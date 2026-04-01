/**
 * components/VarianceTable.tsx
 *
 * Budget-vs-actual variance table for FinAgent-SG Phase 3.
 * Displays the comparison result from compareBudgetVsActual() with
 * color-coding: green for favorable variances, red for unfavorable.
 *
 * Shows an optional summary section above the detail table with total
 * revenue variance, total expense variance, and net profit impact.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BudgetVsActualItem, BVASummary } from "@/lib/budgetVsActual";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VarianceTableProps = {
  items:   BudgetVsActualItem[];
  summary?: BVASummary;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(s: string): string {
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `(${formatted})` : formatted;
}

function fmtVariance(s: string): string {
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n > 0) return `+${formatted}`;
  if (n < 0) return `(${formatted})`;
  return "—";
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    revenue:               "Revenue",
    current_asset:         "Current Asset",
    non_current_asset:     "Non-Current Asset",
    current_liability:     "Current Liability",
    non_current_liability: "Non-Current Liability",
    equity:                "Equity",
    expense:               "Expense",
  };
  return map[cat] ?? cat;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function VarianceTable({ items, summary }: VarianceTableProps) {
  // Group items by category for section headers
  const grouped: { category: string; rows: BudgetVsActualItem[] }[] = [];
  for (const item of items) {
    const existing = grouped.find((g) => g.category === item.category);
    if (existing) {
      existing.rows.push(item);
    } else {
      grouped.push({ category: item.category, rows: [item] });
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Summary ── */}
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard
            label="Revenue Variance"
            value={summary.total_revenue_variance}
            favorable={parseFloat(summary.total_revenue_variance) >= 0}
          />
          <SummaryCard
            label="Expense Variance"
            value={summary.total_expense_variance}
            favorable={parseFloat(summary.total_expense_variance) <= 0}
          />
          <SummaryCard
            label="Net Profit Impact"
            value={summary.net_profit_variance}
            favorable={parseFloat(summary.net_profit_variance) >= 0}
          />
        </div>
      )}

      {/* ── Detail table ── */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="text-xs font-medium w-[180px]">Account</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground w-[90px]">
                Category
              </TableHead>
              <TableHead className="text-right text-xs font-medium w-[110px]">Budget</TableHead>
              <TableHead className="text-right text-xs font-medium w-[110px]">Actual</TableHead>
              <TableHead className="text-right text-xs font-medium w-[110px]">Variance</TableHead>
              <TableHead className="text-right text-xs font-medium w-[70px]">Var %</TableHead>
              <TableHead className="text-center text-xs font-medium w-[50px]">Fav?</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map(({ category, rows }) => (
              <>
                {/* Section heading row */}
                <TableRow key={`section-${category}`} className="bg-muted/20 hover:bg-muted/20">
                  <TableCell
                    colSpan={7}
                    className="py-1 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                  >
                    {categoryLabel(category)}
                  </TableCell>
                </TableRow>

                {/* Data rows */}
                {rows.map((item, i) => (
                  <TableRow
                    key={`${category}-${i}`}
                    className={
                      item.favorable
                        ? "bg-green-50/40 hover:bg-green-50/60"
                        : "bg-red-50/40 hover:bg-red-50/60"
                    }
                  >
                    <TableCell className="py-1.5 text-xs pl-5">
                      <span className="text-foreground">{item.account_name}</span>
                      {item.account_code && (
                        <span className="ml-1 text-muted-foreground/60 font-mono">
                          [{item.account_code}]
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {categoryLabel(item.category)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs font-mono tabular-nums">
                      {fmtAmount(item.budget_amount)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs font-mono tabular-nums">
                      {fmtAmount(item.actual_amount)}
                    </TableCell>
                    <TableCell
                      className={`py-1.5 text-right text-xs font-mono tabular-nums font-medium ${
                        item.favorable ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {fmtVariance(item.variance_amount)}
                    </TableCell>
                    <TableCell
                      className={`py-1.5 text-right text-xs font-mono ${
                        item.favorable ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {item.variance_pct}
                    </TableCell>
                    <TableCell className="py-1.5 text-center text-xs">
                      {item.favorable ? "✅" : "❌"}
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Top variances ── */}
      {summary && (
        <div className="grid grid-cols-2 gap-4">
          <TopVarianceList
            title="Top Favorable Variances"
            items={summary.top_3_favorable_variances}
            favorable
          />
          <TopVarianceList
            title="Top Unfavorable Variances"
            items={summary.top_3_unfavorable_variances}
            favorable={false}
          />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  favorable,
}: {
  label: string;
  value: string;
  favorable: boolean;
}) {
  const n = parseFloat(value);
  return (
    <div
      className={`rounded-md border p-3 ${
        favorable ? "border-green-200 bg-green-50/50" : "border-red-200 bg-red-50/50"
      }`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-semibold font-mono mt-0.5 ${
          favorable ? "text-green-700" : "text-red-700"
        }`}
      >
        {fmtVariance(value)}
      </p>
    </div>
  );
}

function TopVarianceList({
  title,
  items,
  favorable,
}: {
  title: string;
  items: BudgetVsActualItem[];
  favorable: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p
        className={`text-xs font-semibold mb-1 ${
          favorable ? "text-green-700" : "text-red-700"
        }`}
      >
        {title}
      </p>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-muted-foreground flex justify-between">
            <span className="truncate mr-2">{item.account_name}</span>
            <span
              className={`font-mono font-medium shrink-0 ${
                favorable ? "text-green-700" : "text-red-700"
              }`}
            >
              {fmtVariance(item.variance_amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
