/**
 * lib/exemptionChecker.ts
 *
 * Singapore small company audit exemption checker for FinAgent-SG.
 *
 * What this module does:
 * Pure TypeScript logic (no AI) that determines whether a Singapore
 * private limited company qualifies for audit exemption under the
 * Companies Act (as at 2026).
 *
 * Rules applied:
 * 1. Small Company: ALL THREE of — revenue < $10M, assets < $10M, employees < 50
 * 2. Exempt Private Company (EPC): no corporate shareholders AND ≤ 20 shareholders
 * 3. Audit Exempt: company must qualify as BOTH small company AND EPC
 *
 * Returns an ExemptionResult with boolean flags and a human-readable reasons array
 * explaining each determination. The reasons are displayed to the user in the UI.
 *
 * Called by: trigger/fsGenerationJob.ts (Task 6) in Step 3 of the pipeline.
 * No AI involved — pure threshold logic only.
 */

import { type ExemptionInput, type ExemptionResult } from "./schemas";

// Singapore small company thresholds (Companies Act, as at 2026)
const SMALL_COMPANY_REVENUE_THRESHOLD = 10_000_000; // SGD 10 million
const SMALL_COMPANY_ASSETS_THRESHOLD = 10_000_000;  // SGD 10 million
const SMALL_COMPANY_EMPLOYEE_THRESHOLD = 50;          // head count

// EPC shareholder limit
const EPC_MAX_SHAREHOLDERS = 20;

/**
 * Checks whether a company qualifies for audit exemption under Singapore law.
 *
 * All threshold comparisons use strict less-than (<) for revenue and assets,
 * and strict less-than (<) for employees — meeting the threshold exactly
 * (e.g. exactly $10M revenue) does NOT qualify.
 *
 * @param data - ExemptionInput containing financial metrics and shareholder info
 * @returns ExemptionResult with is_small_company, is_epc, is_audit_exempt, reasons[]
 */
export function checkExemption(data: ExemptionInput): ExemptionResult {
  const reasons: string[] = [];

  // ── Small Company Check ──────────────────────────────────────────────────
  // All three criteria must be met simultaneously. Each is checked independently
  // so we can produce a specific reason for any criterion that is not met.

  // Check 1: Annual revenue threshold
  // Criterion: revenue strictly less than SGD 10,000,000
  const revenueQualifies = data.revenue < SMALL_COMPANY_REVENUE_THRESHOLD;
  if (revenueQualifies) {
    reasons.push(
      `Revenue SGD ${formatAmount(data.revenue)} is below the $10M threshold — qualifies.`
    );
  } else {
    reasons.push(
      `Revenue SGD ${formatAmount(data.revenue)} meets or exceeds the $10M threshold — does not qualify as small company.`
    );
  }

  // Check 2: Total assets threshold
  // Criterion: total assets strictly less than SGD 10,000,000
  const assetsQualify = data.total_assets < SMALL_COMPANY_ASSETS_THRESHOLD;
  if (assetsQualify) {
    reasons.push(
      `Total assets SGD ${formatAmount(data.total_assets)} are below the $10M threshold — qualifies.`
    );
  } else {
    reasons.push(
      `Total assets SGD ${formatAmount(data.total_assets)} meet or exceed the $10M threshold — does not qualify as small company.`
    );
  }

  // Check 3: Employee count threshold
  // Criterion: fewer than 50 employees (strictly less than, so 50 does not qualify)
  const employeesQualify = data.employee_count < SMALL_COMPANY_EMPLOYEE_THRESHOLD;
  if (employeesQualify) {
    reasons.push(
      `Employee count ${data.employee_count} is below 50 — qualifies.`
    );
  } else {
    reasons.push(
      `Employee count ${data.employee_count} meets or exceeds 50 — does not qualify as small company.`
    );
  }

  // is_small_company is true only when ALL three criteria pass
  const is_small_company = revenueQualifies && assetsQualify && employeesQualify;
  if (is_small_company) {
    reasons.push("Qualifies as a Small Company (all three criteria met).");
  } else {
    reasons.push(
      "Does not qualify as a Small Company (one or more criteria not met — all three must be satisfied)."
    );
  }

  // ── Exempt Private Company (EPC) Check ──────────────────────────────────
  // EPC requires: no corporate shareholders AND 20 or fewer total shareholders.

  // Check 4: No corporate shareholders
  // A corporate shareholder is any company (as opposed to a natural person) that holds shares.
  const noCorporateShareholders = !data.has_corporate_shareholders;
  if (noCorporateShareholders) {
    reasons.push("No corporate shareholders — satisfies EPC requirement.");
  } else {
    reasons.push(
      "Has one or more corporate shareholders — does not qualify as EPC."
    );
  }

  // Check 5: Shareholder count ≤ 20
  const shareholderCountQualifies = data.shareholder_count <= EPC_MAX_SHAREHOLDERS;
  if (shareholderCountQualifies) {
    reasons.push(
      `Shareholder count ${data.shareholder_count} is ≤ 20 — satisfies EPC requirement.`
    );
  } else {
    reasons.push(
      `Shareholder count ${data.shareholder_count} exceeds 20 — does not qualify as EPC.`
    );
  }

  // is_epc is true only when both EPC conditions are satisfied
  const is_epc = noCorporateShareholders && shareholderCountQualifies;
  if (is_epc) {
    reasons.push("Qualifies as an Exempt Private Company (EPC).");
  } else {
    reasons.push("Does not qualify as an Exempt Private Company (EPC).");
  }

  // ── Audit Exemption Determination ────────────────────────────────────────
  // A company is audit-exempt ONLY if it is BOTH a small company AND an EPC.
  // Meeting only one condition is insufficient.
  const is_audit_exempt = is_small_company && is_epc;
  if (is_audit_exempt) {
    reasons.push(
      "AUDIT EXEMPT: Qualifies as both a Small Company and an EPC. " +
      "Statutory audit is not required under the Companies Act."
    );
  } else {
    const missing = [];
    if (!is_small_company) missing.push("Small Company");
    if (!is_epc) missing.push("EPC");
    reasons.push(
      `NOT AUDIT EXEMPT: Does not satisfy the ${missing.join(" and ")} requirement(s). ` +
      "A statutory audit is required."
    );
  }

  return {
    is_small_company,
    is_epc,
    is_audit_exempt,
    reasons,
  };
}

/**
 * Formats a number as a SGD amount with thousand separators and 2 decimal places.
 * Used only in reason strings — not a financial calculation.
 */
function formatAmount(value: number): string {
  return value.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
