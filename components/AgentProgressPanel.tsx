/**
 * components/AgentProgressPanel.tsx
 *
 * Renders the agent run progress inside the chat UI.
 *
 * Consumed by the chat panel when the user submits a natural language goal to
 * /api/agent. The parent component reads the SSE stream from that route and
 * translates each incoming event into the `nodes` + `missingInputs` + `summary`
 * props passed here.
 *
 * Render rules:
 *   1. If missingInputs.length > 0 — show a single prompt message listing the
 *      missing fields; no node rows are shown (graph stopped before running).
 *   2. Otherwise — render one status row per node in the order they arrive.
 *      Each row shows the node name plus a status indicator:
 *        pending   → grey  ○
 *        running   → blue  ◐  (animate-pulse)
 *        complete  → green ✓
 *        error     → red   ✗  + inline error message
 *   3. If summary is present (graph:complete received) — render it below all
 *      node rows inside a light card.
 *   4. isRunning prop drives the top-level "Agent running…" / "Agent finished"
 *      badge shown in the card header.
 *
 * Visual style matches WorkflowPanel.tsx progress panel exactly
 * (same Tailwind classes, same shadcn/ui Badge variants).
 */

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ── Prop types ────────────────────────────────────────────────────────────────

// One entry per LangGraph node; parent updates status as SSE events arrive
type NodeStatus = "pending" | "running" | "complete" | "error";

interface NodeEntry {
  name:    string;       // raw LangGraph node name e.g. "financialStatementNode"
  status:  NodeStatus;
  error?:  string;       // populated when status === "error"
}

interface AgentProgressPanelProps {
  nodes:         NodeEntry[];   // ordered list of nodes seen so far
  missingInputs: string[];      // from validation:missing SSE event; empty most of the time
  summary:       string | null; // from graph:complete SSE event
  isRunning:     boolean;       // true while SSE stream is still open
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a camelCase LangGraph node name to a readable label.
 * e.g. "financialStatementNode" → "Financial Statement"
 *      "managerNode"            → "Manager"
 *      "validationNode"         → "Validation"
 */
function formatNodeName(name: string): string {
  // Strip trailing "Node" suffix, then insert spaces before capital letters
  return name
    .replace(/Node$/, "")                   // remove "Node" suffix
    .replace(/([A-Z])/g, " $1")             // insert space before each capital
    .trim()                                  // remove any leading space
    .replace(/^./, (c) => c.toUpperCase()); // capitalise first letter
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentProgressPanel({
  nodes,
  missingInputs,
  summary,
  isRunning,
}: AgentProgressPanelProps) {
  return (
    <Card className="w-full">
      {/* ── Header: status badge ── */}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Agent</CardTitle>
          {isRunning ? (
            // Stream still open — pulse to indicate activity
            <Badge variant="outline" className="text-xs text-blue-600 border-blue-200 animate-pulse">
              Running…
            </Badge>
          ) : (
            // Stream closed — show outcome
            <Badge variant="outline" className="text-xs text-green-600 border-green-200">
              Finished
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">

        {/* ── Case 1: missing inputs — skip node rows ── */}
        {missingInputs.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Before I can proceed, I need the following information:{" "}
            <span className="font-medium text-foreground">
              {missingInputs.join(", ")}
            </span>
            . Please provide the missing details and try again.
          </p>
        ) : (
          /* ── Case 2: node status rows ── */
          <div className="space-y-2">
            {nodes.map((node, i) => (
              <div key={`${node.name}-${i}`} className="flex items-start gap-2">
                {/* Status icon — matches WorkflowPanel exactly */}
                <span className={
                  node.status === "complete" ? "text-green-500 mt-0.5" :
                  node.status === "running"  ? "text-blue-500 mt-0.5 animate-pulse" :
                  node.status === "error"    ? "text-destructive mt-0.5" :
                  "text-muted-foreground/40 mt-0.5"
                }>
                  {node.status === "complete" ? "✓" :
                   node.status === "running"  ? "◐" :
                   node.status === "error"    ? "✗" : "○"}
                </span>

                {/* Node label + optional inline error */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${node.status === "pending" ? "text-muted-foreground" : "text-foreground"}`}>
                    {formatNodeName(node.name)}
                  </p>
                  {/* Show error detail below the label when the node failed */}
                  {node.status === "error" && node.error && (
                    <p className="text-xs text-destructive mt-0.5 truncate" title={node.error}>
                      {node.error}
                    </p>
                  )}
                </div>

                {/* Right-aligned status badge — same variants as WorkflowPanel */}
                {node.status === "running" && (
                  <Badge variant="outline" className="text-xs shrink-0">Running</Badge>
                )}
                {node.status === "complete" && (
                  <Badge variant="outline" className="text-xs shrink-0 text-green-600 border-green-200">Done</Badge>
                )}
                {node.status === "error" && (
                  <Badge variant="destructive" className="text-xs shrink-0">Error</Badge>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Case 3: summary — rendered below node rows when graph:complete arrives ── */}
        {summary && (
          <div className="rounded-md bg-muted px-3 py-2 mt-1">
            <p className="text-sm text-foreground">{summary}</p>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
