/**
 * app/api/payroll/journal/route.ts
 *
 * POST /api/payroll/journal
 *
 * Fetches all payslips for a payroll run, fetches employee records, and
 * generates the five standard double-entry payroll journal entries via
 * generatePayrollJournalEntries(). Returns journal entries as JSON.
 *
 * Input:
 *   {
 *     payroll_run_id: string,   // UUID of the payroll_runs row
 *     schemaName: string        // Client Supabase schema name
 *   }
 *
 * Response:
 *   {
 *     journal_date: string,         // Last day of payroll month (ISO date)
 *     entries: JournalEntry[]       // Five double-entry journal entries
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generatePayrollJournalEntries, getLastDayOfMonth } from "@/lib/payrollJournal";
import { type Payslip, type Employee } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { payroll_run_id: string; schemaName: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { payroll_run_id, schemaName } = body;

  if (!payroll_run_id || !schemaName) {
    return NextResponse.json(
      { error: "payroll_run_id and schemaName are required" },
      { status: 400 }
    );
  }

  try {
    // ── Fetch payroll run ─────────────────────────────────────────────────
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
    const journalDate = getLastDayOfMonth(runMonth);

    // ── Fetch payslips ────────────────────────────────────────────────────
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

    // ── Fetch employees ───────────────────────────────────────────────────
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

    // ── Generate journal entries ───────────────────────────────────────────
    const entries = generatePayrollJournalEntries(payslips, employees, journalDate);

    return NextResponse.json({ journal_date: journalDate, entries });
  } catch (err) {
    return NextResponse.json(
      { error: `Journal generation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
