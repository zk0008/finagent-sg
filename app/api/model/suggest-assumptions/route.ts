/**
 * app/api/model/suggest-assumptions/route.ts
 *
 * POST /api/model/suggest-assumptions
 *
 * What this route does:
 * Accepts a client schema name, loads the latest saved FS output from Supabase,
 * and calls the assumption suggester to return AI-generated projection assumptions
 * with rationales. The frontend presents these to the user for confirmation or
 * modification before the projection engine runs.
 *
 * Phase 3, Prompt 5 — AI assumption suggester endpoint.
 *
 * Request body:
 *   { schemaName: string }
 *
 * Response (200):
 *   {
 *     assumptions: ProjectionAssumptions,
 *     rationales: {
 *       revenue_growth_pct: string,
 *       cogs_growth_pct: string,
 *       opex_growth_pct: string,
 *       depreciation_method: string,
 *       tax_rate_pct: string
 *     }
 *   }
 *
 * Error responses:
 *   400 — missing schemaName, or no FS output found
 *   500 — AI call or Supabase read failed
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getLatestFSOutput } from "@/lib/modelStorage";
import { suggestAssumptions } from "@/lib/assumptionSuggester";

// Validate the request body shape.
const RequestSchema = z.object({
  schemaName: z.string().min(1, "schemaName is required"),
  // companyType and isAuditExempt are stored in the entity record, not the FS output.
  // The frontend passes these directly since it already has the entity in state.
  companyType: z.enum(["private_ltd", "llp", "sole_prop"]).default("private_ltd"),
  isAuditExempt: z.boolean().default(false),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Parse and validate the request body.
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

  const { schemaName, companyType, isAuditExempt } = body;

  // Load the latest saved FS output for this client schema.
  // This is the ONLY source of base data — no output ID picker.
  let savedOutput;
  try {
    savedOutput = await getLatestFSOutput(schemaName);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load FS output" },
      { status: 500 }
    );
  }

  if (!savedOutput) {
    return NextResponse.json(
      { error: "No financial statements found. Please generate FS first." },
      { status: 400 }
    );
  }

  // Run the AI assumption suggester against the classified accounts.
  let suggestion;
  try {
    suggestion = await suggestAssumptions({
      classifiedAccounts: savedOutput.classified_accounts,
      companyType,
      isAuditExempt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate assumption suggestions" },
      { status: 500 }
    );
  }

  return NextResponse.json(suggestion, { status: 200 });
}
