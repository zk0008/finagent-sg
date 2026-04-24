/**
 * app/receipts/page.tsx
 *
 * Receipt Segregation page — Improvement B, Prompts B2 + B3 + manual entry addition.
 *
 * Allows users to upload income and expense receipts (PDF, image, CSV),
 * extract line items via POST /api/receipts/extract, and/or add rows manually
 * without uploading any file. Extracted and manual rows appear in the same
 * editable tables. Users can then confirm to:
 *   1. Generate a trial balance (lib/receiptToTrialBalance.ts)
 *   2. Save items to the client's Supabase receipts table
 *      (POST /api/receipts/save)
 *   3. Preview the generated trial balance
 *   4. Export as Excel (POST /api/receipts/export-excel)
 *
 * Manual entry:
 *   Each table has an Add Row button (always visible) that appends a blank row
 *   with extraction_confidence = "manual". Manual rows show a grey badge and
 *   are included in trial balance generation and save without special treatment.
 *
 * State:
 * - clients / schemaName — client selector, loaded from /api/clients
 * - period              — transaction period string (e.g. "March 2026")
 * - incomeFiles         — files staged in the income upload zone
 * - expenseFiles        — files staged in the expense upload zone
 * - incomeItems         — extracted + manually entered income line items
 * - expenseItems        — extracted + manually entered expense line items
 * - extracting          — loading flag during API calls
 * - extractError        — error message from extraction
 * - trialBalance        — generated TrialBalanceLine[] after confirmation
 * - saving              — loading flag during save
 * - saveError           — error message from save
 * - saveSuccess         — true after successful save
 * - exporting           — loading flag during Excel export
 */

"use client";

import { useEffect, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BottomNav } from "@/components/BottomNav";
import { generateTrialBalanceFromReceipts } from "@/lib/receiptToTrialBalance";
import type { TrialBalanceLine } from "@/lib/schemas";
import type { ReceiptLineItem } from "@/app/api/receipts/extract/route";
import type { ClientSummary } from "@/app/api/clients/route";

// ── Local types ───────────────────────────────────────────────────────────────

// Extends ReceiptLineItem with UI-only fields. extraction_confidence is widened
// to include "manual" for rows added by hand (valid in the DB receipts table).
interface EditableReceiptItem extends Omit<ReceiptLineItem, "extraction_confidence"> {
  id: string;
  currency: string;
  extraction_confidence: "high" | "medium" | "low" | "manual";
}

type ItemType = "income" | "expense";

// ── Helper: generate a simple unique id ──────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── ConfidenceBadge ───────────────────────────────────────────────────────────

function ConfidenceBadge({
  confidence,
}: {
  confidence: EditableReceiptItem["extraction_confidence"];
}) {
  if (confidence === "high") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
        High
      </span>
    );
  }
  if (confidence === "medium") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
        Medium
      </span>
    );
  }
  if (confidence === "low") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
        Low
      </span>
    );
  }
  // "manual"
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
      Manual
    </span>
  );
}

// ── UploadZone ────────────────────────────────────────────────────────────────

interface UploadZoneProps {
  label: string;
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled?: boolean;
}

function UploadZone({ label, files, onFilesChange, disabled }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const next = [...files];
    Array.from(incoming).forEach((f) => {
      if (!next.find((x) => x.name === f.name && x.size === f.size)) {
        next.push(f);
      }
    });
    onFilesChange(next);
  }

  function removeFile(index: number) {
    const next = files.filter((_, i) => i !== index);
    onFilesChange(next);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Upload ${label} files`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) addFiles(e.dataTransfer.files);
        }}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " "))
            inputRef.current?.click();
        }}
        className={[
          "min-h-32 border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-1 px-4 py-4 cursor-pointer select-none transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30",
          disabled ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
      >
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <span className="text-xs text-muted-foreground">
          Drag &amp; drop or click — PDF, JPG, PNG, CSV
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.csv"
          className="hidden"
          disabled={disabled}
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-2 text-sm bg-muted/40 rounded px-3 py-1.5"
            >
              <span className="truncate max-w-[200px] sm:max-w-xs">{f.name}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => removeFile(i)}
                disabled={disabled}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── EditableReceiptTable ──────────────────────────────────────────────────────

interface EditableReceiptTableProps {
  items: EditableReceiptItem[];
  onUpdate: (id: string, patch: Partial<EditableReceiptItem>) => void;
  onDelete: (id: string) => void;
  onAddRow: () => void;
}

function EditableReceiptTable({
  items,
  onUpdate,
  onDelete,
  onAddRow,
}: EditableReceiptTableProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-40">Description</TableHead>
              <TableHead className="min-w-36">Amount</TableHead>
              <TableHead className="min-w-32">Currency</TableHead>
              <TableHead className="min-w-48">Date</TableHead>
              <TableHead className="min-w-32">Confidence</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-sm text-muted-foreground py-4"
                >
                  No items yet. Upload a file or add a row manually.
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => {
                const isLowConf =
                  item.extraction_confidence === "low" ||
                  item.extraction_confidence === "medium";

                return (
                  <TableRow
                    key={item.id}
                    className={
                      isLowConf
                        ? "bg-amber-50 hover:bg-amber-100/80"
                        : undefined
                    }
                  >
                    <TableCell>
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) =>
                          onUpdate(item.id, { description: e.target.value })
                        }
                        className="w-full bg-transparent border-b border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm py-0.5"
                        aria-label="Description"
                      />
                    </TableCell>
                    <TableCell>
                      <input
                        type="text"
                        value={item.amount}
                        onChange={(e) =>
                          onUpdate(item.id, { amount: e.target.value })
                        }
                        className="w-full bg-transparent border-b border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm py-0.5 text-left"
                        aria-label="Amount"
                      />
                    </TableCell>
                    <TableCell>
                      <input
                        type="text"
                        value={item.currency}
                        onChange={(e) =>
                          onUpdate(item.id, {
                            currency: e.target.value.toUpperCase(),
                          })
                        }
                        maxLength={3}
                        className="w-full bg-transparent border-b border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm py-0.5 uppercase"
                        aria-label="Currency"
                      />
                    </TableCell>
                    <TableCell>
                      <input
                        type="text"
                        value={item.date ?? ""}
                        placeholder="YYYY-MM-DD"
                        onChange={(e) =>
                          onUpdate(item.id, {
                            date: e.target.value || null,
                          })
                        }
                        className="w-full bg-transparent border-b border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm py-0.5"
                        aria-label="Date"
                      />
                    </TableCell>
                    <TableCell>
                      <ConfidenceBadge confidence={item.extraction_confidence} />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        aria-label="Delete row"
                        onClick={() => onDelete(item.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                      >
                        ✕
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add Row button — always visible */}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAddRow}
          className="min-h-[44px] text-sm"
        >
          + Add Row
        </Button>
      </div>
    </div>
  );
}

// ── TrialBalancePreview ───────────────────────────────────────────────────────

function TrialBalancePreview({ lines }: { lines: TrialBalanceLine[] }) {
  const totalDebit  = lines.reduce((s, l) => s + l.debit,  0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  function fmt(n: number) {
    return n.toLocaleString("en-SG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-40">Account Code</TableHead>
            <TableHead className="min-w-48">Account Name</TableHead>
            <TableHead className="min-w-44 text-right">Debit (SGD)</TableHead>
            <TableHead className="min-w-44 text-right">Credit (SGD)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.account_code}>
              <TableCell className="font-mono text-sm">{line.account_code}</TableCell>
              <TableCell>{line.account_name}</TableCell>
              <TableCell className="text-right font-mono text-sm">
                {line.debit > 0 ? fmt(line.debit) : ""}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {line.credit > 0 ? fmt(line.credit) : ""}
              </TableCell>
            </TableRow>
          ))}
          <TableRow className="font-semibold bg-muted/40">
            <TableCell />
            <TableCell>Total</TableCell>
            <TableCell className="text-right font-mono">{fmt(totalDebit)}</TableCell>
            <TableCell className="text-right font-mono">{fmt(totalCredit)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ── ReceiptsPage ──────────────────────────────────────────────────────────────

export default function ReceiptsPage() {
  // Client selector
  const [clients, setClients]       = useState<ClientSummary[]>([]);
  const [schemaName, setSchemaName] = useState("");

  // Upload + extraction state
  const [period, setPeriod]             = useState("");
  const [incomeFiles, setIncomeFiles]   = useState<File[]>([]);
  const [expenseFiles, setExpenseFiles] = useState<File[]>([]);
  const [incomeItems, setIncomeItems]   = useState<EditableReceiptItem[]>([]);
  const [expenseItems, setExpenseItems] = useState<EditableReceiptItem[]>([]);
  const [extracting, setExtracting]     = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Confirmation + save state
  const [trialBalance, setTrialBalance] = useState<TrialBalanceLine[] | null>(null);
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess]   = useState(false);

  // Excel export state
  const [exporting, setExporting]     = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // ── Load clients on mount ─────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then((d) => {
        if (d.clients?.length) {
          setClients(d.clients);
          setSchemaName(d.clients[0].schema_name);
        }
      })
      .catch(() => {});
  }, []);

  // ── Extract handler ───────────────────────────────────────────────────────

  async function handleExtract() {
    if (!period.trim()) {
      setExtractError("Please enter a transaction period before extracting.");
      return;
    }
    if (incomeFiles.length === 0 && expenseFiles.length === 0) {
      setExtractError("Please upload at least one income or expense file.");
      return;
    }

    setExtracting(true);
    setExtractError(null);
    setTrialBalance(null);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      const calls: Array<{ file: File; type: ItemType }> = [
        ...incomeFiles.map((f) => ({ file: f, type: "income" as ItemType })),
        ...expenseFiles.map((f) => ({ file: f, type: "expense" as ItemType })),
      ];

      const results = await Promise.all(
        calls.map(async ({ file, type }) => {
          const form = new FormData();
          form.append("file", file);
          form.append("type", type);
          form.append("period", period.trim());

          const res = await fetch("/api/receipts/extract", {
            method: "POST",
            body: form,
          });
          const data = await res.json();

          if (!res.ok) {
            throw new Error(
              `${file.name}: ${data.error ?? "Extraction failed"}`
            );
          }

          return {
            type: data.type as ItemType,
            items: (data.items as ReceiptLineItem[]).map((item) => ({
              ...item,
              id: uid(),
              currency: "SGD",
            })),
          };
        })
      );

      const newIncome:  EditableReceiptItem[] = [];
      const newExpense: EditableReceiptItem[] = [];

      for (const r of results) {
        if (r.type === "income") newIncome.push(...r.items);
        else newExpense.push(...r.items);
      }

      setIncomeItems((prev) => [...prev, ...newIncome]);
      setExpenseItems((prev) => [...prev, ...newExpense]);
      setIncomeFiles([]);
      setExpenseFiles([]);
    } catch (err) {
      setExtractError(
        err instanceof Error ? err.message : "Extraction failed."
      );
    } finally {
      setExtracting(false);
    }
  }

  // ── Manual row addition ───────────────────────────────────────────────────

  function addRow(type: ItemType) {
    const newItem: EditableReceiptItem = {
      id:                    uid(),
      description:           "",
      amount:                "0.00",
      date:                  null,
      currency:              "SGD",
      extraction_confidence: "manual",
    };
    const setter = type === "income" ? setIncomeItems : setExpenseItems;
    setter((prev) => [...prev, newItem]);
  }

  // ── Confirm & generate trial balance ─────────────────────────────────────

  async function handleConfirm() {
    if (!schemaName) {
      setSaveError("Please select a client before confirming.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    setTrialBalance(null);

    try {
      const tb = generateTrialBalanceFromReceipts(incomeItems, expenseItems);
      setTrialBalance(tb);

      const res = await fetch("/api/receipts/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaName,
          period: period.trim(),
          incomeItems,
          expenseItems,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");

      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // ── Excel export ──────────────────────────────────────────────────────────

  async function handleExportExcel() {
    setExporting(true);
    setExportError(null);

    try {
      const res = await fetch("/api/receipts/export-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: period.trim(),
          incomeItems,
          expenseItems,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Export failed");
      }

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `trial-balance-${period.trim().replace(/\s+/g, "-")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  // ── Item update / delete helpers ──────────────────────────────────────────

  function updateItem(
    type: ItemType,
    id: string,
    patch: Partial<EditableReceiptItem>
  ) {
    const setter = type === "income" ? setIncomeItems : setExpenseItems;
    setter((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function deleteItem(type: ItemType, id: string) {
    const setter = type === "income" ? setIncomeItems : setExpenseItems;
    setter((prev) => prev.filter((item) => item.id !== id));
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const hasResults = incomeItems.length > 0 || expenseItems.length > 0;
  const canExtract =
    !extracting &&
    period.trim().length > 0 &&
    (incomeFiles.length > 0 || expenseFiles.length > 0);
  const canConfirm = !saving && hasResults && period.trim().length > 0 && !!schemaName;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="px-4 sm:px-6 py-3 border-b bg-white flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Receipt Segregation
        </h1>
        {period.trim() && (
          <Badge variant="secondary" className="shrink-0">
            {period.trim()}
          </Badge>
        )}
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-5xl mx-auto w-full flex flex-col gap-6">

        {/* ── Upload section ── */}
        <section className="flex flex-col gap-4">

          {/* Client selector */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="client" className="text-sm font-medium">
              Client
            </label>
            <select
              id="client"
              value={schemaName}
              onChange={(e) => setSchemaName(e.target.value)}
              disabled={extracting || saving}
              className="w-full max-w-xs border rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 min-h-[44px]"
            >
              {clients.length === 0 && (
                <option value="">Loading clients…</option>
              )}
              {clients.map((c) => (
                <option key={c.schema_name} value={c.schema_name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Transaction period */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="period" className="text-sm font-medium">
              Transaction period
            </label>
            <input
              id="period"
              type="text"
              placeholder="e.g. March 2026"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={extracting}
              className="w-full max-w-xs border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 min-h-[44px]"
            />
          </div>

          {/* Upload zones */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Income receipts</span>
              <UploadZone
                label="Drop income files here"
                files={incomeFiles}
                onFilesChange={setIncomeFiles}
                disabled={extracting}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Expense receipts</span>
              <UploadZone
                label="Drop expense files here"
                files={expenseFiles}
                onFilesChange={setExpenseFiles}
                disabled={extracting}
              />
            </div>
          </div>

          {extractError && (
            <p className="text-sm text-destructive">{extractError}</p>
          )}

          <div>
            <Button
              onClick={handleExtract}
              disabled={!canExtract}
              className="min-h-[44px]"
            >
              {extracting ? "Extracting…" : "Extract line items"}
            </Button>
          </div>
        </section>

        {/* Plain div separator — avoids Base UI SSR hydration mismatch */}
        <div className="shrink-0 bg-border h-px w-full" />

        {/* ── Line items section (always visible) ── */}
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">Line items</h2>
            <p className="text-sm text-muted-foreground">
              Review and correct any field before confirming. Use Add Row to
              enter items manually.{" "}
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded bg-amber-100 border border-amber-300" />
                Amber rows have medium or low extraction confidence.
              </span>
            </p>
          </div>

          {/* Income table */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Income</h3>
              <Badge variant="secondary">{incomeItems.length}</Badge>
            </div>
            <EditableReceiptTable
              items={incomeItems}
              onUpdate={(id, patch) => updateItem("income", id, patch)}
              onDelete={(id) => deleteItem("income", id)}
              onAddRow={() => addRow("income")}
            />
          </div>

          {/* Expense table */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Expenses</h3>
              <Badge variant="secondary">{expenseItems.length}</Badge>
            </div>
            <EditableReceiptTable
              items={expenseItems}
              onUpdate={(id, patch) => updateItem("expense", id, patch)}
              onDelete={(id) => deleteItem("expense", id)}
              onAddRow={() => addRow("expense")}
            />
          </div>

          {/* Confirm + Export buttons */}
          <div className="flex flex-wrap gap-3 items-center">
            <Button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="min-h-[44px]"
            >
              {saving ? "Saving…" : "Confirm & Generate Trial Balance"}
            </Button>
            <Button
              variant="outline"
              onClick={handleExportExcel}
              disabled={!hasResults || exporting}
              className="min-h-[44px]"
            >
              {exporting ? "Exporting…" : "Export as Excel"}
            </Button>
          </div>

          {saveError   && <p className="text-sm text-destructive">{saveError}</p>}
          {exportError && <p className="text-sm text-destructive">{exportError}</p>}
          {saveSuccess && (
            <p className="text-sm text-green-700 font-medium">
              Receipts saved successfully.
            </p>
          )}
        </section>

        {/* ── Trial balance preview ── */}
        {trialBalance && trialBalance.length > 0 && (
          <>
            <Separator />

            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-base font-semibold">
                  Generated Trial Balance
                </h2>
                <p className="text-sm text-muted-foreground">
                  {period.trim()} · {trialBalance.length} account
                  {trialBalance.length !== 1 ? "s" : ""}
                </p>
              </div>
              <TrialBalancePreview lines={trialBalance} />
            </section>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
