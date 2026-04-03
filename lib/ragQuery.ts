/**
 * lib/ragQuery.ts
 *
 * RAG (Retrieval-Augmented Generation) query pipeline for FinAgent-SG.
 *
 * What this module does:
 * Given a natural language question, it:
 * 1. Converts the question to an embedding using OpenAI text-embedding-3-small
 * 2. Queries the `sfrs_knowledge` ChromaDB collection for the most similar chunks
 * 3. Returns an array of RagResult objects, ranked by similarity (closest first)
 *
 * When this will be called (Phase 2+):
 * - Before each AI agent step, to retrieve relevant SFRS rules, IRAS guidance,
 *   and ACRA filing requirements to include in the LLM prompt context
 * - Example: before classifying trial balance accounts, the agent calls ragQuery()
 *   with "SFRS classification of current vs non-current assets" to get the relevant rules
 *
 * The embedding model must match the one used during ingestion (ingest.ts).
 * Both use: text-embedding-3-small
 *
 * Langfuse tracing (Phase 5):
 * - An optional parent trace can be passed from the caller (accountClassifier,
 *   fsGenerator, assumptionSuggester) so RAG spans appear under the parent trace.
 * - Tracked per call: question, nResults requested, result count, top distance score.
 * - If no parent is passed, a standalone trace is created.
 * - flushLangfuse() is called in the API route, not here.
 */

import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { chromaClient } from "./chromaClient";
import { type RagResult } from "./schemas";
import { getLangfuse } from "./langfuse";
import type { LangfuseTraceClient } from "langfuse";

// Must match the model used in scripts/ingest.ts
const EMBEDDING_MODEL = "text-embedding-3-small";

const COLLECTION_NAME = "sfrs_knowledge";

/**
 * Queries the RAG knowledge base and returns the most relevant document chunks.
 *
 * @param question - The natural language question to search for
 * @param nResults - Number of results to return (default: 5)
 * @param parentTrace - Optional Langfuse trace to attach the span to
 * @returns Array of RagResult, ordered by ascending distance (most relevant first)
 *
 * Returns an empty array if the collection is empty or ChromaDB is unreachable.
 */
export async function ragQuery(
  question: string,
  nResults: number = 5,
  parentTrace?: LangfuseTraceClient
): Promise<RagResult[]> {
  // ── Langfuse: open span for this RAG query ─────────────────────────────────
  // Uses a span (not a generation) because ChromaDB is not an LLM call.
  // Tracks latency, how many results were retrieved, and the top similarity score.
  // If a parent trace is provided, this span is a child of it (e.g. under
  // account_classification or fs_generation). Otherwise, a standalone trace is used.
  const langfuse = getLangfuse();
  const traceForSpan = parentTrace ?? langfuse.trace({ name: "rag_query_standalone" });
  const span = traceForSpan.span({
    name: "rag_query",
    input: { question, nResults },
  });

  // Step 1: Embed the question using the same model used during ingestion.
  // This converts the question into the same vector space as the stored chunks,
  // so similarity search finds semantically related content (not just keyword matches).
  const { embedding } = await embed({
    model: openai.embedding(EMBEDDING_MODEL),
    value: question,
  });

  // Step 2: Get the ChromaDB collection.
  // We use getOrCreateCollection to avoid errors if the collection is empty —
  // querying an empty collection returns zero results gracefully.
  const collection = await chromaClient.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: null,
  });

  // Step 3: Run the similarity search.
  // queryEmbeddings: pre-computed embedding (number[]) — skips ChromaDB's own embedding step.
  // include: we want the document text, metadata, and distance scores in the result.
  const results = await collection.query({
    queryEmbeddings: [embedding as number[]],
    nResults,
    include: ["documents", "metadatas", "distances"] as any,
  });

  // Step 4: Reshape ChromaDB's columnar response into RagResult objects.
  // ChromaDB returns parallel arrays: documents[0], metadatas[0], distances[0]
  // all indexed by result position.
  const docs = results.documents?.[0] ?? [];
  const metas = results.metadatas?.[0] ?? [];
  const distances = results.distances?.[0] ?? [];

  const ragResults: RagResult[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const meta = metas[i] as Record<string, unknown> | null;

    if (!doc || !meta) continue;

    ragResults.push({
      text: doc,
      source_file: String(meta.source_file ?? ""),
      chunk_index: Number(meta.chunk_index ?? 0),
      topic: String(meta.topic ?? ""),
      distance: distances[i] ?? 1,
    });
  }

  // ── Langfuse: close span with retrieval summary ────────────────────────────
  span.end({
    output: {
      result_count: ragResults.length,
      top_distance: ragResults[0]?.distance ?? null,
    },
  });

  return ragResults;
}
