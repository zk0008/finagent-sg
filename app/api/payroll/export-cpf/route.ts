/**
 * app/api/payroll/export-cpf/route.ts
 *
 * POST /api/payroll/export-cpf
 *
 * Fetches all payslips for a payroll run, fetches the corresponding employee
 * records, and generates the CPF e-Submit CSV file via generateCPFSubmission().
 * Returns the CSV as a file download.
 *
 * Input:
 *   {
 *     payroll_run_id: string,   // UUID of the payroll_runs row
 *     schemaName: string,       // Client Supabase schema name
 *     entity: { name: string, uen: string }
 *   }
 *
 * Response:
 *   Content-Type: text/csv
 *   Content-Disposition: attachment; filename="cpf-submit-<YYYY-MM>.csv"
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateCPFSubmission } from "@/lib/cpfSubmissionExport";
import { type Payslip, type Employee } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    payroll_run_id: string;
    schemaName: string;
    entity: { name: string; uen: string };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { payroll_run_id, schemaName, entity } = body;

  if (!payroll_run_id || !schemaName || !entity) {
    return NextResponse.json(
      { error: "payroll_run_id, schemaName, and entity are required" },
      { status: 400 }
    );
  }

  try {
    // ── Fetch payroll run (for the run_month / filename) ──────────────────
    const { data: runData, error: runError } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .select("run_month")
      .eq("id", payroll_run_id)
      .single();

    if (runError || !runData) {
      return NextResponse.json(
        { error: `Payroll run not found: ${runError?.message ?? "no data"}` },
        { status: 404 }
      );
    }

    const runMonth: string = (runData as { run_month: string }).run_month;

    // ── Fetch all payslips for this run ───────────────────────────────────
    const { data: payslipData, error: payslipError } = await supabase
      .schema(schemaName)
      .from("payslips")
      .select("*")
      .eq("payroll_run_id", payroll_run_id);

    if (payslipError) {
      return NextResponse.json(
        { error: `Failed to fetch payslips: ${payslipError.message}` },
        { status: 500 }
      );
    }

    const payslips = (payslipData ?? []) as Payslip[];

    // ── Fetch all employees for this entity ───────────────────────────────
    const employeeIds = [...new Set(payslips.map((p) => p.employee_id))];
    const { data: empData, error: empError } = await supabase
      .schema(schemaName)
      .from("employees")
      .select("*")
      .in("id", employeeIds);

    if (empError) {
      return NextResponse.json(
        { error: `Failed to fetch employees: ${empError.message}` },
        { status: 500 }
      );
    }

    const employees = (empData ?? []) as Employee[];

    // ── Generate CPF e-Submit CSV ─────────────────────────────────────────
    const csvBuffer = generateCPFSubmission(payslips, employees, entity);

    const safeMonth = runMonth.slice(0, 7); // "YYYY-MM"
    const filename = `cpf-submit-${safeMonth}.csv`;

    return new NextResponse(new Uint8Array(csvBuffer), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(csvBuffer.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `CPF export failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
