/**
 * app/api/agent/route.ts
 *
 * Single entry point for the FinAgent-SG multi-agent system.
 * Called by the chat UI when a user submits a natural language goal.
 *
 * The LangGraph StateGraph runs entirely server-side. Progress is streamed
 * back to the client via SSE using the same ReadableStream + TextEncoder
 * pattern used by /api/generate-fs and /api/model/run.
 *
 * Langfuse observability (trace-level):
 * A single Langfuse trace wraps the full graph invocation. The goal, clientId,
 * and final summary are recorded as trace input/output.
 *
 * Note on per-node callback tracing:
 * langfuse-langchain (the LangChain callback adapter) requires @langchain/core@0.x,
 * which conflicts with @langchain/core@1.x used by LangGraph v1.x. It cannot be
 * installed without breaking the LangGraph dependency. Trace-level observability
 * via getLangfuse() is used instead — the overall agent run is recorded in Langfuse
 * without per-node granularity.
 *
 * SSE event shapes emitted:
 *   { event: "node:started",        data: { node: string } }
 *   { event: "node:complete",       data: { node: string, result: object } }
 *   { event: "node:error",          data: { node: string, error: string } }
 *   { event: "validation:missing",  data: { fields: string[] } }
 *   { event: "graph:complete",      data: { summary: string } }
 *   { event: "graph:error",         data: { error: string } }
 */

import { NextRequest } from "next/server";
import graph from "@/lib/agents/graph";
import { GraphState } from "@/lib/agents/state";
import { getLangfuse, flushLangfuse } from "@/lib/langfuse";

// The full state type inferred from the LangGraph Annotation
type AgentState = typeof GraphState.State;

export async function POST(req: NextRequest): Promise<Response> {
  // Parse the request body — all optional fields default to undefined / false
  let body: {
    goal: string;
    clientId: string;
    financialYear?: string;
    payrollMonth?: number;
    payrollYear?: number;
    yearOfAssessment?: string;
    projectionPeriodYears?: number;
    runFS?: boolean;
    runPayroll?: boolean;
    runTax?: boolean;
    runFinancialModel?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const {
    goal,
    clientId,
    financialYear,
    payrollMonth,
    payrollYear,
    yearOfAssessment,
    projectionPeriodYears,
    runFS             = false,
    runPayroll        = false,
    runTax            = false,
    runFinancialModel = false,
  } = body;

  if (!goal || !clientId) {
    return new Response(
      JSON.stringify({ error: "goal and clientId are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build the initial graph state; nodes will write their results into this as they run
  const initialState: AgentState = {
    goal,
    clientId,
    missingInputs:       [],      // validationNode populates this if inputs are incomplete
    runFS,
    runPayroll,
    runTax,
    runFinancialModel,
    financialYear,                // undefined if caller didn't provide it
    payrollMonth,
    payrollYear,
    yearOfAssessment,
    projectionPeriodYears,
    fsOutputId:          undefined,
    fsResult:            undefined,
    payrollResult:       undefined,
    taxResult:           undefined,
    financialModelResult: undefined,
    errors:              {},      // nodes write { nodeName: errorMessage } on failure
    fetchedContext:      {},      // nodes write plain-English descriptions of Supabase fetches
    summary:             undefined,
  };

  // ── SSE setup ──────────────────────────────────────────────────────────────
  // Same encoder/ReadableStream/controller pattern used by all SSE routes here
  const encoder = new TextEncoder();

  const sseStream = new ReadableStream({
    async start(controller) {
      // Encodes and enqueues one SSE data line — the payload is an embedded JSON object
      function send(payload: object): void {
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }

      // ── Langfuse trace ──────────────────────────────────────────────────
      // One trace per agent run; records the user's goal and the final summary.
      // This is trace-level observability — individual node calls are not traced
      // separately because langfuse-langchain conflicts with @langchain/core@1.x.
      const langfuse = getLangfuse();
      const trace = langfuse.trace({
        name:  "agent_run",
        input: { goal, clientId },  // what the user asked for
      });

      // Accumulate the final summary as it comes out of summaryNode
      let finalSummary: string | undefined;

      try {
        // ── Invoke the graph in streaming mode ──────────────────────────
        // streamMode "updates" → each chunk is { nodeName: partialStateUpdate }
        // so we can read the node name directly from the chunk key.
        // graph.stream() returns a Promise<IterableReadableStream> — must await
        // before the for-await loop or TypeScript cannot see the async iterator.
        const graphStream = await graph.stream(
          initialState,
          { streamMode: "updates" } as Parameters<typeof graph.stream>[1]
        );

        for await (const chunk of graphStream) {
          // Each chunk has exactly one key — the name of the node that just completed
          const nodeName   = Object.keys(chunk)[0];
          const nodeUpdate = (chunk as Record<string, Partial<AgentState>>)[nodeName];

          // Emit "started" first so the UI can show the running spinner,
          // then immediately follow with the completion result.
          // Both events arrive in the same TCP write but the EventSource API
          // delivers them as two distinct events, so the UI sees the transition.
          send({ event: "node:started", data: { node: nodeName } });

          // Check if this node recorded an error for itself in the errors map
          const errorsMap  = nodeUpdate?.errors as Record<string, string> | undefined;
          const nodeError  = errorsMap?.[nodeName];

          if (nodeError) {
            // Node ran but wrote a failure message — emit error event
            send({ event: "node:error", data: { node: nodeName, error: nodeError } });
          } else {
            // Node completed cleanly — send its partial state update as the result
            send({ event: "node:complete", data: { node: nodeName, result: nodeUpdate } });
          }

          // Special case: validationNode may stop the graph early
          if (nodeName === "validationNode") {
            const missing = nodeUpdate?.missingInputs;
            if (Array.isArray(missing) && missing.length > 0) {
              // Required inputs are missing — tell the UI which fields to ask for
              send({ event: "validation:missing", data: { fields: missing } });
              // Close the stream; the graph will route to END and no further nodes run
              controller.close();
              return;
            }
          }

          // Capture the summary as it comes out of summaryNode
          if (nodeUpdate?.summary) {
            finalSummary = nodeUpdate.summary;
          }
        }

        // ── Graph finished — emit the final completion event ─────────────
        send({
          event: "graph:complete",
          data:  { summary: finalSummary ?? "" },
        });

        // Record the run outcome in Langfuse
        trace.update({ output: { summary: finalSummary ?? "" } });

      } catch (err) {
        // Unhandled error in graph execution — emit and record
        send({
          event: "graph:error",
          data:  { error: (err as Error).message },
        });
        trace.update({ output: { error: (err as Error).message } });

      } finally {
        // Flush Langfuse events before closing — same rule as all other routes
        await flushLangfuse();
        controller.close();
      }
    },
  });

  // Return the SSE response with the same headers used by all other SSE routes
  return new Response(sseStream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",  // prevents nginx/Vercel from buffering the stream
    },
  });
}
