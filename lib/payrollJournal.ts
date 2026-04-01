/**
 * lib/payrollJournal.ts
 *
 * Payroll journal entry generator for Singapore double-entry bookkeeping.
 *
 * What this module does:
 * Generates the standard double-entry journal entries for a monthly payroll run.
 * All arithmetic uses bignumber.js. No AI is involved — pure deterministic logic.
 *
 * The five journal entries generated follow standard Singapore payroll accounting:
 *
 *   Entry 1 — Gross salary expense
 *     DR Staff Salaries Expense    (P&L expense — increases with debit)
 *     CR Salaries Payable          (liability — company owes employees gross salary)
 *     Why: Records the total payroll cost to the company before CPF and deductions.
 *
 *   Entry 2 — Employee CPF deduction
 *     DR Salaries Payable          (reduces the salary liability — employee CPF is deducted)
 *     CR CPF Payable               (liability — company holds employee CPF until remittance)
 *     Why: Employee CPF is withheld from gross pay; the company is now a custodian of
 *          those funds until they are remitted to CPF Board.
 *
 *   Entry 3 — Employer CPF contribution
 *     DR CPF Contributions Expense (P&L expense — employer's CPF cost)
 *     CR CPF Payable               (liability — employer CPF also owed to CPF Board)
 *     Why: Employer CPF is an additional cost on top of salary; it never passes through
 *          the employee's pay.
 *
 *   Entry 4 — SDL expense
 *     DR SDL Expense               (P&L expense — Skills Development Levy)
 *     CR SDL Payable               (liability — SDL owed to SkillsFuture Singapore)
 *     Why: SDL is a separate levy on total wages payable to SkillsFuture Singapore
 *          (not CPF Board) by the 14th of the following month.
 *
 *   Entry 5 — Net pay settlement
 *     DR Salaries Payable          (clears the remaining salary liability after CPF deduction)
 *     CR Bank Account              (cash outflow — net pay transferred to employees)
 *     Why: Salaries Payable should be zero after entries 1+2 net pay is settled.
 *          Debit amount = gross salary − employee CPF (= net pay before other deductions).
 *
 * Called by: app/api/payroll/journal/route.ts
 */

import BigNumber from "bignumber.js";
import { type Payslip, type Employee, type JournalEntry } from "./schemas";

/**
 * Generates the five standard payroll journal entries for a monthly payroll run.
 *
 * Aggregates all payslips in the run into five combined journal entries
 * (one entry per journal type, not one per employee) for clean general ledger posting.
 *
 * @param payslips  - All payslips for the payroll run
 * @param employees - Employee records (used for name lookups in descriptions)
 * @param journalDate - ISO date "YYYY-MM-DD" — the date of the journal entries
 *                      (typically the last day of the payroll month)
 * @returns Array of JournalEntry — five entries covering the full payroll cycle
 */
export function generatePayrollJournalEntries(
  payslips: Payslip[],
  employees: Employee[],
  journalDate: string
): JournalEntry[] {
  // ── Aggregate totals across all payslips ─────────────────────────────────
  let totalGrossPay = new BigNumber("0");
  let totalEmployeeCPF = new BigNumber("0");
  let totalEmployerCPF = new BigNumber("0");
  let totalSDL = new BigNumber("0");

  for (const slip of payslips) {
    // Gross pay = ordinary wages + additional wages + allowances
    const allowanceTotal = (slip.allowances ?? []).reduce(
      (sum, a) => sum.plus(new BigNumber(a.amount.toString())),
      new BigNumber("0")
    );
    const gross = new BigNumber(slip.ordinary_wages.toString())
      .plus(new BigNumber(slip.additional_wages.toString()))
      .plus(allowanceTotal);

    totalGrossPay = totalGrossPay.plus(gross);
    totalEmployeeCPF = totalEmployeeCPF.plus(new BigNumber(slip.employee_cpf.toString()));
    totalEmployerCPF = totalEmployerCPF.plus(new BigNumber(slip.employer_cpf.toString()));
    totalSDL = totalSDL.plus(new BigNumber(slip.sdl.toString()));
  }

  // Net pay for settlement = gross pay − employee CPF
  // (other deductions are already reflected in net_pay on the payslip;
  //  the journal entry clears the salary payable liability net of employee CPF)
  const totalNetPaySettlement = totalGrossPay.minus(totalEmployeeCPF);

  const employeeCount = payslips.length;
  const empLabel = employeeCount === 1 ? "1 employee" : `${employeeCount} employees`;

  const entries: JournalEntry[] = [];

  // ── Entry 1: Gross salary expense ────────────────────────────────────────
  // DR Staff Salaries Expense / CR Salaries Payable
  // Records the total gross payroll cost for the period.
  entries.push({
    date: journalDate,
    description: `Monthly payroll — gross salary expense (${empLabel})`,
    debit_account: "Staff Salaries Expense",
    credit_account: "Salaries Payable",
    amount: totalGrossPay.toFixed(2),
  });

  // ── Entry 2: Employee CPF deduction ─────────────────────────────────────
  // DR Salaries Payable / CR CPF Payable
  // Reclassifies the employee CPF portion of gross pay into a CPF liability.
  // The employer is now custodian of employee CPF funds until remittance.
  entries.push({
    date: journalDate,
    description: `Monthly payroll — employee CPF deduction withheld (${empLabel})`,
    debit_account: "Salaries Payable",
    credit_account: "CPF Payable",
    amount: totalEmployeeCPF.toFixed(2),
  });

  // ── Entry 3: Employer CPF contribution ──────────────────────────────────
  // DR CPF Contributions Expense / CR CPF Payable
  // Records the employer's CPF cost — a separate P&L expense that does not
  // pass through the employee's pay at all.
  entries.push({
    date: journalDate,
    description: `Monthly payroll — employer CPF contribution (${empLabel})`,
    debit_account: "CPF Contributions Expense",
    credit_account: "CPF Payable",
    amount: totalEmployerCPF.toFixed(2),
  });

  // ── Entry 4: SDL expense ──────────────────────────────────────────────────
  // DR SDL Expense / CR SDL Payable
  // SDL is a mandatory levy payable to SkillsFuture Singapore (not CPF Board).
  // It applies to all employees including foreigners; due by 14th of following month.
  entries.push({
    date: journalDate,
    description: `Monthly payroll — Skills Development Levy (SDL) (${empLabel})`,
    debit_account: "SDL Expense",
    credit_account: "SDL Payable",
    amount: totalSDL.toFixed(2),
  });

  // ── Entry 5: Net pay settlement ───────────────────────────────────────────
  // DR Salaries Payable / CR Bank Account
  // Clears the remaining salary liability after employee CPF has been reclassified.
  // After entries 1 and 2, Salaries Payable balance = gross salary − employee CPF
  // = net pay (ignoring non-CPF deductions which reduce net_pay but not this entry).
  entries.push({
    date: journalDate,
    description: `Monthly payroll — net pay transferred to employees (${empLabel})`,
    debit_account: "Salaries Payable",
    credit_account: "Bank Account",
    amount: totalNetPaySettlement.toFixed(2),
  });

  return entries;
}

/**
 * Returns the last day of the month for a given first-day-of-month date string.
 * Used by the API route to compute the journal entry date from the run_month.
 *
 * @param firstDayOfMonth - ISO date "YYYY-MM-DD" (first day of the payroll month)
 * @returns ISO date string of the last day of that month e.g. "2025-12-31"
 */
export function getLastDayOfMonth(firstDayOfMonth: string): string {
  const [year, month] = firstDayOfMonth.split("-").map(Number);
  // Day 0 of the following month = last day of this month
  const lastDay = new Date(year, month, 0);
  const y = lastDay.getFullYear();
  const m = String(lastDay.getMonth() + 1).padStart(2, "0");
  const d = String(lastDay.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
