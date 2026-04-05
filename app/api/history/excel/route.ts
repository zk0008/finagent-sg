/**
 * app/api/history/excel/route.ts
 *
 * GET /api/history/excel?schemaName=<schema>&modelId=<id>
 *
 * Fetches a saved financial model from Supabase and generates an Excel workbook.
 * Called from the History page download button — the page only has the model ID,
 * not the full projection data, so this route loads it from DB and exports.
 *
 * Returns: .xlsx file download
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateModelExcel } from "@/lib/modelExcelExport";

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const { searchParams } = req.nextUrl;
  const schemaName = searchParams.get("schemaName");
  const modelId = searchParams.get("modelId");

  if (!schemaName || !modelId) {
    return NextResponse.json(
      { error: "schemaName and modelId are required" },
      { status: 400 }
    );
  }

  // Fetch the full model record
  const { data: model, error } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .select("model_name, projection_years, assumptions, base_case, best_case, worst_case, fiscal_year_id, created_at")
    .eq("id", modelId)
    .maybeSingle();

  if (error || !model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  // Derive base_year from fiscal_year end_date, fall back to created_at year
  let baseYear = new Date(model.created_at as string).getFullYear();
  if (model.fiscal_year_id) {
    const { data: fy } = await supabase
      .schema(schemaName)
      .from("fiscal_years")
      .select("end_date")
      .eq("id", model.fiscal_year_id)
      .maybeSingle();
    if (fy?.end_date) {
      baseYear = parseInt((fy.end_date as string).slice(0, 4), 10);
    }
  }

  try {
    const buffer = await generateModelExcel({
      modelName:       model.model_name as string,
      projectionYears: model.projection_years as number,
      baseYear,
      assumptions:     model.assumptions as Parameters<typeof generateModelExcel>[0]["assumptions"],
      base_case:       (model.base_case ?? []) as Parameters<typeof generateModelExcel>[0]["base_case"],
      best_case:       (model.best_case ?? []) as Parameters<typeof generateModelExcel>[0]["best_case"],
      worst_case:      (model.worst_case ?? []) as Parameters<typeof generateModelExcel>[0]["worst_case"],
    });

    const safeModelName = (model.model_name as string).replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="financial-model-${safeModelName}.xlsx"`,
        "Content-Length":      String(buffer.length),
      },
    });
  } catch (err) {
    console.error("[history/excel] Excel generation failed:", err);
    return NextResponse.json({ error: "Excel generation failed" }, { status: 500 });
  }
}
