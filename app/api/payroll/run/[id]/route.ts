/**
 * app/api/payroll/run/[id]/route.ts
 *
 * Returns payroll run details and reconstructed results for a single payroll_runs row.
 * Used by PayrollWorkflow's auto-load useEffect to jump straight to Step 3 (download)
 * after the agent completes a payroll run, without requiring the user to re-run payroll.
 *
 * The payroll_runs table stores only: id, entity_id, run_month, status, created_at.
 * Computed results (CPF breakdowns, net pay) are stored in the payslips table — one row
 * per employee per run. This route reconstructs PayrollResult[] from those payslip rows.
 *
 * NUMERIC columns from Supabase come back as JavaScript numbers; they are converted to
 * two-decimal strings (e.g. "5200.00") to match the CPFComputationResult string format
 * that PayrollWorkflow Step 3 expects. age is set to 0 — it is not stored in the DB
 * and is not displayed in the download step, so a placeholder is safe here.
 *
 * Authentication: browser-facing route — auth enforced by proxy.ts (session cookie).
 * Schema isolation: verifySchemaAccess() confirms schemaName is registered before any
 * per-tenant Supabase query is made.
 *
 * GET /api/payroll/run/[id]?schemaName=<schema>
 * Returns: { payroll_month: string, payslip_ids: Record<string, string>, results: CPFComputationResult[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { auth } from "@/auth";
import { verifySchemaAccess } from "@/lib/schemaAccess";

// Shape of one row returned from the payroll_runs table
type PayrollRunRow = {
  run_month: string;  // "YYYY-MM-DD" first-of-month date stored as PostgreSQL DATE
};

// Shape of one row returned from the payslips table
// NUMERIC(12,2) columns arrive as JavaScript numbers from the Supabase JS client
type PayslipRow = {
  id: string;
  employee_id: string;
  ordinary_wages: number;
  additional_wages: number;
  employee_cpf: number;
  employer_cpf: number;
  total_cpf: number;
  sdl: number;
  net_pay: number;
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

  // ── Step 1: Fetch the payroll run to get run_month ─────────────────────────
  const { data: runData, error: runError } = await supabase
    .schema(schemaName)
    .from("payroll_runs")
    .select("run_month")
    .eq("id", id)
    .single();

  if (runError || !runData) {
    return NextResponse.json({ error: "Payroll run not found" }, { status: 404 });
  }

  const { run_month } = runData as PayrollRunRow;

  // ── Step 2: Fetch all payslips for this run ────────────────────────────────
  // Each row contains the full CPF breakdown for one employee
  const { data: payslipRows, error: payslipError } = await supabase
    .schema(schemaName)
    .from("payslips")
    .select(
      "id, employee_id, ordinary_wages, additional_wages, employee_cpf, employer_cpf, total_cpf, sdl, net_pay"
    )
    .eq("payroll_run_id", id);

  if (payslipError) {
    return NextResponse.json(
      { error: `Failed to load payslips: ${payslipError.message}` },
      { status: 500 }
    );
  }

  if (!payslipRows || payslipRows.length === 0) {
    return NextResponse.json(
      { error: "No payslips found for this payroll run" },
      { status: 404 }
    );
  }

  // ── Step 3: Build payslip_ids record (employee_id → payslip_id) ───────────
  // PayrollWorkflow Step 3 uses payslipIds to initiate per-employee PDF downloads
  const payslipIds: Record<string, string> = {};
  for (const row of payslipRows as PayslipRow[]) {
    payslipIds[row.employee_id] = row.id;
  }

  // ── Step 4: Reconstruct CPFComputationResult[] from payslip rows ──────────
  // NUMERIC columns arrive as JS numbers; convert to ".toFixed(2)" strings to
  // match the CPFComputationResult shape PayrollWorkflow Step 3 expects.
  // age is set to 0 — not stored in the DB; not displayed in the download step.
  const results = (payslipRows as PayslipRow[]).map((row) => ({
    employee_id:      row.employee_id,
    age:              0,                                           // placeholder — not stored in DB
    ordinary_wages:   row.ordinary_wages.toFixed(2),
    additional_wages: row.additional_wages.toFixed(2),
    employee_cpf:     row.employee_cpf.toFixed(2),
    employer_cpf:     row.employer_cpf.toFixed(2),
    total_cpf:        row.total_cpf.toFixed(2),
    sdl:              row.sdl.toFixed(2),
    net_pay:          row.net_pay.toFixed(2),
  }));

  return NextResponse.json({
    payroll_month: run_month,    // "YYYY-MM-DD" first-of-month date
    payslip_ids:   payslipIds,   // { [employee_id]: payslip_id }
    results,                     // CPFComputationResult[] reconstructed from payslips
  });
}
