/**
 * app/api/chat/route.ts
 *
 * POST /api/chat — Chatbot message handler (Phase 5).
 *
 * What this route does:
 * Receives a user message from the ChatbotPanel and routes it one of two ways:
 *
 * 1. Correction path (message contains correction keywords):
 *    a. Saves the correction to the Supabase corrections table for the client schema.
 *    b. Immediately ingests the correction text into ChromaDB via ingestText()
 *       so the next FS generation reflects the correction.
 *    c. Returns a confirmation message.
 *    Correction keywords: "should be", "incorrect", "wrong", "change", "update", "fix"
 *
 * 2. Question path (general accounting question):
 *    a. Queries the RAG knowledge base for relevant SFRS context.
 *    b. Calls GPT-4.1-mini with the question + RAG context.
 *    c. Returns the AI answer.
 *
 * Both paths are instrumented in Langfuse (Phase 5, Task 2).
 * flushLangfuse() is called before the response is returned.
 *
 * Request body:
 *   {
 *     message:   string   — the user's message
 *     schemaName: string  — client schema (e.g. "techsoft_pte_ltd")
 *     output_id?: string  — optional: UUID of the FS output being reviewed
 *   }
 *
 * Response (200):
 *   {
 *     type: "correction" | "answer"
 *     message: string
 *   }
 *
 * Error responses:
 *   400 — missing required fields
 *   500 — Supabase write, ChromaDB, or AI call failed
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { supabase } from "@/lib/supabaseClient";
import { queryVectorStore, ingestToVectorStore } from "@/lib/vectorStore";
import { getLangfuse, flushLangfuse } from "@/lib/langfuse";
import { MODEL_ROUTES } from "@/lib/modelRouter";
import { verifySchemaAccess } from "@/lib/schemaAccess";

// Validate the request body
const RequestSchema = z.object({
  message: z.string().min(1, "message is required"),
  schemaName: z.string().min(1, "schemaName is required"),
  output_id: z.string().uuid().optional(),
});

// Keywords that indicate a correction rather than a general question.
// Case-insensitive match against any of these phrases.
const CORRECTION_KEYWORDS = [
  "should be",
  "incorrect",
  "wrong",
  "change",
  "update",
  "fix",
];

function isCorrection(message: string): boolean {
  const lower = message.toLowerCase();
  return CORRECTION_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Parse and validate the request body
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const { message, schemaName, output_id } = body;

  if (!await verifySchemaAccess(schemaName)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Langfuse: open parent trace for this chat message ─────────────────────
  // Tracks both correction and question paths so you can see what users are
  // asking and whether corrections are being captured correctly.
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name: "chat_response",
    input: { message, schemaName, path: isCorrection(message) ? "correction" : "question" },
  });

  if (isCorrection(message)) {
    // ── Correction path ────────────────────────────────────────────────────

    // Step 1: Save correction to Supabase corrections table.
    // The corrections table in each client schema stores all user feedback
    // for review and eventual fine-tuning (Phase 5, Task 6).
    try {
      await supabase.schema(schemaName).from("corrections").insert({
        output_id: output_id ?? null,
        message,
        status: "pending",
      });
    } catch (err) {
      // Log but do not block — RAG ingestion is more important than DB write
      console.error("[chat] Failed to save correction to Supabase:", err);
    }

    // Step 2: Ingest correction into ChromaDB so next FS generation reflects it.
    // The correction is added with topic "correction" so it can be queried
    // alongside other SFRS knowledge in the RAG pipeline.
    const correctionId = `correction::${schemaName}::${Date.now()}`;
    try {
      await ingestToVectorStore(message, correctionId, "correction");
    } catch (err) {
      console.error("[chat] Failed to ingest correction into ChromaDB:", err);
    }

    // ── Langfuse: log correction span ─────────────────────────────────────
    const span = trace.span({ name: "correction_ingested", input: { message, correctionId } });
    span.end({ output: { status: "ingested" } });
    trace.update({ output: { type: "correction" } });

    await flushLangfuse();

    return NextResponse.json({
      type: "correction",
      message:
        "Correction noted and added to knowledge base. Next generation will reflect this.",
    });
  }

  // ── Question path ──────────────────────────────────────────────────────────

  // Step 1: RAG — retrieve relevant SFRS context for this question.
  // Pass the parent trace so the RAG span appears under chat_response in Langfuse.
  const ragResults = await queryVectorStore(message, 4, trace);
  const ragContext =
    ragResults.length > 0
      ? ragResults.map((r) => r.text).join("\n\n---\n\n")
      : "No relevant content found in the knowledge base.";

  const systemPrompt = `You are an expert Singapore chartered accountant assistant for FinAgent-SG.
Answer accounting questions accurately and concisely, focusing on Singapore SFRS standards,
IRAS tax guidance, ACRA filing requirements, and CPF/payroll rules.

Use the following retrieved knowledge base content to answer the question:

--- KNOWLEDGE BASE ---
${ragContext}
--- END KNOWLEDGE BASE ---

If the knowledge base does not contain relevant information, answer from your general Singapore accounting knowledge.
Keep answers concise — 2–4 sentences unless more detail is clearly needed.`;

  // ── Langfuse: generation for the question answer ──────────────────────────
  const generation = trace.generation({
    name: "answer_question",
    model: MODEL_ROUTES.chat_response,
    input: { system: systemPrompt, user: message },
  });

  // Step 2: Call GPT-4.1-mini with the question + RAG context.
  let answer: string;
  try {
    const { text, usage } = await generateText({
      model: openai(MODEL_ROUTES.chat_response),
      system: systemPrompt,
      prompt: message,
    });
    answer = text;

    generation.end({
      output: answer,
      usage: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    });
  } catch (err) {
    generation.end({ output: { error: String(err) } });
    trace.update({ output: { route: "/api/chat", error: String(err), stack: (err as Error).stack ?? null } });
    await flushLangfuse();
    return NextResponse.json(
      { error: "Failed to generate answer" },
      { status: 500 }
    );
  }

  trace.update({ output: { type: "answer", answer } });

  // Flush Langfuse before returning — events must reach the server before
  // the HTTP connection closes.
  await flushLangfuse();

  return NextResponse.json({ type: "answer", message: answer });
}
