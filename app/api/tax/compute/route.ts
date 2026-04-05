/**
 * app/api/tax/compute/route.ts
 *
 * Corporate Tax Computation API — Phase 7.
 *
 * POST /api/tax/compute
 *   Accepts tax computation inputs, runs computeTax(), saves the result
 *   to the tax_computations table, and returns the full TaxComputationResult.
 *
 * Input:
 *   {
 *     schemaName: string,              // Client Supabase schema name
 *     fiscal_year_end: string,         // YYYY-MM-DD — FYE date for YA and deadline calculation
 *     ...TaxComputationInput fields
 *   }
 *
 * Output:
 *   { result: TaxComputationResult, computation_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { computeTax } from "@/lib/taxEngine";
import { TaxComputationInputSchema } from "@/lib/schemas";
import { verifySchemaAccess } from "@/lib/schemaAccess";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    schemaName: string;
    fiscal_year_end: string;
    entity_id: string;
    fiscal_year_id: string;
    accounting_profit: string;
    revenue: string;
    is_new_startup: boolean;
    is_local_employee_cpf: boolean;
    tax_adjustments: Array<{ description: string; amount: string; type: "add_back" | "deduct" }>;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, fiscal_year_end, ...inputFields } = body;

  if (!schemaName) {
    return NextResponse.json({ error: "schemaName is required" }, { status: 400 });
  }

  // Verify the caller has access to this client schema
  try {
    await verifySchemaAccess(schemaName);
  } catch {
    return NextResponse.json({ error: "Schema not found or access denied" }, { status: 403 });
  }

  // Validate input shape
  const parsed = TaxComputationInputSchema.safeParse(inputFields);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const input = parsed.data;

  // Inject the fiscal_year_end into the input for the engine to compute deadlines
  const engineInput = { ...input, fiscal_year_end };

  // Run the tax computation engine (pure arithmetic — no AI)
  let result;
  try {
    result = computeTax(engineInput as typeof input);
  } catch (err) {
    return NextResponse.json(
      { error: `Tax computation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // Save to Supabase tax_computations table
  const { data: saved, error: dbError } = await supabase
    .schema(schemaName)
    .from("tax_computations")
    .insert({
      entity_id:             input.entity_id,
      fiscal_year_id:        input.fiscal_year_id,
      year_of_assessment:    result.year_of_assessment,
      form_type:             result.form_type,
      accounting_profit:     result.accounting_profit,
      tax_adjustments:       JSON.stringify(input.tax_adjustments),
      chargeable_income:     result.chargeable_income,
      exemption_scheme:      result.exemption_scheme,
      tax_before_rebate:     result.gross_tax,
      cit_rebate:            result.cit_rebate,
      cit_rebate_cash_grant: result.cit_rebate_cash_grant,
      tax_payable:           result.tax_payable,
    })
    .select("id")
    .single();

  if (dbError) {
    // Return result even if save fails — computation is still valid
    console.error("Tax computation save error:", dbError.message);
    return NextResponse.json({ result, computation_id: null });
  }

  return NextResponse.json({ result, computation_id: saved.id });
}
