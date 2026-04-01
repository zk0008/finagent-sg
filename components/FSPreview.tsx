/**
 * components/FSPreview.tsx
 *
 * In-browser financial statement preview modal.
 *
 * What this component does:
 * Renders the full structured FS output (from fsGenerator.ts) as formatted
 * HTML tables inside a shadcn/ui Dialog. Displays all five FS components:
 *   1. Balance Sheet
 *   2. Profit & Loss
 *   3. Cash Flow Statement
 *   4. Statement of Changes in Equity
 *   5. Notes to Financial Statements
 * Plus a reference table of XBRL tags at the bottom.
 *
 * Data flow:
 * The fsOutput prop is the exact JSON returned by the SSE pipeline's "complete"
 * event — no additional API calls are made. Amounts are formatted for display
 * only (not computed); all arithmetic was done by calculationEngine.ts upstream.
 *
 * Called by: components/WorkflowPanel.tsx when the user clicks "Preview".
 */

"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── Types ────────────────────────────────────────────────────────────────────

type LineItem = { label: string; amount: number };
type Note = { title: string; content: string };

// The FSOutput shape as returned by the SSE pipeline.
// Typed loosely here since we extract and cast per-section below.
type FSOutputRaw = Record<string, unknown>;

type Props = {
  open: boolean;
  onClose: () => void;
  fsOutput: FSOutputRaw;
  companyName: string;
  fyeDate: string;   // YYYY-MM-DD
};

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Formats a number as SGD with 2dp and thousand separators. Negatives in parens. */
function fmt(value: unknown): string {
  const n = Number(value ?? 0);
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `(${formatted})` : formatted;
}

/** Formats a YYYY-MM-DD date string as "31 December 2025". */
function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold text-gray-900 uppercase tracking-wide mt-4 mb-1 border-b border-gray-300 pb-0.5">
      {children}
    </h2>
  );
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-gray-700 mt-2 mb-0.5">{children}</p>
  );
}

/** Renders a list of line items as label + right-aligned amount rows. */
function LineItems({ items }: { items: LineItem[] }) {
  if (!items || items.length === 0) return null;
  const safe = items.filter((item) => item != null);
  return (
    <>
      {safe.map((item, i) => (
        <div key={i} className="flex justify-between text-[11px] py-px pl-3">
          <span className="text-gray-700">{item.label}</span>
          <span className="font-mono text-gray-900 tabular-nums">{fmt(item.amount)}</span>
        </div>
      ))}
    </>
  );
}

/** Renders a subtotal/total row with a top border and bold text. */
function TotalRow({ label, amount, double = false }: { label: string; amount: unknown; double?: boolean }) {
  return (
    <div className={`flex justify-between text-[11px] py-px mt-0.5 pt-0.5 border-t ${double ? "border-double border-t-4 border-gray-400" : "border-gray-300"}`}>
      <span className="font-semibold text-gray-900">{label}</span>
      <span className="font-mono font-semibold text-gray-900 tabular-nums">{fmt(amount)}</span>
    </div>
  );
}

/** Renders a single key-value data row (label left, amount right). */
function DataRow({ label, amount }: { label: string; amount: unknown }) {
  return (
    <div className="flex justify-between text-[11px] py-px pl-3">
      <span className="text-gray-700">{label}</span>
      <span className="font-mono text-gray-900 tabular-nums">{fmt(amount)}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function FSPreview({ open, onClose, fsOutput, companyName, fyeDate }: Props) {
  const bs = (fsOutput.balance_sheet ?? {}) as Record<string, unknown>;
  const pl = (fsOutput.profit_and_loss ?? {}) as Record<string, unknown>;
  const cf = (fsOutput.cash_flow ?? {}) as Record<string, unknown>;
  const eq = (fsOutput.equity_statement ?? {}) as Record<string, unknown>;
  const notes = Array.isArray(fsOutput.notes) ? (fsOutput.notes as Note[]) : [];
  const xbrl = (fsOutput.xbrl_tags ?? {}) as Record<string, string>;

  const ops = (cf.operating_activities ?? {}) as Record<string, unknown>;
  const inv = (cf.investing_activities ?? {}) as Record<string, unknown>;
  const fin = (cf.financing_activities ?? {}) as Record<string, unknown>;
  const re = (eq.retained_earnings ?? {}) as Record<string, unknown>;
  const sc = (eq.share_capital ?? {}) as Record<string, unknown>;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="w-auto max-w-4xl max-h-[95vh] overflow-y-auto bg-white text-gray-900">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-gray-900">
            Financial Statements Preview
          </DialogTitle>
        </DialogHeader>

        {/* ── Cover ── */}
        <div className="text-center py-3 border-b border-gray-200">
          <p className="text-base font-bold text-gray-900">{companyName}</p>
          <p className="text-xs text-gray-500 mt-1">Financial Statements</p>
          <p className="text-xs text-gray-500">For the Financial Year Ended {fmtDate(fyeDate)}</p>
          <p className="text-xs text-gray-500">Currency: SGD</p>
        </div>

        {/* ── 1. Balance Sheet ── */}
        <SectionHeader>1. Balance Sheet (Statement of Financial Position)</SectionHeader>
        <p className="text-[10px] text-gray-500 mb-1">As at {fmtDate(fyeDate)}</p>

        <SubHeader>ASSETS</SubHeader>
        <SubHeader>Current Assets</SubHeader>
        <LineItems items={bs.current_assets as LineItem[]} />
        <TotalRow label="Total Current Assets" amount={bs.total_current_assets} />

        <SubHeader>Non-Current Assets</SubHeader>
        <LineItems items={bs.non_current_assets as LineItem[]} />
        <TotalRow label="Total Non-Current Assets" amount={bs.total_non_current_assets} />
        <TotalRow label="TOTAL ASSETS" amount={bs.total_assets} double />

        <SubHeader>LIABILITIES</SubHeader>
        <SubHeader>Current Liabilities</SubHeader>
        <LineItems items={bs.current_liabilities as LineItem[]} />
        <TotalRow label="Total Current Liabilities" amount={bs.total_current_liabilities} />

        <SubHeader>Non-Current Liabilities</SubHeader>
        <LineItems items={bs.non_current_liabilities as LineItem[]} />
        <TotalRow label="Total Non-Current Liabilities" amount={bs.total_non_current_liabilities} />
        <TotalRow label="Total Liabilities" amount={bs.total_liabilities} />

        <SubHeader>EQUITY</SubHeader>
        <LineItems items={bs.equity as LineItem[]} />
        <TotalRow label="Total Equity" amount={bs.total_equity} />
        <TotalRow label="TOTAL LIABILITIES AND EQUITY" amount={bs.total_liabilities_and_equity} double />

        {/* ── 2. Profit & Loss ── */}
        <SectionHeader>2. Profit &amp; Loss (Statement of Comprehensive Income)</SectionHeader>
        <p className="text-[10px] text-gray-500 mb-1">For the year ended {fmtDate(fyeDate)}</p>

        <SubHeader>Revenue</SubHeader>
        <LineItems items={pl.revenue_lines as LineItem[]} />
        <TotalRow label="Total Revenue" amount={pl.total_revenue} />

        <SubHeader>Expenses</SubHeader>
        <LineItems items={pl.expense_lines as LineItem[]} />
        <TotalRow label="Total Expenses" amount={pl.total_expenses} />
        <TotalRow label="NET PROFIT / (LOSS) FOR THE YEAR" amount={pl.net_profit} double />

        {/* ── 3. Cash Flow ── */}
        <SectionHeader>3. Cash Flow Statement (Indirect Method)</SectionHeader>
        <p className="text-[10px] text-gray-500 mb-1">For the year ended {fmtDate(fyeDate)}</p>

        <SubHeader>Operating Activities</SubHeader>
        <DataRow label="Net Profit" amount={ops.net_profit} />
        <p className="text-[10px] text-gray-500 pl-3 mt-1">Adjustments for non-cash items:</p>
        <LineItems items={ops.adjustments as LineItem[]} />
        <p className="text-[10px] text-gray-500 pl-3 mt-1">Changes in working capital:</p>
        <LineItems items={ops.working_capital_changes as LineItem[]} />
        <TotalRow label="Net Cash from Operating Activities" amount={ops.net_cash_from_operations} />

        <SubHeader>Investing Activities</SubHeader>
        <LineItems items={inv.items as LineItem[]} />
        <TotalRow label="Net Cash from Investing Activities" amount={inv.net_cash_from_investing} />

        <SubHeader>Financing Activities</SubHeader>
        <LineItems items={fin.items as LineItem[]} />
        <TotalRow label="Net Cash from Financing Activities" amount={fin.net_cash_from_financing} />

        <div className="mt-1">
          <DataRow label="Net Increase / (Decrease) in Cash" amount={cf.net_change_in_cash} />
          <DataRow label="Opening Cash Balance" amount={cf.opening_cash} />
          <TotalRow label="Closing Cash Balance" amount={cf.closing_cash} double />
        </div>

        {/* ── 4. Changes in Equity ── */}
        <SectionHeader>4. Statement of Changes in Equity</SectionHeader>
        <p className="text-[10px] text-gray-500 mb-1">For the year ended {fmtDate(fyeDate)}</p>

        <SubHeader>Retained Earnings</SubHeader>
        <DataRow label="Opening balance" amount={re.opening} />
        <DataRow label="Net profit for the year" amount={re.net_profit} />
        <DataRow label="Dividends paid" amount={re.dividends != null ? -Math.abs(Number(re.dividends)) : 0} />
        <TotalRow label="Closing balance" amount={re.closing} />

        <SubHeader>Share Capital</SubHeader>
        <DataRow label="Opening balance" amount={sc.opening} />
        <DataRow label="Shares issued during the year" amount={sc.issued} />
        <TotalRow label="Closing balance" amount={sc.closing} />

        <TotalRow label="TOTAL EQUITY" amount={eq.total_equity_closing} double />

        {/* ── 5. Notes ── */}
        <SectionHeader>5. Notes to Financial Statements</SectionHeader>
        <div className="space-y-3">
          {notes.map((note, i) => (
            <div key={i}>
              <p className="text-[11px] font-semibold text-gray-900">{note.title}</p>
              <p className="text-[11px] text-gray-700 mt-0.5 leading-snug">{note.content}</p>
            </div>
          ))}
        </div>

        {/* ── XBRL Tags Reference ── */}
        {Object.keys(xbrl).length > 0 && (
          <>
            <SectionHeader>XBRL Tags Reference</SectionHeader>
            <p className="text-[10px] text-gray-500 mb-1">ACRA BizFile+ taxonomy tag mapping (JSON only — full XBRL XML generation is a future feature).</p>
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-0.5 pr-4 font-semibold text-gray-700">Key</th>
                  <th className="text-left py-0.5 font-semibold text-gray-700">XBRL Tag</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(xbrl).map(([key, tag]) => (
                  <tr key={key} className="border-b border-gray-100">
                    <td className="py-px pr-4 text-gray-600 font-mono">{key}</td>
                    <td className="py-px text-gray-800 font-mono">{tag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="h-2" />
      </DialogContent>
    </Dialog>
  );
}
