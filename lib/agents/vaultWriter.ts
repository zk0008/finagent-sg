/**
 * lib/agents/vaultWriter.ts
 *
 * Writes a structured markdown note to a local Obsidian vault after each
 * successful agent run. The vault path is configured via FINAGENT_VAULT_PATH.
 *
 * Called by: app/api/agent/route.ts after graph:complete (V3.1-B, not yet wired).
 *
 * Notes are written to: {FINAGENT_VAULT_PATH}/{clientId}/YYYY-MM-DD-HH-MM-{workflow}.md
 * The vault folder lives outside the Next.js project root — no path enforcement here.
 *
 * This module is intentionally write-only and crash-safe. Any error is logged
 * but never re-thrown, so a vault write failure can never abort an agent run.
 */

import fs   from "fs/promises";
import path from "path";

// Parameters accepted by writeVaultNote — all fields provided by the agent SSE handler
export interface VaultNoteParams {
  clientId:                 string;                    // schema slug e.g. "techsoft_pte_ltd"
  goal:                     string;                    // raw user goal string
  workflows:                string[];                  // e.g. ["financial_statement", "tax"]
  inputsUsed:               Record<string, string>;    // key → value pairs of inputs the agent ran with
  dataFetched:              Record<string, string>;    // what each node pulled from Supabase
  outputsGenerated:         Record<string, string>;    // workflow → summary of saved output
  optionalInputsNotApplied: Record<string, string[]>; // workflow → list of optional inputs that were absent
  errors:                   Record<string, string>;    // nodeName → error message (empty on clean run)
}

// ── Date / time helpers ──────────────────────────────────────────────────────

// Zero-pad a number to 2 digits (used for month, day, hour, minute)
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// Returns the current local time as "YYYY-MM-DD-HH-MM" for use in filenames
function filenameTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    pad2(now.getHours()),
    pad2(now.getMinutes()),
  ].join("-");
}

// Returns the current local time as "D MMM YYYY HH:MM" for human-readable note header
function readableTimestamp(): string {
  const now        = new Date();
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day        = now.getDate();                        // no leading zero for day
  const month      = monthNames[now.getMonth()];
  const year       = now.getFullYear();
  const time       = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return `${day} ${month} ${year} ${time}`;
}

// ── Note content builder ─────────────────────────────────────────────────────

// Renders a Record<string, string> as a bullet list; falls back to fallback if empty
function renderKVList(map: Record<string, string>, fallback: string): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return fallback;
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

// Renders a Record<string, string[]> as grouped bullet lists; falls back if all arrays empty
function renderGroupedList(map: Record<string, string[]>): string {
  const allItems = Object.values(map).flat();
  if (allItems.length === 0) return "- None";
  return Object.entries(map)
    .filter(([, items]) => items.length > 0)             // skip workflows with no items
    .flatMap(([, items]) => items.map((item) => `- ${item}`))
    .join("\n");
}

// Assembles the full markdown note body from the given params
function buildNoteContent(params: VaultNoteParams): string {
  // Title uses workflows joined with " + " for readability
  const workflowTitle = params.workflows.length > 0
    ? params.workflows.join(" + ")
    : "unknown";

  const lines: string[] = [
    `# FinAgent Run — ${workflowTitle}`,
    `Date: ${readableTimestamp()}`,
    `Client: ${params.clientId}`,
    "",
    "## Goal",
    `"${params.goal}"`,
    "",
    "## Inputs Used",
    renderKVList(params.inputsUsed, "- None recorded"),
    "",
    "## Data Fetched from Supabase",
    renderKVList(params.dataFetched, "- None"),
    "",
    "## Outputs Generated",
    renderKVList(params.outputsGenerated, "- None"),
    "",
    "## Optional Inputs Not Applied",
    renderGroupedList(params.optionalInputsNotApplied),
    "",
    "## Errors",
    renderKVList(params.errors, "- None"),
  ];

  // ── Obsidian wiki-link tags ──────────────────────────────────────────────
  // Each note gets [[clientId]] and one [[workflow]] link per workflow.
  // These create edges in Obsidian's graph view so all notes for the same
  // client or workflow type cluster together visually.
  const workflowLinks = params.workflows.length > 0
    ? params.workflows.map((w) => `[[${w}]]`).join(" ")  // e.g. [[financial_statement]] [[tax]]
    : "[[unknown]]";

  lines.push(
    "",                                                         // blank line before divider
    "---",                                                      // horizontal rule
    `**Tags:** [[${params.clientId}]] ${workflowLinks}`,       // wiki-links for graph view
  );

  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Writes a structured markdown note to the local Obsidian vault.
 *
 * Safe to call unconditionally after every agent run:
 * - Returns silently if FINAGENT_VAULT_PATH is not configured
 * - Catches and logs all errors without re-throwing
 */
export async function writeVaultNote(params: VaultNoteParams): Promise<void> {
  try {
    // Step 1 — Resolve vault path from environment variable
    const vaultPath = process.env.FINAGENT_VAULT_PATH;
    if (!vaultPath || vaultPath.trim() === "") {
      // Vault not configured — this is normal in production (Vercel has no persistent FS)
      console.warn("FINAGENT_VAULT_PATH not set — vault note not written");
      return;
    }

    // Step 2 — Build and create the client folder (idempotent — recursive mkdir)
    const clientFolder = path.join(vaultPath, params.clientId);
    await fs.mkdir(clientFolder, { recursive: true });  // no-op if folder already exists

    // Step 3 — Build filename: YYYY-MM-DD-HH-MM-{workflow_slug}.md
    // Multiple workflows are joined with underscore for a valid filename
    const workflowSlug = params.workflows.length > 0
      ? params.workflows
          .map((w) => w.toLowerCase().replace(/\s+/g, "_"))  // normalise spaces to underscores
          .join("_")
      : "unknown";

    const filename = `${filenameTimestamp()}-${workflowSlug}.md`;

    // Step 4 — Build the markdown note content
    const content = buildNoteContent(params);

    // Step 5 — Write the file to disk
    const notePath = path.join(clientFolder, filename);
    await fs.writeFile(notePath, content, "utf-8");

    console.log(`[vaultWriter] Note written: ${notePath}`);

  } catch (err) {
    // Step 6 — Catch-all: log but never throw — vault writer must not crash the agent run
    console.error("[vaultWriter] Failed to write vault note:", err);
  }
}
