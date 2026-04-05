/**
 * app/api/history/route.ts
 *
 * GET /api/history?schemaName=<schema>&type=<fs|model|payroll|tax>
 *
 * Returns past outputs for a given client schema and output type.
 *
 * Query params:
 *   schemaName (required) — the client schema (e.g. "techsoft_pte_ltd")
 *   type (required)       — "fs" | "model" | "payroll" | "tax"
 *
 * Response for type=fs:
 *   { items: FSHistoryItem[] }
 *   Each: { id, created_at, output_type, fiscal_year_end, audit_exempt }
 *
 * Response for type=model:
 *   { items: ModelHistoryItem[] }
 *   Each: { id, created_at, model_name, base_year, projection_years, is_active }
 *
 * Response for type=payroll:
 *   { items: PayrollHistoryItem[] }
 *   Each: { id, created_at, period_month, status, employee_count, total_gross }
 *
 * Response for type=tax:
 *   { items: TaxHistoryItem[] }
 *   Each: { id, created_at, year_of_assessment, form_type, chargeable_income, tax_payable, exemption_scheme }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";

export type FSHistoryItem = {
  id: string;
  created_at: string;
  output_type: string;
  fiscal_year_end: string | null;
  audit_exempt: boolean | null;
};

export type ModelHistoryItem = {
  id: string;
  created_at: string;
  model_name: string;
  projection_years: number;
  is_active: boolean;
};

export type PayrollHistoryItem = {
  id: string;
  created_at: string;
  run_month: string;
  status: string;
};

export type TaxHistoryItem = {
  id: string;
  created_at: string;
  year_of_assessment: number;
  form_type: string;
  chargeable_income: string;
  tax_payable: string;
  exemption_scheme: string;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const schemaName = searchParams.get("schemaName");
  const type = searchParams.get("type");

  if (!schemaName) {
    return NextResponse.json({ error: "schemaName is required" }, { status: 400 });
  }
  if (type !== "fs" && type !== "model" && type !== "payroll" && type !== "tax") {
    return NextResponse.json({ error: "type must be fs | model | payroll | tax" }, { status: 400 });
  }

  if (!await verifySchemaAccess(schemaName)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Financial Statements history ───────────────────────────────────────────
  if (type === "fs") {
    const { data, error } = await supabase
      .schema(schemaName)
      .from("outputs")
      .select("id, created_at, output_type, exemption_result")
      .eq("output_type", "financial_statements")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const items: FSHistoryItem[] = (data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      output_type: row.output_type,
      fiscal_year_end:
        (row.exemption_result as { fye_date?: string } | null)?.fye_date ?? null,
      audit_exempt:
        (row.exemption_result as { is_audit_exempt?: boolean } | null)
          ?.is_audit_exempt ?? null,
    }));

    return NextResponse.json({ items });
  }

  // ── Financial Models history ───────────────────────────────────────────────
  if (type === "model") {
    const { data, error } = await supabase
      .schema(schemaName)
      .from("financial_models")
      .select("id, created_at, model_name, projection_years, is_active")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ items: (data ?? []) as ModelHistoryItem[] });
  }

  // ── Payroll Runs history ───────────────────────────────────────────────────
  if (type === "payroll") {
    const { data, error } = await supabase
      .schema(schemaName)
      .from("payroll_runs")
      .select("id, created_at, run_month, status")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const items: PayrollHistoryItem[] = (data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      run_month: row.run_month,
      status: row.status,
    }));

    return NextResponse.json({ items });
  }

  // ── Tax Computations history ───────────────────────────────────────────────
  const { data, error } = await supabase
    .schema(schemaName)
    .from("tax_computations")
    .select("id, created_at, year_of_assessment, form_type, chargeable_income, tax_payable, exemption_scheme")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items: TaxHistoryItem[] = (data ?? []).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    year_of_assessment: row.year_of_assessment,
    form_type: row.form_type,
    chargeable_income: String(row.chargeable_income),
    tax_payable: String(row.tax_payable),
    exemption_scheme: row.exemption_scheme,
  }));

  return NextResponse.json({ items });
}
