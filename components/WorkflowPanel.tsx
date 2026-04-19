/**
 * components/WorkflowPanel.tsx
 *
 * Left panel of the main FinAgent-SG page.
 *
 * Phase 2: Fully wired — file upload, configuration, SSE progress streaming,
 * and PDF/XBRL download buttons.
 *
 * Event flow:
 * 1. User uploads a .xlsx trial balance file (file stored in component state as base64)
 * 2. User fills in configuration (FYE date, company info, exemption inputs)
 * 3. User clicks "Generate" — POST to /api/generate-fs with file + config
 * 4. The route returns an SSE stream; each event updates the Progress Panel in real time
 * 5. On complete: the final SSE event includes fs_output; download buttons are enabled
 * 6. "Download PDF" triggers POST to /api/generate-pdf and downloads the file
 *
 * Step statuses: "pending" | "in_progress" | "complete" | "error"
 */

"use client";

import { useState, useRef, useEffect } from "react";
import type { ClientSummary } from "@/app/api/clients/route";
import type { ClientDetail } from "@/app/api/clients/[id]/route";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { FSPreview } from "@/components/FSPreview";
import { ModelWorkflow } from "@/components/ModelWorkflow";
import { PayrollWorkflow } from "@/components/PayrollWorkflow";
import { TaxWorkflow } from "@/components/TaxWorkflow";
import { generateSchemaName } from "@/lib/schemaUtils";

// The four task types the system supports (Phases 2, 3, 4, 7)
type Task = "financial_statements" | "financial_model" | "payroll" | "corporate_tax";

// Progress step statuses
type StepStatus = "pending" | "in_progress" | "complete" | "error";

type ProgressStep = {
  key: string;
  label: string;
  status: StepStatus;
  message: string;
};

// The full set of pipeline steps shown in the Progress Panel
const INITIAL_STEPS: ProgressStep[] = [
  { key: "parse_excel", label: "Trial balance parsed", status: "pending", message: "" },
  { key: "classify_accounts", label: "Accounts classified per SFRS", status: "pending", message: "" },
  { key: "check_exemption", label: "Audit exemption checked", status: "pending", message: "" },
  { key: "generate_fs", label: "Financial statements generated", status: "pending", message: "" },
  { key: "save_output", label: "Saved to database", status: "pending", message: "" },
  { key: "complete", label: "Ready for download", status: "pending", message: "" },
];

interface WorkflowPanelProps {
  onSchemaNameChange?: (schemaName: string) => void;
}

export function WorkflowPanel({ onSchemaNameChange }: WorkflowPanelProps = {}) {
  const [selectedTask, setSelectedTask] = useState<Task>("financial_statements");

  // ── Client selector state (Phase 6) ───────────────────────────────────────
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  // entityId and fiscalYearId are loaded from the selected client; no longer hardcoded
  const [entityId, setEntityId] = useState<string>("");
  const [fiscalYearId, setFiscalYearId] = useState<string>("");

  // Load clients list on mount
  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then((d) => { if (d.clients) setClients(d.clients); })
      .catch(() => {/* non-fatal — user can still type manually */});
  }, []);

  // When a client is selected from the dropdown, pre-populate fields and load IDs
  async function handleClientSelect(clientId: string) {
    setSelectedClientId(clientId);
    if (!clientId) {
      setEntityId("");
      setFiscalYearId("");
      return;
    }
    try {
      const res = await fetch(`/api/clients/${clientId}`);
      const data: { client: ClientDetail } = await res.json();
      if (!res.ok || !data.client) return;
      const c = data.client;
      setCompanyName(c.name);
      setUen(c.uen);
      setFyeDate(c.fye_date);
      setEntityId(c.entity_id ?? "");
      setFiscalYearId(c.latest_fiscal_year_id ?? "");
      onSchemaNameChange?.(c.schema_name);
    } catch {/* non-fatal */}
  }

  // ── File upload state ──────────────────────────────────────────────────────
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Configuration state ────────────────────────────────────────────────────
  const [companyName, setCompanyName] = useState("");
  const [uen, setUen] = useState("");
  const [fyeDate, setFyeDate] = useState("2025-12-31");
  const [revenue, setRevenue] = useState("0");
  const [totalAssets, setTotalAssets] = useState("0");
  const [employeeCount, setEmployeeCount] = useState("0");
  const [shareholderCount, setShareholderCount] = useState("1");
  const [hasCorporateShareholders, setHasCorporateShareholders] = useState(false);

  // ── Generation state ───────────────────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false);
  const [steps, setSteps] = useState<ProgressStep[]>(INITIAL_STEPS);
  const [error, setError] = useState<string | null>(null);

  // ── Output state ───────────────────────────────────────────────────────────
  // fsOutput and outputReady are set when the final SSE "complete" event arrives
  const [fsOutput, setFsOutput] = useState<Record<string, unknown> | null>(null);
  const [outputReady, setOutputReady] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // ── File upload handler ────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0] ?? null;
    setUploadedFile(file);
    // Reset any previous generation output when a new file is selected
    setSteps(INITIAL_STEPS);
    setFsOutput(null);
    setOutputReady(false);
    setError(null);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0] ?? null;
    if (file && (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv"))) {
      setUploadedFile(file);
      setSteps(INITIAL_STEPS);
      setFsOutput(null);
      setOutputReady(false);
      setError(null);
    }
  }

  // ── Step status update helper ──────────────────────────────────────────────

  function updateStep(key: string, status: StepStatus, message: string): void {
    setSteps((prev) =>
      prev.map((s) => (s.key === key ? { ...s, status, message } : s))
    );
  }

  // ── Generate handler ───────────────────────────────────────────────────────

  async function handleGenerate(): Promise<void> {
    // Validate: file must be uploaded and FYE date must be set
    if (!uploadedFile) {
      setError("Please upload a trial balance Excel file before generating.");
      return;
    }
    if (!companyName.trim()) {
      setError("Please enter the company name.");
      return;
    }
    if (!fyeDate) {
      setError("Please set the FYE date.");
      return;
    }

    setError(null);
    setIsGenerating(true);
    setOutputReady(false);
    setFsOutput(null);
    setSteps(INITIAL_STEPS);

    // Convert the uploaded file to base64 for transmission in the request body
    const fileBuffer = await uploadedFile.arrayBuffer();
    const base64 = Buffer.from(fileBuffer).toString("base64");

    // Build the request body — entity, fiscal_year, exemption_input, and the file
    const startDate = `${fyeDate.slice(0, 4)}-01-01`; // approximate start as Jan 1 of same year
    const requestBody = {
      entity_id: entityId || undefined,
      fiscal_year_id: fiscalYearId || undefined,
      file_data: base64,
      file_name: uploadedFile.name,
      entity: {
        name: companyName.trim(),
        uen: uen.trim() || "202500001A",
        company_type: "private_ltd",
        fye_date: fyeDate,
        audit_exempt: false, // will be determined by exemption check
      },
      fiscal_year: {
        entity_id: entityId || undefined,
        start_date: startDate,
        end_date: fyeDate,
        status: "in_progress",
      },
      exemption_input: {
        revenue: parseFloat(revenue) || 0,
        total_assets: parseFloat(totalAssets) || 0,
        employee_count: parseInt(employeeCount) || 0,
        has_corporate_shareholders: hasCorporateShareholders,
        shareholder_count: parseInt(shareholderCount) || 1,
      },
    };

    try {
      // POST to /api/generate-fs — this returns an SSE stream
      const response = await fetch("/api/generate-fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      // Connect to the SSE stream and read events
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are delimited by double newlines: "data: {...}\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? ""; // keep any incomplete trailing chunk

        for (const rawEvent of events) {
          const line = rawEvent.trim();
          if (!line.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(line.slice(6)) as {
              step: string;
              status: StepStatus;
              message: string;
              timestamp: string;
              fs_output?: Record<string, unknown>;
              exemption_result?: Record<string, unknown>;
            };

            // Update the corresponding step in the Progress Panel
            updateStep(event.step, event.status, event.message);

            // When the pipeline completes, capture the output and enable downloads
            if (event.step === "complete" && event.status === "complete") {
              if (event.fs_output) {
                setFsOutput(event.fs_output);
              }
              setOutputReady(true);
              setIsGenerating(false);
            }

            // On error, stop generating
            if (event.status === "error") {
              setError(event.message);
              setIsGenerating(false);
            }
          } catch {
            // Ignore malformed SSE events
          }
        }
      }
    } catch (err) {
      setError(`Generation failed: ${(err as Error).message}`);
      setIsGenerating(false);
    }
  }

  // ── PDF download handler ───────────────────────────────────────────────────

  async function handleDownloadPDF(): Promise<void> {
    if (!fsOutput) return;

    const requestBody = {
      entity: {
        name: companyName.trim(),
        uen: uen.trim() || "202500001A",
        company_type: "private_ltd",
        fye_date: fyeDate,
        audit_exempt: false,
      },
      fiscal_year: {
        entity_id: entityId || undefined,
        start_date: `${fyeDate.slice(0, 4)}-01-01`,
        end_date: fyeDate,
        status: "in_progress",
      },
      fs_output: fsOutput,
    };

    try {
      const response = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);

      // Trigger browser file download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `financial-statements-${fyeDate}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`PDF download failed: ${(err as Error).message}`);
    }
  }

  // ── XBRL download handler ──────────────────────────────────────────────────
  // Downloads the XBRL tags as a JSON file (full XBRL XML generation is Phase 3+)

  function handleDownloadXBRL(): void {
    if (!fsOutput) return;
    const xbrlData = fsOutput.xbrl_tags ?? {};
    const blob = new Blob([JSON.stringify(xbrlData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `xbrl-tags-${fyeDate}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Validation: can generate? ──────────────────────────────────────────────
  const canGenerate =
    selectedTask === "financial_statements" &&
    uploadedFile !== null &&
    companyName.trim().length > 0 &&
    fyeDate.length > 0 &&
    !isGenerating;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-3 md:p-6 space-y-6">

      {/* ── 1. Task Selector ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Select Task</CardTitle>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={selectedTask}
            onValueChange={(v) => setSelectedTask(v as Task)}
            className="space-y-2"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="financial_statements" id="task-fs" />
              <Label htmlFor="task-fs">Prepare Financial Statements</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="financial_model" id="task-fm" />
              <Label htmlFor="task-fm">Build / Update Financial Model</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="payroll" id="task-payroll" />
              <Label htmlFor="task-payroll">Process Payroll</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="corporate_tax" id="task-tax" />
              <Label htmlFor="task-tax">Corporate Tax Computation</Label>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      {/* ── 1b. Company (always visible — shared by all tasks) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Company</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Client selector dropdown — populated from /api/clients */}
          {clients.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Select Client</Label>
              <select
                value={selectedClientId}
                onChange={(e) => handleClientSelect(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="">— type manually or select a client —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.uen})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Company Name</Label>
            <Input
              value={companyName}
              onChange={(e) => { setCompanyName(e.target.value); onSchemaNameChange?.(generateSchemaName(e.target.value.trim() || "company")); }}
              placeholder="ABC Pte Ltd"
              className="text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Model Workflow (financial_model task) ── */}
      {selectedTask === "financial_model" && (
        <ModelWorkflow
          schemaName={generateSchemaName(companyName.trim() || "company")}
          companyName={companyName.trim()}
          entityId={entityId}
          fiscalYearId={fiscalYearId}
          isAuditExempt={false}
        />
      )}

      {/* ── Payroll Workflow (payroll task) ── */}
      {selectedTask === "payroll" && (
        <PayrollWorkflow
          schemaName={generateSchemaName(companyName.trim() || "company")}
          companyName={companyName.trim()}
          entityId={entityId}
          uen={uen.trim() || "202500001A"}
        />
      )}

      {/* ── Tax Workflow (corporate_tax task) ── */}
      {selectedTask === "corporate_tax" && (
        <TaxWorkflow
          schemaName={generateSchemaName(companyName.trim() || "company")}
          companyName={companyName.trim()}
          entityId={entityId}
          fiscalYearId={fiscalYearId}
          uen={uen.trim() || "202500001A"}
          fyeDate={fyeDate}
        />
      )}

      {/* ── FS-specific sections (hidden when financial_model task is selected) ── */}
      {selectedTask === "financial_statements" && (
        <>
          {/* ── 2. File Upload Zone ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Upload Trial Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center hover:border-muted-foreground/50 transition-colors cursor-pointer"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadedFile ? (
                  <div>
                    <p className="text-sm font-medium text-foreground">{uploadedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {(uploadedFile.size / 1024).toFixed(1)} KB — click to replace
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-muted-foreground">Drag &amp; Drop Excel / CSV here</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Supported: .xlsx .xls .csv</p>
                  </div>
                )}
                <Button variant="outline" size="sm" className="mt-3 min-h-[44px]" type="button">
                  Browse Files
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileChange}
              />
            </CardContent>
          </Card>

          {/* ── 3. Configuration Form ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Configure</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">UEN (optional)</Label>
                <Input
                  value={uen}
                  onChange={(e) => setUen(e.target.value)}
                  placeholder="202500001A"
                  className="text-sm font-mono"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">FYE Date</Label>
                <Input
                  type="date"
                  value={fyeDate}
                  onChange={(e) => setFyeDate(e.target.value)}
                  className="text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Annual Revenue (SGD)</Label>
                <Input
                  type="number"
                  value={revenue}
                  onChange={(e) => setRevenue(e.target.value)}
                  placeholder="0"
                  className="text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Total Assets (SGD)</Label>
                <Input
                  type="number"
                  value={totalAssets}
                  onChange={(e) => setTotalAssets(e.target.value)}
                  placeholder="0"
                  className="text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Employee Count</Label>
                <Input
                  type="number"
                  value={employeeCount}
                  onChange={(e) => setEmployeeCount(e.target.value)}
                  placeholder="0"
                  className="text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Number of Shareholders</Label>
                <Input
                  type="number"
                  value={shareholderCount}
                  onChange={(e) => setShareholderCount(e.target.value)}
                  placeholder="1"
                  className="text-sm"
                />
              </div>

              <div className="flex items-center gap-2 min-h-[44px]">
                <input
                  id="corp-shareholders"
                  type="checkbox"
                  checked={hasCorporateShareholders}
                  onChange={(e) => setHasCorporateShareholders(e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="corp-shareholders" className="text-xs text-muted-foreground cursor-pointer">
                  Has corporate shareholders (affects EPC status)
                </Label>
              </div>

            </CardContent>
          </Card>

          {/* ── Error display ── */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {/* ── 4. Generate Button ── */}
          <Button
            className="w-full"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            {isGenerating ? "Generating..." : "Generate ▶"}
          </Button>

          <Separator />

          {/* ── 5. Progress Panel ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {steps.map((step) => (
                  <div key={step.key} className="flex items-start gap-2">
                    <span className={
                      step.status === "complete"    ? "text-green-500 mt-0.5" :
                      step.status === "in_progress" ? "text-blue-500 mt-0.5 animate-pulse" :
                      step.status === "error"       ? "text-destructive mt-0.5" :
                      "text-muted-foreground/40 mt-0.5"
                    }>
                      {step.status === "complete"    ? "✓" :
                       step.status === "in_progress" ? "◐" :
                       step.status === "error"       ? "✗" : "○"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${step.status === "pending" ? "text-muted-foreground" : "text-foreground"}`}>
                        {step.label}
                      </p>
                      {step.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate" title={step.message}>
                          {step.message}
                        </p>
                      )}
                    </div>
                    {step.status === "in_progress" && (
                      <Badge variant="outline" className="text-xs shrink-0">Running</Badge>
                    )}
                    {step.status === "complete" && (
                      <Badge variant="outline" className="text-xs shrink-0 text-green-600 border-green-200">Done</Badge>
                    )}
                    {step.status === "error" && (
                      <Badge variant="destructive" className="text-xs shrink-0">Error</Badge>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* ── 6. Output Panel ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Output</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!outputReady}
                    onClick={() => setPreviewOpen(true)}
                  >
                    Preview
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!outputReady}
                    onClick={handleDownloadPDF}
                  >
                    Download PDF
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!outputReady}
                    onClick={handleDownloadXBRL}
                  >
                    XBRL
                  </Button>
                </div>
                {!outputReady && (
                  <p className="text-xs text-muted-foreground">
                    Generate financial statements to enable downloads.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── FS Preview Modal ── */}
          {fsOutput && (
            <FSPreview
              open={previewOpen}
              onClose={() => setPreviewOpen(false)}
              fsOutput={fsOutput}
              companyName={companyName.trim()}
              fyeDate={fyeDate}
            />
          )}
        </>
      )}

    </div>
  );
}
