/**
 * app/api/tax/pdf/route.ts
 *
 * Tax Computation Schedule PDF download — Phase 7.
 *
 * POST /api/tax/pdf
 *   Accepts a TaxComputationResult + entity info and returns a
 *   PDF binary download of the tax computation schedule.
 *
 * Input:
 *   {
 *     schemaName: string,
 *     result: TaxComputationResult,
 *     entity: { name, uen, fye_date, fiscal_year_start }
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateTaxComputationPDF } from "@/lib/taxPdfGenerator";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import type { TaxComputationResult } from "@/lib/schemas";
import type { TaxPDFEntity } from "@/lib/taxPdfGenerator";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    schemaName: string;
    result: TaxComputationResult;
    entity: TaxPDFEntity;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { schemaName, result, entity } = body;

  if (!schemaName || !result || !entity) {
    return NextResponse.json({ error: "schemaName, result, and entity are required" }, { status: 400 });
  }

  try {
    await verifySchemaAccess(schemaName);
  } catch {
    return NextResponse.json({ error: "Schema not found or access denied" }, { status: 403 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateTaxComputationPDF(result, entity);
  } catch (err) {
    return NextResponse.json(
      { error: `PDF generation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  const safeCompanyName = entity.name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const filename = `tax-computation-${safeCompanyName}-YA${result.year_of_assessment}.pdf`;

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length":      String(pdfBuffer.length),
    },
  });
}
