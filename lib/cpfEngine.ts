/**
 * lib/cpfEngine.ts
 *
 * Pure-arithmetic CPF computation engine for Singapore payroll.
 *
 * What this module does:
 * Computes CPF contributions, SDL, and net pay for Singapore employees.
 * All arithmetic uses bignumber.js — no native JS math for any financial calculation.
 * No AI is involved — this is deterministic computation only.
 *
 * Rate source: skills/sg-payroll-cpf/SKILL.md
 * Rates effective from 1 January 2026 (cpf.gov.sg).
 *
 * Functions exported:
 * - getAgeAtDate()    — age in years at last birthday on a reference date
 * - getCPFRates()     — employer/employee/total rates for a citizenship + age combination
 * - computeCPF()      — full CPF computation for one employee for one month
 * - computePayroll()  — runs computeCPF() for an array of employees
 */

import BigNumber from "bignumber.js";
import { type CPFComputationInput, type CPFComputationResult } from "./schemas";

// ── BigNumber configuration ───────────────────────────────────────────────────
// ROUND_DOWN = 1, ROUND_HALF_UP = 4 — used explicitly per CPF rounding rules
BigNumber.config({ DECIMAL_PLACES: 10, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

// ── Wage ceiling constants (from skills/sg-payroll-cpf/SKILL.md) ──────────────
const OW_CEILING = new BigNumber("8000");          // Monthly OW ceiling for CPF
const ANNUAL_SALARY_CEILING = new BigNumber("102000"); // Annual ceiling for OW + AW
const SDL_RATE = new BigNumber("0.0025");           // 0.25% of total wages
const SDL_MIN = new BigNumber("2");                 // $2 minimum SDL
const SDL_MAX = new BigNumber("11.25");             // $11.25 maximum SDL
const SDL_WAGE_CAP = new BigNumber("4500");         // SDL capped on wages up to $4,500

// ── Wage band thresholds ─────────────────────────────────────────────────────
const BAND_NO_CONTRIBUTION = new BigNumber("50");   // <= $50: no CPF
const BAND_EMPLOYER_ONLY = new BigNumber("500");    // > $50 to $500: employer only
const BAND_PHASEDIN = new BigNumber("750");         // > $500 to $750: phased-in
// > $750: full rates

// ── CPF rate types ────────────────────────────────────────────────────────────

export type CitizenshipType = "SC" | "SPR_1" | "SPR_2" | "SPR_3" | "foreigner";

/**
 * Raw CPF rates (as decimal fractions) for a given age + citizenship.
 * These are the full rates applicable when wages > $750.
 * For phased-in wages ($500–$750), the engine applies the phased-in formula.
 */
export type CPFRates = {
  employerRate: BigNumber;   // Fraction e.g. 0.17
  employeeRate: BigNumber;   // Fraction e.g. 0.20
  totalRate: BigNumber;      // Fraction e.g. 0.37
};

// ── Rate tables ───────────────────────────────────────────────────────────────

/**
 * Table 1 — SC and SPR 3rd year onwards.
 * Effective from 1 January 2026.
 * Source: skills/sg-payroll-cpf/SKILL.md, Table 1.
 */
function getTable1Rates(age: number): CPFRates {
  if (age <= 55) {
    return { employerRate: new BigNumber("0.17"), employeeRate: new BigNumber("0.20"), totalRate: new BigNumber("0.37") };
  } else if (age <= 60) {
    return { employerRate: new BigNumber("0.16"), employeeRate: new BigNumber("0.18"), totalRate: new BigNumber("0.34") };
  } else if (age <= 65) {
    return { employerRate: new BigNumber("0.125"), employeeRate: new BigNumber("0.125"), totalRate: new BigNumber("0.25") };
  } else if (age <= 70) {
    return { employerRate: new BigNumber("0.09"), employeeRate: new BigNumber("0.075"), totalRate: new BigNumber("0.165") };
  } else {
    return { employerRate: new BigNumber("0.075"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.125") };
  }
}

/**
 * Table 2 — SPR 1st year (Graduated G/G rates).
 * Effective from 1 January 2026.
 * Source: skills/sg-payroll-cpf/SKILL.md, Table 2.
 */
function getTable2Rates(age: number): CPFRates {
  if (age <= 55) {
    return { employerRate: new BigNumber("0.04"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.09") };
  } else if (age <= 60) {
    return { employerRate: new BigNumber("0.04"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.09") };
  } else if (age <= 65) {
    return { employerRate: new BigNumber("0.035"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.085") };
  } else {
    // Above 65 — same as Above 60–65 bracket per Table 2
    return { employerRate: new BigNumber("0.035"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.085") };
  }
}

/**
 * Table 3 — SPR 2nd year (Graduated G/G rates).
 * Effective from 1 January 2026.
 * Source: skills/sg-payroll-cpf/SKILL.md, Table 3.
 */
function getTable3Rates(age: number): CPFRates {
  if (age <= 55) {
    return { employerRate: new BigNumber("0.09"), employeeRate: new BigNumber("0.15"), totalRate: new BigNumber("0.24") };
  } else if (age <= 60) {
    return { employerRate: new BigNumber("0.06"), employeeRate: new BigNumber("0.125"), totalRate: new BigNumber("0.185") };
  } else if (age <= 65) {
    return { employerRate: new BigNumber("0.035"), employeeRate: new BigNumber("0.075"), totalRate: new BigNumber("0.11") };
  } else {
    return { employerRate: new BigNumber("0.035"), employeeRate: new BigNumber("0.05"), totalRate: new BigNumber("0.085") };
  }
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Computes the age in whole years at the last birthday on or before referenceDate.
 * "Age at last birthday" is the correct interpretation for CPF rate tier determination.
 *
 * @param dob           - Date of birth as ISO string "YYYY-MM-DD"
 * @param referenceDate - The contribution month's reference date as ISO string "YYYY-MM-DD"
 * @returns Age in whole years (integer)
 */
export function getAgeAtDate(dob: string, referenceDate: string): number {
  const birth = new Date(dob + "T00:00:00");
  const ref = new Date(referenceDate + "T00:00:00");

  let age = ref.getFullYear() - birth.getFullYear();

  // If this year's birthday has not yet occurred, subtract 1
  const hasBirthdayOccurred =
    ref.getMonth() > birth.getMonth() ||
    (ref.getMonth() === birth.getMonth() && ref.getDate() >= birth.getDate());

  if (!hasBirthdayOccurred) {
    age -= 1;
  }

  return age;
}

/**
 * Returns the full CPF rates for a given age and citizenship type.
 * These are the rates applicable when wages > $750.
 * For the phased-in band ($500–$750) and lower bands, computeCPF() applies
 * the appropriate adjustments on top of these rates.
 *
 * Foreigners return all-zero rates (SDL is handled separately in computeCPF).
 *
 * @param age         - Employee age at last birthday in the contribution month
 * @param citizenship - CPF citizenship type: SC, SPR_1, SPR_2, SPR_3, or foreigner
 * @returns CPFRates with employer, employee, and total rates as BigNumbers
 */
export function getCPFRates(age: number, citizenship: CitizenshipType): CPFRates {
  const zero = new BigNumber("0");
  switch (citizenship) {
    case "SC":
    case "SPR_3":
      return getTable1Rates(age);
    case "SPR_1":
      return getTable2Rates(age);
    case "SPR_2":
      return getTable3Rates(age);
    case "foreigner":
      return { employerRate: zero, employeeRate: zero, totalRate: zero };
  }
}

/**
 * Computes CPF contributions, SDL, and net pay for one employee for one month.
 *
 * Implements the following rules from skills/sg-payroll-cpf/SKILL.md:
 *
 * Wage ceilings:
 *   OW subject to CPF = min(OW, $8,000)
 *   AW ceiling = max(0, $102,000 − ytd_ow)
 *   AW subject to CPF = min(AW, AW ceiling)
 *
 * Wage band rules (applied independently to OW and AW):
 *   <= $50:          No CPF
 *   > $50 to $500:   Employer only; employee = 0
 *   > $500 to $750:  Phased-in: total = employer_rate×TW + factor×(TW−500); employee = factor×(TW−500)
 *                    where factor = employee_rate × 3 (derived from continuity at $750)
 *   > $750:          Full rates apply
 *
 * Rounding (CPF official rules — must be applied in this exact order):
 *   1. Total CPF = sum of OW and AW raw totals → round to nearest dollar (up if ≥ 50c, down if < 50c)
 *   2. Employee CPF = sum of OW and AW raw employee shares → round DOWN to nearest dollar
 *   3. Employer CPF = Total (rounded) − Employee (rounded down)
 *
 * SDL:
 *   0.25% of total wages (OW + AW, no CPF ceiling), min $2, max $11.25 (capped at $4,500 wages)
 *
 * Net pay:
 *   OW + AW + sum(allowances) − employee_cpf − sum(deductions)
 *   (employer_cpf is a separate cost, not deducted from employee pay)
 *
 * @param input   - CPFComputationInput with wages as strings for bignumber.js
 * @param referenceDate - First day of the payroll month "YYYY-MM-DD" (used for age computation)
 * @param allowances    - Optional itemised allowances [{label, amount}]
 * @param deductions    - Optional non-CPF deductions [{label, amount}]
 * @returns CPFComputationResult with all amounts as strings (bignumber.js precision)
 */
export function computeCPF(
  input: CPFComputationInput,
  referenceDate: string,
  allowances: Array<{ label: string; amount: number }> = [],
  deductions: Array<{ label: string; amount: number }> = []
): CPFComputationResult {
  const { employee_id, citizenship, dob, ordinary_wages, additional_wages } = input;
  const ytdOW = new BigNumber(input.ytd_ow ?? "0");

  const age = getAgeAtDate(dob, referenceDate);
  const rates = getCPFRates(age, citizenship as CitizenshipType);

  // ── Step 1: Apply OW ceiling ─────────────────────────────────────────────
  const rawOW = new BigNumber(ordinary_wages);
  const owSubjectToCPF = BigNumber.min(rawOW, OW_CEILING);

  // ── Step 2: Apply AW ceiling ─────────────────────────────────────────────
  const awCeiling = BigNumber.max(
    new BigNumber("0"),
    ANNUAL_SALARY_CEILING.minus(ytdOW)
  );
  const rawAW = new BigNumber(additional_wages);
  const awSubjectToCPF = BigNumber.min(rawAW, awCeiling);

  // ── Step 3: Compute raw CPF for OW and AW separately ────────────────────
  const { rawTotal: rawTotalOW, rawEmployee: rawEmployeeOW } = computeRawCPF(owSubjectToCPF, rates);
  const { rawTotal: rawTotalAW, rawEmployee: rawEmployeeAW } = computeRawCPF(awSubjectToCPF, rates);

  // ── Step 4: Sum OW + AW before rounding (CPF rule 4) ────────────────────
  const rawTotalCombined = rawTotalOW.plus(rawTotalAW);
  const rawEmployeeCombined = rawEmployeeOW.plus(rawEmployeeAW);

  // ── Step 5: Round per CPF rules ──────────────────────────────────────────
  // Rule 1: Total CPF — round to nearest dollar (half-up)
  const totalCPF = roundHalfUp(rawTotalCombined);
  // Rule 2: Employee share — round DOWN to nearest dollar
  const employeeCPF = rawEmployeeCombined.integerValue(BigNumber.ROUND_DOWN);
  // Rule 3: Employer share = Total (rounded) − Employee (rounded down)
  const employerCPF = totalCPF.minus(employeeCPF);

  // ── Step 6: SDL ──────────────────────────────────────────────────────────
  // SDL is computed on full wages (OW + AW, no CPF ceiling), capped at $4,500
  const totalWages = rawOW.plus(rawAW);
  const sdlWages = BigNumber.min(totalWages, SDL_WAGE_CAP);
  const sdlRaw = sdlWages.multipliedBy(SDL_RATE);
  // SDL: apply min/max; result rounded to 2 decimal places
  const sdl = BigNumber.max(SDL_MIN, BigNumber.min(SDL_MAX, sdlRaw))
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);

  // ── Step 7: Net pay ───────────────────────────────────────────────────────
  // Net pay = OW + AW + allowances − employee CPF − other deductions
  const totalAllowances = allowances.reduce(
    (sum, a) => sum.plus(new BigNumber(a.amount.toString())),
    new BigNumber("0")
  );
  const totalDeductions = deductions.reduce(
    (sum, d) => sum.plus(new BigNumber(d.amount.toString())),
    new BigNumber("0")
  );
  const netPay = rawOW
    .plus(rawAW)
    .plus(totalAllowances)
    .minus(employeeCPF)
    .minus(totalDeductions);

  return {
    employee_id,
    age,
    ordinary_wages: owSubjectToCPF.toFixed(2),
    additional_wages: awSubjectToCPF.toFixed(2),
    employee_cpf: employeeCPF.toFixed(2),
    employer_cpf: employerCPF.toFixed(2),
    total_cpf: totalCPF.toFixed(2),
    sdl: sdl.toFixed(2),
    net_pay: netPay.toFixed(2),
  };
}

/**
 * Runs computeCPF() for each employee in the array and returns an array of results.
 * ytd_ow is expected to be tracked per employee by the caller; pass "0" if not tracked.
 *
 * @param employees     - Array of CPFComputationInput (one per employee)
 * @param payrollMonth  - First day of the payroll month "YYYY-MM-DD"
 * @param employeeData  - Optional per-employee allowances and deductions
 * @returns Array of CPFComputationResult
 */
export function computePayroll(
  employees: CPFComputationInput[],
  payrollMonth: string,
  employeeData?: Array<{
    employee_id: string;
    allowances?: Array<{ label: string; amount: number }>;
    deductions?: Array<{ label: string; amount: number }>;
  }>
): CPFComputationResult[] {
  return employees.map((emp) => {
    const extraData = employeeData?.find((d) => d.employee_id === emp.employee_id);
    return computeCPF(
      emp,
      payrollMonth,
      extraData?.allowances ?? [],
      extraData?.deductions ?? []
    );
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Computes the raw (pre-rounding) CPF total and employee share for a single wage component.
 * Applies wage band rules per skills/sg-payroll-cpf/SKILL.md.
 *
 * Returns { rawTotal, rawEmployee } — both as BigNumbers with full decimal precision.
 * The caller sums OW and AW before applying rounding.
 */
function computeRawCPF(
  wages: BigNumber,
  rates: CPFRates
): { rawTotal: BigNumber; rawEmployee: BigNumber } {
  const zero = new BigNumber("0");

  // Band 1: wages <= $50 — no CPF
  if (wages.isLessThanOrEqualTo(BAND_NO_CONTRIBUTION)) {
    return { rawTotal: zero, rawEmployee: zero };
  }

  // Band 2: wages > $50 to $500 — employer only, employee = 0
  if (wages.isLessThanOrEqualTo(BAND_EMPLOYER_ONLY)) {
    // Employer pays at the full employer rate on total wages in this band
    const employerOnly = wages.multipliedBy(rates.employerRate);
    return { rawTotal: employerOnly, rawEmployee: zero };
  }

  // Band 3: wages > $500 to $750 — phased-in contributions
  // Formula (Table 1 pattern, generalised to all tables):
  //   total   = employer_rate × TW + factor × (TW − 500)
  //   employee = factor × (TW − 500)
  //   where factor = employee_rate × 3
  //   (derived from continuity at $750: at TW=750, employee = employee_rate × 750
  //    which equals factor × 250, so factor = employee_rate × 750 / 250 = employee_rate × 3)
  if (wages.isLessThanOrEqualTo(BAND_PHASEDIN)) {
    const factor = rates.employeeRate.multipliedBy("3");
    const excess = wages.minus(BAND_EMPLOYER_ONLY); // TW − $500
    const rawEmployee = factor.multipliedBy(excess);
    const rawTotal = rates.employerRate.multipliedBy(wages).plus(rawEmployee);
    return { rawTotal, rawEmployee };
  }

  // Band 4: wages > $750 — full rates
  const rawTotal = wages.multipliedBy(rates.totalRate);
  const rawEmployee = wages.multipliedBy(rates.employeeRate);
  return { rawTotal, rawEmployee };
}

/**
 * Rounds a BigNumber to the nearest integer using the CPF half-up rounding rule:
 * - Round DOWN if fractional part < 0.50
 * - Round UP   if fractional part >= 0.50
 */
function roundHalfUp(value: BigNumber): BigNumber {
  return value.integerValue(BigNumber.ROUND_HALF_UP);
}
