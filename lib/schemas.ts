/**
 * lib/schemas.ts
 *
 * Zod schemas for all core data types in FinAgent-SG.
 * These schemas are the single source of truth for data shape validation.
 * They are used at API boundaries, form validation, and AI output parsing.
 *
 * Phase 0: Entity, FiscalYear, TrialBalanceLine, FinancialStatement, Employee, CPFContribution
 * Phase 1: RagResult (added for RAG query pipeline)
 * Phase 2: ClassifiedAccount, ExemptionInput/Result, FSGeneratorInput, FSOutput, SavedOutput
 * Phase 3: ProjectionAssumptions, ProjectedFS, FinancialModel
 * Phase 4: Employee (updated), PayrollRun, Payslip, CPFComputationInput/Result, JournalEntry
 */

import { z } from "zod";

// Entity — a client company record.
// Represents one Singapore company managed within FinAgent-SG.
export const EntitySchema = z.object({
  name: z.string().min(1, "Company name is required"),
  uen: z
    .string()
    .regex(/^[0-9]{9}[A-Z]$|^T[0-9]{2}[A-Z]{2}[0-9]{4}[A-Z]$/, "Invalid UEN format"),
  company_type: z.enum(["private_ltd", "llp", "sole_prop"]),
  fye_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "FYE date must be YYYY-MM-DD"),
  audit_exempt: z.boolean(),
});
export type Entity = z.infer<typeof EntitySchema>;

// FiscalYear — one financial year for an entity.
// Each entity has one or more fiscal years; work is tracked per year.
export const FiscalYearSchema = z.object({
  entity_id: z.string().uuid("entity_id must be a valid UUID"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date must be YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be YYYY-MM-DD"),
  status: z.enum(["draft", "in_progress", "finalised"]),
});
export type FiscalYear = z.infer<typeof FiscalYearSchema>;

// TrialBalanceLine — one row from an uploaded trial balance spreadsheet.
// The Excel parser (Phase 2) will produce an array of these from the uploaded file.
export const TrialBalanceLineSchema = z.object({
  account_code: z.string().min(1, "Account code is required"),
  account_name: z.string().min(1, "Account name is required"),
  debit: z.number().nonnegative("Debit must be non-negative"),
  credit: z.number().nonnegative("Credit must be non-negative"),
});
export type TrialBalanceLine = z.infer<typeof TrialBalanceLineSchema>;

// FinancialStatement — a generated output document (PDF, XBRL, or Excel).
// Created after the FS generation agent completes its work (Phase 2).
export const FinancialStatementSchema = z.object({
  fiscal_year_id: z.string().uuid("fiscal_year_id must be a valid UUID"),
  output_type: z.enum(["financial_statement", "payroll_report", "financial_model"]),
  file_url: z.string().url("file_url must be a valid URL"),
  created_at: z.string().datetime("created_at must be an ISO 8601 datetime"),
});
export type FinancialStatement = z.infer<typeof FinancialStatementSchema>;

// Employee — an employee record used for payroll and CPF computation (Phase 4).
// Updated in Phase 4: added id, nric_fin, created_at; updated citizenship values
// to match official CPF table identifiers used throughout the CPF engine.
// citizenship values:
//   'SC'        → Table 1 (Singapore Citizen — full SC/SPR 3rd+ rates)
//   'SPR_1'     → Table 2 (1st year SPR graduated G/G rates)
//   'SPR_2'     → Table 3 (2nd year SPR graduated G/G rates)
//   'SPR_3'     → Table 1 (3rd year+ SPR — same rates as SC)
//   'foreigner' → No CPF; SDL still applies
export const EmployeeSchema = z.object({
  id: z.string().optional(),                        // UUID from DB; omitted on create
  entity_id: z.string(),
  name: z.string().min(1, "Employee name is required"),
  nric_fin: z.string().nullable().optional(),       // NRIC or FIN; nullable
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dob must be YYYY-MM-DD"),
  citizenship: z.enum(["SC", "SPR_1", "SPR_2", "SPR_3", "foreigner"]),
  monthly_salary: z.number().positive("Monthly salary must be positive"),
  created_at: z.string().optional(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// CPFContribution — legacy stub schema from Phase 0; kept for reference.
// The Phase 4 CPF engine uses CPFComputationInputSchema / CPFComputationResultSchema below.
export const CPFContributionSchema = z.object({
  employee_id: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
  ordinary_wages: z.number().nonnegative(),
  additional_wages: z.number().nonnegative(),
  employee_contribution: z.number().nonnegative(),
  employer_contribution: z.number().nonnegative(),
  total_contribution: z.number().nonnegative(),
});
export type CPFContribution = z.infer<typeof CPFContributionSchema>;

// ClassifiedAccount — a TrialBalanceLine after SFRS category has been assigned by the AI.
// Produced by accountClassifier.ts (Phase 2, Task 2).
// sfrs_category maps to one of the seven top-level SFRS balance sheet / P&L buckets.
// confidence is 0–1 reflecting AI certainty; used for review flagging.
export const SfrsCategoryEnum = z.enum([
  "current_asset",
  "non_current_asset",
  "current_liability",
  "non_current_liability",
  "equity",
  "revenue",
  "expense",
]);
export type SfrsCategory = z.infer<typeof SfrsCategoryEnum>;

export const ClassifiedAccountSchema = z.object({
  account_code: z.string().min(1),
  account_name: z.string().min(1),
  debit: z.number().nonnegative(),
  credit: z.number().nonnegative(),
  sfrs_category: SfrsCategoryEnum,
  confidence: z.number().min(0).max(1),
});
export type ClassifiedAccount = z.infer<typeof ClassifiedAccountSchema>;

// ExemptionInput — inputs required to check Singapore small company audit exemption.
// Produced by the UI configuration form and passed to exemptionChecker.ts (Phase 2, Task 3).
export const ExemptionInputSchema = z.object({
  revenue: z.number().nonnegative("Revenue must be non-negative"),
  total_assets: z.number().nonnegative("Total assets must be non-negative"),
  employee_count: z.number().int().nonnegative("Employee count must be a non-negative integer"),
  has_corporate_shareholders: z.boolean(),
  shareholder_count: z.number().int().nonnegative("Shareholder count must be a non-negative integer"),
});
export type ExemptionInput = z.infer<typeof ExemptionInputSchema>;

// ExemptionResult — output of the small company / EPC exemption check.
// is_audit_exempt is true only if the company is BOTH a small company AND an EPC.
// reasons explains each determination in plain English for display to the user.
export const ExemptionResultSchema = z.object({
  is_small_company: z.boolean(),
  is_epc: z.boolean(),
  is_audit_exempt: z.boolean(),
  reasons: z.array(z.string()),
});
export type ExemptionResult = z.infer<typeof ExemptionResultSchema>;

// FSGeneratorInput — full input package for the FS generation agent (Phase 2, Task 5).
// Combines entity metadata, fiscal year, classified accounts, and exemption status.
export const FSGeneratorInputSchema = z.object({
  entity: EntitySchema,
  fiscal_year: FiscalYearSchema,
  classified_accounts: z.array(ClassifiedAccountSchema),
  exemption_result: ExemptionResultSchema,
});
export type FSGeneratorInput = z.infer<typeof FSGeneratorInputSchema>;

// FSOutput — the full set of generated financial statement components.
// Each field holds the structured data for one FS component.
// xbrl_tags maps line item keys to ACRA BizFile+ taxonomy codes.
//
// notes uses z.preprocess() to defend against the AI returning a plain object
// (e.g. { "0": {...}, "1": {...} }) instead of an array, or returning null/undefined.
// Coercion order: null/undefined → []; plain object → Object.values(); array → as-is.
// FSOutputSchema.parse() is called in fsGenerator.ts before the output leaves the module,
// so this coercion always runs on the raw AI response.
export const FSOutputSchema = z.object({
  balance_sheet: z.record(z.string(), z.unknown()),
  profit_and_loss: z.record(z.string(), z.unknown()),
  cash_flow: z.record(z.string(), z.unknown()),
  equity_statement: z.record(z.string(), z.unknown()),
  notes: z.preprocess(
    (val) => {
      if (val == null) return [];
      if (Array.isArray(val)) return val;
      // AI sometimes returns a keyed object instead of an array — coerce via Object.values()
      if (typeof val === "object") return Object.values(val as Record<string, unknown>);
      return [];
    },
    z.array(z.object({ title: z.string(), content: z.string() }))
  ),
  xbrl_tags: z.record(z.string(), z.string()),
});
export type FSOutput = z.infer<typeof FSOutputSchema>;

// ── Phase 3 schemas ───────────────────────────────────────────────────────────

// ProjectionAssumptions — user-supplied inputs that drive financial projections.
// Stored in financial_models.assumptions (JSONB).
// custom_line_assumptions allows per-account overrides on top of the global rates.
export const ProjectionAssumptionsSchema = z.object({
  revenue_growth_pct: z.number(),
  cogs_growth_pct: z.number(),
  opex_growth_pct: z.number(),
  depreciation_method: z.enum(["straight_line", "reducing_balance"]),
  tax_rate_pct: z.number().min(0).max(100),
  custom_line_assumptions: z.array(
    z.object({
      account_code: z.string(),
      growth_pct: z.number(),
    })
  ),
});
export type ProjectionAssumptions = z.infer<typeof ProjectionAssumptionsSchema>;

// ProjectedFS — one year's projected financial statements.
// Same shape as FSOutput but includes a `year` field indicating which projection
// year this represents (1 = first projection year, 2 = second, etc.).
// Stored as an array of ProjectedFS in financial_models.base_case / best_case / worst_case.
export const ProjectedFSSchema = FSOutputSchema.extend({
  year: z.number().int().min(1).max(5),
});
export type ProjectedFS = z.infer<typeof ProjectedFSSchema>;

// FinancialModel — a row from client_schema.financial_models.
// base_case is always present; best_case, worst_case, and actuals are optional
// (populated in Phase 3 Tasks 6 and 7 respectively).
export const FinancialModelSchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  fiscal_year_id: z.string().nullable(),
  source_output_id: z.string(),
  model_name: z.string(),
  projection_years: z.number().int().min(1).max(5),
  assumptions: ProjectionAssumptionsSchema,
  base_case: z.array(ProjectedFSSchema),
  best_case: z.array(ProjectedFSSchema).nullable(),
  worst_case: z.array(ProjectedFSSchema).nullable(),
  actuals: z.unknown().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FinancialModel = z.infer<typeof FinancialModelSchema>;

// SavedOutput — a row from the client_schema.outputs table.
// Returned by getLatestFS() in lib/outputStorage.ts and used by Phase 3 to
// load the base financial data for projections and scenario analysis.
export const SavedOutputSchema = z.object({
  id: z.string().uuid(),
  fiscal_year_id: z.string().uuid(),
  output_type: z.string(),
  structured_data: FSOutputSchema,
  classified_accounts: z.array(ClassifiedAccountSchema),
  exemption_result: ExemptionResultSchema,
  pdf_data: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type SavedOutput = z.infer<typeof SavedOutputSchema>;

// RagResult — one result returned by the RAG query pipeline (Phase 1).
// Each result is a chunk of text retrieved from ChromaDB, ranked by embedding similarity.
// `distance` is the cosine distance from the query — lower = more relevant.
export const RagResultSchema = z.object({
  text: z.string(),
  source_file: z.string(),
  chunk_index: z.number().int().nonnegative(),
  topic: z.string(),
  distance: z.number(),
});
export type RagResult = z.infer<typeof RagResultSchema>;

// ── Phase 4 schemas ───────────────────────────────────────────────────────────

// PayrollRun — one monthly payroll run for an entity.
// run_month is always the first day of the month (e.g. "2025-12-01").
// status starts as 'draft' and is set to 'finalised' after review — finalised runs are locked.
export const PayrollRunSchema = z.object({
  id: z.string().optional(),
  entity_id: z.string(),
  run_month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "run_month must be YYYY-MM-DD (first of month)"),
  status: z.enum(["draft", "finalised"]),
  created_at: z.string().optional(),
});
export type PayrollRun = z.infer<typeof PayrollRunSchema>;

// Payslip — computed payroll record for one employee in one payroll run.
// allowances and deductions are itemised arrays: [{label, amount}].
// employee_cpf is deducted from the employee's pay.
// employer_cpf is a separate employer cost — shown on payslip but NOT deducted from net pay.
// net_pay = ordinary_wages + additional_wages + sum(allowances) − employee_cpf − sum(deductions)
export const PayslipSchema = z.object({
  id: z.string().optional(),
  payroll_run_id: z.string(),
  employee_id: z.string(),
  ordinary_wages: z.number().nonnegative(),
  additional_wages: z.number().nonnegative(),
  allowances: z.array(z.object({ label: z.string(), amount: z.number() })).nullable().optional(),
  deductions: z.array(z.object({ label: z.string(), amount: z.number() })).nullable().optional(),
  employee_cpf: z.number().nonnegative(),
  employer_cpf: z.number().nonnegative(),
  total_cpf: z.number().nonnegative(),
  sdl: z.number().nonnegative(),
  net_pay: z.number(),
  created_at: z.string().optional(),
});
export type Payslip = z.infer<typeof PayslipSchema>;

// CPFComputationInput — input for computing CPF for one employee for one month.
// All wage amounts are strings to preserve bignumber.js precision across the call boundary.
// ytd_ow is the year-to-date ordinary wages subject to CPF (used to compute the AW ceiling).
// If ytd_ow is omitted it defaults to 0, which produces the most conservative AW ceiling.
export const CPFComputationInputSchema = z.object({
  employee_id: z.string(),
  citizenship: z.enum(["SC", "SPR_1", "SPR_2", "SPR_3", "foreigner"]),
  dob: z.string(),                    // ISO date YYYY-MM-DD
  ordinary_wages: z.string(),         // String for bignumber.js
  additional_wages: z.string(),       // String for bignumber.js
  ytd_ow: z.string().optional(),      // Year-to-date OW subject to CPF (for AW ceiling); default "0"
});
export type CPFComputationInput = z.infer<typeof CPFComputationInputSchema>;

// CPFComputationResult — output of the CPF engine for one employee for one month.
// All monetary amounts are strings (bignumber.js output, rounded per CPF rules).
// age is the employee's age at last birthday in the contribution month.
export const CPFComputationResultSchema = z.object({
  employee_id: z.string(),
  age: z.number().int().nonnegative(),
  ordinary_wages: z.string(),         // OW actually subject to CPF (capped at $8,000)
  additional_wages: z.string(),       // AW actually subject to CPF (capped by annual AW ceiling)
  employee_cpf: z.string(),           // Employee share — rounded DOWN to nearest dollar
  employer_cpf: z.string(),           // Employer share = total_cpf − employee_cpf
  total_cpf: z.string(),              // Total CPF — rounded to nearest dollar (half-up)
  sdl: z.string(),                    // SDL — 0.25% of total wages, min $2, max $11.25
  net_pay: z.string(),                // Gross pay + allowances − employee_cpf − other deductions
});
export type CPFComputationResult = z.infer<typeof CPFComputationResultSchema>;

// JournalEntry — one double-entry bookkeeping line produced by the payroll journal engine.
// amount is a string (bignumber.js output) representing the absolute value of the entry.
// Each journal entry has exactly one debit account and one credit account.
export const JournalEntrySchema = z.object({
  date: z.string(),                   // ISO date YYYY-MM-DD (last day of the payroll month)
  description: z.string(),            // Plain-English description of what this entry records
  debit_account: z.string(),          // Account debited
  credit_account: z.string(),         // Account credited
  amount: z.string(),                 // Absolute amount (string for bignumber.js precision)
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ── Phase 7 schemas ───────────────────────────────────────────────────────────

// TaxAdjustment — one line item in the tax computation schedule.
// amount: positive string value (engine takes abs() and uses type to determine direction).
// type: "add_back" adds to accounting profit; "deduct" reduces it.
export const TaxAdjustmentSchema = z.object({
  description: z.string().min(1, "Description is required"),
  amount: z.string(),   // positive = add back, negative = deduct (engine uses abs() + type)
  type: z.enum(["add_back", "deduct"]),
});
export type TaxAdjustment = z.infer<typeof TaxAdjustmentSchema>;

// TaxComputationInput — all inputs required to compute corporate income tax.
// accounting_profit and revenue are strings for bignumber.js precision.
// is_new_startup: true if this is one of the company's first 3 Years of Assessment.
// is_local_employee_cpf: true if the company made CPF contributions to a local employee in 2025
//   (required for the YA 2026 CIT Rebate Cash Grant of $1,500).
export const TaxComputationInputSchema = z.object({
  entity_id:              z.string().uuid(),
  fiscal_year_id:         z.string().uuid(),
  accounting_profit:      z.string(),   // Net profit per financial statements (string for bignumber.js)
  revenue:                z.string(),   // Annual revenue — determines filing form type
  is_new_startup:         z.boolean(),  // True = new start-up exemption; false = partial exemption
  is_local_employee_cpf:  z.boolean(),  // True = eligible for CIT Rebate Cash Grant
  tax_adjustments:        z.array(TaxAdjustmentSchema),
});
export type TaxComputationInput = z.infer<typeof TaxComputationInputSchema>;

// TaxComputationResult — full output of the corporate tax computation engine.
// All monetary amounts are strings (bignumber.js output, rounded to 2 decimal places).
// eci_filing_required: false only if revenue ≤ $5M AND chargeable income is nil.
// eci_deadline: "DD Mon YYYY" or a descriptive fallback if FYE date is unavailable.
// form_filing_deadline: always "30 Nov YYYY" where YYYY is the Year of Assessment.
export const TaxComputationResultSchema = z.object({
  year_of_assessment:     z.number().int(),
  form_type:              z.enum(["C-S_Lite", "C-S", "C"]),
  accounting_profit:      z.string(),
  total_add_backs:        z.string(),
  total_deductions:       z.string(),
  chargeable_income:      z.string(),
  exemption_scheme:       z.enum(["new_startup", "partial"]),
  exempt_amount:          z.string(),
  taxable_income:         z.string(),
  gross_tax:              z.string(),
  cit_rebate:             z.string(),
  cit_rebate_cash_grant:  z.string(),
  tax_payable:            z.string(),
  eci_filing_required:    z.boolean(),
  eci_deadline:           z.string(),
  form_filing_deadline:   z.string(),
});
export type TaxComputationResult = z.infer<typeof TaxComputationResultSchema>;
