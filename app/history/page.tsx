/**
 * app/history/page.tsx
 *
 * History page — read-only record of past outputs per client (Phase 6).
 *
 * Tabs:
 * - Financial Statements: date, FYE date, audit exempt, download PDF
 * - Financial Models: date, model name, projection years, active status, download Excel
 * - Payroll Runs: month, employees, total payroll, status
 *
 * Client is selected via a dropdown at the top (loaded from /api/clients).
 * All tables are read-only — no editing or regenerating from here.
 *
 * Data fetched from GET /api/history?schemaName=<schema>&type=<fs|model|payroll>
 */

"use client";

import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { BottomNav } from "@/components/BottomNav";
import type { ClientSummary } from "@/app/api/clients/route";
import type {
  FSHistoryItem,
  ModelHistoryItem,
  PayrollHistoryItem,
  TaxHistoryItem,
} from "@/app/api/history/route";

type TabType = "fs" | "model" | "payroll" | "tax";

export default function HistoryPage() {
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selectedSchema, setSelectedSchema] = useState("");
  const [tab, setTab] = useState<TabType>("fs");

  const [fsItems, setFsItems] = useState<FSHistoryItem[]>([]);
  const [modelItems, setModelItems] = useState<ModelHistoryItem[]>([]);
  const [payrollItems, setPayrollItems] = useState<PayrollHistoryItem[]>([]);
  const [taxItems, setTaxItems] = useState<TaxHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load clients on mount
  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then((d) => {
        if (d.clients?.length) {
          setClients(d.clients);
          setSelectedSchema(d.clients[0].schema_name);
        }
      })
      .catch(() => {});
  }, []);

  // Reload history when schema or tab changes
  useEffect(() => {
    if (!selectedSchema) return;
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSchema, tab]);

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/history?schemaName=${encodeURIComponent(selectedSchema)}&type=${tab}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load history");
      if (tab === "fs") setFsItems(data.items);
      else if (tab === "model") setModelItems(data.items);
      else if (tab === "payroll") setPayrollItems(data.items);
      else setTaxItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadPDF(outputId: string) {
    // Fetch the output's pdf_data from Supabase and trigger download
    const res = await fetch(
      `/api/history/pdf?schemaName=${encodeURIComponent(selectedSchema)}&outputId=${outputId}`
    );
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `financial-statements-${outputId}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleDownloadExcel(modelId: string) {
    const res = await fetch(
      `/api/history/excel?schemaName=${encodeURIComponent(selectedSchema)}&modelId=${modelId}`
    );
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `financial-model-${modelId}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-SG", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }


  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-5xl mx-auto w-full">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">History</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Past generated outputs — read only
          </p>
        </div>

        {/* Client selector */}
        {clients.length > 0 && (
          <div className="mb-6">
            <select
              value={selectedSchema}
              onChange={(e) => setSelectedSchema(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-full sm:w-72"
            >
              {clients.map((c) => (
                <option key={c.id} value={c.schema_name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive mb-4">Error: {error}</p>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabType)}>
          <div className="overflow-x-auto mb-4">
            <TabsList className="min-w-max">
              <TabsTrigger value="fs">Financial Statements</TabsTrigger>
              <TabsTrigger value="model">Financial Models</TabsTrigger>
              <TabsTrigger value="payroll">Payroll Runs</TabsTrigger>
              <TabsTrigger value="tax">Tax Computations</TabsTrigger>
            </TabsList>
          </div>

          {/* ── Financial Statements ── */}
          <TabsContent value="fs">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : fsItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No financial statements generated yet.</p>
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date Generated</TableHead>
                    <TableHead className="w-32">FYE Date</TableHead>
                    <TableHead className="w-28">Audit Exempt</TableHead>
                    <TableHead className="w-32">Download</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fsItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">{formatDate(item.created_at)}</TableCell>
                      <TableCell className="text-sm">{item.fiscal_year_end ?? "—"}</TableCell>
                      <TableCell>
                        {item.audit_exempt != null ? (
                          <Badge variant={item.audit_exempt ? "default" : "secondary"}>
                            {item.audit_exempt ? "Exempt" : "Required"}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownloadPDF(item.id)}
                        >
                          PDF
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></div>
            )}
          </TabsContent>

          {/* ── Financial Models ── */}
          <TabsContent value="model">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : modelItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No financial models saved yet.</p>
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date Generated</TableHead>
                    <TableHead>Model Name</TableHead>
                    <TableHead className="w-28">Proj. Years</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead className="w-32">Download</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">{formatDate(item.created_at)}</TableCell>
                      <TableCell className="text-sm font-medium">{item.model_name}</TableCell>
                      <TableCell className="text-sm">{item.projection_years} years</TableCell>
                      <TableCell>
                        <Badge variant={item.is_active ? "default" : "secondary"}>
                          {item.is_active ? "Active" : "Archived"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownloadExcel(item.id)}
                        >
                          Excel
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></div>
            )}
          </TabsContent>

          {/* ── Payroll Runs ── */}
          <TabsContent value="payroll">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : payrollItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payrollItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm font-medium">{item.run_month}</TableCell>
                      <TableCell>
                        <Badge variant={item.status === "finalised" ? "default" : "secondary"}>
                          {item.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></div>
            )}
          </TabsContent>
          {/* ── Tax Computations ── */}
          <TabsContent value="tax">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : taxItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tax computations saved yet.</p>
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date Generated</TableHead>
                    <TableHead className="w-24">YA</TableHead>
                    <TableHead className="w-28">Form Type</TableHead>
                    <TableHead className="w-32">Chargeable Income</TableHead>
                    <TableHead className="w-32">Tax Payable</TableHead>
                    <TableHead className="w-32">Exemption</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taxItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">{formatDate(item.created_at)}</TableCell>
                      <TableCell className="text-sm font-medium">YA {item.year_of_assessment}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{item.form_type.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        SGD {parseFloat(item.chargeable_income).toLocaleString("en-SG", { minimumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        SGD {parseFloat(item.tax_payable).toLocaleString("en-SG", { minimumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.exemption_scheme === "new_startup" ? "New Start-Up" : "Partial"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></div>
            )}
          </TabsContent>

        </Tabs>
      </main>

      <BottomNav />
    </div>
  );
}
