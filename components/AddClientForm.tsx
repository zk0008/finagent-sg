/**
 * components/AddClientForm.tsx
 *
 * Form for adding a new client company (Phase 6).
 *
 * Fields:
 * - Company name (required)
 * - UEN (required)
 * - Company type (default: Private Ltd)
 * - FYE date
 * - Annual revenue, total assets, employee count
 * - Number of shareholders, has corporate shareholders
 *
 * On submit: POST to /api/clients.
 * On success: calls onSuccess(client) so the parent can add it to the list.
 * On failure: shows the error message from the API.
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ClientSummary } from "@/app/api/clients/route";

interface AddClientFormProps {
  onSuccess: (client: ClientSummary) => void;
  onCancel: () => void;
}

export function AddClientForm({ onSuccess, onCancel }: AddClientFormProps) {
  const [name, setName] = useState("");
  const [uen, setUen] = useState("");
  const [companyType, setCompanyType] = useState("private_ltd");
  const [fyeDate, setFyeDate] = useState("2025-12-31");
  const [revenue, setRevenue] = useState("0");
  const [totalAssets, setTotalAssets] = useState("0");
  const [employeeCount, setEmployeeCount] = useState("0");
  const [shareholderCount, setShareholderCount] = useState("1");
  const [hasCorporateShareholders, setHasCorporateShareholders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          uen,
          company_type: companyType,
          fye_date: fyeDate,
          revenue,
          total_assets: totalAssets,
          employee_count: parseInt(employeeCount, 10) || 0,
          shareholder_count: parseInt(shareholderCount, 10) || 1,
          has_corporate_shareholders: hasCorporateShareholders,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create client.");
        return;
      }
      onSuccess(data.client);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1 col-span-2">
          <Label htmlFor="name">Company Name *</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="TechSoft Pte Ltd"
            required
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="uen">UEN *</Label>
          <Input
            id="uen"
            value={uen}
            onChange={(e) => setUen(e.target.value)}
            placeholder="201912345K"
            required
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="company_type">Company Type</Label>
          <select
            id="company_type"
            value={companyType}
            onChange={(e) => setCompanyType(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value="private_ltd">Private Limited</option>
            <option value="llp">LLP</option>
            <option value="sole_prop">Sole Proprietorship</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="fye_date">Financial Year End</Label>
          <Input
            id="fye_date"
            type="date"
            value={fyeDate}
            onChange={(e) => setFyeDate(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="revenue">Annual Revenue (SGD)</Label>
          <Input
            id="revenue"
            type="number"
            min="0"
            value={revenue}
            onChange={(e) => setRevenue(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="total_assets">Total Assets (SGD)</Label>
          <Input
            id="total_assets"
            type="number"
            min="0"
            value={totalAssets}
            onChange={(e) => setTotalAssets(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="employee_count">Number of Employees</Label>
          <Input
            id="employee_count"
            type="number"
            min="0"
            value={employeeCount}
            onChange={(e) => setEmployeeCount(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="shareholder_count">Number of Shareholders</Label>
          <Input
            id="shareholder_count"
            type="number"
            min="1"
            value={shareholderCount}
            onChange={(e) => setShareholderCount(e.target.value)}
          />
        </div>

        <div className="col-span-2 flex items-center gap-2">
          <input
            id="has_corporate_shareholders"
            type="checkbox"
            checked={hasCorporateShareholders}
            onChange={(e) => setHasCorporateShareholders(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="has_corporate_shareholders" className="cursor-pointer">
            Has corporate shareholders
          </Label>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Add Client"}
        </Button>
      </div>
    </form>
  );
}
