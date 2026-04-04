/**
 * app/page.tsx
 *
 * Main page for FinAgent-SG — Phase 0 UI shell.
 *
 * Layout: Two-panel split layout.
 * - Left panel: Workflow (task selector, file upload, config, generate, progress, output)
 * - Right panel: Training & Feedback Chatbot
 * - Bottom: Navigation bar
 *
 * Phase 5: schemaName is lifted here so ChatbotPanel writes corrections to the
 * same client schema that WorkflowPanel is working on.
 */

"use client";

import { useState } from "react";
import { WorkflowPanel } from "@/components/WorkflowPanel";
import { ChatbotPanel } from "@/components/ChatbotPanel";
import { BottomNav } from "@/components/BottomNav";

export default function HomePage() {
  // Defaults to techsoft_pte_ltd so corrections work before a company name is typed.
  // Updates in real time as the user types in the Company Name field.
  const [schemaName, setSchemaName] = useState("techsoft_pte_ltd");

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top header bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
        <span className="text-sm text-muted-foreground">[Client: — ]</span>
      </header>

      {/* Main two-panel area */}
      <main className="flex flex-1 overflow-hidden">
        {/* Left: Workflow panel */}
        <div className="w-1/2 border-r overflow-y-auto">
          <WorkflowPanel onSchemaNameChange={setSchemaName} />
        </div>

        {/* Right: Chatbot panel */}
        <div className="w-1/2 overflow-y-auto">
          <ChatbotPanel schemaName={schemaName} />
        </div>
      </main>

      {/* Bottom navigation */}
      <BottomNav />
    </div>
  );
}
