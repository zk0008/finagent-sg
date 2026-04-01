/**
 * components/ModelWorkflow.tsx
 *
 * Financial model sub-workflow component for FinAgent-SG Phase 3.
 *
 * What this component does:
 * Implements the 4-step financial model workflow within the WorkflowPanel:
 *   Step 1 — Setup: auto-loads latest FS info, user sets model name + years
 *   Step 2 — Assumptions: AI suggestion + user review/adjustment
 *   Step 3 — Results: base/best/worst case tables + save
 *   Step 4 — Budget vs Actual: optional upload and variance comparison
 *
 * Design rules (enforced here):
 * - Always builds from the LATEST saved FS output. No output picker.
 * - Each run creates a NEW model. Save is explicit (user clicks Save Model).
 * - Results are tables only — no charts.
 * - BVA step only appears after the model is saved.
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectionTable, type ProjectionLineItem } from "@/components/ProjectionTable";
import { VarianceTable } from "@/components/VarianceTable";
import type { ProjectionAssumptions, ProjectedFS } from "@/lib/schemas";
import type { AssumptionRationales } from "@/lib/assumptionSuggester";
import type { BudgetVsActualItem, BVASummary } from "@/lib/budgetVsActual";

// ── Props ─────────────────────────────────────────────────────────────────────

export type ModelWorkflowProps = {
  schemaName:    string;
  companyName:   string;
  entityId:      string;
  fiscalYearId:  string | null;
  isAuditExempt: boolean;
};

// ── Internal types ────────────────────────────────────────────────────────────

type LatestFSInfo = {
  output_id:  string;
  base_year:  number;
  as_at_date: string;
  created_at: string;
};

type ScenarioResults = {
  base_case:  ProjectedFS[];
  best_case:  ProjectedFS[];
  worst_case: ProjectedFS[];
};

type RunStep = {
  key:     string;
  label:   string;
  status:  "pending" | "in_progress" | "complete" | "error";
};

const INITIAL_RUN_STEPS: RunStep[] = [
  { key: "load_base_data", label: "Loading base financial data",   status: "pending" },
  { key: "base_case",      label: "Running base case projections", status: "pending" },
  { key: "best_case",      label: "Running best case projections", status: "pending" },
  { key: "worst_case",     label: "Running worst case projections",status: "pending" },
  { key: "complete",       label: "All scenarios complete",        status: "pending" },
];

// ── Table data builders ───────────────────────────────────────────────────────

type LineItem = { label: string; amount: number };

function getLineItems(arr: unknown): LineItem[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (x): x is LineItem =>
      x != null && typeof x === "object" && "label" in x && "amount" in x
  );
}

function buildPLRows(cases: ProjectedFS[]): ProjectionLineItem[] {
  const rows: ProjectionLineItem[] = [];
  if (cases.length === 0) return rows;

  const pls = cases.map((c) => c.profit_and_loss as Record<string, unknown>);
  const year0pl = pls[0];

  // Revenue
  rows.push({ name: "Revenue", values: [], isSection: true });
  const revLines = getLineItems(year0pl.revenue_lines);
  for (const item of revLines) {
    rows.push({
      name:   item.label,
      values: pls.map((pl) => {
        const found = getLineItems(pl.revenue_lines).find((r) => r.label === item.label);
        return found?.amount ?? 0;
      }),
    });
  }
  rows.push({
    name:    "Total Revenue",
    values:  pls.map((pl) => Number(pl.total_revenue ?? 0)),
    isTotal: true,
  });

  rows.push({ name: "", values: [], isBlank: true });

  // Expenses
  rows.push({ name: "Expenses", values: [], isSection: true });
  const expLines = getLineItems(year0pl.expense_lines);
  for (const item of expLines) {
    rows.push({
      name:   item.label,
      values: pls.map((pl) => {
        const found = getLineItems(pl.expense_lines).find((r) => r.label === item.label);
        return found?.amount ?? 0;
      }),
    });
  }
  rows.push({
    name:    "Total Expenses",
    values:  pls.map((pl) => Number(pl.total_expenses ?? 0)),
    isTotal: true,
  });

  rows.push({ name: "", values: [], isBlank: true });

  rows.push({
    name:    "Net Profit / (Loss)",
    values:  pls.map((pl) => Number(pl.net_profit ?? 0)),
    isTotal: true,
  });

  return rows;
}

function buildBSRows(cases: ProjectedFS[]): ProjectionLineItem[] {
  const rows: ProjectionLineItem[] = [];
  if (cases.length === 0) return rows;

  const bss = cases.map((c) => c.balance_sheet as Record<string, unknown>);
  const bs0 = bss[0];

  function addSection(
    sectionName: string,
    lineKey: string,
    totalKey: string
  ) {
    rows.push({ name: sectionName, values: [], isSection: true });
    const items = getLineItems(bs0[lineKey]);
    for (const item of items) {
      rows.push({
        name:   item.label,
        values: bss.map((bs) => {
          const found = getLineItems(bs[lineKey]).find((r) => r.label === item.label);
          return found?.amount ?? 0;
        }),
      });
    }
    rows.push({
      name:    `Total ${sectionName}`,
      values:  bss.map((bs) => Number(bs[totalKey] ?? 0)),
      isTotal: true,
    });
    rows.push({ name: "", values: [], isBlank: true });
  }

  // Assets
  addSection("Current Assets",           "current_assets",       "total_current_assets");
  addSection("Non-Current Assets",        "non_current_assets",   "total_non_current_assets");
  rows.push({
    name:    "Total Assets",
    values:  bss.map((bs) => Number(bs.total_assets ?? 0)),
    isTotal: true,
  });

  rows.push({ name: "", values: [], isBlank: true });

  // Liabilities
  addSection("Current Liabilities",       "current_liabilities",      "total_current_liabilities");
  addSection("Non-Current Liabilities",   "non_current_liabilities",  "total_non_current_liabilities");
  rows.push({
    name:    "Total Liabilities",
    values:  bss.map((bs) => Number(bs.total_liabilities ?? 0)),
    isTotal: true,
  });

  rows.push({ name: "", values: [], isBlank: true });

  // Equity
  addSection("Equity",                    "equity",               "total_equity");
  rows.push({
    name:    "Total Liabilities & Equity",
    values:  bss.map((bs) => Number(bs.total_liabilities_and_equity ?? 0)),
    isTotal: true,
  });

  return rows;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ModelWorkflow({
  schemaName,
  companyName,
  entityId,
  fiscalYearId,
  isAuditExempt,
}: ModelWorkflowProps) {

  // ── Step 1: Setup ──────────────────────────────────────────────────────────
  const [isFetchingFS, setIsFetchingFS]   = useState(true);
  const [latestFS, setLatestFS]           = useState<LatestFSInfo | null>(null);
  const [noFS, setNoFS]                   = useState(false);
  const [modelName, setModelName]         = useState("");
  const [projectionYears, setProjectionYears] = useState(3);

  // ── Step 2: Assumptions ────────────────────────────────────────────────────
  const [isSuggesting, setIsSuggesting]   = useState(false);
  const [assumptions, setAssumptions]     = useState<ProjectionAssumptions | null>(null);
  const [rationales, setRationales]       = useState<AssumptionRationales | null>(null);
  const [suggestError, setSuggestError]   = useState<string | null>(null);
  // Editable assumption fields (strings for controlled inputs)
  const [revGrowth, setRevGrowth]         = useState("10");
  const [cogsGrowth, setCogsGrowth]       = useState("8");
  const [opexGrowth, setOpexGrowth]       = useState("5");
  const [depMethod, setDepMethod]         = useState<"straight_line" | "reducing_balance">("straight_line");
  const [taxRate, setTaxRate]             = useState("17");

  // ── Step 3: Run & Results ──────────────────────────────────────────────────
  const [isRunning, setIsRunning]         = useState(false);
  const [runSteps, setRunSteps]           = useState<RunStep[]>(INITIAL_RUN_STEPS);
  const [runError, setRunError]           = useState<string | null>(null);
  const [results, setResults]             = useState<ScenarioResults | null>(null);
  const [sourceOutputId, setSourceOutputId] = useState<string | null>(null);
  const [activeScenario, setActiveScenario] = useState<"base" | "best" | "worst">("base");

  // ── Step 4: Save ───────────────────────────────────────────────────────────
  const [isSaving, setIsSaving]           = useState(false);
  const [savedModelId, setSavedModelId]   = useState<string | null>(null);
  const [saveError, setSaveError]         = useState<string | null>(null);

  // ── Step 5: BVA ───────────────────────────────────────────────────────────
  const [bvaYear, setBvaYear]             = useState(1);
  const bvaFileRef                        = useRef<HTMLInputElement>(null);
  const [bvaFile, setBvaFile]             = useState<File | null>(null);
  const [isRunningBVA, setIsRunningBVA]   = useState(false);
  const [bvaResult, setBvaResult]         = useState<{
    bva_result: BudgetVsActualItem[];
    summary:    BVASummary;
  } | null>(null);
  const [bvaError, setBvaError]           = useState<string | null>(null);

  // ── On mount: fetch latest FS info ─────────────────────────────────────────
  useEffect(() => {
    if (!schemaName) return;
    setIsFetchingFS(true);
    fetch(`/api/model/latest-fs?schemaName=${encodeURIComponent(schemaName)}`)
      .then((r) => r.json())
      .then((data: { found: boolean } & Partial<LatestFSInfo>) => {
        if (data.found && data.output_id) {
          setLatestFS({
            output_id:  data.output_id,
            base_year:  data.base_year!,
            as_at_date: data.as_at_date!,
            created_at: data.created_at!,
          });
        } else {
          setNoFS(true);
        }
      })
      .catch(() => setNoFS(true))
      .finally(() => setIsFetchingFS(false));
  }, [schemaName]);

  // ── Suggest assumptions ────────────────────────────────────────────────────
  async function handleSuggest(): Promise<void> {
    setSuggestError(null);
    setIsSuggesting(true);
    try {
      const res = await fetch("/api/model/suggest-assumptions", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          schemaName,
          companyType:   "private_ltd",
          isAuditExempt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      const a: ProjectionAssumptions = data.assumptions;
      const r: AssumptionRationales  = data.rationales;

      setAssumptions(a);
      setRationales(r);
      // Pre-fill editable fields
      setRevGrowth(String(a.revenue_growth_pct));
      setCogsGrowth(String(a.cogs_growth_pct));
      setOpexGrowth(String(a.opex_growth_pct));
      setDepMethod(a.depreciation_method);
      setTaxRate(String(a.tax_rate_pct));
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : "Suggestion failed.");
    } finally {
      setIsSuggesting(false);
    }
  }

  // ── Run projections ────────────────────────────────────────────────────────
  async function handleRun(): Promise<void> {
    if (!latestFS) return;
    setRunError(null);
    setResults(null);
    setIsRunning(true);
    setRunSteps(INITIAL_RUN_STEPS);
    setSavedModelId(null);
    setBvaResult(null);

    const confirmedAssumptions: ProjectionAssumptions = {
      revenue_growth_pct:      parseFloat(revGrowth)  || 0,
      cogs_growth_pct:         parseFloat(cogsGrowth) || 0,
      opex_growth_pct:         parseFloat(opexGrowth) || 0,
      depreciation_method:     depMethod,
      tax_rate_pct:            parseFloat(taxRate)    || 17,
      custom_line_assumptions: assumptions?.custom_line_assumptions ?? [],
    };

    try {
      const res = await fetch("/api/model/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          schemaName,
          assumptions:      confirmedAssumptions,
          projection_years: projectionYears,
          base_year:        latestFS.base_year,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const line = rawEvent.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              step:             string;
              status:           string;
              message:          string;
              results?:         ScenarioResults;
              source_output_id?: string;
            };

            setRunSteps((prev) =>
              prev.map((s) =>
                s.key === event.step
                  ? { ...s, status: event.status as RunStep["status"] }
                  : s
              )
            );

            if (event.step === "complete" && event.status === "complete") {
              if (event.results) setResults(event.results);
              if (event.source_output_id) setSourceOutputId(event.source_output_id);
              setIsRunning(false);
            }
            if (event.status === "error") {
              setRunError(event.message);
              setIsRunning(false);
            }
          } catch {
            // ignore malformed events
          }
        }
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Run failed.");
      setIsRunning(false);
    }
  }

  // ── Save model ─────────────────────────────────────────────────────────────
  async function handleSave(): Promise<void> {
    if (!results || !sourceOutputId) return;
    setSaveError(null);
    setIsSaving(true);

    const confirmedAssumptions: ProjectionAssumptions = {
      revenue_growth_pct:      parseFloat(revGrowth)  || 0,
      cogs_growth_pct:         parseFloat(cogsGrowth) || 0,
      opex_growth_pct:         parseFloat(opexGrowth) || 0,
      depreciation_method:     depMethod,
      tax_rate_pct:            parseFloat(taxRate)    || 17,
      custom_line_assumptions: assumptions?.custom_line_assumptions ?? [],
    };

    try {
      const res = await fetch("/api/model/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          schemaName,
          entity_id:        entityId,
          fiscal_year_id:   fiscalYearId,
          source_output_id: sourceOutputId,
          model_name:       modelName.trim() || `Model — ${new Date().toLocaleDateString("en-SG")}`,
          projection_years: projectionYears,
          assumptions:      confirmedAssumptions,
          base_case:        results.base_case,
          best_case:        results.best_case,
          worst_case:       results.worst_case,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSavedModelId(data.model_id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  }

  // ── Excel download ─────────────────────────────────────────────────────────
  const [isExporting, setIsExporting] = useState(false);

  async function handleExcelDownload(): Promise<void> {
    if (!results || !latestFS) return;
    setIsExporting(true);

    const confirmedAssumptions: ProjectionAssumptions = {
      revenue_growth_pct:      parseFloat(revGrowth)  || 0,
      cogs_growth_pct:         parseFloat(cogsGrowth) || 0,
      opex_growth_pct:         parseFloat(opexGrowth) || 0,
      depreciation_method:     depMethod,
      tax_rate_pct:            parseFloat(taxRate)    || 17,
      custom_line_assumptions: assumptions?.custom_line_assumptions ?? [],
    };

    // Build rationales map from AssumptionRationales object if available
    const rationalesMap: Record<string, string> | undefined = rationales
      ? {
          revenue_growth_pct:  rationales.revenue_growth_pct,
          cogs_growth_pct:     rationales.cogs_growth_pct,
          opex_growth_pct:     rationales.opex_growth_pct,
          depreciation_method: rationales.depreciation_method,
          tax_rate_pct:        rationales.tax_rate_pct,
        }
      : undefined;

    try {
      const res = await fetch("/api/model/export-excel", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          model_name:       modelName.trim() || `Model — ${new Date().toLocaleDateString("en-SG")}`,
          base_year:        latestFS.base_year,
          projection_years: projectionYears,
          assumptions:      confirmedAssumptions,
          rationales:       rationalesMap,
          base_case:        results.base_case,
          best_case:        results.best_case,
          worst_case:       results.worst_case,
          bva:              bvaResult
            ? { year: bvaYear, bva_result: bvaResult.bva_result, summary: bvaResult.summary }
            : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const a        = document.createElement("a");
      const safeName = (modelName.trim() || "model").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
      a.href         = url;
      a.download     = `financial-model-${safeName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      // Surface error in the save error state (same area of the UI)
      setSaveError(`Excel export failed: ${(err as Error).message}`);
    } finally {
      setIsExporting(false);
    }
  }

  // ── BVA upload ─────────────────────────────────────────────────────────────
  async function handleBVAUpload(): Promise<void> {
    if (!bvaFile || !savedModelId) return;
    setBvaError(null);
    setIsRunningBVA(true);
    setBvaResult(null);

    try {
      const fileBuffer = await bvaFile.arrayBuffer();
      const base64     = Buffer.from(fileBuffer).toString("base64");

      const res = await fetch("/api/model/upload-actuals", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          schemaName,
          model_id:  savedModelId,
          year:      bvaYear,
          file_data: base64,
          file_name: bvaFile.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBvaResult(data);
    } catch (err) {
      setBvaError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsRunningBVA(false);
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────
  const canSuggest  = !noFS && !isFetchingFS && !isSuggesting;
  const canRun      = assumptions !== null && !isRunning;
  const canSave     = results !== null && !isSaving && !savedModelId;
  const hasResults  = results !== null;

  const activeCase  =
    activeScenario === "best"  ? results?.best_case  :
    activeScenario === "worst" ? results?.worst_case :
    results?.base_case;

  const projYears   = activeCase?.map((pfs) => latestFS!.base_year + pfs.year) ?? [];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ── "No FS" warning ── */}
      {noFS && !isFetchingFS && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-800 font-medium">
            No financial statements found.
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            Generate Financial Statements first before building a model.
          </p>
        </div>
      )}

      {/* ── STEP 1: Projection Setup ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Step 1 — Projection Setup
            {latestFS && <Badge variant="outline" className="text-xs text-green-600 border-green-200">Base data loaded</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Base data display */}
          <div className="rounded-md bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">Base Data</p>
            {isFetchingFS ? (
              <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
            ) : latestFS ? (
              <p className="text-sm font-medium">
                FY{latestFS.base_year} — {companyName || "Company"}
                <span className="text-xs text-muted-foreground ml-2">
                  (as at {latestFS.as_at_date})
                </span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No FS output found</p>
            )}
          </div>

          {/* Model name */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Model Name</Label>
            <Input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={`FY${latestFS?.base_year ?? "2025"} — ${companyName || "Model"}`}
              className="text-sm"
              disabled={noFS}
            />
          </div>

          {/* Projection years */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Projection Years</Label>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((y) => (
                <Button
                  key={y}
                  variant={projectionYears === y ? "default" : "outline"}
                  size="sm"
                  className="w-9 px-0 text-xs"
                  onClick={() => setProjectionYears(y)}
                  disabled={noFS}
                >
                  {y}
                </Button>
              ))}
            </div>
          </div>

          <Button
            className="w-full"
            onClick={handleSuggest}
            disabled={!canSuggest || noFS}
          >
            {isSuggesting ? "Getting AI suggestions…" : "Suggest Assumptions ▶"}
          </Button>

          {suggestError && (
            <p className="text-xs text-destructive">{suggestError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── STEP 2: Review & Adjust Assumptions ── */}
      {assumptions && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">
              Step 2 — Review &amp; Adjust Assumptions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">

            <AssumptionField
              label="Revenue Growth"
              value={revGrowth}
              onChange={setRevGrowth}
              rationale={rationales?.revenue_growth_pct}
              unit="%"
            />
            <AssumptionField
              label="COGS Growth"
              value={cogsGrowth}
              onChange={setCogsGrowth}
              rationale={rationales?.cogs_growth_pct}
              unit="%"
            />
            <AssumptionField
              label="OpEx Growth"
              value={opexGrowth}
              onChange={setOpexGrowth}
              rationale={rationales?.opex_growth_pct}
              unit="%"
            />

            {/* Depreciation method */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Depreciation Method</Label>
              <Select
                value={depMethod}
                onValueChange={(v) => setDepMethod(v as typeof depMethod)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="straight_line">Straight-line</SelectItem>
                  <SelectItem value="reducing_balance">Reducing Balance</SelectItem>
                </SelectContent>
              </Select>
              {rationales?.depreciation_method && (
                <p className="text-xs text-muted-foreground">{rationales.depreciation_method}</p>
              )}
            </div>

            <AssumptionField
              label="Tax Rate"
              value={taxRate}
              onChange={setTaxRate}
              rationale={rationales?.tax_rate_pct}
              unit="%"
            />

            <Separator />

            <Button
              className="w-full"
              onClick={handleRun}
              disabled={!canRun}
            >
              {isRunning ? "Running projections…" : "Run Projections ▶"}
            </Button>

            {/* Run progress */}
            {isRunning && (
              <div className="space-y-1">
                {runSteps.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5 text-xs">
                    <span className={
                      s.status === "complete"   ? "text-green-500" :
                      s.status === "in_progress" ? "text-blue-500 animate-pulse" :
                      s.status === "error"       ? "text-destructive" :
                      "text-muted-foreground/40"
                    }>
                      {s.status === "complete" ? "✓" : s.status === "in_progress" ? "◐" : s.status === "error" ? "✗" : "○"}
                    </span>
                    <span className={s.status === "pending" ? "text-muted-foreground" : "text-foreground"}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {runError && <p className="text-xs text-destructive">{runError}</p>}
          </CardContent>
        </Card>
      )}

      {/* ── STEP 3: Results ── */}
      {hasResults && activeCase && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Step 3 — Projection Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Scenario tabs */}
            <Tabs value={activeScenario} onValueChange={(v) => setActiveScenario(v as typeof activeScenario)}>
              <TabsList className="grid grid-cols-3 w-full">
                <TabsTrigger value="base"  className="text-xs">Base Case</TabsTrigger>
                <TabsTrigger value="best"  className="text-xs">Best Case</TabsTrigger>
                <TabsTrigger value="worst" className="text-xs">Worst Case</TabsTrigger>
              </TabsList>

              {(["base", "best", "worst"] as const).map((scenario) => {
                const caseData =
                  scenario === "best"  ? results!.best_case  :
                  scenario === "worst" ? results!.worst_case :
                  results!.base_case;
                const caseYears = caseData.map((pfs) => latestFS!.base_year + pfs.year);

                return (
                  <TabsContent key={scenario} value={scenario} className="space-y-4 mt-3">
                    <ProjectionTable
                      title="Projected Profit & Loss"
                      years={caseYears}
                      lineItems={buildPLRows(caseData)}
                    />
                    <ProjectionTable
                      title="Projected Balance Sheet"
                      years={caseYears}
                      lineItems={buildBSRows(caseData)}
                    />
                  </TabsContent>
                );
              })}
            </Tabs>

            <Separator />

            {/* Save + Download buttons */}
            <div className="flex gap-2">
              {!savedModelId ? (
                <Button
                  className="flex-1"
                  onClick={handleSave}
                  disabled={!canSave}
                  variant="default"
                >
                  {isSaving ? "Saving…" : "Save Model"}
                </Button>
              ) : (
                <div className="flex-1 rounded-md border border-green-200 bg-green-50 px-3 py-2">
                  <p className="text-xs text-green-700 font-medium">
                    ✓ Model saved — ID: {savedModelId.slice(0, 8)}…
                  </p>
                </div>
              )}
              <Button
                variant="outline"
                onClick={handleExcelDownload}
                disabled={!results || isExporting}
                className="shrink-0"
              >
                {isExporting ? "Exporting…" : "Download Excel"}
              </Button>
            </div>
            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
          </CardContent>
        </Card>
      )}

      {/* ── STEP 4: Budget vs Actual (only after save) ── */}
      {savedModelId && results && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Step 4 — Budget vs Actual</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">

            <p className="text-xs text-muted-foreground">
              Upload an actual trial balance to compare against any projected year.
            </p>

            <div className="flex gap-3 items-end">
              {/* Year selector */}
              <div className="space-y-1 w-36">
                <Label className="text-xs text-muted-foreground">Compare against</Label>
                <Select
                  value={String(bvaYear)}
                  onValueChange={(v) => { if (v != null) setBvaYear(parseInt(v, 10)); }}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {results.base_case.map((pfs) => (
                      <SelectItem key={pfs.year} value={String(pfs.year)}>
                        Year {pfs.year} (FY{latestFS!.base_year + pfs.year})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* File upload */}
              <div className="flex-1">
                <input
                  ref={bvaFileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => setBvaFile(e.target.files?.[0] ?? null)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => bvaFileRef.current?.click()}
                >
                  {bvaFile ? bvaFile.name : "Upload Actual TB (.xlsx)"}
                </Button>
              </div>

              <Button
                size="sm"
                onClick={handleBVAUpload}
                disabled={!bvaFile || isRunningBVA}
                className="shrink-0"
              >
                {isRunningBVA ? "Comparing…" : "Compare ▶"}
              </Button>
            </div>

            {bvaError && <p className="text-xs text-destructive">{bvaError}</p>}

            {bvaResult && (
              <div className="mt-2">
                <VarianceTable
                  items={bvaResult.bva_result}
                  summary={bvaResult.summary}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── AssumptionField sub-component ─────────────────────────────────────────────

function AssumptionField({
  label,
  value,
  onChange,
  rationale,
  unit,
}: {
  label:      string;
  value:      string;
  onChange:   (v: string) => void;
  rationale?: string;
  unit?:      string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-sm w-24"
          step="0.5"
        />
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      {rationale && (
        <p className="text-xs text-muted-foreground italic">{rationale}</p>
      )}
    </div>
  );
}
