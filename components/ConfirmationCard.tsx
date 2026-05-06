/**
 * components/ConfirmationCard.tsx
 *
 * Inline confirmation card rendered in the chat when the agent proposes a
 * write action that requires explicit user approval before execution.
 *
 * Write actions (add_employee, update_employee, add_client, configure_tax,
 * identify_tax_adjustments) route through this card before any data is written
 * to Supabase. Read-only workflow triggers (run_financial_statement, run_payroll,
 * etc.) bypass this card entirely and execute immediately.
 *
 * Visual style: amber/warning border to signal "attention needed" — clearly
 * distinct from the neutral AgentProgressPanel card.
 *
 * Placed below AgentProgressPanel in ChatbotPanel when pendingAction is set.
 * Cleared (pendingAction → null) after the user clicks Confirm or Cancel.
 */

"use client";

import { Loader2, TriangleAlert } from "lucide-react";  // warning icon + spinner
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// ── Prop types ────────────────────────────────────────────────────────────────

interface ConfirmationCardProps {
  action: {
    tool:        string;                    // e.g. "add_employee"
    params:      Record<string, unknown>;   // full params for the tool call
    description: string;                    // plain English shown to user
  };
  onConfirm:  () => void;   // called when user clicks Confirm
  onCancel:   () => void;   // called when user clicks Cancel
  isLoading:  boolean;      // true while the confirmed action is executing
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a compact one-line param summary for display below the description.
 * Shows "Tool: <name> | Key: value | Key: value" — at most 3 param entries
 * to keep the card compact. Keys are title-cased from snake_case.
 *
 * Example output: "Tool: add_employee | Name: John Tan | Salary: 4000"
 */
function buildParamSummary(tool: string, params: Record<string, unknown>): string {
  // Start with the tool name itself as the first segment
  const segments: string[] = [`Tool: ${tool}`];

  // Append up to 3 key-value pairs from params — skip undefined/null values
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;

    // Convert snake_case key to Title Case for readability
    const label = key
      .replace(/_/g, " ")                   // underscores → spaces
      .replace(/\b\w/g, (c) => c.toUpperCase()); // title-case each word

    segments.push(`${label}: ${String(val)}`);

    // Stop after 3 param entries — enough context without overwhelming
    if (segments.length >= 4) break;
  }

  return segments.join(" | ");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ConfirmationCard({
  action,
  onConfirm,
  onCancel,
  isLoading,
}: ConfirmationCardProps) {
  return (
    // Amber border distinguishes this card from AgentProgressPanel's neutral border
    <Card className="w-full border-amber-300 bg-amber-50/40 dark:bg-amber-950/20 dark:border-amber-700">

      {/* ── Header: warning icon + title ── */}
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {/* Amber warning icon — visually reinforces "action required" */}
          <TriangleAlert className="h-4 w-4 text-amber-500 shrink-0" />
          <CardTitle className="text-sm font-medium text-amber-700 dark:text-amber-400">
            Action Required
          </CardTitle>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">

        {/* ── Description: plain-English action summary for the user ── */}
        <p className="text-sm text-foreground">
          {action.description}
        </p>

        {/* ── Param summary: muted one-liner showing tool name + key params ── */}
        <p className="text-xs text-muted-foreground font-mono break-all">
          {buildParamSummary(action.tool, action.params)}
        </p>

        {/* ── Confirm / Cancel buttons ── */}
        <div className="flex gap-2">

          {/* Confirm: primary style; spinner replaces label while loading */}
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={isLoading}                    // block double-click during execution
            className="min-w-[90px]"
          >
            {isLoading ? (
              // Spinner + label while the action is executing server-side
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                Executing…
              </>
            ) : (
              "Confirm"
            )}
          </Button>

          {/* Cancel: outline style; disabled while loading to prevent race */}
          <Button
            size="sm"
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}                    // prevent cancel during execution
          >
            Cancel
          </Button>

        </div>
      </CardContent>
    </Card>
  );
}
