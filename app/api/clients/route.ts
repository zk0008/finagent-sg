/**
 * app/api/clients/route.ts
 *
 * GET  /api/clients         — List all client entities across all schemas.
 * POST /api/clients         — Create a new client: new schema + entity record.
 *
 * GET response:
 *   { clients: ClientSummary[] }
 *   Each item: { id, name, uen, company_type, fye_date, audit_exempt, schema_name, created_at }
 *
 * POST request body:
 *   {
 *     name: string          — Company full legal name (e.g. "TechSoft Pte Ltd")
 *     uen: string           — ACRA UEN (e.g. "201912345K")
 *     company_type?: string — default "private_ltd"
 *     fye_date: string      — Financial year end (ISO date e.g. "2025-12-31")
 *     revenue: string       — Annual revenue (string, BigNumber-safe)
 *     total_assets: string
 *     employee_count: number
 *     shareholder_count: number
 *     has_corporate_shareholders: boolean
 *   }
 *
 * POST response (201): { client: ClientSummary }
 * Errors: 400 — validation, 409 — UEN already exists, 500 — DB failure
 *
 * Schema creation:
 * Creates the client schema in Supabase and all required tables via raw SQL
 * using the service role connection. Tables created: entities, fiscal_years,
 * trial_balances, outputs, corrections, employees, payroll_runs, payslips,
 * financial_models.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabaseClient";
import { generateSchemaName } from "@/lib/schemaUtils";
import { checkExemption } from "@/lib/exemptionChecker";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClientSummary = {
  id: string;
  name: string;
  uen: string;
  company_type: string;
  fye_date: string;
  audit_exempt: boolean;
  schema_name: string;
  created_at?: string;
};

// ── Validation schema ──────────────────────────────────────────────────────────

const CreateClientSchema = z.object({
  name: z.string().min(1, "Company name is required"),
  uen: z.string().min(1, "UEN is required"),
  company_type: z.string().default("private_ltd"),
  fye_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "FYE date must be YYYY-MM-DD"),
  revenue: z.string().default("0"),
  total_assets: z.string().default("0"),
  employee_count: z.number().int().min(0).default(0),
  shareholder_count: z.number().int().min(1).default(1),
  has_corporate_shareholders: z.boolean().default(false),
});

// ── Known client schemas registry ─────────────────────────────────────────────
// Stores the mapping of schema_name → entity metadata in a shared table.
// We use public.client_schemas to track which schemas exist.

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const { data, error } = await supabase
    .from("client_schemas")
    .select("id, name, uen, company_type, fye_date, audit_exempt, schema_name, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Failed to load clients: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ clients: (data ?? []) as ClientSummary[] });
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof CreateClientSchema>;
  try {
    const raw = await req.json();
    body = CreateClientSchema.parse(raw);
  } catch (err) {
    const message =
      err instanceof z.ZodError ? (err.issues?.[0]?.message ?? err.message) : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const schemaName = generateSchemaName(body.name);

  // Check for duplicate UEN
  const { data: existing } = await supabase
    .from("client_schemas")
    .select("id")
    .eq("uen", body.uen)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "A client with this UEN already exists" },
      { status: 409 }
    );
  }

  // Determine audit exemption
  const exemptionInput = {
    revenue: parseFloat(body.revenue) || 0,
    total_assets: parseFloat(body.total_assets) || 0,
    employee_count: body.employee_count,
    shareholder_count: body.shareholder_count,
    has_corporate_shareholders: body.has_corporate_shareholders,
  };
  const exemption = checkExemption(exemptionInput);

  // Create the client schema and all required tables via SQL
  const createSchemaSql = buildSchemaSQL(schemaName);
  const { error: sqlError } = await supabase.rpc("exec_sql", {
    sql: createSchemaSql,
  });

  if (sqlError) {
    console.error("[clients] Failed to create schema:", sqlError);
    return NextResponse.json(
      { error: `Failed to create client schema: ${sqlError.message}` },
      { status: 500 }
    );
  }

  // Expose the new schema to PostgREST via Supabase Management API
  await exposeSchemaToPostgREST(schemaName);

  // Insert the entity — retry up to 5 times with 1s delay to allow PostgREST
  // to reload after the schema exposure change above.
  let entity: { id: string } | null = null;
  let entityError: { message: string } | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await supabase
      .schema(schemaName)
      .from("entities")
      .insert({
        name: body.name,
        uen: body.uen,
        company_type: body.company_type,
        fye_date: body.fye_date,
        audit_exempt: exemption.is_audit_exempt,
      })
      .select("id")
      .single();
    if (!result.error) {
      entity = result.data as { id: string };
      entityError = null;
      break;
    }
    entityError = result.error;
    console.warn(`[clients] Entity insert attempt ${attempt} failed:`, result.error.message);
  }

  if (!entity) {
    console.error("[clients] Failed to insert entity after retries:", entityError);
    return NextResponse.json(
      { error: "Failed to create entity record — PostgREST schema reload timed out. Please try again." },
      { status: 500 }
    );
  }

  // Create the first fiscal year (current FYE year)
  const fyeDate = new Date(body.fye_date);
  const startDate = new Date(fyeDate);
  startDate.setFullYear(fyeDate.getFullYear() - 1);
  startDate.setDate(startDate.getDate() + 1);

  await supabase
    .schema(schemaName)
    .from("fiscal_years")
    .insert({
      entity_id: entity.id,
      start_date: startDate.toISOString().slice(0, 10),
      end_date: body.fye_date,
      status: "draft",
    });

  // Register in the shared client_schemas registry
  const { data: registered, error: registryError } = await supabase
    .from("client_schemas")
    .insert({
      name: body.name,
      uen: body.uen,
      company_type: body.company_type,
      fye_date: body.fye_date,
      audit_exempt: exemption.is_audit_exempt,
      schema_name: schemaName,
      entity_id: entity.id,
    })
    .select("id, name, uen, company_type, fye_date, audit_exempt, schema_name, created_at")
    .single();

  if (registryError || !registered) {
    return NextResponse.json(
      { error: "Client created but registry update failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ client: registered as ClientSummary }, { status: 201 });
}

// ── Expose new schema to PostgREST via Supabase Management API ───────────────
// Requires SUPABASE_ACCESS_TOKEN (personal access token from supabase.com/dashboard/account/tokens).
// Project ref is derived from NEXT_PUBLIC_SUPABASE_URL automatically.
// If the token is not set, logs a warning — user must add schema manually in Supabase dashboard.

async function exposeSchemaToPostgREST(schemaName: string): Promise<void> {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const projectRef = supabaseUrl.replace("https://", "").split(".")[0];

  if (!accessToken || !projectRef) {
    console.warn(`[clients] SUPABASE_ACCESS_TOKEN not set — add "${schemaName}" manually in Supabase dashboard → Settings → API → Exposed schemas.`);
    return;
  }

  const base = `https://api.supabase.com/v1/projects/${projectRef}/postgrest`;

  // Fetch current PostgREST config
  const getRes = await fetch(base, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!getRes.ok) {
    console.warn("[clients] Failed to fetch PostgREST config:", await getRes.text());
    return;
  }

  const config = await getRes.json() as { db_schema?: string };
  const existing = (config.db_schema ?? "public").split(",").map((s) => s.trim());

  if (existing.includes(schemaName)) return;

  const updated = [...existing, schemaName].join(", ");

  const patchRes = await fetch(base, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ db_schema: updated }),
  });

  if (!patchRes.ok) {
    console.warn("[clients] Failed to update PostgREST exposed schemas:", await patchRes.text());
  } else {
    console.log(`[clients] Schema "${schemaName}" exposed to PostgREST.`);
  }
}

// ── Schema creation SQL ───────────────────────────────────────────────────────

function buildSchemaSQL(schemaName: string): string {
  // NOTE: schemaName comes from generateSchemaName() which strips all non-alphanumeric chars.
  // It is safe to interpolate — no user-controlled characters can appear here.
  return `
    CREATE SCHEMA IF NOT EXISTS ${schemaName};
    GRANT USAGE ON SCHEMA ${schemaName} TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA ${schemaName} TO anon, authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schemaName} TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName}
      GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName}
      GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

    CREATE TABLE IF NOT EXISTS ${schemaName}.entities (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      uen           TEXT NOT NULL UNIQUE,
      company_type  TEXT NOT NULL DEFAULT 'private_ltd',
      fye_date      DATE NOT NULL,
      audit_exempt  BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.fiscal_years (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id   UUID NOT NULL REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft'
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.trial_balances (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fiscal_year_id    UUID NOT NULL REFERENCES ${schemaName}.fiscal_years(id) ON DELETE CASCADE,
      uploaded_file_url TEXT NOT NULL,
      parsed_data_json  JSONB
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.outputs (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fiscal_year_id      UUID NOT NULL REFERENCES ${schemaName}.fiscal_years(id) ON DELETE CASCADE,
      output_type         TEXT NOT NULL,
      structured_data     JSONB,
      classified_accounts JSONB,
      exemption_result    JSONB,
      pdf_data            TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.corrections (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      output_id  UUID,
      message    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.employees (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id       UUID NOT NULL REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      nric_fin        TEXT,
      dob             DATE NOT NULL,
      citizenship     TEXT NOT NULL,
      monthly_salary  NUMERIC(12, 2) NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.payroll_runs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id     UUID NOT NULL REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,
      run_month     DATE NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.payslips (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payroll_run_id   UUID NOT NULL REFERENCES ${schemaName}.payroll_runs(id) ON DELETE CASCADE,
      employee_id      UUID NOT NULL REFERENCES ${schemaName}.employees(id) ON DELETE CASCADE,
      ordinary_wages   NUMERIC(12, 2) NOT NULL,
      additional_wages NUMERIC(12, 2) NOT NULL DEFAULT 0,
      allowances       JSONB,
      deductions       JSONB,
      employee_cpf     NUMERIC(12, 2) NOT NULL,
      employer_cpf     NUMERIC(12, 2) NOT NULL,
      total_cpf        NUMERIC(12, 2) NOT NULL,
      sdl              NUMERIC(12, 2) NOT NULL,
      net_pay          NUMERIC(12, 2) NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.financial_models (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id         UUID NOT NULL REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,
      fiscal_year_id    UUID REFERENCES ${schemaName}.fiscal_years(id) ON DELETE SET NULL,
      source_output_id  UUID REFERENCES ${schemaName}.outputs(id) ON DELETE RESTRICT,
      model_name        TEXT NOT NULL,
      projection_years  INTEGER NOT NULL CHECK (projection_years BETWEEN 1 AND 5),
      assumptions       JSONB NOT NULL DEFAULT '{}',
      base_case         JSONB NOT NULL DEFAULT '[]',
      best_case         JSONB,
      worst_case        JSONB,
      actuals           JSONB,
      is_active         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ${schemaName}_one_active_model
      ON ${schemaName}.financial_models (entity_id)
      WHERE is_active = TRUE;

    CREATE TABLE IF NOT EXISTS ${schemaName}.tax_computations (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id             UUID NOT NULL REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,
      fiscal_year_id        UUID REFERENCES ${schemaName}.fiscal_years(id) ON DELETE SET NULL,
      year_of_assessment    INTEGER NOT NULL,
      form_type             TEXT NOT NULL,
      accounting_profit     NUMERIC(18, 2) NOT NULL,
      tax_adjustments       JSONB,
      chargeable_income     NUMERIC(18, 2) NOT NULL,
      exemption_scheme      TEXT NOT NULL,
      tax_before_rebate     NUMERIC(18, 2) NOT NULL,
      cit_rebate            NUMERIC(18, 2) NOT NULL DEFAULT 0,
      cit_rebate_cash_grant NUMERIC(18, 2) NOT NULL DEFAULT 0,
      tax_payable           NUMERIC(18, 2) NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schemaName}.receipts (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      period                TEXT NOT NULL,
      type                  TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      description           TEXT NOT NULL,
      amount                NUMERIC(15, 2) NOT NULL,
      currency              TEXT NOT NULL DEFAULT 'SGD',
      extraction_confidence TEXT NOT NULL CHECK (extraction_confidence IN ('high', 'medium', 'low', 'manual')),
      source_file           TEXT,
      created_at            TIMESTAMPTZ DEFAULT now(),
      updated_at            TIMESTAMPTZ DEFAULT now()
    );
  `;
}
