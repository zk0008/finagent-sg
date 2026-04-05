/**
 * app/api/history/pdf/route.ts
 *
 * GET /api/history/pdf?schemaName=<schema>&outputId=<id>
 *
 * Regenerates a financial statement PDF on demand from stored structured_data.
 * pdf_data is not stored in the DB (generate-fs saves with pdfBase64: null),
 * so this route fetches the structured_data + entity + fiscal_year from Supabase
 * and calls generateFinancialStatementsPDF directly.
 *
 * Returns: application/pdf binary
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateFinancialStatementsPDF } from "@/lib/pdfGenerator";
import { EntitySchema, FiscalYearSchema, FSOutputSchema } from "@/lib/schemas";

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const { searchParams } = req.nextUrl;
  const schemaName = searchParams.get("schemaName");
  const outputId = searchParams.get("outputId");

  if (!schemaName || !outputId) {
    return NextResponse.json(
      { error: "schemaName and outputId are required" },
      { status: 400 }
    );
  }

  // Fetch the output record
  const { data: output, error: outputError } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("structured_data, fiscal_year_id")
    .eq("id", outputId)
    .maybeSingle();

  if (outputError || !output) {
    return NextResponse.json({ error: "Output not found" }, { status: 404 });
  }

  if (!output.structured_data) {
    return NextResponse.json({ error: "No structured data for this output" }, { status: 404 });
  }

  // Fetch the fiscal year
  const { data: fy, error: fyError } = await supabase
    .schema(schemaName)
    .from("fiscal_years")
    .select("id, entity_id, start_date, end_date, status")
    .eq("id", output.fiscal_year_id)
    .maybeSingle();

  if (fyError || !fy) {
    return NextResponse.json({ error: "Fiscal year not found" }, { status: 404 });
  }

  // Fetch the entity
  const { data: entity, error: entityError } = await supabase
    .schema(schemaName)
    .from("entities")
    .select("id, name, uen, company_type, fye_date, audit_exempt")
    .eq("id", fy.entity_id)
    .maybeSingle();

  if (entityError || !entity) {
    return NextResponse.json({ error: "Entity not found" }, { status: 404 });
  }

  // Validate shapes
  const entityParse = EntitySchema.safeParse(entity);
  const fiscalYearParse = FiscalYearSchema.safeParse(fy);
  if (!entityParse.success || !fiscalYearParse.success) {
    return NextResponse.json({ error: "Invalid stored data shape" }, { status: 500 });
  }

  let fsOutput: import("@/lib/schemas").FSOutput;
  try {
    fsOutput = FSOutputSchema.parse(output.structured_data);
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid fs_output: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  try {
    const pdfBuffer = await generateFinancialStatementsPDF(
      entityParse.data,
      fiscalYearParse.data,
      fsOutput
    );

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="financial-statements-${fiscalYearParse.data.end_date}.pdf"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (err) {
    console.error("[history/pdf] PDF generation failed:", err);
    return NextResponse.json({ error: "PDF generation failed" }, { status: 500 });
  }
}
