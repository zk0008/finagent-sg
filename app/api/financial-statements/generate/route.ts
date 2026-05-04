/**
 * app/api/financial-statements/generate/route.ts
 *
 * Thin JSON wrapper for the FS generation pipeline — used by the agent layer.
 *
 * This route is intentionally different from /api/generate-fs (the SSE route
 * used by the UI). It runs the AI generation step synchronously and returns
 * plain JSON so LangGraph nodes can await the result directly.
 *
 * Important constraint: this route cannot run a brand-new FS from scratch
 * because the trial balance Excel file is not in the agent state. Instead it
 * re-runs the AI generation step (generateFinancialStatements) using classified
 * accounts that were already saved by a prior UI-triggered run. If no prior
 * output exists for the requested fiscal year the route returns 400.
 *
 * Called by: financialStatementNode in lib/agents/nodes/index.ts
 *
 * POST /api/financial-statements/generate
 * Input:  { clientId: string, financialYear: string }   e.g. { clientId: "techsoft_pte_ltd", financialYear: "2025" }
 * Output: { fsOutputId: string, fsResult: FSOutput }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { generateFinancialStatements } from "@/lib/fsGenerator";
import { saveGeneratedFS } from "@/lib/outputStorage";
import { flushLangfuse } from "@/lib/langfuse";
import type { ClassifiedAccount, ExemptionResult, Entity, FiscalYear } from "@/lib/schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { // top-level catch — prevents Next.js from returning an HTML 500 page on any unhandled throw
  // Parse the simplified agent request body
  let body: { clientId: string; financialYear: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { clientId, financialYear } = body;

  if (!clientId || !financialYear) {
    return NextResponse.json({ error: "clientId and financialYear are required" }, { status: 400 });
  }

  // clientId is the schema name slug throughout the agent layer (e.g. "techsoft_pte_ltd")
  const schemaName = clientId;

  // Verify the schema exists and is registered — prevents arbitrary schema enumeration
  const allowed = await verifySchemaAccess(schemaName);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Step 1: Load entity ───────────────────────────────────────────────────
  // Each client schema has exactly one entity row; just grab the first one
  const { data: entityRow, error: entityError } = await supabase
    .schema(schemaName)
    .from("entities")
    .select("name, uen, company_type, fye_date, audit_exempt")
    .limit(1)
    .single();

  if (entityError || !entityRow) {
    return NextResponse.json({ error: "Entity not found in schema" }, { status: 404 });
  }

  // Build the Entity object that fsGenerator expects (no id field in the type)
  const entity: Entity = {
    name:          entityRow.name,
    uen:           entityRow.uen,
    company_type:  entityRow.company_type as Entity["company_type"],
    fye_date:      entityRow.fye_date,    // already "YYYY-MM-DD" from Supabase
    audit_exempt:  entityRow.audit_exempt,
  };

  // ── Step 2: Load fiscal year by year string ───────────────────────────────
  // Match any fiscal year whose end_date falls within the requested calendar year
  const { data: fyRows, error: fyError } = await supabase
    .schema(schemaName)
    .from("fiscal_years")
    .select("id, entity_id, start_date, end_date, status")
    .gte("end_date", `${financialYear}-01-01`)   // end date is on or after Jan 1
    .lte("end_date", `${financialYear}-12-31`);  // end date is on or before Dec 31

  if (fyError || !fyRows || fyRows.length === 0) {
    return NextResponse.json(
      { error: `No fiscal year found ending in ${financialYear}` },
      { status: 404 }
    );
  }

  const fyRow = fyRows[0];  // take the first match if multiple

  const fiscalYear: FiscalYear = {
    entity_id:  fyRow.entity_id,
    start_date: fyRow.start_date,
    end_date:   fyRow.end_date,
    status:     fyRow.status as FiscalYear["status"],
  };

  // ── Step 3: Load classified accounts + exemption result from last saved output
  // The original FS run (triggered via the UI) saved these to the outputs table.
  // We cannot reconstruct them without the Excel file, so this route requires them.
  const { data: lastOutput, error: outputError } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("classified_accounts, exemption_result")
    .eq("output_type", "financial_statements")
    .eq("fiscal_year_id", fyRow.id)
    .order("created_at", { ascending: false })  // most recent first
    .limit(1)
    .single();

  if (outputError || !lastOutput) {
    return NextResponse.json(
      {
        error:
          `No prior FS data found for fiscal year ${financialYear}. ` +
          "Please run FS generation from the UI first to upload a trial balance.",
      },
      { status: 400 }
    );
  }

  const classifiedAccounts = lastOutput.classified_accounts as ClassifiedAccount[];
  const exemptionResult    = lastOutput.exemption_result    as ExemptionResult;

  // ── Step 4: Load pending user corrections ────────────────────────────────
  // Non-fatal: if the query fails, proceed without corrections
  let corrections: string[] = [];
  try {
    const { data: corrRows } = await supabase
      .schema(schemaName)
      .from("corrections")
      .select("message")
      .eq("status", "pending");
    if (corrRows && corrRows.length > 0) {
      corrections = corrRows.map((r: { message: string }) => r.message);
    }
  } catch {
    // Silently skip — corrections are advisory, not required
  }

  // ── Step 5: Run the AI generation step ───────────────────────────────────
  // generateFinancialStatements makes LLM calls; flushLangfuse MUST run afterwards
  let fsOutput;
  try {
    fsOutput = await generateFinancialStatements({
      entity,
      fiscal_year:         fiscalYear,
      classified_accounts: classifiedAccounts,
      exemption_result:    exemptionResult,
      corrections,
    });
  } catch (err) {
    // Flush traces even on failure, then return the error
    await flushLangfuse();
    return NextResponse.json(
      { error: `FS generation failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  // Flush Langfuse traces before the response closes the HTTP connection
  await flushLangfuse();

  // ── Step 6: Save the new FS output to Supabase ────────────────────────────
  // Returns the UUID of the new outputs row; this ID flows to Tax and Model nodes
  let fsOutputId: string;
  try {
    fsOutputId = await saveGeneratedFS({
      schemaName,
      fiscalYearId:   fyRow.id,
      fsOutput,
      classifiedAccounts,
      exemptionResult,
      pdfBase64: null,   // PDF is generated on demand; not saved here
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save FS output: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ fsOutputId, fsResult: fsOutput });
  } catch (err) {
    // Unhandled throw — return JSON so the calling node always gets a parseable response
    console.error("[financial-statements/generate] Unexpected error:", err);
    await flushLangfuse();  // flush any open Langfuse traces even on crash
    return NextResponse.json(
      { error: `Internal server error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
