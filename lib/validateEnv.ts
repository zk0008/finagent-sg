/**
 * lib/validateEnv.ts
 *
 * Environment variable validation (Phase 6).
 *
 * Called once in app/layout.tsx on server startup.
 * Throws a clear, descriptive error if any required variable is missing,
 * so misconfiguration is caught immediately rather than producing cryptic
 * runtime errors deep in the call stack.
 *
 * Required variables:
 *   OPENAI_API_KEY             — Vercel AI SDK + OpenAI fine-tuning
 *   NEXTAUTH_SECRET            — NextAuth JWT signing
 *   NEXT_PUBLIC_SUPABASE_URL   — Supabase project URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY — Supabase public anon key
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role (server only)
 *   LANGFUSE_PUBLIC_KEY        — Langfuse observability
 *   LANGFUSE_SECRET_KEY        — Langfuse observability
 *   LANGFUSE_HOST              — Langfuse server URL
 */

const REQUIRED_ENV_VARS = [
  "OPENAI_API_KEY",
  "NEXTAUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
] as const;

/**
 * Validates all required environment variables are present.
 * Safe to call in server context (layout.tsx, API routes, lib files).
 * No-ops in test environments where variables may be intentionally absent.
 */
export function validateEnv(): void {
  // Skip in test environments
  if (process.env.NODE_ENV === "test") return;

  const missing = REQUIRED_ENV_VARS.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `FinAgent-SG: Missing required environment variables:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nCopy .env.example to .env.local and fill in all values.`
    );
  }
}
