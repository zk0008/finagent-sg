/**
 * lib/budgetVsActual.ts
 *
 * Budget-vs-actual comparison engine for FinAgent-SG Phase 3.
 *
 * What this module does:
 * Compares one year's projected financial statements (the "budget") against
 * actual results from a new trial balance upload. Produces a line-by-line
 * variance report and a summary of the key movements.
 *
 * Design:
 * - All arithmetic via bignumber.js — never native JS math.
 * - Matching between budget and actual is by normalised account_name
 *   (case-insensitive, trimmed). Budget items have no account_code in the
 *   projected FS; account_code in the output is sourced from the actual
 *   ClassifiedAccount when available, or empty string for budget-only items.
 * - Unmatched budget items (no actual): actual_amount = "0.00".
 * - Unmatched actual items (no budget): budget_amount = "0.00".
 * - Favorable logic follows standard management accounting convention:
 *     Revenue/Asset/Equity:   actual > budget = favorable
 *     Expense/Liability:      actual < budget = favorable
 * - Division by zero (budget = 0): variance_pct = "N/A".
 *
 * Budget line items are extracted from the ProjectedFS balance_sheet and
 * profit_and_loss sections, which store { label, amount } arrays grouped
 * by SFRS category.
 *
 * Called by: app/api/model/upload-actuals/route.ts (Phase 3, Prompt 7).
 */

import BigNumber from "bignumber.js";
import { type ClassifiedAccount, type ProjectedFS } from "./schemas";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BudgetVsActualItem = {
  account_code: string;
  account_name: string;
  category: string;
  budget_amount: string;    // SGD string, 2 decimal places
  actual_amount: string;    // SGD string, 2 decimal places
  variance_amount: string;  // actual − budget, 2 decimal places (negative = actual below budget)
  variance_pct: string;     // percentage of budget, 2 decimal places + "%" or "N/A"
  favorable: boolean;
};

export type BVASummary = {
  total_revenue_variance: string;
  total_expense_variance: string;
  net_profit_variance: string;
  top_3_favorable_variances: BudgetVsActualItem[];
  top_3_unfavorable_variances: BudgetVsActualItem[];
};

// ── Internal types ────────────────────────────────────────────────────────────

type BudgetEntry = {
  account_name: string;        // original casing preserved for display
  account_name_key: string;    // normalised key for matching
  category: string;
  budget_amount: BigNumber;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalises an account name for matching: lowercase, trimmed. */
function normalise(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Extracts all budget line items from the ProjectedFS.
 * Reads the { label, amount } arrays from balance_sheet and profit_and_loss.
 * Only individual account rows are extracted — totals and metadata fields are skipped.
 */
function extractBudgetEntries(projected: ProjectedFS): BudgetEntry[] {
  const bs = projected.balance_sheet as Record<string, unknown>;
  const pl = projected.profit_and_loss as Record<string, unknown>;
  const entries: BudgetEntry[] = [];

  function addSection(arr: unknown, category: string): void {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (
        item &&
        typeof item === "object" &&
        "label" in item &&
        "amount" in item &&
        typeof (item as Record<string, unknown>).label === "string"
      ) {
        const label = (item as { label: string; amount: unknown }).label;
        const amount = (item as { label: string; amount: unknown }).amount;
        entries.push({
          account_name: label,
          account_name_key: normalise(label),
          category,
          budget_amount: new BigNumber(String(amount ?? "0")).decimalPlaces(
            2,
            BigNumber.ROUND_HALF_UP
          ),
        });
      }
    }
  }

  addSection(bs.current_assets,           "current_asset");
  addSection(bs.non_current_assets,       "non_current_asset");
  addSection(bs.current_liabilities,      "current_liability");
  addSection(bs.non_current_liabilities,  "non_current_liability");
  addSection(bs.equity,                   "equity");
  addSection(pl.revenue_lines,            "revenue");
  addSection(pl.expense_lines,            "expense");

  return entries;
}

/**
 * Computes the net balance for an actual ClassifiedAccount in the normal direction.
 * Mirrors the getNetBalance logic in projectionEngine.ts.
 *   Debit-normal (asset, expense):      debit − credit
 *   Credit-normal (liability, equity, revenue): credit − debit
 */
function actualNetBalance(ca: ClassifiedAccount): BigNumber {
  const debit  = new BigNumber(ca.debit);
  const credit = new BigNumber(ca.credit);
  const debitNormal =
    ca.sfrs_category === "current_asset"     ||
    ca.sfrs_category === "non_current_asset" ||
    ca.sfrs_category === "expense";
  return (debitNormal ? debit.minus(credit) : credit.minus(debit))
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/**
 * Determines whether a variance is favorable.
 * Convention:
 *   Revenue / Asset / Equity:    actual > budget → favorable (variance > 0)
 *   Expense / Liability:         actual < budget → favorable (variance < 0)
 */
function isFavorable(category: string, variance: BigNumber): boolean {
  switch (category) {
    case "revenue":
    case "current_asset":
    case "non_current_asset":
    case "equity":
      return variance.isGreaterThan(0);
    case "expense":
    case "current_liability":
    case "non_current_liability":
      return variance.isLessThan(0);
    default:
      return variance.isGreaterThan(0);
  }
}

/** Formats a BigNumber as a fixed 2-decimal string. */
function fmt(n: BigNumber): string {
  return n.toFixed(2);
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Compares one year's projected FS (budget) against actual trial balance results.
 *
 * Matching is by normalised account_name. Unmatched items from either side
 * are included with a zero amount for the missing side.
 *
 * @param projected - One year's ProjectedFS from projectionEngine
 * @param actual    - ClassifiedAccount[] from the actual trial balance upload
 * @returns Array of BudgetVsActualItem, one per unique account (budget or actual)
 */
export function compareBudgetVsActual(
  projected: ProjectedFS,
  actual: ClassifiedAccount[]
): BudgetVsActualItem[] {
  const budgetEntries = extractBudgetEntries(projected);

  // Build a lookup map: normalised name → BudgetEntry
  const budgetMap = new Map<string, BudgetEntry>();
  for (const entry of budgetEntries) {
    budgetMap.set(entry.account_name_key, entry);
  }

  // Build a lookup map: normalised name → ClassifiedAccount
  const actualMap = new Map<string, ClassifiedAccount>();
  for (const ca of actual) {
    actualMap.set(normalise(ca.account_name), ca);
  }

  // Collect all unique account names from both sides
  const allKeys = new Set<string>([
    ...budgetMap.keys(),
    ...actualMap.keys(),
  ]);

  const result: BudgetVsActualItem[] = [];

  for (const key of allKeys) {
    const budgetEntry = budgetMap.get(key);
    const actualCA   = actualMap.get(key);

    // Determine display name, code, and category from whichever side has the account
    const account_name = budgetEntry?.account_name ?? actualCA!.account_name;
    const account_code = actualCA?.account_code ?? "";
    const category     = budgetEntry?.category ?? actualCA!.sfrs_category;

    const budgetAmt = budgetEntry?.budget_amount ?? new BigNumber(0);
    const actualAmt = actualCA ? actualNetBalance(actualCA) : new BigNumber(0);

    // variance = actual − budget
    const variance = actualAmt.minus(budgetAmt).decimalPlaces(2, BigNumber.ROUND_HALF_UP);

    // variance_pct = (variance / budget) × 100; "N/A" if budget is zero
    let variance_pct: string;
    if (budgetAmt.isZero()) {
      variance_pct = "N/A";
    } else {
      variance_pct =
        variance
          .dividedBy(budgetAmt.abs())
          .multipliedBy(100)
          .decimalPlaces(2, BigNumber.ROUND_HALF_UP)
          .toFixed(2) + "%";
    }

    result.push({
      account_code,
      account_name,
      category,
      budget_amount:   fmt(budgetAmt),
      actual_amount:   fmt(actualAmt),
      variance_amount: fmt(variance),
      variance_pct,
      favorable: isFavorable(category, variance),
    });
  }

  // Sort: revenue first, then assets, liabilities, equity, expenses
  const categoryOrder: Record<string, number> = {
    revenue: 0,
    current_asset: 1,
    non_current_asset: 2,
    current_liability: 3,
    non_current_liability: 4,
    equity: 5,
    expense: 6,
  };
  result.sort(
    (a, b) =>
      (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99) ||
      a.account_name.localeCompare(b.account_name)
  );

  return result;
}

/**
 * Summarises the detailed BVA result into high-level totals and top variances.
 *
 * net_profit_variance = total_revenue_variance − total_expense_variance
 * (positive = actual profit exceeded budget; negative = shortfall)
 *
 * Top-3 lists are sorted by absolute variance_amount descending.
 *
 * @param detailed - Output from compareBudgetVsActual()
 * @returns BVASummary with totals and top-3 lists
 */
export function summarizeBVA(detailed: BudgetVsActualItem[]): BVASummary {
  let revenueVariance = new BigNumber(0);
  let expenseVariance = new BigNumber(0);

  for (const item of detailed) {
    const variance = new BigNumber(item.variance_amount);
    if (item.category === "revenue") {
      revenueVariance = revenueVariance.plus(variance);
    } else if (item.category === "expense") {
      expenseVariance = expenseVariance.plus(variance);
    }
  }

  // Net profit variance: more revenue is good (positive), more expense is bad (negative).
  // Net profit = revenue − expenses, so:
  //   net_profit_variance = revenue_variance − expense_variance
  const netProfitVariance = revenueVariance
    .minus(expenseVariance)
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);

  // Sort by absolute variance descending for top-3 lists
  const byAbsVariance = [...detailed].sort((a, b) => {
    const absA = new BigNumber(a.variance_amount).abs();
    const absB = new BigNumber(b.variance_amount).abs();
    return absB.minus(absA).toNumber();
  });

  const top_3_favorable_variances   = byAbsVariance.filter((i) => i.favorable).slice(0, 3);
  const top_3_unfavorable_variances = byAbsVariance.filter((i) => !i.favorable).slice(0, 3);

  return {
    total_revenue_variance: revenueVariance.decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2),
    total_expense_variance: expenseVariance.decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2),
    net_profit_variance:    netProfitVariance.toFixed(2),
    top_3_favorable_variances,
    top_3_unfavorable_variances,
  };
}
