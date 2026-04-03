/**
 * app/api/generate-fs/route.ts
 *
 * SSE API route for financial statement generation.
 *
 * What this route does:
 * 1. Accepts a POST request with { entity_id, fiscal_year_id, file_url, entity,
 *    fiscal_year, exemption_input }
 * 2. Runs the full FS pipeline inline, streaming SSE progress events to the client
 *    after each step completes
 * 3. The frontend WorkflowPanel connects to this stream and updates the Progress Panel
 *    in real time as each step moves from pending → in_progress → complete / error
 *
 * SSE setup:
 * - Returns Content-Type: text/event-stream
 * - Each event is a JSON-encoded progress object: { step, status, message, timestamp }
 * - The stream is closed after the final step (complete or error)
 * - Uses Web Streams API (ReadableStream + TransformStream), compatible with Next.js
 *   App Router edge/Node runtimes
 *
 * Design note on Trigger.dev:
 * The Trigger.dev task (trigger/fsGenerationJob.ts) is the canonical background job
 * definition. This SSE route runs the same pipeline inline so that the frontend can
 * receive real-time progress via SSE — Trigger.dev cloud execution and SSE streaming
 * are complementary: Trigger.dev provides durability/retries; this route provides
 * the real-time UI feedback stream.
 *
 * Called by: components/WorkflowPanel.tsx on Generate button click.
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFile } from "fs/promises";
import os from "os";
import { parseTrialBalance } from "@/lib/excelParser";
import { classifyAccounts } from "@/lib/accountClassifier";
import { checkExemption } from "@/lib/exemptionChecker";
import { generateFinancialStatements } from "@/lib/fsGenerator";
import { saveGeneratedFS } from "@/lib/outputStorage";
import { generateSchemaName } from "@/lib/schemaUtils";
import { flushLangfuse } from "@/lib/langfuse";
import {
  EntitySchema,
  FiscalYearSchema,
  ExemptionInputSchema,
} from "@/lib/schemas";

// Progress event type — matches what WorkflowPanel expects
export type ProgressEvent = {
  step: string;
  status: "pending" | "in_progress" | "complete" | "error";
  message: string;
  timestamp: string;
};

/**
 * POST /api/generate-fs
 *
 * Request body (JSON):
 * {
 *   entity_id: string,
 *   fiscal_year_id: string,
 *   file_data: string,          // base64-encoded Excel file content
 *   file_name: string,          // original filename (e.g. "trial_balance.xlsx")
 *   entity: Entity,             // full entity object
 *   fiscal_year: FiscalYear,    // full fiscal year object
 *   exemption_input: {          // inputs for audit exemption check
 *     revenue: number,
 *     total_assets: number,
 *     employee_count: number,
 *     has_corporate_shareholders: boolean,
 *     shareholder_count: number
 *   }
 * }
 *
 * Response: text/event-stream
 * Each SSE event: data: <JSON ProgressEvent>\n\n
 * Final event when complete: data: { step: "complete", status: "complete", ... }\n\n
 */
export async function POST(req: NextRequest): Promise<Response> {
  // Parse and validate the request body
  let body: {
    entity_id: string;
    fiscal_year_id: string;
    file_data: string;
    file_name: string;
    entity: unknown;
    fiscal_year: unknown;
    exemption_input: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate entity and fiscal_year shapes
  const entityParse = EntitySchema.safeParse(body.entity);
  if (!entityParse.success) {
    return NextResponse.json(
      { error: "Invalid entity: " + entityParse.error.message },
      { status: 400 }
    );
  }

  const fiscalYearParse = FiscalYearSchema.safeParse(body.fiscal_year);
  if (!fiscalYearParse.success) {
    return NextResponse.json(
      { error: "Invalid fiscal_year: " + fiscalYearParse.error.message },
      { status: 400 }
    );
  }

  const exemptionParse = ExemptionInputSchema.safeParse(body.exemption_input);
  if (!exemptionParse.success) {
    return NextResponse.json(
      { error: "Invalid exemption_input: " + exemptionParse.error.message },
      { status: 400 }
    );
  }

  const entity = entityParse.data;
  const fiscalYear = fiscalYearParse.data;
  const exemptionInput = exemptionParse.data;

  // ── Set up the SSE stream ────────────────────────────────────────────────
  // ReadableStream with a TransformStream allows us to push events from inside
  // the async pipeline and have them immediately flushed to the client.
  //
  // The controller.enqueue() calls push SSE-formatted data chunks into the stream.
  // Each chunk is: "data: <JSON>\n\n" — the standard SSE event format.

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Helper: sends one SSE event to the client
      function send(event: ProgressEvent): void {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }

      try {
        // ── Step 1: Save uploaded file to a temp path ──────────────────
        // The file is sent as base64 from the frontend.
        // We write it to a temp file so excelParser.ts can read it from disk.
        send({
          step: "parse_excel",
          status: "in_progress",
          message: "Saving uploaded file and parsing trial balance...",
          timestamp: new Date().toISOString(),
        });

        const fileBuffer = Buffer.from(body.file_data, "base64");
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `finagent_${Date.now()}_${body.file_name}`);
        await writeFile(tempFilePath, fileBuffer);

        // ── Step 2: Parse the trial balance Excel file ─────────────────
        const trialBalanceLines = await parseTrialBalance(tempFilePath);
        send({
          step: "parse_excel",
          status: "complete",
          message: `Parsed ${trialBalanceLines.length} trial balance lines. Debits = Credits.`,
          timestamp: new Date().toISOString(),
        });

        // ── Step 3: Classify accounts ──────────────────────────────────
        send({
          step: "classify_accounts",
          status: "in_progress",
          message: `Classifying ${trialBalanceLines.length} accounts against SFRS standards...`,
          timestamp: new Date().toISOString(),
        });

        const classifiedAccounts = await classifyAccounts(trialBalanceLines);
        send({
          step: "classify_accounts",
          status: "complete",
          message: `All ${classifiedAccounts.length} accounts classified per SFRS.`,
          timestamp: new Date().toISOString(),
        });

        // ── Step 4: Check audit exemption ──────────────────────────────
        send({
          step: "check_exemption",
          status: "in_progress",
          message: "Checking audit exemption eligibility (Small Company + EPC criteria)...",
          timestamp: new Date().toISOString(),
        });

        const exemptionResult = checkExemption(exemptionInput);
        send({
          step: "check_exemption",
          status: "complete",
          message: exemptionResult.is_audit_exempt
            ? "Audit Exempt: qualifies as Small Company and EPC."
            : "Not Audit Exempt: statutory audit required.",
          timestamp: new Date().toISOString(),
        });

        // ── Step 5: Generate financial statements ──────────────────────
        send({
          step: "generate_fs",
          status: "in_progress",
          message: "Generating financial statements (Balance Sheet, P&L, Cash Flow, Equity, Notes)...",
          timestamp: new Date().toISOString(),
        });

        const fsOutput = await generateFinancialStatements({
          entity,
          fiscal_year: fiscalYear,
          classified_accounts: classifiedAccounts,
          exemption_result: exemptionResult,
        });

        send({
          step: "generate_fs",
          status: "complete",
          message: "Financial statements generated successfully.",
          timestamp: new Date().toISOString(),
        });

        // ── Step 6: Save to Supabase ───────────────────────────────────
        send({
          step: "save_output",
          status: "in_progress",
          message: "Saving to database...",
          timestamp: new Date().toISOString(),
        });

        const schemaName = generateSchemaName(entity.name);
        await saveGeneratedFS({
          schemaName,
          fiscalYearId: body.fiscal_year_id,
          fsOutput,
          classifiedAccounts,
          exemptionResult,
          pdfBase64: null, // PDF is generated on demand via /api/generate-pdf; not saved here
        });

        send({
          step: "save_output",
          status: "complete",
          message: "Output saved to database.",
          timestamp: new Date().toISOString(),
        });

        // ── Step 8: Complete ───────────────────────────────────────────
        // Send the final completion event with the output embedded.
        // The frontend uses this to enable the download buttons.
        send({
          step: "complete",
          status: "complete",
          message: "All steps complete. Download your financial statements below.",
          timestamp: new Date().toISOString(),
          // Include fs_output and exemption_result in the final event
          // so the frontend can use them to trigger PDF download
          ...{ fs_output: fsOutput, exemption_result: exemptionResult },
        } as ProgressEvent & { fs_output: unknown; exemption_result: unknown });

      } catch (err) {
        // On any error: emit an error event with the step context, then close the stream.
        // The frontend shows this error in the Progress Panel.
        send({
          step: "error",
          status: "error",
          message: `Pipeline error: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        });
      } finally {
        // Flush all Langfuse traces before closing the stream.
        // Must be called here (not inside lib files) so events reach Langfuse
        // before the HTTP connection closes.
        await flushLangfuse();
        // Always close the stream when done (success or error)
        controller.close();
      }
    },
  });

  // Return the SSE response with the correct headers.
  // Cache-Control: no-cache prevents buffering by proxies and CDNs.
  // X-Accel-Buffering: no disables nginx proxy buffering (important for Vercel).
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
