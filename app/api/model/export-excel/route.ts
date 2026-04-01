/**
 * app/api/model/export-excel/route.ts
 *
 * POST /api/model/export-excel
 *
 * What this route does:
 * Accepts the full model data from the frontend (no extra DB call) and generates
 * an Excel workbook via modelExcelExport.ts. Returns the file as a binary download.
 *
 * The request body contains the full model state already held in the browser
 * after running projections — this avoids a round-trip to Supabase.
 *
 * Phase 3, Prompt 9 — model Excel export endpoint.
 *
 * Request body:
 * {
 *   model_name:       string,
 *   base_year:        number,
 *   projection_years: number,
 *   assumptions:      ProjectionAssumptions,
 *   rationales?:      Record<string, string>,
 *   base_case:        ProjectedFS[],
 *   best_case:        ProjectedFS[],
 *   worst_case:       ProjectedFS[],
 *   bva?:             { year, bva_result, summary }
 * }
 *
 * Response: .xlsx file download
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { generateModelExcel } from "@/lib/modelExcelExport";
import { ProjectionAssumptionsSchema, ProjectedFSSchema } from "@/lib/schemas";

const RequestSchema = z.object({
  model_name:       z.string().min(1),
  base_year:        z.number().int(),
  projection_years: z.number().int().min(1).max(5),
  assumptions:      ProjectionAssumptionsSchema,
  rationales:       z.record(z.string(), z.string()).optional(),
  base_case:        z.array(ProjectedFSSchema),
  best_case:        z.array(ProjectedFSSchema),
  worst_case:       z.array(ProjectedFSSchema),
  bva: z
    .object({
      year:       z.number().int().min(1).max(5),
      bva_result: z.array(z.unknown()),
      summary:    z.unknown(),
    })
    .optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const buffer = await generateModelExcel({
      modelName:       body.model_name,
      projectionYears: body.projection_years,
      baseYear:        body.base_year,
      assumptions:     body.assumptions,
      rationales:      body.rationales,
      base_case:       body.base_case,
      best_case:       body.best_case,
      worst_case:      body.worst_case,
      bva:             body.bva as Parameters<typeof generateModelExcel>[0]["bva"],
    });

    const safeModelName = body.model_name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    const filename = `financial-model-${safeModelName}.xlsx`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      String(buffer.length),
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Excel generation failed: ${(err as Error).message}` }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
