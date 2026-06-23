/**
 * app/settings/page.tsx
 *
 * Settings placeholder page for FinAgent-SG.
 * Static — no backend calls.
 */

import { AppLayout } from "@/components/AppLayout";

export default function SettingsPage() {
  return (
    <AppLayout pageTitle="Settings">
      <main className="flex-1 p-8 max-w-3xl mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Settings coming soon.</p>
        </div>
      </main>
    </AppLayout>
  );
}
