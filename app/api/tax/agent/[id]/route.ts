/**
 * app/api/tax/agent/[id]/route.ts
 *
 * Rehydrates a saved tax_computations row into the full TaxComputationResult shape
 * expected by TaxWorkflow Step 3. Used by TaxWorkflow's auto-load useEffect to jump
 * straight to the results view after the agent completes a tax run.
 *
 * Why this route is needed:
 * The tax_computations table stores the fields computed by computeTax() that are safe
 * to persist as NUMERIC. Seven derived fields are NOT stored because they can always be
 * recomputed deterministically from what is stored:
 *   total_add_backs     → sum TaxAdjustment[] where type === "add_back"
 *   total_deductions    → sum TaxAdjustment[] where type === "deduct"
 *   exempt_amount       → applyTaxExemption(chargeable_income, exemption_scheme).exempt_amount
 *   taxable_income      → applyTaxExemption(chargeable_income, exemption_scheme).taxable_income
 *   gross_tax           → tax_before_rebate column (stored under a different name)
 *   eci_filing_required → form_type === 'C' OR chargeable_income > 0
 *   eci_deadline        → 3 months after fiscal year end (looked up via fiscal_year_id)
 *   form_filing_deadline → "30 Nov {year_of_assessment}" (fixed formula)
 *
 * For agent-initiated runs tax_adjustments is always [] — total_add_backs and
 * total_deductions will always be "0.00". The computation is general enough to handle
 * non-empty arrays if the route is ever reused for UI-generated runs.
 *
 * Authentication: browser-facing route — auth enforced by proxy.ts (session cookie).
 * Schema isolation: verifySchemaAccess() confirms schemaName is registered.
 *
 * GET /api/tax/agent/[id]?schemaName=<schema>
 * Returns: { result: TaxComputationResult }
 */

import { NextRequest, NextResponse } from "next/server";
import BigNumber from "bignumber.js";
import { supabase } from "@/lib/supabaseClient";
import { auth } from "@/auth";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { applyTaxExemption } from "@/lib/taxEngine";
import type { TaxComputationResult } from "@/lib/schemas";

// ── Inlined from lib/taxEngine.ts (formatDeadlineDate is not exported) ─────────
// Returns last day of the given month as "DD Mon YYYY" (e.g. "31 Mar 2026")
function formatDeadlineDate(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();  // day 0 of next month = last day of this month
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${lastDay} ${monthNames[month - 1]} ${year}`;
}

// Shape of a single row returned from tax_computations
type TaxComputationRow = {
  year_of_assessment:   number;
  form_type:            string;
  accounting_profit:    number;
  tax_adjustments:      Array<{ description: string; amount: string; type: "add_back" | "deduct" }> | null;
  chargeable_income:    number;
  exemption_scheme:     string;
  tax_before_rebate:    number;
  cit_rebate:           number;
  cit_rebate_cash_grant: number;
  tax_payable:          number;
  fiscal_year_id:       string | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }  // Next.js 15: params is a Promise
): Promise<NextResponse> {
  // Await the dynamic route params — required in Next.js 15 App Router
  const { id } = await params;
  const schemaName = req.nextUrl.searchParams.get("schemaName");

  if (!id || !schemaName) {
    return NextResponse.json(
      { error: "id and schemaName are required" },
      { status: 400 }
    );
  }

  // Confirm the schema is registered in public.client_schemas before querying it
  const session = await auth();
  const userId = session?.user?.id as string | undefined;
  const userRole = (session?.user as { role?: string })?.role;
  const allowed = await verifySchemaAccess(schemaName, userId, userRole);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Step 1: Fetch the stored tax computation row ───────────────────────────
  const { data, error } = await supabase
    .schema(schemaName)
    .from("tax_computations")
    .select(
      "year_of_assessment, form_type, accounting_profit, tax_adjustments, " +
      "chargeable_income, exemption_scheme, tax_before_rebate, " +
      "cit_rebate, cit_rebate_cash_grant, tax_payable, fiscal_year_id"
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Tax computation not found" }, { status: 404 });
  }

  const row = data as unknown as TaxComputationRow;

  // ── Step 2: Derive total_add_backs and total_deductions from stored adjustments ─
  // Agent runs always store [] — both totals will be "0.00" for agent-generated rows.
  // Non-empty arrays (e.g. UI-generated runs) are handled correctly by the loop below.
  const adjustments = row.tax_adjustments ?? [];
  let addBacksTotal   = new BigNumber("0");
  let deductionsTotal = new BigNumber("0");

  for (const adj of adjustments) {
    const amt = new BigNumber(adj.amount).abs();  // engine uses abs() — store may be signed
    if (adj.type === "add_back") {
      addBacksTotal   = addBacksTotal.plus(amt);
    } else {
      deductionsTotal = deductionsTotal.plus(amt);
    }
  }

  // ── Step 3: Derive exempt_amount and taxable_income via applyTaxExemption ───
  const scheme = row.exemption_scheme as "new_startup" | "partial";
  const { exempt_amount, taxable_income } = applyTaxExemption(
    row.chargeable_income.toFixed(2),
    scheme
  );

  // ── Step 4: Derive ECI filing requirement ─────────────────────────────────
  // form_type 'C' implies revenue > $5M → ECI filing required.
  // Otherwise required if chargeable income is positive.
  // This is a safe proxy — revenue is not stored in tax_computations.
  const eci_filing_required =
    row.form_type === "C" || new BigNumber(row.chargeable_income).isGreaterThan(0);

  // ── Step 5: Derive ECI deadline from fiscal year end date ─────────────────
  // ECI must be filed within 3 months of the financial year end.
  // If fiscal_year_id is null (edge case), fall back to a descriptive string.
  let eci_deadline = "3 months after financial year end";  // fallback

  if (row.fiscal_year_id) {
    const { data: fyRow } = await supabase
      .schema(schemaName)
      .from("fiscal_years")
      .select("end_date")
      .eq("id", row.fiscal_year_id)
      .single();

    if (fyRow) {
      const fyeDate  = (fyRow as { end_date: string }).end_date;  // "YYYY-MM-DD"
      const fyeYear  = parseInt(fyeDate.slice(0, 4), 10);
      const fyeMonth = parseInt(fyeDate.slice(5, 7), 10);

      // ECI deadline = last day of the month that is 3 months after FYE month
      const eciMonth = ((fyeMonth - 1 + 3) % 12) + 1;
      const eciYear  = fyeYear + Math.floor((fyeMonth - 1 + 3) / 12);
      eci_deadline   = formatDeadlineDate(eciYear, eciMonth);
    }
  }

  // ── Step 6: Derive form_filing_deadline (always 30 Nov of YA) ────────────
  const form_filing_deadline = `30 Nov ${row.year_of_assessment}`;

  // ── Step 7: Assemble the full TaxComputationResult ────────────────────────
  // NUMERIC columns from Supabase arrive as JS numbers; convert to .toFixed(2) strings
  // to match TaxComputationResult's string fields.
  const result: TaxComputationResult = {
    year_of_assessment:    row.year_of_assessment,
    form_type:             row.form_type as TaxComputationResult["form_type"],
    accounting_profit:     row.accounting_profit.toFixed(2),
    total_add_backs:       addBacksTotal.toFixed(2),
    total_deductions:      deductionsTotal.toFixed(2),
    chargeable_income:     row.chargeable_income.toFixed(2),
    exemption_scheme:      scheme,
    exempt_amount,                                 // derived via applyTaxExemption
    taxable_income,                                // derived via applyTaxExemption
    gross_tax:             row.tax_before_rebate.toFixed(2),  // stored as tax_before_rebate
    cit_rebate:            row.cit_rebate.toFixed(2),
    cit_rebate_cash_grant: row.cit_rebate_cash_grant.toFixed(2),
    tax_payable:           row.tax_payable.toFixed(2),
    eci_filing_required,
    eci_deadline,
    form_filing_deadline,
  };

  return NextResponse.json({ result });
}
