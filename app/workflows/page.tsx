/**
 * app/workflows/page.tsx
 *
 * Workflow runner page — two-panel split layout.
 * - Left panel: Workflow (task selector, file upload, config, generate, progress, output)
 * - Right panel: Training & Feedback Chatbot
 *
 * schemaName defaults to "" so auto-resolution (via the dashboard) handles initial client
 * selection rather than silently running against a hardcoded test client.
 *
 * Moved from app/page.tsx to /workflows as part of V4 dashboard refactor.
 */

"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { WorkflowPanel } from "@/components/WorkflowPanel";
import { ChatbotPanel } from "@/components/ChatbotPanel";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";

export default function WorkflowsPage() {
  const { data: session } = useSession();

  // Empty string default — the agent cannot silently run against a test schema.
  // Updates in real time as the user selects or types in the Company Name field.
  const [schemaName, setSchemaName] = useState("");

  // Tracks whether the user has made an explicit client selection this session.
  // Starts false so the agent cannot run until the user has chosen a client.
  // Becomes true the first time WorkflowPanel calls onSchemaNameChange.
  const [clientSelected, setClientSelected] = useState(false);

  // Stores run IDs produced by the most recent agent graph execution.
  // Each entry tells a workflow component which Supabase row to auto-load.
  // Reset to [] whenever the active client changes (different client = stale run IDs).
  const [agentCompletedRuns, setAgentCompletedRuns] = useState<
    Array<{ workflow: string; runId: string }>
  >([]);

  // Auto-resolve the user's company when they land on /workflows with no client selected.
  // Fetches /api/clients (already filtered to the session user's own companies) and
  // pre-selects automatically if exactly one company is found. Admins or future
  // multi-company users with more than one client are left to the dropdown.
  useEffect(() => {
    if (schemaName !== "") return; // already set — skip auto-resolve
    fetch("/api/clients")
      .then((r) => r.json())
      .then((json: { clients?: Array<{ schema_name: string }> }) => {
        const clients = json.clients ?? [];
        if (clients.length === 1) {
          setSchemaName(clients[0].schema_name);
          setClientSelected(true);
        }
      })
      .catch(() => {}); // silent — user can still select manually via the dropdown
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Called by ChatbotPanel when the agent graph:complete SSE event fires.
  // Filters out any entries with an empty runId (failed nodes return no ID).
  function handleAgentComplete(runs: Array<{ workflow: string; runId: string }>) {
    setAgentCompletedRuns(runs.filter((r) => !!r.runId));
  }

  return (
    <AppLayout
      pageTitle="Workflows"
      headerRight={
        <div className="flex items-center gap-3">
          {session?.user?.name && (
            <span className="text-sm text-muted-foreground">
              {session.user.name}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/auth/login" })}
          >
            Sign out
          </Button>
        </div>
      }
    >
      {/* Main two-panel area */}
      <main className="flex flex-1 overflow-hidden flex-col md:flex-row">
        {/* Left: Workflow panel */}
        <div className="w-full md:w-1/2 border-b md:border-b-0 md:border-r overflow-y-auto">
          <WorkflowPanel
            onSchemaNameChange={(name) => {
              setSchemaName(name);           // update the active client schema
              setClientSelected(true);       // mark that the user made an explicit selection
              setAgentCompletedRuns([]);     // stale run IDs from a previous client are no longer valid
            }}
            agentCompletedRuns={agentCompletedRuns}  // signals which workflow to auto-load
          />
        </div>

        {/* Right: Chatbot panel */}
        <div className="w-full md:w-1/2 overflow-y-auto min-h-64 md:min-h-0">
          <ChatbotPanel
            schemaName={schemaName}
            clientSelected={clientSelected}
            onAgentComplete={handleAgentComplete}  // called when graph:complete fires with completedRuns
            onClientCreated={(newSchemaName) => {
              setSchemaName(newSchemaName);    // switch WorkflowPanel to the newly created client
              setClientSelected(true);         // mark explicit selection so agent can run immediately
              setAgentCompletedRuns([]);       // clear any stale run IDs from the previous client
            }}
          />
        </div>
      </main>
    </AppLayout>
  );
}
