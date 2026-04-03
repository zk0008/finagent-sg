/**
 * lib/modelRouter.ts
 *
 * Centralised model routing for FinAgent-SG (Phase 5).
 *
 * What this module does:
 * Provides a single config object (MODEL_ROUTES) that maps each task type
 * to the appropriate OpenAI model. All AI-calling files import their model
 * from here instead of hardcoding strings — so changing a model means
 * editing one line rather than hunting across multiple files.
 *
 * Routing rationale:
 * - gpt-4.1         Used for accuracy-critical tasks where errors cause ACRA
 *                   filing rejections or material misstatements. Cost is
 *                   secondary to correctness.
 * - gpt-4.1-mini    Used for high-volume or advisory tasks where GPT-4.1-mini
 *                   is sufficient and cost efficiency matters. The user always
 *                   reviews the output before it is acted on (assumptions,
 *                   chat) or the task is repetitive with a structured schema
 *                   that constrains the model (classification).
 *
 * fine_tuned_model:
 * Leave this empty string until fine-tuning completes (Phase 5, Task 6).
 * When a fine-tuned model is ready, copy its model ID from platform.openai.com
 * into this field. The chat route will then prefer it over gpt-4.1-mini.
 *
 * How to use:
 *   import { MODEL_ROUTES } from "@/lib/modelRouter";
 *   model: openai(MODEL_ROUTES.account_classification)
 */

// Route each task to the appropriate model.
// GPT-4.1 for accuracy-critical tasks.
// GPT-4.1-mini for cost-efficient tasks.
export const MODEL_ROUTES = {
  fs_generation: "gpt-4.1",            // 5 FS steps — ACRA filing accuracy critical
  account_classification: "gpt-4.1-mini", // Per-account SFRS classification — high volume
  assumption_suggestion: "gpt-4.1-mini",  // Advisory only — user reviews before engine runs
  notes_generation: "gpt-4.1",          // Notes require full compliance accuracy
  chat_response: "gpt-4.1-mini",        // Chat answers and correction detection
  fine_tuned_model: "",                  // Populate when fine-tuned model is ready (Phase 5 Task 6)
} as const;

export type ModelRouteKey = keyof typeof MODEL_ROUTES;
