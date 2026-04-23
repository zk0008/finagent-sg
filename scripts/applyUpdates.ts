/**
 * scripts/applyUpdates.ts
 *
 * Interactive CLI for reviewing and applying detected regulatory constant updates.
 *
 * Usage:
 *   npx tsx scripts/applyUpdates.ts
 *
 * Prerequisites:
 *   - scripts/pending-updates.json must exist (written by checkGovDocs.ts)
 *
 * What this does:
 * - Reads pending-updates.json written by checkGovDocs.ts
 * - For each auto-patchable constant:
 *     Shows: constant name, file, current value, proposed value, confidence, source excerpt
 *     Asks:  apply / skip / quit
 *     On apply: asks for a final confirmation, then patches the TypeScript source file
 * - For each manual-review flag:
 *     Prints the constant name, file, description, and the relevant document excerpt
 *     No patching — the developer must edit the file directly
 * - Applied updates are removed from pending-updates.json
 * - Skipped/unprocessed updates remain in pending-updates.json for the next run
 * - When all updates are processed, pending-updates.json is deleted
 *
 * Patching rules:
 *   bignum:  replaces the string value inside `const NAME = new BigNumber("VALUE");`
 *   literal: replaces the number literal in  `const NAME = VALUE;`
 *
 * The Next.js dev server hot-reloads automatically when TypeScript source files change.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { config } from "dotenv";

// ── Environment ───────────────────────────────────────────────────────────────

const ROOT = process.cwd();
config({ path: path.join(ROOT, ".env.local") });

const PENDING_FILE = path.join(ROOT, "scripts", "pending-updates.json");

// ── Interfaces ────────────────────────────────────────────────────────────────

interface ConstantUpdate {
  constantName: string;
  file: string;
  patternType: "bignum" | "literal";
  currentValue: string;
  extractedValue: string;
  confidence: "high" | "low";
  sourceText: string;
  sourceId: string;
  sourceLabel: string;
}

interface ManualReviewFlag {
  name: string;
  file: string;
  description: string;
  extractedSection: string;
  confidence: "high" | "low";
  sourceId: string;
  sourceLabel: string;
}

interface PendingUpdates {
  generatedAt: string;
  updates: ConstantUpdate[];
  manualReviewFlags: ManualReviewFlag[];
}

// ── Readline helpers ──────────────────────────────────────────────────────────

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim().toLowerCase()));
  });
}

// ── File patching ─────────────────────────────────────────────────────────────

/**
 * Patches a single named constant in a TypeScript source file content string.
 *
 * bignum:  const NAME = new BigNumber("OLD");  →  const NAME = new BigNumber("NEW");
 * literal: const NAME = OLD;                   →  const NAME = NEW;
 *
 * Returns the patched content string, or null if the pattern was not found.
 * Does NOT write to disk — caller is responsible for writing.
 */
function patchConstant(
  content: string,
  constantName: string,
  patternType: "bignum" | "literal",
  newValue: string
): string | null {
  if (patternType === "bignum") {
    const regex = new RegExp(
      `(const ${constantName}\\s*=\\s*new BigNumber\\(")[^"]*(")`
    );
    if (!regex.test(content)) return null;
    return content.replace(regex, `$1${newValue}$2`);
  } else {
    // literal: e.g. const SG_CORPORATE_TAX_RATE = 17;
    const regex = new RegExp(`(const ${constantName}\\s*=\\s*)[\\d.]+`);
    if (!regex.test(content)) return null;
    return content.replace(regex, `$1${newValue}`);
  }
}

// ── Separator helper ──────────────────────────────────────────────────────────

function hr(): void {
  console.log("─".repeat(62));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nFinAgent-SG — Regulatory Update Review\n");

  // ── Load pending-updates.json ──────────────────────────────────────────────

  if (!fs.existsSync(PENDING_FILE)) {
    console.log(
      "No pending updates found (scripts/pending-updates.json does not exist).\n" +
      "Start the dev server or run 'npx tsx scripts/checkGovDocs.ts' to check for changes."
    );
    return;
  }

  let pending: PendingUpdates;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) as PendingUpdates;
  } catch (err) {
    console.error("Failed to parse pending-updates.json:", err);
    return;
  }

  const { updates, manualReviewFlags, generatedAt } = pending;

  if (updates.length === 0 && manualReviewFlags.length === 0) {
    console.log("pending-updates.json exists but contains no items. Deleting file.");
    fs.unlinkSync(PENDING_FILE);
    return;
  }

  const dateStr = new Date(generatedAt).toLocaleString();
  console.log(`Updates detected at: ${dateStr}`);
  console.log(`  Auto-patchable constants : ${updates.length}`);
  console.log(`  Manual review flags      : ${manualReviewFlags.length}`);

  // ── Process auto-patchable updates ────────────────────────────────────────

  const skippedUpdates: ConstantUpdate[] = [];
  let quitRequested = false;

  if (updates.length > 0) {
    console.log(`\n${"─".repeat(62)}`);
    console.log(`\nAUTO-PATCHABLE CONSTANTS  (${updates.length} to review)\n`);

    const rl = createRl();

    for (let i = 0; i < updates.length; i++) {
      if (quitRequested) {
        skippedUpdates.push(updates[i]);
        continue;
      }

      const u = updates[i];
      const confLabel =
        u.confidence === "high"
          ? "HIGH"
          : "LOW — verify the document directly before applying";

      console.log(`\nUpdate ${i + 1} of ${updates.length}`);
      hr();
      console.log(`  Constant : ${u.constantName}`);
      console.log(`  File     : ${u.file}`);
      console.log(`  Source   : ${u.sourceLabel}`);
      console.log(`  Current  : "${u.currentValue}"`);
      console.log(`  Proposed : "${u.extractedValue}"  (confidence: ${confLabel})`);

      const excerpt = u.sourceText.slice(0, 200);
      console.log(
        `  Evidence : "${excerpt}${u.sourceText.length > 200 ? "…" : ""}"`
      );

      if (u.confidence === "low") {
        console.log(
          `\n  ⚠ LOW confidence — please verify ${u.sourceLabel} directly before applying.`
        );
      }

      const answer = await ask(rl, "\n  Apply this change? [y/n/q]  ");

      if (answer === "q") {
        console.log("  Quitting — remaining updates saved for next run.");
        skippedUpdates.push(u);
        quitRequested = true;
        continue;
      }

      if (answer !== "y") {
        console.log("  Skipped — update retained in pending-updates.json.");
        skippedUpdates.push(u);
        continue;
      }

      // Final confirmation before writing
      const confirm = await ask(
        rl,
        `  Confirm: modify ${u.file} and set ${u.constantName} to "${u.extractedValue}"? [y/n]  `
      );

      if (confirm !== "y") {
        console.log("  Cancelled — update retained for next run.");
        skippedUpdates.push(u);
        continue;
      }

      // Read and patch the file
      const filePath = path.join(ROOT, u.file);

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        console.log(`  ✗ Could not read ${u.file}: ${err instanceof Error ? err.message : String(err)}`);
        skippedUpdates.push(u);
        continue;
      }

      const patched = patchConstant(content, u.constantName, u.patternType, u.extractedValue);

      if (!patched) {
        console.log(
          `  ✗ Pattern not found in ${u.file} — the file may have been manually edited. Skipping.`
        );
        skippedUpdates.push(u);
        continue;
      }

      try {
        fs.writeFileSync(filePath, patched, "utf8");
      } catch (err) {
        console.log(`  ✗ Failed to write ${u.file}: ${err instanceof Error ? err.message : String(err)}`);
        skippedUpdates.push(u);
        continue;
      }

      console.log(
        `  ✓ Updated ${u.constantName}: "${u.currentValue}" → "${u.extractedValue}"  (${u.file})`
      );
      console.log(`  ↺ Next.js will hot-reload ${u.file} automatically.`);
    }

    rl.close();
  }

  // ── Manual review flags ────────────────────────────────────────────────────

  if (manualReviewFlags.length > 0) {
    console.log(`\n${"─".repeat(62)}`);
    console.log(`\nMANUAL REVIEW REQUIRED  (${manualReviewFlags.length} item(s))\n`);
    console.log(
      "These rate tables are embedded inside function bodies and cannot be auto-patched.\n" +
      "Review each item below and edit the source file directly if values have changed.\n"
    );

    for (let i = 0; i < manualReviewFlags.length; i++) {
      const f = manualReviewFlags[i];
      const confLabel = f.confidence === "high" ? "HIGH" : "LOW";

      hr();
      console.log(`${i + 1}. ${f.name}  →  ${f.file}`);
      console.log(`   Source      : ${f.sourceLabel}  (confidence: ${confLabel})`);
      console.log(`   Description : ${f.description}`);
      console.log(`\n   Document excerpt:`);

      const excerpt = f.extractedSection.slice(0, 700);
      excerpt.split("\n").forEach((line) => console.log(`     ${line}`));
      if (f.extractedSection.length > 700) {
        console.log("     […excerpt truncated…]");
      }
      console.log();
    }
  }

  // ── Save remaining (skipped/quit) updates ─────────────────────────────────

  if (skippedUpdates.length > 0) {
    const remaining: PendingUpdates = {
      generatedAt,
      updates: skippedUpdates,
      manualReviewFlags, // always retained — informational only
    };
    fs.writeFileSync(PENDING_FILE, JSON.stringify(remaining, null, 2) + "\n", "utf8");
    console.log(`\n${skippedUpdates.length} update(s) retained in pending-updates.json for next run.`);
  } else {
    // All auto-patch updates processed — clear the file
    if (fs.existsSync(PENDING_FILE)) {
      fs.unlinkSync(PENDING_FILE);
    }
    console.log("\nAll auto-patchable updates processed — pending-updates.json cleared.");
  }

  console.log("Done.\n");
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
