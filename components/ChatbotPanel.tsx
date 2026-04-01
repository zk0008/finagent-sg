/**
 * components/ChatbotPanel.tsx
 *
 * Right panel of the main FinAgent-SG page — Training & Feedback Chatbot.
 *
 * This chatbot serves as the correction and training interface:
 * - Users submit corrections while reviewing generated outputs
 * - Users upload training documents (SFRS standards, working papers, guides)
 * - Users report issues with AI-generated content
 * - Users ask accounting questions
 *
 * When fully built (Phase 2+), corrections will:
 * 1. Immediately update the ChromaDB RAG knowledge base
 * 2. Be accumulated for monthly fine-tuning of the LLM
 *
 * Phase 1 additions:
 * - "Upload training doc" button wired to POST /api/ingest
 * - Accepts .txt and .pdf files; displays result as a system message
 *
 * Still disabled in Phase 1:
 * - Send button (useChat hook added in Phase 2)
 * - Text input (AI chat wired in Phase 2)
 * - Correction logging (Supabase write added in Phase 2)
 */

"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

// Message types displayed in the chat area
type MessageRole = "user" | "assistant" | "system";
interface ChatMessage {
  role: MessageRole;
  content: string;
}

// Static placeholder messages carried over from Phase 0 for UI context
const INITIAL_MESSAGES: ChatMessage[] = [
  {
    role: "user",
    content:
      "The depreciation for FY2024 should use straight-line, not reducing balance.",
  },
  {
    role: "assistant",
    content:
      "Noted. I've updated the depreciation rule for this client. The next financial statement generation will use straight-line depreciation.",
  },
];

export function ChatbotPanel() {
  // Controlled state for text input — send action wired in Phase 2
  const [inputValue, setInputValue] = useState("");

  // Message history — starts with the Phase 0 placeholder, grows as documents are uploaded
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);

  // Hidden file input — triggered programmatically when the button is clicked
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Appends a message to the chat display.
   * Used to show upload progress and results inline in the chatbot panel.
   */
  function appendMessage(role: MessageRole, content: string) {
    setMessages((prev) => [...prev, { role, content }]);
  }

  /**
   * Handles file selection from the hidden input.
   * POSTs the file to /api/ingest and shows the result as a system message.
   *
   * Only .txt and .pdf are accepted — the API route also validates this,
   * but we do a fast client-side check first to avoid an unnecessary request.
   */
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset the input so the same file can be re-uploaded if needed
    e.target.value = "";

    // Client-side file type guard — mirrors the server-side check in /api/ingest
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "txt" && ext !== "pdf") {
      appendMessage(
        "system",
        `❌ '${file.name}' was rejected — only .txt and .pdf files are accepted.`
      );
      return;
    }

    // Show an uploading indicator in the chat
    appendMessage("system", `⏳ Uploading '${file.name}'…`);
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/ingest", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (result.success) {
        appendMessage(
          "system",
          `✅ '${result.filename}' ingested — ${result.chunks} chunks added to the knowledge base.`
        );
      } else {
        appendMessage(
          "system",
          `❌ Upload failed: ${result.error}`
        );
      }
    } catch (err) {
      appendMessage(
        "system",
        `❌ Network error — could not reach /api/ingest. Is the server running?`
      );
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="flex flex-col h-full p-6">

      {/* Panel header */}
      <div className="mb-4">
        <h2 className="text-sm font-medium">Training &amp; Feedback Chatbot</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Submit corrections · Upload training documents · Report issues · Ask accounting questions
        </p>
      </div>

      <Separator className="mb-4" />

      {/* ── Message display area ── */}
      {/*
       * Phase 1: Displays static placeholder messages + upload result system messages.
       * Phase 2: This will be replaced with the useChat hook from Vercel AI SDK:
       *   const { messages, input, handleSubmit } = useChat({ api: '/api/chat' });
       * Messages will stream in real-time via the Vercel AI SDK streaming protocol.
       */}
      <div className="flex-1 space-y-4 overflow-y-auto mb-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${
              msg.role === "user"
                ? "justify-end"
                : msg.role === "system"
                ? "justify-center"
                : "justify-start"
            }`}
          >
            <div
              className={`rounded-lg px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "max-w-[80%] bg-primary text-primary-foreground"
                  : msg.role === "system"
                  ? "max-w-full text-xs text-muted-foreground bg-muted/50 italic"
                  : "max-w-[80%] bg-muted text-muted-foreground"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
      </div>

      {/* ── Input area ── */}
      <div className="space-y-2">
        {/*
         * Hidden file input — accepts .txt and .pdf only.
         * Triggered by the visible "Upload training doc" button below.
         */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.pdf"
          className="hidden"
          onChange={handleFileSelected}
        />

        {/*
         * "Upload training doc" button — now active in Phase 1.
         * Clicks the hidden file input to open the OS file picker.
         * Accepted: .txt and .pdf → POST to /api/ingest → ChromaDB storage.
         */}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? "Uploading…" : "Upload training doc"}
        </Button>

        {/* Message input + send — send action wired in Phase 2 */}
        <div className="flex gap-2">
          <Textarea
            placeholder="Type message… (chat active in Phase 2)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="resize-none min-h-[60px]"
            disabled
          />
          <Button disabled className="self-end">
            Send
          </Button>
        </div>
      </div>

    </div>
  );
}
