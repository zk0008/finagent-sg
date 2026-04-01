/**
 * components/PayrollWorkflow.tsx
 *
 * Payroll workflow UI for FinAgent-SG (Phase 4).
 *
 * What this component does:
 * Renders a 3-step payroll workflow:
 *
 *   Step 1 — Employee Setup
 *     Table of existing employees; add/edit/delete form.
 *     Calls GET /api/payroll/employees on load.
 *     Calls POST /api/payroll/employees to create.
 *     Calls PUT  /api/payroll/employees/[id] to edit.
 *     Calls DELETE /api/payroll/employees/[id] to delete.
 *
 *   Step 2 — Run Payroll
 *     Month picker + table of employees with editable OW, AW, allowances.
 *     [Run Payroll ▶] button calls POST /api/payroll/run.
 *     Results table shows CPF breakdown per employee after run.
 *
 *   Step 3 — Download Outputs
 *     Buttons to download:
 *       - Individual payslips (PDF) per employee → POST /api/payroll/payslip
 *       - CPF e-Submit CSV → POST /api/payroll/export-cpf
 *       - Journal entries (JSON) → POST /api/payroll/journal
 *     [Finalise Payroll] → PATCH /api/payroll/run (locks the run)
 *
 * Props:
 *   schemaName  — Supabase schema name derived from company name
 *   companyName — Display name and UEN for payslip headers
 *   entityId    — Entity UUID for DB queries
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { type Employee } from "@/lib/schemas";

// ── Types ─────────────────────────────────────────────────────────────────────

type CitizenshipValue = "SC" | "SPR_1" | "SPR_2" | "SPR_3" | "foreigner";

const CITIZENSHIP_LABELS: Record<CitizenshipValue, string> = {
  SC: "Singapore Citizen (SC)",
  SPR_1: "SPR — 1st Year",
  SPR_2: "SPR — 2nd Year",
  SPR_3: "SPR — 3rd Year+",
  foreigner: "Foreigner",
};

type PayrollRowData = {
  employee_id: string;
  ordinary_wages: string;
  additional_wages: string;
  allowances_text: string; // simple text input e.g. "Transport 200, Housing 500"
};

type PayrollResult = {
  employee_id: string;
  age: number;
  ordinary_wages: string;
  additional_wages: string;
  employee_cpf: string;
  employer_cpf: string;
  total_cpf: string;
  sdl: string;
  net_pay: string;
};

type RunState = "idle" | "running" | "complete" | "error";

// ── Props ─────────────────────────────────────────────────────────────────────

type PayrollWorkflowProps = {
  schemaName: string;
  companyName: string;
  entityId: string;
  uen?: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function PayrollWorkflow({
  schemaName,
  companyName,
  entityId,
  uen = "202500001A",
}: PayrollWorkflowProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // ── Step 1: Employee state ─────────────────────────────────────────────────
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [empError, setEmpError] = useState<string | null>(null);

  // Add / edit form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formNric, setFormNric] = useState("");
  const [formDob, setFormDob] = useState("");
  const [formCitizenship, setFormCitizenship] = useState<CitizenshipValue>("SC");
  const [formSalary, setFormSalary] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // ── Step 2: Payroll run state ──────────────────────────────────────────────
  const [payrollMonth, setPayrollMonth] = useState(() => {
    // Default to first day of current month
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const [rowData, setRowData] = useState<PayrollRowData[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runMessage, setRunMessage] = useState("");
  const [payrollResults, setPayrollResults] = useState<PayrollResult[]>([]);
  const [payrollRunId, setPayrollRunId] = useState<string | null>(null);

  // payslipIds maps employee_id → payslip DB id; returned by the run route
  const [payslipIds, setPayslipIds] = useState<Record<string, string>>({});

  // ── Step 3: Output state ───────────────────────────────────────────────────
  const [finalised, setFinalised] = useState(false);
  const [downloadingPayslips, setDownloadingPayslips] = useState(false);
  const [downloadingCPF, setDownloadingCPF] = useState(false);
  const [downloadingJournal, setDownloadingJournal] = useState(false);
  const [finalising, setFinalising] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);

  // ── Fetch employees on mount and when schemaName/entityId changes ──────────
  const fetchEmployees = useCallback(async () => {
    if (!schemaName || !entityId) return;
    setLoadingEmployees(true);
    setEmpError(null);
    try {
      const res = await fetch(
        `/api/payroll/employees?schemaName=${encodeURIComponent(schemaName)}&entity_id=${encodeURIComponent(entityId)}`
      );
      const data = await res.json() as { employees?: Employee[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEmployees(data.employees ?? []);
    } catch (err) {
      setEmpError(`Failed to load employees: ${(err as Error).message}`);
    } finally {
      setLoadingEmployees(false);
    }
  }, [schemaName, entityId]);

  useEffect(() => {
    void fetchEmployees();
  }, [fetchEmployees]);

  // Sync payroll row data when employees list changes
  useEffect(() => {
    setRowData(
      employees.map((emp) => ({
        employee_id: emp.id ?? "",
        ordinary_wages: emp.monthly_salary.toFixed(2),
        additional_wages: "0.00",
        allowances_text: "",
      }))
    );
  }, [employees]);

  // ── Employee form helpers ──────────────────────────────────────────────────

  function resetForm() {
    setEditingId(null);
    setFormName("");
    setFormNric("");
    setFormDob("");
    setFormCitizenship("SC");
    setFormSalary("");
  }

  function startEdit(emp: Employee) {
    setEditingId(emp.id ?? null);
    setFormName(emp.name);
    setFormNric(emp.nric_fin ?? "");
    setFormDob(emp.dob);
    setFormCitizenship(emp.citizenship as CitizenshipValue);
    setFormSalary(emp.monthly_salary.toString());
  }

  async function handleSaveEmployee(): Promise<void> {
    if (!formName.trim() || !formDob || !formSalary) {
      setEmpError("Name, DOB, and monthly salary are required.");
      return;
    }
    const salary = parseFloat(formSalary);
    if (isNaN(salary) || salary <= 0) {
      setEmpError("Monthly salary must be a positive number.");
      return;
    }

    setFormSaving(true);
    setEmpError(null);

    try {
      if (editingId) {
        // Update
        const res = await fetch(`/api/payroll/employees/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaName,
            name: formName.trim(),
            nric_fin: formNric.trim() || null,
            dob: formDob,
            citizenship: formCitizenship,
            monthly_salary: salary,
          }),
        });
        const data = await res.json() as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      } else {
        // Create
        const res = await fetch("/api/payroll/employees", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaName,
            entity_id: entityId,
            name: formName.trim(),
            nric_fin: formNric.trim() || null,
            dob: formDob,
            citizenship: formCitizenship,
            monthly_salary: salary,
          }),
        });
        const data = await res.json() as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      resetForm();
      await fetchEmployees();
    } catch (err) {
      setEmpError(`Save failed: ${(err as Error).message}`);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDeleteEmployee(id: string): Promise<void> {
    if (!confirm("Delete this employee? This cannot be undone.")) return;
    setEmpError(null);
    try {
      const res = await fetch(
        `/api/payroll/employees/${id}?schemaName=${encodeURIComponent(schemaName)}`,
        { method: "DELETE" }
      );
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchEmployees();
    } catch (err) {
      setEmpError(`Delete failed: ${(err as Error).message}`);
    }
  }

  // ── Payroll row update helpers ─────────────────────────────────────────────

  function updateRowData(
    employeeId: string,
    field: keyof PayrollRowData,
    value: string
  ) {
    setRowData((prev) =>
      prev.map((row) =>
        row.employee_id === employeeId ? { ...row, [field]: value } : row
      )
    );
  }

  /**
   * Parses a simple allowances text input into structured allowances.
   * Accepts "Transport 200, Housing 500" format.
   */
  function parseAllowancesText(text: string): Array<{ label: string; amount: number }> {
    if (!text.trim()) return [];
    return text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .flatMap((part) => {
        // Try to split label and amount — last token is the amount
        const tokens = part.trim().split(/\s+/);
        if (tokens.length < 2) return [];
        const amount = parseFloat(tokens[tokens.length - 1]);
        if (isNaN(amount)) return [];
        const label = tokens.slice(0, tokens.length - 1).join(" ");
        return [{ label, amount }];
      });
  }

  // ── Run payroll ────────────────────────────────────────────────────────────

  async function handleRunPayroll(): Promise<void> {
    if (employees.length === 0) {
      setRunMessage("Add at least one employee before running payroll.");
      return;
    }

    setRunState("running");
    setRunMessage("Computing CPF...");
    setPayrollResults([]);
    setPayrollRunId(null);
    setPayslipIds({});
    setFinalised(false);

    const employeesPayload = rowData.map((row) => {
      const emp = employees.find((e) => e.id === row.employee_id);
      return {
        employee_id: row.employee_id,
        citizenship: emp?.citizenship ?? "SC",
        dob: emp?.dob ?? "1980-01-01",
        ordinary_wages: row.ordinary_wages || "0",
        additional_wages: row.additional_wages || "0",
        ytd_ow: "0", // simplified — full YTD tracking is a future enhancement
        allowances: parseAllowancesText(row.allowances_text),
        deductions: [],
      };
    });

    try {
      setRunMessage("Saving payroll run...");
      const res = await fetch("/api/payroll/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaName,
          entity_id: entityId,
          payroll_month: payrollMonth,
          employees: employeesPayload,
        }),
      });

      const data = await res.json() as {
        payroll_run_id?: string;
        results?: PayrollResult[];
        payslip_ids?: Record<string, string>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setPayrollRunId(data.payroll_run_id ?? null);
      setPayrollResults(data.results ?? []);
      setPayslipIds(data.payslip_ids ?? {});
      setRunState("complete");
      setRunMessage("Payroll run complete.");
    } catch (err) {
      setRunState("error");
      setRunMessage(`Run failed: ${(err as Error).message}`);
    }
  }

  // ── Download helpers ───────────────────────────────────────────────────────

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleDownloadPayslips(): Promise<void> {
    if (!payrollRunId) return;
    setDownloadingPayslips(true);
    setOutputError(null);

    try {
      // Download one PDF per employee sequentially.
      // payslipIds (employee_id → payslip DB id) was returned by the run route.
      for (const slip of payrollResults) {
        const emp = employees.find((e) => e.id === slip.employee_id);
        const payslipId = payslipIds[slip.employee_id];
        if (!payslipId) {
          throw new Error(`No payslip ID found for employee ${emp?.name ?? slip.employee_id}`);
        }

        const res = await fetch("/api/payroll/payslip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payslip_id: payslipId,
            schemaName,
            entity: { name: companyName, uen },
          }),
        });

        if (!res.ok) {
          const errData = await res.json() as { error?: string };
          throw new Error(errData.error ?? `HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const safeName = (emp?.name ?? slip.employee_id).replace(/[^a-z0-9_-]/gi, "_").slice(0, 30);
        const safeMonth = payrollMonth.slice(0, 7);
        triggerDownload(blob, `payslip-${safeName}-${safeMonth}.pdf`);

        // Small delay between downloads to avoid browser blocking
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      setOutputError(`Payslip download failed: ${(err as Error).message}`);
    } finally {
      setDownloadingPayslips(false);
    }
  }

  async function handleDownloadCPF(): Promise<void> {
    if (!payrollRunId) return;
    setDownloadingCPF(true);
    setOutputError(null);

    try {
      const res = await fetch("/api/payroll/export-cpf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payroll_run_id: payrollRunId,
          schemaName,
          entity: { name: companyName, uen },
        }),
      });

      if (!res.ok) {
        const errData = await res.json() as { error?: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const safeMonth = payrollMonth.slice(0, 7);
      triggerDownload(blob, `cpf-submit-${safeMonth}.csv`);
    } catch (err) {
      setOutputError(`CPF export failed: ${(err as Error).message}`);
    } finally {
      setDownloadingCPF(false);
    }
  }

  async function handleDownloadJournal(): Promise<void> {
    if (!payrollRunId) return;
    setDownloadingJournal(true);
    setOutputError(null);

    try {
      const res = await fetch("/api/payroll/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payroll_run_id: payrollRunId, schemaName }),
      });

      if (!res.ok) {
        const errData = await res.json() as { error?: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as object;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const safeMonth = payrollMonth.slice(0, 7);
      triggerDownload(blob, `payroll-journal-${safeMonth}.json`);
    } catch (err) {
      setOutputError(`Journal download failed: ${(err as Error).message}`);
    } finally {
      setDownloadingJournal(false);
    }
  }

  async function handleFinalise(): Promise<void> {
    if (!payrollRunId) return;
    setFinalising(true);
    setOutputError(null);

    try {
      const res = await fetch("/api/payroll/run", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaName, payroll_run_id: payrollRunId }),
      });

      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFinalised(true);
    } catch (err) {
      setOutputError(`Finalise failed: ${(err as Error).message}`);
    } finally {
      setFinalising(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Step navigation ── */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 flex-wrap">
            {([1, 2, 3] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                  step === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-primary/50"
                }`}
              >
                {s === 1 ? "1. Employee Setup" : s === 2 ? "2. Run Payroll" : "3. Download Outputs"}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* STEP 1: Employee Setup                                              */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 1 && (
        <>
          {/* Employee list */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Employees
                {loadingEmployees && (
                  <span className="ml-2 text-xs text-muted-foreground font-normal">Loading...</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {empError && (
                <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
                  <p className="text-xs text-destructive">{empError}</p>
                </div>
              )}
              {employees.length === 0 && !loadingEmployees ? (
                <p className="text-xs text-muted-foreground">
                  No employees yet. Add an employee using the form below.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left pb-2 pr-3">Name</th>
                        <th className="text-left pb-2 pr-3">NRIC/FIN</th>
                        <th className="text-left pb-2 pr-3">DOB</th>
                        <th className="text-left pb-2 pr-3">Citizenship</th>
                        <th className="text-right pb-2 pr-3">Salary (SGD)</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {employees.map((emp) => (
                        <tr key={emp.id} className="border-b last:border-0">
                          <td className="py-2 pr-3 font-medium">{emp.name}</td>
                          <td className="py-2 pr-3 text-muted-foreground font-mono">
                            {emp.nric_fin ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">{emp.dob}</td>
                          <td className="py-2 pr-3">
                            <Badge variant="outline" className="text-xs">
                              {CITIZENSHIP_LABELS[emp.citizenship as CitizenshipValue] ?? emp.citizenship}
                            </Badge>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono">
                            {emp.monthly_salary.toLocaleString("en-SG", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          <td className="py-2">
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs"
                                onClick={() => startEdit(emp)}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => void handleDeleteEmployee(emp.id ?? "")}
                              >
                                Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Add / edit form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                {editingId ? "Edit Employee" : "Add Employee"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Full Name *</Label>
                  <Input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Jane Tan"
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">NRIC / FIN (optional)</Label>
                  <Input
                    value={formNric}
                    onChange={(e) => setFormNric(e.target.value)}
                    placeholder="S1234567A"
                    className="text-sm font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Date of Birth *</Label>
                  <Input
                    type="date"
                    value={formDob}
                    onChange={(e) => setFormDob(e.target.value)}
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Monthly Salary (SGD) *</Label>
                  <Input
                    type="number"
                    value={formSalary}
                    onChange={(e) => setFormSalary(e.target.value)}
                    placeholder="5000"
                    className="text-sm"
                    min="0"
                    step="0.01"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Citizenship / PR Status *</Label>
                <Select
                  value={formCitizenship}
                  onValueChange={(v) => {
                    if (v != null) setFormCitizenship(v as CitizenshipValue);
                  }}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(CITIZENSHIP_LABELS) as [CitizenshipValue, string][]).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleSaveEmployee()}
                  disabled={formSaving}
                  className="text-sm"
                >
                  {formSaving ? "Saving..." : editingId ? "Update Employee" : "Save Employee"}
                </Button>
                {editingId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={resetForm}
                    className="text-sm"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Button
            className="w-full"
            onClick={() => setStep(2)}
            disabled={employees.length === 0}
          >
            Continue to Run Payroll →
          </Button>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* STEP 2: Run Payroll                                                 */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 2 && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Payroll Month</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  First day of payroll month (e.g. 2025-12-01)
                </Label>
                <Input
                  type="date"
                  value={payrollMonth}
                  onChange={(e) => setPayrollMonth(e.target.value)}
                  className="text-sm w-48"
                  disabled={runState === "complete"}
                />
              </div>
            </CardContent>
          </Card>

          {/* Per-employee table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Employee Wages for This Month</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Adjust OW and AW as needed. OW is prefilled from monthly salary.
                Allowances format: &quot;Transport 200, Housing 500&quot;
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left pb-2 pr-3">Employee</th>
                      <th className="text-right pb-2 pr-3">OW (SGD)</th>
                      <th className="text-right pb-2 pr-3">AW (SGD)</th>
                      <th className="text-left pb-2 pr-3">Allowances</th>
                      <th className="text-right pb-2">CPF Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp) => {
                      const row = rowData.find((r) => r.employee_id === emp.id);
                      const result = payrollResults.find((r) => r.employee_id === emp.id);
                      return (
                        <tr key={emp.id} className="border-b last:border-0">
                          <td className="py-2 pr-3 font-medium">{emp.name}</td>
                          <td className="py-2 pr-3">
                            <Input
                              type="number"
                              value={row?.ordinary_wages ?? ""}
                              onChange={(e) =>
                                updateRowData(emp.id ?? "", "ordinary_wages", e.target.value)
                              }
                              className="text-xs h-7 w-24 text-right"
                              disabled={runState === "complete"}
                              min="0"
                              step="0.01"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <Input
                              type="number"
                              value={row?.additional_wages ?? "0.00"}
                              onChange={(e) =>
                                updateRowData(emp.id ?? "", "additional_wages", e.target.value)
                              }
                              className="text-xs h-7 w-24 text-right"
                              disabled={runState === "complete"}
                              min="0"
                              step="0.01"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <Input
                              value={row?.allowances_text ?? ""}
                              onChange={(e) =>
                                updateRowData(emp.id ?? "", "allowances_text", e.target.value)
                              }
                              placeholder="Transport 200"
                              className="text-xs h-7 w-36"
                              disabled={runState === "complete"}
                            />
                          </td>
                          <td className="py-2 text-right font-mono text-muted-foreground">
                            {result
                              ? `Ee: $${result.employee_cpf} | Er: $${result.employer_cpf}`
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Run button and status */}
          {runState !== "complete" && (
            <Button
              className="w-full"
              onClick={() => void handleRunPayroll()}
              disabled={runState === "running" || employees.length === 0}
            >
              {runState === "running" ? runMessage : "Run Payroll ▶"}
            </Button>
          )}

          {runState === "error" && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2">
              <p className="text-xs text-destructive">{runMessage}</p>
            </div>
          )}

          {/* Results table */}
          {runState === "complete" && payrollResults.length > 0 && (
            <>
              <Separator />
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">
                    Payroll Results — {payrollMonth.slice(0, 7)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left pb-2 pr-3">Employee</th>
                          <th className="text-right pb-2 pr-3">Gross Pay</th>
                          <th className="text-right pb-2 pr-3">Ee CPF</th>
                          <th className="text-right pb-2 pr-3">Er CPF</th>
                          <th className="text-right pb-2 pr-3">SDL</th>
                          <th className="text-right pb-2">Net Pay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payrollResults.map((result) => {
                          const emp = employees.find((e) => e.id === result.employee_id);
                          const grossPay = (
                            parseFloat(result.ordinary_wages) +
                            parseFloat(result.additional_wages)
                          ).toFixed(2);
                          return (
                            <tr key={result.employee_id} className="border-b last:border-0">
                              <td className="py-2 pr-3 font-medium">{emp?.name ?? result.employee_id}</td>
                              <td className="py-2 pr-3 text-right font-mono">${grossPay}</td>
                              <td className="py-2 pr-3 text-right font-mono">${result.employee_cpf}</td>
                              <td className="py-2 pr-3 text-right font-mono">${result.employer_cpf}</td>
                              <td className="py-2 pr-3 text-right font-mono">${result.sdl}</td>
                              <td className="py-2 text-right font-mono font-semibold">${result.net_pay}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Button className="w-full" onClick={() => setStep(3)}>
                Continue to Download Outputs →
              </Button>
            </>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* STEP 3: Download Outputs                                            */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 3 && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Payroll Outputs — {payrollMonth.slice(0, 7)}
                {finalised && (
                  <Badge className="ml-2 text-xs" variant="outline">
                    Finalised
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {outputError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
                  <p className="text-xs text-destructive">{outputError}</p>
                </div>
              )}

              {!payrollRunId && (
                <p className="text-xs text-muted-foreground">
                  No payroll run found. Go back to Step 2 and run payroll first.
                </p>
              )}

              <div className="space-y-2">
                {/* Download All Payslips */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">All Payslips (PDF)</p>
                    <p className="text-xs text-muted-foreground">
                      One PDF per employee — MOM compliant
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!payrollRunId || downloadingPayslips || finalised}
                    onClick={() => void handleDownloadPayslips()}
                  >
                    {downloadingPayslips ? "Downloading..." : "Download"}
                  </Button>
                </div>

                <Separator />

                {/* CPF Submission File */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">CPF e-Submit File (CSV)</p>
                    <p className="text-xs text-muted-foreground">
                      Due: 14th of following month
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!payrollRunId || downloadingCPF}
                    onClick={() => void handleDownloadCPF()}
                  >
                    {downloadingCPF ? "Exporting..." : "Download"}
                  </Button>
                </div>

                <Separator />

                {/* Journal Entries */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Payroll Journal Entries (JSON)</p>
                    <p className="text-xs text-muted-foreground">
                      5 double-entry bookkeeping entries
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!payrollRunId || downloadingJournal}
                    onClick={() => void handleDownloadJournal()}
                  >
                    {downloadingJournal ? "Generating..." : "Download"}
                  </Button>
                </div>

                <Separator />

                {/* FWL reminder */}
                <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    Foreign Worker Levy (FWL)
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                    FWL is not computed automatically. If you have Work Permit or S Pass
                    holders, please refer to the MOM levy schedule for your sector and
                    compute the levy manually.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Finalise */}
          {!finalised && payrollRunId && (
            <Button
              className="w-full"
              variant="outline"
              onClick={() => void handleFinalise()}
              disabled={finalising}
            >
              {finalising ? "Finalising..." : "Finalise Payroll — Lock This Run"}
            </Button>
          )}

          {finalised && (
            <div className="rounded-md border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 px-4 py-3">
              <p className="text-sm font-medium text-green-800 dark:text-green-200">
                Payroll Finalised
              </p>
              <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">
                This payroll run is locked. No further edits can be made.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
