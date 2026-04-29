/**
 * scripts/checkGovDocs.ts
 *
 * Startup-triggered government document watcher for FinAgent-SG.
 *
 * What this does:
 * - Fetches monitored Singapore government URLs (CPF Board, IRAS, ASC)
 * - Computes a SHA-256 hash of each fetched document
 * - Compares against the stored hash in scripts/ingest-sources.json
 * - On first run (empty hash): establishes baseline hash and re-ingests into ChromaDB
 * - On change detected: re-ingests into ChromaDB, extracts updated constant values
 *   via GPT-4.1-mini, writes detected changes to scripts/pending-updates.json,
 *   and prints a diff summary to the terminal
 * - Schedules a re-check every 24 hours of uptime
 *
 * Auto-patchable constants (lib/cpfEngine.ts, lib/taxEngine.ts, lib/assumptionSuggester.ts):
 *   These are named `const` declarations that can be safely regex-replaced.
 *   User confirms each change via scripts/applyUpdates.ts before any file is written.
 *
 * Manual-review constants (CPF rate tables in function bodies):
 *   getTable1Rates, getTable2Rates, getTable3Rates in lib/cpfEngine.ts.
 *   These are flagged with the relevant document excerpt — no auto-patching.
 *
 * Called by: instrumentation.ts (Next.js startup hook, Node.js runtime only)
 * Also runnable standalone: npx tsx scripts/checkGovDocs.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// ── Path constants ────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "scripts", "ingest-sources.json");
const PENDING_FILE = path.join(ROOT, "scripts", "pending-updates.json");
const MAX_DOC_CHARS = 30_000; // Truncation limit for GPT extraction prompt

// ── Interfaces ────────────────────────────────────────────────────────────────

interface SourceEntry {
  id: string;
  label: string;
  url: string;
  lastHash: string;
  lastChecked: string | null;
}

interface SourcesConfig {
  sources: SourceEntry[];
}

interface ConstantInfo {
  name: string;
  file: string;            // relative to project root, e.g. "lib/cpfEngine.ts"
  patternType: "bignum" | "literal";
  description: string;
  extractionKey: string;   // key in the extraction Zod schema
}

interface ManualReviewInfo {
  name: string;
  file: string;
  description: string;
  extractionKey: string;
}

interface SourceConstantConfig {
  autoPatch: ConstantInfo[];
  manualReview: ManualReviewInfo[];
}

export interface ConstantUpdate {
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

export interface ManualReviewFlag {
  name: string;
  file: string;
  description: string;
  extractedSection: string;
  confidence: "high" | "low";
  sourceId: string;
  sourceLabel: string;
}

export interface PendingUpdates {
  generatedAt: string;
  updates: ConstantUpdate[];
  manualReviewFlags: ManualReviewFlag[];
}

// ── Extraction Zod schemas ────────────────────────────────────────────────────

const extractionEntrySchema = z.object({
  value: z
    .string()
    .describe(
      "The extracted numeric value as a plain string — no currency symbols, no commas, no percent sign. " +
      "Represent percentages as decimals unless the specific field says otherwise (e.g. 17% → '0.17')."
    ),
  confidence: z
    .enum(["high", "low"])
    .describe(
      "high = value found explicitly in a labelled table or unambiguous sentence; " +
      "low = inferred, ambiguous, or you are not certain"
    ),
  sourceText: z
    .string()
    .max(400)
    .describe("Brief verbatim excerpt from the document clearly showing the value"),
});

/** Fields extracted from the CPF contribution rate document */
const cpfExtractionSchema = z.object({
  ow_ceiling: extractionEntrySchema
    .nullable()
    .describe("Monthly ordinary wage ceiling in SGD — plain integer, e.g. '8000'"),
  annual_salary_ceiling: extractionEntrySchema
    .nullable()
    .describe("Annual wage ceiling (OW + AW combined) in SGD — plain integer, e.g. '102000'"),
  sdl_rate: extractionEntrySchema
    .nullable()
    .describe("Skills Development Levy rate as decimal — e.g. '0.0025' for 0.25%"),
  sdl_min: extractionEntrySchema
    .nullable()
    .describe("SDL minimum amount in SGD — plain number, e.g. '2'"),
  sdl_max: extractionEntrySchema
    .nullable()
    .describe("SDL maximum amount in SGD — plain number, e.g. '11.25'"),
  sdl_wage_cap: extractionEntrySchema
    .nullable()
    .describe("SDL wage cap — wages above this are not subject to SDL, in SGD — plain integer, e.g. '4500'"),
  table1_rates: z
    .object({
      confidence: z.enum(["high", "low"]),
      sourceText: z
        .string()
        .max(1000)
        .describe("Full textual content of the SC and 3rd-year SPR rate table showing all age tiers"),
    })
    .nullable()
    .describe("CPF Table 1: SC and SPR 3rd year+ contribution rates by age tier"),
  table2_rates: z
    .object({
      confidence: z.enum(["high", "low"]),
      sourceText: z
        .string()
        .max(1000)
        .describe("Full textual content of the SPR 1st year rate table showing all age tiers"),
    })
    .nullable()
    .describe("CPF Table 2: SPR 1st year (graduated G/G) contribution rates by age tier"),
  table3_rates: z
    .object({
      confidence: z.enum(["high", "low"]),
      sourceText: z
        .string()
        .max(1000)
        .describe("Full textual content of the SPR 2nd year rate table showing all age tiers"),
    })
    .nullable()
    .describe("CPF Table 3: SPR 2nd year (graduated G/G) contribution rates by age tier"),
});

/** Fields extracted from the IRAS corporate tax rate document */
const irasExtractionSchema = z.object({
  tax_rate: extractionEntrySchema
    .nullable()
    .describe("Corporate income tax rate as decimal — e.g. '0.17' for 17%"),
  startup_tier1_cap: extractionEntrySchema
    .nullable()
    .describe("New start-up tax exemption first tier income cap in SGD — e.g. '100000'"),
  startup_tier1_exempt: extractionEntrySchema
    .nullable()
    .describe("New start-up first tier exemption rate as decimal — e.g. '0.75' for 75%"),
  startup_tier2_cap: extractionEntrySchema
    .nullable()
    .describe("New start-up tax exemption second tier income cap in SGD — e.g. '100000'"),
  startup_tier2_exempt: extractionEntrySchema
    .nullable()
    .describe("New start-up second tier exemption rate as decimal — e.g. '0.50' for 50%"),
  partial_tier1_cap: extractionEntrySchema
    .nullable()
    .describe("Partial tax exemption first tier income cap in SGD — e.g. '10000'"),
  partial_tier1_exempt: extractionEntrySchema
    .nullable()
    .describe("Partial exemption first tier rate as decimal — e.g. '0.75' for 75%"),
  partial_tier2_cap: extractionEntrySchema
    .nullable()
    .describe("Partial tax exemption second tier income cap in SGD — e.g. '190000'"),
  partial_tier2_exempt: extractionEntrySchema
    .nullable()
    .describe("Partial exemption second tier rate as decimal — e.g. '0.50' for 50%"),
  cit_rebate_rate: extractionEntrySchema
    .nullable()
    .describe("YA CIT rebate rate as decimal — e.g. '0.40' for 40%"),
  cit_rebate_cap: extractionEntrySchema
    .nullable()
    .describe("YA CIT rebate cap in SGD — e.g. '30000'"),
  cit_cash_grant: extractionEntrySchema
    .nullable()
    .describe("CIT rebate cash grant amount in SGD — e.g. '1500'"),
  form_cs_lite_cap: extractionEntrySchema
    .nullable()
    .describe("Revenue threshold for Form C-S Lite in SGD — e.g. '200000'"),
  form_cs_cap: extractionEntrySchema
    .nullable()
    .describe("Revenue threshold for Form C-S (above → Form C required) in SGD — e.g. '5000000'"),
  sg_corporate_tax_rate: extractionEntrySchema
    .nullable()
    .describe(
      "Corporate tax rate as an integer percentage string (NOT decimal) — e.g. '17' for 17%. " +
      "This is used in AI prompt text, not arithmetic."
    ),
  sg_small_company_effective_tax_rate: extractionEntrySchema
    .nullable()
    .describe(
      "Effective tax rate for small company with partial exemption, as a decimal percentage string — " +
      "e.g. '8.5' for 8.5%. This is used in AI prompt text, not arithmetic."
    ),
});

type CpfExtraction = z.infer<typeof cpfExtractionSchema>;
type IrasExtraction = z.infer<typeof irasExtractionSchema>;

// Generic field shape for auto-patchable entries (have a .value field)
type AutoPatchEntry = { value: string; confidence: "high" | "low"; sourceText: string };
// Generic field shape for manual review entries (no .value field)
type ManualEntry = { confidence: "high" | "low"; sourceText: string };

// ── Constant map ──────────────────────────────────────────────────────────────

/**
 * Maps each monitored source ID to its list of auto-patchable constants and
 * manual-review constants.
 *
 * auto-patchable: named `const` declarations that can be safely replaced by regex.
 * manual-review: values embedded inside function bodies — flag and show excerpt only.
 */
const CONSTANT_MAP: Record<string, SourceConstantConfig> = {
  cpf_rates: {
    autoPatch: [
      {
        name: "OW_CEILING",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "Monthly ordinary wage ceiling ($)",
        extractionKey: "ow_ceiling",
      },
      {
        name: "ANNUAL_SALARY_CEILING",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "Annual wage ceiling — OW + AW combined ($)",
        extractionKey: "annual_salary_ceiling",
      },
      {
        name: "SDL_RATE",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "SDL rate as decimal (e.g. 0.0025 for 0.25%)",
        extractionKey: "sdl_rate",
      },
      {
        name: "SDL_MIN",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "SDL minimum amount ($)",
        extractionKey: "sdl_min",
      },
      {
        name: "SDL_MAX",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "SDL maximum amount ($)",
        extractionKey: "sdl_max",
      },
      {
        name: "SDL_WAGE_CAP",
        file: "lib/cpfEngine.ts",
        patternType: "bignum",
        description: "SDL wage cap — wages above this are not subject to SDL ($)",
        extractionKey: "sdl_wage_cap",
      },
    ],
    manualReview: [
      {
        name: "getTable1Rates",
        file: "lib/cpfEngine.ts",
        description:
          "SC and SPR 3rd year+ employer/employee contribution rates by age tier (lib/cpfEngine.ts lines 64–76). " +
          "Edit the inline rate literals in getTable1Rates() manually.",
        extractionKey: "table1_rates",
      },
      {
        name: "getTable2Rates",
        file: "lib/cpfEngine.ts",
        description:
          "SPR 1st year graduated employer/employee rates by age tier (lib/cpfEngine.ts lines 83–94). " +
          "Edit the inline rate literals in getTable2Rates() manually.",
        extractionKey: "table2_rates",
      },
      {
        name: "getTable3Rates",
        file: "lib/cpfEngine.ts",
        description:
          "SPR 2nd year graduated employer/employee rates by age tier (lib/cpfEngine.ts lines 100–111). " +
          "Edit the inline rate literals in getTable3Rates() manually.",
        extractionKey: "table3_rates",
      },
    ],
  },

  iras_corporate_tax: {
    autoPatch: [
      {
        name: "TAX_RATE",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Corporate income tax rate as decimal (e.g. 0.17 for 17%)",
        extractionKey: "tax_rate",
      },
      {
        name: "STARTUP_TIER1_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "New start-up exemption tier 1 income cap ($)",
        extractionKey: "startup_tier1_cap",
      },
      {
        name: "STARTUP_TIER1_EXEMPT",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "New start-up tier 1 exemption rate as decimal",
        extractionKey: "startup_tier1_exempt",
      },
      {
        name: "STARTUP_TIER2_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "New start-up exemption tier 2 income cap ($)",
        extractionKey: "startup_tier2_cap",
      },
      {
        name: "STARTUP_TIER2_EXEMPT",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "New start-up tier 2 exemption rate as decimal",
        extractionKey: "startup_tier2_exempt",
      },
      {
        name: "PARTIAL_TIER1_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Partial tax exemption tier 1 income cap ($)",
        extractionKey: "partial_tier1_cap",
      },
      {
        name: "PARTIAL_TIER1_EXEMPT",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Partial tax exemption tier 1 rate as decimal",
        extractionKey: "partial_tier1_exempt",
      },
      {
        name: "PARTIAL_TIER2_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Partial tax exemption tier 2 income cap ($)",
        extractionKey: "partial_tier2_cap",
      },
      {
        name: "PARTIAL_TIER2_EXEMPT",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Partial tax exemption tier 2 rate as decimal",
        extractionKey: "partial_tier2_exempt",
      },
      {
        name: "CIT_REBATE_RATE",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "YA CIT rebate rate as decimal (e.g. 0.40 for 40%)",
        extractionKey: "cit_rebate_rate",
      },
      {
        name: "CIT_REBATE_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "YA CIT rebate cap ($)",
        extractionKey: "cit_rebate_cap",
      },
      {
        name: "CIT_CASH_GRANT",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "CIT rebate cash grant amount ($)",
        extractionKey: "cit_cash_grant",
      },
      {
        name: "FORM_CS_LITE_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Revenue threshold for Form C-S Lite ($)",
        extractionKey: "form_cs_lite_cap",
      },
      {
        name: "FORM_CS_CAP",
        file: "lib/taxEngine.ts",
        patternType: "bignum",
        description: "Revenue threshold for Form C-S ($)",
        extractionKey: "form_cs_cap",
      },
      {
        name: "SG_CORPORATE_TAX_RATE",
        file: "lib/assumptionSuggester.ts",
        patternType: "literal",
        description: "Tax rate as integer % used in AI prompt text (e.g. 17 for 17%)",
        extractionKey: "sg_corporate_tax_rate",
      },
      {
        name: "SG_SMALL_COMPANY_EFFECTIVE_TAX_RATE",
        file: "lib/assumptionSuggester.ts",
        patternType: "literal",
        description: "Effective small company tax rate % used in AI prompt text (e.g. 8.5)",
        extractionKey: "sg_small_company_effective_tax_rate",
      },
    ],
    manualReview: [],
  },

  // ACRA/ASC: no constants to extract — re-ingest only for knowledge base freshness
  acra_sfrs: {
    autoPatch: [],
    manualReview: [],
  },
};

// ── HTML stripping ────────────────────────────────────────────────────────────

/**
 * Strips HTML tags from a document string, leaving readable plain text.
 * Removes <script> and <style> blocks entirely before stripping tags.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── SHA-256 hash ──────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Read current constant value from source file ──────────────────────────────

/**
 * Reads the current hardcoded value of a named constant from a TypeScript source file.
 *
 * Handles two patterns:
 *   bignum:  const NAME = new BigNumber("VALUE");  → returns "VALUE"
 *   literal: const NAME = 17;                      → returns "17"
 */
function readCurrentValue(
  filePath: string,
  constantName: string,
  patternType: "bignum" | "literal"
): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return "unknown";
  }

  if (patternType === "bignum") {
    const match = content.match(
      new RegExp(`const ${constantName}\\s*=\\s*new BigNumber\\("([^"]+)"\\)`)
    );
    return match?.[1] ?? "unknown";
  } else {
    const match = content.match(
      new RegExp(`const ${constantName}\\s*=\\s*([\\d.]+)`)
    );
    return match?.[1] ?? "unknown";
  }
}

// ── GPT extraction ────────────────────────────────────────────────────────────

async function extractCpfConstants(text: string): Promise<CpfExtraction> {
  const { object } = await generateObject({
    model: openai("gpt-4.1-mini"),
    schema: cpfExtractionSchema,
    system:
      "You are extracting specific regulatory values from a Singapore CPF Board document about " +
      "contribution rates and the Skills Development Levy (SDL). " +
      "Extract only values that are explicitly stated. " +
      "Return monetary amounts as plain numbers without $ or commas (e.g. '8000' not '$8,000'). " +
      "Return rates as decimals (e.g. '0.0025' for 0.25%). " +
      "For rate tables, extract the full text of the table showing employer/employee rates by age tier. " +
      "Omit any field where you cannot find the value in the document.",
    prompt: `Extract regulatory values from this CPF document:\n\n${text.slice(0, MAX_DOC_CHARS)}`,
  });
  return object;
}

async function extractIrasConstants(text: string): Promise<IrasExtraction> {
  const { object } = await generateObject({
    model: openai("gpt-4.1-mini"),
    schema: irasExtractionSchema,
    system:
      "You are extracting specific regulatory values from a Singapore IRAS document about " +
      "corporate income tax rates, rebates, and exemption schemes. " +
      "Return tax rates as decimals (e.g. '0.17' for 17%, '0.75' for 75%), " +
      "EXCEPT: sg_corporate_tax_rate should be an integer string (e.g. '17' for 17%), " +
      "and sg_small_company_effective_tax_rate should be a decimal percentage string (e.g. '8.5' for 8.5%). " +
      "Return monetary thresholds as plain integers without $ or commas (e.g. '100000' not '$100,000'). " +
      "Omit any field where you cannot find the value in the document.",
    prompt: `Extract regulatory values from this IRAS corporate tax document:\n\n${text.slice(0, MAX_DOC_CHARS)}`,
  });
  return object;
}

// ── Process one source ────────────────────────────────────────────────────────

async function processSource(
  source: SourceEntry,
  allUpdates: ConstantUpdate[],
  allManualFlags: ManualReviewFlag[]
): Promise<SourceEntry> {
  const tag = `[GovDocs] ${source.label}`;

  // Fetch the document
  let rawHtml: string;
  try {
    const response = await fetch(source.url, {
      headers: { "User-Agent": "FinAgent-SG/1.0 (automated regulatory update check)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`${tag}: HTTP ${response.status} — skipping`);
      return source;
    }
    rawHtml = await response.text();
  } catch (err) {
    console.warn(`${tag}: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
    return source;
  }

  const newHash = sha256(rawHtml);
  const isFirstRun = source.lastHash === "" || source.lastHash == null;
  const isChanged = !isFirstRun && source.lastHash !== newHash;

  const updatedSource: SourceEntry = {
    ...source,
    lastHash: newHash,
    lastChecked: new Date().toISOString(),
  };

  // ── First run: establish baseline, ingest, no diff ──────────────────────────
  if (isFirstRun) {
    console.log(`${tag}: first run — establishing hash baseline and ingesting into ChromaDB…`);
    try {
      const { ingestText } = await import("../lib/ingest");
      const stripped = stripHtml(rawHtml);
      const chunks = await ingestText(stripped, `gov_doc::${source.id}`, source.id);
      console.log(`${tag}: ingested ${chunks} chunk(s)`);
    } catch (err) {
      console.warn(
        `${tag}: ingest failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return updatedSource;
  }

  // ── No change ───────────────────────────────────────────────────────────────
  if (!isChanged) {
    console.log(`${tag}: no change`);
    return updatedSource;
  }

  // ── Document changed ─────────────────────────────────────────────────────────
  console.log(`${tag}: CHANGED — re-ingesting and extracting constants…`);

  // Re-ingest updated document into ChromaDB
  try {
    const { ingestText } = await import("../lib/ingest");
    const stripped = stripHtml(rawHtml);
    const chunks = await ingestText(stripped, `gov_doc::${source.id}`, source.id);
    console.log(`${tag}: re-ingested ${chunks} chunk(s)`);
  } catch (err) {
    console.warn(
      `${tag}: re-ingest failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Skip extraction if OPENAI_API_KEY is not set
  if (!process.env.OPENAI_API_KEY) {
    console.warn(`${tag}: OPENAI_API_KEY not set — skipping constant extraction`);
    return updatedSource;
  }

  const config = CONSTANT_MAP[source.id];
  if (!config || (config.autoPatch.length === 0 && config.manualReview.length === 0)) {
    return updatedSource;
  }

  const strippedText = stripHtml(rawHtml);

  try {
    // Run the appropriate extraction for this source
    let extraction: CpfExtraction | IrasExtraction | null = null;
    if (source.id === "cpf_rates") {
      extraction = await extractCpfConstants(strippedText);
    } else if (source.id === "iras_corporate_tax") {
      extraction = await extractIrasConstants(strippedText);
    }

    if (!extraction) {
      return updatedSource;
    }

    // Access extracted fields by key using a record cast
    const record = extraction as Record<string, AutoPatchEntry | ManualEntry | undefined>;

    // ── Auto-patchable constants ───────────────────────────────────────────────
    for (const constInfo of config.autoPatch) {
      const raw = record[constInfo.extractionKey];
      if (!raw || !("value" in raw)) continue;
      const extracted = raw as AutoPatchEntry;
      if (!extracted.value?.trim()) continue;

      const filePath = path.join(ROOT, constInfo.file);
      const currentValue = readCurrentValue(filePath, constInfo.name, constInfo.patternType);

      // Skip if unchanged
      if (extracted.value.trim() === currentValue.trim()) continue;

      allUpdates.push({
        constantName: constInfo.name,
        file: constInfo.file,
        patternType: constInfo.patternType,
        currentValue,
        extractedValue: extracted.value.trim(),
        confidence: extracted.confidence,
        sourceText: extracted.sourceText,
        sourceId: source.id,
        sourceLabel: source.label,
      });

      const conf = extracted.confidence === "high" ? "HIGH" : "LOW";
      console.log(`  ${constInfo.name}: ${currentValue} → ${extracted.value.trim()} (${conf} confidence)`);
    }

    // ── Manual review items ────────────────────────────────────────────────────
    for (const manualInfo of config.manualReview) {
      const raw = record[manualInfo.extractionKey];
      if (!raw?.sourceText) continue;
      const extracted = raw as ManualEntry;

      allManualFlags.push({
        name: manualInfo.name,
        file: manualInfo.file,
        description: manualInfo.description,
        extractedSection: extracted.sourceText,
        confidence: extracted.confidence,
        sourceId: source.id,
        sourceLabel: source.label,
      });

      console.log(`  ⚠ Manual review required: ${manualInfo.name} (${manualInfo.file})`);
    }
  } catch (err) {
    console.warn(
      `${tag}: GPT extraction failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return updatedSource;
}

// ── Main check logic ──────────────────────────────────────────────────────────

async function runCheck(): Promise<void> {
  console.log("[GovDocs] Starting government document check…");

  let sourcesConfig: SourcesConfig;
  try {
    const raw = fs.readFileSync(SOURCES_FILE, "utf8");
    sourcesConfig = JSON.parse(raw) as SourcesConfig;
  } catch (err) {
    console.error("[GovDocs] Failed to read ingest-sources.json:", err);
    return;
  }

  const allUpdates: ConstantUpdate[] = [];
  const allManualFlags: ManualReviewFlag[] = [];
  const updatedSources: SourceEntry[] = [];

  // Process each source sequentially — avoids hammering servers simultaneously
  for (const source of sourcesConfig.sources) {
    const updated = await processSource(source, allUpdates, allManualFlags);
    updatedSources.push(updated);
  }

  // Write updated hashes back to ingest-sources.json
  try {
    const updated: SourcesConfig = { sources: updatedSources };
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(updated, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error("[GovDocs] Failed to write ingest-sources.json:", err);
  }

  // If any changes were detected, write pending-updates.json and print summary
  if (allUpdates.length > 0 || allManualFlags.length > 0) {
    const pending: PendingUpdates = {
      generatedAt: new Date().toISOString(),
      updates: allUpdates,
      manualReviewFlags: allManualFlags,
    };
    try {
      fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2) + "\n", "utf8");
    } catch (err) {
      console.error("[GovDocs] Failed to write pending-updates.json:", err);
    }

    console.log("\n" + "─".repeat(60));

    if (allUpdates.length > 0) {
      console.log(`\n[GovDocs] ⚠ ${allUpdates.length} constant(s) may need updating:\n`);
      for (const u of allUpdates) {
        const conf = u.confidence === "high"
          ? "(HIGH confidence)"
          : "(LOW confidence — verify manually before applying)";
        console.log(`  • ${u.constantName}  (${u.file})`);
        console.log(`    Current:  ${u.currentValue}`);
        console.log(`    Proposed: ${u.extractedValue}  ${conf}`);
      }
    }

    if (allManualFlags.length > 0) {
      console.log(`\n[GovDocs] ⚠ ${allManualFlags.length} rate table(s) require manual review:\n`);
      for (const f of allManualFlags) {
        console.log(`  • ${f.name}  (${f.file})`);
        console.log(`    ${f.description}`);
      }
    }

    console.log("\n[GovDocs] Run 'npx tsx scripts/applyUpdates.ts' to review and apply changes.\n");
    console.log("─".repeat(60) + "\n");
  } else {
    console.log("[GovDocs] All constants up to date.\n");
  }
}

// ── Exported entry point ──────────────────────────────────────────────────────

/**
 * Runs an immediate document check, then schedules a re-check every 24 hours.
 * Called by instrumentation.ts on dev server startup.
 *
 * Non-blocking: errors are caught and logged, never thrown to the caller.
 */
export async function startGovDocWatcher(): Promise<void> {
  // Load .env.local when running outside the Next.js context (e.g. npx tsx directly)
  if (!process.env.OPENAI_API_KEY) {
    try {
      const { config: dotenvLoad } = await import("dotenv");
      dotenvLoad({ path: path.join(ROOT, ".env.local") });
    } catch {
      // dotenv unavailable — env must be set externally
    }
  }

  // Initial check on startup
  try {
    await runCheck();
  } catch (err) {
    console.error("[GovDocs] Initial check failed:", err);
  }

  // Re-check every 24 hours of uptime
  setInterval(() => {
    runCheck().catch((err: unknown) => {
      console.error("[GovDocs] Periodic check failed:", err);
    });
  }, 24 * 60 * 60 * 1000);
}

// ── Standalone invocation ─────────────────────────────────────────────────────
// Runs when called directly: npx tsx scripts/checkGovDocs.ts

const invokedDirectly =
  process.argv[1] != null &&
  (process.argv[1].endsWith("checkGovDocs.ts") || process.argv[1].endsWith("checkGovDocs.js"));

if (invokedDirectly) {
  startGovDocWatcher().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
