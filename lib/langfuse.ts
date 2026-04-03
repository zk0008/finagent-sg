/**
 * lib/langfuse.ts
 *
 * Singleton Langfuse client for FinAgent-SG observability (Phase 5).
 *
 * What Langfuse tracks in this project:
 * - account_classification  Every GPT-4.1-mini account classification call
 *   (one generation per account, one trace per classifyAccounts() call).
 * - fs_generation           Full FS pipeline — one parent trace with five child
 *   generations (balance sheet, P&L, cash flow, equity, notes).
 * - assumption_suggestion   GPT-4.1-mini projection assumption call.
 * - rag_query               ChromaDB similarity search span (not an LLM call —
 *   tracked as a span so latency and retrieval quality are visible).
 * - chat_response           GPT-4.1-mini chat / correction detection call.
 *
 * When each trace is called:
 * - Traces are opened in the lib/* file that performs the AI/RAG work.
 * - flushLangfuse() MUST be called at the end of the API route that triggers
 *   the work — NOT inside the lib file — so events are flushed before the
 *   HTTP response is returned or the SSE stream is closed.
 *
 * Configuration (all in .env.local):
 * - LANGFUSE_PUBLIC_KEY  Project public key from Langfuse dashboard
 * - LANGFUSE_SECRET_KEY  Project secret key from Langfuse dashboard
 * - LANGFUSE_HOST        URL of the self-hosted Langfuse server (default: http://localhost:3001)
 *
 * Self-hosted Langfuse runs via docker-compose.yml alongside ChromaDB.
 * Start with: docker compose --env-file docker-compose.env up -d
 */

import { Langfuse } from "langfuse";

// ── Singleton ──────────────────────────────────────────────────────────────────

let _langfuse: Langfuse | null = null;

/**
 * Returns the singleton Langfuse client, initialising it on first call.
 *
 * If LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY are not set, Langfuse is
 * initialised in a no-op state — it will not throw and will not send events.
 * This means the app works in development without Langfuse configured.
 */
export function getLangfuse(): Langfuse {
  if (!_langfuse) {
    _langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
      baseUrl: process.env.LANGFUSE_HOST ?? "http://localhost:3001",
      // Flush events to Langfuse immediately rather than batching them.
      // In server-side Next.js routes, the process may not stay alive long
      // enough for a background flush to complete.
      flushAt: 1,
    });
  }
  return _langfuse;
}

/**
 * Flushes all pending Langfuse events to the server.
 *
 * Call this at the END of every API route that triggers an instrumented
 * AI or RAG call. Do NOT call this inside lib/* files.
 *
 * Example usage in an API route:
 *   await doAiWork();
 *   await flushLangfuse();
 *   return NextResponse.json(result);
 */
export async function flushLangfuse(): Promise<void> {
  if (_langfuse) {
    await _langfuse.flushAsync();
  }
}
