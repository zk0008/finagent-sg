/**
 * components/BottomNav.tsx
 *
 * Bottom navigation bar for FinAgent-SG.
 *
 * Links:
 * - Dashboard: Overview of all clients and recent activity
 * - Clients: Client management — add/edit entities and fiscal years
 * - History: Past generated outputs and corrections
 * - Settings: User account, API keys, preferences
 *
 * Phase 0: Placeholder links only — no pages exist yet.
 * Individual pages will be built in Phase 1 (Clients) and later phases.
 * Uses Next.js Link for client-side navigation when pages are ready.
 */

import { Separator } from "@/components/ui/separator";

const NAV_ITEMS = [
  { label: "Dashboard", href: "/" },
  { label: "Clients", href: "/clients" },
  { label: "History", href: "/history" },
  { label: "Settings", href: "/settings" },
];

export function BottomNav() {
  return (
    <footer className="border-t bg-white">
      <Separator />
      <nav className="flex items-center gap-6 px-6 py-3">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {item.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
