/**
 * app/page.tsx
 *
 * Main page for FinAgent-SG.
 *
 * Layout: Two-panel split layout.
 * - Left panel: Workflow (task selector, file upload, config, generate, progress, output)
 * - Right panel: Training & Feedback Chatbot
 * - Bottom: Navigation bar
 *
 * Phase 5: schemaName is lifted here so ChatbotPanel writes corrections to the
 * same client schema that WorkflowPanel is working on.
 * Phase 6: Header shows logged-in user name + Sign Out button.
 */

"use client";

import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { WorkflowPanel } from "@/components/WorkflowPanel";
import { ChatbotPanel } from "@/components/ChatbotPanel";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const { data: session } = useSession();

  // Defaults to techsoft_pte_ltd so corrections work before a company name is typed.
  // Updates in real time as the user types in the Company Name field.
  const [schemaName, setSchemaName] = useState("techsoft_pte_ltd");

  // Tracks whether the user has made an explicit client selection this session.
  // Starts false so the agent cannot silently run against the default schema.
  // Becomes true the first time WorkflowPanel calls onSchemaNameChange (either
  // dropdown pick or company name typed), and stays true for the rest of the session.
  const [clientSelected, setClientSelected] = useState(false);

  // Stores run IDs produced by the most recent agent graph execution.
  // Each entry tells a workflow component which Supabase row to auto-load.
  // Reset to [] whenever the active client changes (different client = stale run IDs).
  const [agentCompletedRuns, setAgentCompletedRuns] = useState<
    Array<{ workflow: string; runId: string }>
  >([]);

  // Called by ChatbotPanel when the agent graph:complete SSE event fires.
  // Filters out any entries with an empty runId (failed nodes return no ID).
  function handleAgentComplete(runs: Array<{ workflow: string; runId: string }>) {
    setAgentCompletedRuns(runs.filter((r) => !!r.runId));
  }

  return (
    <AppLayout
      pageTitle="Dashboard"
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
