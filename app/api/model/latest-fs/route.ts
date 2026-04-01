/**
 * app/api/model/latest-fs/route.ts
 *
 * GET /api/model/latest-fs?schemaName=xxx
 *
 * What this route does:
 * Returns basic metadata about the latest saved FS output for a client schema.
 * Used by ModelWorkflow on mount to populate the "Base Data" display in Step 1
 * and determine whether the financial model workflow can proceed.
 *
 * Response (200, found):
 * {
 *   found:          true,
 *   output_id:      string,
 *   base_year:      number,   // fiscal year (from balance_sheet.as_at_date or created_at year)
 *   as_at_date:     string,   // e.g. "2025-12-31"
 *   created_at:     string
 * }
 *
 * Response (200, not found):
 * { found: false }
 *
 * Error: 400 if schemaName is missing
 */

import { NextRequest, NextResponse } from "next/server";
import { getLatestFSOutput } from "@/lib/modelStorage";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const schemaName = req.nextUrl.searchParams.get("schemaName");
  if (!schemaName) {
    return NextResponse.json({ error: "schemaName query param is required" }, { status: 400 });
  }

  let output;
  try {
    output = await getLatestFSOutput(schemaName);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load FS output" },
      { status: 500 }
    );
  }

  if (!output) {
    return NextResponse.json({ found: false }, { status: 200 });
  }

  // Extract the fiscal year from the balance sheet as_at_date if available.
  // Falls back to the created_at year.
  const bs = (output.structured_data as Record<string, unknown>)?.balance_sheet as
    | Record<string, unknown>
    | undefined;
  const asAtDate =
    typeof bs?.as_at_date === "string" ? bs.as_at_date : null;
  const baseYear = asAtDate
    ? parseInt(asAtDate.slice(0, 4), 10)
    : new Date(output.created_at).getFullYear();

  return NextResponse.json(
    {
      found:      true,
      output_id:  output.id,
      base_year:  baseYear,
      as_at_date: asAtDate ?? `${baseYear}-12-31`,
      created_at: output.created_at,
    },
    { status: 200 }
  );
}
