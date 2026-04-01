/**
 * app/api/model/run/route.ts
 *
 * POST /api/model/run  →  text/event-stream (SSE)
 *
 * What this route does:
 * Runs financial projections for all three scenarios (base, best, worst) and
 * streams progress events to the client. The final "complete" event includes
 * the full results object so the frontend can display results and proceed to save.
 *
 * Uses the LATEST saved FS output automatically — no output ID picker.
 * All projection arithmetic is deterministic (no AI); scenario deltas are
 * applied by scenarioAnalysis.ts.
 *
 * Phase 3, Prompt 8 — model run SSE endpoint.
 *
 * Request body:
 * {
 *   schemaName:       string,
 *   assumptions:      ProjectionAssumptions,
 *   projection_years: number (1–5),
 *   base_year:        number  (e.g. 2025)
 * }
 *
 * SSE events (JSON):
 * { step, status, message, timestamp, results?, source_output_id? }
 *
 * Steps: load_base_data → base_case → best_case → worst_case → complete
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { getLatestFSOutput } from "@/lib/modelStorage";
import { projectFinancials } from "@/lib/projectionEngine";
import { generateScenarios } from "@/lib/scenarioAnalysis";
import { ProjectionAssumptionsSchema } from "@/lib/schemas";

const RequestSchema = z.object({
  schemaName:       z.string().min(1),
  assumptions:      ProjectionAssumptionsSchema,
  projection_years: z.number().int().min(1).max(5),
  base_year:        z.number().int().min(2000).max(2100),
});

// timestamp is injected by send() — callers do not need to provide it
type SSEEvent = {
  step:              string;
  status:            "in_progress" | "complete" | "error";
  message:           string;
  timestamp?:        string;
  results?:          unknown;
  source_output_id?: string;
};

export async function POST(req: NextRequest): Promise<Response> {
  // Parse request body synchronously before opening the stream
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { schemaName, assumptions, projection_years, base_year } = body;

  // Build the SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: SSEEvent): void {
        const data = `data: ${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n\n`;
        controller.enqueue(new TextEncoder().encode(data));
      }

      function sendError(step: string, message: string): void {
        send({ step, status: "error", message });
        controller.close();
      }

      try {
        // ── Step 1: Load base data ──────────────────────────────────────
        send({ step: "load_base_data", status: "in_progress", message: "Loading base financial data..." });

        const latestOutput = await getLatestFSOutput(schemaName);
        if (!latestOutput) {
          sendError(
            "load_base_data",
            "No financial statements found. Please generate FS first."
          );
          return;
        }

        const classifiedAccounts = latestOutput.classified_accounts;
        send({
          step:    "load_base_data",
          status:  "complete",
          message: `Loaded ${classifiedAccounts.length} classified accounts.`,
        });

        // ── Step 2: Base case ────────────────────────────────────────────
        send({ step: "base_case", status: "in_progress", message: "Running base case projections..." });

        const base_case = projectFinancials({
          classifiedAccounts,
          assumptions,
          projectionYears: projection_years,
          baseYear:        base_year,
        });

        send({
          step:    "base_case",
          status:  "complete",
          message: `Base case: ${projection_years} year(s) projected.`,
        });

        // ── Step 3: Best case ────────────────────────────────────────────
        send({ step: "best_case", status: "in_progress", message: "Running best case projections..." });

        const { best_case: bestAssumptions, worst_case: worstAssumptions } =
          generateScenarios(assumptions);

        const best_case = projectFinancials({
          classifiedAccounts,
          assumptions:     bestAssumptions,
          projectionYears: projection_years,
          baseYear:        base_year,
        });

        send({ step: "best_case", status: "complete", message: "Best case complete." });

        // ── Step 4: Worst case ───────────────────────────────────────────
        send({ step: "worst_case", status: "in_progress", message: "Running worst case projections..." });

        const worst_case = projectFinancials({
          classifiedAccounts,
          assumptions:     worstAssumptions,
          projectionYears: projection_years,
          baseYear:        base_year,
        });

        send({ step: "worst_case", status: "complete", message: "Worst case complete." });

        // ── Complete ─────────────────────────────────────────────────────
        send({
          step:             "complete",
          status:           "complete",
          message:          "All scenarios complete.",
          results:          { base_case, best_case, worst_case },
          source_output_id: latestOutput.id,
        });
      } catch (err) {
        sendError("complete", err instanceof Error ? err.message : "Projection run failed.");
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      Connection:      "keep-alive",
    },
  });
}
