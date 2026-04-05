/**
 * lib/taxPdfGenerator.ts
 *
 * Tax Computation Schedule PDF generator — Phase 7.
 *
 * What this module does:
 * Generates a single-page (or multi-page if needed) PDF containing the full
 * Singapore corporate tax computation schedule for a given Year of Assessment.
 *
 * PDF sections:
 *   1. Header     — company name, UEN, YA, basis period, form type
 *   2. Tax Computation Schedule — accounting profit, add-backs, deductions
 *   3. Tax Exemption            — scheme applied, tier breakdowns
 *   4. Tax Calculation          — gross tax, CIT rebate, net tax payable
 *   5. Filing Deadlines         — ECI and form deadlines, IRAS filing note
 *
 * Uses pdfkit — same pattern as lib/pdfGenerator.ts.
 * Called by: app/api/tax/pdf/route.ts
 */

import PDFDocument from "pdfkit";
import type { TaxComputationResult } from "./schemas";

// ── Layout constants (matches pdfGenerator.ts conventions) ────────────────
const PAGE_MARGIN   = 60;
const PAGE_WIDTH    = 595.28;
const PAGE_HEIGHT   = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const FOOTER_Y      = PAGE_HEIGHT - PAGE_MARGIN / 2;

const FONT_REGULAR  = "Helvetica";
const FONT_BOLD     = "Helvetica-Bold";
const FONT_SIZE_TITLE   = 14;
const FONT_SIZE_SECTION = 11;
const FONT_SIZE_BODY    = 9;
const FONT_SIZE_FOOTER  = 8;

const COLOR_TEXT    = "#1a1a1a";
const COLOR_HEADER  = "#2c3e50";
const COLOR_RULE    = "#cccccc";
const COLOR_MUTED   = "#666666";

// Entity info passed to the PDF generator
export interface TaxPDFEntity {
  name: string;
  uen: string;
  fye_date: string;          // YYYY-MM-DD
  fiscal_year_start: string; // YYYY-MM-DD
}

/**
 * Generates a corporate tax computation schedule PDF as a Buffer.
 *
 * @param result  - The full TaxComputationResult from computeTax()
 * @param entity  - Company name, UEN, and fiscal year dates for the header
 * @returns Promise<Buffer> — the complete PDF as a binary buffer
 */
export function generateTaxComputationPDF(
  result: TaxComputationResult,
  entity: TaxPDFEntity
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: {
        Title: `Tax Computation — ${entity.name} — YA ${result.year_of_assessment}`,
        Author: "FinAgent-SG",
        Subject: `Corporate Income Tax Computation YA ${result.year_of_assessment}`,
        Keywords: "Singapore, IRAS, corporate tax, CIT, YA",
      },
      autoFirstPage: false,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.addPage();
    renderPage(doc, result, entity);
    doc.end();
  });
}

// ── Main page renderer ────────────────────────────────────────────────────

function renderPage(
  doc: InstanceType<typeof PDFDocument>,
  result: TaxComputationResult,
  entity: TaxPDFEntity
): void {

  // ── Helper: horizontal rule ──────────────────────────────────────────────
  function rule(thin = false): void {
    const y = doc.y + 4;
    doc.moveTo(PAGE_MARGIN, y)
       .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
       .strokeColor(COLOR_RULE)
       .lineWidth(thin ? 0.3 : 0.5)
       .stroke();
    doc.y = y + 8;
  }

  // ── Helper: section heading ──────────────────────────────────────────────
  function sectionTitle(title: string): void {
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_HEADER).text(title, PAGE_MARGIN);
    doc.moveDown(0.3);
    rule();
  }

  // ── Helper: two-column line (label + right-aligned amount) ───────────────
  function lineItem(label: string, amount: string, bold = false, indent = 0): void {
    doc.font(bold ? FONT_BOLD : FONT_REGULAR)
       .fontSize(FONT_SIZE_BODY)
       .fillColor(COLOR_TEXT);
    doc.text(
      label,
      PAGE_MARGIN + indent,
      doc.y,
      { continued: true, width: CONTENT_WIDTH - indent - 120 }
    );
    doc.text(amount, { align: "right", width: 120 });
  }

  // ── Helper: muted note text ───────────────────────────────────────────────
  function note(text: string): void {
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_FOOTER).fillColor(COLOR_MUTED)
       .text(text, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.3);
  }

  // ── Section 1: Header ─────────────────────────────────────────────────────
  // Company name and document title
  doc.font(FONT_BOLD).fontSize(FONT_SIZE_TITLE).fillColor(COLOR_HEADER)
     .text("CORPORATE INCOME TAX COMPUTATION SCHEDULE", PAGE_MARGIN, PAGE_MARGIN, {
       width: CONTENT_WIDTH, align: "center",
     });
  doc.moveDown(0.5);

  // Company details in a two-column grid
  const col1X = PAGE_MARGIN;
  const col2X = PAGE_MARGIN + CONTENT_WIDTH / 2;
  const startY = doc.y;

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
     .text("Company Name:", col1X, startY);
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY)
     .text(entity.name, col1X, doc.y);

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY)
     .text("UEN:", col2X, startY);
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY)
     .text(entity.uen, col2X, doc.y - FONT_SIZE_BODY - 2);

  doc.moveDown(0.4);
  const row2Y = doc.y;

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY)
     .text("Year of Assessment:", col1X, row2Y);
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY)
     .text(`YA ${result.year_of_assessment}`, col1X, doc.y);

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY)
     .text("Basis Period:", col2X, row2Y);
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY)
     .text(
       `${formatDisplayDate(entity.fiscal_year_start)} to ${formatDisplayDate(entity.fye_date)}`,
       col2X, row2Y + FONT_SIZE_BODY + 2
     );

  doc.moveDown(0.4);
  const row3Y = doc.y;

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY)
     .text("Filing Form:", col1X, row3Y);
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY)
     .text(result.form_type.replace("_", " "), col1X, doc.y);

  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY)
     .text("All amounts in SGD", col2X, row3Y);

  doc.moveDown(1);
  rule();

  // ── Section 2: Tax Computation Schedule ───────────────────────────────────
  sectionTitle("Tax Computation Schedule");

  lineItem("Accounting profit per financial statements", sgd(result.accounting_profit));
  doc.moveDown(0.3);

  // Add-backs — list each adjustment
  // (The result object does not carry individual line items; we show the total.
  //  The API route may pass the full adjustments list via an extended result object.)
  const extended = result as TaxComputationResult & {
    tax_adjustments?: Array<{ description: string; amount: string; type: string }>;
  };

  if (extended.tax_adjustments && extended.tax_adjustments.length > 0) {
    const addBacks   = extended.tax_adjustments.filter((a) => a.type === "add_back");
    const deductions = extended.tax_adjustments.filter((a) => a.type === "deduct");

    if (addBacks.length > 0) {
      doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
         .text("Add: Non-deductible expenses", PAGE_MARGIN, doc.y);
      doc.moveDown(0.2);
      for (const adj of addBacks) {
        lineItem(adj.description, sgd(adj.amount), false, 16);
        doc.moveDown(0.2);
      }
    }

    if (deductions.length > 0) {
      doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
         .text("Less: Non-taxable income", PAGE_MARGIN, doc.y);
      doc.moveDown(0.2);
      for (const adj of deductions) {
        lineItem(`(${adj.description})`, `(${sgd(adj.amount)})`, false, 16);
        doc.moveDown(0.2);
      }
    }
  } else {
    // Show totals only when individual items are not passed
    if (parseFloat(result.total_add_backs) > 0) {
      lineItem("Add: Non-deductible expenses", sgd(result.total_add_backs));
      doc.moveDown(0.2);
    }
    if (parseFloat(result.total_deductions) > 0) {
      lineItem("Less: Non-taxable income", `(${sgd(result.total_deductions)})`);
      doc.moveDown(0.2);
    }
  }

  rule(true);
  lineItem("Chargeable Income", sgd(result.chargeable_income), true);
  doc.moveDown(0.5);

  // ── Section 3: Tax Exemption ───────────────────────────────────────────────
  sectionTitle("Tax Exemption");

  const schemeLabel = result.exemption_scheme === "new_startup"
    ? "New Start-Up Company Exemption (First 3 YAs)"
    : "Partial Tax Exemption";
  note(`Exemption scheme applied: ${schemeLabel}`);

  if (result.exemption_scheme === "new_startup") {
    note("  Tier 1: 75% exempt on first $100,000 of chargeable income");
    note("  Tier 2: 50% exempt on next $100,000 of chargeable income");
  } else {
    note("  Tier 1: 75% exempt on first $10,000 of chargeable income");
    note("  Tier 2: 50% exempt on next $190,000 of chargeable income");
  }
  doc.moveDown(0.3);

  lineItem("Chargeable Income", sgd(result.chargeable_income));
  doc.moveDown(0.2);
  lineItem("Less: Tax Exemption", `(${sgd(result.exempt_amount)})`);
  doc.moveDown(0.2);
  rule(true);
  lineItem("Taxable Income after Exemption", sgd(result.taxable_income), true);
  doc.moveDown(0.5);

  // ── Section 4: Tax Calculation ─────────────────────────────────────────────
  sectionTitle("Tax Calculation");

  lineItem("Gross Tax at 17%", sgd(result.gross_tax));
  doc.moveDown(0.2);
  lineItem(
    `Less: CIT Rebate YA ${result.year_of_assessment} (40%, max $30,000)`,
    `(${sgd(result.cit_rebate)})`
  );
  doc.moveDown(0.2);
  if (parseFloat(result.cit_rebate_cash_grant) > 0) {
    lineItem("Less: CIT Rebate Cash Grant ($1,500)", `(${sgd(result.cit_rebate_cash_grant)})`);
    doc.moveDown(0.2);
  }
  rule(true);
  lineItem("Net Tax Payable", sgd(result.tax_payable), true);
  doc.moveDown(0.5);

  // ── Section 5: Filing Deadlines ────────────────────────────────────────────
  sectionTitle("Filing Deadlines");

  if (result.eci_filing_required) {
    lineItem("ECI Filing Deadline", result.eci_deadline);
  } else {
    lineItem("ECI Filing", "Exempt (revenue \u2264 $5M and ECI is nil)");
  }
  doc.moveDown(0.2);
  lineItem(`Form ${result.form_type.replace("_", " ")} Filing Deadline`, result.form_filing_deadline);
  doc.moveDown(0.6);

  note("Note: This computation is for reference only. File via mytax.iras.gov.sg using CorpPass.");

  // ── Footer ─────────────────────────────────────────────────────────────────
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_FOOTER).fillColor(COLOR_MUTED)
     .text(
       `Generated by FinAgent-SG  |  ${new Date().toLocaleDateString("en-SG")}`,
       PAGE_MARGIN,
       FOOTER_Y,
       { width: CONTENT_WIDTH, align: "center" }
     );
}

// ── Formatting helpers ────────────────────────────────────────────────────

/** Formats a numeric string as SGD with thousands separator and 2 decimal places */
function sgd(value: string): string {
  const n = parseFloat(value);
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Formats a YYYY-MM-DD date as "DD Mon YYYY" */
function formatDisplayDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" });
}
