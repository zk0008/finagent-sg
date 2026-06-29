/**
 * app/api/dashboard/route.ts
 *
 * GET /api/dashboard
 *
 * Returns all data needed to render the client dashboard in a single request:
 * company info, fiscal year, compliance deadlines, latest FS/payroll/tax/model,
 * and employee count.
 *
 * Auth: session required. Resolves the caller's company via client_schemas.user_id.
 * If the caller is an admin with no matching company, falls back to returning all
 * clients (caller selects via ?schema= query param).
 *
 * Response 200:
 *   { company, fiscalYear, deadlines, latestFS, latestPayroll, latestTax,
 *     activeModel, employeeCount }
 *
 * Response 200 with { company: null } if the user has no company yet (pre-onboarding).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabase } from "@/lib/supabaseClient";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { getComplianceDeadlines, type ComplianceDeadlines } from "@/lib/deadlines";

// ── Response shape types ────────────────────────────────────────────────────────

type CompanyInfo = {
  name:        string;
  uen:         string;
  schema_name: string;
  fye_date:    string;
};

type FiscalYearInfo = {
  start_date: string;
  end_date:   string;
  status:     string;
};

type LatestFS = {
  id:             string;
  created_at:     string;
  fiscal_year_id: string;
};

type LatestPayroll = {
  id:         string;
  run_month:  string;
  status:     string;
  created_at: string;
};

type LatestTax = {
  id:                 string;
  year_of_assessment: number;
  form_type:          string;
  tax_payable:        number;
  created_at:         string;
};

type ActiveModel = {
  id:               string;
  model_name:       string;
  projection_years: number;
};

type DashboardResponse = {
  company:       CompanyInfo | null;
  fiscalYear:    FiscalYearInfo | null;
  deadlines:     ComplianceDeadlines | null;
  latestFS:      LatestFS | null;
  latestPayroll: LatestPayroll | null;
  latestTax:     LatestTax | null;
  activeModel:   ActiveModel | null;
  employeeCount: number;
};

// ── DB row shapes ───────────────────────────────────────────────────────────────

type ClientSchemaRow = {
  name:        string;
  uen:         string;
  schema_name: string;
  fye_date:    string;
};

// ── GET handler ─────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const userId   = session.user.id as string | undefined;
  const userRole = (session.user as { role?: string }).role;
  const isAdmin  = userRole === "admin";

  // ── 2. Resolve the user's company ────────────────────────────────────────────
  // Prefer ?schema= query param (multi-company future support), otherwise auto-resolve
  // from client_schemas.user_id.
  const requestedSchema = req.nextUrl.searchParams.get("schema");
  let schemaName: string | null = null;
  let companyRow: ClientSchemaRow | null = null;

  if (requestedSchema) {
    // Caller explicitly selected a schema — verify access before trusting it
    const allowed = await verifySchemaAccess(requestedSchema, userId, userRole);
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Fetch the company metadata for the requested schema
    const { data } = await supabase
      .from("client_schemas")
      .select("name, uen, schema_name, fye_date")
      .eq("schema_name", requestedSchema)
      .maybeSingle();
    schemaName  = requestedSchema;
    companyRow  = (data ?? null) as ClientSchemaRow | null;
  } else if (userId) {
    // Auto-resolve: find schemas owned by this user
    const { data: userClients } = await supabase
      .from("client_schemas")
      .select("name, uen, schema_name, fye_date")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (userClients && userClients.length > 0) {
      // Single company (common case) — use the first (oldest) registration
      companyRow = (userClients[0] as ClientSchemaRow);
      schemaName = companyRow.schema_name;
    } else if (isAdmin) {
      // Admin fallback: no personal company but can see all — return first alphabetically
      // so the dashboard has something to show without requiring a ?schema= param
      const { data: allClients } = await supabase
        .from("client_schemas")
        .select("name, uen, schema_name, fye_date")
        .order("name", { ascending: true })
        .limit(1);
      if (allClients && allClients.length > 0) {
        companyRow = (allClients[0] as ClientSchemaRow);
        schemaName = companyRow.schema_name;
      }
    }
  }

  // No company found — user hasn't completed onboarding yet
  if (!schemaName || !companyRow) {
    const emptyResponse: DashboardResponse = {
      company:       null,
      fiscalYear:    null,
      deadlines:     null,
      latestFS:      null,
      latestPayroll: null,
      latestTax:     null,
      activeModel:   null,
      employeeCount: 0,
    };
    return NextResponse.json(emptyResponse);
  }

  // ── 3. Query the client schema in parallel ────────────────────────────────────
  // All six queries are independent — run them concurrently to minimise latency.
  const [
    fiscalYearResult,
    fsResult,
    payrollResult,
    taxResult,
    modelResult,
    employeeCountResult,
  ] = await Promise.all([
    // Latest fiscal year by end_date
    supabase
      .schema(schemaName)
      .from("fiscal_years")
      .select("start_date, end_date, status")
      .order("end_date", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Latest financial statements output
    supabase
      .schema(schemaName)
      .from("outputs")
      .select("id, created_at, fiscal_year_id")
      .eq("output_type", "financial_statements")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Latest payroll run
    supabase
      .schema(schemaName)
      .from("payroll_runs")
      .select("id, run_month, status, created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Latest tax computation
    supabase
      .schema(schemaName)
      .from("tax_computations")
      .select("id, year_of_assessment, form_type, tax_payable, created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Active financial model (partial unique index ensures at most one)
    supabase
      .schema(schemaName)
      .from("financial_models")
      .select("id, model_name, projection_years")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),

    // Employee count — head:true returns count without fetching rows
    supabase
      .schema(schemaName)
      .from("employees")
      .select("id", { count: "exact", head: true }),
  ]);

  // ── 4. Compute compliance deadlines ─────────────────────────────────────────
  // run_month is stored as "YYYY-MM-01" (first-of-month DATE) — pass directly.
  const latestPayrollMonth =
    (payrollResult.data as { run_month?: string } | null)?.run_month ?? undefined;
  const deadlines = getComplianceDeadlines(companyRow.fye_date, latestPayrollMonth);

  // ── 5. Shape and return the response ─────────────────────────────────────────
  const response: DashboardResponse = {
    company: {
      name:        companyRow.name,
      uen:         companyRow.uen,
      schema_name: companyRow.schema_name,
      fye_date:    companyRow.fye_date,
    },

    fiscalYear: fiscalYearResult.data
      ? {
          start_date: (fiscalYearResult.data as { start_date: string }).start_date,
          end_date:   (fiscalYearResult.data as { end_date: string }).end_date,
          status:     (fiscalYearResult.data as { status: string }).status,
        }
      : null,

    deadlines,

    latestFS: fsResult.data
      ? {
          id:             (fsResult.data as { id: string }).id,
          created_at:     (fsResult.data as { created_at: string }).created_at,
          fiscal_year_id: (fsResult.data as { fiscal_year_id: string }).fiscal_year_id,
        }
      : null,

    latestPayroll: payrollResult.data
      ? {
          id:         (payrollResult.data as { id: string }).id,
          run_month:  (payrollResult.data as { run_month: string }).run_month,
          status:     (payrollResult.data as { status: string }).status,
          created_at: (payrollResult.data as { created_at: string }).created_at,
        }
      : null,

    latestTax: taxResult.data
      ? {
          id:                 (taxResult.data as { id: string }).id,
          year_of_assessment: (taxResult.data as { year_of_assessment: number }).year_of_assessment,
          form_type:          (taxResult.data as { form_type: string }).form_type,
          tax_payable:        (taxResult.data as { tax_payable: number }).tax_payable,
          created_at:         (taxResult.data as { created_at: string }).created_at,
        }
      : null,

    activeModel: modelResult.data
      ? {
          id:               (modelResult.data as { id: string }).id,
          model_name:       (modelResult.data as { model_name: string }).model_name,
          projection_years: (modelResult.data as { projection_years: number }).projection_years,
        }
      : null,

    employeeCount: employeeCountResult.count ?? 0,
  };

  return NextResponse.json(response);
}
