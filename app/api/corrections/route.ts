/**
 * app/api/corrections/route.ts
 *
 * GET  /api/corrections?schemaName=techsoft_pte_ltd[&status=pending]
 * PATCH /api/corrections
 *
 * What this route does:
 *
 * GET — Lists corrections for a given client schema.
 *   Query params:
 *     schemaName (required) — the client schema (e.g. "techsoft_pte_ltd")
 *     status (optional)     — filter by status: "pending" | "reviewed" | omit for all
 *   Returns: { corrections: Correction[] }
 *
 * PATCH — Updates a correction's status to "reviewed".
 *   Body: { id: string, schemaName: string, status: "reviewed" }
 *   Returns: { correction: Correction }
 *
 * Used by: app/corrections/page.tsx — the correction review interface (Phase 5).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabaseClient";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Correction = {
  id: string;
  output_id: string | null;
  message: string;
  status: string;
  created_at: string;
};

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const schemaName = searchParams.get("schemaName");
  const statusFilter = searchParams.get("status");

  if (!schemaName) {
    return NextResponse.json({ error: "schemaName query param is required" }, { status: 400 });
  }

  // Build the Supabase query against the client schema's corrections table.
  // The table is addressed as "<schemaName>.corrections" via the service role client.
  let query = supabase
    .schema(schemaName)
    .from("corrections")
    .select("id, output_id, message, status, created_at")
    .order("created_at", { ascending: false });

  // Apply optional status filter
  if (statusFilter === "pending" || statusFilter === "reviewed") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: `Failed to load corrections: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ corrections: (data ?? []) as Correction[] });
}

// ── PATCH ──────────────────────────────────────────────────────────────────────

const PatchSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
  schemaName: z.string().min(1, "schemaName is required"),
  status: z.literal("reviewed"),
});

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof PatchSchema>;
  try {
    const raw = await req.json();
    body = PatchSchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const { id, schemaName, status } = body;

  const { data, error } = await supabase
    .schema(schemaName)
    .from("corrections")
    .update({ status })
    .eq("id", id)
    .select("id, output_id, message, status, created_at")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Failed to update correction: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ correction: data as Correction });
}
