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
 * Phase 0: Static UI shell only. No backend logic, no AI calls, no data fetching.
 * All panels show placeholder content. Interactions will be wired in Phase 1+.
 */

import { WorkflowPanel } from "@/components/WorkflowPanel";
import { ChatbotPanel } from "@/components/ChatbotPanel";
import { BottomNav } from "@/components/BottomNav";

export default function HomePage() {
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
          <WorkflowPanel />
        </div>

        {/* Right: Chatbot panel */}
        <div className="w-1/2 overflow-y-auto">
          <ChatbotPanel />
        </div>
      </main>

      {/* Bottom navigation */}
      <BottomNav />
    </div>
  );
}
