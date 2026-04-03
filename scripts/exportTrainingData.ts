/**
 * scripts/exportTrainingData.ts
 *
 * Exports reviewed corrections as OpenAI fine-tuning JSONL.
 *
 * Run this script when you have 50-100 reviewed corrections.
 * Do not run in production.
 *
 * Usage:
 *   npx tsx scripts/exportTrainingData.ts
 *
 * What this script does:
 * 1. Reads all corrections with status = "reviewed" from Supabase.
 *    Queries every client schema found in the list of known schemas.
 * 2. For each correction that has an output_id, loads the original FS output
 *    from the outputs table (structured_data) to use as the AI's "wrong" answer.
 * 3. Formats each correction as an OpenAI fine-tuning JSONL entry:
 *    {
 *      "messages": [
 *        { "role": "system",    "content": "You are a Singapore chartered accountant..." },
 *        { "role": "user",      "content": "<original AI output context>" },
 *        { "role": "assistant", "content": "<the correction: what it should have been>" }
 *      ]
 *    }
 * 4. Writes output to docs/training/training_data.jsonl.
 * 5. Prints a summary: total corrections, total pairs exported, count by output_type.
 *
 * Notes:
 * - Only "reviewed" corrections are exported — "pending" corrections are not
 *   yet validated and should not be used for fine-tuning.
 * - Corrections without an output_id are exported as standalone examples
 *   (user = the correction message, assistant = an acknowledgement template).
 * - training_data.jsonl may contain client-sensitive data — keep it local,
 *   never commit it to git (it is gitignored).
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

// ── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_PATH = path.join(process.cwd(), "docs", "training", "training_data.jsonl");

// System prompt used for all fine-tuning examples.
// This must match the system prompt used in the AI calls being fine-tuned.
const SYSTEM_PROMPT = `You are an expert Singapore chartered accountant specialising in SFRS (Singapore Financial Reporting Standards), IRAS tax guidance, ACRA filing requirements, and CPF/payroll rules. Provide accurate, concise answers aligned with Singapore accounting standards.`;

// ── Supabase client ──────────────────────────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: "public" },
});

// ── Types ────────────────────────────────────────────────────────────────────

type FineTuningEntry = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

type CorrectionRow = {
  id: string;
  output_id: string | null;
  message: string;
  status: string;
  created_at: string;
  schema_name: string;
};

type OutputRow = {
  id: string;
  output_type: string;
  structured_data: Record<string, unknown> | null;
};

// ── Schema discovery ─────────────────────────────────────────────────────────

/**
 * Discovers all client schemas that have a corrections table.
 * Queries the Supabase information schema for tables named "corrections"
 * in any schema other than public, pg_*, information_schema.
 */
async function discoverClientSchemas(): Promise<string[]> {
  const { data, error } = await supabase
    .from("information_schema.tables" as any)
    .select("table_schema")
    .eq("table_name", "corrections")
    .not("table_schema", "in", "(public,pg_catalog,information_schema)");

  if (error) {
    console.warn("Warning: Could not auto-discover schemas:", error.message);
    return [];
  }

  return (data ?? []).map((row: any) => row.table_schema as string);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("FinAgent-SG — Export Training Data");
  console.log("=====================================");
  console.log("Only exports corrections with status = 'reviewed'.\n");

  // Step 1: Discover all client schemas
  console.log("Discovering client schemas…");
  const schemas = await discoverClientSchemas();

  if (schemas.length === 0) {
    console.log("No client schemas found with a corrections table.");
    console.log("Create corrections by submitting messages via the chatbot.");
    process.exit(0);
  }

  console.log(`Found ${schemas.length} schema(s): ${schemas.join(", ")}\n`);

  // Step 2: Load reviewed corrections from all schemas
  const allCorrections: CorrectionRow[] = [];
  for (const schema of schemas) {
    const { data, error } = await (supabase as any)
      .schema(schema)
      .from("corrections")
      .select("id, output_id, message, status, created_at")
      .eq("status", "reviewed");

    if (error) {
      console.warn(`Warning: Could not read ${schema}.corrections:`, error.message);
      continue;
    }

    const rows = (data ?? []).map((row: any) => ({ ...row, schema_name: schema }));
    allCorrections.push(...rows);
  }

  console.log(`Total reviewed corrections found: ${allCorrections.length}`);

  if (allCorrections.length === 0) {
    console.log("\nNo reviewed corrections. Use the Corrections page (/corrections)");
    console.log("to mark corrections as reviewed before exporting.");
    process.exit(0);
  }

  if (allCorrections.length < 10) {
    console.warn(`\nWarning: Only ${allCorrections.length} corrections found.`);
    console.warn("OpenAI requires at least 10 examples for fine-tuning.");
    console.warn("Recommendation: Collect at least 50 before running fine-tuning.\n");
  } else if (allCorrections.length < 50) {
    console.warn(`\nNote: ${allCorrections.length} corrections found.`);
    console.warn("Recommendation: Collect 50–100 for best fine-tuning results.\n");
  }

  // Step 3: Load original outputs for corrections that have an output_id
  const outputIds = [
    ...new Set(allCorrections.filter((c) => c.output_id).map((c) => c.output_id!)),
  ];

  const outputMap = new Map<string, OutputRow>();

  for (const schema of schemas) {
    if (outputIds.length === 0) break;

    const { data, error } = await (supabase as any)
      .schema(schema)
      .from("outputs")
      .select("id, output_type, structured_data")
      .in("id", outputIds);

    if (error) {
      console.warn(`Warning: Could not read ${schema}.outputs:`, error.message);
      continue;
    }

    for (const row of data ?? []) {
      outputMap.set(row.id, row as OutputRow);
    }
  }

  // Step 4: Build fine-tuning JSONL entries
  const entries: FineTuningEntry[] = [];
  const countByType: Record<string, number> = {};

  for (const correction of allCorrections) {
    let userContent: string;
    let outputType = "standalone";

    if (correction.output_id && outputMap.has(correction.output_id)) {
      const output = outputMap.get(correction.output_id)!;
      outputType = output.output_type;

      // Summarise the original output so the model learns what was wrong
      const outputSummary = output.structured_data
        ? JSON.stringify(output.structured_data).slice(0, 2000)
        : "(no structured data)";

      userContent = `The following was generated by FinAgent-SG (output type: ${output.output_type}):\n\n${outputSummary}\n\nUser correction: ${correction.message}`;
    } else {
      // Standalone correction — no original output to compare against
      userContent = `User correction submitted via chatbot: ${correction.message}`;
    }

    entries.push({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
        {
          role: "assistant",
          content: `Understood. ${correction.message} This has been noted and will be applied in future outputs.`,
        },
      ],
    });

    countByType[outputType] = (countByType[outputType] ?? 0) + 1;
  }

  // Step 5: Write JSONL output
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const jsonlContent = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(OUTPUT_PATH, jsonlContent, "utf-8");

  // Step 6: Print summary
  console.log("\n── Export Summary ──────────────────────────────");
  console.log(`Total reviewed corrections:  ${allCorrections.length}`);
  console.log(`Total JSONL pairs exported:  ${entries.length}`);
  console.log("By output type:");
  for (const [type, count] of Object.entries(countByType)) {
    console.log(`  ${type.padEnd(30)} ${count}`);
  }
  console.log(`\nOutput written to: ${OUTPUT_PATH}`);
  console.log("\nNext step: Review training_data.jsonl, then run:");
  console.log("  npx tsx scripts/runFineTuning.ts");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
