/**
 * app/api/clients/[id]/route.ts
 *
 * GET /api/clients/[id] — Fetch a single client's details including entity_id
 *   and latest fiscal_year_id (needed by WorkflowPanel to remove hardcoded UUIDs).
 * PUT /api/clients/[id] — Update client details (name, fye_date, company_type).
 *
 * Note: DELETE is intentionally not implemented — clients must never be deleted.
 *
 * The [id] param is the row id from public.client_schemas.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabaseClient";
import type { ClientSummary } from "@/app/api/clients/route";

export type ClientDetail = ClientSummary & {
  entity_id: string | null;
  latest_fiscal_year_id: string | null;
};

const UpdateClientSchema = z.object({
  name: z.string().min(1).optional(),
  company_type: z.string().optional(),
  fye_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  audit_exempt: z.boolean().optional(),
});

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  const { data, error } = await supabase
    .from("client_schemas")
    .select("id, name, uen, company_type, fye_date, audit_exempt, schema_name, entity_id, created_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Fetch the latest fiscal year for this client from its own schema
  let latestFiscalYearId: string | null = null;
  if (data.schema_name && data.entity_id) {
    const { data: fy } = await supabase
      .schema(data.schema_name)
      .from("fiscal_years")
      .select("id")
      .eq("entity_id", data.entity_id)
      .order("end_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    latestFiscalYearId = fy?.id ?? null;
  }

  const detail: ClientDetail = {
    ...(data as ClientSummary),
    entity_id: (data as { entity_id?: string }).entity_id ?? null,
    latest_fiscal_year_id: latestFiscalYearId,
  };

  return NextResponse.json({ client: detail });
}

// ── PUT ───────────────────────────────────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  let body: z.infer<typeof UpdateClientSchema>;
  try {
    const raw = await req.json();
    body = UpdateClientSchema.parse(raw);
  } catch (err) {
    const message =
      err instanceof z.ZodError ? (err.issues?.[0]?.message ?? err.message) : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("client_schemas")
    .update(body)
    .eq("id", id)
    .select("id, name, uen, company_type, fye_date, audit_exempt, schema_name, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ client: data as ClientSummary });
}
