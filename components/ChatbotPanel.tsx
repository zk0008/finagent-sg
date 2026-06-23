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
import { ConfirmationCard } from "@/components/ConfirmationCard";     // inline yes/no card for write actions

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
  // Called when the agent graph:complete SSE event fires with a completedRuns array.
  // Passed up to page.tsx, which stores the runs and passes them to WorkflowPanel
  // so each workflow component can auto-load its agent-generated result.
  onAgentComplete?: (runs: Array<{ workflow: string; runId: string }>) => void;
  // Called after add_client confirmation succeeds — page.tsx uses this to switch the
  // active client in WorkflowPanel so the user can immediately run workflows.
  onClientCreated?: (schemaName: string) => void;
}

// ── Agent SSE helper ──────────────────────────────────────────────────────────
// Shared SSE parsing logic — used by both handleSend (initial agent run) and
// handleConfirm (re-invocation after action confirmation).
interface AgentSSEHandlers {
  onNodeStarted:                (nodeName: string) => void;
  onNodeComplete:               (nodeName: string) => void;
  onNodeError:                  (nodeName: string, error: string) => void;
  onValidationMissing:          (fields: string[]) => void;
  onActionConfirmationRequired: (action: { tool: string; params: Record<string, unknown>; description: string }) => void;
  onActionExecuted:             (message: string) => void;
  onGraphComplete:              (summary: string, completedRuns: Array<{ workflow: string; runId: string; projectionPeriodYears?: number }>, executedAction?: string, newClientSchemaName?: string) => void;
  onGraphError:                 (error: string) => void;
}

async function consumeAgentSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: AgentSSEHandlers,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      let payload: { event: string; data: Record<string, unknown> };
      try { payload = JSON.parse(line.slice("data: ".length)); } catch { continue; }
      const { event, data } = payload;
      if (event === "node:started") {
        handlers.onNodeStarted(data.node as string);
      } else if (event === "node:complete") {
        handlers.onNodeComplete(data.node as string);
      } else if (event === "node:error") {
        handlers.onNodeError(data.node as string, data.error as string);
      } else if (event === "validation:missing") {
        handlers.onValidationMissing(data.fields as string[]);
      } else if (event === "action:confirmation_required") {
        handlers.onActionConfirmationRequired(data.action as { tool: string; params: Record<string, unknown>; description: string });
      } else if (event === "action:executed") {
        handlers.onActionExecuted(data.message as string);
      } else if (event === "graph:complete") {
        handlers.onGraphComplete(
          (data.summary as string) || "",
          (data.completedRuns as Array<{ workflow: string; runId: string; projectionPeriodYears?: number }>) || [],
          data.executedAction as string | undefined,
          // newClientSchemaName is only present on add_client action-only completions
          data.newClientSchemaName as string | undefined,
        );
      } else if (event === "graph:error") {
        handlers.onGraphError(data.error as string);
      }
    }
  }
}

// Single welcome message shown on load — replaces the old dummy conversation
const INITIAL_MESSAGES: ChatMessage[] = [
  {
    role: "system",
    content:
      "Welcome to FinAgent. Select a client from the left panel, then type a command or question below.",
  },
];

export function ChatbotPanel({ schemaName = "default", clientSelected = false, onAgentComplete, onClientCreated }: ChatbotPanelProps) {
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

  // Pending write action proposed by the agent — set by action:confirmation_required
  // SSE event; cleared when the user clicks Confirm or Cancel, or sends a new message.
  const [pendingAction, setPendingAction] = useState<{
    tool:        string;
    params:      Record<string, unknown>;
    description: string;
  } | null>(null);

  // True while /api/agent/confirm is being called after the user clicks Confirm.
  // Drives the loading spinner inside ConfirmationCard.
  const [isConfirmationLoading, setIsConfirmationLoading] = useState(false);

  // ── Agent goal + temporal params (V3.2-B) ────────────────────────────────
  // Captured from handleSend when routing to /api/agent; preserved here so
  // handleConfirm can re-invoke the graph with the same context after an action
  // is confirmed without asking the user to repeat themselves.
  const [agentGoal,                 setAgentGoal]                 = useState<string>("");
  const [agentFinancialYear,        setAgentFinancialYear]        = useState<string | undefined>(undefined);
  const [agentPayrollMonth,         setAgentPayrollMonth]         = useState<number | undefined>(undefined);
  const [agentPayrollYear,          setAgentPayrollYear]          = useState<number | undefined>(undefined);
  const [agentYearOfAssessment,     setAgentYearOfAssessment]     = useState<string | undefined>(undefined);
  const [agentProjectionPeriodYears, setAgentProjectionPeriodYears] = useState<number | undefined>(undefined);

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
    // Also clear any outstanding confirmation card — a new message supersedes it
    setPendingAction(null);
    setIsConfirmationLoading(false);
    // Reset preserved goal + temporal params — will be re-set below if isAgentGoal
    setAgentGoal("");
    setAgentFinancialYear(undefined);
    setAgentPayrollMonth(undefined);
    setAgentPayrollYear(undefined);
    setAgentYearOfAssessment(undefined);
    setAgentProjectionPeriodYears(undefined);

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

      // Preserve goal + temporal params so handleConfirm can re-invoke the graph
      // with the same context after the user confirms an action tool call.
      setAgentGoal(message);
      setAgentFinancialYear(intent.financialYear);
      setAgentPayrollMonth(intent.payrollMonth);
      setAgentPayrollYear(intent.payrollYear);
      setAgentYearOfAssessment(intent.yearOfAssessment);
      setAgentProjectionPeriodYears(intent.projectionPeriodYears);

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

        const reader = response.body.getReader();
        await consumeAgentSSE(reader, {
          onNodeStarted: (nodeName) => {
            setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "running" } : n));
          },
          onNodeComplete: (nodeName) => {
            setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "complete" } : n));
          },
          onNodeError: (nodeName, errorMsg) => {
            setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "error", error: errorMsg } : n));
          },
          onValidationMissing: (fields) => {
            setAgentMissingInputs(fields);
          },
          onActionConfirmationRequired: (actionPayload) => {
            setPendingAction(actionPayload);
          },
          onActionExecuted: (msg) => {
            appendMessage("system", `✅ ${msg}`);
          },
          onGraphComplete: (summary, completedRuns) => {
            setAgentSummary(summary || null);
            setIsAgentRunning(false);
            if (completedRuns.length > 0) {
              onAgentComplete?.(completedRuns);
            }
            // executedAction not present on the initial agent route — no action needed here
          },
          onGraphError: (error) => {
            appendMessage("system", `❌ Agent error: ${error}`);
            setIsAgentRunning(false);
          },
        });

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
   * Called when the user clicks Confirm on the ConfirmationCard.
   *
   * POSTs to /api/agent/confirm with the full preserved agent context so the
   * confirm route can execute the action and optionally re-invoke the graph for
   * any workflows the user also requested. Consumes the SSE response stream with
   * the shared consumeAgentSSE helper — same event handling as handleSend.
   */
  async function handleConfirm() {
    if (!pendingAction) return;

    // Capture before clearing state — used in the fetch body below
    const action = pendingAction;

    // Clear the card immediately; show spinner in the Confirm button
    setPendingAction(null);
    setIsConfirmationLoading(true);

    // Derive workflow flags from the node list built during handleSend
    const runFS             = agentNodes.some((n) => n.name === "financialStatementNode");
    const runPayroll        = agentNodes.some((n) => n.name === "payrollNode");
    const runTax            = agentNodes.some((n) => n.name === "taxNode");
    const runFinancialModel = agentNodes.some((n) => n.name === "financialModelNode");

    // Reset progress panel for the re-invocation run
    setAgentSummary(null);
    setIsAgentRunning(true);
    const reInvokeNodes: AgentNodeEntry[] = [
      { name: "validationNode", status: "pending" },
      { name: "managerNode",    status: "pending" },
      ...(runFS             ? [{ name: "financialStatementNode", status: "pending" as NodeStatus }] : []),
      ...(runPayroll        ? [{ name: "payrollNode",            status: "pending" as NodeStatus }] : []),
      ...(runTax            ? [{ name: "taxNode",                status: "pending" as NodeStatus }] : []),
      ...(runFinancialModel ? [{ name: "financialModelNode",     status: "pending" as NodeStatus }] : []),
      { name: "summaryNode", status: "pending" },
    ];
    setAgentNodes(reInvokeNodes);

    try {
      const res = await fetch("/api/agent/confirm", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          confirmed:             true,
          action,
          clientId:              schemaName,
          goal:                  agentGoal,
          runFS,
          runPayroll,
          runTax,
          runFinancialModel,
          financialYear:         agentFinancialYear,
          payrollMonth:          agentPayrollMonth,
          payrollYear:           agentPayrollYear,
          yearOfAssessment:      agentYearOfAssessment,
          projectionPeriodYears: agentProjectionPeriodYears,
        }),
      });

      if (!res.ok || !res.body) {
        // Non-2xx before the stream opens (action execution failed)
        const result = await res.json() as { error?: string };
        appendMessage("system", `❌ Confirm error: ${result.error ?? "Unknown error"}`);
        setIsAgentRunning(false);
        return;
      }

      const reader = res.body.getReader();
      await consumeAgentSSE(reader, {
        onNodeStarted: (nodeName) => {
          setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "running" } : n));
        },
        onNodeComplete: (nodeName) => {
          setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "complete" } : n));
        },
        onNodeError: (nodeName, errorMsg) => {
          setAgentNodes((prev) => prev.map((n) => n.name === nodeName ? { ...n, status: "error", error: errorMsg } : n));
        },
        onValidationMissing: (fields) => {
          setAgentMissingInputs(fields);
        },
        onActionConfirmationRequired: (actionPayload) => {
          setPendingAction(actionPayload);
        },
        onActionExecuted: (msg) => {
          appendMessage("system", `✅ ${msg}`);
        },
        onGraphComplete: (summary, completedRuns, executedAction, newClientSchemaName) => {
          setAgentSummary(summary || null);
          setIsAgentRunning(false);
          if (completedRuns.length > 0) {
            onAgentComplete?.(completedRuns);
          }
          // Action-only completion (no workflow re-invocation): if the confirmed action
          // was add_employee or update_employee, trigger a PayrollWorkflow employee list
          // re-fetch via a sentinel runId so the new employee appears immediately.
          if (
            (executedAction === "add_employee" || executedAction === "update_employee") &&
            completedRuns.length === 0
          ) {
            onAgentComplete?.([{ workflow: "payroll", runId: "refresh" }]);
          }
          // add_client: auto-switch the active client in the UI so the user can
          // immediately run workflows for the newly created client.
          if (executedAction === "add_client" && newClientSchemaName && completedRuns.length === 0) {
            onClientCreated?.(newClientSchemaName);  // propagates to page.tsx setSchemaName + setClientSelected
            appendMessage(
              "system",
              `✅ Client created. Switched to ${newClientSchemaName}. You can now run workflows for this client.`,
            );
          }
        },
        onGraphError: (error) => {
          appendMessage("system", `❌ Agent error: ${error}`);
          setIsAgentRunning(false);
        },
      });

    } catch {
      appendMessage("system", "❌ Network error — could not reach /api/agent/confirm.");
      setIsAgentRunning(false);
    } finally {
      setIsConfirmationLoading(false);
    }
  }

  /**
   * Called when the user clicks Cancel on the ConfirmationCard.
   * Clears the card immediately, then fires a fire-and-forget POST to
   * /api/agent/confirm with confirmed:false so the server can clean up state.
   */
  function handleCancel() {
    if (!pendingAction) return;              // guard: nothing to cancel

    // Capture the action before nulling state — the fetch below closes over it
    const cancelledAction = pendingAction;

    // Clear the card immediately — no loading state needed for cancel
    setPendingAction(null);

    // Fire-and-forget: inform the server the action was rejected.
    // void — does not block the UI; server-side no-op in the current stub.
    void fetch("/api/agent/confirm", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        confirmed: false,
        action:    cancelledAction,          // action that was cancelled
        clientId:  schemaName,
      }),
    });
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

        {/* ── Confirmation card (V3.2-F) ────────────────────────────────────
            Rendered below AgentProgressPanel when the agent proposes a write
            action that requires user approval (e.g. add_employee, add_client).
            Cleared when the user clicks Confirm or Cancel, or sends a new message. */}
        {pendingAction !== null && (
          <ConfirmationCard
            action={pendingAction}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
            isLoading={isConfirmationLoading}
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
                            rounded-md border bg-popover px-3 py-2 shadow-sm
                            text-xs text-muted-foreground space-y-0.5 select-text"
              >
                {/* Section 1: agent workflow and action tool examples */}
                <p className="font-medium text-foreground mb-0.5">🤖 Agent — workflows and actions</p>
                <p>Prepare financial statement for 2025</p>
                <p>Run payroll for April 2026</p>
                <p>Compute corporate tax for YA2026</p>
                <p>Generate a 3 year financial projection</p>
                <p>Run payroll for May 2026 and what is the SDL rate?</p>
                <p>Prepare financial statement for 2025. The depreciation should use straight-line method.</p>
                <p>Add employee John Tan, Singapore citizen, DOB 1990-01-15, salary $4000</p>
                <p>Delete employee John Tan</p>
                <p>Update employee John Tan salary to $4500</p>
                <p>Add new client TechSoft Pte Ltd, UEN 202500001A, FYE 31 December 2026</p>
                {/* Section 2: RAG knowledge base questions */}
                <p className="font-medium text-foreground mt-1.5 mb-0.5">💬 Question — Singapore accounting and tax</p>
                <p>What is the CPF contribution rate for a PR in year 2?</p>
                <p>What are the SFRS going concern disclosure requirements?</p>
                <p>What is the SDL rate for 2026?</p>
                {/* Section 3: correction / knowledge base update examples */}
                <p className="font-medium text-foreground mt-1.5 mb-0.5">✏️ Correction — update the knowledge base</p>
                <p>The depreciation for this client should use straight-line method</p>
                <p>Update financial statements notes to include the going concern note</p>
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
