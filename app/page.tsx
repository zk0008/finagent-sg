/**
 * app/page.tsx
 *
 * Client dashboard — the home page after login.
 *
 * Fetches GET /api/dashboard on mount to resolve the user's company and load
 * compliance deadlines, recent activity, and key metrics in a single request.
 *
 * States:
 *   loading  — skeleton placeholders while the API call is in flight
 *   no company — welcome card directing the user to /clients to set up
 *   company found — full dashboard: company info, deadlines, overview, quick actions
 */

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  FileText,
  Users,
  Calculator,
  TrendingUp,
  UserPlus,
  Building2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

type CPFStatus      = "upcoming" | "overdue" | "completed";
type DeadlineStatus = "upcoming" | "overdue";

type DeadlineItem = { label: string; date: string; status: DeadlineStatus };
type CPFDeadlineItem = { label: string; date: string; status: CPFStatus };

type DashboardData = {
  company: { name: string; uen: string; schema_name: string; fye_date: string } | null;
  fiscalYear: { start_date: string; end_date: string; status: string } | null;
  deadlines: {
    cpf:    CPFDeadlineItem;
    eci:    DeadlineItem;
    formCS: DeadlineItem;
    acra:   DeadlineItem;
  } | null;
  latestFS:      { id: string; created_at: string; fiscal_year_id: string } | null;
  latestPayroll: { id: string; run_month: string; status: string; created_at: string } | null;
  latestTax:     { id: string; year_of_assessment: number; form_type: string; tax_payable: number; created_at: string } | null;
  activeModel:   { id: string; model_name: string; projection_years: number } | null;
  employeeCount: number;
};

// ── Date helpers ─────────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// "2025-12-31" → "31 Dec 2025"
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// "2025-12-01" → "Dec 2025"
function formatMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DeadlineBadge({ status }: { status: CPFStatus | DeadlineStatus }) {
  const styles: Record<string, string> = {
    upcoming:  "bg-[#FBF3DE] text-[#B5841A]",
    overdue:   "bg-[#F8EDEC] text-[#9B3A3A]",
    completed: "bg-[#EAF1EC] text-[#3D6B52]",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? styles.upcoming}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function FYStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const styles =
    s === "final" || s === "closed"
      ? "bg-[#EAF1EC] text-[#3D6B52]"
      : s === "draft"
      ? "bg-[#FBF3DE] text-[#B5841A]"
      : "bg-[#EFECE6] text-[#6B6560]";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function SummaryCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-2">
        <div className="h-5 w-48 bg-secondary animate-pulse rounded-md" />
        <div className="h-4 w-32 bg-secondary animate-pulse rounded-md" />
      </div>
      <div className="space-y-3">
        <div className="h-5 w-44 bg-secondary animate-pulse rounded-md" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0,1,2,3].map((i) => (
            <div key={i} className="h-24 bg-secondary animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-5 w-24 bg-secondary animate-pulse rounded-md" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0,1,2,3,4].map((i) => (
            <div key={i} className="h-24 bg-secondary animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router                = useRouter();
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((json: DashboardData) => setData(json))
      .catch(() => setData({ company: null, fiscalYear: null, deadlines: null, latestFS: null, latestPayroll: null, latestTax: null, activeModel: null, employeeCount: 0 }))
      .finally(() => setLoading(false));
  }, []);

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <AppLayout pageTitle="Dashboard">
        <LoadingSkeleton />
      </AppLayout>
    );
  }

  // ── No company — pre-onboarding welcome ─────────────────────────────────────
  if (!data?.company) {
    return (
      <AppLayout pageTitle="Dashboard">
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="bg-card border border-border rounded-lg p-8 text-center max-w-sm w-full">
            <Building2 className="w-8 h-8 text-muted-foreground mx-auto mb-4" strokeWidth={1.5} />
            <h2 className="text-lg font-semibold text-foreground mb-2">Welcome to FinAgent-SG</h2>
            <p className="text-sm text-muted-foreground mb-6">Set up your company to get started</p>
            <Link
              href="/clients"
              className={buttonVariants({ className: "w-full justify-center cursor-pointer" })}
            >
              Set up company
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  const { company, fiscalYear, deadlines, latestFS, latestPayroll, latestTax, activeModel, employeeCount } = data;

  // Flatten deadlines into an ordered array for the grid
  const deadlineItems = deadlines
    ? [deadlines.cpf, deadlines.eci, deadlines.formCS, deadlines.acra]
    : [];

  return (
    <AppLayout pageTitle="Dashboard">
      <div className="p-6 space-y-6">

        {/* ── TOP BAR — Company info ──────────────────────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">{company.name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{company.uen}</p>
          </div>
          {fiscalYear && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {formatDate(fiscalYear.start_date)} — {formatDate(fiscalYear.end_date)}
              </span>
              <FYStatusBadge status={fiscalYear.status} />
            </div>
          )}
        </div>

        {/* ── COMPLIANCE DEADLINES ────────────────────────────────────────────── */}
        {deadlineItems.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">Compliance Deadlines</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {deadlineItems.map((item) => (
                <div key={item.label} className="bg-card border border-border rounded-lg p-4">
                  <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
                  <p className="text-sm font-medium text-foreground mt-1">{formatDate(item.date)}</p>
                  <div className="mt-2">
                    <DeadlineBadge status={item.status} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── OVERVIEW ────────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">Overview</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* Financial Statements */}
            <SummaryCard icon={FileText} title="Financial Statements">
              {latestFS ? (
                <>
                  <p className="text-sm font-medium text-foreground">{formatDate(latestFS.created_at.slice(0, 10))}</p>
                  <p className="text-xs text-muted-foreground mt-1">Last generated</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">No statements generated</p>
                  <p className="text-xs text-muted-foreground mt-1">Upload a trial balance to get started</p>
                </>
              )}
            </SummaryCard>

            {/* Payroll */}
            <SummaryCard icon={Users} title="Payroll">
              {latestPayroll ? (
                <>
                  <p className="text-sm font-medium text-foreground">{formatMonth(latestPayroll.run_month)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Status: {latestPayroll.status}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">No payroll runs</p>
                  <p className="text-xs text-muted-foreground mt-1">Run payroll via the Workflows page</p>
                </>
              )}
            </SummaryCard>

            {/* Corporate Tax */}
            <SummaryCard icon={Calculator} title="Corporate Tax">
              {latestTax ? (
                <>
                  <p className="text-sm font-medium text-foreground font-mono">
                    SGD {latestTax.tax_payable.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    YA {latestTax.year_of_assessment} · {latestTax.form_type}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">No tax computations</p>
                  <p className="text-xs text-muted-foreground mt-1">Complete your financial statements first</p>
                </>
              )}
            </SummaryCard>

            {/* Financial Model */}
            <SummaryCard icon={TrendingUp} title="Financial Model">
              {activeModel ? (
                <>
                  <p className="text-sm font-medium text-foreground">{activeModel.model_name}</p>
                  <p className="text-xs text-muted-foreground mt-1">{activeModel.projection_years}-year projection</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">No active model</p>
                  <p className="text-xs text-muted-foreground mt-1">Build a model via the Workflows page</p>
                </>
              )}
            </SummaryCard>

            {/* Employees */}
            <SummaryCard icon={UserPlus} title="Employees">
              <p className="text-sm font-medium text-foreground font-mono">{employeeCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Registered employees</p>
            </SummaryCard>

          </div>
        </section>

        {/* ── QUICK ACTIONS ───────────────────────────────────────────────────── */}
        <section className="flex flex-wrap items-center gap-4">
          <Button onClick={() => router.push("/workflows")} className="cursor-pointer">
            Run Workflow
          </Button>
          {!latestFS && (
            <p className="text-sm text-muted-foreground">
              Upload a trial balance to generate financial statements
            </p>
          )}
        </section>

      </div>
    </AppLayout>
  );
}
