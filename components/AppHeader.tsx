/**
 * components/AppHeader.tsx
 *
 * Shared top header bar for all app pages (replaces inline <header> blocks).
 * Height: 48px, bg-card, border-b.
 * Desktop: page title + optional right-side content.
 * Mobile: hamburger toggle (left) + page title + optional right-side content.
 */

"use client";

import { Menu } from "lucide-react";

interface AppHeaderProps {
  pageTitle: string;
  onMenuOpen: () => void;
  headerRight?: React.ReactNode;
}

export function AppHeader({ pageTitle, onMenuOpen, headerRight }: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between h-12 px-4 md:px-6 border-b bg-card shrink-0">
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <button
          className="md:hidden p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors duration-150"
          onClick={onMenuOpen}
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" strokeWidth={1.5} />
        </button>
        <h1 className="text-sm font-semibold text-foreground">{pageTitle}</h1>
      </div>

      {headerRight && (
        <div className="flex items-center gap-3">{headerRight}</div>
      )}
    </header>
  );
}
