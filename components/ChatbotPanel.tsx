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
 * V3-D (multi-agent routing):
 * - detectAgentIntent() inspects each outgoing message before sending
 * - If the message is a workflow goal, it is routed to POST /api/agent instead
 *   of /api/chat; progress is rendered via AgentProgressPanel below the
 *   message list (Option A — panel lives outside the messages array)
 * - Standard chat messages are unaffected
 *
 * Props:
 * - schemaName: string — the client schema name (e.g. "techsoft_pte_ltd")
 *   Derived from company name in WorkflowPanel and passed down.
 *   Defaults to "default" when no company is selected.
 */

"use client";

import { useEffect, useRef, useState } from "react"; // useEffect added for outside-click listener
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { detectAgentIntent } from "@/lib/agents/intentDetector"; // rule-based workflow intent detector
import { AgentProgressPanel } from "@/components/AgentProgressPanel"; // per-node progress UI

// Message types displayed in the chat area
type MessageRole = "user" | "assistant" | "system";
interface ChatMessage {
  role: MessageRole;
  content: string;
}

// One entry in the agent node list — mirrors AgentProgressPanel's NodeEntry type
type NodeStatus = "pending" | "running" | "complete" | "error";
interface AgentNodeEntry {
  name:   string;
  status: NodeStatus;
  error?: string;
}

// Props
interface ChatbotPanelProps {
  schemaName?: string;
  // True only after the user has explicitly picked a client from the dropdown.
  // False on initial page load even though schemaName has a default value.
  clientSelected?: boolean;
}

// Single welcome message shown on load — replaces the old dummy conversation
const INITIAL_MESSAGES: ChatMessage[] = [
  {
    role: "system",
    content:
      "Welcome to FinAgent. Select a client from the left panel, then type a command or question below.",
  },
];

export function ChatbotPanel({ schemaName = "default", clientSelected = false }: ChatbotPanelProps) {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string })?.role === "admin";

  // Controlled state for text input
  const [inputValue, setInputValue] = useState("");

  // Controls whether the floating hint panel is visible.
  // Set true on textarea focus; cleared only when the user clicks outside
  // the wrapper div (both the textarea and the hint panel).
  const [showHint, setShowHint] = useState(false);

  // Ref on the wrapper div that contains both the hint panel and the textarea.
  // Used by the outside-click handler to detect clicks that land outside both elements.
  const hintWrapperRef = useRef<HTMLDivElement>(null);

  // ── Outside-click handler for the hint panel ───────────────────────────────
  // Attach a mousedown listener to the document on mount; remove it on unmount.
  // mousedown fires before blur, so we can check containment before React
  // processes the blur event and before the hint would disappear.
  useEffect(() => {
    function handleDocumentMouseDown(e: MouseEvent) {
      // If the click target is inside the wrapper (textarea or hint panel), do nothing
      if (hintWrapperRef.current?.contains(e.target as Node)) return;
      // Click landed outside — hide the hint panel
      setShowHint(false);
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);
    // Clean up the listener when the component unmounts to avoid memory leaks
    return () => document.removeEventListener("mousedown", handleDocumentMouseDown);
  }, []); // empty deps — listener is registered once and never needs to re-register

  // Message history — starts with placeholder examples
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);

  // Sending state — disables Send button while the API call is in flight
  const [isSending, setIsSending] = useState(false);

  // ── Agent run state (V3-D) ─────────────────────────────────────────────────
  // Populated only when detectAgentIntent() routes the message to /api/agent.
  // Reset to initial values each time the user sends a new message.

  // Ordered list of nodes the graph will visit; statuses update as SSE events arrive
  const [agentNodes, setAgentNodes] = useState<AgentNodeEntry[]>([]);

  // Populated by the validation:missing SSE event if required inputs are absent
  const [agentMissingInputs, setAgentMissingInputs] = useState<string[]>([]);

  // Populated by the graph:complete SSE event — plain-English run summary
  const [agentSummary, setAgentSummary] = useState<string | null>(null);

  // True while the SSE stream from /api/agent is still open
  const [isAgentRunning, setIsAgentRunning] = useState(false);

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
   *
   * First checks the message with detectAgentIntent(). If the message is a
   * workflow goal, routes it to POST /api/agent and consumes the SSE stream
   * to drive AgentProgressPanel. Otherwise falls through to the existing
   * POST /api/chat RAG chatbot — no change to that path.
   */
  async function handleSend() {
    const message = inputValue.trim();
    if (!message || isSending) return;

    // Show the user's message in the chat immediately regardless of route
    appendMessage("user", message);
    setInputValue("");
    setIsSending(true);

    // Reset all agent state before each new message so stale results don't show
    setAgentNodes([]);
    setAgentMissingInputs([]);
    setAgentSummary(null);
    setIsAgentRunning(false);

    // ── Intent check ────────────────────────────────────────────────────────
    const intent = detectAgentIntent(message);

    if (intent.isAgentGoal) {
      // ── Client selection guard ───────────────────────────────────────────
      // The agent must never assume which client to run against. If the user
      // has not explicitly selected a client from the dropdown, surface a
      // missing-input prompt instead of silently using the default schema.
      if (!clientSelected) {
        setAgentMissingInputs(["Client — please select a client from the dropdown"]);
        setIsSending(false);  // re-enable the Send button immediately
        return;               // do not call /api/agent
      }

      // ── Agent path: route to /api/agent and stream SSE progress ──────────

      // Pre-populate the node list with every workflow that will run, in graph order.
      // Nodes start as "pending"; statuses flip as SSE events arrive.
      const initialNodes: AgentNodeEntry[] = [
        { name: "validationNode", status: "pending" },
        { name: "managerNode",    status: "pending" },
        // Worker nodes — only include those flagged true by the intent detector
        ...(intent.runFS             ? [{ name: "financialStatementNode", status: "pending" as NodeStatus }] : []),
        ...(intent.runPayroll        ? [{ name: "payrollNode",            status: "pending" as NodeStatus }] : []),
        ...(intent.runTax            ? [{ name: "taxNode",                status: "pending" as NodeStatus }] : []),
        ...(intent.runFinancialModel ? [{ name: "financialModelNode",     status: "pending" as NodeStatus }] : []),
        { name: "summaryNode", status: "pending" },
      ];
      setAgentNodes(initialNodes);
      setIsAgentRunning(true);

      try {
        // POST to the agent route with the goal + clientId + all extracted fields
        const response = await fetch("/api/agent", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal:                  message,
            clientId:              schemaName,       // schemaName is the clientId slug
            runFS:                 intent.runFS,
            runPayroll:            intent.runPayroll,
            runTax:                intent.runTax,
            runFinancialModel:     intent.runFinancialModel,
            financialYear:         intent.financialYear,
            payrollMonth:          intent.payrollMonth,
            payrollYear:           intent.payrollYear,
            yearOfAssessment:      intent.yearOfAssessment,
            projectionPeriodYears: intent.projectionPeriodYears,
          }),
        });

        if (!response.ok || !response.body) {
          // Non-2xx before the stream even opens — show as a chat error
          appendMessage("system", `❌ Agent error: HTTP ${response.status}`);
          setIsAgentRunning(false);
          return;
        }

        // Read the SSE stream line-by-line using a text decoder
        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = "";   // accumulates partial SSE lines between chunks

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;  // stream closed by server after graph:complete or graph:error

          // Append the decoded chunk to our line buffer
          buffer += decoder.decode(value, { stream: true });

          // SSE lines are separated by "\n\n"; split and process each complete event
          const parts = buffer.split("\n\n");
          // The last element may be an incomplete line — keep it in the buffer
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            // Each part is "data: <json>" — strip the "data: " prefix
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice("data: ".length);

            let payload: { event: string; data: Record<string, unknown> };
            try {
              payload = JSON.parse(jsonStr);
            } catch {
              continue;  // skip malformed lines
            }

            const { event, data } = payload;

            if (event === "node:started") {
              // Mark the named node as running — spinner appears in the panel
              const nodeName = data.node as string;
              setAgentNodes((prev) =>
                prev.map((n) =>
                  n.name === nodeName ? { ...n, status: "running" } : n
                )
              );

            } else if (event === "node:complete") {
              // Node finished cleanly — flip it to complete
              const nodeName = data.node as string;
              setAgentNodes((prev) =>
                prev.map((n) =>
                  n.name === nodeName ? { ...n, status: "complete" } : n
                )
              );

            } else if (event === "node:error") {
              // Node failed — record the error message alongside the status
              const nodeName  = data.node as string;
              const errorMsg  = data.error as string;
              setAgentNodes((prev) =>
                prev.map((n) =>
                  n.name === nodeName
                    ? { ...n, status: "error", error: errorMsg }
                    : n
                )
              );

            } else if (event === "validation:missing") {
              // Required inputs were missing — panel will show the prompt message
              setAgentMissingInputs(data.fields as string[]);

            } else if (event === "graph:complete") {
              // Graph finished — store the summary and close the running state
              setAgentSummary((data.summary as string) || null);
              setIsAgentRunning(false);

            } else if (event === "graph:error") {
              // Unhandled error in graph execution — show in chat as a system message
              appendMessage("system", `❌ Agent error: ${data.error as string}`);
              setIsAgentRunning(false);
            }
          }
        }

      } catch {
        appendMessage("system", "❌ Network error — could not reach /api/agent.");
        setIsAgentRunning(false);
      } finally {
        setIsSending(false);
      }

      return;  // do not fall through to the standard chat route
    }

    // ── Standard chat path (unchanged) ──────────────────────────────────────
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
        <h2 className="text-sm font-medium">FinAgent</h2>  {/* updated heading */}
        <p className="text-xs text-muted-foreground mt-1">
          Run workflows · Ask questions · Submit corrections  {/* updated subtitle */}
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

        {/* ── Agent progress panel (V3-D) ────────────────────────────────────
            Rendered below all chat bubbles when an agent run is active or just
            finished. Stays visible until the user sends the next message, which
            resets all agent state back to initial values (see handleSend).
            Option A: panel lives outside the messages array — ChatMessage type
            is unchanged; AgentProgressPanel is a sibling after the .map(). */}
        {/* Also render when missingInputs is set — covers the no-client-selected
            guard which sets missingInputs without starting an agent run */}
        {(isAgentRunning || agentSummary !== null || agentMissingInputs.length > 0) && (
          <AgentProgressPanel
            nodes={agentNodes}
            missingInputs={agentMissingInputs}
            summary={agentSummary}
            isRunning={isAgentRunning}
          />
        )}
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
          {/* Wrapper div holds both the hint panel and the textarea.
              hintWrapperRef lets the outside-click handler (useEffect above)
              distinguish clicks inside this area from clicks elsewhere. */}
          <div className="relative flex-1" ref={hintWrapperRef}>

            {/* ── Floating hint panel ──────────────────────────────────────────
                Visible whenever showHint is true — set on textarea focus and
                cleared only by the document mousedown handler when the user
                clicks outside this wrapper. Remains visible while typing.
                onMouseDown={e.preventDefault()} stops the mousedown event from
                propagating to the document listener, so clicking inside the
                panel never triggers the outside-click hide logic. */}
            {showHint && (
              <div
                onMouseDown={(e) => e.preventDefault()} // prevent outside-click handler from firing on panel clicks
                className="absolute bottom-full mb-1 left-0 right-0 z-10
                            rounded-md border bg-popover px-3 py-2 shadow-md
                            text-xs text-muted-foreground space-y-0.5 select-text"
              >
                {/* Header label */}
                <p className="font-medium text-foreground mb-1">Try:</p>
                {/* Agent workflow examples */}
                <p>Agent — "Prepare financial statement for 2025"</p>
                <p>Agent — "Run payroll for April 2026"</p>
                <p>Agent — "Compute corporate tax for YA2026"</p>
                <p>Agent — "Generate a 3 year financial projection"</p>
                {/* RAG question example */}
                <p>Question — "What is the CPF contribution rate for a PR in year 2?"</p>
                {/* Correction examples */}
                <p>Correction — "The depreciation for this client should use straight-line method"</p>
                <p>Correction — "Update financial statements notes to include the going concern note"</p>
              </div>
            )}

            {/* The textarea — placeholder removed; onFocus shows the hint panel.
                No onBlur handler: hiding is handled by the document mousedown
                listener instead, so the panel survives clicks within the wrapper. */}
            <Textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowHint(true)}  // reveal hint panel when user enters the textarea
              className="resize-none min-h-[60px] w-full"
              disabled={isSending}
            />
          </div>

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
