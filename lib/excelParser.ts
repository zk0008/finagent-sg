/**
 * lib/excelParser.ts
 *
 * Trial balance parser for FinAgent-SG.
 *
 * What this module does:
 * Reads an uploaded trial balance file (.xlsx or .csv) and extracts
 * trial balance data (account_code, account_name, debit, credit).
 *
 * Supported formats:
 * - Excel (.xlsx / .xls): parsed via exceljs (unchanged from Phase 2)
 * - CSV (.csv): parsed via papaparse (added in A1)
 *
 * Validation rules (applied to both formats):
 * - Skips the header row and any blank rows
 * - Rejects rows missing account_code or account_name
 * - All numeric values are parsed via bignumber.js — never native JS math
 * - Validates that total debits equal total credits within $0.01 tolerance
 * - Throws a descriptive error if the file is unreadable or the format is invalid
 *
 * Expected column layout (header names for CSV; column positions A–D for Excel):
 *   account_code  |  account_name  |  debit  |  credit
 *
 * Called by: trigger/fsGenerationJob.ts (Task 6) and app/api/generate-fs/route.ts
 * in Step 1 of the pipeline.
 */

import ExcelJS from "exceljs";
import BigNumber from "bignumber.js";
import Papa from "papaparse";
import { readFileSync } from "fs";
import { TrialBalanceLineSchema, type TrialBalanceLine } from "./schemas";

// Tolerance for debit/credit balance check — $0.01 (one cent)
const BALANCE_TOLERANCE = new BigNumber("0.01");

/**
 * Parses a trial balance file (.xlsx or .csv) and returns validated line items.
 * Dispatches to the Excel parser or CSV parser based on the file extension.
 *
 * @param filePath - Absolute path to the .xlsx, .xls, or .csv file on disk
 * @returns Array of TrialBalanceLine objects, one per data row
 * @throws Error if the file cannot be read, is missing required columns,
 *         contains invalid data, or debits ≠ credits
 */
export async function parseTrialBalance(filePath: string): Promise<TrialBalanceLine[]> {
  // Dispatch to the CSV parser for .csv files; Excel parser for everything else.
  if (filePath.toLowerCase().endsWith(".csv")) {
    return parseTrialBalanceCSV(filePath);
  }
  return parseTrialBalanceExcel(filePath);
}

/**
 * Parses a trial balance Excel (.xlsx / .xls) file using exceljs.
 * This is the original Phase 2 implementation, extracted into a named function.
 *
 * @param filePath - Absolute path to the .xlsx or .xls file on disk
 */
async function parseTrialBalanceExcel(filePath: string): Promise<TrialBalanceLine[]> {
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
 * Parses a trial balance CSV file using papaparse.
 *
 * Expected CSV column headers (case-insensitive):
 *   account_code | account_name | debit | credit
 *
 * The header row is required. Columns may appear in any order as long as
 * the four required header names are present.
 *
 * Applies the same validation rules as the Excel parser:
 * - Skips blank rows
 * - Rejects rows missing account_code or account_name
 * - Parses numeric values via bignumber.js
 * - Validates debit = credit balance within $0.01 tolerance
 *
 * @param filePath - Absolute path to the .csv file on disk
 */
function parseTrialBalanceCSV(filePath: string): Promise<TrialBalanceLine[]> {
  return new Promise((resolve, reject) => {
    let csvContent: string;
    try {
      csvContent = readFileSync(filePath, "utf-8");
    } catch (err) {
      return reject(new Error(`Failed to read CSV file at "${filePath}": ${(err as Error).message}`));
    }

    const result = Papa.parse<Record<string, string>>(csvContent, {
      header: true,           // Use first row as field names
      skipEmptyLines: true,   // Skip blank rows automatically
      // Normalise headers to match the required field names regardless of how
      // the user named their columns. Steps:
      //   1. Strip UTF-8 BOM (present when Excel saves CSV)
      //   2. Lowercase and trim
      //   3. Drop any parenthetical suffix (e.g. " (SGD)", " (USD)")
      //   4. Replace runs of whitespace with underscores
      //   5. Strip any remaining non-alphanumeric characters
      // Examples: "Account Code" → "account_code"
      //           "Debit (SGD)"  → "debit"
      //           "Credit (SGD)" → "credit"
      transformHeader: (h) =>
        h
          .replace(/^\uFEFF/, "")       // strip UTF-8 BOM on first header
          .trim()
          .toLowerCase()
          .split(/\s*\(/)[0]            // drop " (SGD)" and anything after "("
          .trim()
          .replace(/\s+/g, "_")         // spaces → underscores
          .replace(/[^a-z0-9_]/g, ""),  // strip remaining non-alphanumeric chars
    });

    if (result.errors.length > 0) {
      const firstError = result.errors[0];
      return reject(new Error(`CSV parse error on row ${firstError.row ?? "unknown"}: ${firstError.message}`));
    }

    // Validate that all four required columns are present in the header
    const requiredHeaders = ["account_code", "account_name", "debit", "credit"];
    const actualHeaders = Object.keys(result.data[0] ?? {});
    for (const h of requiredHeaders) {
      if (!actualHeaders.includes(h)) {
        return reject(
          new Error(
            `CSV is missing required column "${h}". ` +
            `Expected headers: account_code, account_name, debit, credit.`
          )
        );
      }
    }

    const lines: TrialBalanceLine[] = [];
    let totalDebits = new BigNumber(0);
    let totalCredits = new BigNumber(0);

    for (let i = 0; i < result.data.length; i++) {
      const row = result.data[i];
      const rowNumber = i + 2; // +2 because row 1 is the header

      const accountCode = (row["account_code"] ?? "").trim();
      const accountName = (row["account_name"] ?? "").trim();

      // Skip rows where account_code is blank (summary/footer rows)
      if (!accountCode) continue;

      if (!accountName) {
        return reject(new Error(`Row ${rowNumber}: account_name is missing or blank.`));
      }

      const debit = parseNumericString(row["debit"] ?? "", rowNumber, "debit");
      if (debit instanceof Error) return reject(debit);

      const credit = parseNumericString(row["credit"] ?? "", rowNumber, "credit");
      if (credit instanceof Error) return reject(credit);

      totalDebits = totalDebits.plus(debit);
      totalCredits = totalCredits.plus(credit);

      const parseResult = TrialBalanceLineSchema.safeParse({
        account_code: accountCode,
        account_name: accountName,
        debit: debit.toNumber(),
        credit: credit.toNumber(),
      });

      if (!parseResult.success) {
        return reject(
          new Error(
            `Row ${rowNumber}: invalid data — ${parseResult.error.issues.map((i) => i.message).join("; ")}`
          )
        );
      }

      lines.push(parseResult.data);
    }

    // Validate that the trial balance is in balance
    const difference = totalDebits.minus(totalCredits).abs();
    if (difference.isGreaterThan(BALANCE_TOLERANCE)) {
      return reject(
        new Error(
          `Trial balance is out of balance. ` +
          `Total debits: ${totalDebits.toFixed(2)}, ` +
          `Total credits: ${totalCredits.toFixed(2)}, ` +
          `Difference: ${difference.toFixed(2)}. ` +
          `Maximum allowed tolerance is $0.01.`
        )
      );
    }

    if (lines.length === 0) {
      return reject(new Error("No data rows found in the CSV file. Check the file format."));
    }

    resolve(lines);
  });
}

/**
 * Parses a CSV cell string value into a BigNumber.
 * Returns an Error object (not thrown) if the value is invalid, so the
 * Promise-based caller can reject cleanly.
 */
function parseNumericString(value: string, rowNumber: number, fieldName: string): BigNumber | Error {
  const str = value.replace(/,/g, "").trim(); // strip thousand separators
  if (str === "" || str === "-") return new BigNumber(0);

  const bn = new BigNumber(str);
  if (bn.isNaN()) {
    return new Error(`Row ${rowNumber}: "${fieldName}" value "${value}" is not a valid number.`);
  }
  if (bn.isNegative()) {
    return new Error(
      `Row ${rowNumber}: "${fieldName}" value ${bn.toFixed(2)} is negative. ` +
      `Trial balance entries must be non-negative (use the opposite column for contra entries).`
    );
  }
  return bn;
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
