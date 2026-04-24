/**
 * app/api/receipts/export-excel/route.ts
 *
 * API route: POST /api/receipts/export-excel
 *
 * Generates a trial balance Excel file from confirmed receipt line items and
 * returns it as a downloadable .xlsx binary.
 * Part of Improvement B — Receipt Segregation (Prompt B3).
 *
 * Request body (JSON):
 *   period:        string           — transaction period label (e.g. "March 2026")
 *   incomeItems:   ReceiptEntry[]   — confirmed income items { description, amount }
 *   expenseItems:  ReceiptEntry[]   — confirmed expense items { description, amount }
 *
 * Response:
 *   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet binary
 *   Content-Disposition: attachment; filename="trial-balance-<period>.xlsx"
 *
 * Workbook structure (single sheet):
 *   Sheet: "Trial Balance"
 *   Columns: Account Code | Account Name | Debit (SGD) | Credit (SGD)
 *   Header row: bold, light blue background
 *   Number cells: #,##0.00 accounting format
 *   Final row: "Total" label with SUM formulas in debit/credit columns
 *
 * Matches the column structure of docs/samples/sample_trial_balance.xlsx.
 *
 * Uses exceljs (already installed). Follows the same Buffer→Uint8Array pattern
 * as lib/modelExcelExport.ts and app/api/generate-pdf/route.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { auth } from "@/auth";
import { generateTrialBalanceFromReceipts, type ReceiptEntry } from "@/lib/receiptToTrialBalance";

const COLOR_HEADER_FILL = "FFD6E4F7"; // light blue — matches modelExcelExport.ts
const COLOR_TOTAL_FILL  = "FFF2F2F2"; // light grey for totals row

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    period:       string;
    incomeItems:  ReceiptEntry[];
    expenseItems: ReceiptEntry[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { period, incomeItems, expenseItems } = body;

  if (!period || typeof period !== "string" || !period.trim()) {
    return NextResponse.json(
      { error: "Field 'period' is required." },
      { status: 400 }
    );
  }

  if (!Array.isArray(incomeItems) || !Array.isArray(expenseItems)) {
    return NextResponse.json(
      { error: "Fields 'incomeItems' and 'expenseItems' must be arrays." },
      { status: 400 }
    );
  }

  // ── Generate trial balance ──────────────────────────────────────────────────

  const tbLines = generateTrialBalanceFromReceipts(incomeItems, expenseItems);

  if (tbLines.length === 0) {
    return NextResponse.json(
      { error: "No line items to export. Confirm at least one receipt first." },
      { status: 422 }
    );
  }

  // ── Build workbook ──────────────────────────────────────────────────────────

  const wb = new ExcelJS.Workbook();
  wb.creator  = "FinAgent-SG";
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet("Trial Balance");

  ws.columns = [
    { header: "Account Code", key: "account_code", width: 16 },
    { header: "Account Name", key: "account_name", width: 44 },
    { header: "Debit (SGD)",  key: "debit",        width: 18 },
    { header: "Credit (SGD)", key: "credit",        width: 18 },
  ];

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type:    "pattern",
      pattern: "solid",
      fgColor: { argb: COLOR_HEADER_FILL },
    };
    cell.alignment = { vertical: "middle" };
  });

  // Add data rows
  for (const line of tbLines) {
    const row = ws.addRow([
      line.account_code,
      line.account_name,
      line.debit,
      line.credit,
    ]);
    // Accounting number format on debit and credit cells
    row.getCell(3).numFmt = "#,##0.00";
    row.getCell(4).numFmt = "#,##0.00";
  }

  // Add totals row
  const dataRowCount = tbLines.length;
  const totalRow = ws.addRow([
    "",
    "Total",
    { formula: `SUM(C2:C${dataRowCount + 1})` },
    { formula: `SUM(D2:D${dataRowCount + 1})` },
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(3).numFmt = "#,##0.00";
  totalRow.getCell(4).numFmt = "#,##0.00";
  totalRow.eachCell((cell) => {
    cell.fill = {
      type:    "pattern",
      pattern: "solid",
      fgColor: { argb: COLOR_TOTAL_FILL },
    };
    cell.border = {
      top: { style: "thin" },
    };
  });

  // ── Write to buffer ─────────────────────────────────────────────────────────

  const arrayBuffer = await wb.xlsx.writeBuffer();
  const uint8 = new Uint8Array(Buffer.from(arrayBuffer));

  const safePeriod = period.trim().replace(/[^a-zA-Z0-9-]/g, "-");

  return new NextResponse(uint8, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="trial-balance-${safePeriod}.xlsx"`,
    },
  });
}
