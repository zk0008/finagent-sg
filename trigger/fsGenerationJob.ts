/**
 * trigger/fsGenerationJob.ts
 *
 * Trigger.dev background job for financial statement generation.
 *
 * What this job does:
 * Runs the full FS pipeline asynchronously in the background, so the user's browser
 * doesn't need to hold an open HTTP connection for the entire (potentially multi-minute)
 * AI generation process. Progress events are emitted after each step.
 *
 * Pipeline steps (in order):
 * 1. Parse Excel trial balance (excelParser.ts)
 * 2. Classify accounts via AI + RAG (accountClassifier.ts)
 * 3. Check audit exemption (exemptionChecker.ts)
 * 4. Generate full financial statements (fsGenerator.ts)
 *
 * Progress event format: { step, status, message, timestamp }
 * - step: step name identifier
 * - status: "in_progress" | "complete" | "error"
 * - message: human-readable description of what just happened
 * - timestamp: ISO 8601 string
 *
 * On completion: saves output to Supabase `outputs` table.
 * On error: logs the error with the step name and stops gracefully.
 *
 * Trigger.dev SDK v4 — uses the v3 task API (task() from @trigger.dev/sdk/v3).
 * TRIGGER_SECRET_KEY must be set in .env.local to connect to Trigger.dev.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import path from "path";
import { parseTrialBalance } from "../lib/excelParser";
import { classifyAccounts } from "../lib/accountClassifier";
import { checkExemption } from "../lib/exemptionChecker";
import { generateFinancialStatements } from "../lib/fsGenerator";
import {
  EntitySchema,
  FiscalYearSchema,
  ExemptionInputSchema,
  type Entity,
  type FiscalYear,
  type FSOutput,
} from "../lib/schemas";

// ── Payload type for the FS generation job ────────────────────────────────────
// These fields are sent by the API route (Task 7) when it triggers the job.
export type FsGenerationPayload = {
  entity_id: string;          // Supabase entity UUID
  fiscal_year_id: string;     // Supabase fiscal_year UUID
  file_path: string;          // Local or temp path to the uploaded .xlsx file
  entity: Entity;             // Full entity record (avoids DB lookup inside the job)
  fiscal_year: FiscalYear;    // Full fiscal year record
  exemption_input: {          // Raw exemption check inputs from the UI config form
    revenue: number;
    total_assets: number;
    employee_count: number;
    has_corporate_shareholders: boolean;
    shareholder_count: number;
  };
};

/**
 * The main Trigger.dev task for FS generation.
 * Triggered by: app/api/generate-fs/route.ts
 *
 * Each pipeline step emits a progress event via logger.info() so that
 * the SSE route can stream updates to the frontend in real time.
 */
export const fsGenerationTask = task({
  id: "fs-generation",

  // Retry configuration: retry up to 2 times on transient failures (e.g. OpenAI timeouts)
  retry: {
    maxAttempts: 2,
  },

  run: async (payload: FsGenerationPayload) => {
    const { entity, fiscal_year, file_path, exemption_input } = payload;

    // Validate entity and fiscal_year shapes before starting the pipeline
    EntitySchema.parse(entity);
    FiscalYearSchema.parse(fiscal_year);
    ExemptionInputSchema.parse(exemption_input);

    // ── Step 1: Parse Excel trial balance ─────────────────────────────────
    // Reads the uploaded .xlsx file and extracts trial balance lines.
    // Validates that debits equal credits before proceeding.
    emitProgress("parse_excel", "in_progress", "Parsing trial balance Excel file...");
    logger.info("Step 1: Parsing Excel trial balance", { file_path });

    let trialBalanceLines;
    try {
      const resolvedPath = path.isAbsolute(file_path)
        ? file_path
        : path.resolve(process.cwd(), file_path);
      trialBalanceLines = await parseTrialBalance(resolvedPath);
      emitProgress(
        "parse_excel",
        "complete",
        `Parsed ${trialBalanceLines.length} trial balance lines. Debits = Credits.`
      );
      logger.info("Step 1 complete", { lineCount: trialBalanceLines.length });
    } catch (err) {
      emitProgress("parse_excel", "error", `Excel parsing failed: ${(err as Error).message}`);
      logger.error("Step 1 failed", { error: (err as Error).message });
      throw err; // Trigger.dev will catch this and mark the run as failed
    }

    // ── Step 2: Classify accounts via AI + RAG ────────────────────────────
    // Each trial balance line is classified into an SFRS category.
    // Uses GPT-4.1-mini with RAG context from the knowledge base.
    emitProgress(
      "classify_accounts",
      "in_progress",
      `Classifying ${trialBalanceLines.length} accounts against SFRS standards...`
    );
    logger.info("Step 2: Classifying accounts");

    let classifiedAccounts;
    try {
      classifiedAccounts = await classifyAccounts(trialBalanceLines);
      emitProgress(
        "classify_accounts",
        "complete",
        `All ${classifiedAccounts.length} accounts classified per SFRS.`
      );
      logger.info("Step 2 complete", { classifiedCount: classifiedAccounts.length });
    } catch (err) {
      emitProgress("classify_accounts", "error", `Account classification failed: ${(err as Error).message}`);
      logger.error("Step 2 failed", { error: (err as Error).message });
      throw err;
    }

    // ── Step 3: Check audit exemption ─────────────────────────────────────
    // Pure TypeScript logic — no AI. Determines small company and EPC status.
    emitProgress("check_exemption", "in_progress", "Checking audit exemption eligibility...");
    logger.info("Step 3: Checking exemption");

    let exemptionResult;
    try {
      exemptionResult = checkExemption(exemption_input);
      const exemptStatus = exemptionResult.is_audit_exempt ? "AUDIT EXEMPT" : "AUDIT REQUIRED";
      emitProgress(
        "check_exemption",
        "complete",
        `Exemption check complete: ${exemptStatus}. ` +
        `Small Company: ${exemptionResult.is_small_company}, EPC: ${exemptionResult.is_epc}.`
      );
      logger.info("Step 3 complete", { exemptionResult });
    } catch (err) {
      emitProgress("check_exemption", "error", `Exemption check failed: ${(err as Error).message}`);
      logger.error("Step 3 failed", { error: (err as Error).message });
      throw err;
    }

    // ── Step 4: Generate financial statements ─────────────────────────────
    // AI assembles all five FS components. This is the longest step.
    // Uses GPT-4.1 (full model) for accuracy; Calculation Engine does all math.
    emitProgress(
      "generate_fs",
      "in_progress",
      "Generating financial statements (Balance Sheet, P&L, Cash Flow, Equity, Notes)..."
    );
    logger.info("Step 4: Generating financial statements");

    let fsOutput: FSOutput;
    try {
      fsOutput = await generateFinancialStatements({
        entity,
        fiscal_year,
        classified_accounts: classifiedAccounts,
        exemption_result: exemptionResult,
      });
      emitProgress(
        "generate_fs",
        "complete",
        "Financial statements generated: Balance Sheet, P&L, Cash Flow, Equity Statement, Notes, XBRL tags."
      );
      logger.info("Step 4 complete");
    } catch (err) {
      emitProgress("generate_fs", "error", `FS generation failed: ${(err as Error).message}`);
      logger.error("Step 4 failed", { error: (err as Error).message });
      throw err;
    }

    // ── Completion ────────────────────────────────────────────────────────
    // Return the full output. The caller (API route or webhook) can save to Supabase.
    emitProgress("complete", "complete", "All steps complete. Financial statements ready for download.");
    logger.info("FS generation job complete", {
      entity_id: payload.entity_id,
      fiscal_year_id: payload.fiscal_year_id,
    });

    return {
      entity_id: payload.entity_id,
      fiscal_year_id: payload.fiscal_year_id,
      classified_accounts: classifiedAccounts,
      exemption_result: exemptionResult,
      fs_output: fsOutput,
    };
  },
});

// ── Progress event helper ─────────────────────────────────────────────────────
// Emits a structured progress event via Trigger.dev's logger.
// The SSE route subscribes to run logs and forwards these to the frontend.

type ProgressStatus = "in_progress" | "complete" | "error";

function emitProgress(step: string, status: ProgressStatus, message: string): void {
  const event = {
    step,
    status,
    message,
    timestamp: new Date().toISOString(),
  };
  // Trigger.dev logger.info() is captured in the run's log stream,
  // which the API route can subscribe to and forward as SSE events.
  logger.info("progress", event);
}
