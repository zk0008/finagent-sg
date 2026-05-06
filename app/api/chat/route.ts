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
import { generateText, tool, stepCountIs } from "ai";  // tool() for typed tool schemas; stepCountIs() for stopWhen (SDK v6 maxSteps equivalent)
import { openai } from "@ai-sdk/openai";
import { supabase } from "@/lib/supabaseClient";
import { queryVectorStore, ingestToVectorStore } from "@/lib/vectorStore";
import { getLangfuse, flushLangfuse } from "@/lib/langfuse";
import { MODEL_ROUTES } from "@/lib/modelRouter";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { writeVaultNote } from "@/lib/agents/vaultWriter";       // V3.1: vault notes for chat interactions
import { getRecentVaultNotes } from "@/lib/agents/vaultReader";  // V3.1: prior-run context for LLM injection

// ── Tool definitions (used by the Q&A path in the POST handler) ──────────────
// Defined at module scope so they are not recreated on each request.
// No execute functions — tool calls are dispatched manually from result.toolCalls.

// Lets the LLM retrieve relevant SFRS / IRAS / CPF / ACRA chunks from ChromaDB.
// The LLM crafts a focused search query rather than passing the raw message,
// which produces more targeted and relevant retrieval than the previous
// unconditional queryVectorStore(message, 4, trace) call.
const queryKnowledgeBaseTool = tool({
  description:
    "Query the Singapore accounting and tax knowledge base to retrieve relevant SFRS standards, " +
    "IRAS tax guidance, CPF contribution tables, ACRA filing requirements, or MOM payroll rules. " +
    "Call this when the user asks a question that requires specific regulatory knowledge. " +
    "Craft a focused search query from the key concepts in the user's question.",
  inputSchema: z.object({
    query: z.string().describe(
      "A focused search query extracting the key regulatory concept " +
      "e.g. 'CPF contribution rate Singapore PR year 2' or " +
      "'SFRS going concern disclosure requirements'"
    ),
  }),
});

// Lets the LLM route a message to the correction pipeline when it detects that
// the user is correcting information rather than asking a question.
// This formalises what isCorrection() previously caught via keyword matching.
const submitCorrectionTool = tool({
  description:
    "Submit a correction to the accounting knowledge base. Call this when the user wants to " +
    "update, fix, change, or correct information — for example updating a depreciation method, " +
    "adding a disclosure note, or correcting a prior statement. The correction will be saved " +
    "and applied to future financial statement generation.",
  inputSchema: z.object({
    correction: z.string().describe(
      "The full correction text exactly as the user stated it"
    ),
  }),
});

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
  "should include",
  "should always",
  "should note",
  "should update",
  "incorrect",
  "wrong",
  "change",
  "update",
  "fix",
  "always include",
  "add back",
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

  // ── V3.1: Read recent vault notes for this client ─────────────────────────
  // Called once before the correction/Q&A branch so the result is available to
  // both the Q&A system prompt injection and the Langfuse trace input field.
  // Returns "" silently when vault is unconfigured or client has no prior runs.
  const recentNotes = await getRecentVaultNotes(schemaName, 5);

  // ── Langfuse: open parent trace for this chat message ─────────────────────
  // Tracks both correction and question paths so you can see what users are
  // asking and whether corrections are being captured correctly.
  // vaultContext included so the dashboard shows what prior context was available.
  const langfuse = getLangfuse();
  const trace = langfuse.trace({
    name:  "chat_response",
    input: {
      message,
      schemaName,
      path:         isCorrection(message) ? "correction" : "question",
      vaultContext: recentNotes || "",  // "" when no prior runs or vault not configured
    },
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

    // V3.1: fire-and-forget vault note for correction interactions.
    // void — does not block the HTTP response; writeVaultNote has its own try/catch.
    void writeVaultNote({
      clientId:                 schemaName,
      goal:                     message,
      workflows:                ["correction"],                           // correction wiki-link tag
      inputsUsed:               { "Correction": message },
      dataFetched:              {},                                       // corrections do not fetch from Supabase
      outputsGenerated:         { "Status": "Correction submitted to knowledge base" },
      optionalInputsNotApplied: {},
      errors:                   {},
    });

    return NextResponse.json({
      type: "correction",
      message:
        "Correction noted and added to knowledge base. Next generation will reflect this.",
    });
  }

  // ── Question path ──────────────────────────────────────────────────────────

  // Base identity/instruction prompt — does NOT include the RAG fence here.
  // The LLM calls query_knowledge_base if it needs regulatory context; retrieved
  // chunks are injected into finalSystemPrompt for the second pass only.
  const systemPromptBase =
    "You are an expert Singapore chartered accountant assistant for FinAgent-SG.\n" +
    "Answer accounting questions accurately and concisely, focusing on Singapore SFRS standards,\n" +
    "IRAS tax guidance, ACRA filing requirements, and CPF/payroll rules.\n" +
    "If the knowledge base provides relevant content, use it to inform your answer.\n" +
    "Keep answers concise — 2–4 sentences unless more detail is clearly needed.";

  // Append vault context when prior run notes exist — same conditional pattern as managerNode.
  // Vault context goes into the first (tool-calling) call only; not repeated in finalSystemPrompt
  // to avoid duplicate context across two passes.
  const systemPrompt = recentNotes
    ? systemPromptBase +
      "\n\nHere are the last interactions for this client for your context. Use this to give more informed and consistent responses:\n\n" +
      recentNotes
    : systemPromptBase;

  // ── STEP 1: Call generateText with tools ─────────────────────────────────
  // The LLM decides whether to call query_knowledge_base, submit_correction,
  // or answer directly — no unconditional RAG call before the LLM runs.
  // stopWhen: stepCountIs(3) allows up to 3 sequential tool invocations;
  // SDK v6.0.140 uses stopWhen + stepCountIs — maxSteps does not exist in this version.
  // No explicit type annotation — TypeScript infers the correct specific generic type
  // (GenerateTextResult<{query_knowledge_base:..., submit_correction:...}>) from the
  // generateText call below. Annotating with Awaited<ReturnType<typeof generateText>>
  // uses the no-tools ToolSet default and causes an incompatible-type error.
  // The catch block always returns, so control flow analysis guarantees result is
  // assigned before any code below the try/catch can execute.
  let result;
  try {
    result = await generateText({
      model:    openai(MODEL_ROUTES.chat_response),   // GPT-4.1-mini — cost-efficient for chat
      system:   systemPrompt,                          // identity + vault context; no RAG fence yet
      prompt:   message,
      tools: {
        query_knowledge_base: queryKnowledgeBaseTool,  // LLM calls with a focused query
        submit_correction:    submitCorrectionTool,     // LLM calls to route correction messages
      },
      stopWhen: stepCountIs(3),  // allow up to 3 tool calls (e.g. two RAG queries + correction)
    });
  } catch (err) {
    // LLM call failed — update Langfuse trace and return 500 before touching Supabase
    trace.update({ output: { route: "/api/chat", error: String(err), stack: (err as Error).stack ?? null } });
    await flushLangfuse();
    return NextResponse.json({ error: "Failed to generate answer" }, { status: 500 });
  }

  // ── STEP 2: Process tool calls ────────────────────────────────────────────
  // SDK v6 uses toolCall.input (not toolCall.args) for the typed parameters.
  const ragChunks:       Array<{ text: string }> = [];  // accumulated from query_knowledge_base calls
  const correctionTexts: string[]                = [];   // accumulated from submit_correction calls

  for (const toolCall of result.toolCalls) {
    const toolName = toolCall.toolName as string;
    const input    = toolCall.input as Record<string, unknown>;  // SDK v6 field name

    if (toolName === "query_knowledge_base") {
      // LLM crafted a focused query — retrieve up to 4 relevant chunks from ChromaDB.
      // Using the LLM's extracted query (not the raw message) gives more targeted retrieval.
      const chunks = await queryVectorStore(input.query as string, 4, trace);
      ragChunks.push(...chunks);  // accumulate across multiple query_knowledge_base calls

    } else if (toolName === "submit_correction") {
      const correctionText = input.correction as string;

      // Step 1: Write to Supabase corrections table for the review and fine-tuning pipeline.
      // Logged but non-blocking — same resilience pattern as the isCorrection() fast-path.
      try {
        await supabase.schema(schemaName).from("corrections").insert({
          output_id: output_id ?? null,
          message:   correctionText,   // store the extracted correction, not the raw user message
          status:    "pending",
        });
      } catch (err) {
        console.error("[chat] Failed to save correction to Supabase:", err);
      }

      // Step 2: Ingest into ChromaDB so the next FS generation reflects the correction immediately.
      const correctionId = `correction::${schemaName}::${Date.now()}`;
      try {
        await ingestToVectorStore(correctionText, correctionId, "correction");
      } catch (err) {
        console.error("[chat] Failed to ingest correction into ChromaDB:", err);
      }

      // Step 3: Fire-and-forget vault note — same pattern as the isCorrection() fast-path.
      void writeVaultNote({
        clientId:                 schemaName,
        goal:                     correctionText,
        workflows:                ["correction"],
        inputsUsed:               { "Correction": correctionText },
        dataFetched:              {},
        outputsGenerated:         { "Status": "Correction submitted to knowledge base" },
        optionalInputsNotApplied: {},
        errors:                   {},
      });

      correctionTexts.push(correctionText);  // track so the final answer can acknowledge it
    }
  }

  // ── STEP 3: Generate the final answer ────────────────────────────────────
  // No tool calls → LLM answered from general knowledge; use result.text directly.
  // Tool calls made → build finalSystemPrompt with retrieved chunks and corrections,
  // then make a second generateText call with all tool results in context.
  let answer: string;

  if (result.toolCalls.length === 0) {
    // LLM answered from general knowledge or vault context — use the direct response.
    answer = result.text;

  } else {
    // Build finalSystemPrompt: base identity + RAG chunks (if any) + corrections (if any).
    // Vault context deliberately excluded — it was already in the first call's system prompt.
    let finalSystemPrompt = systemPromptBase;

    if (ragChunks.length > 0) {
      // Inject retrieved chunks in the same --- KNOWLEDGE BASE --- fence format used
      // by the pre-tool-calling path — keeps the LLM context structure consistent.
      const ragContext = ragChunks.map((r) => r.text).join("\n\n---\n\n");
      finalSystemPrompt +=
        "\n\nUse the following retrieved knowledge base content to answer the question:\n\n" +
        "--- KNOWLEDGE BASE ---\n" +
        ragContext + "\n" +
        "--- END KNOWLEDGE BASE ---\n\n" +
        "If the knowledge base does not contain relevant information, answer from your general Singapore accounting knowledge.";
    }

    if (correctionTexts.length > 0) {
      // Inform the LLM that corrections were saved so it can acknowledge them in the answer.
      finalSystemPrompt +=
        "\n\nCorrections submitted this session:\n" +
        correctionTexts.join("\n");
    }

    // Second generateText call — straight generation from the enriched system prompt.
    // No tools passed; this call only produces the final answer text.
    const finalResult = await generateText({
      model:  openai(MODEL_ROUTES.chat_response),
      system: finalSystemPrompt,
      prompt: message,  // repeat the original user message so the LLM answers the right question
    });
    answer = finalResult.text;
  }

  // If the LLM called submit_correction, append the fixed acknowledgement string so
  // the user always sees a consistent confirmation regardless of what the LLM generated.
  // Covers both branches: direct result.text (no other tool calls) and finalResult.text.
  if (correctionTexts.length > 0) {
    answer += "\n\nCorrection noted and added to knowledge base. Next generation will reflect this.";
  }

  // ── STEP 4: Update Langfuse trace with tool call metadata ─────────────────
  // toolsCalled lets the Langfuse dashboard show retrieval vs. correction vs. direct-answer
  // breakdown per message — useful for diagnosing RAG quality.
  trace.update({
    input: {
      message,
      schemaName,
      path:         "question",
      vaultContext: recentNotes || "",
      toolsCalled:  result.toolCalls.map((tc) => tc.toolName),  // e.g. ["query_knowledge_base"]
    },
  });

  trace.update({ output: { type: "answer", answer } });

  // Flush Langfuse before returning — events must reach the server before the connection closes.
  await flushLangfuse();

  // V3.1: fire-and-forget vault note — same pattern as the existing path.
  // Answer truncated to 200 chars to keep vault notes readable.
  void writeVaultNote({
    clientId:                 schemaName,
    goal:                     message,
    workflows:                ["question"],
    inputsUsed:               { "Question": message },
    dataFetched:              {},
    outputsGenerated:         {
      "Answer": answer.length > 200 ? answer.slice(0, 200) + "..." : answer,
    },
    optionalInputsNotApplied: {},
    errors:                   {},
  });

  return NextResponse.json({ type: "answer", message: answer });
}
