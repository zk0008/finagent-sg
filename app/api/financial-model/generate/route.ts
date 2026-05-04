/**
 * app/api/financial-model/generate/route.ts
 *
 * Thin JSON wrapper for the financial model pipeline — used by the agent layer.
 *
 * Loads classified accounts from the specified FS output, then runs all three
 * projection scenarios (base, best, worst) via runAllScenarios() — a single
 * deterministic call, no AI involved.
 *
 * Assumptions are loaded from the entity's last active financial model in
 * Supabase. If no active model exists, conservative Singapore-appropriate
 * defaults are applied (5% revenue growth, 3% COGS/OPEX, 17% tax, straight-line
 * depreciation). The user can adjust these via the UI after reviewing results.
 *
 * This route generates projections only — it does not save the model to DB.
 * Saving is a deliberate user action triggered from the UI (Phase 3 flow).
 *
 * Called by: financialModelNode in lib/agents/nodes/index.ts
 *
 * POST /api/financial-model/generate
 * Input:  { clientId: string, projectionPeriodYears: number, fsOutputId: string }
 * Output: { base_case, best_case, worst_case, source_output_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { runAllScenarios } from "@/lib/scenarioAnalysis";
import type { ClassifiedAccount, ProjectionAssumptions } from "@/lib/schemas";

// Conservative Singapore-appropriate defaults used when no prior model exists.
// These match the typical SG SME growth range and the statutory 17% corporate tax rate.
const DEFAULT_ASSUMPTIONS: ProjectionAssumptions = {
  revenue_growth_pct:       5,                 // 5% year-on-year revenue growth
  cogs_growth_pct:          3,                 // 3% cost growth (below revenue — improving margin)
  opex_growth_pct:          3,                 // 3% operating expense growth
  depreciation_method:      "straight_line",   // standard method; safe default
  tax_rate_pct:             17,                // SG corporate income tax rate
  custom_line_assumptions:  [],                // no per-account overrides
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { // top-level catch — prevents Next.js from returning an HTML 500 page on any unhandled throw
  // Parse the simplified agent request body
  let body: { clientId: string; projectionPeriodYears: number; fsOutputId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { clientId, projectionPeriodYears, fsOutputId } = body;

  if (!clientId || !projectionPeriodYears || !fsOutputId) {
    return NextResponse.json(
      { error: "clientId, projectionPeriodYears, and fsOutputId are required" },
      { status: 400 }
    );
  }

  // clientId is the schema slug throughout the agent layer (e.g. "techsoft_pte_ltd")
  const schemaName = clientId;

  const allowed = await verifySchemaAccess(schemaName);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Step 1: Load FS output to get classified accounts ─────────────────────
  // The projection engine needs classified accounts as its base data
  const { data: outputRow, error: outputError } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("classified_accounts, fiscal_year_id")
    .eq("id", fsOutputId)
    .single();

  if (outputError || !outputRow) {
    return NextResponse.json(
      { error: `FS output not found: ${fsOutputId}` },
      { status: 404 }
    );
  }

  const classifiedAccounts = outputRow.classified_accounts as ClassifiedAccount[];

  // ── Step 2: Derive base year from fiscal year end date ────────────────────
  // The projection engine needs a calendar year number (e.g. 2025) as baseYear
  const { data: fyRow, error: fyError } = await supabase
    .schema(schemaName)
    .from("fiscal_years")
    .select("end_date")
    .eq("id", outputRow.fiscal_year_id)
    .single();

  if (fyError || !fyRow) {
    return NextResponse.json(
      { error: "Fiscal year not found for this FS output" },
      { status: 404 }
    );
  }

  // Supabase returns DATE as "YYYY-MM-DD" string; append time to avoid UTC offset issues
  const baseYear = new Date(fyRow.end_date + "T00:00:00").getFullYear();

  // ── Step 3: Load assumptions from last active model (or use defaults) ─────
  // Re-using prior assumptions gives consistent projections if the user already
  // configured them; defaults kick in only for first-time runs
  let assumptions: ProjectionAssumptions = DEFAULT_ASSUMPTIONS;
  try {
    const { data: modelRow } = await supabase
      .schema(schemaName)
      .from("financial_models")
      .select("assumptions")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (modelRow?.assumptions) {
      // Active model found — reuse its assumptions so this run is comparable
      assumptions = modelRow.assumptions as ProjectionAssumptions;
    }
  } catch {
    // Non-fatal: no active model or query failed — fall through to defaults
  }

  // ── Step 4: Run all three scenario projections ─────────────────────────────
  // runAllScenarios runs base, best, and worst cases as three independent
  // projectFinancials() calls — deterministic, no AI
  let scenarios;
  try {
    scenarios = runAllScenarios(
      classifiedAccounts,
      assumptions,
      projectionPeriodYears,
      baseYear
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Projection failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    base_case:        scenarios.base_case,
    best_case:        scenarios.best_case,
    worst_case:       scenarios.worst_case,
    source_output_id: fsOutputId,   // lets the caller link results back to the FS that was used
  });
  } catch (err) {
    // Unhandled throw — return JSON so the calling node always gets a parseable response
    console.error("[financial-model/generate] Unexpected error:", err);
    return NextResponse.json(
      { error: `Internal server error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
