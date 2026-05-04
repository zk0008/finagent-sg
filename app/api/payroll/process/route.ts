/**
 * app/api/payroll/process/route.ts
 *
 * Thin JSON wrapper for the payroll pipeline — used by the agent layer.
 *
 * Fetches entity and employee records from Supabase, then runs computePayroll()
 * directly. Uses each employee's stored monthly_salary as ordinary_wages.
 * Additional wages, allowances, and deductions default to zero because the agent
 * cannot infer these from a natural language goal.
 *
 * Unlike the UI-facing /api/payroll/run (which receives a full employee array
 * from the frontend), this route assembles the employee data from the DB itself.
 *
 * Called by: payrollNode in lib/agents/nodes/index.ts
 *
 * POST /api/payroll/process
 * Input:  { clientId: string, payrollMonth: number (1–12), payrollYear: number }
 * Output: { payroll_run_id, payroll_month, status, results, payslip_ids }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { computePayroll } from "@/lib/cpfEngine";
import type { CPFComputationInput } from "@/lib/schemas";

// DB row shape returned when querying the employees table
type EmployeeRow = {
  id: string;
  dob: string;             // "YYYY-MM-DD" from PostgreSQL DATE
  citizenship: string;     // "SC" | "SPR_1" | "SPR_2" | "SPR_3" | "foreigner"
  monthly_salary: number;  // NUMERIC returned as number by Supabase JS client
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { // top-level catch — prevents Next.js from returning an HTML 500 page on any unhandled throw
  // Parse the simplified agent request body
  let body: { clientId: string; payrollMonth: number; payrollYear: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { clientId, payrollMonth, payrollYear } = body;

  if (!clientId || !payrollMonth || !payrollYear) {
    return NextResponse.json(
      { error: "clientId, payrollMonth, and payrollYear are required" },
      { status: 400 }
    );
  }

  // clientId is the schema slug throughout the agent layer (e.g. "techsoft_pte_ltd")
  const schemaName = clientId;

  const allowed = await verifySchemaAccess(schemaName);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Build the "YYYY-MM-DD" first-of-month date the CPF engine requires
  // e.g. payrollMonth=12, payrollYear=2025 → "2025-12-01"
  const payrollMonthDate = `${payrollYear}-${String(payrollMonth).padStart(2, "0")}-01`;

  // ── Step 1: Load entity ID ─────────────────────────────────────────────────
  // We need entity_id to scope the employees query and to write the payroll_run row
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

  // ── Step 2: Load all employees for this entity ────────────────────────────
  const { data: employeeRows, error: empError } = await supabase
    .schema(schemaName)
    .from("employees")
    .select("id, dob, citizenship, monthly_salary")
    .eq("entity_id", entityId);

  if (empError) {
    return NextResponse.json(
      { error: `Failed to load employees: ${empError.message}` },
      { status: 500 }
    );
  }

  if (!employeeRows || employeeRows.length === 0) {
    return NextResponse.json(
      { error: "No employees found for this entity. Add employees before running payroll." },
      { status: 400 }
    );
  }

  // Build the CPF input array from Supabase employee rows.
  // monthly_salary is the DB value; convert to string for bignumber.js precision.
  // additional_wages and ytd_ow default to "0" — same deferred defaults as Phase 4.
  const cpfInputs: CPFComputationInput[] = (employeeRows as EmployeeRow[]).map((emp) => ({
    employee_id:      emp.id,
    citizenship:      emp.citizenship as CPFComputationInput["citizenship"],
    dob:              emp.dob,
    ordinary_wages:   emp.monthly_salary.toString(),  // NUMERIC → string for BigNumber
    additional_wages: "0",  // agent cannot infer bonuses
    ytd_ow:           "0",  // YTD tracking deferred (Phase 4 known issue)
  }));

  // ── Step 3: Run the CPF + payroll computation ─────────────────────────────
  let results;
  try {
    // No employeeData arg — allowances and deductions are zero for agent-initiated runs
    results = computePayroll(cpfInputs, payrollMonthDate);
  } catch (err) {
    return NextResponse.json(
      { error: `Payroll computation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // ── Step 4: Save payroll_run row to Supabase ──────────────────────────────
  const { data: runData, error: runError } = await supabase
    .schema(schemaName)
    .from("payroll_runs")
    .insert({ entity_id: entityId, run_month: payrollMonthDate, status: "draft" })
    .select("id")
    .single();

  if (runError) {
    return NextResponse.json(
      { error: `Failed to save payroll run: ${runError.message}` },
      { status: 500 }
    );
  }

  const payrollRunId = (runData as { id: string }).id;

  // ── Step 5: Save individual payslip rows ─────────────────────────────────
  // parseFloat converts bignumber.js string output back to NUMERIC for DB storage
  const payslipRows = results.map((r) => ({
    payroll_run_id:   payrollRunId,
    employee_id:      r.employee_id,
    ordinary_wages:   parseFloat(r.ordinary_wages),
    additional_wages: parseFloat(r.additional_wages),
    allowances:       [],   // empty for agent runs
    deductions:       [],   // empty for agent runs
    employee_cpf:     parseFloat(r.employee_cpf),
    employer_cpf:     parseFloat(r.employer_cpf),
    total_cpf:        parseFloat(r.total_cpf),
    sdl:              parseFloat(r.sdl),
    net_pay:          parseFloat(r.net_pay),
  }));

  const { data: payslipData, error: payslipError } = await supabase
    .schema(schemaName)
    .from("payslips")
    .insert(payslipRows)
    .select("id, employee_id");

  if (payslipError) {
    return NextResponse.json(
      { error: `Failed to save payslips: ${payslipError.message}` },
      { status: 500 }
    );
  }

  // Build employee_id → payslip_id map for callers who need per-payslip IDs
  const payslipIds: Record<string, string> = {};
  for (const row of (payslipData ?? []) as { id: string; employee_id: string }[]) {
    payslipIds[row.employee_id] = row.id;
  }

  return NextResponse.json({
    payroll_run_id: payrollRunId,
    payroll_month:  payrollMonthDate,
    status:         "draft",
    results,
    payslip_ids:    payslipIds,
  });
  } catch (err) {
    // Unhandled throw (e.g. unexpected null on monthly_salary, Supabase network error)
    // — return JSON so the calling node always gets a parseable response
    console.error("[payroll/process] Unexpected error:", err);
    return NextResponse.json(
      { error: `Internal server error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
