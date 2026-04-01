/**
 * scripts/createSampleTrialBalance.ts
 *
 * Creates a sample trial balance Excel file for testing FinAgent-SG.
 * Run: npx tsx scripts/createSampleTrialBalance.ts
 *
 * Output: docs/samples/sample_trial_balance.xlsx
 *
 * The sample represents a realistic small Singapore private limited company
 * (a software services firm) for FYE 31 December 2025.
 * Debits = Credits = SGD 1,318,500.00
 * 22 account lines covering assets, liabilities, equity, revenue, and expenses.
 */

import ExcelJS from "exceljs";
import path from "path";

// Sample trial balance data for "TechSoft Pte Ltd" (fictitious)
// Realistic SGD amounts for a small Singapore software services company.
// Debit-normal: assets, expenses (positive in debit column)
// Credit-normal: liabilities, equity, revenue (positive in credit column)
const ACCOUNTS = [
  // ── Assets ──────────────────────────────────────────────────────────────
  { code: "1010", name: "Cash at Bank - OCBC Current Account",   debit: 85000.00,   credit: 0 },
  { code: "1020", name: "Cash at Bank - DBS Savings Account",    debit: 198300.00,  credit: 0 },
  { code: "1110", name: "Trade Receivables",                     debit: 120000.00,  credit: 0 },
  { code: "1120", name: "Other Receivables",                     debit: 8500.00,    credit: 0 },
  { code: "1130", name: "GST Receivable",                        debit: 6200.00,    credit: 0 },
  { code: "1200", name: "Prepayments",                           debit: 12000.00,   credit: 0 },
  { code: "1300", name: "Inventories - Software Licences",       debit: 18000.00,   credit: 0 },
  { code: "2010", name: "Office Equipment (at cost)",            debit: 55000.00,   credit: 0 },
  { code: "2011", name: "Accumulated Depreciation - Equipment",  debit: 0,          credit: 18000.00 },
  { code: "2020", name: "Furniture and Fittings (at cost)",      debit: 22000.00,   credit: 0 },
  { code: "2021", name: "Accumulated Depreciation - Furniture",  debit: 0,          credit: 8800.00 },
  { code: "2030", name: "Computer Hardware (at cost)",           debit: 38000.00,   credit: 0 },
  { code: "2031", name: "Accumulated Depreciation - Computers",  debit: 0,          credit: 15200.00 },
  // ── Liabilities ──────────────────────────────────────────────────────────
  { code: "3010", name: "Trade Payables",                        debit: 0,          credit: 42000.00 },
  { code: "3020", name: "Accrued Expenses",                      debit: 0,          credit: 18500.00 },
  { code: "3030", name: "GST Payable",                           debit: 0,          credit: 9800.00 },
  { code: "3040", name: "Income Tax Payable",                    debit: 0,          credit: 24200.00 },
  { code: "3050", name: "CPF Payable",                           debit: 0,          credit: 7500.00 },
  { code: "3510", name: "Term Loan - DBS Bank",                  debit: 0,          credit: 80000.00 },
  // ── Equity ───────────────────────────────────────────────────────────────
  { code: "4010", name: "Share Capital (Ordinary Shares)",       debit: 0,          credit: 100000.00 },
  { code: "4020", name: "Retained Earnings (Opening)",           debit: 0,          credit: 125000.00 },
  // ── Revenue ───────────────────────────────────────────────────────────────
  { code: "5010", name: "Revenue - Software Development Services", debit: 0,        credit: 480000.00 },
  { code: "5020", name: "Revenue - IT Consulting",               debit: 0,          credit: 180000.00 },
  { code: "5030", name: "Revenue - Software Maintenance",        debit: 0,          credit: 96000.00 },
  { code: "5040", name: "Interest Income",                       debit: 0,          credit: 2800.00 },
  // ── Expenses ─────────────────────────────────────────────────────────────
  { code: "6010", name: "Staff Salaries and Wages",              debit: 288000.00,  credit: 0 },
  { code: "6020", name: "CPF Contributions - Employer",          debit: 48600.00,   credit: 0 },
  { code: "6030", name: "Staff Training and Development",        debit: 8400.00,    credit: 0 },
  { code: "6110", name: "Office Rental",                         debit: 60000.00,   credit: 0 },
  { code: "6120", name: "Utilities and Telecommunication",       debit: 12000.00,   credit: 0 },
  { code: "6130", name: "Office Supplies",                       debit: 4200.00,    credit: 0 },
  { code: "6210", name: "Cost of Software Licences Sold",        debit: 54000.00,   credit: 0 },
  { code: "6220", name: "Subcontractor Fees",                    debit: 72000.00,   credit: 0 },
  { code: "6310", name: "Depreciation - Equipment",              debit: 9200.00,    credit: 0 },
  { code: "6320", name: "Depreciation - Furniture",              debit: 4400.00,    credit: 0 },
  { code: "6330", name: "Depreciation - Computers",              debit: 7600.00,    credit: 0 },
  { code: "6410", name: "Marketing and Advertising",             debit: 18000.00,   credit: 0 },
  { code: "6420", name: "Professional Fees (Legal + Accounting)", debit: 24000.00,  credit: 0 },
  { code: "6430", name: "Insurance",                             debit: 6000.00,    credit: 0 },
  { code: "6510", name: "Interest Expense - Term Loan",          debit: 4200.00,    credit: 0 },
  { code: "6610", name: "Income Tax Expense",                    debit: 24200.00,   credit: 0 },
];

async function main() {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Trial Balance");

  // Set column widths
  ws.columns = [
    { key: "code",   header: "Account Code",  width: 14 },
    { key: "name",   header: "Account Name",  width: 45 },
    { key: "debit",  header: "Debit (SGD)",   width: 18 },
    { key: "credit", header: "Credit (SGD)",  width: 18 },
  ];

  // Style the header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2C3E50" },
  };
  headerRow.alignment = { horizontal: "center" };

  // Add data rows
  let totalDebit = 0;
  let totalCredit = 0;

  for (const account of ACCOUNTS) {
    const row = ws.addRow({
      code: account.code,
      name: account.name,
      debit: account.debit,
      credit: account.credit,
    });

    // Format numeric cells with 2 decimal places and thousand separators
    row.getCell("debit").numFmt = "#,##0.00";
    row.getCell("credit").numFmt = "#,##0.00";
    row.alignment = { vertical: "middle" };

    totalDebit += account.debit;
    totalCredit += account.credit;
  }

  // Add totals row
  const totalRow = ws.addRow({
    code: "",
    name: "TOTAL",
    debit: totalDebit,
    credit: totalCredit,
  });
  totalRow.font = { bold: true };
  totalRow.getCell("debit").numFmt = "#,##0.00";
  totalRow.getCell("credit").numFmt = "#,##0.00";
  totalRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF0F0F0" },
  };

  // Add a validation note at the bottom
  const noteRow = ws.addRow(["", `Debits = Credits = SGD ${totalDebit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}`, "", ""]);
  noteRow.font = { italic: true, color: { argb: "FF888888" }, size: 9 };

  // Set borders on all data rows
  for (let i = 1; i <= ACCOUNTS.length + 2; i++) {
    const row = ws.getRow(i);
    for (let j = 1; j <= 4; j++) {
      row.getCell(j).border = {
        top: { style: "thin", color: { argb: "FFCCCCCC" } },
        left: { style: "thin", color: { argb: "FFCCCCCC" } },
        bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
        right: { style: "thin", color: { argb: "FFCCCCCC" } },
      };
    }
  }

  const outputPath = path.resolve(process.cwd(), "docs/samples/sample_trial_balance.xlsx");
  await workbook.xlsx.writeFile(outputPath);

  console.log(`Sample trial balance written to: ${outputPath}`);
  console.log(`Total Debit:  SGD ${totalDebit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}`);
  console.log(`Total Credit: SGD ${totalCredit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}`);
  console.log(`Balanced: ${Math.abs(totalDebit - totalCredit) < 0.01 ? "YES" : "NO"}`);
  console.log(`Rows: ${ACCOUNTS.length} accounts`);
}

main().catch(console.error);
