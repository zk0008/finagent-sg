/**
 * lib/modelExcelExport.ts
 *
 * Excel export for financial model output — FinAgent-SG Phase 3.
 *
 * What this module does:
 * Generates a multi-sheet Excel workbook from the projection results
 * (base, best, worst cases) plus optional assumptions and BVA data.
 * Returns a Buffer that the API route streams as a file download.
 *
 * Workbook structure:
 *   Sheet 1:  "Assumptions"      — all projection assumptions with rationales
 *   Sheet 2:  "Base Case P&L"    — projected P&L for all projection years
 *   Sheet 3:  "Base Case BS"     — projected balance sheet for all years
 *   Sheet 4:  "Best Case P&L"
 *   Sheet 5:  "Best Case BS"
 *   Sheet 6:  "Worst Case P&L"
 *   Sheet 7:  "Worst Case BS"
 *   Sheet 8:  "Budget vs Actual" — only if actuals data is provided
 *
 * Formatting:
 *   - Header rows: bold, light blue background (#D6E4F7)
 *   - Section header rows: bold, light grey background (#F2F2F2)
 *   - Total rows: bold, thin top border
 *   - Number cells: #,##0.00 accounting format
 *   - Tab colors: blue (base), green (best), red (worst), orange (BVA)
 *   - Column widths set to reasonable defaults (auto-fit approximated)
 *
 * Uses exceljs (already installed in Phase 2 for Excel parsing).
 * Returns a Buffer — converted to Uint8Array in the API route, same as pdfkit.
 *
 * No AI is used here. Pure data formatting only.
 *
 * Called by: app/api/model/export-excel/route.ts (Phase 3, Prompt 9).
 */

import ExcelJS from "exceljs";
import { type ProjectedFS, type ProjectionAssumptions } from "./schemas";
import type { BudgetVsActualItem, BVASummary } from "./budgetVsActual";

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_HEADER_FILL  = "FFD6E4F7"; // light blue
const COLOR_SECTION_FILL = "FFF2F2F2"; // light grey
const COLOR_TAB_BASE     = "FF2563EB"; // blue-600
const COLOR_TAB_BEST     = "FF16A34A"; // green-600
const COLOR_TAB_WORST    = "FFDC2626"; // red-600
const COLOR_TAB_BVA      = "FFD97706"; // amber-600
const COLOR_FAVORABLE    = "FFD1FAE5"; // green-50
const COLOR_UNFAVORABLE  = "FFFEE2E2"; // red-50

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelExcelParams = {
  modelName:       string;
  projectionYears: number;
  baseYear:        number;
  assumptions:     ProjectionAssumptions;
  rationales?:     Record<string, string>; // keyed by assumption field name
  base_case:       ProjectedFS[];
  best_case:       ProjectedFS[];
  worst_case:      ProjectedFS[];
  bva?: {
    year:       number;
    bva_result: BudgetVsActualItem[];
    summary:    BVASummary;
  };
};

// ── Internal helpers ──────────────────────────────────────────────────────────

type LineItem = { label: string; amount: number };

function getLineItems(arr: unknown): LineItem[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (x): x is LineItem =>
      x != null &&
      typeof x === "object" &&
      "label" in x &&
      "amount" in x
  );
}

/** Applies bold + light blue background to a header row. */
function styleHeaderRow(row: ExcelJS.Row, colCount: number): void {
  row.font    = { bold: true };
  row.height  = 18;
  for (let c = 1; c <= colCount; c++) {
    row.getCell(c).fill = {
      type:    "pattern",
      pattern: "solid",
      fgColor: { argb: COLOR_HEADER_FILL },
    };
  }
  row.commit();
}

/** Applies bold + grey background to a section-header row. */
function styleSectionRow(row: ExcelJS.Row, colCount: number): void {
  row.font = { bold: true };
  for (let c = 1; c <= colCount; c++) {
    row.getCell(c).fill = {
      type:    "pattern",
      pattern: "solid",
      fgColor: { argb: COLOR_SECTION_FILL },
    };
  }
  row.commit();
}

/** Applies a thin top border + bold to a totals row. */
function styleTotalRow(row: ExcelJS.Row, colCount: number): void {
  row.font = { bold: true };
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.border = {
      ...cell.border,
      top: { style: "thin" },
    };
  }
  row.commit();
}

/** Sets accounting number format on all numeric columns in a row. */
function applyNumberFormat(row: ExcelJS.Row, startCol: number, endCol: number): void {
  for (let c = startCol; c <= endCol; c++) {
    row.getCell(c).numFmt = '#,##0.00';
  }
}

// ── Assumptions sheet ─────────────────────────────────────────────────────────

function buildAssumptionsSheet(
  wb:          ExcelJS.Workbook,
  assumptions: ProjectionAssumptions,
  rationales:  Record<string, string> | undefined,
  modelName:   string
): void {
  const ws = wb.addWorksheet("Assumptions");
  ws.properties.tabColor = { argb: COLOR_TAB_BASE };

  ws.columns = [
    { key: "field",     width: 28 },
    { key: "value",     width: 16 },
    { key: "rationale", width: 60 },
  ];

  // Title
  ws.addRow([modelName]).font = { bold: true, size: 13 };
  ws.addRow(["Projection Assumptions"]).font = { italic: true, color: { argb: "FF6B7280" } };
  ws.addRow([]);

  // Header
  const hdr = ws.addRow(["Assumption", "Value", "Rationale (AI-suggested)"]);
  styleHeaderRow(hdr, 3);

  const rows: Array<{ field: string; value: string; rationale: string }> = [
    {
      field:     "Revenue Growth",
      value:     `${assumptions.revenue_growth_pct}%`,
      rationale: rationales?.revenue_growth_pct ?? "",
    },
    {
      field:     "COGS Growth",
      value:     `${assumptions.cogs_growth_pct}%`,
      rationale: rationales?.cogs_growth_pct ?? "",
    },
    {
      field:     "OpEx Growth",
      value:     `${assumptions.opex_growth_pct}%`,
      rationale: rationales?.opex_growth_pct ?? "",
    },
    {
      field:     "Depreciation Method",
      value:     assumptions.depreciation_method === "straight_line"
                   ? "Straight-line"
                   : "Reducing Balance",
      rationale: rationales?.depreciation_method ?? "",
    },
    {
      field:     "Corporate Tax Rate",
      value:     `${assumptions.tax_rate_pct}%`,
      rationale: rationales?.tax_rate_pct ?? "",
    },
  ];

  for (const r of rows) {
    const row = ws.addRow([r.field, r.value, r.rationale]);
    row.getCell("rationale").alignment = { wrapText: true };
    row.commit();
  }

  // Custom line assumptions (if any)
  if (assumptions.custom_line_assumptions.length > 0) {
    ws.addRow([]);
    const subHdr = ws.addRow(["Custom Line Overrides", "Growth %", ""]);
    styleSectionRow(subHdr, 3);
    for (const override of assumptions.custom_line_assumptions) {
      ws.addRow([override.account_code, `${override.growth_pct}%`, ""]);
    }
  }
}

// ── P&L sheet ─────────────────────────────────────────────────────────────────

function buildPLSheet(
  wb:         ExcelJS.Workbook,
  sheetName:  string,
  tabColor:   string,
  cases:      ProjectedFS[],
  baseYear:   number
): void {
  const ws = wb.addWorksheet(sheetName);
  ws.properties.tabColor = { argb: tabColor };

  const yearCols = cases.map((c) => ({
    header: `FY${baseYear + c.year}`,
    key:    `y${c.year}`,
    width:  14,
  }));

  ws.columns = [
    { key: "label", width: 36 },
    ...yearCols,
  ];

  const colCount = 1 + cases.length;

  // Header row
  const hdrRow = ws.addRow(["Line Item", ...cases.map((c) => `FY${baseYear + c.year}`)]);
  styleHeaderRow(hdrRow, colCount);

  // Helper: add a data row
  function addRow(
    label:     string,
    values:    number[],
    opts?: { isTotalRow?: boolean; isSectionRow?: boolean; indent?: boolean }
  ) {
    const row = ws.addRow([label, ...values]);
    if (opts?.isSectionRow) {
      styleSectionRow(row, colCount);
    } else if (opts?.isTotalRow) {
      styleTotalRow(row, colCount);
      applyNumberFormat(row, 2, colCount);
    } else {
      applyNumberFormat(row, 2, colCount);
      if (opts?.indent) {
        row.getCell(1).alignment = { indent: 2 };
      }
    }
    row.commit();
  }

  // ── Revenue ──
  addRow("Revenue", [], { isSectionRow: true });
  const pls = cases.map((c) => c.profit_and_loss as Record<string, unknown>);
  const pl0 = pls[0];
  const revLines = getLineItems(pl0.revenue_lines);
  for (const item of revLines) {
    addRow(
      item.label,
      pls.map((pl) => getLineItems(pl.revenue_lines).find((r) => r.label === item.label)?.amount ?? 0),
      { indent: true }
    );
  }
  addRow("Total Revenue", pls.map((pl) => Number(pl.total_revenue ?? 0)), { isTotalRow: true });

  ws.addRow([]);

  // ── Expenses ──
  addRow("Expenses", [], { isSectionRow: true });
  const expLines = getLineItems(pl0.expense_lines);
  for (const item of expLines) {
    addRow(
      item.label,
      pls.map((pl) => getLineItems(pl.expense_lines).find((r) => r.label === item.label)?.amount ?? 0),
      { indent: true }
    );
  }
  addRow("Total Expenses", pls.map((pl) => Number(pl.total_expenses ?? 0)), { isTotalRow: true });

  ws.addRow([]);

  // ── Net Profit ──
  addRow("Net Profit / (Loss)", pls.map((pl) => Number(pl.net_profit ?? 0)), { isTotalRow: true });
}

// ── Balance Sheet sheet ───────────────────────────────────────────────────────

function buildBSSheet(
  wb:        ExcelJS.Workbook,
  sheetName: string,
  tabColor:  string,
  cases:     ProjectedFS[],
  baseYear:  number
): void {
  const ws = wb.addWorksheet(sheetName);
  ws.properties.tabColor = { argb: tabColor };

  ws.columns = [
    { key: "label", width: 36 },
    ...cases.map((c) => ({ key: `y${c.year}`, header: `FY${baseYear + c.year}`, width: 14 })),
  ];

  const colCount = 1 + cases.length;

  const hdrRow = ws.addRow(["Line Item", ...cases.map((c) => `FY${baseYear + c.year}`)]);
  styleHeaderRow(hdrRow, colCount);

  const bss = cases.map((c) => c.balance_sheet as Record<string, unknown>);
  const bs0 = bss[0];

  function addRow(
    label:  string,
    values: number[],
    opts?:  { isTotalRow?: boolean; isSectionRow?: boolean; indent?: boolean }
  ) {
    const row = ws.addRow([label, ...values]);
    if (opts?.isSectionRow) {
      styleSectionRow(row, colCount);
    } else if (opts?.isTotalRow) {
      styleTotalRow(row, colCount);
      applyNumberFormat(row, 2, colCount);
    } else {
      applyNumberFormat(row, 2, colCount);
      if (opts?.indent) {
        row.getCell(1).alignment = { indent: 2 };
      }
    }
    row.commit();
  }

  function addSection(sectionLabel: string, lineKey: string, totalKey: string) {
    addRow(sectionLabel, [], { isSectionRow: true });
    const items = getLineItems(bs0[lineKey]);
    for (const item of items) {
      addRow(
        item.label,
        bss.map((bs) => getLineItems(bs[lineKey]).find((r) => r.label === item.label)?.amount ?? 0),
        { indent: true }
      );
    }
    addRow(
      `Total ${sectionLabel}`,
      bss.map((bs) => Number(bs[totalKey] ?? 0)),
      { isTotalRow: true }
    );
    ws.addRow([]);
  }

  // Assets
  addSection("Current Assets",          "current_assets",       "total_current_assets");
  addSection("Non-Current Assets",       "non_current_assets",   "total_non_current_assets");
  addRow("Total Assets", bss.map((bs) => Number(bs.total_assets ?? 0)), { isTotalRow: true });
  ws.addRow([]);

  // Liabilities
  addSection("Current Liabilities",       "current_liabilities",     "total_current_liabilities");
  addSection("Non-Current Liabilities",   "non_current_liabilities", "total_non_current_liabilities");
  addRow("Total Liabilities", bss.map((bs) => Number(bs.total_liabilities ?? 0)), { isTotalRow: true });
  ws.addRow([]);

  // Equity
  addSection("Equity", "equity", "total_equity");
  addRow(
    "Total Liabilities & Equity",
    bss.map((bs) => Number(bs.total_liabilities_and_equity ?? 0)),
    { isTotalRow: true }
  );
}

// ── Budget vs Actual sheet ────────────────────────────────────────────────────

function buildBVASheet(
  wb:         ExcelJS.Workbook,
  bvaYear:    number,
  bva_result: BudgetVsActualItem[],
  summary:    BVASummary,
  baseYear:   number
): void {
  const ws = wb.addWorksheet("Budget vs Actual");
  ws.properties.tabColor = { argb: COLOR_TAB_BVA };

  ws.columns = [
    { key: "account_code",    width: 14 },
    { key: "account_name",    width: 32 },
    { key: "category",        width: 20 },
    { key: "budget_amount",   width: 16 },
    { key: "actual_amount",   width: 16 },
    { key: "variance_amount", width: 16 },
    { key: "variance_pct",    width: 12 },
    { key: "favorable",       width: 10 },
  ];

  // Title
  ws.addRow([`Budget vs Actual — Year ${bvaYear} (FY${baseYear + bvaYear})`]).font = { bold: true, size: 13 };

  // Summary block
  ws.addRow([]);
  const sumHdr = ws.addRow(["Summary", "", "", "Budget", "Actual", "Variance", "", ""]);
  styleSectionRow(sumHdr, 8);

  const revRow = ws.addRow([
    "Total Revenue", "", "",
    parseFloat(summary.total_revenue_variance) + 0, // placeholder — we don't store totals separately
    "", summary.total_revenue_variance, "", ""
  ]);
  revRow.getCell(6).numFmt = '#,##0.00';
  revRow.commit();

  ws.addRow([
    "Net Profit Variance", "", "", "", "",
    summary.net_profit_variance, "", ""
  ]).getCell(6).numFmt = '#,##0.00';

  ws.addRow([]);

  // Header
  const hdr = ws.addRow([
    "Code", "Account Name", "Category",
    "Budget", "Actual", "Variance", "Var %", "Favorable"
  ]);
  styleHeaderRow(hdr, 8);

  // Data rows grouped by category
  let lastCategory = "";
  for (const item of bva_result) {
    // Section header when category changes
    if (item.category !== lastCategory) {
      const secLabel = item.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const secRow = ws.addRow([secLabel, "", "", "", "", "", "", ""]);
      styleSectionRow(secRow, 8);
      lastCategory = item.category;
    }

    const row = ws.addRow([
      item.account_code,
      item.account_name,
      item.category,
      parseFloat(item.budget_amount),
      parseFloat(item.actual_amount),
      parseFloat(item.variance_amount),
      item.variance_pct,
      item.favorable ? "Yes" : "No",
    ]);

    // Color-code by favorable/unfavorable
    const fillColor = item.favorable ? COLOR_FAVORABLE : COLOR_UNFAVORABLE;
    for (let c = 1; c <= 8; c++) {
      row.getCell(c).fill = {
        type:    "pattern",
        pattern: "solid",
        fgColor: { argb: fillColor },
      };
    }
    // Number format for numeric columns
    for (const c of [4, 5, 6]) {
      row.getCell(c).numFmt = '#,##0.00';
    }
    row.commit();
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generates the full model Excel workbook and returns it as a Buffer.
 *
 * @param params - Model data from the frontend (no extra DB call needed)
 * @returns Buffer of the .xlsx file
 */
export async function generateModelExcel(params: ModelExcelParams): Promise<Buffer> {
  const {
    modelName,
    baseYear,
    assumptions,
    rationales,
    base_case,
    best_case,
    worst_case,
    bva,
  } = params;

  const wb = new ExcelJS.Workbook();
  wb.creator  = "FinAgent-SG";
  wb.created  = new Date();
  wb.modified = new Date();

  // Sheet 1: Assumptions
  buildAssumptionsSheet(wb, assumptions, rationales, modelName);

  // Sheets 2-3: Base Case
  buildPLSheet(wb, "Base Case P&L", COLOR_TAB_BASE, base_case, baseYear);
  buildBSSheet(wb, "Base Case BS",  COLOR_TAB_BASE, base_case, baseYear);

  // Sheets 4-5: Best Case
  buildPLSheet(wb, "Best Case P&L", COLOR_TAB_BEST, best_case, baseYear);
  buildBSSheet(wb, "Best Case BS",  COLOR_TAB_BEST, best_case, baseYear);

  // Sheets 6-7: Worst Case
  buildPLSheet(wb, "Worst Case P&L", COLOR_TAB_WORST, worst_case, baseYear);
  buildBSSheet(wb, "Worst Case BS",  COLOR_TAB_WORST, worst_case, baseYear);

  // Sheet 8: Budget vs Actual (optional)
  if (bva) {
    buildBVASheet(wb, bva.year, bva.bva_result, bva.summary, baseYear);
  }

  // Write to buffer
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
