/**
 * scripts/migrateChromaToPgvector.ts
 *
 * One-time migration: copies all chunks from ChromaDB (sfrs_knowledge collection)
 * into Supabase pgvector (knowledge_embeddings table).
 *
 * Run once before deploying to production:
 *   npx ts-node --project tsconfig.json scripts/migrateChromaToPgvector.ts
 *
 * Prerequisites:
 *   1. Local ChromaDB running: docker compose --env-file docker-compose.env up -d
 *   2. Supabase pgvector enabled and knowledge_embeddings table created (supabase/schema.sql)
 *   3. .env.local has NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *
 * The script re-embeds each chunk using text-embedding-3-small (same model as ingest.ts)
 * and upserts into pgvector. Safe to re-run — duplicates are handled by upsert.
 */

import "dotenv/config";
import { ChromaClient } from "chromadb";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
const COLLECTION_NAME = "sfrs_knowledge";
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 50;

async function main() {
  console.log("FinAgent-SG — ChromaDB → pgvector migration");
  console.log("─────────────────────────────────────────────");

  // ── Clients ──────────────────────────────────────────────────────────────

  const chroma = new ChromaClient({ host: CHROMA_URL });
  const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // ── Fetch all chunks from ChromaDB ───────────────────────────────────────

  let collection;
  try {
    collection = await chroma.getCollection({
      name: COLLECTION_NAME,
      embeddingFunction: null as never,
    });
  } catch {
    console.error(`Collection "${COLLECTION_NAME}" not found in ChromaDB.`);
    console.error("Make sure ChromaDB is running and knowledge has been ingested.");
    process.exit(1);
  }

  const count = await collection.count();
  console.log(`Found ${count} chunks in ChromaDB collection "${COLLECTION_NAME}"`);

  if (count === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // Fetch all records (ChromaDB get() returns all if no IDs specified)
  const allRecords = await collection.get({
    include: ["documents", "metadatas"] as never,
  });

  const documents = (allRecords.documents ?? []) as (string | null)[];
  const metadatas = (allRecords.metadatas ?? []) as Record<string, unknown>[];
  const ids = allRecords.ids ?? [];

  console.log(`Fetched ${documents.length} documents. Starting migration…\n`);

  let migrated = 0;
  let failed = 0;

  // Process in batches to respect OpenAI rate limits
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batchDocs = documents.slice(i, i + BATCH_SIZE);
    const batchMeta = metadatas.slice(i, i + BATCH_SIZE);
    const batchIds = ids.slice(i, i + BATCH_SIZE);

    const validBatch = batchDocs
      .map((doc, idx) => ({ doc, meta: batchMeta[idx], id: batchIds[idx] }))
      .filter((item) => item.doc != null && item.doc.trim().length > 0);

    if (validBatch.length === 0) continue;

    try {
      // Embed the batch
      const embeddingResponse = await openaiClient.embeddings.create({
        model: EMBEDDING_MODEL,
        input: validBatch.map((item) => item.doc as string),
      });

      // Upsert each chunk into pgvector
      for (let j = 0; j < validBatch.length; j++) {
        const { doc, meta } = validBatch[j];
        const embedding = embeddingResponse.data[j].embedding;

        const { error } = await supabase.from("knowledge_embeddings").upsert(
          {
            content: doc as string,
            embedding: JSON.stringify(embedding),
            source_file: (meta?.source_file as string) ?? null,
            chunk_index: (meta?.chunk_index as number) ?? j,
            topic: (meta?.topic as string) ?? "general",
          },
          { onConflict: "source_file,chunk_index", ignoreDuplicates: false }
        );

        if (error) {
          console.error(`  ✗ Failed chunk ${i + j}: ${error.message}`);
          failed++;
        } else {
          migrated++;
        }
      }

      console.log(
        `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${validBatch.length} chunks processed ` +
          `(total: ${migrated} migrated, ${failed} failed)`
      );
    } catch (err) {
      console.error(`  ✗ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err);
      failed += validBatch.length;
    }
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`Migration complete.`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${documents.length}`);

  if (failed > 0) {
    console.log("\nSome chunks failed. Re-run the script to retry — upsert is idempotent.");
  } else {
    console.log("\nAll chunks migrated successfully. pgvector is ready for production.");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
