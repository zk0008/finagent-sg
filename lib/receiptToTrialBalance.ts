/**
 * lib/receiptToTrialBalance.ts
 *
 * Converts confirmed receipt line items (income and expense) into a
 * TrialBalanceLine array compatible with the existing FS generation pipeline.
 *
 * Part of Improvement B — Receipt Segregation (Prompt B3).
 *
 * Mapping logic:
 * - Income items → credit entries to revenue accounts (account codes 4xxx)
 * - Expense items → debit entries to expense accounts (account codes 6xxx)
 * - A single "Cash / Bank" entry (account 1010) is added to balance the TB:
 *     net_cash = total_income − total_expenses
 *     If net_cash > 0: Cash debit = net_cash, credit = 0
 *     If net_cash < 0: Cash debit = 0, credit = abs(net_cash)
 *     If net_cash = 0: Cash entry omitted
 *
 * Account classification uses case-insensitive keyword matching on the item's
 * description field. Items whose description matches no keyword fall back to:
 *   income  → 4999 Other Income
 *   expense → 6999 Other Expenses
 *
 * Items with the same account code are aggregated into a single TB line.
 *
 * All arithmetic uses bignumber.js — no native JS math.
 *
 * Called by: app/receipts/page.tsx (Confirm & Generate Trial Balance button)
 *            app/api/receipts/export-excel/route.ts (Excel export)
 */

import BigNumber from "bignumber.js";
import type { TrialBalanceLine } from "./schemas";

// ── Minimal input type ────────────────────────────────────────────────────────
// Only description and amount are needed for classification and aggregation.
// Compatible with both ReceiptLineItem and EditableReceiptItem.

export interface ReceiptEntry {
  description: string;
  amount: string; // bignumber.js string — always 2 decimal places
}

// ── Account maps ──────────────────────────────────────────────────────────────

interface AccountInfo {
  code: string;
  name: string;
}

const INCOME_KEYWORD_MAP: Array<{ keywords: string[]; account: AccountInfo }> =
  [
    {
      keywords: ["sales", "revenue", "invoice", "goods"],
      account: { code: "4000", name: "Sales Revenue" },
    },
    {
      keywords: ["service", "consulting", "advisory", "consultation"],
      account: { code: "4100", name: "Service Revenue" },
    },
    {
      keywords: ["interest"],
      account: { code: "4200", name: "Interest Income" },
    },
    {
      keywords: ["rental", "rent", "lease", "tenancy"],
      account: { code: "4300", name: "Rental Income" },
    },
    {
      keywords: ["dividend"],
      account: { code: "4400", name: "Dividend Income" },
    },
    {
      keywords: ["grant", "subsidy"],
      account: { code: "4500", name: "Grant Income" },
    },
    {
      keywords: ["commission"],
      account: { code: "4600", name: "Commission Income" },
    },
  ];

const EXPENSE_KEYWORD_MAP: Array<{ keywords: string[]; account: AccountInfo }> =
  [
    {
      keywords: ["salary", "salaries", "wages", "payroll", "cpf", "bonus"],
      account: { code: "6000", name: "Salaries and Wages" },
    },
    {
      keywords: ["rent", "rental", "lease"],
      account: { code: "6100", name: "Rent Expense" },
    },
    {
      keywords: ["utilities", "electricity", "water", "gas", "power"],
      account: { code: "6200", name: "Utilities" },
    },
    {
      keywords: [
        "transport",
        "travel",
        "taxi",
        "grab",
        "mrt",
        "bus",
        "parking",
        "fuel",
        "petrol",
        "flight",
        "airline",
      ],
      account: { code: "6300", name: "Transport and Travel" },
    },
    {
      keywords: [
        "food",
        "meal",
        "meals",
        "lunch",
        "dinner",
        "breakfast",
        "restaurant",
        "catering",
        "f&b",
        "cafe",
        "coffee",
        "entertainment",
      ],
      account: { code: "6400", name: "Meals and Entertainment" },
    },
    {
      keywords: [
        "phone",
        "mobile",
        "internet",
        "broadband",
        "telco",
        "telecom",
        "singtel",
        "starhub",
        "m1",
      ],
      account: { code: "6500", name: "Telecommunications" },
    },
    {
      keywords: ["insurance"],
      account: { code: "6600", name: "Insurance" },
    },
    {
      keywords: ["office", "stationery", "printing", "supplies", "paper"],
      account: { code: "6700", name: "Office Supplies" },
    },
    {
      keywords: [
        "professional",
        "legal",
        "accounting",
        "audit",
        "auditor",
        "lawyer",
        "solicitor",
        "consultant",
      ],
      account: { code: "6800", name: "Professional Fees" },
    },
    {
      keywords: [
        "advertising",
        "marketing",
        "promotion",
        "social media",
        "digital",
        "ads",
        "seo",
      ],
      account: { code: "6900", name: "Marketing and Advertising" },
    },
    {
      keywords: ["depreciation", "amortisation", "amortization"],
      account: { code: "6950", name: "Depreciation and Amortisation" },
    },
    {
      keywords: ["maintenance", "repair", "servicing", "cleaning"],
      account: { code: "6960", name: "Maintenance and Repairs" },
    },
  ];

const DEFAULT_INCOME_ACCOUNT:  AccountInfo = { code: "4999", name: "Other Income" };
const DEFAULT_EXPENSE_ACCOUNT: AccountInfo = { code: "6999", name: "Other Expenses" };
const CASH_ACCOUNT:            AccountInfo = { code: "1010", name: "Cash / Bank" };

// ── Keyword classifier ────────────────────────────────────────────────────────

function classifyIncome(description: string): AccountInfo {
  const lower = description.toLowerCase();
  for (const entry of INCOME_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.account;
    }
  }
  return DEFAULT_INCOME_ACCOUNT;
}

function classifyExpense(description: string): AccountInfo {
  const lower = description.toLowerCase();
  for (const entry of EXPENSE_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.account;
    }
  }
  return DEFAULT_EXPENSE_ACCOUNT;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generates a balanced TrialBalanceLine[] from confirmed receipt line items.
 *
 * Income items  → credit entries to 4xxx revenue accounts
 * Expense items → debit entries to 6xxx expense accounts
 * A 1010 Cash/Bank balancing entry ensures total debits = total credits.
 *
 * Items with the same account code are aggregated into one row.
 *
 * @param incomeItems  Confirmed income receipts
 * @param expenseItems Confirmed expense receipts
 * @returns TrialBalanceLine[] — safe to pass directly to the FS generation pipeline
 */
export function generateTrialBalanceFromReceipts(
  incomeItems:  ReceiptEntry[],
  expenseItems: ReceiptEntry[]
): TrialBalanceLine[] {
  // ── Aggregate income items by account code ──────────────────────────────────
  const incomeMap = new Map<string, { account: AccountInfo; total: BigNumber }>();

  for (const item of incomeItems) {
    const bn = new BigNumber(item.amount);
    if (bn.isNaN() || !bn.isFinite() || bn.isLessThan(0)) continue;

    const account = classifyIncome(item.description);
    const existing = incomeMap.get(account.code);
    if (existing) {
      existing.total = existing.total.plus(bn);
    } else {
      incomeMap.set(account.code, { account, total: bn });
    }
  }

  // ── Aggregate expense items by account code ─────────────────────────────────
  const expenseMap = new Map<string, { account: AccountInfo; total: BigNumber }>();

  for (const item of expenseItems) {
    const bn = new BigNumber(item.amount);
    if (bn.isNaN() || !bn.isFinite() || bn.isLessThan(0)) continue;

    const account = classifyExpense(item.description);
    const existing = expenseMap.get(account.code);
    if (existing) {
      existing.total = existing.total.plus(bn);
    } else {
      expenseMap.set(account.code, { account, total: bn });
    }
  }

  // ── Compute totals ──────────────────────────────────────────────────────────
  let totalIncome   = new BigNumber(0);
  let totalExpenses = new BigNumber(0);

  for (const { total } of incomeMap.values())  totalIncome   = totalIncome.plus(total);
  for (const { total } of expenseMap.values()) totalExpenses = totalExpenses.plus(total);

  // ── Build TB lines ──────────────────────────────────────────────────────────
  const lines: TrialBalanceLine[] = [];

  // Cash / Bank entry — ensures total debits = total credits
  // net_cash = income − expenses
  //   positive → cash net received → debit entry
  //   negative → cash net paid out → credit entry
  const netCash = totalIncome.minus(totalExpenses);
  if (!netCash.isZero()) {
    lines.push({
      account_code: CASH_ACCOUNT.code,
      account_name: CASH_ACCOUNT.name,
      debit:  netCash.isGreaterThan(0) ? netCash.toNumber()           : 0,
      credit: netCash.isLessThan(0)    ? netCash.abs().toNumber()     : 0,
    });
  }

  // Expense lines — debit entries (sorted by account code)
  for (const [, { account, total }] of [...expenseMap.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    lines.push({
      account_code: account.code,
      account_name: account.name,
      debit:  total.toNumber(),
      credit: 0,
    });
  }

  // Income lines — credit entries (sorted by account code)
  for (const [, { account, total }] of [...incomeMap.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    lines.push({
      account_code: account.code,
      account_name: account.name,
      debit:  0,
      credit: total.toNumber(),
    });
  }

  return lines;
}
