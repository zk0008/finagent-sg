/**
 * lib/calculationEngine.ts
 *
 * Precise financial calculation engine for FinAgent-SG.
 *
 * What this module does:
 * Provides all arithmetic functions used by the FS generator (Task 5).
 * Every function uses bignumber.js — never native JS math operators (+, -, *, /).
 *
 * Why bignumber.js instead of native JS math:
 * JavaScript uses IEEE 754 double-precision floating-point, which cannot represent
 * many decimal fractions exactly. For example:
 *   0.1 + 0.2 === 0.30000000000000004  (not 0.30)
 *   1234567.89 * 1.07 === 1321027.6422999999  (not 1,321,027.64)
 * These tiny errors compound across hundreds of trial balance lines, producing
 * balance sheet totals that are off by cents — unacceptable for financial statements.
 * bignumber.js uses arbitrary-precision decimal arithmetic and is exact.
 *
 * All return values are rounded to 2 decimal places (standard SGD precision).
 * No AI is involved — pure arithmetic only.
 *
 * Called by: lib/fsGenerator.ts (Task 5) for all numerical computations.
 *            lib/projectionEngine.ts (Phase 3) for growth and depreciation calculations.
 */

import BigNumber from "bignumber.js";
import { type ClassifiedAccount } from "./schemas";

// Configure BigNumber globally for financial use:
// ROUND_HALF_UP matches standard accounting rounding (5 rounds up).
BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

// Tolerance for balance sheet validation — $0.01 (one cent)
const BALANCE_SHEET_TOLERANCE = new BigNumber("0.01");

/**
 * Sums the net balances of all accounts in a given SFRS category.
 *
 * For asset, expense accounts: the balance is debit - credit (debit-normal).
 * For liability, equity, revenue accounts: the balance is credit - debit (credit-normal).
 *
 * The net balance logic ensures the sum represents the correct signed amount
 * regardless of which side the balance sits on in the trial balance.
 *
 * @param accounts - Full array of classified accounts
 * @param category - The SFRS category to filter and sum
 * @returns BigNumber total rounded to 2 decimal places
 */
export function sumAccounts(
  accounts: ClassifiedAccount[],
  category: string
): BigNumber {
  // Filter to only accounts in the requested category
  const filtered = accounts.filter((a) => a.sfrs_category === category);

  // Determine the normal balance side for this category:
  // Debit-normal: assets and expenses (debit increases the balance)
  // Credit-normal: liabilities, equity, and revenue (credit increases the balance)
  const debitNormal = category === "current_asset" ||
    category === "non_current_asset" ||
    category === "expense";

  // Sum net balances using BigNumber addition — never native +
  let total = new BigNumber(0);
  for (const account of filtered) {
    const debit = new BigNumber(account.debit);
    const credit = new BigNumber(account.credit);
    // Net balance = debit - credit for debit-normal accounts
    //             = credit - debit for credit-normal accounts
    const net = debitNormal ? debit.minus(credit) : credit.minus(debit);
    total = total.plus(net);
  }

  // Return rounded to 2 decimal places (SGD standard)
  return total.decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/**
 * Calculates net profit / (loss) for the period.
 *
 * Net Profit = Total Revenue - Total Expenses
 * A positive result is a profit; negative is a loss.
 *
 * @param revenue - Total revenue (BigNumber, from sumAccounts with "revenue")
 * @param expenses - Total expenses (BigNumber, from sumAccounts with "expense")
 * @returns BigNumber net profit/(loss) rounded to 2 decimal places
 */
export function calculateNetProfit(revenue: BigNumber, expenses: BigNumber): BigNumber {
  // Use BigNumber .minus() — never native subtraction
  return revenue.minus(expenses).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/**
 * Calculates closing retained earnings.
 *
 * Retained Earnings (closing) = Opening Retained Earnings + Net Profit - Dividends Declared
 *
 * Dividends reduce retained earnings because they distribute profits to shareholders.
 *
 * @param opening - Opening retained earnings balance (BigNumber)
 * @param netProfit - Net profit/(loss) for the period (BigNumber, may be negative)
 * @param dividends - Dividends declared during the period (BigNumber, non-negative)
 * @returns BigNumber closing retained earnings rounded to 2 decimal places
 */
export function calculateRetainedEarnings(
  opening: BigNumber,
  netProfit: BigNumber,
  dividends: BigNumber
): BigNumber {
  // Opening + Net Profit - Dividends, all via BigNumber methods
  return opening
    .plus(netProfit)
    .minus(dividends)
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/**
 * Validates the balance sheet equation: Total Assets = Total Liabilities + Total Equity.
 *
 * This is a fundamental accounting identity. If it does not hold (within $0.01 rounding
 * tolerance), the financial statements cannot be filed.
 *
 * @param totalAssets - Sum of current and non-current assets (BigNumber)
 * @param totalLiabilitiesAndEquity - Sum of all liabilities and equity (BigNumber)
 * @returns true if the balance sheet balances (within $0.01 tolerance), false otherwise
 */
export function validateBalanceSheet(
  totalAssets: BigNumber,
  totalLiabilitiesAndEquity: BigNumber
): boolean {
  // Use .minus() and .abs() via BigNumber — never native math
  const difference = totalAssets.minus(totalLiabilitiesAndEquity).abs();
  // The balance sheet is valid if the difference is within the $0.01 tolerance
  return difference.isLessThanOrEqualTo(BALANCE_SHEET_TOLERANCE);
}

/**
 * Applies a percentage growth rate to a monetary amount.
 *
 * Result = amount × (1 + growthPct / 100)
 *
 * Used by the projection engine to grow account balances year-over-year.
 * Inputs and outputs are strings to preserve BigNumber precision across call chains.
 *
 * Examples:
 *   applyGrowthRate("100000.00", 10)   → "110000.00"  (+10%)
 *   applyGrowthRate("100000.00", -5)   → "95000.00"   (-5%)
 *   applyGrowthRate("100000.00", 0)    → "100000.00"  (no change)
 *
 * @param amount    - The monetary amount as a string (e.g. "50000.00")
 * @param growthPct - Annual growth rate as a percentage (e.g. 10 = 10%)
 * @returns Grown amount as a string, rounded to 2 decimal places
 */
export function applyGrowthRate(amount: string, growthPct: number): string {
  const factor = new BigNumber(1).plus(new BigNumber(growthPct).dividedBy(100));
  return new BigNumber(amount)
    .multipliedBy(factor)
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP)
    .toFixed(2);
}

/**
 * Computes the annual depreciation charge for a single asset.
 *
 * Two methods:
 *
 * straight_line:
 *   Annual charge = cost / usefulLife  (same every year)
 *   Example: cost=55000, life=5 → 11000/year
 *
 * reducing_balance:
 *   Annual charge for year N = cost × rate × (1 − rate)^(N−1)
 *   where rate = 1 / usefulLife
 *   Example: cost=55000, life=5, year=1 → 55000 × 0.20 = 11000
 *            cost=55000, life=5, year=2 → 55000 × 0.20 × 0.80 = 8800
 *
 * Note: In the projection engine, reducing_balance is called with year=1 and
 * the CURRENT net book value as "cost", so it correctly computes the current
 * year's charge on the remaining balance.
 *
 * @param cost       - Asset cost or net book value as a string
 * @param method     - "straight_line" or "reducing_balance"
 * @param usefulLife - Useful life in years (e.g. 5)
 * @param year       - Which year of the asset's life (1 = first year)
 * @returns Annual depreciation charge as a string, rounded to 2 decimal places
 */
export function computeDepreciation(
  cost: string,
  method: string,
  usefulLife: number,
  year: number
): string {
  const costBN = new BigNumber(cost).abs(); // cost is always positive
  if (method === "reducing_balance") {
    // Rate = 1 / usefulLife; charge for year N = cost × rate × (1-rate)^(N-1)
    const rate = new BigNumber(1).dividedBy(usefulLife);
    const charge = costBN
      .multipliedBy(rate)
      .multipliedBy(new BigNumber(1).minus(rate).exponentiatedBy(year - 1));
    return charge.decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2);
  }
  // Straight-line: constant annual charge regardless of year
  return costBN.dividedBy(usefulLife).decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2);
}

/**
 * Formats a BigNumber as a SGD string with thousand separators and 2 decimal places.
 * Used by the FS generator and PDF generator to format output figures.
 *
 * Example: new BigNumber(1234567.89) → "1,234,567.89"
 *
 * @param value - BigNumber to format
 * @returns Formatted string (e.g. "1,234,567.89")
 */
export function formatSGD(value: BigNumber): string {
  // toFormat() uses bignumber.js's built-in locale formatting
  return value.toFormat(2);
}
