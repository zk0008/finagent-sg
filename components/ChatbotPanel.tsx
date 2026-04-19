/**
 * components/ChatbotPanel.tsx
 *
 * Right panel of the main FinAgent-SG page — Training & Feedback Chatbot.
 *
 * This chatbot serves as the correction and training interface:
 * - Users submit corrections while reviewing generated outputs
 * - Users upload training documents (SFRS standards, working papers, guides)
 * - Users ask accounting questions
 *
 * Phase 1:
 * - "Upload training doc" button wired to POST /api/ingest
 * - Accepts .txt and .pdf files; displays result as a system message
 *
 * Phase 5:
 * - Send button wired to POST /api/chat
 * - Corrections (containing keywords like "should be", "wrong", etc.) are saved
 *   to Supabase and immediately ingested into ChromaDB
 * - General questions are answered by GPT-4.1-mini + RAG
 * - schemaName is passed with every message so the server knows which client
 *   schema to write corrections to
 *
 * Props:
 * - schemaName: string — the client schema name (e.g. "techsoft_pte_ltd")
 *   Derived from company name in WorkflowPanel and passed down.
 *   Defaults to "default" when no company is selected.
 */

"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

// Message types displayed in the chat area
type MessageRole = "user" | "assistant" | "system";
interface ChatMessage {
  role: MessageRole;
  content: string;
}

// Props
interface ChatbotPanelProps {
  schemaName?: string;
}

// Initial messages shown on load — Phase 0 placeholder examples
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

export function ChatbotPanel({ schemaName = "default" }: ChatbotPanelProps) {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string })?.role === "admin";

  // Controlled state for text input
  const [inputValue, setInputValue] = useState("");

  // Message history — starts with placeholder examples
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);

  // Sending state — disables Send button while the API call is in flight
  const [isSending, setIsSending] = useState(false);

  // Hidden file input — triggered programmatically when the button is clicked
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Appends a message to the chat display.
   */
  function appendMessage(role: MessageRole, content: string) {
    setMessages((prev) => [...prev, { role, content }]);
  }

  /**
   * Handles file selection from the hidden input.
   * POSTs the file to /api/ingest and shows the result as a system message.
   */
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = "";

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "txt" && ext !== "pdf") {
      appendMessage(
        "system",
        `❌ '${file.name}' was rejected — only .txt and .pdf files are accepted.`
      );
      return;
    }

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
        appendMessage("system", `❌ Upload failed: ${result.error}`);
      }
    } catch {
      appendMessage(
        "system",
        `❌ Network error — could not reach /api/ingest. Is the server running?`
      );
    } finally {
      setIsUploading(false);
    }
  }

  /**
   * Handles Send button click.
   * POSTs the message to /api/chat with the current schemaName.
   * Displays the user message immediately, then the assistant reply when it arrives.
   */
  async function handleSend() {
    const message = inputValue.trim();
    if (!message || isSending) return;

    // Show user message immediately
    appendMessage("user", message);
    setInputValue("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, schemaName }),
      });

      const result = await response.json();

      if (!response.ok) {
        appendMessage("system", `❌ Error: ${result.error ?? "Unknown error"}`);
        return;
      }

      appendMessage("assistant", result.message);
    } catch {
      appendMessage(
        "system",
        `❌ Network error — could not reach /api/chat. Is the server running?`
      );
    } finally {
      setIsSending(false);
    }
  }

  /**
   * Allows submitting with Ctrl+Enter (Cmd+Enter on Mac).
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full p-3 md:p-6">

      {/* Panel header */}
      <div className="mb-4">
        <h2 className="text-sm font-medium">Training &amp; Feedback Chatbot</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Submit corrections · Upload training documents · Ask accounting questions
        </p>
      </div>

      <Separator className="mb-4" />

      {/* ── Message display area ── */}
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
        {/* Upload button — admin only */}
        {isAdmin && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.pdf"
              className="hidden"
              onChange={handleFileSelected}
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? "Uploading…" : "Upload training doc"}
            </Button>
          </>
        )}

        {/* Message input + Send */}
        <div className="flex gap-2">
          <Textarea
            placeholder="Ask a question or submit a correction (Ctrl+Enter to send)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="resize-none min-h-[60px]"
            disabled={isSending}
          />
          <Button
            onClick={handleSend}
            disabled={isSending || !inputValue.trim()}
            className="self-end min-h-[44px]"
          >
            {isSending ? "…" : "Send"}
          </Button>
        </div>
      </div>

    </div>
  );
}
