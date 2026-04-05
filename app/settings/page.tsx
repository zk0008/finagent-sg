/**
 * app/settings/page.tsx
 *
 * Settings placeholder page for FinAgent-SG.
 * Static — no backend calls.
 */

import { BottomNav } from "@/components/BottomNav";

export default function SettingsPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
      </header>

      <main className="flex-1 p-8 max-w-3xl mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Settings coming soon.</p>
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
