/**
 * components/ProjectionTable.tsx
 *
 * Reusable table for displaying multi-year projected financial data.
 * Used by ModelWorkflow to show projected P&L and Balance Sheet.
 *
 * Renders a shadcn/ui Table with one column per projected year and
 * one row per line item. Totals rows are bold with a top border.
 * Section header rows (e.g. "ASSETS") are uppercase and muted.
 * All amounts are formatted with 2 decimal places and thousands separator.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProjectionLineItem = {
  name:       string;
  values:     number[];    // one value per year, indexed same as `years` prop
  isTotal?:   boolean;     // bold row with top border
  isSection?: boolean;     // uppercase section heading, muted background
  isBlank?:   boolean;     // empty spacer row
};

export type ProjectionTableProps = {
  title:     string;
  years:     number[];           // e.g. [2026, 2027, 2028]
  lineItems: ProjectionLineItem[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Formats a number as a SGD amount string.
 * Thousands separator + 2 decimal places. Negative numbers are shown
 * in parentheses per accounting convention.
 */
function fmtAmount(value: number): string {
  if (isNaN(value)) return "—";
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `(${formatted})` : formatted;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProjectionTable({ title, years, lineItems }: ProjectionTableProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[220px] text-xs font-medium">Line Item</TableHead>
              {years.map((y) => (
                <TableHead key={y} className="text-right text-xs font-medium w-[110px]">
                  FY{y}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lineItems.map((item, idx) => {
              if (item.isBlank) {
                return (
                  <TableRow key={idx} className="h-2 border-0">
                    <TableCell colSpan={years.length + 1} className="py-0" />
                  </TableRow>
                );
              }

              if (item.isSection) {
                return (
                  <TableRow key={idx} className="bg-muted/20 hover:bg-muted/20">
                    <TableCell
                      colSpan={years.length + 1}
                      className="py-1 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                    >
                      {item.name}
                    </TableCell>
                  </TableRow>
                );
              }

              return (
                <TableRow
                  key={idx}
                  className={item.isTotal ? "border-t-2 border-foreground/20" : undefined}
                >
                  <TableCell
                    className={`py-1.5 text-xs ${
                      item.isTotal
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground pl-5"
                    }`}
                  >
                    {item.name}
                  </TableCell>
                  {item.values.map((val, yIdx) => (
                    <TableCell
                      key={yIdx}
                      className={`py-1.5 text-right text-xs font-mono tabular-nums ${
                        item.isTotal ? "font-semibold text-foreground" : "text-foreground"
                      } ${val < 0 ? "text-destructive" : ""}`}
                    >
                      {fmtAmount(val)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
