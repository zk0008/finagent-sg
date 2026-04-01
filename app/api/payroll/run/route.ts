/**
 * app/api/payroll/run/route.ts
 *
 * Payroll run API — POST and PATCH.
 *
 * POST /api/payroll/run
 *   Runs computePayroll() for all employees, saves a payroll_run row and
 *   individual payslip rows to Supabase, and returns the full payroll result.
 *   No AI calls — pure arithmetic only.
 *
 * PATCH /api/payroll/run
 *   Marks an existing payroll run as 'finalised'. Finalised runs are locked
 *   and cannot be edited. Required by the Finalise Payroll button in the UI.
 *
 * Input (POST):
 *   {
 *     schemaName: string,      // Client Supabase schema name e.g. "techsoft_pte_ltd"
 *     entity_id: string,       // UUID of the client entity
 *     payroll_month: string,   // "YYYY-MM-DD" — first day of the month
 *     employees: Array<{       // One entry per employee
 *       employee_id: string,
 *       citizenship: string,
 *       dob: string,
 *       ordinary_wages: string,
 *       additional_wages: string,
 *       ytd_ow?: string,
 *       allowances?: { label: string; amount: number }[],
 *       deductions?: { label: string; amount: number }[],
 *     }>
 *   }
 *
 * Input (PATCH):
 *   { schemaName: string, payroll_run_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { computePayroll } from "@/lib/cpfEngine";
import { type CPFComputationInput } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    schemaName: string;
    entity_id: string;
    payroll_month: string;
    employees: Array<{
      employee_id: string;
      citizenship: string;
      dob: string;
      ordinary_wages: string;
      additional_wages: string;
      ytd_ow?: string;
      allowances?: Array<{ label: string; amount: number }>;
      deductions?: Array<{ label: string; amount: number }>;
    }>;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, entity_id, payroll_month, employees } = body;

  if (!schemaName || !entity_id || !payroll_month || !Array.isArray(employees)) {
    return NextResponse.json(
      { error: "schemaName, entity_id, payroll_month, and employees are required" },
      { status: 400 }
    );
  }

  try {
    // ── Step 1: Run CPF computation for all employees ────────────────────
    const cpfInputs: CPFComputationInput[] = employees.map((emp) => ({
      employee_id: emp.employee_id,
      citizenship: emp.citizenship as CPFComputationInput["citizenship"],
      dob: emp.dob,
      ordinary_wages: emp.ordinary_wages,
      additional_wages: emp.additional_wages,
      ytd_ow: emp.ytd_ow ?? "0",
    }));

    const employeeData = employees.map((emp) => ({
      employee_id: emp.employee_id,
      allowances: emp.allowances ?? [],
      deductions: emp.deductions ?? [],
    }));

    const results = computePayroll(cpfInputs, payroll_month, employeeData);

    // ── Step 2: Save payroll_run row ─────────────────────────────────────
    const { data: runData, error: runError } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .insert({
        entity_id,
        run_month: payroll_month,
        status: "draft",
      })
      .select("id")
      .single();

    if (runError) {
      return NextResponse.json(
        { error: `Failed to save payroll run: ${runError.message}` },
        { status: 500 }
      );
    }

    const payrollRunId = (runData as { id: string }).id;

    // ── Step 3: Save payslip rows ────────────────────────────────────────
    const payslipRows = results.map((result) => {
      const empInput = employees.find((e) => e.employee_id === result.employee_id);
      return {
        payroll_run_id: payrollRunId,
        employee_id: result.employee_id,
        ordinary_wages: parseFloat(result.ordinary_wages),
        additional_wages: parseFloat(result.additional_wages),
        allowances: empInput?.allowances ?? [],
        deductions: empInput?.deductions ?? [],
        employee_cpf: parseFloat(result.employee_cpf),
        employer_cpf: parseFloat(result.employer_cpf),
        total_cpf: parseFloat(result.total_cpf),
        sdl: parseFloat(result.sdl),
        net_pay: parseFloat(result.net_pay),
      };
    });

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

    // Build a map of employee_id → payslip_id for the UI to use when downloading payslips
    const payslipIds: Record<string, string> = {};
    for (const row of (payslipData ?? []) as { id: string; employee_id: string }[]) {
      payslipIds[row.employee_id] = row.id;
    }

    return NextResponse.json({
      payroll_run_id: payrollRunId,
      payroll_month,
      status: "draft",
      results,
      payslip_ids: payslipIds,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Payroll run failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let body: { schemaName: string; payroll_run_id: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, payroll_run_id } = body;

  if (!schemaName || !payroll_run_id) {
    return NextResponse.json(
      { error: "schemaName and payroll_run_id are required" },
      { status: 400 }
    );
  }

  try {
    const { error } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .update({ status: "finalised" })
      .eq("id", payroll_run_id);

    if (error) {
      return NextResponse.json(
        { error: `Failed to finalise payroll run: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, status: "finalised" });
  } catch (err) {
    return NextResponse.json(
      { error: `Finalise failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
