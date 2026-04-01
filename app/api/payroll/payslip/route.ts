/**
 * app/api/payroll/payslip/route.ts
 *
 * POST /api/payroll/payslip
 *
 * Fetches one payslip and its associated employee record from Supabase,
 * generates a MOM-compliant payslip PDF via generatePayslip(), and returns
 * the PDF binary as a file download.
 *
 * Input:
 *   {
 *     payslip_id: string,    // UUID of the payslip row
 *     schemaName: string,    // Client Supabase schema name
 *     entity: { name: string, uen: string }  // Company info for the payslip header
 *   }
 *
 * Response:
 *   Content-Type: application/pdf
 *   Content-Disposition: attachment; filename="payslip-<name>-<month>.pdf"
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generatePayslip } from "@/lib/payslipGenerator";
import { type Employee, type Payslip } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    payslip_id: string;
    schemaName: string;
    entity: { name: string; uen: string };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { payslip_id, schemaName, entity } = body;

  if (!payslip_id || !schemaName || !entity) {
    return NextResponse.json(
      { error: "payslip_id, schemaName, and entity are required" },
      { status: 400 }
    );
  }

  try {
    // ── Fetch payslip ────────────────────────────────────────────────────
    const { data: payslipData, error: payslipError } = await supabase
      .schema(schemaName)
      .from("payslips")
      .select("*")
      .eq("id", payslip_id)
      .single();

    if (payslipError || !payslipData) {
      return NextResponse.json(
        { error: `Payslip not found: ${payslipError?.message ?? "no data"}` },
        { status: 404 }
      );
    }

    const payslip = payslipData as Payslip;

    // ── Fetch employee ────────────────────────────────────────────────────
    const { data: employeeData, error: employeeError } = await supabase
      .schema(schemaName)
      .from("employees")
      .select("*")
      .eq("id", payslip.employee_id)
      .single();

    if (employeeError || !employeeData) {
      return NextResponse.json(
        { error: `Employee not found: ${employeeError?.message ?? "no data"}` },
        { status: 404 }
      );
    }

    const employee = employeeData as Employee;

    // ── Fetch the payroll run to get the payment date ─────────────────────
    const { data: runData, error: runError } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .select("run_month")
      .eq("id", payslip.payroll_run_id)
      .single();

    if (runError || !runData) {
      return NextResponse.json(
        { error: `Payroll run not found: ${runError?.message ?? "no data"}` },
        { status: 404 }
      );
    }

    // Payment date = last day of the payroll month
    const runMonth: string = (runData as { run_month: string }).run_month;
    const [year, month] = runMonth.split("-").map(Number);
    const lastDay = new Date(year, month, 0);
    const paymentDate = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;

    // ── Generate payslip PDF ──────────────────────────────────────────────
    const pdfBuffer = await generatePayslip(employee, payslip, entity, paymentDate);

    // ── Build safe filename ───────────────────────────────────────────────
    const safeName = employee.name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 30);
    const safeMonth = runMonth.slice(0, 7); // "YYYY-MM"
    const filename = `payslip-${safeName}-${safeMonth}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Payslip generation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
