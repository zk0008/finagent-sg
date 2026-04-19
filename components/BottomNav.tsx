/**
 * components/BottomNav.tsx
 *
 * Bottom navigation bar for FinAgent-SG.
 *
 * Links:
 * - Dashboard:   Overview of all clients and recent activity
 * - Clients:     Client management — add/edit entities and fiscal years
 * - History:     Past generated outputs and corrections
 * - Corrections: Review chatbot corrections before fine-tuning (Phase 5)
 * - Settings:    User account, API keys, preferences
 *
 * Phase 0: Placeholder links only — no pages exist yet.
 * Phase 5: Corrections page added — links to /corrections?schema=<schemaName>.
 * Individual pages will be built in future phases.
 */

import { Separator } from "@/components/ui/separator";

const NAV_ITEMS = [
  { label: "Dashboard", href: "/" },
  { label: "Clients", href: "/clients" },
  { label: "History", href: "/history" },
  { label: "Corrections", href: "/corrections" },
  { label: "Help", href: "/help" },
  { label: "Settings", href: "/settings" },
];

export function BottomNav() {
  return (
    <footer className="border-t bg-white">
      <Separator />
      <nav className="flex items-center flex-wrap gap-x-4 gap-y-1 sm:gap-x-6 px-4 sm:px-6 py-2 sm:py-3">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            {item.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
