/**
 * lib/taxEngine.ts
 *
 * Corporate Tax Computation Engine — Phase 7.
 *
 * What this module does:
 * Computes Singapore corporate income tax for a given fiscal year.
 * Pure arithmetic only — no AI. All calculations use bignumber.js.
 *
 * Tax rules applied (as at YA 2026):
 * - Flat rate: 17% of chargeable income
 * - New Start-Up exemption: 75% on first $100K, 50% on next $100K
 * - Partial Tax Exemption: 75% on first $10K, 50% on next $190K
 * - YA 2026 CIT Rebate: 40% of tax, capped at $30,000
 * - CIT Rebate Cash Grant: $1,500 if local employee CPF contributions made
 * - Total benefit (rebate + cash grant) capped at $30,000
 *
 * Reference: skills/sg-corporate-tax/SKILL.md
 *
 * Called by: app/api/tax/compute/route.ts
 */

import BigNumber from "bignumber.js";
import type { TaxComputationInput, TaxComputationResult } from "./schemas";

// Configure BigNumber: 10 decimal places, ROUND_HALF_UP
BigNumber.config({ DECIMAL_PLACES: 10, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

// ── Tax constants (YA 2026) ────────────────────────────────────────────────
const TAX_RATE = new BigNumber("0.17");                  // 17% flat rate

// New Start-Up exemption tiers
const STARTUP_TIER1_CAP    = new BigNumber("100000");    // First $100,000
const STARTUP_TIER1_EXEMPT = new BigNumber("0.75");      // 75% exempt
const STARTUP_TIER2_CAP    = new BigNumber("100000");    // Next $100,000
const STARTUP_TIER2_EXEMPT = new BigNumber("0.50");      // 50% exempt

// Partial Tax Exemption tiers
const PARTIAL_TIER1_CAP    = new BigNumber("10000");     // First $10,000
const PARTIAL_TIER1_EXEMPT = new BigNumber("0.75");      // 75% exempt
const PARTIAL_TIER2_CAP    = new BigNumber("190000");    // Next $190,000
const PARTIAL_TIER2_EXEMPT = new BigNumber("0.50");      // 50% exempt

// CIT Rebate (YA 2026)
const CIT_REBATE_RATE    = new BigNumber("0.40");        // 40% rebate
const CIT_REBATE_CAP     = new BigNumber("30000");       // $30,000 maximum total benefit
const CIT_CASH_GRANT     = new BigNumber("1500");        // $1,500 cash grant

// Form type revenue thresholds
const FORM_CS_LITE_CAP = new BigNumber("200000");        // ≤ $200,000 → C-S Lite
const FORM_CS_CAP      = new BigNumber("5000000");       // ≤ $5,000,000 → C-S

export interface TaxExemptionResult {
  exempt_amount: string;
  taxable_income: string;
}

export interface CITRebateResult {
  cit_rebate: string;
  cit_rebate_cash_grant: string;
}

/**
 * Determines the IRAS filing form type based on annual revenue.
 * C-S Lite: revenue ≤ $200,000
 * C-S:      revenue ≤ $5,000,000
 * C:        revenue > $5,000,000
 */
export function determineFormType(revenue: string): "C-S_Lite" | "C-S" | "C" {
  const rev = new BigNumber(revenue);
  if (rev.isLessThanOrEqualTo(FORM_CS_LITE_CAP)) return "C-S_Lite";
  if (rev.isLessThanOrEqualTo(FORM_CS_CAP))      return "C-S";
  return "C";
}

/**
 * Returns the applicable exemption scheme based on whether the company
 * qualifies as a new start-up (first 3 Years of Assessment).
 */
export function determineExemptionScheme(isNewStartup: boolean): "new_startup" | "partial" {
  return isNewStartup ? "new_startup" : "partial";
}

/**
 * Applies the correct tax exemption tiers to chargeable income.
 * Returns the total exempt amount and the remaining taxable income.
 *
 * New Start-Up: 75% on first $100K + 50% on next $100K
 * Partial:      75% on first $10K  + 50% on next $190K
 */
export function applyTaxExemption(
  chargeableIncome: string,
  scheme: "new_startup" | "partial"
): TaxExemptionResult {
  const income = new BigNumber(chargeableIncome);

  // If chargeable income is zero or negative, no exemption applies
  if (income.isLessThanOrEqualTo(0)) {
    return { exempt_amount: "0", taxable_income: "0" };
  }

  const tier1Cap    = scheme === "new_startup" ? STARTUP_TIER1_CAP    : PARTIAL_TIER1_CAP;
  const tier1Exempt = scheme === "new_startup" ? STARTUP_TIER1_EXEMPT : PARTIAL_TIER1_EXEMPT;
  const tier2Cap    = scheme === "new_startup" ? STARTUP_TIER2_CAP    : PARTIAL_TIER2_CAP;
  const tier2Exempt = scheme === "new_startup" ? STARTUP_TIER2_EXEMPT : PARTIAL_TIER2_EXEMPT;

  // Tier 1: apply to the first slice of income (up to tier1Cap)
  const tier1Income  = BigNumber.min(income, tier1Cap);
  const tier1Relief  = tier1Income.multipliedBy(tier1Exempt);

  // Tier 2: apply to the next slice (above tier1Cap, up to tier2Cap)
  const tier2Income  = BigNumber.min(BigNumber.max(income.minus(tier1Cap), 0), tier2Cap);
  const tier2Relief  = tier2Income.multipliedBy(tier2Exempt);

  const totalExempt  = tier1Relief.plus(tier2Relief);
  const taxableIncome = BigNumber.max(income.minus(totalExempt), 0);

  return {
    exempt_amount:   totalExempt.toFixed(2),
    taxable_income:  taxableIncome.toFixed(2),
  };
}

/**
 * Computes the YA 2026 CIT Rebate and CIT Rebate Cash Grant.
 *
 * CIT Rebate:    40% of gross tax, subject to overall $30,000 cap
 * Cash Grant:    $1,500 if company made CPF contributions to a local employee in 2025
 * Total benefit (rebate + cash grant) cannot exceed $30,000.
 */
export function computeCITRebate(
  grossTax: string,
  hasLocalEmployee: boolean
): CITRebateResult {
  const tax = new BigNumber(grossTax);

  // Compute 40% rebate
  const rebate40 = tax.multipliedBy(CIT_REBATE_RATE);

  // Cash grant applies only if company has local employee CPF contributions
  const cashGrant = hasLocalEmployee ? CIT_CASH_GRANT : new BigNumber("0");

  // Total benefit is rebate + cash grant, capped at $30,000
  const totalBenefit = BigNumber.min(rebate40.plus(cashGrant), CIT_REBATE_CAP);

  // If cash grant pushes over cap, reduce rebate; cash grant takes priority if under cap
  let finalCashGrant: BigNumber;
  let finalRebate: BigNumber;

  if (cashGrant.isGreaterThan(0)) {
    // Cash grant is paid in full if total benefit is within cap
    finalCashGrant = BigNumber.min(cashGrant, totalBenefit);
    finalRebate    = BigNumber.max(totalBenefit.minus(finalCashGrant), 0);
    // Rebate cannot exceed the computed 40% amount
    finalRebate    = BigNumber.min(finalRebate, rebate40);
  } else {
    finalCashGrant = new BigNumber("0");
    finalRebate    = BigNumber.min(rebate40, CIT_REBATE_CAP);
  }

  return {
    cit_rebate:            finalRebate.toFixed(2),
    cit_rebate_cash_grant: finalCashGrant.toFixed(2),
  };
}

/**
 * Main tax computation function.
 * Runs the complete corporate tax calculation in sequence:
 *   1. Sum add-back adjustments
 *   2. Sum deduction adjustments
 *   3. Compute chargeable income
 *   4. Determine form type from revenue
 *   5. Determine exemption scheme
 *   6. Apply exemption tiers
 *   7. Compute gross tax at 17%
 *   8. Apply YA 2026 CIT Rebate
 *   9. Compute net tax payable (minimum $0)
 *  10. Compute filing deadlines
 *  11. Determine ECI filing requirement
 */
export function computeTax(input: TaxComputationInput): TaxComputationResult {
  const {
    accounting_profit,
    revenue,
    is_new_startup,
    is_local_employee_cpf,
    tax_adjustments,
  } = input;

  // ── Step 1 & 2: Sum adjustments ───────────────────────────────────────────
  let totalAddBacks   = new BigNumber("0");
  let totalDeductions = new BigNumber("0");

  for (const adj of tax_adjustments) {
    const amt = new BigNumber(adj.amount);
    if (adj.type === "add_back") {
      totalAddBacks = totalAddBacks.plus(amt.abs());
    } else {
      totalDeductions = totalDeductions.plus(amt.abs());
    }
  }

  // ── Step 3: Chargeable income ─────────────────────────────────────────────
  const profit          = new BigNumber(accounting_profit);
  const chargeableIncome = BigNumber.max(
    profit.plus(totalAddBacks).minus(totalDeductions),
    new BigNumber("0")
  );

  // ── Step 4 & 5: Form type and exemption scheme ────────────────────────────
  const formType        = determineFormType(revenue);
  const exemptionScheme = determineExemptionScheme(is_new_startup);

  // ── Step 6: Apply tax exemption ───────────────────────────────────────────
  const { exempt_amount, taxable_income } = applyTaxExemption(
    chargeableIncome.toFixed(2),
    exemptionScheme
  );

  // ── Step 7: Gross tax ─────────────────────────────────────────────────────
  const grossTax = new BigNumber(taxable_income).multipliedBy(TAX_RATE);

  // ── Step 8: CIT Rebate (YA 2026) ─────────────────────────────────────────
  const { cit_rebate, cit_rebate_cash_grant } = computeCITRebate(
    grossTax.toFixed(2),
    is_local_employee_cpf
  );

  // ── Step 9: Net tax payable ───────────────────────────────────────────────
  const taxPayable = BigNumber.max(
    grossTax.minus(new BigNumber(cit_rebate)).minus(new BigNumber(cit_rebate_cash_grant)),
    new BigNumber("0")
  );

  // ── Step 10: Filing deadlines ─────────────────────────────────────────────
  // Year of Assessment = calendar year following the financial year end.
  // The fiscal_year_id in the input is a UUID; we need the FYE date from the accounting context.
  // We derive YA from the current date heuristic: if the accounting profit implies a
  // recent FY, YA is determined by the entity's FYE.
  // Since we don't have FYE here, we use the current year as a fallback.
  // The API route should pass fiscal year end date; for the engine we compute deadlines
  // based on a `fiscal_year_end` field that callers must supply via the extended input.
  // For this engine function, we accept an optional `fiscal_year_end` via the input
  // by reading it from the input object directly (it is passed through the API route).
  const fyeDate = (input as TaxComputationInput & { fiscal_year_end?: string }).fiscal_year_end;

  let yearOfAssessment: number;
  let eciDeadline: string;
  let formFilingDeadline: string;

  if (fyeDate) {
    // YA = year after the FYE year
    const fyeYear = parseInt(fyeDate.slice(0, 4), 10);
    const fyeMonth = parseInt(fyeDate.slice(5, 7), 10);
    yearOfAssessment = fyeYear + 1;

    // ECI deadline: 3 months after FYE month end
    const eciMonth = ((fyeMonth - 1 + 3) % 12) + 1;
    const eciYear  = fyeYear + Math.floor((fyeMonth - 1 + 3) / 12);
    eciDeadline = formatDeadlineDate(eciYear, eciMonth);
  } else {
    yearOfAssessment = new Date().getFullYear();
    eciDeadline      = "3 months after financial year end";
  }

  // Form filing deadline is always 30 November of the YA
  formFilingDeadline = `30 Nov ${yearOfAssessment}`;

  // ── Step 11: ECI filing requirement ──────────────────────────────────────
  // ECI filing required if: revenue > $5M OR chargeable income > 0
  // ECI exemption: revenue ≤ $5M AND ECI is nil (chargeable income = 0)
  const eci_filing_required =
    new BigNumber(revenue).isGreaterThan(FORM_CS_CAP) ||
    chargeableIncome.isGreaterThan(0);

  return {
    year_of_assessment:    yearOfAssessment,
    form_type:             formType,
    accounting_profit:     new BigNumber(accounting_profit).toFixed(2),
    total_add_backs:       totalAddBacks.toFixed(2),
    total_deductions:      totalDeductions.toFixed(2),
    chargeable_income:     chargeableIncome.toFixed(2),
    exemption_scheme:      exemptionScheme,
    exempt_amount,
    taxable_income,
    gross_tax:             grossTax.toFixed(2),
    cit_rebate,
    cit_rebate_cash_grant,
    tax_payable:           taxPayable.toFixed(2),
    eci_filing_required,
    eci_deadline:          eciDeadline,
    form_filing_deadline:  formFilingDeadline,
  };
}

/** Formats a year + month number as "DD Mon YYYY" last-day-of-month string */
function formatDeadlineDate(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${lastDay} ${monthNames[month - 1]} ${year}`;
}
