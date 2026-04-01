/**
 * app/api/ingest/route.ts
 *
 * API route: POST /api/ingest
 *
 * Accepts a file upload from the chatbot "Upload training doc" button,
 * runs it through the RAG ingestion pipeline, and returns the result.
 *
 * Request: multipart/form-data with a single field named "file"
 * Response: JSON { success: true, chunks: number, filename: string }
 *           or  { success: false, error: string }
 *
 * Accepted file types: .txt and .pdf only.
 * Other types are rejected with a 400 error.
 *
 * Pipeline steps:
 * 1. Parse the uploaded file from the multipart form data
 * 2. Validate file type (.txt or .pdf only)
 * 3. Write the file to a system temp directory
 * 4. Call ingestFile() from scripts/ingest.ts to chunk, embed, and store
 * 5. Delete the temp file
 * 6. Return the number of chunks ingested
 *
 * Note: This route runs server-side in Next.js App Router.
 * OPENAI_API_KEY and CHROMA_URL must be set in .env.local for it to work.
 */

import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// Import from lib/ingest (not scripts/ingest) so Next.js build does not
// accidentally execute the CLI script's main() function during page-data collection.
import { ingestFile } from "@/lib/ingest";

// Allowed MIME types and extensions for uploaded training documents
const ALLOWED_EXTENSIONS = new Set([".txt", ".pdf"]);
const ALLOWED_MIME_TYPES = new Set(["text/plain", "application/pdf"]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  let tempFilePath: string | null = null;

  try {
    // Step 1: Parse the multipart form data
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: "No file provided. Send a file in the 'file' field." },
        { status: 400 }
      );
    }

    // Step 2: Validate file type by extension and MIME type
    const filename = file.name;
    const ext = path.extname(filename).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        {
          success: false,
          error: `File type '${ext}' is not supported. Only .txt and .pdf files are accepted.`,
        },
        { status: 400 }
      );
    }

    // MIME type check as a secondary guard (browsers may vary)
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: `MIME type '${file.type}' is not supported. Only text/plain and application/pdf are accepted.`,
        },
        { status: 400 }
      );
    }

    // Step 3: Write the file to a temp directory
    // We need a real file path because pdf-parse reads from disk.
    const tempDir = os.tmpdir();
    // Use a timestamp prefix to avoid collisions if multiple uploads happen concurrently
    tempFilePath = path.join(tempDir, `finagent_upload_${Date.now()}_${filename}`);

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tempFilePath, fileBuffer);

    // Step 4: Run the ingestion pipeline on the temp file
    // ingestFile() handles chunking, embedding, and ChromaDB storage
    const chunksIngested = await ingestFile(tempFilePath);

    if (chunksIngested === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No text could be extracted from '${filename}'. The file may be empty or image-only (OCR not supported).`,
        },
        { status: 422 }
      );
    }

    // Step 5: Delete the temp file
    fs.unlinkSync(tempFilePath);
    tempFilePath = null;

    // Step 6: Return success with chunk count
    return NextResponse.json({
      success: true,
      filename,
      chunks: chunksIngested,
    });
  } catch (err) {
    // Clean up temp file if ingestion threw an error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/ingest] Error:", message);

    return NextResponse.json(
      { success: false, error: `Ingestion failed: ${message}` },
      { status: 500 }
    );
  }
}
