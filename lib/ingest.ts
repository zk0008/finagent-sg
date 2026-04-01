/**
 * lib/ingest.ts
 *
 * Core document ingestion logic for the FinAgent-SG RAG pipeline.
 *
 * This module is imported by:
 *   - scripts/ingest.ts  — CLI script for bulk ingestion from docs/knowledge/
 *   - app/api/ingest/route.ts — API route for chatbot "Upload training doc" button
 *
 * Separating the logic here means the CLI script's main() is never executed
 * when Next.js imports this module during build or page-data collection.
 *
 * What ingestFile() does:
 * 1. Reads the file (text extraction for PDFs, direct read for .txt)
 * 2. Splits text into overlapping chunks (~500 tokens / 2000 chars, overlap 50 tokens / 200 chars)
 * 3. Embeds each chunk via OpenAI text-embedding-3-small (Vercel AI SDK)
 * 4. Stores embeddings + metadata in the ChromaDB `sfrs_knowledge` collection
 *
 * Metadata stored per chunk: { source_file, chunk_index, topic }
 * The `topic` field is the filename without extension.
 */

import * as fs from "fs";
import * as path from "path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { chromaClient } from "./chromaClient";

// ── Constants ────────────────────────────────────────────────────────────────

// ~500 tokens × 4 chars/token
const CHUNK_SIZE_CHARS = 2000;
// ~50 tokens × 4 chars/token
const CHUNK_OVERLAP_CHARS = 200;

const COLLECTION_NAME = "sfrs_knowledge";

// Must match the model used in ragQuery.ts
const EMBEDDING_MODEL = "text-embedding-3-small";

// ChromaDB max batch size — add in batches to avoid payload limits
const BATCH_SIZE = 100;

// ── Text splitter ────────────────────────────────────────────────────────────

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE_CHARS,
  chunkOverlap: CHUNK_OVERLAP_CHARS,
});

// ── File reading ─────────────────────────────────────────────────────────────

/** Reads a .txt file and returns its content. */
async function readTextFile(filePath: string): Promise<string> {
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Extracts plain text from a PDF using pdf-parse.
 * Text extraction only — scanned/image PDFs return empty or garbled text.
 *
 * pdf-parse v2+ uses a class-based API:
 *   new PDFParse({ data: Uint8Array }) → parser.getText() → { text: string }
 */
async function readPdfFile(filePath: string): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}

/**
 * Derives a human-readable topic label from a filename.
 * Example: "sfrs_101_inventories.pdf" → "sfrs_101_inventories"
 */
function topicFromFilename(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingests a single file into the ChromaDB `sfrs_knowledge` collection.
 *
 * @param filePath - Absolute path to a .txt or .pdf file
 * @returns Number of chunks ingested. Returns 0 if the file was skipped
 *          (unsupported type, empty content, or no text extractable).
 * @throws If ChromaDB is unreachable or the OpenAI embedding call fails.
 */
export async function ingestFile(filePath: string): Promise<number> {
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (![".txt", ".pdf"].includes(ext)) {
    return 0; // Unsupported type — caller should reject before reaching here
  }

  // Step 1: Extract text
  let text: string;
  try {
    if (ext === ".txt") {
      text = await readTextFile(filePath);
    } else {
      text = await readPdfFile(filePath);
    }
  } catch (err) {
    throw new Error(`Failed to read ${filename}: ${err instanceof Error ? err.message : err}`);
  }

  if (!text || text.trim().length === 0) {
    return 0; // Nothing to ingest
  }

  // Step 2: Split into chunks
  const chunks = await splitter.splitText(text);
  if (chunks.length === 0) return 0;

  // Step 3: Get or create the ChromaDB collection
  const collection = await chromaClient.getOrCreateCollection({
    name: COLLECTION_NAME,
  });

  const topic = topicFromFilename(filename);
  let totalIngested = 0;

  // Step 4: Embed and store in batches
  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batchChunks = chunks.slice(batchStart, batchStart + BATCH_SIZE);
    const batchIndexes = batchChunks.map((_, i) => batchStart + i);

    // Embed via OpenAI text-embedding-3-small (Vercel AI SDK)
    const { embeddings } = await embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: batchChunks,
    });

    const ids = batchIndexes.map((i) => `${filename}::chunk_${i}`);
    const metadatas = batchIndexes.map((i) => ({
      source_file: filename,
      chunk_index: i,
      topic,
    }));

    await collection.add({
      ids,
      embeddings: embeddings as number[][],
      documents: batchChunks,
      metadatas,
    });

    totalIngested += batchChunks.length;
  }

  return totalIngested;
}
