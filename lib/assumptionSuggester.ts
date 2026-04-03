/**
 * lib/assumptionSuggester.ts
 *
 * AI-powered projection assumption suggester for FinAgent-SG Phase 3.
 *
 * What this module does:
 * Analyses the classified accounts from the latest saved FS output and uses
 * GPT-4.1-mini + RAG to suggest reasonable financial projection assumptions
 * (growth rates, depreciation method, tax rate) for a Singapore entity.
 * The user sees these suggestions with rationales and can confirm or modify
 * them before the projection engine runs.
 *
 * Design:
 * - RAG retrieves Singapore economic context (GDP growth, corporate tax rate,
 *   industry benchmarks) from ChromaDB before the AI call.
 * - Only category-level totals are sent to the AI (not individual line items)
 *   to keep token usage low — GPT-4.1-mini is sufficient for suggestions.
 * - The AI returns structured JSON parsed and validated by Zod.
 * - Default Singapore corporate tax rate: 17% (effective ~8.5% for first $200K
 *   under partial exemption scheme for qualifying companies).
 * - No arithmetic is performed here — this module only suggests inputs for the
 *   projection engine (lib/projectionEngine.ts).
 *
 * Langfuse tracing (Phase 5):
 * - One trace per suggestAssumptions() call ("assumption_suggestion").
 * - One child span for the RAG query (via ragQuery() with parent trace).
 * - One child generation for the GPT-4.1-mini assumption call.
 * - Tracks: model, input (account summaries + RAG context), output
 *   (assumptions + rationales), token usage.
 * - flushLangfuse() is called in app/api/model/suggest-assumptions/route.ts, not here.
 *
 * Called by: app/api/model/suggest-assumptions/route.ts (Phase 3, Prompt 5).
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ragQuery } from "./ragQuery";
import { sumAccounts } from "./calculationEngine";
import {
  ProjectionAssumptionsSchema,
  type ProjectionAssumptions,
  type ClassifiedAccount,
} from "./schemas";
import { MODEL_ROUTES } from "./modelRouter";
import { getLangfuse } from "./langfuse";

// Model sourced from centralised router (Phase 5).
// Previously hardcoded as "gpt-4.1-mini".
const SUGGESTION_MODEL = MODEL_ROUTES.assumption_suggestion;

// Singapore corporate tax rate (standard flat rate).
// Small companies qualifying for partial exemption pay an effective rate
// of ~8.5% on first $200K chargeable income, then 17% above that.
const SG_CORPORATE_TAX_RATE = 17;
const SG_SMALL_COMPANY_EFFECTIVE_TAX_RATE = 8.5;

// RAG query targeting Singapore economic and tax context.
const RAG_QUERY_ASSUMPTION =
  "Singapore GDP growth rate corporate tax rate partial exemption small company industry benchmark revenue growth";

/**
 * Params for suggestAssumptions.
 * classifiedAccounts come from the latest saved FS output.
 * companyType and isAuditExempt are used to determine appropriate tax rate defaults.
 */
export type SuggestAssumptionsParams = {
  classifiedAccounts: ClassifiedAccount[];
  companyType: "private_ltd" | "llp" | "sole_prop";
  isAuditExempt: boolean; // true = small company — use effective tax rate hint
};

/**
 * Rationales for each suggested assumption — one plain-English sentence each.
 */
export type AssumptionRationales = {
  revenue_growth_pct: string;
  cogs_growth_pct: string;
  opex_growth_pct: string;
  depreciation_method: string;
  tax_rate_pct: string;
};

/**
 * Return type of suggestAssumptions.
 * assumptions is a fully valid ProjectionAssumptions object (passes Zod parse).
 * rationales explains each suggestion in one sentence.
 */
export type AssumptionSuggestion = {
  assumptions: ProjectionAssumptions;
  rationales: AssumptionRationales;
};

// ── Zod schema for the AI's structured response ───────────────────────────────

// The AI returns both the numeric values and a rationale for each.
// custom_line_assumptions is always empty — the suggester operates at category level.
const AISuggestionSchema = z.object({
  revenue_growth_pct: z.number(),
  revenue_growth_rationale: z.string(),
  cogs_growth_pct: z.number(),
  cogs_growth_rationale: z.string(),
  opex_growth_pct: z.number(),
  opex_growth_rationale: z.string(),
  depreciation_method: z.enum(["straight_line", "reducing_balance"]),
  depreciation_method_rationale: z.string(),
  tax_rate_pct: z.number().min(0).max(100),
  tax_rate_rationale: z.string(),
});

// ── Internal helper: build category-level summary ─────────────────────────────

/**
 * Summarises classified accounts into a compact category-total map.
 * Sent to the AI instead of individual line items to minimise token usage.
 *
 * Returns a plain object with each SFRS category total as a formatted number.
 */
function buildAccountSummary(accounts: ClassifiedAccount[]): Record<string, string> {
  const categories = [
    "current_asset",
    "non_current_asset",
    "current_liability",
    "non_current_liability",
    "equity",
    "revenue",
    "expense",
  ] as const;

  const summary: Record<string, string> = {};
  for (const cat of categories) {
    const total = sumAccounts(accounts, cat);
    summary[cat] = total.toFixed(2);
  }
  return summary;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyses the entity's financial position and suggests projection assumptions.
 *
 * Steps:
 * 1. Build a category-level summary of classified accounts (token-efficient).
 * 2. RAG: retrieve Singapore economic context and tax guidance from ChromaDB.
 * 3. Call GPT-4.1-mini with the summary + RAG context.
 * 4. Parse and validate the AI response via Zod.
 * 5. Return validated assumptions + rationales.
 *
 * @param params - classifiedAccounts, companyType, isAuditExempt
 * @returns AssumptionSuggestion with validated assumptions and rationales
 */
export async function suggestAssumptions(
  params: SuggestAssumptionsParams
): Promise<AssumptionSuggestion> {
  const { classifiedAccounts, companyType, isAuditExempt } = params;

  // ── Langfuse: open parent trace for this suggestion run ────────────────────
  // One trace per suggestAssumptions() call.
  // The RAG span and the AI generation are both children of this trace.
  // flushLangfuse() is called in app/api/model/suggest-assumptions/route.ts.
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "assumption_suggestion",
    input: { account_count: classifiedAccounts.length, companyType, isAuditExempt },
  });

  // Step 1: Build compact account summary (no individual line items).
  const accountSummary = buildAccountSummary(classifiedAccounts);

  // Compute a simple gross margin indicator for the AI's COGS suggestion.
  // Gross margin = (revenue - cogs-like expenses) / revenue.
  // We pass this as context rather than asking the AI to compute it.
  const revenue = parseFloat(accountSummary["revenue"] ?? "0");
  const totalExpense = parseFloat(accountSummary["expense"] ?? "0");
  const impliedNetMarginPct =
    revenue > 0 ? (((revenue - totalExpense) / revenue) * 100).toFixed(1) : "N/A";

  // Step 2: RAG — retrieve Singapore economic and tax context.
  // Pass the parent trace so the RAG span appears under assumption_suggestion in Langfuse.
  const ragResults = await ragQuery(RAG_QUERY_ASSUMPTION, 4, trace);
  const ragContext =
    ragResults.length > 0
      ? ragResults.map((r) => r.text).join("\n\n---\n\n")
      : "No additional context retrieved from knowledge base.";

  // Default tax rate hint based on company profile.
  // Audit-exempt companies are typically small companies that qualify for
  // the partial exemption scheme (effective ~8.5% on first $200K).
  const taxRateHint = isAuditExempt
    ? `This is a small company qualifying for Singapore's partial tax exemption. Standard rate is ${SG_CORPORATE_TAX_RATE}% but effective rate on first SGD 200,000 chargeable income is approximately ${SG_SMALL_COMPANY_EFFECTIVE_TAX_RATE}%. Suggest a blended rate appropriate for a small company.`
    : `Standard Singapore corporate tax rate is ${SG_CORPORATE_TAX_RATE}%. Suggest ${SG_CORPORATE_TAX_RATE}% unless there is a specific reason to deviate.`;

  const systemPrompt = `You are a Singapore-qualified chartered accountant helping a client build a 3–5 year financial model.
Your task is to suggest reasonable projection assumptions based on the company's current financial position and Singapore economic context.

Rules:
- All growth rates are annual percentages. Use realistic, conservative values aligned with Singapore market norms.
- Singapore GDP growth typically runs 1–3% in stable years; higher-growth sectors (tech, professional services) may warrant 5–15%.
- COGS growth should generally track revenue growth or slightly below if margins are improving.
- OPEX growth is typically below revenue growth as companies gain operating leverage.
- Depreciation method: prefer straight_line for most assets; reducing_balance for technology assets that lose value quickly.
- Tax rate: Singapore corporate tax is ${SG_CORPORATE_TAX_RATE}%. Use ${SG_CORPORATE_TAX_RATE} unless partial exemption applies.
- Provide exactly one rationale sentence per field — concise, factual, specific to this company's numbers.
- Do NOT suggest negative growth unless the numbers clearly indicate a declining business.`;

  const userPrompt = `Company profile:
- Type: ${companyType}
- Audit exempt (small company): ${isAuditExempt}
- Implied net margin: ${impliedNetMarginPct}%

Financial position summary (SGD):
- Current assets:        ${accountSummary["current_asset"]}
- Non-current assets:    ${accountSummary["non_current_asset"]}
- Current liabilities:   ${accountSummary["current_liability"]}
- Non-current liabilities: ${accountSummary["non_current_liability"]}
- Equity:                ${accountSummary["equity"]}
- Total revenue:         ${accountSummary["revenue"]}
- Total expenses:        ${accountSummary["expense"]}

Tax guidance:
${taxRateHint}

Singapore economic context (from knowledge base):
${ragContext}

Suggest projection assumptions for this company. For each assumption, provide the value and a one-sentence rationale.`;

  // ── Langfuse: generation for the assumption suggestion call ────────────────
  const generation = trace.generation({
    name: "suggest_assumptions",
    model: SUGGESTION_MODEL,
    input: { system: systemPrompt, user: userPrompt },
  });

  // Step 3: Call GPT-4.1-mini with account summary + RAG context.
  const { object: aiSuggestion, usage } = await generateObject({
    model: openai(SUGGESTION_MODEL),
    schema: AISuggestionSchema,
    system: systemPrompt,
    prompt: userPrompt,
  });

  // ── Langfuse: close generation with output + token usage ───────────────────
  generation.end({
    output: aiSuggestion,
    usage: { input: usage.inputTokens, output: usage.outputTokens, total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
  });

  // Step 4: Build the validated ProjectionAssumptions object.
  // Parse through ProjectionAssumptionsSchema to ensure downstream type safety.
  const assumptions = ProjectionAssumptionsSchema.parse({
    revenue_growth_pct: aiSuggestion.revenue_growth_pct,
    cogs_growth_pct: aiSuggestion.cogs_growth_pct,
    opex_growth_pct: aiSuggestion.opex_growth_pct,
    depreciation_method: aiSuggestion.depreciation_method,
    tax_rate_pct: aiSuggestion.tax_rate_pct,
    custom_line_assumptions: [], // suggester always operates at category level
  });

  // Step 5: Return assumptions + rationales.
  const rationales: AssumptionRationales = {
    revenue_growth_pct: aiSuggestion.revenue_growth_rationale,
    cogs_growth_pct: aiSuggestion.cogs_growth_rationale,
    opex_growth_pct: aiSuggestion.opex_growth_rationale,
    depreciation_method: aiSuggestion.depreciation_method_rationale,
    tax_rate_pct: aiSuggestion.tax_rate_rationale,
  };

  // ── Langfuse: close parent trace ───────────────────────────────────────────
  trace.update({ output: { assumptions } });

  return { assumptions, rationales };
}
