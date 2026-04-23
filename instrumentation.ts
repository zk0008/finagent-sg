/**
 * instrumentation.ts
 *
 * Next.js 15 instrumentation hook for FinAgent-SG.
 *
 * Next.js calls register() once when the server starts. When NEXT_RUNTIME is "nodejs",
 * this hook wires the government document watcher (scripts/checkGovDocs.ts) to run
 * in the background immediately and every 24 hours of continuous uptime.
 *
 * Design constraints:
 * - Fire-and-forget: startup is never blocked. App starts normally regardless of
 *   fetch results, ChromaDB availability, or OPENAI_API_KEY presence.
 * - Node.js runtime only: the check requires fs, crypto, and Node fetch — none of
 *   which exist in the Edge runtime. The NEXT_RUNTIME guard ensures it runs once.
 * - Dev mode only: the 24-hour interval is a dev-server feature. In production,
 *   the watcher still runs once on startup (establishes baseline) but ChromaDB
 *   is typically unreachable in production, so the ingest step is a no-op.
 *
 * To review and apply any detected changes:
 *   npx tsx scripts/applyUpdates.ts
 */

export async function register(): Promise<void> {
  // Only run in the Node.js runtime — not in the Edge runtime.
  // In Next.js dev mode, register() is called for both runtimes; this guard
  // ensures the watcher starts exactly once.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic import so that the module is not loaded during Edge runtime evaluation.
  // Import errors and watcher errors are caught and logged — never thrown.
  import("./scripts/checkGovDocs")
    .then(({ startGovDocWatcher }) => {
      startGovDocWatcher().catch((err: unknown) => {
        console.error("[FinAgent-SG] Gov doc watcher error:", err);
      });
    })
    .catch((err: unknown) => {
      console.error("[FinAgent-SG] Failed to load gov doc watcher:", err);
    });
}
