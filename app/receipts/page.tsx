/**
 * app/receipts/page.tsx
 *
 * Receipt Segregation page — Improvement B, Prompt B2.
 *
 * Allows users to upload income and expense receipts (PDF, image, CSV),
 * extract line items via POST /api/receipts/extract, review and edit
 * extracted items in an inline editable table, then confirm for trial
 * balance generation (B3).
 *
 * State:
 * - period          — the transaction period string (e.g. "March 2026")
 * - incomeFiles     — files staged in the income upload zone
 * - expenseFiles    — files staged in the expense upload zone
 * - incomeItems     — extracted + editable income line items
 * - expenseItems    — extracted + editable expense line items
 * - extracting      — loading flag during API calls
 * - extractError    — error message from extraction
 *
 * No Supabase calls — saving and trial balance generation are in B3.
 * Navigation wiring is in B3.
 */

"use client";

import { useRef, useState } from "react";
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
import type { ReceiptLineItem } from "@/app/api/receipts/extract/route";

// ── Local types ───────────────────────────────────────────────────────────────

interface EditableReceiptItem extends ReceiptLineItem {
  id: string;
  currency: string;
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
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
      Low
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
    // Reset input so the same file can be re-added if removed
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Drop zone */}
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
          "min-h-[80px] border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-1 px-4 py-4 cursor-pointer select-none transition-colors",
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

      {/* Staged file list */}
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
}

function EditableReceiptTable({
  items,
  onUpdate,
  onDelete,
}: EditableReceiptTableProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No items extracted yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[160px]">Description</TableHead>
            <TableHead className="min-w-[90px]">Amount</TableHead>
            <TableHead className="min-w-[80px]">Currency</TableHead>
            <TableHead className="min-w-[120px]">Date</TableHead>
            <TableHead className="min-w-[80px]">Confidence</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
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
                {/* Description */}
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

                {/* Amount */}
                <TableCell>
                  <input
                    type="text"
                    value={item.amount}
                    onChange={(e) =>
                      onUpdate(item.id, { amount: e.target.value })
                    }
                    className="w-full bg-transparent border-b border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm py-0.5 text-right"
                    aria-label="Amount"
                  />
                </TableCell>

                {/* Currency */}
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

                {/* Date */}
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

                {/* Confidence */}
                <TableCell>
                  <ConfidenceBadge confidence={item.extraction_confidence} />
                </TableCell>

                {/* Delete */}
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
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── ReceiptsPage ──────────────────────────────────────────────────────────────

export default function ReceiptsPage() {
  const [period, setPeriod] = useState("");
  const [incomeFiles, setIncomeFiles] = useState<File[]>([]);
  const [expenseFiles, setExpenseFiles] = useState<File[]>([]);
  const [incomeItems, setIncomeItems] = useState<EditableReceiptItem[]>([]);
  const [expenseItems, setExpenseItems] = useState<EditableReceiptItem[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // ── Extract handler ─────────────────────────────────────────────────────────

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

      const newIncome: EditableReceiptItem[] = [];
      const newExpense: EditableReceiptItem[] = [];

      for (const r of results) {
        if (r.type === "income") newIncome.push(...r.items);
        else newExpense.push(...r.items);
      }

      setIncomeItems((prev) => [...prev, ...newIncome]);
      setExpenseItems((prev) => [...prev, ...newExpense]);

      // Clear staged files after successful extraction
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

  // ── Item update / delete helpers ────────────────────────────────────────────

  function updateItem(
    type: ItemType,
    id: string,
    patch: Partial<EditableReceiptItem>
  ) {
    const setter =
      type === "income" ? setIncomeItems : setExpenseItems;
    setter((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function deleteItem(type: ItemType, id: string) {
    const setter =
      type === "income" ? setIncomeItems : setExpenseItems;
    setter((prev) => prev.filter((item) => item.id !== id));
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  const hasResults = incomeItems.length > 0 || expenseItems.length > 0;
  const canExtract =
    !extracting &&
    period.trim().length > 0 &&
    (incomeFiles.length > 0 || expenseFiles.length > 0);

  // ── Render ──────────────────────────────────────────────────────────────────

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

        {/* Period + Upload Section */}
        <section className="flex flex-col gap-4">
          {/* Transaction period */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="period"
              className="text-sm font-medium"
            >
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

          {/* Error */}
          {extractError && (
            <p className="text-sm text-destructive">{extractError}</p>
          )}

          {/* Extract button */}
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

        {/* Results Section */}
        {hasResults && (
          <>
            <Separator />

            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-base font-semibold">Extracted items</h2>
                <p className="text-sm text-muted-foreground">
                  Review and correct any field before confirming.{" "}
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
                />
              </div>

              {/* Confirm button (disabled — B3 wires this) */}
              <div>
                <Button
                  disabled
                  className="min-h-[44px]"
                  title="Trial balance generation coming in B3"
                >
                  Confirm &amp; Generate Trial Balance
                </Button>
              </div>
            </section>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
