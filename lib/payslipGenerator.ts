/**
 * lib/payslipGenerator.ts
 *
 * Payslip PDF generator for Singapore employees.
 *
 * What this module does:
 * Generates a single-page A4 PDF payslip for one employee per MOM (Ministry of
 * Manpower) guidelines. Called once per employee during a payroll run download.
 *
 * MOM required fields (per Employment Act):
 *   - Company name and UEN
 *   - Employee name and NRIC/FIN
 *   - Date of payment (last day of the payroll month)
 *   - Basic salary (ordinary wages)
 *   - Allowances — itemised
 *   - Deductions — itemised (employee CPF shown here)
 *   - Net pay
 *   - Employer CPF contribution — shown separately, labelled as not deducted from pay
 *   - SDL amount
 *
 * Uses the same pdfkit pattern as lib/pdfGenerator.ts:
 *   new PDFDocument → collect chunks → Promise<Buffer>
 *
 * Called by: app/api/payroll/payslip/route.ts
 */

import PDFDocument from "pdfkit";
import { type Employee, type Payslip } from "./schemas";

// ── Layout constants ──────────────────────────────────────────────────────────
const PAGE_MARGIN = 60;
const PAGE_WIDTH = 595.28;   // A4 width in points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Typography
const FONT_REGULAR = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_SIZE_TITLE = 14;
const FONT_SIZE_SECTION = 10;
const FONT_SIZE_BODY = 9;
const FONT_SIZE_SMALL = 8;

// Colors
const COLOR_TEXT = "#1a1a1a";
const COLOR_HEADER = "#2c3e50";
const COLOR_MUTED = "#666666";
const COLOR_RULE = "#cccccc";

// ── Entity shape (minimal — only what the payslip needs) ─────────────────────
type EntityForPayslip = {
  name: string;
  uen: string;
};

/**
 * Generates a single-page MOM-compliant payslip PDF for one employee.
 *
 * @param employee - The employee record (name, NRIC/FIN, citizenship)
 * @param payslip  - The computed payslip (wages, CPF, SDL, net pay, allowances, deductions)
 * @param entity   - Company info (name, UEN) for the payslip header
 * @param paymentDate - ISO date "YYYY-MM-DD" — the actual date of payment (last day of month)
 * @returns Promise<Buffer> — the complete payslip PDF as a binary buffer
 */
export function generatePayslip(
  employee: Employee,
  payslip: Payslip,
  entity: EntityForPayslip,
  paymentDate: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: `Payslip — ${employee.name}`,
        Author: "FinAgent-SG",
        Subject: `Payslip for ${formatDate(paymentDate)}`,
        Keywords: "Singapore, payslip, CPF, MOM",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header: Company name and UEN ─────────────────────────────────────────
    // The payslip header identifies the employer as required by MOM guidelines.
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_TITLE).fillColor(COLOR_HEADER)
      .text(entity.name, PAGE_MARGIN, PAGE_MARGIN, { width: CONTENT_WIDTH });
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_SMALL).fillColor(COLOR_MUTED)
      .text(`UEN: ${entity.uen}`, PAGE_MARGIN, doc.y);
    doc.moveDown(0.3);

    // Horizontal rule below header
    rule(doc);

    // ── Payslip title and date ───────────────────────────────────────────────
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_TEXT)
      .text("PAYSLIP", PAGE_MARGIN, doc.y);
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_BODY).fillColor(COLOR_MUTED)
      .text(`Date of Payment: ${formatDate(paymentDate)}`, PAGE_MARGIN, doc.y);
    doc.moveDown(0.5);

    // ── Employee details ─────────────────────────────────────────────────────
    // MOM requires employee name and identification number on every payslip.
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_HEADER)
      .text("EMPLOYEE DETAILS", PAGE_MARGIN, doc.y);
    doc.moveDown(0.2);
    twoColRow(doc, "Employee Name", employee.name);
    twoColRow(doc, "NRIC / FIN", employee.nric_fin ?? "—");
    doc.moveDown(0.5);

    // ── Earnings section ─────────────────────────────────────────────────────
    // Shows basic salary, then itemised allowances.
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_HEADER)
      .text("EARNINGS", PAGE_MARGIN, doc.y);
    doc.moveDown(0.2);
    twoColRow(doc, "Basic Salary (Ordinary Wages)", formatAmount(payslip.ordinary_wages));
    if (payslip.additional_wages > 0) {
      twoColRow(doc, "Additional Wages", formatAmount(payslip.additional_wages));
    }

    // Allowances — itemised as required by MOM
    const allowances = payslip.allowances ?? [];
    if (allowances.length > 0) {
      doc.font(FONT_REGULAR).fontSize(FONT_SIZE_SMALL).fillColor(COLOR_MUTED)
        .text("Allowances:", PAGE_MARGIN + 10, doc.y);
      doc.moveDown(0.1);
      for (const a of allowances) {
        twoColRow(doc, `  ${a.label}`, formatAmount(a.amount), false, PAGE_MARGIN + 10);
      }
    }

    // Gross earnings subtotal
    const allowanceTotal = (payslip.allowances ?? []).reduce((s, a) => s + a.amount, 0);
    const grossPay = payslip.ordinary_wages + payslip.additional_wages + allowanceTotal;
    doc.moveDown(0.2);
    rule(doc);
    twoColRow(doc, "Gross Pay", formatAmount(grossPay), true);
    doc.moveDown(0.5);

    // ── Deductions section ───────────────────────────────────────────────────
    // Employee CPF must appear here as a deduction.
    // Other deductions are itemised. (Employer CPF is shown separately below.)
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_HEADER)
      .text("DEDUCTIONS", PAGE_MARGIN, doc.y);
    doc.moveDown(0.2);
    twoColRow(doc, "Employee CPF Contribution", `(${formatAmount(payslip.employee_cpf)})`);

    // Other deductions — itemised
    const otherDeductions = payslip.deductions ?? [];
    for (const d of otherDeductions) {
      twoColRow(doc, d.label, `(${formatAmount(d.amount)})`);
    }

    const otherDeductionTotal = otherDeductions.reduce((s, d) => s + d.amount, 0);
    const totalDeductions = payslip.employee_cpf + otherDeductionTotal;
    doc.moveDown(0.2);
    rule(doc);
    twoColRow(doc, "Total Deductions", `(${formatAmount(totalDeductions)})`, true);
    doc.moveDown(0.5);

    // ── Net Pay ──────────────────────────────────────────────────────────────
    // Net pay = Gross pay − total deductions (employee CPF + other deductions)
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_HEADER)
      .text("NET PAY", PAGE_MARGIN, doc.y, { continued: true, width: CONTENT_WIDTH - 100 });
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_SECTION).fillColor(COLOR_HEADER)
      .text(formatAmount(payslip.net_pay), { align: "right", width: 100 });
    doc.moveDown(0.8);

    // ── Employer contributions (for information — not deducted from pay) ─────
    // MOM requires employer CPF to be shown on payslip but clearly labelled as
    // NOT a deduction from the employee's pay.
    rule(doc);
    doc.font(FONT_BOLD).fontSize(FONT_SIZE_BODY).fillColor(COLOR_HEADER)
      .text("FOR INFORMATION ONLY", PAGE_MARGIN, doc.y);
    doc.moveDown(0.2);
    twoColRow(doc, "Employer CPF Contribution (not deducted from pay)", formatAmount(payslip.employer_cpf));
    twoColRow(doc, "Skills Development Levy (SDL)", formatAmount(payslip.sdl));
    doc.moveDown(0.5);

    // ── Footer note ──────────────────────────────────────────────────────────
    rule(doc);
    doc.font(FONT_REGULAR).fontSize(FONT_SIZE_SMALL).fillColor(COLOR_MUTED)
      .text(
        "CPF contributions are computed in accordance with the CPF Act and rates effective " +
        "from 1 January 2026. SDL is payable to the Skills Development Fund.",
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );

    doc.end();
  });
}

// ── Layout helpers ─────────────────────────────────────────────────────────────

/**
 * Renders a horizontal rule (thin grey line).
 */
function rule(doc: PDFKit.PDFDocument): void {
  const y = doc.y + 4;
  doc.moveTo(PAGE_MARGIN, y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
    .strokeColor(COLOR_RULE)
    .lineWidth(0.5)
    .stroke();
  doc.y = y + 8;
}

/**
 * Renders a two-column row: label on the left, value right-aligned.
 * @param bold   - Whether the text should be bold
 * @param indent - Optional left indent offset from PAGE_MARGIN
 */
function twoColRow(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  bold = false,
  indent = PAGE_MARGIN
): void {
  const font = bold ? FONT_BOLD : FONT_REGULAR;
  const labelWidth = CONTENT_WIDTH - 120;
  doc.font(font).fontSize(FONT_SIZE_BODY).fillColor(COLOR_TEXT)
    .text(label, indent, doc.y, { continued: true, width: labelWidth })
    .text(value, { align: "right", width: 120 });
}

/**
 * Formats a number as SGD with thousand separators and 2 decimal places.
 * Does not add parentheses — callers wrap negative values as needed.
 */
function formatAmount(value: number): string {
  const abs = Math.abs(value);
  return abs.toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formats an ISO date "YYYY-MM-DD" as "31 December 2025".
 */
function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-SG", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
