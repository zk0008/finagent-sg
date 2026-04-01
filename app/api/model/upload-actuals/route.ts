/**
 * app/api/model/upload-actuals/route.ts
 *
 * POST /api/model/upload-actuals
 *
 * What this route does:
 * Accepts an actual trial balance Excel file for a specific projection year,
 * classifies its accounts using the Phase 2 AI classifier, runs a
 * budget-vs-actual comparison against the matching projected year from the
 * specified financial model, and saves the result to financial_models.actuals.
 *
 * This is the ONE route that UPDATEs an existing financial model row —
 * actuals data is added to an existing model, not stored as a new model.
 *
 * Phase 3, Prompt 7 — budget-vs-actual engine endpoint.
 *
 * Request body (JSON):
 * {
 *   schemaName:  string,   // client schema, e.g. "techsoft_pte_ltd"
 *   model_id:    string,   // UUID of the financial_models row to compare against
 *   year:        number,   // which projection year to compare (1–5)
 *   file_data:   string,   // base64-encoded .xlsx file content
 *   file_name:   string    // original filename (e.g. "actuals_fy2026.xlsx")
 * }
 *
 * Response (200):
 * {
 *   bva_result: BudgetVsActualItem[],
 *   summary:    BVASummary
 * }
 *
 * Error responses:
 *   400 — invalid body, model not found, year not found in model
 *   500 — file parse, classification, or Supabase write failure
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFile, unlink } from "fs/promises";
import os from "os";
import { z } from "zod";
import { parseTrialBalance } from "@/lib/excelParser";
import { classifyAccounts } from "@/lib/accountClassifier";
import { getFinancialModel, updateModelActuals } from "@/lib/modelStorage";
import { compareBudgetVsActual, summarizeBVA, type BudgetVsActualItem } from "@/lib/budgetVsActual";
import { type ProjectedFS } from "@/lib/schemas";

// Request body schema
const RequestSchema = z.object({
  schemaName: z.string().min(1, "schemaName is required"),
  model_id:   z.string().uuid("model_id must be a valid UUID"),
  year:       z.number().int().min(1).max(5),
  file_data:  z.string().min(1, "file_data is required"),
  file_name:  z.string().min(1, "file_name is required"),
});

// Shape of one entry stored in financial_models.actuals
type ActualsEntry = {
  year: number;
  classified_accounts: unknown[];
  bva_result: BudgetVsActualItem[];
  uploaded_at: string;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Parse and validate the request body ────────────────────────────
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const { schemaName, model_id, year, file_data, file_name } = body;

  // ── 2. Load the financial model and find the requested projection year ─
  let model;
  try {
    model = await getFinancialModel(schemaName, model_id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load financial model" },
      { status: 500 }
    );
  }

  if (!model) {
    return NextResponse.json(
      { error: `Financial model ${model_id} not found.` },
      { status: 400 }
    );
  }

  // Find the matching projection year in base_case.
  // base_case is always present; best/worst may not be populated yet.
  const projectedYear = (model.base_case as ProjectedFS[]).find(
    (pfs) => pfs.year === year
  );

  if (!projectedYear) {
    return NextResponse.json(
      {
        error: `Year ${year} not found in model "${model.model_name}". ` +
          `Model has ${model.base_case.length} projected year(s).`,
      },
      { status: 400 }
    );
  }

  // ── 3. Write the uploaded Excel file to a temp path ───────────────────
  // excelParser.ts requires a file path on disk — same pattern as generate-fs.
  const ext = path.extname(file_name) || ".xlsx";
  const tmpPath = path.join(os.tmpdir(), `actuals_${Date.now()}${ext}`);

  try {
    const fileBuffer = Buffer.from(file_data, "base64");
    await writeFile(tmpPath, fileBuffer);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to write temp file: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // ── 4. Parse the trial balance Excel file ─────────────────────────────
  let parsedLines;
  try {
    parsedLines = await parseTrialBalance(tmpPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined); // best-effort cleanup
    return NextResponse.json(
      { error: `Failed to parse Excel file: ${(err as Error).message}` },
      { status: 400 }
    );
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }

  // ── 5. Classify the actual accounts via AI + RAG ──────────────────────
  let classifiedActuals;
  try {
    classifiedActuals = await classifyAccounts(parsedLines);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to classify accounts: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // ── 6. Run budget-vs-actual comparison ────────────────────────────────
  const bva_result = compareBudgetVsActual(projectedYear, classifiedActuals);
  const summary    = summarizeBVA(bva_result);

  // ── 7. Merge with existing actuals and save ───────────────────────────
  // Existing actuals may contain other years — preserve them and upsert this year.
  const existingActuals: ActualsEntry[] =
    Array.isArray(model.actuals) ? (model.actuals as ActualsEntry[]) : [];

  const newEntry: ActualsEntry = {
    year,
    classified_accounts: classifiedActuals,
    bva_result,
    uploaded_at: new Date().toISOString(),
  };

  // Replace the entry for this year if it already exists, else append.
  const updatedActuals: ActualsEntry[] = [
    ...existingActuals.filter((e) => e.year !== year),
    newEntry,
  ].sort((a, b) => a.year - b.year);

  try {
    await updateModelActuals(schemaName, model_id, updatedActuals);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save actuals" },
      { status: 500 }
    );
  }

  // ── 8. Return the comparison result ───────────────────────────────────
  return NextResponse.json({ bva_result, summary }, { status: 200 });
}
