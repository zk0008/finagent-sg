/**
 * app/api/model/save/route.ts
 *
 * POST /api/model/save
 *
 * What this route does:
 * Saves a generated financial model to Supabase via modelStorage.saveFinancialModel().
 * Automatically deactivates the previous active model for the entity and sets
 * the new model as active. Always inserts a new row — never overwrites.
 *
 * Phase 3, Prompt 8 — model save endpoint.
 *
 * Request body:
 * {
 *   schemaName:       string,
 *   entity_id:        string (UUID),
 *   fiscal_year_id:   string | null,
 *   source_output_id: string (UUID),
 *   model_name:       string,
 *   projection_years: number (1–5),
 *   assumptions:      ProjectionAssumptions,
 *   base_case:        ProjectedFS[],
 *   best_case:        ProjectedFS[],
 *   worst_case:       ProjectedFS[]
 * }
 *
 * Response (200):
 * { model_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveFinancialModel } from "@/lib/modelStorage";
import {
  ProjectionAssumptionsSchema,
  ProjectedFSSchema,
} from "@/lib/schemas";

const RequestSchema = z.object({
  schemaName:       z.string().min(1),
  entity_id:        z.string().uuid(),
  fiscal_year_id:   z.string().uuid().nullable().default(null),
  source_output_id: z.string().uuid(),
  model_name:       z.string().min(1),
  projection_years: z.number().int().min(1).max(5),
  assumptions:      ProjectionAssumptionsSchema,
  base_case:        z.array(ProjectedFSSchema),
  best_case:        z.array(ProjectedFSSchema),
  worst_case:       z.array(ProjectedFSSchema),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const {
    schemaName,
    entity_id,
    fiscal_year_id,
    source_output_id,
    model_name,
    projection_years,
    assumptions,
    base_case,
    best_case,
    worst_case,
  } = body;

  let modelId: string;
  try {
    modelId = await saveFinancialModel(schemaName, {
      entityId:        entity_id,
      fiscalYearId:    fiscal_year_id,
      sourceOutputId:  source_output_id,
      modelName:       model_name,
      projectionYears: projection_years,
      assumptions,
      baseCase:        base_case,
      bestCase:        best_case,
      worstCase:       worst_case,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save model" },
      { status: 500 }
    );
  }

  return NextResponse.json({ model_id: modelId }, { status: 200 });
}
