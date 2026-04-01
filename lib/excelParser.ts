/**
 * lib/excelParser.ts
 *
 * Excel trial balance parser for FinAgent-SG.
 *
 * What this module does:
 * Reads an uploaded Excel (.xlsx) file row by row using exceljs and extracts
 * trial balance data (account_code, account_name, debit, credit).
 *
 * Validation rules:
 * - Skips the header row (row 1) and any blank rows
 * - Rejects rows missing account_code or account_name
 * - All numeric values are parsed via bignumber.js — never native JS math
 * - Validates that total debits equal total credits within $0.01 tolerance
 * - Throws a descriptive error if the file is unreadable or the format is invalid
 *
 * Expected Excel column layout (row 1 = headers):
 *   A: account_code  B: account_name  C: debit  D: credit
 *
 * Called by: trigger/fsGenerationJob.ts (Task 6) in Step 1 of the pipeline.
 */

import ExcelJS from "exceljs";
import BigNumber from "bignumber.js";
import { TrialBalanceLineSchema, type TrialBalanceLine } from "./schemas";

// Tolerance for debit/credit balance check — $0.01 (one cent)
const BALANCE_TOLERANCE = new BigNumber("0.01");

/**
 * Parses a trial balance Excel file and returns validated line items.
 *
 * @param filePath - Absolute path to the .xlsx file on disk
 * @returns Array of TrialBalanceLine objects, one per data row
 * @throws Error if the file cannot be read, is missing required columns,
 *         contains invalid data, or debits ≠ credits
 */
export async function parseTrialBalance(filePath: string): Promise<TrialBalanceLine[]> {
  // Step 1: Load the workbook from disk.
  // exceljs reads the full file into memory. We use the first worksheet only.
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    throw new Error(`Failed to read Excel file at "${filePath}": ${(err as Error).message}`);
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Excel file contains no worksheets.");
  }

  const lines: TrialBalanceLine[] = [];
  // Running totals tracked as BigNumber — never native JS addition
  let totalDebits = new BigNumber(0);
  let totalCredits = new BigNumber(0);

  // Step 2: Iterate over rows. Row 1 is the header row — skip it.
  // exceljs uses 1-based row numbering.
  worksheet.eachRow((row, rowNumber) => {
    // Skip the header row
    if (rowNumber === 1) return;

    // Extract raw cell values from columns A, B, C, D
    const rawCode = row.getCell(1).value;
    const rawName = row.getCell(2).value;
    const rawDebit = row.getCell(3).value;
    const rawCredit = row.getCell(4).value;

    // Step 3: Skip entirely blank rows (all four cells empty).
    // This handles trailing empty rows that Excel sometimes appends.
    if (rawCode == null && rawName == null && rawDebit == null && rawCredit == null) {
      return;
    }

    // Step 4: Validate required text fields — account_code and account_name.
    // A row with a missing account_code is treated as a summary or footer row
    // (e.g. a TOTAL row, a note row) and skipped gracefully — not an error.
    // Only rows with both account_code AND account_name are treated as data rows.
    const accountCode = rawCode != null ? String(rawCode).trim() : "";
    const accountName = rawName != null ? String(rawName).trim() : "";

    if (!accountCode) {
      // Skip summary/footer rows silently (TOTAL rows, note rows, etc.)
      return;
    }
    if (!accountName) {
      throw new Error(`Row ${rowNumber}: account_name is missing or blank.`);
    }

    // Step 5: Parse numeric debit and credit values via BigNumber.
    // We never use parseFloat() or Number() for financial figures because
    // native JS floating-point arithmetic introduces rounding errors
    // (e.g. 0.1 + 0.2 === 0.30000000000000004). BigNumber is exact.
    const debit = parseNumericCell(rawDebit, rowNumber, "debit");
    const credit = parseNumericCell(rawCredit, rowNumber, "credit");

    // Step 6: Accumulate running totals using BigNumber addition.
    totalDebits = totalDebits.plus(debit);
    totalCredits = totalCredits.plus(credit);

    // Step 7: Validate the row shape via Zod before pushing.
    // BigNumber values are converted to plain JS numbers for the schema,
    // which stores numbers (not BigNumber objects) per TrialBalanceLineSchema.
    const parseResult = TrialBalanceLineSchema.safeParse({
      account_code: accountCode,
      account_name: accountName,
      debit: debit.toNumber(),
      credit: credit.toNumber(),
    });

    if (!parseResult.success) {
      throw new Error(
        `Row ${rowNumber}: invalid data — ${parseResult.error.issues.map((i) => i.message).join("; ")}`
      );
    }

    lines.push(parseResult.data);
  });

  // Step 8: Validate that the trial balance is in balance.
  // A correctly prepared trial balance always has total debits = total credits.
  // We allow a $0.01 tolerance to accommodate rounding in source systems.
  const difference = totalDebits.minus(totalCredits).abs();
  if (difference.isGreaterThan(BALANCE_TOLERANCE)) {
    throw new Error(
      `Trial balance is out of balance. ` +
      `Total debits: ${totalDebits.toFixed(2)}, ` +
      `Total credits: ${totalCredits.toFixed(2)}, ` +
      `Difference: ${difference.toFixed(2)}. ` +
      `Maximum allowed tolerance is $0.01.`
    );
  }

  if (lines.length === 0) {
    throw new Error("No data rows found in the Excel file. Check the file format.");
  }

  return lines;
}

/**
 * Parses a raw ExcelJS cell value into a BigNumber.
 *
 * ExcelJS returns cell values as number, string, null, or complex objects.
 * This helper normalises all cases into a BigNumber >= 0.
 *
 * @param value - Raw cell value from exceljs
 * @param rowNumber - Row number (for error messages)
 * @param fieldName - Field name ("debit" or "credit") for error messages
 * @returns BigNumber representation of the cell value
 */
function parseNumericCell(
  value: ExcelJS.CellValue,
  rowNumber: number,
  fieldName: string
): BigNumber {
  // Null or undefined → treat as zero (some cells are blank)
  if (value == null) return new BigNumber(0);

  // ExcelJS rich text objects have a .text property
  if (typeof value === "object" && "text" in value) {
    value = (value as { text: string }).text;
  }

  // Convert to string first, then construct BigNumber.
  // This avoids any intermediate float representation.
  const str = String(value).replace(/,/g, "").trim(); // strip thousand separators

  if (str === "" || str === "-") return new BigNumber(0);

  const bn = new BigNumber(str);
  if (bn.isNaN()) {
    throw new Error(
      `Row ${rowNumber}: "${fieldName}" value "${value}" is not a valid number.`
    );
  }
  if (bn.isNegative()) {
    throw new Error(
      `Row ${rowNumber}: "${fieldName}" value ${bn.toFixed(2)} is negative. ` +
      `Trial balance entries must be non-negative (use the opposite column for contra entries).`
    );
  }

  return bn;
}
