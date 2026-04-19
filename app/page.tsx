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
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const { data: session } = useSession();

  // Defaults to techsoft_pte_ltd so corrections work before a company name is typed.
  // Updates in real time as the user types in the Company Name field.
  const [schemaName, setSchemaName] = useState("techsoft_pte_ltd");

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top header bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
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
      </header>

      {/* Main two-panel area */}
      <main className="flex flex-1 overflow-hidden flex-col md:flex-row">
        {/* Left: Workflow panel */}
        <div className="w-full md:w-1/2 border-b md:border-b-0 md:border-r overflow-y-auto">
          <WorkflowPanel onSchemaNameChange={setSchemaName} />
        </div>

        {/* Right: Chatbot panel */}
        <div className="w-full md:w-1/2 overflow-y-auto min-h-64 md:min-h-0">
          <ChatbotPanel schemaName={schemaName} />
        </div>
      </main>

      {/* Bottom navigation */}
      <BottomNav />
    </div>
  );
}
