/**
 * components/TaxWorkflow.tsx
 *
 * Corporate Tax Computation workflow UI — Phase 7.
 *
 * What this component does:
 * Renders a 3-step corporate tax workflow:
 *
 *   Step 1 — Setup
 *     Displays company name, FYE date, computed Year of Assessment.
 *     Auto-loads latest FS output metadata from GET /api/model/latest-fs.
 *     User enters accounting profit and revenue (pre-populated from FS if found).
 *     Exemption scheme toggle (new startup vs partial).
 *     Checkbox for local employee CPF contributions (CIT Rebate Cash Grant eligibility).
 *
 *   Step 2 — Tax Adjustments
 *     Table of adjustments: Description, Type (Add Back / Deduct), Amount.
 *     Pre-populated with 3 common SG tax adjustments.
 *     User can add rows, edit, or delete.
 *     [Compute Tax] button POSTs to /api/tax/compute.
 *
 *   Step 3 — Results
 *     Full tax computation summary table with all line items.
 *     Filing deadline cards.
 *     [Download PDF] button POSTs to /api/tax/pdf.
 *     [Save] confirmation (computation_id displayed when saved).
 *
 * Props:
 *   schemaName     — Supabase schema name (from generateSchemaName)
 *   companyName    — Company display name
 *   entityId       — Entity UUID
 *   fiscalYearId   — Fiscal year UUID
 *   uen            — Company UEN
 *   fyeDate        — Financial year end date (YYYY-MM-DD)
 */

"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { TaxComputationResult } from "@/lib/schemas";

// ── Types ─────────────────────────────────────────────────────────────────────

type AdjustmentType = "add_back" | "deduct";

interface TaxAdjustmentRow {
  id: string;          // local key for React list rendering
  description: string;
  amount: string;
  type: AdjustmentType;
}

// Props
interface TaxWorkflowProps {
  schemaName: string;
  companyName: string;
  entityId: string;
  fiscalYearId: string;
  uen: string;
  fyeDate: string;     // YYYY-MM-DD
}

// Latest FS metadata returned by GET /api/model/latest-fs
interface LatestFSMeta {
  found: boolean;
  output_id?: string;
  base_year?: number;
  as_at_date?: string;
  created_at?: string;
}

// Default pre-populated adjustments (common SG CIT add-backs / deductions)
const DEFAULT_ADJUSTMENTS: Omit<TaxAdjustmentRow, "id">[] = [
  { description: "Private motor vehicle expenses",  amount: "0", type: "add_back" },
  { description: "Non-approved donations",           amount: "0", type: "add_back" },
  { description: "Singapore dividend income",        amount: "0", type: "deduct"   },
];

// Generate a simple unique id for list keys
let _rowCounter = 0;
function nextId(): string {
  return `row_${++_rowCounter}_${Date.now()}`;
}

function initDefaultRows(): TaxAdjustmentRow[] {
  return DEFAULT_ADJUSTMENTS.map((r) => ({ ...r, id: nextId() }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaxWorkflow({
  schemaName,
  companyName,
  entityId,
  fiscalYearId,
  uen,
  fyeDate,
}: TaxWorkflowProps) {
  // Step: 1 = Setup, 2 = Adjustments, 3 = Results
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // ── Step 1 state ──────────────────────────────────────────────────────────
  const [fsMeta, setFsMeta] = useState<LatestFSMeta | null>(null);
  const [fsMetaLoading, setFsMetaLoading] = useState(false);

  // Accounting inputs
  const [accountingProfit, setAccountingProfit] = useState("");
  const [revenue, setRevenue] = useState("");
  const [isNewStartup, setIsNewStartup] = useState(false);
  const [isLocalEmployeeCpf, setIsLocalEmployeeCpf] = useState(false);

  // ── Step 2 state ──────────────────────────────────────────────────────────
  const [adjustments, setAdjustments] = useState<TaxAdjustmentRow[]>(initDefaultRows);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);

  // ── Step 3 state ──────────────────────────────────────────────────────────
  const [taxResult, setTaxResult] = useState<TaxComputationResult | null>(null);
  const [computationId, setComputationId] = useState<string | null>(null);
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────
  // Year of Assessment = FYE year + 1
  const fyeYear = fyeDate ? parseInt(fyeDate.slice(0, 4), 10) : new Date().getFullYear();
  const yearOfAssessment = fyeYear + 1;

  // Fiscal year start = first day of the same year as FYE (approximation)
  const fiscalYearStart = fyeDate ? `${fyeDate.slice(0, 4)}-01-01` : "";

  // Auto-detect form type from revenue for display in Setup
  function getFormTypeLabel(rev: string): string {
    const n = parseFloat(rev) || 0;
    if (n <= 200000)   return "Form C-S Lite (revenue \u2264 $200K)";
    if (n <= 5000000)  return "Form C-S (revenue \u2264 $5M)";
    return "Form C (revenue > $5M)";
  }

  // ── Load latest FS metadata on mount ─────────────────────────────────────
  useEffect(() => {
    if (!schemaName) return;
    setFsMetaLoading(true);
    fetch(`/api/model/latest-fs?schemaName=${encodeURIComponent(schemaName)}`)
      .then((r) => r.json())
      .then((data: LatestFSMeta) => {
        setFsMeta(data);
        // If FS found, we could pre-populate fields — but structured_data is not
        // returned by this route. Show a hint to the user to enter values manually.
      })
      .catch(() => { /* non-fatal — user can enter values manually */ })
      .finally(() => setFsMetaLoading(false));
  }, [schemaName]);

  // ── Step 1: validate before proceeding ───────────────────────────────────
  function canProceedToStep2(): boolean {
    const profit = parseFloat(accountingProfit);
    const rev    = parseFloat(revenue);
    return (
      !isNaN(profit) &&
      !isNaN(rev) && rev >= 0 &&
      accountingProfit.trim() !== "" &&
      revenue.trim() !== ""
    );
  }

  // ── Step 2: adjustment row operations ────────────────────────────────────
  function handleAddRow(): void {
    setAdjustments((prev) => [
      ...prev,
      { id: nextId(), description: "", amount: "0", type: "add_back" },
    ]);
  }

  function handleDeleteRow(id: string): void {
    setAdjustments((prev) => prev.filter((r) => r.id !== id));
  }

  function handleRowChange(
    id: string,
    field: keyof Omit<TaxAdjustmentRow, "id">,
    value: string
  ): void {
    setAdjustments((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    );
  }

  // ── Compute Tax ───────────────────────────────────────────────────────────
  async function handleComputeTax(): Promise<void> {
    setComputeError(null);
    setComputing(true);

    const payload = {
      schemaName,
      fiscal_year_end: fyeDate,
      entity_id:             entityId,
      fiscal_year_id:        fiscalYearId,
      accounting_profit:     accountingProfit,
      revenue:               revenue,
      is_new_startup:        isNewStartup,
      is_local_employee_cpf: isLocalEmployeeCpf,
      tax_adjustments: adjustments
        .filter((r) => r.description.trim() !== "")
        .map(({ description, amount, type }) => ({ description, amount, type })),
    };

    try {
      const res = await fetch("/api/tax/compute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { result?: TaxComputationResult; computation_id?: string | null; error?: string };

      if (!res.ok || data.error) {
        setComputeError(data.error ?? `HTTP ${res.status}`);
        setComputing(false);
        return;
      }

      setTaxResult(data.result ?? null);
      setComputationId(data.computation_id ?? null);
      setStep(3);
    } catch (err) {
      setComputeError(`Compute failed: ${(err as Error).message}`);
    } finally {
      setComputing(false);
    }
  }

  // ── Download PDF ──────────────────────────────────────────────────────────
  async function handleDownloadPDF(): Promise<void> {
    if (!taxResult) return;
    setPdfError(null);
    setPdfDownloading(true);

    const payload = {
      schemaName,
      result: taxResult,
      entity: {
        name:               companyName,
        uen:                uen,
        fye_date:           fyeDate,
        fiscal_year_start:  fiscalYearStart,
      },
    };

    try {
      const res = await fetch("/api/tax/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `tax-computation-YA${taxResult.year_of_assessment}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setPdfError(`PDF download failed: ${(err as Error).message}`);
    } finally {
      setPdfDownloading(false);
    }
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function fmtSGD(val: string): string {
    const n = parseFloat(val);
    if (isNaN(n)) return "0.00";
    return n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Step indicator ── */}
      <div className="flex items-center gap-2">
        {([1, 2, 3] as const).map((s) => (
          <div key={s} className="flex items-center gap-1">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                step === s
                  ? "bg-primary text-primary-foreground"
                  : step > s
                  ? "bg-green-500 text-white"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {step > s ? "✓" : s}
            </span>
            <span className="text-xs text-muted-foreground">
              {s === 1 ? "Setup" : s === 2 ? "Adjustments" : "Results"}
            </span>
            {s < 3 && <span className="text-muted-foreground/40 mx-1">›</span>}
          </div>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════ */}
      {/* STEP 1 — Setup                                              */}
      {/* ════════════════════════════════════════════════════════════ */}
      {step === 1 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Step 1 — Tax Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Company info row */}
            <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Company</span>
                <span className="text-xs">{companyName || "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">UEN</span>
                <span className="text-xs font-mono">{uen || "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Financial Year End</span>
                <span className="text-xs">{fyeDate || "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Year of Assessment</span>
                <Badge variant="outline" className="text-xs">YA {yearOfAssessment}</Badge>
              </div>
              {fsMeta?.found && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Latest FS</span>
                  <span className="text-xs text-green-600">
                    Found (FYE {fsMeta.as_at_date}) — enter profit &amp; revenue below
                  </span>
                </div>
              )}
              {fsMetaLoading && (
                <p className="text-xs text-muted-foreground animate-pulse">Loading FS data...</p>
              )}
              {fsMeta && !fsMeta.found && !fsMetaLoading && (
                <p className="text-xs text-muted-foreground">No saved FS found — enter values manually</p>
              )}
            </div>

            <Separator />

            {/* Accounting profit */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Accounting Profit (SGD)
                <span className="ml-1 text-muted-foreground/60">— net profit per financial statements</span>
              </Label>
              <Input
                type="number"
                value={accountingProfit}
                onChange={(e) => setAccountingProfit(e.target.value)}
                placeholder="e.g. 250000"
                className="text-sm font-mono"
              />
            </div>

            {/* Revenue */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Annual Revenue (SGD)
                <span className="ml-1 text-muted-foreground/60">— determines filing form type</span>
              </Label>
              <Input
                type="number"
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                placeholder="e.g. 800000"
                className="text-sm font-mono"
              />
              {revenue && !isNaN(parseFloat(revenue)) && (
                <p className="text-xs text-muted-foreground mt-1">
                  Filing form: <span className="font-medium">{getFormTypeLabel(revenue)}</span>
                </p>
              )}
            </div>

            <Separator />

            {/* Exemption scheme */}
            <div className="space-y-2">
              <Label className="text-xs font-medium">Tax Exemption Scheme</Label>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="exemption"
                    checked={isNewStartup}
                    onChange={() => setIsNewStartup(true)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm">New Start-Up Company Exemption</p>
                    <p className="text-xs text-muted-foreground">
                      First 3 YAs — 75% on first $100K, 50% on next $100K
                    </p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="exemption"
                    checked={!isNewStartup}
                    onChange={() => setIsNewStartup(false)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm">Partial Tax Exemption</p>
                    <p className="text-xs text-muted-foreground">
                      All other companies — 75% on first $10K, 50% on next $190K
                    </p>
                  </div>
                </label>
              </div>
            </div>

            <Separator />

            {/* Local employee CPF */}
            <div className="space-y-1">
              <Label className="text-xs font-medium">YA 2026 CIT Rebate Cash Grant</Label>
              <label className="flex items-start gap-2 cursor-pointer mt-1">
                <input
                  type="checkbox"
                  checked={isLocalEmployeeCpf}
                  onChange={(e) => setIsLocalEmployeeCpf(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <div>
                  <p className="text-sm">
                    Company made CPF contributions for at least one local employee in 2025
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Tick to claim the $1,500 CIT Rebate Cash Grant (YA 2026). Total rebate benefit capped at $30,000.
                  </p>
                </div>
              </label>
            </div>

            <Button
              className="w-full"
              disabled={!canProceedToStep2()}
              onClick={() => setStep(2)}
            >
              Next: Tax Adjustments ›
            </Button>

          </CardContent>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════ */}
      {/* STEP 2 — Tax Adjustments                                   */}
      {/* ════════════════════════════════════════════════════════════ */}
      {step === 2 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Step 2 — Tax Adjustments</CardTitle>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setStep(1)}>
                ‹ Back
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            <p className="text-xs text-muted-foreground">
              Enter adjustments to accounting profit. Leave amount as 0 to exclude a row.
              Add-backs increase chargeable income; deductions reduce it.
            </p>

            {/* Adjustments table */}
            <div className="space-y-2">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_100px_90px_36px] gap-2 items-center">
                <span className="text-xs font-medium text-muted-foreground">Description</span>
                <span className="text-xs font-medium text-muted-foreground">Amount (SGD)</span>
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <span />
              </div>

              {adjustments.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_100px_90px_36px] gap-2 items-center">
                  <Input
                    value={row.description}
                    onChange={(e) => handleRowChange(row.id, "description", e.target.value)}
                    placeholder="Description"
                    className="text-xs h-8"
                  />
                  <Input
                    type="number"
                    value={row.amount}
                    onChange={(e) => handleRowChange(row.id, "amount", e.target.value)}
                    className="text-xs h-8 font-mono"
                    min="0"
                  />
                  <select
                    value={row.type}
                    onChange={(e) => handleRowChange(row.id, "type", e.target.value as AdjustmentType)}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    <option value="add_back">Add Back</option>
                    <option value="deduct">Deduct</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteRow(row.id)}
                    title="Remove row"
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>

            <Button variant="outline" size="sm" className="w-full text-xs" onClick={handleAddRow}>
              + Add Row
            </Button>

            <Separator />

            {/* Summary of what will be computed */}
            <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1">
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Accounting profit</span>
                <span className="text-xs font-mono">${fmtSGD(accountingProfit)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Revenue</span>
                <span className="text-xs font-mono">${fmtSGD(revenue)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Exemption scheme</span>
                <span className="text-xs">{isNewStartup ? "New Start-Up" : "Partial"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">CIT Cash Grant</span>
                <span className="text-xs">{isLocalEmployeeCpf ? "Eligible ($1,500)" : "Not eligible"}</span>
              </div>
            </div>

            {computeError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
                <p className="text-xs text-destructive">{computeError}</p>
              </div>
            )}

            <Button
              className="w-full"
              disabled={computing}
              onClick={handleComputeTax}
            >
              {computing ? "Computing..." : "Compute Tax \u25B6"}
            </Button>

          </CardContent>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════ */}
      {/* STEP 3 — Results                                            */}
      {/* ════════════════════════════════════════════════════════════ */}
      {step === 3 && taxResult && (
        <div className="space-y-4">

          {/* Header card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">
                  Tax Computation — YA {taxResult.year_of_assessment}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {taxResult.form_type.replace("_", " ")}
                  </Badge>
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => setStep(2)}>
                    ‹ Back
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {companyName} — Basis period: {fiscalYearStart} to {fyeDate}
              </p>
              {computationId && (
                <p className="text-xs text-green-600 mt-1">
                  Saved to database (ID: {computationId.slice(0, 8)}...)
                </p>
              )}
            </CardContent>
          </Card>

          {/* Tax computation schedule */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Tax Computation Schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-xs">
                <tbody>
                  <tr>
                    <td className="py-1 text-muted-foreground">Accounting profit per financial statements</td>
                    <td className="py-1 text-right font-mono">${fmtSGD(taxResult.accounting_profit)}</td>
                  </tr>
                  {parseFloat(taxResult.total_add_backs) > 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground pl-3">Add: Non-deductible expenses</td>
                      <td className="py-1 text-right font-mono">${fmtSGD(taxResult.total_add_backs)}</td>
                    </tr>
                  )}
                  {parseFloat(taxResult.total_deductions) > 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground pl-3">Less: Non-taxable income</td>
                      <td className="py-1 text-right font-mono">({fmtSGD(taxResult.total_deductions)})</td>
                    </tr>
                  )}
                  <tr className="border-t border-border">
                    <td className="py-1 font-medium">Chargeable Income</td>
                    <td className="py-1 text-right font-mono font-medium">${fmtSGD(taxResult.chargeable_income)}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Tax exemption */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Tax Exemption</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                {taxResult.exemption_scheme === "new_startup"
                  ? "New Start-Up Company Exemption — 75% on first $100,000 + 50% on next $100,000"
                  : "Partial Tax Exemption — 75% on first $10,000 + 50% on next $190,000"}
              </p>
              <table className="w-full text-xs">
                <tbody>
                  <tr>
                    <td className="py-1 text-muted-foreground">Chargeable Income</td>
                    <td className="py-1 text-right font-mono">${fmtSGD(taxResult.chargeable_income)}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-muted-foreground">Less: Tax Exemption</td>
                    <td className="py-1 text-right font-mono">({fmtSGD(taxResult.exempt_amount)})</td>
                  </tr>
                  <tr className="border-t border-border">
                    <td className="py-1 font-medium">Taxable Income after Exemption</td>
                    <td className="py-1 text-right font-mono font-medium">${fmtSGD(taxResult.taxable_income)}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Tax calculation */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Tax Calculation</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-xs">
                <tbody>
                  <tr>
                    <td className="py-1 text-muted-foreground">Gross Tax at 17%</td>
                    <td className="py-1 text-right font-mono">${fmtSGD(taxResult.gross_tax)}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-muted-foreground">
                      Less: CIT Rebate YA {taxResult.year_of_assessment} (40%, max $30,000)
                    </td>
                    <td className="py-1 text-right font-mono text-green-700">
                      ({fmtSGD(taxResult.cit_rebate)})
                    </td>
                  </tr>
                  {parseFloat(taxResult.cit_rebate_cash_grant) > 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground">
                        Less: CIT Rebate Cash Grant ($1,500)
                      </td>
                      <td className="py-1 text-right font-mono text-green-700">
                        ({fmtSGD(taxResult.cit_rebate_cash_grant)})
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-border">
                    <td className="py-1 font-semibold text-sm">Net Tax Payable</td>
                    <td className="py-1 text-right font-mono font-semibold text-sm">
                      ${fmtSGD(taxResult.tax_payable)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Filing deadlines */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Filing Deadlines</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">ECI Filing</span>
                {taxResult.eci_filing_required ? (
                  <span className="text-xs font-medium">{taxResult.eci_deadline}</span>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    Exempt (revenue &le; $5M &amp; ECI nil)
                  </Badge>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Form {taxResult.form_type.replace("_", " ")} Filing
                </span>
                <span className="text-xs font-medium">{taxResult.form_filing_deadline}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                File via mytax.iras.gov.sg using CorpPass.
              </p>
            </CardContent>
          </Card>

          {/* Action buttons */}
          <Card>
            <CardContent className="pt-4 space-y-2">
              {pdfError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
                  <p className="text-xs text-destructive">{pdfError}</p>
                </div>
              )}
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pdfDownloading}
                  onClick={handleDownloadPDF}
                >
                  {pdfDownloading ? "Generating PDF..." : "Download PDF"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep(1);
                    setTaxResult(null);
                    setComputationId(null);
                    setAdjustments(initDefaultRows());
                  }}
                >
                  New Computation
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This computation is for reference only. Always verify with your tax advisor before filing.
              </p>
            </CardContent>
          </Card>

        </div>
      )}

    </div>
  );
}
