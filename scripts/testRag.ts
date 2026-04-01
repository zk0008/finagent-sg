/**
 * scripts/testRag.ts
 *
 * Dev-only test script for the FinAgent-SG RAG query pipeline.
 *
 * Runs 5 accounting questions through ragQuery() and prints the top 3 results
 * for each, including the source file, distance score, and a text excerpt.
 *
 * Use this to verify:
 * 1. ChromaDB is reachable
 * 2. The sfrs_knowledge collection has been populated (run ingest.ts first)
 * 3. Queries return semantically relevant chunks
 * 4. Distance scores look reasonable (lower = more similar, typically 0.0–1.0)
 *
 * Usage (from project root):
 *   npx tsx scripts/testRag.ts
 *
 * Prerequisites:
 *   - ChromaDB running: docker run -p 8000:8000 chromadb/chroma
 *   - OPENAI_API_KEY set in .env.local
 *   - sfrs_knowledge collection populated: npx tsx scripts/ingest.ts
 *
 * Dev only — not called by the Next.js app.
 */

import * as path from "path";
import { config } from "dotenv";

// Load .env.local so OPENAI_API_KEY and CHROMA_URL are available
config({ path: path.resolve(__dirname, "../.env.local") });

import { ragQuery } from "../lib/ragQuery";

// ── Test questions ────────────────────────────────────────────────────────────

const TEST_QUESTIONS = [
  "What are the criteria for small company audit exemption in Singapore?",
  "How should current and non-current assets be classified under SFRS?",
  "What disclosures are required for related party transactions?",
  "What is the CPF contribution rate for employees under 55?",
  "What is the ACRA annual return filing deadline?",
];

const TOP_N = 3;       // Print top 3 results per question
const EXCERPT_LEN = 200; // Characters of chunk text to show in output

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Truncates a string to maxLen characters, appending "…" if truncated. */
function excerpt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/** Formats a distance score as a percentage-like string for readability. */
function formatDistance(d: number): string {
  return d.toFixed(4);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("FinAgent-SG — RAG Query Test");
  console.log("=============================\n");

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is not set. Add it to .env.local and retry.");
    process.exit(1);
  }

  let allPassed = true;

  for (let i = 0; i < TEST_QUESTIONS.length; i++) {
    const question = TEST_QUESTIONS[i];
    console.log(`Q${i + 1}: ${question}`);
    console.log("─".repeat(70));

    try {
      const results = await ragQuery(question, TOP_N);

      if (results.length === 0) {
        console.log(
          "  ⚠ No results returned. Is the sfrs_knowledge collection populated?\n" +
          "    Run: npx tsx scripts/ingest.ts\n"
        );
        allPassed = false;
        continue;
      }

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        console.log(`  Result ${j + 1}:`);
        console.log(`    Source:    ${r.source_file} (chunk ${r.chunk_index})`);
        console.log(`    Topic:     ${r.topic}`);
        console.log(`    Distance:  ${formatDistance(r.distance)}`);
        console.log(`    Excerpt:   ${excerpt(r.text, EXCERPT_LEN)}`);
        console.log();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Query failed: ${message}\n`);
      allPassed = false;
    }
  }

  console.log("=============================");
  if (allPassed) {
    console.log("✅ All queries completed successfully.");
  } else {
    console.log(
      "⚠ Some queries returned no results or failed.\n" +
      "  If the collection is empty, run: npx tsx scripts/ingest.ts"
    );
  }
}

main().catch((err) => {
  console.error("❌ Test script failed:", err);
  process.exit(1);
});
