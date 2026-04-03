/**
 * app/corrections/page.tsx
 *
 * Correction Review Interface — Phase 5.
 *
 * What this page does:
 * Displays all corrections submitted via the chatbot for a given client schema.
 * Accountants use this page to review user corrections before they are used
 * for fine-tuning (Phase 5, Task 6 — the export script reads "reviewed" status).
 *
 * Features:
 * - Table showing: date, message, status, linked output_id (if any)
 * - Filter by status: all / pending / reviewed
 * - "Mark as reviewed" button — PATCHes status to "reviewed" via API
 *
 * schemaName is passed as a query param: /corrections?schema=techsoft_pte_ltd
 * This mirrors how other pages in FinAgent-SG identify the active client.
 */

"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Correction } from "@/app/api/corrections/route";

type StatusFilter = "all" | "pending" | "reviewed";

export default function CorrectionsPage() {
  const searchParams = useSearchParams();
  const schemaName = searchParams.get("schema") ?? "techsoft_pte_ltd";

  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);

  // Load corrections whenever the schema or filter changes
  useEffect(() => {
    loadCorrections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaName, statusFilter]);

  async function loadCorrections() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ schemaName });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/corrections?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load corrections");
      setCorrections(data.corrections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function markReviewed(id: string) {
    setMarkingId(id);
    try {
      const res = await fetch("/api/corrections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, schemaName, status: "reviewed" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
      // Update local state rather than re-fetching
      setCorrections((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "reviewed" } : c))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setMarkingId(null);
    }
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
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Corrections</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Schema: <span className="font-mono">{schemaName}</span>
          {" · "}
          Review chatbot corrections before fine-tuning
        </p>
      </div>

      {/* Status filter */}
      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="reviewed">Reviewed</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Error message */}
      {error && (
        <p className="text-sm text-destructive mb-4">Error: {error}</p>
      )}

      {/* Corrections table */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading corrections…</p>
      ) : corrections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {statusFilter !== "all" ? statusFilter + " " : ""}corrections found.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Date</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-32">Linked Output</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-36">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {corrections.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(c.created_at)}
                </TableCell>
                <TableCell className="text-sm">{c.message}</TableCell>
                <TableCell className="text-xs font-mono text-muted-foreground">
                  {c.output_id ? c.output_id.slice(0, 8) + "…" : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={c.status === "reviewed" ? "default" : "secondary"}
                  >
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {c.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={markingId === c.id}
                      onClick={() => markReviewed(c.id)}
                    >
                      {markingId === c.id ? "Saving…" : "Mark reviewed"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
