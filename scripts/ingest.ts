/**
 * scripts/ingest.ts
 *
 * CLI script — bulk document ingestion for FinAgent-SG RAG knowledge base.
 *
 * Reads all .txt and .pdf files from docs/knowledge/, ingests each into
 * the ChromaDB `sfrs_knowledge` collection via lib/ingest.ts.
 *
 * Usage (from project root):
 *   npx tsx scripts/ingest.ts
 *
 * Prerequisites:
 *   - ChromaDB running: docker run -p 8000:8000 chromadb/chroma
 *   - OPENAI_API_KEY set in .env.local
 *   - Documents placed in docs/knowledge/ (.txt or .pdf)
 *
 * The ingestion logic (chunking, embedding, ChromaDB storage) lives in lib/ingest.ts
 * so it can be imported by the API route (app/api/ingest/route.ts) without
 * triggering this main() function during Next.js build.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

// Load .env.local so OPENAI_API_KEY and CHROMA_URL are available when run via tsx
config({ path: path.resolve(__dirname, "../.env.local") });

import { ingestFile } from "../lib/ingest";
import { chromaClient } from "../lib/chromaClient";

const KNOWLEDGE_DIR = path.resolve(__dirname, "../docs/knowledge");

async function main() {
  console.log("FinAgent-SG — RAG Ingestion Pipeline");
  console.log("=====================================");
  console.log(`Knowledge dir: ${KNOWLEDGE_DIR}`);
  console.log(`Collection:    sfrs_knowledge`);
  console.log(`Embedding:     text-embedding-3-small`);
  console.log(`Chunk size:    ~2000 chars (~500 tokens)`);
  console.log(`Overlap:       ~200 chars (~50 tokens)`);
  console.log();

  // Validate environment
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is not set. Add it to .env.local and retry.");
    process.exit(1);
  }

  // Verify ChromaDB is reachable
  try {
    await chromaClient.heartbeat();
    console.log("✓ ChromaDB is reachable\n");
  } catch {
    console.error(
      "❌ Cannot reach ChromaDB. Is it running?\n  docker run -p 8000:8000 chromadb/chroma"
    );
    process.exit(1);
  }

  // Read all files from the knowledge directory
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`❌ Knowledge directory not found: ${KNOWLEDGE_DIR}`);
    process.exit(1);
  }

  // Exclude hidden files and the README — only ingest actual knowledge documents
  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => !f.startsWith(".") && f !== "README.txt")
    .map((f) => path.join(KNOWLEDGE_DIR, f));

  if (files.length === 0) {
    console.log("No documents found in docs/knowledge/ (README.txt excluded).");
    console.log("Add .txt or .pdf files to docs/knowledge/ and re-run.");
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to ingest:\n`);
  files.forEach((f) => console.log(`  ${path.basename(f)}`));

  // Ingest each file sequentially
  let totalChunks = 0;
  for (const filePath of files) {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (![".txt", ".pdf"].includes(ext)) {
      console.log(`\n→ Skipping ${filename} — unsupported type (only .txt and .pdf)`);
      continue;
    }

    console.log(`\n→ Ingesting: ${filename}`);
    try {
      const count = await ingestFile(filePath);
      if (count === 0) {
        console.log(`  ⚠ No text extracted from ${filename} — skipped`);
      } else {
        console.log(`  ✅ ${count} chunks ingested`);
        totalChunks += count;
      }
    } catch (err) {
      console.error(`  ❌ Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n=====================================");
  console.log(`✅ Ingestion complete — ${totalChunks} total chunks stored`);
}

main().catch((err) => {
  console.error("❌ Ingestion failed:", err);
  process.exit(1);
});
