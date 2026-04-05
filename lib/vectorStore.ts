/**
 * lib/vectorStore.ts
 *
 * Environment-aware vector store router (Phase 6, Task 5).
 *
 * Development  (NODE_ENV === "development"): uses ChromaDB via Docker (lib/ragQuery.ts + lib/ingest.ts)
 * Production   (NODE_ENV === "production"):  uses pgvector via Supabase (lib/pgvectorClient.ts)
 *
 * Exports the same interface regardless of environment:
 *   queryVectorStore(question, nResults, parentTrace?) → Promise<RagResult[]>
 *   ingestToVectorStore(text, sourceId, topic)         → Promise<void>
 *
 * Callers (ragQuery.ts, ingest.ts, app/api/chat/route.ts) import from here
 * instead of calling ChromaDB directly, so the production swap is transparent.
 */

import type { LangfuseTraceClient } from "langfuse";
import { type RagResult } from "@/lib/schemas";

// ── queryVectorStore ──────────────────────────────────────────────────────────

export async function queryVectorStore(
  question: string,
  nResults: number = 5,
  parentTrace?: LangfuseTraceClient
): Promise<RagResult[]> {
  if (process.env.NODE_ENV === "production") {
    return queryPgVector(question, nResults, parentTrace);
  }
  // Development: use existing ragQuery (ChromaDB)
  const { ragQuery } = await import("@/lib/ragQuery");
  return ragQuery(question, nResults, parentTrace);
}

// ── ingestToVectorStore ───────────────────────────────────────────────────────

export async function ingestToVectorStore(
  text: string,
  sourceId: string,
  topic: string
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    return ingestToPgVector(text, sourceId, topic);
  }
  // Development: use existing ingestText (ChromaDB)
  const { ingestText } = await import("@/lib/ingest");
  await ingestText(text, sourceId, topic);
}

// ── pgvector implementations ──────────────────────────────────────────────────

async function queryPgVector(
  question: string,
  nResults: number,
  parentTrace?: LangfuseTraceClient
): Promise<RagResult[]> {
  const { embed } = await import("ai");
  const { openai } = await import("@ai-sdk/openai");
  const { queryEmbeddings } = await import("@/lib/pgvectorClient");

  const span = parentTrace?.span({ name: "rag_query_pgvector", input: { question, nResults } });

  try {
    const { embedding } = await embed({
      model: openai.embedding("text-embedding-3-small"),
      value: question,
    });

    const results = await queryEmbeddings(embedding, nResults);

    const ragResults: RagResult[] = results.map((r) => ({
      text: r.content,
      source_file: r.source_file ?? "unknown",
      chunk_index: r.chunk_index ?? 0,
      topic: r.topic ?? "general",
      distance: r.distance,
    }));

    span?.end({ output: { result_count: ragResults.length } });
    return ragResults;
  } catch (err) {
    span?.end({ output: { error: String(err) } });
    throw err;
  }
}

async function ingestToPgVector(
  text: string,
  sourceId: string,
  topic: string
): Promise<void> {
  const { embed } = await import("ai");
  const { openai } = await import("@ai-sdk/openai");
  const { upsertEmbedding } = await import("@/lib/pgvectorClient");

  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });

  await upsertEmbedding(text, embedding, {
    source_file: sourceId,
    chunk_index: 0,
    topic,
  });
}
