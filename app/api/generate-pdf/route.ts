/**
 * app/api/generate-pdf/route.ts
 *
 * PDF download API route.
 *
 * Accepts a POST with the FSOutput, entity, and fiscal year,
 * generates the PDF via pdfGenerator.ts, and returns it as a binary download.
 * Called by WorkflowPanel when the user clicks "Download PDF".
 */

import { NextRequest, NextResponse } from "next/server";
import { generateFinancialStatementsPDF } from "@/lib/pdfGenerator";
import { EntitySchema, FiscalYearSchema, FSOutputSchema } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<Response> {
  let body: { entity: unknown; fiscal_year: unknown; fs_output: unknown };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const entityParse = EntitySchema.safeParse(body.entity);
  if (!entityParse.success) {
    return NextResponse.json({ error: "Invalid entity" }, { status: 400 });
  }

  const fiscalYearParse = FiscalYearSchema.safeParse(body.fiscal_year);
  if (!fiscalYearParse.success) {
    return NextResponse.json({ error: "Invalid fiscal_year" }, { status: 400 });
  }

  // Run FSOutputSchema.parse() so z.preprocess() coercions (e.g. notes object→array) fire
  let fsOutput: import("@/lib/schemas").FSOutput;
  try {
    fsOutput = FSOutputSchema.parse(body.fs_output);
  } catch (parseErr) {
    console.error("[generate-pdf] FSOutputSchema.parse() failed:", (parseErr as Error).message);
    return NextResponse.json(
      { error: `fs_output validation failed: ${(parseErr as Error).message}` },
      { status: 400 }
    );
  }

  try {
    const pdfBuffer = await generateFinancialStatementsPDF(
      entityParse.data,
      fiscalYearParse.data,
      fsOutput
    );

    const filename = `financial-statements-${fiscalYearParse.data.end_date}.pdf`;

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `PDF generation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
