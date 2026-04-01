-- ============================================================
-- FinAgent-SG — Supabase PostgreSQL Schema
-- ============================================================
-- Architecture: Multi-tenant, separate schema per client.
-- The "public" schema is the shared schema for platform users.
-- Each client company gets its own schema (e.g. "abc_pte_ltd").
-- Data is never mixed between client schemas.
-- ============================================================

-- ============================================================
-- SHARED SCHEMA (public)
-- ============================================================

-- users: All platform users — accountants who log in to FinAgent-SG.
-- One row per registered user. Role determines access level.
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'accountant', -- 'admin' | 'accountant'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PER-CLIENT SCHEMA TEMPLATE
-- ============================================================
-- The tables below are created once per client schema.
-- Replace "client_schema" with the actual schema name (e.g. "abc_pte_ltd").
-- Run this block for each new client you onboard.
-- ============================================================

-- USAGE: Call generate_schema_name('ABC Pte Ltd') → 'abc_pte_ltd'
-- Then run the following block, replacing "client_schema" with the real schema name:
--
--   CREATE SCHEMA IF NOT EXISTS abc_pte_ltd;
--
--   -- Required: grant Supabase API roles access to the schema and all its tables.
--   -- Without these grants, PostgREST returns "permission denied for schema ..."
--   -- even when using the service role key.
--   GRANT USAGE ON SCHEMA abc_pte_ltd TO anon, authenticated, service_role;
--   GRANT ALL ON ALL TABLES    IN SCHEMA abc_pte_ltd TO anon, authenticated, service_role;
--   GRANT ALL ON ALL SEQUENCES IN SCHEMA abc_pte_ltd TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA abc_pte_ltd
--     GRANT ALL ON TABLES    TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA abc_pte_ltd
--     GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
--
-- Then create each table below inside that schema.

-- entities: Core company information for a client.
-- One row per company. A client may have one or more entities
-- (e.g. a group with multiple subsidiaries).
CREATE TABLE IF NOT EXISTS client_schema.entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                        -- Company full legal name
  uen           TEXT NOT NULL UNIQUE,                 -- ACRA UEN (e.g. 201912345K)
  company_type  TEXT NOT NULL DEFAULT 'private_ltd',  -- 'private_ltd' | 'llp' | 'sole_prop'
  fye_date      DATE NOT NULL,                        -- Financial year end date (e.g. 2025-12-31)
  audit_exempt  BOOLEAN NOT NULL DEFAULT FALSE        -- True if small company audit exemption applies
);

-- fiscal_years: One row per financial year per entity.
-- Tracks the status of each year's work (draft, in_progress, finalised).
CREATE TABLE IF NOT EXISTS client_schema.fiscal_years (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES client_schema.entities(id) ON DELETE CASCADE,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft'  -- 'draft' | 'in_progress' | 'finalised'
);

-- trial_balances: Uploaded trial balance files and their parsed content.
-- uploaded_file_url points to the file in Vercel Blob storage.
-- parsed_data_json stores the structured rows extracted by the Excel parser (Phase 2).
CREATE TABLE IF NOT EXISTS client_schema.trial_balances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year_id    UUID NOT NULL REFERENCES client_schema.fiscal_years(id) ON DELETE CASCADE,
  uploaded_file_url TEXT NOT NULL,            -- Vercel Blob URL of the uploaded .xlsx/.csv
  parsed_data_json  JSONB                     -- Parsed rows: [{account_code, account_name, debit, credit}]
);

-- outputs: All generated output files — financial statements, payroll reports, models.
-- output_type distinguishes what kind of document was generated.
-- structured_data stores the full FS output object (all five FS components + XBRL tags).
-- classified_accounts stores the classified trial balance lines used to generate the FS.
-- exemption_result stores the audit exemption determination.
-- pdf_data stores the generated PDF as a base64 TEXT string.
--   NOTE: pdf_data will be migrated to Vercel Blob (file_url) in a future phase.
CREATE TABLE IF NOT EXISTS client_schema.outputs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year_id      UUID NOT NULL REFERENCES client_schema.fiscal_years(id) ON DELETE CASCADE,
  output_type         TEXT NOT NULL,    -- 'financial_statements' | 'payroll_report' | 'financial_model'
  structured_data     JSONB,            -- Full FSOutput object (balance sheet, P&L, cash flow, equity, notes, xbrl_tags)
  classified_accounts JSONB,            -- Array of ClassifiedAccount — the trial balance after SFRS classification
  exemption_result    JSONB,            -- ExemptionResult — small company / EPC determination
  pdf_data            TEXT,             -- Base64-encoded PDF binary (temporary; migrate to Vercel Blob later)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- financial_models: Each row is one independently generated financial model.
-- Models are never overwritten — every generation creates a new row.
-- Only one model per entity may be active at a time (enforced by partial unique index).
-- source_output_id links to the outputs row whose structured_data was used as the base.
-- assumptions holds ProjectionAssumptions (growth rates, tax rate, depreciation method).
-- base_case / best_case / worst_case hold ProjectedFS arrays (one entry per projection year).
-- actuals holds actual results for budget-vs-actual comparison (Phase 3, Task 7).
-- is_active = true marks the current active model for the dashboard display.
CREATE TABLE IF NOT EXISTS client_schema.financial_models (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         UUID NOT NULL REFERENCES client_schema.entities(id) ON DELETE CASCADE,
  fiscal_year_id    UUID REFERENCES client_schema.fiscal_years(id) ON DELETE SET NULL,
  source_output_id  UUID NOT NULL REFERENCES client_schema.outputs(id) ON DELETE RESTRICT,
  model_name        TEXT NOT NULL,
  projection_years  INTEGER NOT NULL CHECK (projection_years BETWEEN 1 AND 5),
  assumptions       JSONB NOT NULL,   -- ProjectionAssumptions object
  base_case         JSONB NOT NULL,   -- Array of ProjectedFS (one per year)
  best_case         JSONB,            -- Array of ProjectedFS — populated in Phase 3 Task 6
  worst_case        JSONB,            -- Array of ProjectedFS — populated in Phase 3 Task 6
  actuals           JSONB,            -- Actual results for budget-vs-actual (Phase 3 Task 7)
  is_active         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce: only one active model per entity at a time.
-- A partial unique index on (entity_id) WHERE is_active = true makes it impossible
-- to have two rows with is_active = true for the same entity_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_model_per_entity
  ON client_schema.financial_models (entity_id)
  WHERE is_active = true;

-- corrections: User corrections submitted via the chatbot while reviewing outputs.
-- Linked to a specific output. Used for the immediate RAG update and monthly fine-tuning.
CREATE TABLE IF NOT EXISTS client_schema.corrections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id        UUID NOT NULL REFERENCES client_schema.outputs(id) ON DELETE CASCADE,
  field            TEXT NOT NULL,           -- The field or line item being corrected
  original_value   TEXT NOT NULL,           -- What the AI produced
  corrected_value  TEXT NOT NULL,           -- What the user says it should be
  status           TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected'
);

-- employees: Employee records used for payroll and CPF computation (Phase 4).
-- One row per employee per client entity.
-- citizenship determines which CPF rate table applies:
--   'SC'        → Table 1 (full SC rates)
--   'SPR_1'     → Table 2 (1st year SPR graduated G/G rates)
--   'SPR_2'     → Table 3 (2nd year SPR graduated G/G rates)
--   'SPR_3'     → Table 1 (3rd year+ SPR — same as SC rates)
--   'foreigner' → No CPF; SDL still applies
CREATE TABLE IF NOT EXISTS client_schema.employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES client_schema.entities(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                       -- Employee full legal name as per NRIC/FIN
  nric_fin        TEXT,                                -- NRIC (SC/SPR) or FIN (foreigner); nullable for privacy
  dob             DATE NOT NULL,                       -- Date of birth — used for age-tiered CPF rates
  citizenship     TEXT NOT NULL,                       -- 'SC' | 'SPR_1' | 'SPR_2' | 'SPR_3' | 'foreigner'
  monthly_salary  NUMERIC(12, 2) NOT NULL,             -- Ordinary wages per month in SGD
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- payroll_runs: One row per monthly payroll run per entity.
-- A payroll run starts as 'draft' and is moved to 'finalised' after review.
-- Finalised runs are locked and cannot be edited.
CREATE TABLE IF NOT EXISTS client_schema.payroll_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES client_schema.entities(id) ON DELETE CASCADE,
  run_month   DATE NOT NULL,                           -- First day of the payroll month (e.g. 2025-12-01)
  status      TEXT NOT NULL DEFAULT 'draft',           -- 'draft' | 'finalised'
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- payslips: Individual payslip for one employee in one payroll run.
-- Stores all computed payroll values: CPF contributions, SDL, net pay.
-- allowances and deductions are itemised JSONB arrays: [{label, amount}].
-- employee_cpf is deducted from gross pay; employer_cpf is a separate cost.
CREATE TABLE IF NOT EXISTS client_schema.payslips (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id   UUID NOT NULL REFERENCES client_schema.payroll_runs(id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES client_schema.employees(id) ON DELETE CASCADE,
  ordinary_wages   NUMERIC(12, 2) NOT NULL,            -- OW for this month (capped at $8,000 for CPF)
  additional_wages NUMERIC(12, 2) NOT NULL DEFAULT 0, -- AW for this month (subject to annual AW ceiling)
  allowances       JSONB,                              -- [{label: string, amount: number}]
  deductions       JSONB,                              -- [{label: string, amount: number}] — excluding CPF
  employee_cpf     NUMERIC(12, 2) NOT NULL,            -- Employee CPF share (deducted from pay)
  employer_cpf     NUMERIC(12, 2) NOT NULL,            -- Employer CPF share (separate cost; not deducted from pay)
  total_cpf        NUMERIC(12, 2) NOT NULL,            -- Total CPF = employee_cpf + employer_cpf
  sdl              NUMERIC(12, 2) NOT NULL,            -- Skills Development Levy (all employees incl. foreigners)
  net_pay          NUMERIC(12, 2) NOT NULL,            -- Gross pay + allowances − employee_cpf − other deductions
  created_at       TIMESTAMPTZ DEFAULT now()
);
