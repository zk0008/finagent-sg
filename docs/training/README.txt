FinAgent-SG — Fine-Tuning Pipeline
====================================

This directory holds training data for fine-tuning the FinAgent-SG AI models.

When to run fine-tuning
------------------------
Run fine-tuning when you have accumulated 50–100 reviewed corrections.
More corrections = better fine-tuned model. Do NOT fine-tune on fewer than 10.

To check how many reviewed corrections you have, run:
  npx tsx scripts/exportTrainingData.ts

The script prints a summary: total corrections, total pairs exported, count by type.
If the count is below 50, keep collecting corrections via the chatbot.

How to run fine-tuning
-----------------------
Step 1: Export training data (only exports "reviewed" corrections):
  npx tsx scripts/exportTrainingData.ts

  Output: docs/training/training_data.jsonl

Step 2: Review the JSONL file manually.
  Open training_data.jsonl and check that the examples are high quality.
  Each line should be a valid system/user/assistant conversation pair.
  Remove any low-quality or ambiguous examples before uploading.

Step 3: Upload and start fine-tuning:
  npx tsx scripts/runFineTuning.ts

  This uploads training_data.jsonl to OpenAI, creates a fine-tuning job
  for gpt-4.1-mini, and polls for completion (every 60 seconds).
  The job ID and progress URL are printed so you can monitor at:
    https://platform.openai.com/finetune

How to activate the fine-tuned model
--------------------------------------
When fine-tuning completes, the script prints the fine-tuned model ID, e.g.:
  ft:gpt-4.1-mini-2025-04-14:finagent::abc123

Copy this model ID into lib/modelRouter.ts:
  fine_tuned_model: "ft:gpt-4.1-mini-2025-04-14:finagent::abc123"

Then update app/api/chat/route.ts to use MODEL_ROUTES.fine_tuned_model
instead of MODEL_ROUTES.chat_response (ask the user before doing this).

Notes
------
- training_data.jsonl is gitignored — it may contain client-sensitive content.
- Never run fine-tuning from a CI/CD pipeline — it's a manual, deliberate action.
- OpenAI charges for fine-tuning by token count — check costs before running.
- Fine-tuned model IDs expire if unused for 90 days (OpenAI policy as of 2026).
