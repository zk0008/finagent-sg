/**
 * lib/supabaseClient.ts
 *
 * Server-side Supabase client for FinAgent-SG.
 *
 * What this module does:
 * Creates and exports a singleton Supabase client using the service role key,
 * which bypasses Row Level Security and is suitable for server-side operations.
 *
 * IMPORTANT: This client must only be used in server-side code (API routes, lib/).
 * Never import this in client components — the service role key must never be
 * exposed to the browser.
 *
 * Used by: lib/outputStorage.ts (Phase 2+), and future agent modules in Phase 3+.
 *
 * Env vars required:
 * - NEXT_PUBLIC_SUPABASE_URL  — the project URL (e.g. https://xxxx.supabase.co)
 * - SUPABASE_SERVICE_ROLE_KEY — the service role secret key (not the anon key)
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    // Service role clients do not need session persistence
    persistSession: false,
    autoRefreshToken: false,
  },
});
