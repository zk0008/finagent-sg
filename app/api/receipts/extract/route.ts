/**
 * app/api/receipts/extract/route.ts
 *
 * API route: POST /api/receipts/extract
 *
 * Accepts a file upload (PDF, image, or CSV) and extracts line items from it.
 * Part of Improvement B — Receipt Segregation (Prompt B1).
 *
 * Request: multipart/form-data with fields:
 *   file   — the uploaded file (.pdf, .jpg, .jpeg, .png, or .csv)
 *   type   — "income" or "expense"
 *   period — the transaction period as a string (e.g. "March 2026")
 *
 * Response: JSON
 *   { items: ReceiptLineItem[], type: string, period: string }
 *   or { error: string } on failure
 *
 * Extraction behaviour:
 *   CSV:        Parsed by papaparse. Expects columns: description, amount.
 *               Optional column: date. Any extra columns are ignored.
 *   PDF/image:  Sent to GPT-4.1 vision via generateObject. The model extracts
 *               all line items with description, amount, optional date, and
 *               a confidence assessment per item.
 *
 * Amount handling:
 *   All amounts are validated and normalised using bignumber.js.
 *   No native JS math. Amounts stored as strings with 2 decimal places.
 *
 * This route does NOT write to Supabase — saving is handled in a separate route
 * (app/api/receipts/save/route.ts, built in Prompt B3).
 */

import { NextRequest, NextResponse } from "next/server";
import BigNumber from "bignumber.js";
import Papa from "papaparse";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { auth } from "@/auth";
import { MODEL_ROUTES } from "@/lib/modelRouter";

// ── Exported type — used by B2 UI component and B3 save route ────────────────

export interface ReceiptLineItem {
  description: string;
  amount: string;      // bignumber.js string, always 2 decimal places (e.g. "1234.56")
  date: string | null; // ISO YYYY-MM-DD or null if not available
  extraction_confidence: "high" | "medium" | "low";
}

// ── Allowed file types ────────────────────────────────────────────────────────

const CSV_EXTS = new Set([".csv"]);

const VISION_EXTS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

const VISION_MIME: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
};

// ── GPT vision output schema ──────────────────────────────────────────────────

const lineItemSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Merchant name or item description for this line item"),
  amount: z
    .number()
    .nonnegative()
    .describe(
      "Extracted amount as a positive number. No currency symbols, no commas. " +
      "Example: 1234.56 — not '$1,234.56'. " +
      "If the amount is ambiguous, provide your best estimate and mark confidence as low."
    ),
  date: z
    .string()
    .nullable()
    .describe(
      "Transaction date in YYYY-MM-DD format, or null if the date is not visible in the document."
    ),
  extraction_confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "high   = text is clearly legible and the value is unambiguous; " +
      "medium = some uncertainty (e.g. handwriting, smudged ink, or partly obscured); " +
      "low    = value is unclear, guessed, or may be wrong."
    ),
});

const extractionOutputSchema = z.object({
  items: z
    .array(lineItemSchema)
    .describe(
      "All transaction or line items found in the document. " +
      "Include every item regardless of confidence — do not silently drop any line. " +
      "Do NOT include totals, subtotals, or tax summary rows as line items."
    ),
});

const VISION_PROMPT =
  "You are a receipt and bank statement extraction assistant. " +
  "Your task is to extract every individual transaction or line item from the document provided. " +
  "For each item: " +
  "(1) extract the description (merchant name or item label), " +
  "(2) extract the amount as a plain positive number (no $ signs, no commas), " +
  "(3) extract the date in YYYY-MM-DD format if visible (otherwise null), " +
  "(4) assess your confidence in the extraction. " +
  "Include ALL items even if confidence is low — never drop a line silently. " +
  "Do NOT include row totals, subtotals, opening/closing balances, or tax summary lines.";

// ── CSV parsing ───────────────────────────────────────────────────────────────

/**
 * Parses a CSV file using papaparse and maps rows to ReceiptLineItem[].
 *
 * Expected columns (case-insensitive, whitespace-normalised):
 *   description / merchant / name  — required
 *   amount / value / total         — required
 *   date / transaction_date        — optional
 *
 * Confidence assignment:
 *   high   — description present, amount is a clean numeric string
 *   medium — amount required stripping of non-numeric characters (e.g. "$1,234.56")
 *   low    — amount could not be parsed as a valid non-negative number
 */
function parseCsv(text: string): ReceiptLineItem[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const items: ReceiptLineItem[] = [];

  for (const row of result.data) {
    const rawDescription = (
      row["description"] ??
      row["merchant"] ??
      row["name"] ??
      ""
    ).trim();

    const rawAmount = (
      row["amount"] ??
      row["value"] ??
      row["total"] ??
      ""
    ).trim();

    const rawDate = (
      row["date"] ??
      row["transaction_date"] ??
      ""
    ).trim();

    // Skip rows with no description or no amount column at all
    if (!rawDescription || !rawAmount) continue;

    // Strip non-numeric characters except decimal point and leading minus
    const cleanAmount = rawAmount.replace(/[^0-9.-]/g, "");
    const bn = new BigNumber(cleanAmount);

    const isClean = cleanAmount === rawAmount;
    const isValid = !bn.isNaN() && bn.isFinite() && bn.isGreaterThanOrEqualTo(0);

    const confidence: "high" | "medium" | "low" = !isValid
      ? "low"
      : isClean
      ? "high"
      : "medium";

    items.push({
      description: rawDescription,
      amount: isValid ? bn.toFixed(2) : "0.00",
      date: rawDate || null,
      extraction_confidence: confidence,
    });
  }

  return items;
}

// ── Vision extraction (PDF / JPG / PNG) ──────────────────────────────────────

/**
 * Extracts line items from a PDF or image file using GPT-4.1 vision.
 * Uses generateObject so the model's output is validated against lineItemSchema.
 * Amounts are normalised to 2 decimal places using bignumber.js after extraction.
 */
async function extractVision(
  fileBuffer: ArrayBuffer,
  mimeType: string
): Promise<ReceiptLineItem[]> {
  // Pass image bytes directly as Uint8Array with mediaType.
  // The Vercel AI SDK's ImagePart accepts Uint8Array via the DataContent union.
  // Passing a data: URL string causes the SDK to treat it as a URL and attempt
  // an http download, which fails with "URL scheme must be http or https".
  const uint8 = new Uint8Array(fileBuffer);

  const { object } = await generateObject({
    model: openai(MODEL_ROUTES.fs_generation), // "gpt-4.1" — accuracy-critical
    schema: extractionOutputSchema,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: VISION_PROMPT },
          { type: "image" as const, image: uint8, mediaType: mimeType },
        ],
      },
    ],
  });

  return object.items.map((item) => {
    const bn = new BigNumber(item.amount);
    return {
      description: item.description,
      amount: bn.isNaN() ? "0.00" : bn.toFixed(2),
      date: item.date ?? null,
      extraction_confidence: item.extraction_confidence,
    };
  });
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Authentication — any authenticated user may use receipt extraction
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const type = formData.get("type");
    const period = formData.get("period");

    // ── Validate inputs ───────────────────────────────────────────────────────

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file provided. Include the file in the 'file' field." },
        { status: 400 }
      );
    }

    if (type !== "income" && type !== "expense") {
      return NextResponse.json(
        { error: "Field 'type' must be 'income' or 'expense'." },
        { status: 400 }
      );
    }

    if (!period || typeof period !== "string" || !period.trim()) {
      return NextResponse.json(
        { error: "Field 'period' is required (e.g. 'March 2026')." },
        { status: 400 }
      );
    }

    const filename = file.name;
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();

    // ── CSV branch ────────────────────────────────────────────────────────────

    if (CSV_EXTS.has(ext)) {
      const text = await file.text();
      const items = parseCsv(text);

      if (items.length === 0) {
        return NextResponse.json(
          {
            error:
              "No valid line items found in the CSV. " +
              "Expected columns: description (or merchant/name) and amount (or value/total). " +
              "Optional column: date.",
          },
          { status: 422 }
        );
      }

      return NextResponse.json({ items, type, period: period.trim() });
    }

    // ── Vision branch (PDF / JPG / PNG) ───────────────────────────────────────

    if (VISION_EXTS.has(ext)) {
      const mimeType = VISION_MIME[ext] ?? "application/octet-stream";
      const fileBuffer = await file.arrayBuffer();
      const items = await extractVision(fileBuffer, mimeType);

      if (items.length === 0) {
        return NextResponse.json(
          {
            error:
              "No line items could be extracted from the document. " +
              "Ensure the file contains readable transaction data.",
          },
          { status: 422 }
        );
      }

      return NextResponse.json({ items, type, period: period.trim() });
    }

    // ── Unsupported file type ─────────────────────────────────────────────────

    return NextResponse.json(
      {
        error: `File type '${ext}' is not supported. Accepted formats: .csv, .pdf, .jpg, .jpeg, .png`,
      },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/receipts/extract] Error:", message);
    return NextResponse.json(
      { error: `Extraction failed: ${message}` },
      { status: 500 }
    );
  }
}
