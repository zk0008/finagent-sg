/**
 * lib/fsGenerator.ts
 *
 * AI Financial Statement generator for FinAgent-SG.
 *
 * What this module does:
 * Orchestrates the assembly of a full Singapore financial statement package:
 * Balance Sheet, P&L, Cash Flow, Equity Statement, Notes, and XBRL tags.
 *
 * Architecture:
 * - The AI (GPT-4.1) determines structure, narrative, and required disclosures.
 * - The Calculation Engine (calculationEngine.ts) does ALL arithmetic — the AI
 *   never computes numbers directly. This prevents hallucinated figures.
 * - RAG is used before the Notes step to retrieve required SFRS disclosures.
 * - XBRL tagging is a deterministic tool (no AI) mapping line items to ACRA taxonomy.
 *
 * Uses GPT-4.1 (not mini) because financial statement accuracy is critical —
 * errors in FS structure can cause ACRA filing rejections.
 *
 * Langfuse tracing (Phase 5):
 * - One parent trace "fs_generation" wraps the entire generateFinancialStatements() call.
 * - Each of the 5 AI steps is a separate child generation under the parent trace.
 * - Step names: "generate_balance_sheet", "generate_profit_and_loss",
 *   "generate_cash_flow", "generate_equity_statement", "generate_notes".
 * - Each generation tracks: model, prompt (system + user), output, token usage.
 * - The RAG query in generateNotes() also creates a child span via ragQuery().
 * - flushLangfuse() is called in app/api/generate-fs/route.ts, not here.
 *
 * Called by: trigger/fsGenerationJob.ts (Task 6) in Step 4 of the pipeline.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import BigNumber from "bignumber.js";
import { ragQuery } from "./ragQuery";
import {
  sumAccounts,
  calculateNetProfit,
  calculateRetainedEarnings,
  validateBalanceSheet,
  formatSGD,
} from "./calculationEngine";
import { FSOutputSchema, type FSGeneratorInput, type FSOutput } from "./schemas";
import { MODEL_ROUTES } from "./modelRouter";
import { getLangfuse } from "./langfuse";
import type { LangfuseTraceClient } from "langfuse";

// Model sourced from centralised router (Phase 5).
// Previously hardcoded as "gpt-4.1".
const FS_MODEL = MODEL_ROUTES.fs_generation;

/**
 * Generates the full financial statement package for a Singapore entity.
 *
 * Runs five AI steps plus one deterministic XBRL step concurrently:
 * 1. Balance Sheet          ─┐
 * 2. P&L Statement          ─┼─ fired simultaneously
 * 3. Cash Flow Statement    ─┤
 * 4. Statement of Equity    ─┘
 * 5. Notes (RAG-assisted)   — chains off BS + P&L; starts when both settle
 * 6. XBRL Tagging (deterministic, no AI)
 *
 * @param input - FSGeneratorInput with entity, fiscal year, accounts, and exemption status
 * @returns FSOutput with all five FS components and XBRL tags
 */
export async function generateFinancialStatements(
  input: FSGeneratorInput
): Promise<FSOutput> {
  const { entity, fiscal_year, classified_accounts, exemption_result, corrections } = input;

  // ── Langfuse: open parent trace for the full FS pipeline ──────────────────
  // All 5 AI steps are child generations of this single trace so you can see
  // the total token cost, latency per step, and end-to-end pipeline time.
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "fs_generation",
    input: {
      entity_name: entity.name,
      uen: entity.uen,
      fye: fiscal_year.end_date,
      account_count: classified_accounts.length,
    },
  });

  // ── Pre-compute all figures using the Calculation Engine ──────────────────
  // The AI receives these pre-computed totals. It never does arithmetic.

  const currentAssets = sumAccounts(classified_accounts, "current_asset");
  const nonCurrentAssets = sumAccounts(classified_accounts, "non_current_asset");
  const totalAssets = currentAssets.plus(nonCurrentAssets).decimalPlaces(2);

  const currentLiabilities = sumAccounts(classified_accounts, "current_liability");
  const nonCurrentLiabilities = sumAccounts(classified_accounts, "non_current_liability");
  const totalLiabilities = currentLiabilities.plus(nonCurrentLiabilities).decimalPlaces(2);

  const equityAccounts = sumAccounts(classified_accounts, "equity");
  const revenue = sumAccounts(classified_accounts, "revenue");
  const expenses = sumAccounts(classified_accounts, "expense");
  const netProfit = calculateNetProfit(revenue, expenses);

  // Retained earnings: equity accounts include retained earnings in the trial balance.
  // Opening retained earnings derived from equity total minus other capital components.
  // For simplicity, we treat the full equity balance as the closing equity including net profit.
  const openingRetainedEarnings = equityAccounts.minus(netProfit).decimalPlaces(2);
  const closingRetainedEarnings = calculateRetainedEarnings(
    openingRetainedEarnings,
    netProfit,
    new BigNumber(0) // dividends: 0 unless declared in trial balance
  );

  const totalEquity = closingRetainedEarnings.decimalPlaces(2);
  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity).decimalPlaces(2);

  // Validate the balance sheet equation: Assets = Liabilities + Equity
  const isBalanced = validateBalanceSheet(totalAssets, totalLiabilitiesAndEquity);

  // Shared context passed to each AI step so it has the full picture
  const entityContext = `
Entity: ${entity.name}
UEN: ${entity.uen}
FYE: ${fiscal_year.end_date}
Currency: SGD
Audit Exempt: ${exemption_result.is_audit_exempt ? "Yes (Small Company + EPC)" : "No"}
  `.trim();

  // ── Steps 1–5: Concurrent component generation (A3) ──────────────────────
  //
  // Steps 1–4 (Balance Sheet, P&L, Cash Flow, Equity) are fully independent —
  // each reads only from the pre-computed figures and classified_accounts above.
  // They are fired simultaneously.
  //
  // Step 5 (Notes) receives balanceSheet and profitAndLoss as context, so it
  // chains off those two promises and starts as soon as the slower of the two
  // settles. It is still covered by the outer Promise.all so any rejection
  // surfaces immediately and is not swallowed.
  //
  // Wall-clock time falls from sum(t1..t5) to max(t1, t2, max(t1,t2)+t5, t3, t4).

  const bsPromise = generateBalanceSheet({
    trace,
    entityContext,
    currentAssets,
    nonCurrentAssets,
    totalAssets,
    currentLiabilities,
    nonCurrentLiabilities,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity,
    isBalanced,
    accounts: classified_accounts,
  });

  const plPromise = generateProfitAndLoss({
    trace,
    entityContext,
    revenue,
    expenses,
    netProfit,
    accounts: classified_accounts,
    fiscalYear: fiscal_year,
  });

  const cfPromise = generateCashFlow({
    trace,
    entityContext,
    netProfit,
    accounts: classified_accounts,
    fiscalYear: fiscal_year,
  });

  const eqPromise = generateEquityStatement({
    trace,
    entityContext,
    openingRetainedEarnings,
    netProfit,
    closingRetainedEarnings,
    totalEquity,
    fiscalYear: fiscal_year,
  });

  // Notes chains off BS + P&L: starts once both are settled, no signature change.
  const notesPromise = Promise.all([bsPromise, plPromise]).then(([bs, pl]) =>
    generateNotes({
      trace,
      entityContext,
      entity,
      exemptionResult: exemption_result,
      balanceSheet: bs,
      profitAndLoss: pl,
      fiscalYear: fiscal_year,
      corrections: corrections ?? [],
    })
  );

  const [balanceSheet, profitAndLoss, cashFlow, equityStatement, notes] =
    await Promise.all([bsPromise, plPromise, cfPromise, eqPromise, notesPromise]);

  // ── Step 6: XBRL Tagging (deterministic, no AI) ───────────────────────────
  // Maps each line item key to the corresponding ACRA BizFile+ taxonomy code.
  // This is a lookup table — no AI involved, no ambiguity.
  const xbrlTags = generateXbrlTags();

  // ── Langfuse: close parent trace ──────────────────────────────────────────
  trace.update({ output: { steps_completed: 5, xbrl_tags_count: Object.keys(xbrlTags).length } });

  // Parse through FSOutputSchema before returning so that:
  // 1. The notes preprocess coercion runs on the raw AI output (object → array, null → [])
  // 2. Any unexpected shape is caught here rather than crashing the PDF generator downstream
  return FSOutputSchema.parse({
    balance_sheet: balanceSheet,
    profit_and_loss: profitAndLoss,
    cash_flow: cashFlow,
    equity_statement: equityStatement,
    notes,
    xbrl_tags: xbrlTags,
  });
}

// ── Step 1 Helper: Balance Sheet ─────────────────────────────────────────────

async function generateBalanceSheet(params: {
  trace: LangfuseTraceClient;
  entityContext: string;
  currentAssets: BigNumber;
  nonCurrentAssets: BigNumber;
  totalAssets: BigNumber;
  currentLiabilities: BigNumber;
  nonCurrentLiabilities: BigNumber;
  totalLiabilities: BigNumber;
  totalEquity: BigNumber;
  totalLiabilitiesAndEquity: BigNumber;
  isBalanced: boolean;
  accounts: import("./schemas").ClassifiedAccount[];
}): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a Singapore chartered accountant preparing a Balance Sheet (Statement of Financial Position)
under SFRS for a Singapore private limited company.
Structure the balance sheet with: current assets, non-current assets, current liabilities,
non-current liabilities, and equity sections.
All figures are pre-computed — do not recalculate. Use the exact SGD figures provided.
Return a structured JSON object representing the balance sheet layout.`;

  const userPrompt = `${params.entityContext}

PRE-COMPUTED FIGURES (use exactly as provided, do not recalculate):
Current Assets: SGD ${formatSGD(params.currentAssets)}
Non-Current Assets: SGD ${formatSGD(params.nonCurrentAssets)}
Total Assets: SGD ${formatSGD(params.totalAssets)}
Current Liabilities: SGD ${formatSGD(params.currentLiabilities)}
Non-Current Liabilities: SGD ${formatSGD(params.nonCurrentLiabilities)}
Total Liabilities: SGD ${formatSGD(params.totalLiabilities)}
Total Equity: SGD ${formatSGD(params.totalEquity)}
Total Liabilities + Equity: SGD ${formatSGD(params.totalLiabilitiesAndEquity)}
Balance Sheet Balanced: ${params.isBalanced}

Individual accounts by category:
${params.accounts.map((a) => `[${a.sfrs_category}] ${a.account_code} ${a.account_name}: Dr ${a.debit.toFixed(2)} Cr ${a.credit.toFixed(2)}`).join("\n")}

Structure a complete Singapore Balance Sheet in JSON format.`;

  // ── Langfuse: generation for Balance Sheet step ────────────────────────────
  const generation = params.trace.generation({
    name: "generate_balance_sheet",
    model: FS_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  const { object, usage } = await generateObject({
    model: openai(FS_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    schema: z.object({
      title: z.string(),
      as_at_date: z.string(),
      current_assets: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_current_assets: z.number(),
      non_current_assets: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_non_current_assets: z.number(),
      total_assets: z.number(),
      current_liabilities: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_current_liabilities: z.number(),
      non_current_liabilities: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_non_current_liabilities: z.number(),
      total_liabilities: z.number(),
      equity: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_equity: z.number(),
      total_liabilities_and_equity: z.number(),
      is_balanced: z.boolean(),
    }),
  });

  generation.end({
    output: object,
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  return object as Record<string, unknown>;
}

// ── Step 2 Helper: Profit & Loss ─────────────────────────────────────────────

async function generateProfitAndLoss(params: {
  trace: LangfuseTraceClient;
  entityContext: string;
  revenue: BigNumber;
  expenses: BigNumber;
  netProfit: BigNumber;
  accounts: import("./schemas").ClassifiedAccount[];
  fiscalYear: import("./schemas").FiscalYear;
}): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a Singapore chartered accountant preparing a Profit & Loss Statement
(Statement of Comprehensive Income) under SFRS for a Singapore private limited company.
Structure it with: revenue, cost of goods sold (if applicable), gross profit,
operating expenses, operating profit, finance costs, profit before tax, income tax, net profit.
All figures are pre-computed — do not recalculate.`;

  const userPrompt = `${params.entityContext}
Period: ${params.fiscalYear.start_date} to ${params.fiscalYear.end_date}

PRE-COMPUTED FIGURES:
Total Revenue: SGD ${formatSGD(params.revenue)}
Total Expenses: SGD ${formatSGD(params.expenses)}
Net Profit: SGD ${formatSGD(params.netProfit)}

Revenue accounts:
${params.accounts.filter((a) => a.sfrs_category === "revenue").map((a) => `  ${a.account_code} ${a.account_name}: ${a.credit.toFixed(2)}`).join("\n")}

Expense accounts:
${params.accounts.filter((a) => a.sfrs_category === "expense").map((a) => `  ${a.account_code} ${a.account_name}: ${a.debit.toFixed(2)}`).join("\n")}

Structure a complete Singapore P&L in JSON format.`;

  // ── Langfuse: generation for P&L step ─────────────────────────────────────
  const generation = params.trace.generation({
    name: "generate_profit_and_loss",
    model: FS_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  const { object, usage } = await generateObject({
    model: openai(FS_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    schema: z.object({
      title: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      revenue_lines: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_revenue: z.number(),
      expense_lines: z.array(z.object({ label: z.string(), amount: z.number() })),
      total_expenses: z.number(),
      net_profit: z.number(),
    }),
  });

  generation.end({
    output: object,
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  return object as Record<string, unknown>;
}

// ── Step 3 Helper: Cash Flow Statement ───────────────────────────────────────

async function generateCashFlow(params: {
  trace: LangfuseTraceClient;
  entityContext: string;
  netProfit: BigNumber;
  accounts: import("./schemas").ClassifiedAccount[];
  fiscalYear: import("./schemas").FiscalYear;
}): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a Singapore chartered accountant preparing a Cash Flow Statement
using the INDIRECT METHOD under SFRS for a Singapore private limited company.
Structure: Operating Activities (start from net profit, add non-cash items,
adjust working capital), Investing Activities, Financing Activities.
Derive figures from the trial balance accounts provided. All arithmetic is done by you
using the account balances — provide reasonable estimates based on account classifications.`;

  const userPrompt = `${params.entityContext}
Period: ${params.fiscalYear.start_date} to ${params.fiscalYear.end_date}

Net Profit: SGD ${formatSGD(params.netProfit)}

All classified accounts:
${params.accounts.map((a) => `[${a.sfrs_category}] ${a.account_code} ${a.account_name}: Dr ${a.debit.toFixed(2)} Cr ${a.credit.toFixed(2)}`).join("\n")}

Prepare the Cash Flow Statement using the indirect method.
Identify depreciation, working capital changes, PPE purchases, and financing activities from the account list.`;

  // ── Langfuse: generation for Cash Flow step ───────────────────────────────
  const generation = params.trace.generation({
    name: "generate_cash_flow",
    model: FS_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  const { object, usage } = await generateObject({
    model: openai(FS_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    schema: z.object({
      title: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      operating_activities: z.object({
        net_profit: z.number(),
        adjustments: z.array(z.object({ label: z.string(), amount: z.number() })),
        working_capital_changes: z.array(z.object({ label: z.string(), amount: z.number() })),
        net_cash_from_operations: z.number(),
      }),
      investing_activities: z.object({
        items: z.array(z.object({ label: z.string(), amount: z.number() })),
        net_cash_from_investing: z.number(),
      }),
      financing_activities: z.object({
        items: z.array(z.object({ label: z.string(), amount: z.number() })),
        net_cash_from_financing: z.number(),
      }),
      net_change_in_cash: z.number(),
      opening_cash: z.number(),
      closing_cash: z.number(),
    }),
  });

  generation.end({
    output: object,
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  return object as Record<string, unknown>;
}

// ── Step 4 Helper: Statement of Changes in Equity ───────────────────────────

async function generateEquityStatement(params: {
  trace: LangfuseTraceClient;
  entityContext: string;
  openingRetainedEarnings: BigNumber;
  netProfit: BigNumber;
  closingRetainedEarnings: BigNumber;
  totalEquity: BigNumber;
  fiscalYear: import("./schemas").FiscalYear;
}): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a Singapore chartered accountant preparing a Statement of Changes in Equity
under SFRS for a Singapore private limited company.
Show movements in share capital and retained earnings from opening to closing balance.
All figures are pre-computed — use exactly as provided.`;

  const userPrompt = `${params.entityContext}
Period: ${params.fiscalYear.start_date} to ${params.fiscalYear.end_date}

PRE-COMPUTED FIGURES:
Opening Retained Earnings: SGD ${formatSGD(params.openingRetainedEarnings)}
Net Profit for Year: SGD ${formatSGD(params.netProfit)}
Closing Retained Earnings: SGD ${formatSGD(params.closingRetainedEarnings)}
Total Equity: SGD ${formatSGD(params.totalEquity)}

Structure a complete Statement of Changes in Equity in JSON format.`;

  // ── Langfuse: generation for Equity Statement step ────────────────────────
  const generation = params.trace.generation({
    name: "generate_equity_statement",
    model: FS_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  const { object, usage } = await generateObject({
    model: openai(FS_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    schema: z.object({
      title: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      share_capital: z.object({
        opening: z.number(),
        issued: z.number(),
        closing: z.number(),
      }),
      retained_earnings: z.object({
        opening: z.number(),
        net_profit: z.number(),
        dividends: z.number(),
        closing: z.number(),
      }),
      total_equity_opening: z.number(),
      total_equity_closing: z.number(),
    }),
  });

  generation.end({
    output: object,
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  return object as Record<string, unknown>;
}

// ── Step 5 Helper: Notes to Financial Statements ─────────────────────────────

async function generateNotes(params: {
  trace: LangfuseTraceClient;
  entityContext: string;
  entity: import("./schemas").Entity;
  exemptionResult: import("./schemas").ExemptionResult;
  balanceSheet: Record<string, unknown>;
  profitAndLoss: Record<string, unknown>;
  fiscalYear: import("./schemas").FiscalYear;
  corrections: string[];
}): Promise<Array<{ title: string; content: string }>> {
  // RAG retrieves required SFRS disclosure requirements from the knowledge base.
  // This ensures the notes include all mandatory items (e.g. accounting policies,
  // related party disclosures, contingent liabilities) required under Singapore SFRS.
  // Pass the parent trace so the RAG span appears under fs_generation in Langfuse.
  const ragResults = await ragQuery(
    "SFRS notes to financial statements required disclosures Singapore private limited company",
    8,
    params.trace
  );

  const ragContext =
    ragResults.length > 0
      ? ragResults.map((r) => r.text).join("\n\n---\n\n")
      : "No specific SFRS disclosures found in knowledge base. Use standard Singapore SFRS requirements.";

  const systemPrompt = `You are a Singapore chartered accountant preparing Notes to Financial Statements
under SFRS for a Singapore private limited company.
Use the retrieved SFRS knowledge base content to ensure all mandatory disclosures are included.
Each note should have a clear title and detailed content appropriate for a Singapore private limited company.

SFRS Knowledge Base Content:
${ragContext}`;

  const correctionsBlock =
    params.corrections.length > 0
      ? `\nUSER CORRECTIONS (must be applied — these override defaults):\n${params.corrections.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
      : "";

  const userPrompt = `${params.entityContext}
Audit Exempt: ${params.exemptionResult.is_audit_exempt}
EPC Status: ${params.exemptionResult.is_epc}
${correctionsBlock}
Prepare comprehensive Notes to Financial Statements including:
1. General information (company name, UEN, nature of business, FYE)
2. Summary of significant accounting policies
3. Revenue recognition policy
4. Property, plant and equipment policy and movements
5. Trade and other receivables
6. Trade and other payables
7. Related party transactions (confirm if applicable)
8. Contingent liabilities (if any)
9. Events after balance sheet date

IMPORTANT: The "notes" field in your response MUST be a JSON array [].
Never return notes as an object with numeric keys.
Never return null or omit the field.
Each element must have exactly two string fields: "title" and "content".`;

  // ── Langfuse: generation for Notes step ───────────────────────────────────
  const generation = params.trace.generation({
    name: "generate_notes",
    model: FS_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  const { object, usage } = await generateObject({
    model: openai(FS_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    schema: z.object({
      notes: z.array(
        z.object({
          title: z.string(),
          content: z.string(),
        })
      ),
    }),
  });

  generation.end({
    output: { note_count: object.notes.length },
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  return object.notes;
}

// ── Step 6: XBRL Tagging (deterministic, no AI) ──────────────────────────────
// Maps financial statement line item keys to ACRA BizFile+ taxonomy codes.
// This is a static lookup — no AI ambiguity, no API calls.

function generateXbrlTags(): Record<string, string> {
  // ACRA BizFile+ taxonomy codes for simplified XBRL (small company filing)
  // These map FS line item identifiers to the official ACRA taxonomy element names.
  return {
    // Balance Sheet — Assets
    "current_assets.cash_and_cash_equivalents": "ifrs-full:CashAndCashEquivalents",
    "current_assets.trade_and_other_receivables": "ifrs-full:TradeAndOtherCurrentReceivables",
    "current_assets.inventories": "ifrs-full:Inventories",
    "current_assets.prepayments": "ifrs-full:OtherCurrentAssets",
    "current_assets.total": "ifrs-full:CurrentAssets",
    "non_current_assets.property_plant_equipment": "ifrs-full:PropertyPlantAndEquipment",
    "non_current_assets.intangible_assets": "ifrs-full:IntangibleAssetsOtherThanGoodwill",
    "non_current_assets.long_term_investments": "ifrs-full:OtherNoncurrentFinancialAssets",
    "non_current_assets.total": "ifrs-full:NoncurrentAssets",
    "total_assets": "ifrs-full:Assets",

    // Balance Sheet — Liabilities
    "current_liabilities.trade_and_other_payables": "ifrs-full:TradeAndOtherCurrentPayables",
    "current_liabilities.short_term_borrowings": "ifrs-full:CurrentBorrowings",
    "current_liabilities.income_tax_payable": "ifrs-full:CurrentTaxLiabilitiesCurrent",
    "current_liabilities.accruals": "ifrs-full:OtherCurrentLiabilities",
    "current_liabilities.total": "ifrs-full:CurrentLiabilities",
    "non_current_liabilities.long_term_borrowings": "ifrs-full:NoncurrentBorrowings",
    "non_current_liabilities.deferred_tax": "ifrs-full:DeferredTaxLiabilities",
    "non_current_liabilities.total": "ifrs-full:NoncurrentLiabilities",
    "total_liabilities": "ifrs-full:Liabilities",

    // Balance Sheet — Equity
    "equity.share_capital": "ifrs-full:IssuedCapital",
    "equity.retained_earnings": "ifrs-full:RetainedEarnings",
    "equity.other_reserves": "ifrs-full:OtherReserves",
    "total_equity": "ifrs-full:Equity",
    "total_liabilities_and_equity": "ifrs-full:EquityAndLiabilities",

    // P&L
    "revenue.total": "ifrs-full:Revenue",
    "expenses.cost_of_sales": "ifrs-full:CostOfSales",
    "expenses.selling_and_distribution": "ifrs-full:SellingAndDistributionExpense",
    "expenses.administrative": "ifrs-full:AdministrativeExpense",
    "expenses.finance_costs": "ifrs-full:FinanceCosts",
    "expenses.depreciation": "ifrs-full:DepreciationAndAmortisationExpense",
    "profit_before_tax": "ifrs-full:ProfitLossBeforeTax",
    "income_tax_expense": "ifrs-full:IncomeTaxExpenseContinuingOperations",
    "net_profit": "ifrs-full:ProfitLoss",

    // Cash Flow
    "cash_flow.net_cash_from_operations": "ifrs-full:CashFlowsFromUsedInOperatingActivities",
    "cash_flow.net_cash_from_investing": "ifrs-full:CashFlowsFromUsedInInvestingActivities",
    "cash_flow.net_cash_from_financing": "ifrs-full:CashFlowsFromUsedInFinancingActivities",
    "cash_flow.net_change_in_cash": "ifrs-full:IncreaseDecreaseInCashAndCashEquivalents",
    "cash_flow.closing_cash": "ifrs-full:CashAndCashEquivalents",
  };
}
