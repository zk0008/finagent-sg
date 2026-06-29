/**
 * lib/deadlines.ts
 *
 * Compliance deadline calculator for Singapore private limited companies.
 * Computes due dates for CPF, ECI, Form C-S, and ACRA annual return filings
 * based on the client's financial year end and latest payroll month.
 *
 * All arithmetic uses plain Date — no external date library.
 */

export type CPFStatus     = "upcoming" | "overdue" | "completed";
export type DeadlineStatus = "upcoming" | "overdue";

export interface CPFDeadlineItem {
  label:  string;
  date:   string; // ISO YYYY-MM-DD
  status: CPFStatus;
}

export interface DeadlineItem {
  label:  string;
  date:   string; // ISO YYYY-MM-DD
  status: DeadlineStatus;
}

export interface ComplianceDeadlines {
  cpf:    CPFDeadlineItem;
  eci:    DeadlineItem;
  formCS: DeadlineItem;
  acra:   DeadlineItem;
}

// Returns a Date whose time is zeroed so comparisons are date-only.
function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Returns the last day of a calendar month.
// month is 1-based (1 = January, 12 = December).
// Trick: day 0 of month+1 (0-based: month) = last day of the target month.
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0);
}

// Formats a Date as "YYYY-MM-DD".
function toISO(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Computes the four Singapore compliance deadlines for a private limited company.
 *
 * @param fye_date           - Financial year end in "YYYY-MM-DD" format.
 * @param latestPayrollMonth - Optional most-recent payroll run month in "YYYY-MM-01" format.
 *                             If omitted, CPF deadline is shown as the 14th of next month.
 */
export function getComplianceDeadlines(
  fye_date: string,
  latestPayrollMonth?: string,
): ComplianceDeadlines {
  const now = todayMidnight();

  // ─── Parse FYE ────────────────────────────────────────────────────────────
  const [fyeYear, fyeMonth] = fye_date.split("-").map(Number);
  // fyeMonth is 1-based (e.g. 12 for December)

  // ─── CPF ──────────────────────────────────────────────────────────────────
  // CPF contributions must be submitted by the 14th of the month AFTER the pay month.
  // e.g. January 2026 payroll → CPF due 14 February 2026.
  //
  // latestPayrollMonth = "YYYY-MM-01" (1-based month from Supabase DATE column).
  // new Date(year, pmonth, 14): because pmonth is already 1-based, passing it directly
  // as the JS month arg (which is 0-based) shifts it to the next calendar month — exactly
  // what we want. e.g. pmonth=12 → new Date(2025, 12, 14) → 14 Jan 2026.
  let cpfDate: Date;
  if (latestPayrollMonth) {
    const [py, pm] = latestPayrollMonth.split("-").map(Number);
    cpfDate = new Date(py, pm, 14); // pm is 1-based → 0-based next month
  } else {
    // No payroll on record — show next expected CPF date as 14th of next month
    cpfDate = new Date(now.getFullYear(), now.getMonth() + 1, 14);
  }

  const cpfStatus: CPFStatus = cpfDate < now ? "overdue" : "upcoming";

  // ─── ECI ──────────────────────────────────────────────────────────────────
  // Estimated Chargeable Income must be filed within 3 months after FYE.
  // Deadline = last day of the month that is 3 months after the FYE month.
  // e.g. FYE 31 Dec 2025 → +3 months → March 2026 → last day = 31 Mar 2026.
  //
  // Convert fyeMonth to 0-based (subtract 1), add 3, then re-derive year and month.
  const eciTarget0 = (fyeMonth - 1) + 3;            // 0-based month index
  const eciYear    = fyeYear + Math.floor(eciTarget0 / 12);
  const eciMonth   = (eciTarget0 % 12) + 1;         // back to 1-based for lastDayOfMonth
  const eciDate    = lastDayOfMonth(eciYear, eciMonth);
  const eciStatus: DeadlineStatus = eciDate < now ? "overdue" : "upcoming";

  // ─── Form C-S ─────────────────────────────────────────────────────────────
  // Corporate tax return (Form C-S / C) is due 30 November of the Year of Assessment.
  // YA = the calendar year FOLLOWING the financial year end.
  // e.g. FYE 31 Dec 2025 → YA 2026 → deadline 30 Nov 2026.
  const ya          = fyeYear + 1;
  const formCSDate  = new Date(ya, 10, 30); // month 10 (0-based) = November
  const formCSStatus: DeadlineStatus = formCSDate < now ? "overdue" : "upcoming";

  // ─── ACRA Annual Return ────────────────────────────────────────────────────
  // Private limited companies must file the annual return within 5 months after FYE.
  // Deadline = last day of the month that is 5 months after the FYE month.
  // e.g. FYE 31 Dec 2025 → +5 months → May 2026 → last day = 31 May 2026.
  const acraTarget0 = (fyeMonth - 1) + 5;           // 0-based month index
  const acraYear    = fyeYear + Math.floor(acraTarget0 / 12);
  const acraMonth   = (acraTarget0 % 12) + 1;       // back to 1-based for lastDayOfMonth
  const acraDate    = lastDayOfMonth(acraYear, acraMonth);
  const acraStatus: DeadlineStatus = acraDate < now ? "overdue" : "upcoming";

  return {
    cpf: {
      label:  "CPF Submission",
      date:   toISO(cpfDate),
      status: cpfStatus,
    },
    eci: {
      label:  "ECI Filing",
      date:   toISO(eciDate),
      status: eciStatus,
    },
    formCS: {
      label:  "Form C-S Filing",
      date:   toISO(formCSDate),
      status: formCSStatus,
    },
    acra: {
      label:  "ACRA Annual Return",
      date:   toISO(acraDate),
      status: acraStatus,
    },
  };
}
