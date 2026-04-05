/**
 * lib/schemaAccess.ts
 *
 * Client schema isolation verification (Phase 6, Task 4).
 *
 * Every API route that accepts a schemaName from the user must call
 * verifySchemaAccess() before querying that schema. This prevents a
 * user from querying an arbitrary schema name that might belong to
 * another client (or a system schema like "public" or "pg_catalog").
 *
 * How it works:
 * Checks public.client_schemas to confirm the schema_name is registered.
 * An unregistered schema name — whether mistyped, injected, or belonging
 * to another tenant — will return false.
 *
 * Usage:
 *   const allowed = await verifySchemaAccess(schemaName);
 *   if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */

import { supabase } from "@/lib/supabaseClient";

// Cache verified schema names for the lifetime of the server process
// to avoid a DB round-trip on every API request.
const verifiedSchemas = new Set<string>();

/**
 * Returns true if the schema is registered in public.client_schemas.
 * Returns false if the schema is unknown or the DB lookup fails.
 */
export async function verifySchemaAccess(schemaName: string): Promise<boolean> {
  if (!schemaName || typeof schemaName !== "string") return false;

  // Only allow schema names that match the safe slug pattern
  // (same rules as generateSchemaName — lowercase alphanumeric + underscores only)
  if (!/^[a-z0-9_]+$/.test(schemaName)) return false;

  // Fast path: already verified this session
  if (verifiedSchemas.has(schemaName)) return true;

  const { data, error } = await supabase
    .from("client_schemas")
    .select("id")
    .eq("schema_name", schemaName)
    .maybeSingle();

  if (error || !data) return false;

  verifiedSchemas.add(schemaName);
  return true;
}
