/**
 * lib/scenarioAnalysis.ts
 *
 * Deterministic scenario analysis engine for FinAgent-SG Phase 3.
 *
 * What this module does:
 * Takes the user-confirmed base case assumptions and derives best case and
 * worst case variants by applying fixed percentage-point deltas to each
 * growth rate. Then runs the projection engine three times — once per
 * scenario — and returns all three sets of projected financial statements.
 *
 * Design:
 * - No AI involved. Scenario deltas are deterministic and configurable
 *   via constants at the top of this file.
 * - All arithmetic is delegated to projectionEngine.projectFinancials(),
 *   which in turn uses bignumber.js for all calculations.
 * - Tax rate and depreciation method are scenario-invariant (same across
 *   all three cases) — only growth rates differ between scenarios.
 * - The worst case revenue floor is 0%: revenue cannot be projected to
 *   shrink by default (the user can override via custom_line_assumptions
 *   if they want to model a revenue decline).
 *
 * Called by: Phase 3 API routes (Prompt 8) and Prompt 10 pipeline.
 */

import { type ClassifiedAccount, type ProjectionAssumptions, type ProjectedFS } from "./schemas";
import { projectFinancials } from "./projectionEngine";

// ── Configurable scenario deltas ──────────────────────────────────────────────
// All values are percentage points added to or subtracted from the base rate.
// Adjust these constants to change the spread between scenarios without
// modifying any downstream logic.

/** Best case: revenue grows faster than base by this many percentage points. */
const BEST_REVENUE_DELTA = 5;

/** Best case: COGS grows slower than base by this many percentage points. */
const BEST_COGS_DELTA = -2;

/** Best case: OPEX grows slower than base by this many percentage points. */
const BEST_OPEX_DELTA = -2;

/** Worst case: revenue grows slower than base by this many percentage points. */
const WORST_REVENUE_DELTA = -5;

/** Worst case: COGS grows faster than base by this many percentage points. */
const WORST_COGS_DELTA = 3;

/** Worst case: OPEX grows faster than base by this many percentage points. */
const WORST_OPEX_DELTA = 3;

/**
 * Minimum revenue growth rate applied in the worst case.
 * Prevents projecting revenue contraction unless the user explicitly
 * sets a negative rate via custom_line_assumptions.
 */
const WORST_REVENUE_FLOOR_PCT = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScenarioAssumptions = {
  best_case: ProjectionAssumptions;
  worst_case: ProjectionAssumptions;
};

export type ScenarioResults = {
  base_case: ProjectedFS[];
  best_case: ProjectedFS[];
  worst_case: ProjectedFS[];
};

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Derives best case and worst case assumption sets from the base case.
 *
 * Only growth rates change between scenarios. Tax rate, depreciation method,
 * and custom_line_assumptions are carried through unchanged.
 *
 * @param baseAssumptions - User-confirmed base case ProjectionAssumptions
 * @returns { best_case, worst_case } assumption objects
 */
export function generateScenarios(
  baseAssumptions: ProjectionAssumptions
): ScenarioAssumptions {
  const best_case: ProjectionAssumptions = {
    revenue_growth_pct: baseAssumptions.revenue_growth_pct + BEST_REVENUE_DELTA,
    cogs_growth_pct:    baseAssumptions.cogs_growth_pct    + BEST_COGS_DELTA,
    opex_growth_pct:    baseAssumptions.opex_growth_pct    + BEST_OPEX_DELTA,
    depreciation_method:      baseAssumptions.depreciation_method,
    tax_rate_pct:             baseAssumptions.tax_rate_pct,
    custom_line_assumptions:  baseAssumptions.custom_line_assumptions,
  };

  const worst_case: ProjectionAssumptions = {
    revenue_growth_pct: Math.max(
      baseAssumptions.revenue_growth_pct + WORST_REVENUE_DELTA,
      WORST_REVENUE_FLOOR_PCT
    ),
    cogs_growth_pct:    baseAssumptions.cogs_growth_pct + WORST_COGS_DELTA,
    opex_growth_pct:    baseAssumptions.opex_growth_pct + WORST_OPEX_DELTA,
    depreciation_method:      baseAssumptions.depreciation_method,
    tax_rate_pct:             baseAssumptions.tax_rate_pct,
    custom_line_assumptions:  baseAssumptions.custom_line_assumptions,
  };

  return { best_case, worst_case };
}

/**
 * Runs the projection engine for all three scenarios (base, best, worst)
 * and returns the results.
 *
 * Each scenario is an independent call to projectFinancials() — no state
 * is shared between runs.
 *
 * @param classifiedAccounts - Base year trial balance (from latest FS output)
 * @param baseAssumptions    - User-confirmed base case assumptions
 * @param projectionYears    - How many years to project (1–5)
 * @param baseYear           - Calendar year of the base FS (e.g. 2025)
 * @returns { base_case, best_case, worst_case } — each an array of ProjectedFS
 */
export function runAllScenarios(
  classifiedAccounts: ClassifiedAccount[],
  baseAssumptions: ProjectionAssumptions,
  projectionYears: number,
  baseYear: number
): ScenarioResults {
  const { best_case: bestAssumptions, worst_case: worstAssumptions } =
    generateScenarios(baseAssumptions);

  const base_case = projectFinancials({
    classifiedAccounts,
    assumptions: baseAssumptions,
    projectionYears,
    baseYear,
  });

  const best_case = projectFinancials({
    classifiedAccounts,
    assumptions: bestAssumptions,
    projectionYears,
    baseYear,
  });

  const worst_case = projectFinancials({
    classifiedAccounts,
    assumptions: worstAssumptions,
    projectionYears,
    baseYear,
  });

  return { base_case, best_case, worst_case };
}
