/**
 * lib/pgvectorClient.ts
 *
 * pgvector RAG client for production use on Vercel (Phase 6, Task 5).
 *
 * Replaces ChromaDB in production — ChromaDB is a local Docker service that
 * cannot run on Vercel. pgvector is a PostgreSQL extension available in
 * Supabase that provides the same vector similarity search capability.
 *
 * Functions mirror the ChromaDB interface used in lib/ragQuery.ts and lib/ingest.ts
 * so the vectorStore.ts router can swap implementations transparently.
 *
 * Embedding model: text-embedding-3-small (1536 dimensions) — must match ingest.ts.
 * Distance: cosine similarity (lower = more similar).
 *
 * Prerequisite SQL (run once in Supabase):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   (see supabase/schema.sql for the full knowledge_embeddings table definition)
 */

import { supabase } from "@/lib/supabaseClient";

export type PgVectorMetadata = {
  source_file?: string;
  chunk_index?: number;
  topic?: string;
};

export type PgVectorResult = {
  id: string;
  content: string;
  source_file: string | null;
  chunk_index: number | null;
  topic: string | null;
  distance: number;
};

/**
 * Inserts or updates a single embedding in knowledge_embeddings.
 * Uses upsert keyed on (source_file, chunk_index) to handle re-ingestion.
 */
export async function upsertEmbedding(
  content: string,
  embedding: number[],
  metadata: PgVectorMetadata
): Promise<void> {
  const { error } = await supabase.from("knowledge_embeddings").upsert(
    {
      content,
      embedding: JSON.stringify(embedding),
      source_file: metadata.source_file ?? null,
      chunk_index: metadata.chunk_index ?? null,
      topic: metadata.topic ?? null,
    },
    {
      onConflict: "source_file,chunk_index",
      ignoreDuplicates: false,
    }
  );

  if (error) {
    throw new Error(`[pgvector] upsertEmbedding failed: ${error.message}`);
  }
}

/**
 * Cosine similarity search — returns the top N most relevant chunks.
 * Uses Supabase's RPC function match_knowledge_embeddings (see below).
 *
 * Required RPC (run once in Supabase SQL editor):
 *
 *   CREATE OR REPLACE FUNCTION match_knowledge_embeddings(
 *     query_embedding vector(1536),
 *     match_count int
 *   )
 *   RETURNS TABLE (
 *     id uuid, content text, source_file text,
 *     chunk_index int, topic text, distance float
 *   )
 *   LANGUAGE plpgsql AS $$
 *   BEGIN
 *     RETURN QUERY
 *     SELECT id, content, source_file, chunk_index, topic,
 *            (embedding <=> query_embedding) AS distance
 *     FROM knowledge_embeddings
 *     ORDER BY embedding <=> query_embedding
 *     LIMIT match_count;
 *   END;
 *   $$;
 */
export async function queryEmbeddings(
  embedding: number[],
  nResults: number
): Promise<PgVectorResult[]> {
  const { data, error } = await supabase.rpc("match_knowledge_embeddings", {
    query_embedding: JSON.stringify(embedding),
    match_count: nResults,
  });

  if (error) {
    throw new Error(`[pgvector] queryEmbeddings failed: ${error.message}`);
  }

  return (data ?? []) as PgVectorResult[];
}
