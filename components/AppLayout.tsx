/**
 * components/AppLayout.tsx
 *
 * Shell layout that composes AppSidebar + AppHeader + scrollable content area.
 * Manages mobileMenuOpen state and passes it to the sidebar and header via props.
 *
 * Desktop: sidebar (220px) fixed left, header (48px) top, content fills remaining space.
 * Mobile: full-width, sidebar appears as fixed overlay when the hamburger is tapped.
 */

"use client";

import { useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";

interface AppLayoutProps {
  children: React.ReactNode;
  pageTitle: string;
  headerRight?: React.ReactNode;
}

export function AppLayout({ children, pageTitle, headerRight }: AppLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <AppSidebar
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      {/* Right column: header + content */}
      <div className="flex flex-col flex-1 min-w-0">
        <AppHeader
          pageTitle={pageTitle}
          onMenuOpen={() => setMobileMenuOpen(true)}
          headerRight={headerRight}
        />

        {/* Content area — flex-col allows flex-1 children to fill height */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
