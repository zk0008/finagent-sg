/**
 * components/AppSidebar.tsx
 *
 * Sidebar navigation component for FinAgent-SG.
 * Desktop: fixed 220px left panel, always visible.
 * Mobile: hidden by default, shown as fixed overlay when mobileOpen=true.
 * Active route detected via usePathname().
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  Receipt,
  Clock,
  CheckCircle,
  HelpCircle,
  Settings,
  X,
} from "lucide-react";

const NAV_ITEMS = [
  { label: "Dashboard",   href: "/",            Icon: LayoutDashboard },
  { label: "Clients",     href: "/clients",     Icon: Building2 },
  { label: "Receipts",    href: "/receipts",    Icon: Receipt },
  { label: "History",     href: "/history",     Icon: Clock },
  { label: "Corrections", href: "/corrections", Icon: CheckCircle },
  { label: "Help",        href: "/help",        Icon: HelpCircle },
  { label: "Settings",    href: "/settings",    Icon: Settings },
] as const;

interface AppSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function AppSidebar({ open, onClose }: AppSidebarProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  const navList = (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV_ITEMS.map(({ label, href, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onClose}
            className={`flex items-center gap-2 px-2.5 py-[7px] rounded-md text-sm transition-colors duration-150 ${
              active
                ? "bg-[#EAF1EC] text-primary font-medium"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* ── Desktop sidebar — always visible ── */}
      <aside className="hidden md:flex flex-col w-[220px] shrink-0 h-full bg-card border-r border">
        <div className="px-4 h-12 flex items-center border-b border shrink-0">
          <span className="text-base font-semibold text-foreground">FinAgent-SG</span>
        </div>
        {navList}
      </aside>

      {/* ── Mobile sidebar — fixed overlay ── */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={onClose}
          />
          {/* Panel */}
          <aside className="fixed left-0 top-0 z-50 flex flex-col w-[220px] h-full bg-card border-r border md:hidden">
            <div className="px-4 h-12 flex items-center justify-between border-b border shrink-0">
              <span className="text-base font-semibold text-foreground">FinAgent-SG</span>
              <button
                onClick={onClose}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors duration-150"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
            {navList}
          </aside>
        </>
      )}
    </>
  );
}
