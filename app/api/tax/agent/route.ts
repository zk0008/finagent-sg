/**
 * app/api/tax/agent/route.ts
 *
 * Thin JSON wrapper for the corporate tax pipeline — used by the agent layer.
 *
 * Accepts a simplified input shape (clientId, yearOfAssessment, fsOutputId),
 * derives the full TaxComputationInput from Supabase data and the FS output,
 * then calls computeTax() directly.
 *
 * Agent-specific defaults applied here:
 *   is_new_startup       = false  (agent cannot determine reliably; conservative default)
 *   is_local_employee_cpf = true if any payroll run exists for the base fiscal year
 *   tax_adjustments      = []     (agents cannot infer add-backs or deductions)
 *
 * This is a SEPARATE route from /api/tax/compute (the UI-facing route) to
 * preserve the UI route's contract unchanged. The taxNode calls this route.
 *
 * Called by: taxNode in lib/agents/nodes/index.ts
 *
 * POST /api/tax/agent
 * Input:  { clientId: string, yearOfAssessment: string, fsOutputId: string }
 *         e.g. { clientId: "techsoft_pte_ltd", yearOfAssessment: "YA2026", fsOutputId: "uuid" }
 * Output: { result: TaxComputationResult, computation_id: string | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { computeTax } from "@/lib/taxEngine";
import { sumAccounts, calculateNetProfit } from "@/lib/calculationEngine";
import type { ClassifiedAccount, TaxComputationInput } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { // top-level catch — prevents Next.js from returning an HTML 500 page on any unhandled throw
  // Parse the simplified agent request body
  let body: { clientId: string; yearOfAssessment: string; fsOutputId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { clientId, yearOfAssessment, fsOutputId } = body;

  if (!clientId || !yearOfAssessment || !fsOutputId) {
    return NextResponse.json(
      { error: "clientId, yearOfAssessment, and fsOutputId are required" },
      { status: 400 }
    );
  }

  // clientId is the schema slug throughout the agent layer (e.g. "techsoft_pte_ltd")
  const schemaName = clientId;

  const allowed = await verifySchemaAccess(schemaName);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Step 1: Load entity ID ─────────────────────────────────────────────────
  const { data: entityRow, error: entityError } = await supabase
    .schema(schemaName)
    .from("entities")
    .select("id")
    .limit(1)
    .single();

  if (entityError || !entityRow) {
    return NextResponse.json({ error: "Entity not found in schema" }, { status: 404 });
  }

  const entityId = entityRow.id as string;

  // ── Step 2: Load FS output to get classified accounts and fiscal_year_id ──
  const { data: outputRow, error: outputError } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("classified_accounts, fiscal_year_id")
    .eq("id", fsOutputId)
    .single();

  if (outputError || !outputRow) {
    return NextResponse.json(
      { error: `FS output not found: ${fsOutputId}` },
      { status: 404 }
    );
  }

  const classifiedAccounts = outputRow.classified_accounts as ClassifiedAccount[];
  const fiscalYearId       = outputRow.fiscal_year_id as string;

  // ── Step 3: Load fiscal year end date ─────────────────────────────────────
  // The tax engine uses fiscal_year_end to compute the ECI deadline and YA number
  const { data: fyRow, error: fyError } = await supabase
    .schema(schemaName)
    .from("fiscal_years")
    .select("end_date")
    .eq("id", fiscalYearId)
    .single();

  if (fyError || !fyRow) {
    return NextResponse.json(
      { error: "Fiscal year not found for this FS output" },
      { status: 404 }
    );
  }

  const fiscalYearEnd = fyRow.end_date as string;  // "YYYY-MM-DD"

  // ── Step 4: Derive accounting_profit and revenue from classified accounts ─
  // accounting_profit = total revenue − total expenses (SFRS basis)
  // Both sumAccounts() and calculateNetProfit() use bignumber.js internally
  const totalRevenue  = sumAccounts(classifiedAccounts, "revenue");
  const totalExpenses = sumAccounts(classifiedAccounts, "expense");
  const accountingProfit = calculateNetProfit(totalRevenue, totalExpenses);

  // ── Step 5: Determine is_local_employee_cpf from payroll history ──────────
  // YA2026 covers FY2025 → base year = YA year − 1
  // If any payroll run exists in the base fiscal year, assume CPF was paid
  const yaYear  = parseInt(yearOfAssessment.replace("YA", ""), 10);  // "YA2026" → 2026
  const baseYear = yaYear - 1;                                        // 2026 → 2025

  let isLocalEmployeeCpf = false;
  try {
    const { data: payrollRows } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .select("id")
      .gte("run_month", `${baseYear}-01-01`)   // any run in the base fiscal year
      .lte("run_month", `${baseYear}-12-31`)
      .limit(1);
    // If at least one payroll run exists, CPF contributions were made
    isLocalEmployeeCpf = !!(payrollRows && payrollRows.length > 0);
  } catch {
    // Non-fatal; default remains false — no CPF cash grant is safer than over-claiming
  }

  // ── Step 6: Run the corporate tax computation engine ─────────────────────
  // Pass fiscal_year_end as an extra field — the engine reads it via type cast
  // to compute the ECI deadline and Year of Assessment correctly.
  const taxInput: TaxComputationInput & { fiscal_year_end: string } = {
    entity_id:            entityId,
    fiscal_year_id:       fiscalYearId,
    accounting_profit:    accountingProfit.toFixed(2),  // string for bignumber.js precision
    revenue:              totalRevenue.toFixed(2),
    is_new_startup:       false,    // safe default; user can override via the UI
    is_local_employee_cpf: isLocalEmployeeCpf,
    tax_adjustments:      [],       // agents cannot infer add-backs or deductions
    fiscal_year_end:      fiscalYearEnd,  // needed for ECI deadline calculation
  };

  let result;
  try {
    result = computeTax(taxInput as TaxComputationInput);
  } catch (err) {
    return NextResponse.json(
      { error: `Tax computation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // ── Step 7: Save to Supabase tax_computations table ───────────────────────
  const { data: saved, error: dbError } = await supabase
    .schema(schemaName)
    .from("tax_computations")
    .insert({
      entity_id:            entityId,
      fiscal_year_id:       fiscalYearId,
      year_of_assessment:   result.year_of_assessment,
      form_type:            result.form_type,
      accounting_profit:    result.accounting_profit,
      tax_adjustments:      JSON.stringify([]),        // empty — stored for audit trail
      chargeable_income:    result.chargeable_income,
      exemption_scheme:     result.exemption_scheme,
      tax_before_rebate:    result.gross_tax,
      cit_rebate:           result.cit_rebate,
      cit_rebate_cash_grant: result.cit_rebate_cash_grant,
      tax_payable:          result.tax_payable,
    })
    .select("id")
    .single();

  if (dbError) {
    // Return the result even if saving fails — computation is still valid
    console.error("Tax agent save error:", dbError.message);
    return NextResponse.json({ result, computation_id: null });
  }

  return NextResponse.json({ result, computation_id: (saved as { id: string }).id });
  } catch (err) {
    // Unhandled throw — return JSON so the calling node always gets a parseable response
    console.error("[tax/agent] Unexpected error:", err);
    return NextResponse.json(
      { error: `Internal server error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
