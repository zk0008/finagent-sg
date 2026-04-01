/**
 * lib/pdfGenerator.ts
 *
 * PDF generator for Singapore financial statements.
 *
 * What this module does:
 * Generates a single multi-page PDF containing all five financial statement
 * components, in the order required for ACRA filing:
 *   1. Balance Sheet (Statement of Financial Position)
 *   2. Profit & Loss (Statement of Comprehensive Income)
 *   3. Cash Flow Statement (Indirect Method)
 *   4. Statement of Changes in Equity
 *   5. Notes to Financial Statements
 *
 * PDF features:
 * - Company name and FYE on every page header
 * - Currency label (SGD) on every page
 * - Sequential page numbers in the footer
 * - All figures formatted to 2 decimal places with thousand separators
 * - Section dividers and consistent typography
 *
 * Uses pdfkit for PDF generation. pdfkit streams the PDF to a Buffer which
 * can then be sent as a file download or saved to cloud storage.
 *
 * Called by: app/api/generate-pdf/route.ts (wired in Task 9 via WorkflowPanel).
 */

import PDFDocument from "pdfkit";
import { type FSOutput, type Entity, type FiscalYear } from "./schemas";

// ── Layout constants ──────────────────────────────────────────────────────────
const PAGE_MARGIN = 60;
const PAGE_WIDTH = 595.28;   // A4 width in points
const PAGE_HEIGHT = 841.89;  // A4 height in points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const FOOTER_Y = PAGE_HEIGHT - PAGE_MARGIN / 2;

// Typography
const FONT_REGULAR = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_SIZE_TITLE = 14;
const FONT_SIZE_SECTION = 11;
const FONT_SIZE_BODY = 9;
const FONT_SIZE_FOOTER = 8;

// Colors
const COLOR_TEXT = "#1a1a1a";
const COLOR_HEADER = "#2c3e50";
const COLOR_RULE = "#cccccc";

/**
 * Generates a complete Singapore financial statements PDF as a Buffer.
 *
 * @param entity - The company entity (name, UEN, FYE)
 * @param fiscalYear - The fiscal year (start_date, end_date)
 * @param fsOutput - The generated FS components from fsGenerator.ts
 * @returns Promise<Buffer> — the complete PDF as a binary buffer
 */
export function generateFinancialStatementsPDF(
  entity: Entity,
  fiscalYear: FiscalYear,
  fsOutput: FSOutput
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Create a new PDFDocument (A4 portrait)
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: {
        Title: `Financial Statements — ${entity.name}`,
        Author: "FinAgent-SG",
        Subject: `Financial Statements for FYE ${fiscalYear.end_date}`,
        Keywords: "Singapore, SFRS, financial statements, ACRA",
      },
      autoFirstPage: false,
    });

    // Collect PDF chunks into a buffer
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let pageNumber = 0;

    // Helper: start a new page with the standard header
    function newPage(): void {
      pageNumber++;
      doc.addPage();
      renderPageHeader(doc, entity, fiscalYear, pageNumber);
    }

    // Helper: render a horizontal rule
    function rule(): void {
      const y = doc.y + 4;
      doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
        .strokeColor(COLOR_RULE).lineWidth(0.5).stroke();
      doc.y = y + 8;
    }

    // Helper: render a section heading
    function sectionTitle(title: string): void {
      doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_HEADER)
        .text(title, PAGE_MARGIN, doc.y);
      doc.moveDown(0.3);
      rule();
    }

    // Helper: render a key-value line (label left, amount right)
    function lineItem(label: string, amount: number | string, bold = false): void {
      const amtStr = typeof amount === "number" ? formatAmount(amount) : amount;
      doc.font(bold ? FONT_BOLD : FONT_REGULAR)
        .fontSize(FONT_SIZE_BODY)
        .fillColor(COLOR_TEXT);
      doc.text(label, PAGE_MARGIN, doc.y, { continued: true, width: CONTENT_WIDTH - 100 });
      doc.text(amtStr, { align: "right", width: 100 });
    }

    // Helper: render a subtotal line
    function subtotalLine(label: string, amount: number): void {
      rule();
      lineItem(label, amount, true);
      doc.moveDown(0.5);
    }

    // ── Cover / Title Page ─────────────────────────────────────────────────
    newPage();
    doc.moveDown(4);
    doc.font(FONT_BOLD).fontSize(16).fillColor(COLOR_HEADER).text(entity.name, PAGE_MARGIN, doc.y, {
      align: "center",
      width: CONTENT_WIDTH,
    });
    doc.moveDown(0.5);
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
      .text(`UEN: ${entity.uen}`, { align: "center" })
      .text("Financial Statements", { align: "center" })
      .text(`For the Financial Year Ended ${formatDate(fiscalYear.end_date)}`, { align: "center" })
      .text("Currency: SGD", { align: "center" });
    doc.moveDown(1);
    doc.font(FONT_REGULAR).fontSize(7).fillColor("#888888")
      .text("Prepared by FinAgent-SG", { align: "center" });

    // ── 1. Balance Sheet ───────────────────────────────────────────────────
    newPage();
    sectionTitle(`1. Balance Sheet (Statement of Financial Position)\nas at ${formatDate(fiscalYear.end_date)}`);

    const bs = fsOutput.balance_sheet as Record<string, unknown>;

    doc.moveDown(0.3);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("ASSETS", PAGE_MARGIN);
    doc.moveDown(0.2);

    renderLineItems(doc, bs.current_assets as LineItemEntry[], "Current Assets", PAGE_MARGIN);
    subtotalLine("Total Current Assets", Number(bs.total_current_assets ?? 0));

    renderLineItems(doc, bs.non_current_assets as LineItemEntry[], "Non-Current Assets", PAGE_MARGIN);
    subtotalLine("Total Non-Current Assets", Number(bs.total_non_current_assets ?? 0));
    subtotalLine("TOTAL ASSETS", Number(bs.total_assets ?? 0));

    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("LIABILITIES AND EQUITY", PAGE_MARGIN);
    doc.moveDown(0.2);

    renderLineItems(doc, bs.current_liabilities as LineItemEntry[], "Current Liabilities", PAGE_MARGIN);
    subtotalLine("Total Current Liabilities", Number(bs.total_current_liabilities ?? 0));

    renderLineItems(doc, bs.non_current_liabilities as LineItemEntry[], "Non-Current Liabilities", PAGE_MARGIN);
    subtotalLine("Total Non-Current Liabilities", Number(bs.total_non_current_liabilities ?? 0));
    subtotalLine("Total Liabilities", Number(bs.total_liabilities ?? 0));

    renderLineItems(doc, bs.equity as LineItemEntry[], "Equity", PAGE_MARGIN);
    subtotalLine("Total Equity", Number(bs.total_equity ?? 0));
    subtotalLine("TOTAL LIABILITIES AND EQUITY", Number(bs.total_liabilities_and_equity ?? 0));

    // ── 2. Profit & Loss ───────────────────────────────────────────────────
    newPage();
    const pl = fsOutput.profit_and_loss as Record<string, unknown>;
    sectionTitle(
      `2. Profit & Loss (Statement of Comprehensive Income)\n` +
      `For the year ended ${formatDate(fiscalYear.end_date)}`
    );

    renderLineItems(doc, pl.revenue_lines as LineItemEntry[], "Revenue", PAGE_MARGIN);
    subtotalLine("Total Revenue", Number(pl.total_revenue ?? 0));

    renderLineItems(doc, pl.expense_lines as LineItemEntry[], "Expenses", PAGE_MARGIN);
    subtotalLine("Total Expenses", Number(pl.total_expenses ?? 0));
    subtotalLine("NET PROFIT / (LOSS) FOR THE YEAR", Number(pl.net_profit ?? 0));

    // ── 3. Cash Flow Statement ─────────────────────────────────────────────
    newPage();
    const cf = fsOutput.cash_flow as Record<string, unknown>;
    sectionTitle(
      `3. Cash Flow Statement (Indirect Method)\n` +
      `For the year ended ${formatDate(fiscalYear.end_date)}`
    );

    const ops = cf.operating_activities as Record<string, unknown>;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("Operating Activities", PAGE_MARGIN);
    doc.moveDown(0.2);
    lineItem("Net Profit", Number(ops?.net_profit ?? 0));
    renderLineItems(doc, ops?.adjustments as LineItemEntry[], "Adjustments for non-cash items:", PAGE_MARGIN + 10);
    renderLineItems(doc, ops?.working_capital_changes as LineItemEntry[], "Changes in working capital:", PAGE_MARGIN + 10);
    subtotalLine("Net Cash from Operating Activities", Number(ops?.net_cash_from_operations ?? 0));

    const inv = cf.investing_activities as Record<string, unknown>;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("Investing Activities", PAGE_MARGIN);
    doc.moveDown(0.2);
    renderLineItems(doc, inv?.items as LineItemEntry[], "", PAGE_MARGIN + 10);
    subtotalLine("Net Cash from Investing Activities", Number(inv?.net_cash_from_investing ?? 0));

    const fin = cf.financing_activities as Record<string, unknown>;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("Financing Activities", PAGE_MARGIN);
    doc.moveDown(0.2);
    renderLineItems(doc, fin?.items as LineItemEntry[], "", PAGE_MARGIN + 10);
    subtotalLine("Net Cash from Financing Activities", Number(fin?.net_cash_from_financing ?? 0));

    rule();
    lineItem("Net Increase / (Decrease) in Cash", Number(cf.net_change_in_cash ?? 0));
    lineItem("Opening Cash Balance", Number(cf.opening_cash ?? 0));
    subtotalLine("Closing Cash Balance", Number(cf.closing_cash ?? 0));

    // ── 4. Statement of Changes in Equity ─────────────────────────────────
    newPage();
    const eq = fsOutput.equity_statement as Record<string, unknown>;
    sectionTitle(
      `4. Statement of Changes in Equity\n` +
      `For the year ended ${formatDate(fiscalYear.end_date)}`
    );

    const re = eq.retained_earnings as Record<string, unknown>;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("Retained Earnings", PAGE_MARGIN);
    doc.moveDown(0.2);
    lineItem("Opening balance", Number(re?.opening ?? 0));
    lineItem("Net profit for the year", Number(re?.net_profit ?? 0));
    lineItem("Dividends paid", -Math.abs(Number(re?.dividends ?? 0)));
    subtotalLine("Closing balance", Number(re?.closing ?? 0));

    const sc = eq.share_capital as Record<string, unknown>;
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).text("Share Capital", PAGE_MARGIN);
    doc.moveDown(0.2);
    lineItem("Opening balance", Number(sc?.opening ?? 0));
    lineItem("Shares issued during the year", Number(sc?.issued ?? 0));
    subtotalLine("Closing balance", Number(sc?.closing ?? 0));

    subtotalLine("TOTAL EQUITY", Number(eq.total_equity_closing ?? 0));

    // ── 5. Notes to Financial Statements ──────────────────────────────────
    for (const note of fsOutput.notes) {
      newPage();
      sectionTitle(`5. Notes to Financial Statements`);
      doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_HEADER).text(note.title);
      doc.moveDown(0.3);
      doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
        .text(note.content, { width: CONTENT_WIDTH, align: "justify" });
    }

    // Finalise the document — triggers the 'end' event which resolves the promise
    doc.end();
  });
}

// ── Layout helpers ─────────────────────────────────────────────────────────────

type LineItemEntry = { label: string; amount: number };

function renderLineItems(
  doc: PDFKit.PDFDocument,
  items: LineItemEntry[] | undefined,
  sectionLabel: string,
  indent: number
): void {
  if (!items || items.length === 0) return;
  // Filter out any null or undefined entries the AI may have injected into the array
  const safeItems = items.filter((item): item is LineItemEntry => item != null);
  if (safeItems.length === 0) return;
  if (sectionLabel) {
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY).fillColor("#555555")
      .text(sectionLabel, indent, doc.y);
    doc.moveDown(0.1);
  }
  for (const item of safeItems) {
    const amtStr = formatAmount(item.amount);
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
      .text(item.label, indent, doc.y, { continued: true, width: CONTENT_WIDTH - 100 - (indent - PAGE_MARGIN) })
      .text(amtStr, { align: "right", width: 100 });
  }
  doc.moveDown(0.2);
}

function renderPageHeader(
  doc: PDFKit.PDFDocument,
  entity: Entity,
  fiscalYear: FiscalYear,
  pageNumber: number
): void {
  // Company name and FYE at the top of every page
  doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY + 1).fillColor(COLOR_HEADER)
    .text(entity.name, PAGE_MARGIN, PAGE_MARGIN - 10, { continued: true, width: CONTENT_WIDTH - 80 })
    .font(FONT_REGULAR).fontSize(FONT_SIZE_FOOTER).fillColor("#888888")
    .text(`FYE: ${formatDate(fiscalYear.end_date)} | SGD`, { align: "right", width: 80 });

  // Horizontal rule below the header
  const ruleY = PAGE_MARGIN + 8;
  doc.moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_MARGIN + CONTENT_WIDTH, ruleY)
    .strokeColor(COLOR_RULE).lineWidth(0.5).stroke();

  // Page number in the footer — lineBreak: false prevents pdfkit from
  // auto-adding a blank page after writing at FOOTER_Y (which is past maxY).
  doc.font(FONT_REGULAR).fontSize(FONT_SIZE_FOOTER).fillColor("#aaaaaa")
    .text(`Page ${pageNumber}`, PAGE_MARGIN, FOOTER_Y, { align: "center", width: CONTENT_WIDTH, lineBreak: false });

  // Reset y position below the header rule
  doc.y = ruleY + 16;
}

/**
 * Formats a number as SGD with thousand separators and 2 decimal places.
 * Negative values are shown in parentheses per accounting convention.
 * Examples: 1234567.89 → "1,234,567.89"   -5000 → "(5,000.00)"
 */
function formatAmount(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `(${formatted})` : formatted;
}

/**
 * Formats a YYYY-MM-DD date as "31 December 2025" for use in PDF headers.
 */
function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" });
}
