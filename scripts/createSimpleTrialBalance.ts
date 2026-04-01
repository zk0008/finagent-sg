/**
 * scripts/createSimpleTrialBalance.ts
 *
 * Creates a simple 20-account trial balance Excel file for quick smoke testing.
 * Run: npx tsx scripts/createSimpleTrialBalance.ts
 *
 * Output: docs/samples/sample_trial_balance_simple.xlsx
 *
 * Represents a minimal Singapore IT consulting Pte Ltd for FYE 31 December 2025.
 * Debits = Credits = SGD 380,000.00
 * Net profit = SGD 38,000 (Revenue 240,000 − Expenses 202,000)
 * 20 accounts covering assets, liabilities, equity, revenue, and expenses.
 */

import ExcelJS from "exceljs";
import path from "path";

const ACCOUNTS = [
  // ── Assets (debit-normal) ─────────────────────────────────────────────────
  { code: "1010", name: "Cash at Bank - DBS Current Account",      debit: 95000.00,  credit: 0        },
  { code: "1110", name: "Trade Receivables",                       debit: 45000.00,  credit: 0        },
  { code: "1200", name: "Prepayments",                             debit:  8000.00,  credit: 0        },
  { code: "2010", name: "Office Equipment (at cost)",              debit: 30000.00,  credit: 0        },
  { code: "2011", name: "Accumulated Depreciation - Equipment",    debit:     0,     credit: 9000.00  },
  // ── Liabilities (credit-normal) ───────────────────────────────────────────
  { code: "3010", name: "Trade Payables",                          debit:     0,     credit: 22000.00 },
  { code: "3020", name: "Accrued Expenses",                        debit:     0,     credit:  8500.00 },
  { code: "3050", name: "CPF Payable",                             debit:     0,     credit:  3500.00 },
  { code: "3040", name: "Income Tax Payable",                      debit:     0,     credit: 12000.00 },
  // ── Equity (credit-normal) ────────────────────────────────────────────────
  { code: "4010", name: "Share Capital (Ordinary Shares)",         debit:     0,     credit: 50000.00 },
  { code: "4020", name: "Retained Earnings (Opening Balance)",     debit:     0,     credit: 35000.00 },
  // ── Revenue (credit-normal) ───────────────────────────────────────────────
  { code: "5010", name: "Revenue - IT Consulting Services",        debit:     0,     credit: 180000.00 },
  { code: "5020", name: "Revenue - IT Support & Maintenance",      debit:     0,     credit: 60000.00  },
  // ── Expenses (debit-normal) ───────────────────────────────────────────────
  { code: "6010", name: "Staff Salaries and Wages",                debit: 120000.00, credit: 0         },
  { code: "6020", name: "CPF Contributions - Employer",            debit:  20400.00, credit: 0         },
  { code: "6110", name: "Office Rental",                           debit:  24000.00, credit: 0         },
  { code: "6120", name: "Utilities and Telecommunication",         debit:   6000.00, credit: 0         },
  { code: "6420", name: "Professional Fees (Legal & Accounting)",  debit:  12000.00, credit: 0         },
  { code: "6310", name: "Depreciation - Office Equipment",         debit:   7600.00, credit: 0         },
  { code: "6610", name: "Income Tax Expense",                      debit:  12000.00, credit: 0         },
];

async function main() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FinAgent-SG";
  workbook.lastModifiedBy = "FinAgent-SG";
  workbook.created = new Date("2025-12-31");

  const ws = workbook.addWorksheet("Trial Balance");

  ws.columns = [
    { key: "code",   header: "Account Code", width: 14 },
    { key: "name",   header: "Account Name", width: 46 },
    { key: "debit",  header: "Debit (SGD)",  width: 18 },
    { key: "credit", header: "Credit (SGD)", width: 18 },
  ];

  // Header row styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C3E50" } };
  headerRow.alignment = { horizontal: "center" };
  headerRow.height = 18;

  let totalDebit = 0;
  let totalCredit = 0;

  for (const account of ACCOUNTS) {
    const row = ws.addRow({
      code:   account.code,
      name:   account.name,
      debit:  account.debit,
      credit: account.credit,
    });
    row.getCell("debit").numFmt  = "#,##0.00";
    row.getCell("credit").numFmt = "#,##0.00";
    row.getCell("debit").alignment  = { horizontal: "right" };
    row.getCell("credit").alignment = { horizontal: "right" };
    totalDebit  += account.debit;
    totalCredit += account.credit;
  }

  // Totals row
  const totalRow = ws.addRow({
    code:   "",
    name:   "TOTAL",
    debit:  totalDebit,
    credit: totalCredit,
  });
  totalRow.font = { bold: true };
  totalRow.getCell("debit").numFmt  = "#,##0.00";
  totalRow.getCell("credit").numFmt = "#,##0.00";
  totalRow.getCell("debit").alignment  = { horizontal: "right" };
  totalRow.getCell("credit").alignment = { horizontal: "right" };
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F0F0" } };

  // Balance note
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  const noteRow = ws.addRow([
    "",
    `Debits = Credits = SGD ${totalDebit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}  |  ${balanced ? "BALANCED ✓" : "NOT BALANCED ✗"}`,
    "", "",
  ]);
  noteRow.font = { italic: true, color: { argb: "FF888888" }, size: 9 };

  // Borders on all rows including header
  for (let i = 1; i <= ACCOUNTS.length + 2; i++) {
    for (let j = 1; j <= 4; j++) {
      ws.getRow(i).getCell(j).border = {
        top:    { style: "thin", color: { argb: "FFCCCCCC" } },
        left:   { style: "thin", color: { argb: "FFCCCCCC" } },
        bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
        right:  { style: "thin", color: { argb: "FFCCCCCC" } },
      };
    }
  }

  const outputPath = path.resolve(process.cwd(), "docs/samples/sample_trial_balance_simple.xlsx");
  await workbook.xlsx.writeFile(outputPath);

  console.log(`Written to: ${outputPath}`);
  console.log(`Accounts:     ${ACCOUNTS.length}`);
  console.log(`Total Debit:  SGD ${totalDebit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}`);
  console.log(`Total Credit: SGD ${totalCredit.toLocaleString("en-SG", { minimumFractionDigits: 2 })}`);
  console.log(`Balanced:     ${balanced ? "YES" : "NO"}`);
}

main().catch(console.error);
