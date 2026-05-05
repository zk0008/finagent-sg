/**
 * lib/agents/vaultReader.ts
 *
 * Reads recent vault notes for a given client from the local Obsidian vault.
 * Returns a single concatenated string of the last N notes, separated by
 * dividers, for injection into the managerNode system prompt (V3.1-C).
 *
 * Called by: lib/agents/nodes/index.ts managerNode (V3.1-C, not yet wired).
 *
 * Notes are read from: {FINAGENT_VAULT_PATH}/{clientId}/*.md
 * Files are sorted descending by filename — since filenames are prefixed
 * YYYY-MM-DD-HH-MM, alphabetical descending gives most recent first.
 *
 * This module is read-only and crash-safe. Any error is logged but never
 * re-thrown, so a vault read failure can never abort an agent run.
 */

import fs   from "fs/promises";
import path from "path";

/**
 * Returns a concatenated string of the last `maxNotes` vault notes for
 * the given client. Returns empty string if vault is unavailable, the
 * client folder does not exist, or no .md files are found.
 *
 * @param clientId  - Schema slug e.g. "techsoft_pte_ltd"
 * @param maxNotes  - Maximum number of recent notes to include (default 5)
 */
export async function getRecentVaultNotes(
  clientId: string,
  maxNotes: number = 5
): Promise<string> {
  try {
    // Step 1 — Resolve vault path from environment variable
    const vaultPath = process.env.FINAGENT_VAULT_PATH;
    if (!vaultPath || vaultPath.trim() === "") {
      // Vault not configured — normal in production; return empty string silently
      return "";
    }

    // Step 2 — Resolve and verify the client-specific folder
    const clientFolder = path.join(vaultPath, clientId);
    try {
      await fs.access(clientFolder);  // throws if folder does not exist
    } catch {
      // Folder absent — new client with no prior runs; not an error
      return "";
    }

    // Step 3 — List, filter, sort, and take the most recent N notes
    const allFiles = await fs.readdir(clientFolder);

    const mdFiles = allFiles
      .filter((f) => f.endsWith(".md"))            // vault notes only; skip any non-markdown files
      .sort((a, b) => b.localeCompare(a))          // descending: YYYY-MM-DD-HH-MM prefix → most recent first
      .slice(0, maxNotes);                          // cap at maxNotes

    // Step 5 (early return) — no notes found
    if (mdFiles.length === 0) {
      return "";
    }

    // Step 4 — Read each selected note and concatenate with dividers
    const noteContents = await Promise.all(
      mdFiles.map((filename) =>
        fs.readFile(path.join(clientFolder, filename), "utf-8")  // read as UTF-8 text
      )
    );

    // Step 5 — Join all note bodies with the standard divider and return
    return noteContents.join("\n\n---\n\n");

  } catch (err) {
    // Step 6 — Catch-all: log but never throw — vault reader must not crash the agent run
    console.error("[vaultReader] Failed to read vault notes:", err);
    return "";
  }
}
