/**
 * lib/chromaClient.ts
 *
 * ChromaDB client setup for local RAG development.
 *
 * ChromaDB runs as a local Docker container during development.
 * To start ChromaDB: docker run -p 8000:8000 chromadb/chroma
 *
 * The `sfrs_knowledge` collection is a placeholder — it will be populated
 * in Phase 1 with SFRS standards, IRAS guides, and ACRA documentation.
 *
 * NOTE: ChromaDB is used for local development only.
 * In production, this will be migrated to pgvector (Supabase) to avoid
 * running a separate vector store service, reduce latency, and simplify
 * the deployment architecture.
 */

import { ChromaClient } from "chromadb";

// Parse host and port from CHROMA_URL (chromadb v3 deprecated the `path` option).
// Default: http://localhost:8000
const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");

// ChromaDB client — connects to the local ChromaDB instance (v2 API)
const chromaClient = new ChromaClient({
  host: chromaUrl.hostname,
  port: chromaUrl.port ? parseInt(chromaUrl.port, 10) : 8000,
  ssl: chromaUrl.protocol === "https:",
});

/**
 * Returns the `sfrs_knowledge` collection, creating it if it doesn't exist.
 *
 * This collection will hold:
 * - SFRS standards and interpretations
 * - IRAS e-Tax Guides and Practice Notes
 * - ACRA filing guides and XBRL taxonomy documentation
 * - CPF contribution rate tables and rounding rules
 *
 * Document ingestion is implemented in Phase 1.
 */
export async function getSfrsKnowledgeCollection() {
  // getOrCreateCollection is idempotent — safe to call on every startup
  const collection = await chromaClient.getOrCreateCollection({
    name: "sfrs_knowledge",
    embeddingFunction: null,
    metadata: {
      description:
        "SFRS standards, IRAS guides, ACRA docs, and CPF rules for FinAgent-SG RAG pipeline. Ingestion added in Phase 1.",
    },
  });
  return collection;
}

export { chromaClient };
