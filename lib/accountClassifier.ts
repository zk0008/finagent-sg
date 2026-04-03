/**
 * lib/accountClassifier.ts
 *
 * AI-powered SFRS account classifier for FinAgent-SG.
 *
 * What this module does:
 * Takes each TrialBalanceLine and uses GPT-4.1-mini + RAG to determine
 * the correct SFRS category for that account. Returns ClassifiedAccount[]
 * with the sfrs_category and a confidence score (0–1).
 *
 * Design:
 * - RAG query retrieves relevant SFRS classification rules from ChromaDB
 *   before each AI call, giving the model authoritative accounting context.
 * - GPT-4.1-mini is used (cost-efficient for high-volume classification).
 * - The LLM returns structured JSON parsed via Zod — it never computes numbers.
 * - Accounts are classified one at a time to isolate errors per line.
 *
 * Langfuse tracing (Phase 5):
 * - One trace per classifyAccounts() call ("account_classification").
 * - One child generation per account — tracks model, input prompt, output
 *   (sfrs_category + confidence), and token usage.
 * - One child span per ragQuery() call — see lib/ragQuery.ts.
 * - flushLangfuse() is called in the API route, not here.
 *
 * Called by: trigger/fsGenerationJob.ts (Task 6) in Step 2 of the pipeline.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ragQuery } from "./ragQuery";
import {
  ClassifiedAccountSchema,
  SfrsCategoryEnum,
  type TrialBalanceLine,
  type ClassifiedAccount,
} from "./schemas";
import { MODEL_ROUTES } from "./modelRouter";
import { getLangfuse } from "./langfuse";

// Model sourced from centralised router (Phase 5).
// Previously hardcoded as "gpt-4.1-mini".
const CLASSIFICATION_MODEL = MODEL_ROUTES.account_classification;

// RAG query used to retrieve SFRS account classification rules.
// This is fixed per call — we want the same SFRS rules for every account.
const SFRS_CLASSIFICATION_QUERY =
  "SFRS Singapore account classification current assets non-current liabilities equity revenue expenses";

/**
 * Classifies an array of trial balance lines into SFRS categories using AI + RAG.
 *
 * @param lines - Parsed trial balance lines from excelParser.ts
 * @returns Array of ClassifiedAccount with sfrs_category and confidence added
 */
export async function classifyAccounts(
  lines: TrialBalanceLine[]
): Promise<ClassifiedAccount[]> {
  // ── Langfuse: open parent trace for this classification run ────────────────
  // One trace per classifyAccounts() call — contains one generation per account.
  // flushLangfuse() is called in app/api/generate-fs/route.ts, not here.
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "account_classification",
    input: { account_count: lines.length },
  });

  // Step 1: Retrieve SFRS classification rules from the RAG knowledge base.
  // We fetch these once (not per account) since the same rules apply to all accounts.
  // RAG context is injected into the system prompt so the model has authoritative
  // Singapore accounting standards to reference when classifying each account.
  const ragResults = await ragQuery(SFRS_CLASSIFICATION_QUERY, 8, trace);

  const ragContext =
    ragResults.length > 0
      ? ragResults.map((r) => r.text).join("\n\n---\n\n")
      : "No SFRS knowledge base content found. Use your general SFRS knowledge.";

  // Step 2: Build the system prompt with RAG context injected.
  // The model is told to behave as an SFRS expert and is given the retrieved rules.
  // Structured output (generateObject) ensures the response is always valid JSON.
  const systemPrompt = `You are an expert Singapore accountant specialising in SFRS (Singapore Financial Reporting Standards).

Your task is to classify a trial balance account into exactly one of these SFRS categories:
- current_asset: cash, receivables due within 12 months, inventory, prepayments
- non_current_asset: PPE, intangibles, long-term investments, long-term receivables
- current_liability: payables due within 12 months, short-term loans, accruals, tax payable
- non_current_liability: long-term loans, deferred tax, finance leases > 12 months
- equity: share capital, retained earnings, reserves
- revenue: sales, service income, interest income, other income
- expense: COGS, operating expenses, depreciation, finance costs, tax expense

Use the following SFRS reference content retrieved from the knowledge base to guide your classification:

--- SFRS KNOWLEDGE BASE ---
${ragContext}
--- END KNOWLEDGE BASE ---

Return only the sfrs_category and a confidence score between 0 and 1.
confidence = 1.0 means you are certain; 0.5 means ambiguous; below 0.6 should be flagged for review.`;

  // Step 3: Classify each account individually.
  // We process accounts sequentially (not in parallel) to avoid rate-limit spikes.
  const classified: ClassifiedAccount[] = [];

  for (const line of lines) {
    // Build the user prompt for this specific account line.
    // We include both the code and name because the code prefix (e.g. "1xxx" = assets)
    // provides additional signal that helps the model classify correctly.
    const userPrompt = `Classify this Singapore trial balance account:
Account Code: ${line.account_code}
Account Name: ${line.account_name}
Debit balance: ${line.debit.toFixed(2)}
Credit balance: ${line.credit.toFixed(2)}

Determine the correct SFRS category and your confidence level.`;

    // ── Langfuse: open generation for this account ─────────────────────────
    // Tracks the AI call for each account individually so per-account
    // latency, token cost, and classification confidence are visible.
    const generation = trace.generation({
      name: "classify_account",
      model: CLASSIFICATION_MODEL,
      input: { system: systemPrompt, user: userPrompt },
      metadata: { account_code: line.account_code, account_name: line.account_name },
    });

    // Step 4: Call GPT-4.1-mini with structured output.
    // generateObject enforces the response schema via JSON mode — no parsing errors.
    const { object, usage } = await generateObject({
      model: openai(CLASSIFICATION_MODEL),
      system: systemPrompt,
      prompt: userPrompt,
      schema: z.object({
        sfrs_category: SfrsCategoryEnum,
        confidence: z.number().min(0).max(1),
      }),
    });

    // ── Langfuse: close generation with output + token usage ───────────────
    generation.end({
      output: object,
      usage: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    });

    // Step 5: Merge the AI output with the original line data and validate via Zod.
    const parseResult = ClassifiedAccountSchema.safeParse({
      account_code: line.account_code,
      account_name: line.account_name,
      debit: line.debit,
      credit: line.credit,
      sfrs_category: object.sfrs_category,
      confidence: object.confidence,
    });

    if (!parseResult.success) {
      // If the merged object somehow fails validation, use a fallback with low confidence.
      // This should not happen in practice since generateObject enforces the schema,
      // but it prevents the pipeline from crashing on an unexpected AI response.
      classified.push({
        account_code: line.account_code,
        account_name: line.account_name,
        debit: line.debit,
        credit: line.credit,
        sfrs_category: "expense", // conservative fallback
        confidence: 0,
      });
    } else {
      classified.push(parseResult.data);
    }
  }

  // ── Langfuse: close parent trace ───────────────────────────────────────────
  trace.update({ output: { classified_count: classified.length } });

  return classified;
}
