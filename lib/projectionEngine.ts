/**
 * lib/projectionEngine.ts
 *
 * Pure TypeScript financial projection engine for FinAgent-SG Phase 3.
 *
 * What this module does:
 * Takes a base-year set of classified accounts and user-confirmed assumptions,
 * then computes projected financial statements for 1–5 years forward.
 *
 * No AI is used here — this is purely deterministic arithmetic using bignumber.js.
 * AI is used upstream (assumption suggestion in Prompt 5) and the results of that
 * are passed in as the `assumptions` parameter.
 *
 * Growth logic applied per account category:
 * - Revenue accounts:             revenue_growth_pct (or custom_line_assumptions override)
 * - COGS expense accounts:        cogs_growth_pct (or custom override)
 * - OPEX expense accounts:        opex_growth_pct (or custom override)
 * - Depreciation expense:         recomputed each year from NCA balance
 * - Accumulated depreciation:     reduced by annual depreciation charge
 * - Non-current asset costs:      unchanged (no new capex assumed)
 * - Current assets (excl. cash):  revenue_growth_pct as a working capital proxy
 * - Current liabilities:          opex_growth_pct as a working capital proxy
 * - Non-current liabilities:      unchanged (no new borrowings assumed)
 * - Share capital / other equity: unchanged
 * - Retained earnings:            prior year RE + net profit after tax
 * - Cash:                         computed as BS plug (Total L+E − Total non-cash assets)
 *
 * COGS detection heuristic (no subcategory field in ClassifiedAccount):
 * An expense account is treated as COGS if its account_name contains "cost of",
 * "cogs", or "subcontract" (case-insensitive), or if account_code starts with "62".
 * All other expense accounts (except depreciation and income tax) are treated as OPEX.
 *
 * Depreciation:
 * Default useful life: 5 years (20% rate). This default is used when no per-asset
 * useful life is available. Both straight-line and reducing_balance methods are
 * supported via computeDepreciation() from calculationEngine.ts.
 *
 * Balance sheet balancing:
 * After all account projections, cash is set as the plug to satisfy
 * Assets = Liabilities + Equity. Negative cash (projected overdraft) is allowed
 * and flagged by validateProjection().
 *
 * Each projected year uses the PREVIOUS projected year as its base, not the
 * original base year.
 *
 * Called by: Phase 3 API routes (Prompt 8).
 */

import BigNumber from "bignumber.js";
import {
  type ClassifiedAccount,
  type ProjectionAssumptions,
  type ProjectedFS,
} from "./schemas";
import {
  applyGrowthRate,
  computeDepreciation,
  calculateRetainedEarnings,
} from "./calculationEngine";

// ── Constants ─────────────────────────────────────────────────────────────────

// Default useful life for non-current assets (years) when no per-asset life is known.
const DEFAULT_USEFUL_LIFE = 5;

// ── Internal types ────────────────────────────────────────────────────────────

// Working representation of an account during projection.
// balance is always the NET amount in the normal direction for the category:
//   - current_asset / non_current_asset / expense: positive = debit-side balance
//     (accumulated depreciation contra-assets have a NEGATIVE balance here)
//   - current_liability / non_current_liability / equity / revenue: positive = credit-side balance
type ProjectionAccount = {
  account_code: string;
  account_name: string;
  sfrs_category: string;
  balance: BigNumber;
};

// ── Public types ──────────────────────────────────────────────────────────────

export type ProjectFinancialsParams = {
  classifiedAccounts: ClassifiedAccount[];
  assumptions: ProjectionAssumptions;
  projectionYears: number;   // 1–5
  baseYear: number;          // Calendar year of the base FS (e.g. 2025)
};

export type ProjectionValidation = {
  valid: boolean;
  errors: string[];
};

// ── Account classification helpers ───────────────────────────────────────────

/** Extracts the net balance from a ClassifiedAccount in the normal direction. */
function getNetBalance(ca: ClassifiedAccount): BigNumber {
  const debit = new BigNumber(ca.debit);
  const credit = new BigNumber(ca.credit);
  const debitNormal =
    ca.sfrs_category === "current_asset" ||
    ca.sfrs_category === "non_current_asset" ||
    ca.sfrs_category === "expense";
  return (debitNormal ? debit.minus(credit) : credit.minus(debit))
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/** Converts ClassifiedAccount[] to ProjectionAccount[]. */
function toProjectionAccounts(accounts: ClassifiedAccount[]): ProjectionAccount[] {
  return accounts.map((ca) => ({
    account_code: ca.account_code,
    account_name: ca.account_name,
    sfrs_category: ca.sfrs_category,
    balance: getNetBalance(ca),
  }));
}

/** Deep-clones ProjectionAccount[] so each year's projection is independent. */
function cloneAccounts(accounts: ProjectionAccount[]): ProjectionAccount[] {
  return accounts.map((a) => ({ ...a, balance: new BigNumber(a.balance) }));
}

/** True if this expense account is a COGS account. */
function isCogs(a: ProjectionAccount): boolean {
  const name = a.account_name.toLowerCase();
  return (
    name.includes("cost of") ||
    name.includes("cogs") ||
    name.includes("subcontract") ||
    a.account_code.startsWith("62")
  );
}

/** True if this expense account records depreciation charges. */
function isDepreciationExpense(a: ProjectionAccount): boolean {
  return (
    a.sfrs_category === "expense" &&
    a.account_name.toLowerCase().includes("depreciation")
  );
}

/** True if this non-current asset account is an accumulated depreciation contra-asset.
 *  These have a negative net balance (credit-side of a debit-normal category). */
function isAccumulatedDep(a: ProjectionAccount): boolean {
  return a.sfrs_category === "non_current_asset" && a.balance.isLessThan(0);
}

/** True if this current asset account represents cash or a bank balance. */
function isCashAccount(a: ProjectionAccount): boolean {
  if (a.sfrs_category !== "current_asset") return false;
  const name = a.account_name.toLowerCase();
  return name.includes("cash") || name.includes("bank");
}

/** True if this equity account is retained earnings. */
function isRetainedEarnings(a: ProjectionAccount): boolean {
  const name = a.account_name.toLowerCase();
  return (
    a.sfrs_category === "equity" &&
    (name.includes("retained") || name.includes("accumulated profit"))
  );
}

/** True if this expense account is income tax. */
function isIncomeTax(a: ProjectionAccount): boolean {
  const name = a.account_name.toLowerCase();
  return (
    a.sfrs_category === "expense" &&
    (name.includes("income tax") || name.includes("tax expense"))
  );
}

// ── Arithmetic helpers ────────────────────────────────────────────────────────

/** Sums the balances of a set of ProjectionAccounts. */
function sumBalances(accounts: ProjectionAccount[]): BigNumber {
  return accounts
    .reduce((sum, a) => sum.plus(a.balance), new BigNumber(0))
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
}

/** Maps ProjectionAccounts to the { label, amount } line-item format used by FSOutput. */
function toLineItems(accounts: ProjectionAccount[]): { label: string; amount: number }[] {
  return accounts.map((a) => ({
    label: a.account_name,
    amount: a.balance.toNumber(),
  }));
}

// ── FSOutput builder ──────────────────────────────────────────────────────────

function buildProjectedFS(
  accounts: ProjectionAccount[],
  year: number,
  baseYear: number,
  projectionYears: number,
  netProfit: BigNumber,
  openingRE: BigNumber,
  closingRE: BigNumber,
  annualDepCharge: BigNumber,
  openingCash: BigNumber,
  assumptions: ProjectionAssumptions
): ProjectedFS {
  const projYear = baseYear + year;

  const currentAssets      = accounts.filter((a) => a.sfrs_category === "current_asset");
  const nonCurrentAssets   = accounts.filter((a) => a.sfrs_category === "non_current_asset");
  const currentLiabs       = accounts.filter((a) => a.sfrs_category === "current_liability");
  const nonCurrentLiabs    = accounts.filter((a) => a.sfrs_category === "non_current_liability");
  const equityAccounts     = accounts.filter((a) => a.sfrs_category === "equity");
  const revenueAccounts    = accounts.filter((a) => a.sfrs_category === "revenue");
  const expenseAccounts    = accounts.filter((a) => a.sfrs_category === "expense");

  const totalCurrentAssets       = sumBalances(currentAssets);
  const totalNonCurrentAssets    = sumBalances(nonCurrentAssets);
  const totalAssets              = totalCurrentAssets.plus(totalNonCurrentAssets).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
  const totalCurrentLiabs        = sumBalances(currentLiabs);
  const totalNonCurrentLiabs     = sumBalances(nonCurrentLiabs);
  const totalLiabilities         = totalCurrentLiabs.plus(totalNonCurrentLiabs).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
  const totalEquity              = sumBalances(equityAccounts);
  const totalLiabsAndEquity      = totalLiabilities.plus(totalEquity).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
  const totalRevenue             = sumBalances(revenueAccounts);
  const totalExpenses            = sumBalances(expenseAccounts);
  const closingCash              = sumBalances(accounts.filter(isCashAccount));

  const nonShareEquity = equityAccounts.filter((a) => !isRetainedEarnings(a));
  const shareCapitalBalance = sumBalances(nonShareEquity);

  // ── Balance Sheet ──────────────────────────────────────────────────────
  const balance_sheet = {
    title: `Year ${year} Projection (FY${projYear}) — Statement of Financial Position`,
    as_at_date: `${projYear}-12-31`,
    current_assets:             toLineItems(currentAssets),
    total_current_assets:       totalCurrentAssets.toNumber(),
    non_current_assets:         toLineItems(nonCurrentAssets),
    total_non_current_assets:   totalNonCurrentAssets.toNumber(),
    total_assets:               totalAssets.toNumber(),
    current_liabilities:        toLineItems(currentLiabs),
    total_current_liabilities:  totalCurrentLiabs.toNumber(),
    non_current_liabilities:    toLineItems(nonCurrentLiabs),
    total_non_current_liabilities: totalNonCurrentLiabs.toNumber(),
    total_liabilities:          totalLiabilities.toNumber(),
    equity:                     toLineItems(equityAccounts),
    total_equity:               totalEquity.toNumber(),
    total_liabilities_and_equity: totalLiabsAndEquity.toNumber(),
    is_balanced: totalAssets.minus(totalLiabsAndEquity).abs().isLessThanOrEqualTo(new BigNumber("0.01")),
  };

  // ── Profit & Loss ─────────────────────────────────────────────────────
  const profit_and_loss = {
    title: `Year ${year} Projection (FY${projYear}) — Profit & Loss Statement`,
    period_start: `${projYear}-01-01`,
    period_end:   `${projYear}-12-31`,
    revenue_lines:   toLineItems(revenueAccounts),
    total_revenue:   totalRevenue.toNumber(),
    expense_lines:   toLineItems(expenseAccounts),
    total_expenses:  totalExpenses.toNumber(),
    net_profit:      netProfit.toNumber(),
  };

  // ── Cash Flow (simplified indirect method) ────────────────────────────
  // Net change in cash is authoritative from the BS plug.
  // Operating activities = net profit + depreciation (simplified; WC changes excluded).
  const netCashFromOperations = netProfit.plus(annualDepCharge).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
  const netChangeinCash = closingCash.minus(openingCash).decimalPlaces(2, BigNumber.ROUND_HALF_UP);

  const cash_flow = {
    title: `Year ${year} Projection (FY${projYear}) — Cash Flow Statement (Indirect Method)`,
    period_start: `${projYear}-01-01`,
    period_end:   `${projYear}-12-31`,
    operating_activities: {
      net_profit: netProfit.toNumber(),
      adjustments: [
        { label: "Depreciation and amortisation", amount: annualDepCharge.toNumber() },
      ],
      working_capital_changes: [],
      net_cash_from_operations: netCashFromOperations.toNumber(),
    },
    investing_activities: {
      items: [],
      net_cash_from_investing: 0,
    },
    financing_activities: {
      items: [],
      net_cash_from_financing: 0,
    },
    net_change_in_cash: netChangeinCash.toNumber(),
    opening_cash:       openingCash.toNumber(),
    closing_cash:       closingCash.toNumber(),
  };

  // ── Equity Statement ──────────────────────────────────────────────────
  const equity_statement = {
    title: `Year ${year} Projection (FY${projYear}) — Statement of Changes in Equity`,
    period_start: `${projYear}-01-01`,
    period_end:   `${projYear}-12-31`,
    retained_earnings: {
      opening:    openingRE.toNumber(),
      net_profit: netProfit.toNumber(),
      dividends:  0,
      closing:    closingRE.toNumber(),
    },
    share_capital: {
      opening: shareCapitalBalance.toNumber(),
      issued:  0,
      closing: shareCapitalBalance.toNumber(),
    },
    total_equity_opening: openingRE.plus(shareCapitalBalance).decimalPlaces(2, BigNumber.ROUND_HALF_UP).toNumber(),
    total_equity_closing: totalEquity.toNumber(),
  };

  // ── Notes ─────────────────────────────────────────────────────────────
  const notes = [
    {
      title: `Year ${year} Projection — Basis of Preparation`,
      content:
        `This is a projected financial statement for FY${projYear} ` +
        `(Year ${year} of ${projectionYears}-year projection). ` +
        `Assumptions applied: revenue growth ${assumptions.revenue_growth_pct}%, ` +
        `COGS growth ${assumptions.cogs_growth_pct}%, ` +
        `OPEX growth ${assumptions.opex_growth_pct}%, ` +
        `tax rate ${assumptions.tax_rate_pct}%, ` +
        `depreciation method: ${assumptions.depreciation_method.replace("_", " ")} ` +
        `(default useful life ${DEFAULT_USEFUL_LIFE} years). ` +
        `Non-current asset purchases, new borrowings, and dividends are assumed to be nil. ` +
        `Cash is computed as the balancing item. ` +
        `These are projections only and have not been audited.`,
    },
  ];

  return {
    balance_sheet,
    profit_and_loss,
    cash_flow,
    equity_statement,
    notes,
    xbrl_tags: {},
    year,
  } as ProjectedFS;
}

// ── Main projection function ──────────────────────────────────────────────────

/**
 * Projects financial statements for 1–5 years forward from the base year.
 *
 * Each year builds on the previous projected year (not the original base year).
 * Returns an array of ProjectedFS — one entry per projection year.
 *
 * @param params.classifiedAccounts - Base year trial balance (from Phase 2 classifier)
 * @param params.assumptions        - Growth rates, depreciation method, tax rate
 * @param params.projectionYears    - How many years to project (1–5)
 * @param params.baseYear           - Calendar year of the base FS (e.g. 2025)
 */
export function projectFinancials(params: ProjectFinancialsParams): ProjectedFS[] {
  const { classifiedAccounts, assumptions, projectionYears, baseYear } = params;

  if (projectionYears < 1 || projectionYears > 5) {
    throw new Error(`projectionYears must be between 1 and 5, got ${projectionYears}`);
  }

  // Build override map: account_code → growth_pct
  const overrides = new Map(
    assumptions.custom_line_assumptions.map((o) => [o.account_code, o.growth_pct])
  );

  // Convert base year classified accounts to mutable projection accounts
  let accounts = toProjectionAccounts(classifiedAccounts);

  // Opening retained earnings (base year)
  let openingRE = sumBalances(accounts.filter(isRetainedEarnings));

  // Opening cash (base year) — used as the opening balance in Year 1 CF
  let openingCash = sumBalances(accounts.filter(isCashAccount));

  // For straight-line depreciation: compute a fixed annual charge from base-year NCA NBV.
  // NCA net = cost accounts (positive) + accumulated dep (negative) = net book value.
  const baseNbv = sumBalances(accounts.filter((a) => a.sfrs_category === "non_current_asset"));
  const straightLineAnnualCharge = new BigNumber(
    computeDepreciation(baseNbv.toFixed(2), "straight_line", DEFAULT_USEFUL_LIFE, 1)
  );

  const results: ProjectedFS[] = [];

  for (let year = 1; year <= projectionYears; year++) {
    const yearAccounts = cloneAccounts(accounts);

    // ── Grow revenue accounts ────────────────────────────────────────────
    for (const a of yearAccounts) {
      if (a.sfrs_category !== "revenue") continue;
      const rate = overrides.get(a.account_code) ?? assumptions.revenue_growth_pct;
      a.balance = new BigNumber(applyGrowthRate(a.balance.toFixed(2), rate));
    }

    // ── Grow expense accounts (COGS and OPEX; skip dep and tax — handled separately) ──
    for (const a of yearAccounts) {
      if (a.sfrs_category !== "expense") continue;
      if (isDepreciationExpense(a) || isIncomeTax(a)) continue;
      const override = overrides.get(a.account_code);
      const rate =
        override !== undefined
          ? override
          : isCogs(a)
          ? assumptions.cogs_growth_pct
          : assumptions.opex_growth_pct;
      a.balance = new BigNumber(applyGrowthRate(a.balance.toFixed(2), rate));
    }

    // ── Depreciation ─────────────────────────────────────────────────────
    // Compute this year's annual depreciation charge.
    let annualDepCharge: BigNumber;
    if (assumptions.depreciation_method === "straight_line") {
      // Fixed amount every year — computed once from base-year NBV
      annualDepCharge = straightLineAnnualCharge;
    } else {
      // Reducing balance — use CURRENT year's NCA NBV as the base
      const currentNbv = sumBalances(yearAccounts.filter((a) => a.sfrs_category === "non_current_asset"));
      annualDepCharge = new BigNumber(
        computeDepreciation(currentNbv.toFixed(2), "reducing_balance", DEFAULT_USEFUL_LIFE, 1)
      );
    }
    annualDepCharge = annualDepCharge.abs().decimalPlaces(2, BigNumber.ROUND_HALF_UP);

    // Apply charge to accumulated depreciation accounts (make them more negative)
    const accDepAccounts = yearAccounts.filter(isAccumulatedDep);
    if (accDepAccounts.length > 0) {
      const totalAbsAccDep = accDepAccounts.reduce(
        (s, a) => s.plus(a.balance.abs()), new BigNumber(0)
      );
      for (const a of accDepAccounts) {
        const proportion = totalAbsAccDep.isZero()
          ? new BigNumber(1).dividedBy(accDepAccounts.length)
          : a.balance.abs().dividedBy(totalAbsAccDep);
        a.balance = a.balance
          .minus(annualDepCharge.multipliedBy(proportion))
          .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
      }
    }

    // Apply charge to depreciation expense accounts (increase each proportionally)
    const depExpAccounts = yearAccounts.filter(isDepreciationExpense);
    if (depExpAccounts.length > 0) {
      const totalPrevDep = sumBalances(depExpAccounts);
      for (const a of depExpAccounts) {
        const proportion = totalPrevDep.isZero()
          ? new BigNumber(1).dividedBy(depExpAccounts.length)
          : a.balance.dividedBy(totalPrevDep);
        a.balance = annualDepCharge
          .multipliedBy(proportion)
          .decimalPlaces(2, BigNumber.ROUND_HALF_UP);
      }
    } else {
      // No existing depreciation expense accounts — create one
      yearAccounts.push({
        account_code: "6300",
        account_name: "Depreciation Expense",
        sfrs_category: "expense",
        balance: annualDepCharge,
      });
    }

    // ── Grow current assets (excluding cash — cash is the BS plug) ────────
    for (const a of yearAccounts) {
      if (a.sfrs_category !== "current_asset" || isCashAccount(a)) continue;
      const rate = overrides.get(a.account_code) ?? assumptions.revenue_growth_pct;
      a.balance = new BigNumber(applyGrowthRate(a.balance.toFixed(2), rate));
    }

    // ── Grow current liabilities ──────────────────────────────────────────
    for (const a of yearAccounts) {
      if (a.sfrs_category !== "current_liability") continue;
      const rate = overrides.get(a.account_code) ?? assumptions.opex_growth_pct;
      a.balance = new BigNumber(applyGrowthRate(a.balance.toFixed(2), rate));
    }

    // Non-current liabilities: unchanged (no new borrowings assumed)
    // Non-current asset cost accounts: unchanged (no new capex assumed)
    // Equity (share capital etc.): unchanged — retained earnings handled below

    // ── Compute profit before tax ─────────────────────────────────────────
    const totalRevenue = sumBalances(yearAccounts.filter((a) => a.sfrs_category === "revenue"));
    const expensesBefTax = sumBalances(
      yearAccounts.filter((a) => a.sfrs_category === "expense" && !isIncomeTax(a))
    );
    const profitBeforeTax = totalRevenue.minus(expensesBefTax).decimalPlaces(2, BigNumber.ROUND_HALF_UP);

    // ── Compute income tax (only on positive profit) ──────────────────────
    const taxAmount = profitBeforeTax.isGreaterThan(0)
      ? profitBeforeTax
          .multipliedBy(assumptions.tax_rate_pct)
          .dividedBy(100)
          .decimalPlaces(2, BigNumber.ROUND_HALF_UP)
      : new BigNumber(0);

    const taxAccount = yearAccounts.find(isIncomeTax);
    if (taxAccount) {
      taxAccount.balance = taxAmount;
    } else if (taxAmount.isGreaterThan(0)) {
      yearAccounts.push({
        account_code: "6610",
        account_name: "Income Tax Expense",
        sfrs_category: "expense",
        balance: taxAmount,
      });
    }

    // ── Net profit after tax ──────────────────────────────────────────────
    const netProfit = profitBeforeTax.minus(taxAmount).decimalPlaces(2, BigNumber.ROUND_HALF_UP);

    // ── Update retained earnings ──────────────────────────────────────────
    // No dividends assumed in projections.
    const closingRE = calculateRetainedEarnings(openingRE, netProfit, new BigNumber(0));
    const reAccount = yearAccounts.find(isRetainedEarnings);
    if (reAccount) {
      reAccount.balance = closingRE;
    } else {
      yearAccounts.push({
        account_code: "3200",
        account_name: "Retained Earnings",
        sfrs_category: "equity",
        balance: closingRE,
      });
    }

    // ── Balance BS: set cash as the plug ─────────────────────────────────
    // Required cash = Total Liabilities + Total Equity − Total Non-Cash Assets
    const liabilityAccounts = yearAccounts.filter(
      (a) => a.sfrs_category === "current_liability" || a.sfrs_category === "non_current_liability"
    );
    const equityAccounts = yearAccounts.filter((a) => a.sfrs_category === "equity");
    const nonCashCurrentAssets = yearAccounts.filter(
      (a) => a.sfrs_category === "current_asset" && !isCashAccount(a)
    );
    const ncaAccounts = yearAccounts.filter((a) => a.sfrs_category === "non_current_asset");

    const totalLiabs  = sumBalances(liabilityAccounts);
    const totalEquity = sumBalances(equityAccounts);
    const totalNonCashAssets = sumBalances([...nonCashCurrentAssets, ...ncaAccounts]);
    const requiredCash = totalLiabs.plus(totalEquity).minus(totalNonCashAssets).decimalPlaces(2, BigNumber.ROUND_HALF_UP);

    // Distribute required cash across all cash/bank accounts proportionally.
    const cashAccounts = yearAccounts.filter(isCashAccount);
    if (cashAccounts.length > 0) {
      const prevTotalCash = sumBalances(cashAccounts);
      if (prevTotalCash.isZero()) {
        // No prior cash distribution to base proportions on — put it all in the first account
        cashAccounts[0].balance = requiredCash.decimalPlaces(2, BigNumber.ROUND_HALF_UP);
        for (let i = 1; i < cashAccounts.length; i++) {
          cashAccounts[i].balance = new BigNumber(0);
        }
      } else {
        for (const a of cashAccounts) {
          const proportion = a.balance.dividedBy(prevTotalCash);
          a.balance = requiredCash.multipliedBy(proportion).decimalPlaces(2, BigNumber.ROUND_HALF_UP);
        }
      }
    } else {
      // No cash accounts in base year — create one
      yearAccounts.push({
        account_code: "1010",
        account_name: "Cash and Cash Equivalents",
        sfrs_category: "current_asset",
        balance: requiredCash.decimalPlaces(2, BigNumber.ROUND_HALF_UP),
      });
    }

    // ── Build ProjectedFS ─────────────────────────────────────────────────
    const projectedFS = buildProjectedFS(
      yearAccounts,
      year,
      baseYear,
      projectionYears,
      netProfit,
      openingRE,
      closingRE,
      annualDepCharge,
      openingCash,
      assumptions
    );
    results.push(projectedFS);

    // ── Advance to next year ──────────────────────────────────────────────
    accounts    = yearAccounts;
    openingRE   = closingRE;
    openingCash = sumBalances(yearAccounts.filter(isCashAccount));
  }

  return results;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates that the balance sheet balances for every projected year.
 * Also flags negative cash positions (projected overdraft / insolvency).
 *
 * @param projected - Array of ProjectedFS from projectFinancials()
 * @returns { valid: boolean, errors: string[] }
 */
export function validateProjection(projected: ProjectedFS[]): ProjectionValidation {
  const errors: string[] = [];

  for (const pfs of projected) {
    const year = pfs.year;
    const bs = pfs.balance_sheet as Record<string, unknown>;

    // Check BS equation
    const totalAssets = Number(bs.total_assets ?? 0);
    const totalLandE  = Number(bs.total_liabilities_and_equity ?? 0);
    const diff        = Math.abs(totalAssets - totalLandE);
    if (diff > 0.01) {
      errors.push(
        `Year ${year}: Balance sheet out of balance — ` +
        `Assets: ${totalAssets.toFixed(2)}, L+E: ${totalLandE.toFixed(2)}, ` +
        `difference: ${diff.toFixed(2)}`
      );
    }

    // Flag negative cash (projected overdraft)
    const currentAssets = (bs.current_assets as { label: string; amount: number }[] | null) ?? [];
    const totalCash = currentAssets
      .filter((item) => {
        const label = (item?.label ?? "").toLowerCase();
        return label.includes("cash") || label.includes("bank");
      })
      .reduce((s, item) => s + (item?.amount ?? 0), 0);

    if (totalCash < -0.01) {
      errors.push(
        `Year ${year}: Negative cash balance (${totalCash.toFixed(2)}) — ` +
        `projected cash requirements exceed available funding. ` +
        `Consider revising growth assumptions or adding a financing assumption.`
      );
    }

    // Flag net loss (informational — not a hard error)
    const pl = pfs.profit_and_loss as Record<string, unknown>;
    const netProfit = Number(pl.net_profit ?? 0);
    if (netProfit < 0) {
      errors.push(
        `Year ${year}: Projected net loss of ${Math.abs(netProfit).toFixed(2)} — ` +
        `review revenue and expense growth assumptions.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
