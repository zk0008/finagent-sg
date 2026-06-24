/**
 * lib/schemaAccess.ts
 *
 * Client schema isolation verification.
 *
 * Every API route that accepts a schemaName from the user must call
 * verifySchemaAccess() before querying that schema. This prevents a
 * user from querying an arbitrary schema name that might belong to
 * another client (or a system schema like "public" or "pg_catalog").
 *
 * Access rules:
 *   - admin role: schema_name match only — admins can access all clients.
 *   - accountant role: schema_name AND user_id must match — accountants
 *     can only access schemas they own.
 *   - Internal server-to-server routes pass userRole = "admin" explicitly.
 *
 * Usage:
 *   const allowed = await verifySchemaAccess(schemaName, userId, userRole);
 *   if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */

import { supabase } from "@/lib/supabaseClient";

// Cache verified (schemaName, userId) pairs for the lifetime of the server process
// to avoid a DB round-trip on every API request.
const verifiedSchemas = new Set<string>();

/**
 * Returns true if the schema is accessible by the requesting user.
 * Returns false if the schema is unknown, the user doesn't own it, or the DB lookup fails.
 *
 * @param schemaName  PostgreSQL schema slug to verify (e.g. "abc_pte_ltd")
 * @param userId      Session user id — required for non-admin access checks
 * @param userRole    "admin" bypasses ownership check; any other value (or undefined) enforces it
 */
export async function verifySchemaAccess(
  schemaName: string,
  userId?: string,
  userRole?: string,
): Promise<boolean> {
  if (!schemaName || typeof schemaName !== "string") return false;

  // Only allow schema names that match the safe slug pattern
  // (same rules as generateSchemaName — lowercase alphanumeric + underscores only)
  if (!/^[a-z0-9_]+$/.test(schemaName)) return false;

  const isAdmin = userRole === "admin";

  // Non-admin with no userId — cannot verify ownership, deny immediately
  if (!isAdmin && !userId) return false;

  // Composite cache key so different users have separate entries
  const cacheKey = `${schemaName}:${userId ?? "anon"}`;

  // Fast path: already verified this session
  if (verifiedSchemas.has(cacheKey)) return true;

  let query = supabase
    .from("client_schemas")
    .select("id")
    .eq("schema_name", schemaName);

  // Admin sees all schemas; accountants are scoped to schemas they own
  if (!isAdmin) {
    query = query.eq("user_id", userId!);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) return false;

  verifiedSchemas.add(cacheKey);
  return true;
}
