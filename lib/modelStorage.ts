/**
 * lib/modelStorage.ts
 *
 * Supabase persistence layer for Phase 3 Financial Model data.
 *
 * What this module does:
 * Provides functions for reading base FS data, saving generated financial models,
 * and retrieving models for dashboard display and history viewing.
 *
 * Design rules (enforced here):
 * - Every model generation is an INSERT — models are never overwritten.
 * - Only one model per entity may be "active" at a time. Activating a new model
 *   deactivates the previous one within the same transaction.
 * - Phase 3 always builds from the LATEST saved FS output — no picker.
 *
 * Multi-tenant pattern:
 * All queries target the client's own Supabase schema (e.g. "techsoft_pte_ltd").
 * Schema names come from generateSchemaName() in lib/schemaUtils.ts.
 *
 * Used by:
 * - Phase 3 projection engine (Prompt 4) — reads base data via getLatestFSOutput()
 * - Phase 3 API routes (Prompt 8) — saves and retrieves models
 * - Phase 3 dashboard (Prompt 8) — reads active model and model list
 */

import { supabase } from "./supabaseClient";
import { type SavedFSRecord } from "./outputStorage";
import {
  type FinancialModel,
  type ProjectionAssumptions,
  type ProjectedFS,
} from "./schemas";

// ── Save params type ──────────────────────────────────────────────────────────

export type SaveFinancialModelParams = {
  entityId: string;
  fiscalYearId: string | null;
  sourceOutputId: string;
  modelName: string;
  projectionYears: number;
  assumptions: ProjectionAssumptions;
  baseCase: ProjectedFS[];
  bestCase?: ProjectedFS[] | null;
  worstCase?: ProjectedFS[] | null;
};

// ── List item type (summary only — no projection data) ────────────────────────

export type FinancialModelSummary = {
  id: string;
  model_name: string;
  projection_years: number;
  is_active: boolean;
  created_at: string;
};

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Retrieves the most recent saved FS output for a client schema.
 * This is the ONLY entry point for Phase 3 base data — no picker, no selection.
 * Returns null if no FS has been saved yet.
 *
 * @param schemaName - Client schema, e.g. "techsoft_pte_ltd"
 */
export async function getLatestFSOutput(
  schemaName: string
): Promise<SavedFSRecord | null> {
  const { data, error } = await supabase
    .schema(schemaName)
    .from("outputs")
    .select("*")
    .eq("output_type", "financial_statements")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no rows
    throw new Error(`Failed to retrieve latest FS output: ${error.message}`);
  }

  return data as SavedFSRecord;
}

/**
 * Saves a new financial model and sets it as the active model for the entity.
 * Deactivates the previously active model (if any) in the same operation.
 * Always inserts a new row — never updates an existing model.
 *
 * @returns The newly inserted model's id.
 */
export async function saveFinancialModel(
  schemaName: string,
  params: SaveFinancialModelParams
): Promise<string> {
  const {
    entityId,
    fiscalYearId,
    sourceOutputId,
    modelName,
    projectionYears,
    assumptions,
    baseCase,
    bestCase,
    worstCase,
  } = params;

  // Step 1: Deactivate the currently active model for this entity (if any).
  // This must happen before the INSERT so the partial unique index
  // (only one is_active = true per entity) is not violated.
  const { error: deactivateError } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("entity_id", entityId)
    .eq("is_active", true);

  if (deactivateError) {
    throw new Error(`Failed to deactivate previous model: ${deactivateError.message}`);
  }

  // Step 2: Insert the new model as active.
  const { data, error: insertError } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .insert({
      entity_id: entityId,
      fiscal_year_id: fiscalYearId,
      source_output_id: sourceOutputId,
      model_name: modelName,
      projection_years: projectionYears,
      assumptions,
      base_case: baseCase,
      best_case: bestCase ?? null,
      worst_case: worstCase ?? null,
      actuals: null,
      is_active: true,
    })
    .select("id")
    .single();

  if (insertError) {
    throw new Error(`Failed to save financial model: ${insertError.message}`);
  }

  return data.id as string;
}

/**
 * Retrieves the currently active financial model for an entity.
 * Returns null if no active model exists yet.
 *
 * Used by the Phase 3 dashboard to display the current model on load.
 *
 * @param schemaName - Client schema, e.g. "techsoft_pte_ltd"
 * @param entityId   - UUID of the entity
 */
export async function getActiveModel(
  schemaName: string,
  entityId: string
): Promise<FinancialModel | null> {
  const { data, error } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .select("*")
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no active model
    throw new Error(`Failed to retrieve active model: ${error.message}`);
  }

  return data as FinancialModel;
}

/**
 * Retrieves a specific financial model by ID.
 * Used for History tab read-only viewing.
 *
 * @param schemaName - Client schema, e.g. "techsoft_pte_ltd"
 * @param modelId    - UUID of the financial_models row
 */
export async function getFinancialModel(
  schemaName: string,
  modelId: string
): Promise<FinancialModel | null> {
  const { data, error } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .select("*")
    .eq("id", modelId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`Failed to retrieve financial model: ${error.message}`);
  }

  return data as FinancialModel;
}

/**
 * Updates the actuals JSONB column on an existing financial model.
 *
 * This is the ONE permitted UPDATE to an existing model row.
 * All other model changes (new projections, new scenarios) are always INSERTs.
 * actuals stores an array of per-year comparison entries; callers are responsible
 * for merging any existing actuals data before calling this function.
 *
 * @param schemaName - Client schema, e.g. "techsoft_pte_ltd"
 * @param modelId    - UUID of the financial_models row to update
 * @param actuals    - The full actuals value to write (replaces whatever was there)
 */
export async function updateModelActuals(
  schemaName: string,
  modelId: string,
  actuals: unknown
): Promise<void> {
  const { error } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .update({ actuals, updated_at: new Date().toISOString() })
    .eq("id", modelId);

  if (error) {
    throw new Error(`Failed to update model actuals: ${error.message}`);
  }
}

/**
 * Lists all financial models for an entity (summary only — no projection data).
 * Ordered newest first. Used by the History tab.
 *
 * @param schemaName - Client schema, e.g. "techsoft_pte_ltd"
 * @param entityId   - UUID of the entity
 */
export async function listFinancialModels(
  schemaName: string,
  entityId: string
): Promise<FinancialModelSummary[]> {
  const { data, error } = await supabase
    .schema(schemaName)
    .from("financial_models")
    .select("id, model_name, projection_years, is_active, created_at")
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list financial models: ${error.message}`);
  }

  return (data ?? []) as FinancialModelSummary[];
}
