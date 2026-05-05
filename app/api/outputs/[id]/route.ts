/**
 * app/api/outputs/[id]/route.ts
 *
 * Returns the structured_data (full FSOutput object) for a single outputs row.
 *
 * Called by WorkflowPanel's agentCompletedRuns useEffect when the agent has
 * completed a financial statement run. Loading the stored structured_data lets
 * WorkflowPanel set fsOutput and outputReady so the download buttons activate
 * without re-running the generation pipeline.
 *
 * Authentication: browser-facing route — auth enforced by proxy.ts (session cookie).
 * Schema isolation: verifySchemaAccess() confirms the schemaName is registered
 *   in public.client_schemas before any per-tenant Supabase query is made.
 *
 * GET /api/outputs/[id]?schemaName=<schema>
 * Returns: { structured_data: Record<string, unknown> }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }  // Next.js 15: params is a Promise
): Promise<NextResponse> {
  // Await the dynamic route params — required in Next.js 15 App Router
  const { id } = await params;
  const schemaName = req.nextUrl.searchParams.get("schemaName");

  if (!id || !schemaName) {
    return NextResponse.json(
      { error: "id and schemaName are required" },
      { status: 400 }
    );
  }

  // Confirm the schema is registered in public.client_schemas before querying it
  const allowed = await verifySchemaAccess(schemaName);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch structured_data only — the full FSOutput object (balance sheet, P&L,
  // cash flow, equity, notes, XBRL tags) stored as JSONB in the outputs table
  const { data, error } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("structured_data")
    .eq("id", id)         // match the specific output row by UUID
    .single();

  if (error || !data?.structured_data) {
    return NextResponse.json({ error: "Output not found" }, { status: 404 });
  }

  return NextResponse.json({
    structured_data: data.structured_data as Record<string, unknown>,
  });
}
