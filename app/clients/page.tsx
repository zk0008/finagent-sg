/**
 * app/clients/page.tsx
 *
 * Client management page (Phase 6).
 *
 * What this page shows:
 * - Table of all client companies: name, UEN, FYE date, audit exempt, date added.
 * - [Add New Client] button — shows AddClientForm inline.
 * - Clicking a client row navigates to the main workflow pre-loaded with that client.
 *   (Navigates to /?schema=<schema_name> — WorkflowPanel reads this on load.)
 *
 * Data: fetched from GET /api/clients on mount.
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AddClientForm } from "@/components/AddClientForm";
import { BottomNav } from "@/components/BottomNav";
import type { ClientSummary } from "@/app/api/clients/route";

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadClients();
  }, []);

  async function loadClients() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load clients");
      setClients(data.clients);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function handleClientAdded(client: ClientSummary) {
    setClients((prev) => [client, ...prev]);
    setShowForm(false);
  }

  function handleSelectClient(client: ClientSummary) {
    // Navigate to the main workflow page with the client's schema pre-selected
    router.push(`/?schema=${client.schema_name}`);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-SG", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold tracking-tight">FinAgent-SG</h1>
      </header>

      <main className="flex-1 p-8 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold">Clients</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Manage your client companies
            </p>
          </div>
          {!showForm && (
            <Button onClick={() => setShowForm(true)}>Add New Client</Button>
          )}
        </div>

        {/* Add Client Form */}
        {showForm && (
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-medium">New Client</CardTitle>
            </CardHeader>
            <CardContent>
              <AddClientForm
                onSuccess={handleClientAdded}
                onCancel={() => setShowForm(false)}
              />
            </CardContent>
          </Card>
        )}

        <Separator className="mb-6" />

        {/* Error */}
        {error && (
          <p className="text-sm text-destructive mb-4">Error: {error}</p>
        )}

        {/* Clients table */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading clients…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No clients yet. Click &ldquo;Add New Client&rdquo; to get started.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company Name</TableHead>
                <TableHead className="w-32">UEN</TableHead>
                <TableHead className="w-32">FYE Date</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead className="w-28">Audit Exempt</TableHead>
                <TableHead className="w-36">Date Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => handleSelectClient(c)}
                >
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-sm font-mono">{c.uen}</TableCell>
                  <TableCell className="text-sm">{c.fye_date}</TableCell>
                  <TableCell className="text-sm text-muted-foreground capitalize">
                    {c.company_type.replace("_", " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.audit_exempt ? "default" : "secondary"}>
                      {c.audit_exempt ? "Exempt" : "Required"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.created_at ? formatDate(c.created_at) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
