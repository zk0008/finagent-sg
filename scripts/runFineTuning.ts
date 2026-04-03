/**
 * scripts/runFineTuning.ts
 *
 * Uploads training data to OpenAI and creates a fine-tuning job.
 *
 * Do not run this script until you have at least 50 high-quality reviewed corrections.
 * When fine-tuning completes, copy the model ID into MODEL_ROUTES.fine_tuned_model
 * in lib/modelRouter.ts.
 *
 * Usage:
 *   npx tsx scripts/runFineTuning.ts
 *
 * What this script does:
 * 1. Reads docs/training/training_data.jsonl
 * 2. Validates: minimum 10 examples required. Warns if fewer than 50.
 * 3. Uploads the JSONL file to OpenAI Files API.
 * 4. Creates a fine-tuning job for gpt-4.1-mini with the uploaded file.
 * 5. Prints the job ID and a link to monitor progress at platform.openai.com.
 * 6. Polls the job every 60 seconds until it completes or fails.
 * 7. When complete, prints the fine-tuned model ID.
 *
 * After fine-tuning:
 *   Copy the model ID (e.g. ft:gpt-4.1-mini:finagent::abc123) into:
 *   lib/modelRouter.ts → MODEL_ROUTES.fine_tuned_model
 */

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

// ── Constants ────────────────────────────────────────────────────────────────

const TRAINING_DATA_PATH = path.join(process.cwd(), "docs", "training", "training_data.jsonl");

// Minimum examples required by OpenAI for fine-tuning
const MINIMUM_EXAMPLES = 10;

// Recommended minimum for good results
const RECOMMENDED_MINIMUM = 50;

// Base model to fine-tune — matches MODEL_ROUTES.chat_response in lib/modelRouter.ts
const BASE_MODEL = "gpt-4.1-mini";

// Polling interval: 60 seconds
const POLL_INTERVAL_MS = 60_000;

// ── OpenAI client ────────────────────────────────────────────────────────────

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY must be set in .env.local");
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("FinAgent-SG — Fine-Tuning Runner");
  console.log("===================================");
  console.log(`Base model: ${BASE_MODEL}\n`);

  // Step 1: Read and validate the training file
  if (!fs.existsSync(TRAINING_DATA_PATH)) {
    console.error(`Error: Training data not found at ${TRAINING_DATA_PATH}`);
    console.error("Run: npx tsx scripts/exportTrainingData.ts");
    process.exit(1);
  }

  const exampleCount = countLines(TRAINING_DATA_PATH);
  console.log(`Training examples found: ${exampleCount}`);

  // Minimum check — OpenAI rejects jobs with fewer than 10 examples
  if (exampleCount < MINIMUM_EXAMPLES) {
    console.error(
      `\nError: ${exampleCount} examples found. OpenAI requires at least ${MINIMUM_EXAMPLES}.`
    );
    console.error("Collect more corrections via the chatbot and re-export.");
    process.exit(1);
  }

  // Recommendation check — warn but do not block
  if (exampleCount < RECOMMENDED_MINIMUM) {
    console.warn(
      `\nWarning: Only ${exampleCount} examples. Recommend ${RECOMMENDED_MINIMUM}–100 for best results.`
    );
    console.warn("Proceeding anyway — you can still fine-tune with fewer examples.\n");
  }

  // Step 2: Upload the JSONL file to OpenAI Files API
  console.log("\nUploading training data to OpenAI Files API…");
  const fileStream = fs.createReadStream(TRAINING_DATA_PATH);

  const uploadedFile = await openai.files.create({
    file: fileStream,
    purpose: "fine-tune",
  });

  console.log(`File uploaded: ${uploadedFile.id}`);
  console.log(`File name:     ${uploadedFile.filename}`);
  console.log(`File size:     ${uploadedFile.bytes} bytes`);

  // Step 3: Create the fine-tuning job
  console.log("\nCreating fine-tuning job…");
  const job = await openai.fineTuning.jobs.create({
    training_file: uploadedFile.id,
    model: BASE_MODEL,
    hyperparameters: {
      // n_epochs: "auto" lets OpenAI choose based on training set size
      n_epochs: "auto",
    },
    suffix: "finagent",
  });

  console.log(`\nFine-tuning job created!`);
  console.log(`Job ID:     ${job.id}`);
  console.log(`Status:     ${job.status}`);
  console.log(`Monitor at: https://platform.openai.com/finetune/${job.id}`);
  console.log("\nPolling for completion every 60 seconds…");
  console.log("(You can Ctrl+C and monitor manually at the URL above)\n");

  // Step 4: Poll until the job completes or fails
  let currentJob = job;
  while (
    currentJob.status === "validating_files" ||
    currentJob.status === "queued" ||
    currentJob.status === "running"
  ) {
    await sleep(POLL_INTERVAL_MS);
    currentJob = await openai.fineTuning.jobs.retrieve(job.id);
    const ts = new Date().toLocaleTimeString("en-SG");
    console.log(`[${ts}] Status: ${currentJob.status}`);
  }

  // Step 5: Report result
  if (currentJob.status === "succeeded") {
    const modelId = currentJob.fine_tuned_model;
    console.log("\n✅ Fine-tuning completed successfully!");
    console.log(`\nFine-tuned model ID: ${modelId}`);
    console.log("\nNext step — activate the model:");
    console.log("  1. Open lib/modelRouter.ts");
    console.log(`  2. Set fine_tuned_model: "${modelId}"`);
    console.log("  3. Update app/api/chat/route.ts to use MODEL_ROUTES.fine_tuned_model");
    console.log("     (ask the user before making this change — Phase 6 decision)");
  } else {
    console.error(`\n❌ Fine-tuning job ended with status: ${currentJob.status}`);
    if (currentJob.error) {
      console.error(`Error: ${JSON.stringify(currentJob.error)}`);
    }
    console.error(`Review the job at: https://platform.openai.com/finetune/${job.id}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
