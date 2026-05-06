/**
 * lib/agents/nodes/index.ts
 *
 * Barrel export for all seven LangGraph node functions in the FinAgent-SG graph.
 * Each node reads from and writes to the shared GraphState defined in state.ts.
 *
 * Architecture:
 * - validationNode  — pure TypeScript; no external calls; runs first as a guard
 * - managerNode     — LLM call (GPT-4.1) to parse the user goal and set run flags
 * - worker nodes    — make internal HTTP POST calls to the thin wrapper routes
 * - summaryNode     — pure TypeScript; assembles a plain-English summary
 *
 * Workers call internal routes (not SSE routes) so they can await plain JSON.
 * The wrapper routes handle all Supabase lookups and engine calls internally.
 *
 * clientId convention:
 * Throughout the agent layer, clientId is the schema name slug
 * (e.g. "techsoft_pte_ltd"). It is set by the graph caller at invoke time.
 */

import { generateText, tool } from "ai";           // tool() defines typed tool schemas for managerNode
import { openai } from "@ai-sdk/openai";
import { z } from "zod";                             // Zod schemas used in tool parameter definitions below
import { MODEL_ROUTES } from "@/lib/modelRouter";
import { supabase } from "@/lib/supabaseClient";  // used by taxNode and financialModelNode Supabase fallback
import { GraphState } from "../state";
import { writeVaultNote } from "@/lib/agents/vaultWriter";   // V3.1-A: writes a markdown run note to the local vault
import { getRecentVaultNotes } from "@/lib/agents/vaultReader"; // V3.1-B: reads recent notes for context injection

// Shorthand: the full inferred state type from the LangGraph Annotation
type State = typeof GraphState.State;

// Shorthand: what nodes return — a partial update (only changed fields needed)
type NodeReturn = Partial<State>;

// Base URL for internal HTTP calls to the thin wrapper routes.
// NEXTAUTH_URL is set to the app's canonical URL in both dev and production.
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

// Short month names used by formatSavedDate — avoids locale-dependent toLocaleString output
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Formats a Supabase ISO timestamp string as "D MMM YYYY" (e.g. "3 May 2026").
 * Used in fetchedContext entries so the user can see when saved data was last written.
 * Uses UTC interpretation to avoid timezone-shift surprises on the server.
 */
function formatSavedDate(isoString: string): string {
  const d = new Date(isoString);               // parse the ISO 8601 timestamp
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ─── Node 1: Validation Node ─────────────────────────────────────────────────

/**
 * Pure TypeScript guard — Supabase read only, no LLM call.
 * Checks that all inputs required by the flagged workflows are present in state,
 * and for the FS workflow also verifies that a prior UI-run FS output exists in
 * Supabase for the requested fiscal year (the agent cannot parse Excel, so it
 * depends on the user having run FS generation from the UI at least once).
 * Populates state.missingInputs if anything is absent; graph routes to END if so.
 * If everything is present, returns unchanged state and graph continues to manager.
 */
export async function validationNode(state: State): Promise<NodeReturn> {
  const missing: string[] = [];

  // clientId must always be present — it scopes all Supabase queries
  if (!state.clientId) {
    missing.push("clientId");
  }

  // Check each workflow's required temporal parameters only when that workflow is flagged.
  // Flags set to false (the default) skip their check — caller must set them intentionally.
  if (state.runFS && !state.financialYear) {
    missing.push("financialYear");  // FS pipeline needs the target fiscal year
  }

  if (state.runPayroll) {
    // Payroll needs both month (1–12) and year — both must be present
    if (!state.payrollMonth) missing.push("payrollMonth");
    if (!state.payrollYear)  missing.push("payrollYear");
  }

  if (state.runTax && !state.yearOfAssessment) {
    missing.push("yearOfAssessment");  // Tax engine needs e.g. "YA2026"
  }

  if (state.runFinancialModel && !state.projectionPeriodYears) {
    missing.push("projectionPeriodYears");  // Model engine needs how many years to project
  }

  // ── FS hard constraint: verify a prior UI-run FS output exists in Supabase ──
  // This check only runs when:
  //   (a) runFS is true, AND
  //   (b) financialYear is already present (otherwise "financialYear" is already in
  //       missing and there is no point querying Supabase with an undefined year), AND
  //   (c) clientId is present (Supabase queries are scoped to the client schema).
  // The agent cannot parse an Excel trial balance — it re-runs AI generation using
  // classified_accounts saved by a prior UI-initiated run. If no such output exists,
  // dispatch would fail inside financialStatementNode with a confusing HTTP 400.
  // Blocking here gives the user a clear, actionable message before any worker runs.
  if (state.runFS && state.financialYear && state.clientId) {
    // Step 1: find the fiscal_years row whose end_date falls in the requested year.
    // Mirror the exact query used by /api/financial-statements/generate/route.ts.
    const { data: fyRows } = await supabase
      .schema(state.clientId)
      .from("fiscal_years")
      .select("id")
      .gte("end_date", `${state.financialYear}-01-01`)   // end date ≥ Jan 1 of the year
      .lte("end_date", `${state.financialYear}-12-31`);  // end date ≤ Dec 31 of the year

    const fyRow = fyRows && fyRows.length > 0 ? fyRows[0] : null;

    if (!fyRow) {
      // No fiscal year row at all — FS has never been set up for this calendar year
      missing.push(
        `Financial Statement data for FY${state.financialYear} — please run the Financial Statement workflow manually first to upload your trial balance, then try again`
      );
    } else {
      // Step 2: check that at least one FS output row exists for this fiscal year.
      // Mirror the query from the wrapper route: output_type + fiscal_year_id match.
      const { data: outputRow } = await supabase
        .schema(state.clientId)
        .from("outputs")
        .select("id")
        .eq("output_type", "financial_statements")
        .eq("fiscal_year_id", (fyRow as { id: string }).id)  // must match the specific FY
        .limit(1)
        .maybeSingle();  // returns null (not an error) when no row exists

      if (!outputRow) {
        // Fiscal year exists but no FS output has been saved — UI run required first
        missing.push(
          `Financial Statement data for FY${state.financialYear} — please run the Financial Statement workflow manually first to upload your trial balance, then try again`
        );
      }
    }
  }

  if (missing.length > 0) {
    // Write the list and stop — the conditional edge routes to END on non-empty array
    return { missingInputs: missing };
  }

  // All inputs present — clear any stale missing list and let the graph continue
  return { missingInputs: [] };
}

// ─── Tool definitions (used by managerNode) ──────────────────────────────────
// Defined at module scope so they are not recreated on each managerNode call.
// No execute functions — tool calls are dispatched manually from result.toolCalls.

// Triggers financial statement generation; args carry the target fiscal year
const runFinancialStatementTool = tool({
  description:
    "Trigger financial statement generation for a client. Use when the user wants to " +
    "prepare, generate, or create financial statements or a trial balance for a specific financial year.",
  inputSchema: z.object({
    financialYear: z.string().describe("The financial year e.g. '2025'"),
  }),
});

// Triggers payroll processing; args carry month (1–12) and year
const runPayrollTool = tool({
  description:
    "Trigger payroll processing for a client. Use when the user wants to run, process, " +
    "or generate payroll or CPF contributions for a specific month and year.",
  inputSchema: z.object({
    payrollMonth: z.number().min(1).max(12).describe("Month as number 1-12"),
    payrollYear:  z.number().describe("Year e.g. 2026"),
  }),
});

// Triggers corporate tax computation; args carry the year of assessment string
const computeTaxTool = tool({
  description:
    "Trigger corporate tax computation for a client. Use when the user wants to compute, " +
    "calculate, or prepare corporate tax or Form C for a specific year of assessment.",
  inputSchema: z.object({
    yearOfAssessment: z.string().describe("Year of assessment e.g. 'YA2026'"),
  }),
});

// Triggers financial model projection; args carry how many years to project
const generateFinancialModelTool = tool({
  description:
    "Trigger financial model and projection generation for a client. Use when the user wants " +
    "to generate, create, or build a financial model, projections, scenarios, or forecasts.",
  inputSchema: z.object({
    projectionPeriodYears: z.number().min(1).max(10).describe("Number of years to project e.g. 3 or 5"),
  }),
});

// Action tool — requires user confirmation; adds a new employee record
const addEmployeeTool = tool({
  description:
    "Add a new employee record for the client. Use when the user wants to add, create, or " +
    "register a new employee. Requires confirmation before executing.",
  inputSchema: z.object({
    name:          z.string().describe("Full name of the employee"),
    dob:           z.string().describe("Date of birth in YYYY-MM-DD format"),
    citizenship:   z.enum(["Singapore Citizen", "Singapore PR", "Foreigner"])
                     .describe("Citizenship status"),
    monthlySalary: z.number().describe("Monthly salary in SGD"),
    nricFin:       z.string().optional().describe("NRIC or FIN number if provided"),
  }),
});

// Action tool — requires user confirmation; updates an existing employee record
const updateEmployeeTool = tool({
  description:
    "Update an existing employee record. Use when the user wants to update, change, or " +
    "modify an employee's details. Requires confirmation before executing.",
  inputSchema: z.object({
    employeeId:    z.string().describe("UUID of the employee to update"),
    name:          z.string().optional(),
    dob:           z.string().optional().describe("Date of birth in YYYY-MM-DD format"),
    citizenship:   z.enum(["Singapore Citizen", "Singapore PR", "Foreigner"]).optional(),
    monthlySalary: z.number().optional(),
    nricFin:       z.string().optional(),
  }),
});

// Action tool — requires user confirmation; creates a new client record
const addClientTool = tool({
  description:
    "Create a new client. Use when the user wants to add, register, or onboard a new company " +
    "as a client. Requires confirmation before executing.",
  inputSchema: z.object({
    companyName:  z.string().describe("Full company name"),
    uen:          z.string().describe("UEN number"),
    companyType:  z.string().describe("Company type e.g. 'Private Limited'"),
    fyeDate:      z.string().describe("Financial year end date in YYYY-MM-DD format"),
    auditExempt:  z.boolean().describe("Whether the company is audit exempt"),
  }),
});

// Action tool — requires user confirmation; overrides profit/revenue used in tax computation
const configureTaxTool = tool({
  description:
    "Override the accounting profit and/or revenue used for tax computation. Use when the user " +
    "wants to set, override, or configure the accounting profit or annual revenue for tax purposes. " +
    "Requires confirmation before executing.",
  inputSchema: z.object({
    accountingProfitOverride: z.number().optional()
      .describe("Override value for accounting profit in SGD"),
    revenueOverride:          z.number().optional()
      .describe("Override value for annual revenue in SGD"),
  }),
});

// ─── buildDescription helper ──────────────────────────────────────────────────

/**
 * Builds a plain-English description of a confirmation-required action tool call.
 * This string is shown in the ConfirmationCard so the user understands what they
 * are approving before any data is written to Supabase.
 */
function buildDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "add_employee": {
      // Cast to the known add_employee arg shape
      const a = args as { name: string; citizenship: string; dob: string; monthlySalary: number };
      return `Add employee ${a.name}, ${a.citizenship}, DOB ${a.dob}, monthly salary SGD ${a.monthlySalary}`;
    }
    case "update_employee": {
      // Show the employee ID plus all fields the caller wants to change
      const a = args as { employeeId: string };
      const changedFields = Object.entries(args)
        .filter(([k]) => k !== "employeeId")          // exclude the ID itself from the change list
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      return `Update employee ${a.employeeId} with: ${changedFields}`;
    }
    case "add_client": {
      const a = args as { companyName: string; uen: string; fyeDate: string; auditExempt: boolean };
      return `Create new client ${a.companyName} (UEN: ${a.uen}), FYE ${a.fyeDate}, audit exempt: ${String(a.auditExempt)}`;
    }
    case "configure_tax": {
      const a = args as { accountingProfitOverride?: number; revenueOverride?: number };
      // Show "unchanged" when the field was omitted rather than a misleading SGD 0
      const profit  = a.accountingProfitOverride !== undefined ? `SGD ${a.accountingProfitOverride}` : "unchanged";
      const revenue = a.revenueOverride          !== undefined ? `SGD ${a.revenueOverride}`          : "unchanged";
      return `Set tax override — accounting profit: ${profit}, revenue: ${revenue}`;
    }
    default:
      // Fallback for any future action tool not yet handled here
      return `Execute ${toolName}`;
  }
}

// ─── Node 2: Manager Node ────────────────────────────────────────────────────

/**
 * Parses the user's natural language goal using GPT-4.1 tool calling and writes
 * the resulting run flags and temporal parameters back into graph state.
 * Replaces the previous manual JSON-parsing approach with native Vercel AI SDK
 * tool calling — the LLM calls one or more tools in a single pass to handle
 * multi-intent goals (e.g. "run payroll and tax"). Action tools that require
 * user confirmation write a pendingAction to state instead of executing directly.
 */
export async function managerNode(state: State): Promise<NodeReturn> {
  // ── V3.1: Read recent vault notes for this client ────────────────────────
  // Returns "" if vault is unavailable or the client has no prior notes — safe
  // to call unconditionally. The string is injected into the system prompt below.
  const recentNotes = await getRecentVaultNotes(state.clientId, 5);

  // Single log line — shows whether vault context was injected without logging note content
  console.log(
    `[managerNode] vault context for ${state.clientId}:`,
    recentNotes ? `${recentNotes.length} chars loaded` : "empty — no prior runs"
  );

  // ── V3.2-A: Tool-calling system prompt ──────────────────────────────────
  // Instructs the LLM to call tools (not return JSON) — multi-intent goals can
  // trigger multiple tool calls in a single pass (e.g. run_payroll + compute_tax).
  const systemPrompt =
    "You are a compliance workflow manager for a Singapore private limited company accounting system. " +
    "Given a user goal, call the appropriate tools to fulfil the request. You may call multiple tools if the goal requires it.\n" +
    "Call tools in logical order — if financial statements are needed before tax, call run_financial_statement before compute_tax.\n" +
    "For tools that require confirmation (add_employee, update_employee, add_client, configure_tax), call them and they will be queued " +
    "for user confirmation before execution." +
    (recentNotes ? "\n\nHere are the last runs for this client:\n\n" + recentNotes : "");

  // ── Accumulators — populated by iterating over result.toolCalls ──────────
  // Workflow flags: may be set by multiple tool calls (e.g. payroll + tax in one pass)
  let runFS             = false;
  let runPayroll        = false;
  let runTax            = false;
  let runFinancialModel = false;
  // Temporal parameters: set by the matching workflow tool call
  let financialYear:         string | undefined;
  let payrollMonth:          number | undefined;
  let payrollYear:           number | undefined;
  let yearOfAssessment:      string | undefined;
  let projectionPeriodYears: number | undefined;
  // Action tool result: only the first action tool call is queued (sequential confirmation)
  let pendingAction: { tool: string; params: Record<string, unknown>; description: string } | undefined;

  try {
    // ── Call GPT-4.1 with all 8 tools; LLM decides which ones to invoke ──────
    // maxSteps: 5 allows the model up to 5 sequential passes if it needs to
    // chain tool calls, though in practice a single pass covers all use cases.
    const result = await generateText({
      model:  openai(MODEL_ROUTES.fs_generation),  // "gpt-4.1" — accuracy-critical routing
      system: systemPrompt,
      prompt: state.goal,                           // the user's natural language goal
      tools: {
        run_financial_statement: runFinancialStatementTool,
        run_payroll:             runPayrollTool,
        compute_tax:             computeTaxTool,
        generate_financial_model: generateFinancialModelTool,
        add_employee:            addEmployeeTool,
        update_employee:         updateEmployeeTool,
        add_client:              addClientTool,
        configure_tax:           configureTaxTool,
      },
    });

    // ── Process each tool call the LLM made ──────────────────────────────────
    // toolCalls is an array; the LLM may call zero, one, or many tools per pass.
    // input (not args) is the field name in Vercel AI SDK v6.

    // Skip action tools on re-invocation after confirmation — pendingActionConfirmed
    // is set to true by /api/agent/confirm so managerNode does not re-queue the same
    // action (e.g. add_employee) when the goal also includes a workflow (run_payroll).
    // Workflow tool calls (run_payroll, etc.) are processed normally regardless.
    const skipActionTools = state.pendingActionConfirmed === true;

    for (const toolCall of result.toolCalls) {
      const toolName = toolCall.toolName as string;          // which tool was called
      const input    = toolCall.input as Record<string, unknown>;  // its typed arguments

      if (toolName === "run_financial_statement") {
        // Map FS tool input → graph state flags
        runFS         = true;
        financialYear = (input as { financialYear: string }).financialYear;

      } else if (toolName === "run_payroll") {
        // Map payroll tool input → graph state flags
        runPayroll   = true;
        payrollMonth = (input as { payrollMonth: number; payrollYear: number }).payrollMonth;
        payrollYear  = (input as { payrollMonth: number; payrollYear: number }).payrollYear;

      } else if (toolName === "compute_tax") {
        // Map tax tool input → graph state flags
        runTax            = true;
        yearOfAssessment  = (input as { yearOfAssessment: string }).yearOfAssessment;

      } else if (toolName === "generate_financial_model") {
        // Map financial model tool input → graph state flags
        runFinancialModel    = true;
        projectionPeriodYears = (input as { projectionPeriodYears: number }).projectionPeriodYears;

      } else if (
        toolName === "add_employee"   ||
        toolName === "update_employee" ||
        toolName === "add_client"     ||
        toolName === "configure_tax"
      ) {
        // Action tool — queue for user confirmation; do NOT execute immediately.
        // Skip entirely on re-invocation after confirmation so the same action is
        // not re-queued when the goal also contains a workflow (e.g. run_payroll).
        if (skipActionTools) {
          console.log(`[managerNode] skipping action tool ${toolName} — pendingActionConfirmed is true`);
        } else if (!pendingAction) {
          // First action tool call: build the confirmation card payload
          pendingAction = {
            tool:        toolName,
            params:      input,
            description: buildDescription(toolName, input),  // plain English shown in ConfirmationCard
          };
        } else {
          // Subsequent action tool calls: skip — sequential confirmation handles one at a time
          console.warn(`[managerNode] skipping additional action tool call: ${toolName}`);
        }
      }
    }

  } catch (err) {
    // LLM call failed — disable all workers and record the error
    return {
      runFS:             false,
      runPayroll:        false,
      runTax:            false,
      runFinancialModel: false,
      errors: {
        ...state.errors,
        managerNode: `Failed to parse goal: ${(err as Error).message}`,
      },
    };
  }

  // ── If a pendingAction was set, return with all accumulated state ────────
  // Workflow flags and temporal parameters extracted by the LLM are preserved
  // so they are available in graph state when the graph is re-invoked after the
  // user confirms. Workers are not triggered here because the graph edge in
  // graph.ts checks pendingAction first and routes directly to summaryNode,
  // bypassing the workflow flag checks entirely.
  if (pendingAction) {
    return {
      runFS,              // preserved — graph edge skips workers via pendingAction check
      runPayroll,
      runTax,
      runFinancialModel,
      financialYear,
      payrollMonth,
      payrollYear,
      yearOfAssessment,
      projectionPeriodYears,
      pendingAction,      // queued for ConfirmationCard in ChatbotPanel
      vaultContext:  recentNotes,
    };
  }

  // ── No action tool called — return accumulated workflow flags and parameters ─
  // vaultContext is always written so agent/route.ts can include it in the Langfuse trace.
  return {
    runFS,
    runPayroll,
    runTax,
    runFinancialModel,
    financialYear,
    payrollMonth,
    payrollYear,
    yearOfAssessment,
    projectionPeriodYears,
    pendingAction: undefined,  // explicitly clear any stale pendingAction from a prior run
    vaultContext:  recentNotes,
  };
}

// ─── Node 3: Financial Statement Node ────────────────────────────────────────

/**
 * Triggers the FS generation pipeline via internal HTTP.
 * On success: writes fsOutputId (used downstream by Tax and Model nodes) and fsResult.
 * On error: writes to state.errors.financialStatementNode — does not throw.
 */
export async function financialStatementNode(state: State): Promise<NodeReturn> {
  try {
    // POST to the thin wrapper route; it handles all Supabase lookups internally
    const res = await fetch(`${APP_URL}/api/financial-statements/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        clientId:      state.clientId,
        financialYear: state.financialYear,
      }),
    });

    if (!res.ok) {
      // Read body as text first — avoids a JSON parse error if the server returned
      // an HTML error page (e.g. Next.js 500) instead of a JSON response
      const text = await res.text();
      return {
        errors: {
          ...state.errors,
          financialStatementNode: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    // Only parse JSON once we know the response is a 2xx success
    const data = await res.json() as Record<string, unknown>;

    return {
      fsOutputId: data.fsOutputId as string,    // UUID of the new outputs row
      fsResult:   data.fsResult   as object,    // full FSOutput for the summary node
      // Record that we loaded classified accounts for this fiscal year from Supabase.
      // The wrapper route fetches them from the outputs table keyed by fiscal year.
      fetchedContext: {
        financialStatementNode: `Loaded classified accounts from FY${state.financialYear} trial balance`,
      },
    };

  } catch (err) {
    // Network or unexpected error — write to errors, do not throw
    return {
      errors: {
        ...state.errors,
        financialStatementNode: (err as Error).message,
      },
    };
  }
}

// ─── Node 4: Payroll Node ─────────────────────────────────────────────────────

/**
 * Triggers the payroll pipeline via internal HTTP.
 * On success: writes payrollResult.
 * On error: writes to state.errors.payrollNode — does not throw.
 */
export async function payrollNode(state: State): Promise<NodeReturn> {
  try {
    const res = await fetch(`${APP_URL}/api/payroll/process`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        clientId:     state.clientId,
        payrollMonth: state.payrollMonth,
        payrollYear:  state.payrollYear,
      }),
    });

    if (!res.ok) {
      // Read body as text first — avoids a JSON parse error if the server returned
      // an HTML error page (e.g. Next.js 500) instead of a JSON response
      const text = await res.text();
      return {
        errors: {
          ...state.errors,
          payrollNode: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    // Only parse JSON once we know the response is a 2xx success
    const data = await res.json() as Record<string, unknown>;

    // The wrapper route returns a results array with one entry per employee.
    // Cast to unknown[] so we can read .length without a full type annotation.
    const employeeCount = Array.isArray(data.results)
      ? (data.results as unknown[]).length
      : 0;

    return {
      payrollResult: data as object,
      // Record how many employee records were loaded from Supabase by the wrapper route.
      fetchedContext: {
        payrollNode: `Loaded ${employeeCount} employee record${employeeCount !== 1 ? "s" : ""} for ${state.clientId}`,
      },
    };

  } catch (err) {
    return {
      errors: {
        ...state.errors,
        payrollNode: (err as Error).message,
      },
    };
  }
}

// ─── Node 5: Tax Node ─────────────────────────────────────────────────────────

/**
 * Triggers the corporate tax computation via internal HTTP.
 * Requires fsOutputId — guards against running without it.
 * On success: writes taxResult.
 * On error: writes to state.errors.taxNode — does not throw.
 */
export async function taxNode(state: State): Promise<NodeReturn> {
  // Resolve fsOutputId — prefer the value already in graph state (set by
  // financialStatementNode if FS ran in this session), then fall back to the
  // most recently saved FS output in Supabase for this client schema.
  let fsOutputId = state.fsOutputId;

  // Will be set only when fsOutputId is resolved via Supabase fallback (not from
  // shared state). Undefined when FS ran in the same session — no context needed then.
  let taxFetchedContext: string | undefined;

  if (!fsOutputId) {
    // FS did not run in this invocation — look up the latest saved output row.
    // Select created_at and fiscal_year_id alongside id so we can surface the
    // saved date and fiscal year in the fetchedContext entry.
    try {
      const { data: outputRow } = await supabase
        .schema(state.clientId)          // each client has its own Postgres schema
        .from("outputs")
        .select("id, created_at, fiscal_year_id")  // extended to capture context fields
        .eq("output_type", "financial_statements")  // only FS outputs, not model outputs
        .order("created_at", { ascending: false })  // most recent first
        .limit(1)
        .single();

      if (outputRow) {
        fsOutputId = outputRow.id as string;  // use the saved output's UUID

        // Format the saved date from the ISO timestamp (e.g. "3 May 2026")
        const savedDate = formatSavedDate(outputRow.created_at as string);

        // Look up the fiscal year end date to derive the calendar year (e.g. "FY2025")
        try {
          const { data: fyRow } = await supabase
            .schema(state.clientId)
            .from("fiscal_years")
            .select("end_date")
            .eq("id", outputRow.fiscal_year_id as string)  // match the specific FY row
            .single();

          // Parse the year from end_date ("YYYY-MM-DD"); append T00:00:00 to avoid UTC offset issues
          const fyYear = fyRow
            ? new Date((fyRow.end_date as string) + "T00:00:00").getFullYear()
            : null;

          // Include FY year when available; fall back to date-only description if not
          taxFetchedContext = fyYear
            ? `Used financial statement for FY${fyYear} (saved ${savedDate})`
            : `Used financial statement saved ${savedDate}`;
        } catch {
          // FY lookup failed — still record the saved date without the year label
          taxFetchedContext = `Used financial statement saved ${savedDate}`;
        }
      }
    } catch {
      // Supabase lookup failed — fall through to the missing-output error below
    }
  }

  if (!fsOutputId) {
    // No FS output in state and none found in Supabase — cannot proceed
    return {
      errors: {
        ...state.errors,
        taxNode: "No saved financial statement found. Please run the Financial Statement workflow first.",
      },
    };
  }

  try {
    // The /api/tax/agent route is a new thin wrapper; the existing /api/tax/compute
    // is preserved unchanged for the UI's TaxWorkflow component
    const res = await fetch(`${APP_URL}/api/tax/agent`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        clientId:         state.clientId,
        yearOfAssessment: state.yearOfAssessment,
        fsOutputId,       // resolved above: from state or Supabase fallback
      }),
    });

    if (!res.ok) {
      // Read body as text first — avoids a JSON parse error if the server returned
      // an HTML error page (e.g. Next.js 500) instead of a JSON response
      const text = await res.text();
      return {
        errors: {
          ...state.errors,
          taxNode: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    // Only parse JSON once we know the response is a 2xx success
    const data = await res.json() as Record<string, unknown>;

    return {
      taxResult: data as object,
      // Only include fetchedContext when the ID came from Supabase (background fetch).
      // When FS ran in the same session and passed fsOutputId via shared state,
      // no background fetch occurred — omit the entry to avoid misleading the user.
      ...(taxFetchedContext ? { fetchedContext: { taxNode: taxFetchedContext } } : {}),
    };

  } catch (err) {
    return {
      errors: {
        ...state.errors,
        taxNode: (err as Error).message,
      },
    };
  }
}

// ─── Node 6: Financial Model Node ────────────────────────────────────────────

/**
 * Triggers the financial model projection pipeline via internal HTTP.
 * Requires fsOutputId — guards against running without it.
 * On success: writes financialModelResult.
 * On error: writes to state.errors.financialModelNode — does not throw.
 */
export async function financialModelNode(state: State): Promise<NodeReturn> {
  // Resolve fsOutputId — prefer the value already in graph state (set by
  // financialStatementNode if FS ran in this session), then fall back to the
  // most recently saved FS output in Supabase for this client schema.
  let fsOutputId = state.fsOutputId;

  // Will be set only when fsOutputId is resolved via Supabase fallback (not from
  // shared state). Undefined when FS ran in the same session — no context needed then.
  let modelFetchedContext: string | undefined;

  if (!fsOutputId) {
    // FS did not run in this invocation — look up the latest saved output row.
    // Select created_at and fiscal_year_id alongside id so we can surface the
    // saved date and fiscal year in the fetchedContext entry.
    try {
      const { data: outputRow } = await supabase
        .schema(state.clientId)          // each client has its own Postgres schema
        .from("outputs")
        .select("id, created_at, fiscal_year_id")  // extended to capture context fields
        .eq("output_type", "financial_statements")  // only FS outputs, not model outputs
        .order("created_at", { ascending: false })  // most recent first
        .limit(1)
        .single();

      if (outputRow) {
        fsOutputId = outputRow.id as string;  // use the saved output's UUID

        // Format the saved date from the ISO timestamp (e.g. "3 May 2026")
        const savedDate = formatSavedDate(outputRow.created_at as string);

        // Look up the fiscal year end date to derive the calendar year (e.g. "FY2025")
        try {
          const { data: fyRow } = await supabase
            .schema(state.clientId)
            .from("fiscal_years")
            .select("end_date")
            .eq("id", outputRow.fiscal_year_id as string)  // match the specific FY row
            .single();

          // Parse the year from end_date ("YYYY-MM-DD"); append T00:00:00 to avoid UTC offset issues
          const fyYear = fyRow
            ? new Date((fyRow.end_date as string) + "T00:00:00").getFullYear()
            : null;

          // Include FY year when available; fall back to date-only description if not
          modelFetchedContext = fyYear
            ? `Used financial statement for FY${fyYear} (saved ${savedDate})`
            : `Used financial statement saved ${savedDate}`;
        } catch {
          // FY lookup failed — still record the saved date without the year label
          modelFetchedContext = `Used financial statement saved ${savedDate}`;
        }
      }
    } catch {
      // Supabase lookup failed — fall through to the missing-output error below
    }
  }

  if (!fsOutputId) {
    // No FS output in state and none found in Supabase — cannot proceed
    return {
      errors: {
        ...state.errors,
        financialModelNode: "No saved financial statement found. Please run the Financial Statement workflow first.",
      },
    };
  }

  try {
    const res = await fetch(`${APP_URL}/api/financial-model/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        clientId:              state.clientId,
        projectionPeriodYears: state.projectionPeriodYears,
        fsOutputId,            // resolved above: from state or Supabase fallback
      }),
    });

    if (!res.ok) {
      // Read body as text first — avoids a JSON parse error if the server returned
      // an HTML error page (e.g. Next.js 500) instead of a JSON response
      const text = await res.text();
      return {
        errors: {
          ...state.errors,
          financialModelNode: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    // Only parse JSON once we know the response is a 2xx success
    const data = await res.json() as Record<string, unknown>;

    return {
      financialModelResult: data as object,
      // Only include fetchedContext when the ID came from Supabase (background fetch).
      // When FS ran in the same session and passed fsOutputId via shared state,
      // no background fetch occurred — omit the entry to avoid misleading the user.
      ...(modelFetchedContext ? { fetchedContext: { financialModelNode: modelFetchedContext } } : {}),
    };

  } catch (err) {
    return {
      errors: {
        ...state.errors,
        financialModelNode: (err as Error).message,
      },
    };
  }
}

// ─── Node 7: Summary Node ────────────────────────────────────────────────────

/**
 * Pure TypeScript — no LLM call, no external fetch.
 * Collates all result slots and error entries into a single plain-English
 * summary string and writes it to state.summary for posting to chat.
 */
export async function summaryNode(state: State): Promise<NodeReturn> {
  const lines: string[] = [];

  // ── Short-circuit when a confirmation is pending ─────────────────────────
  // An action tool was called but requires user approval before execution.
  // No workflows ran, so there are no results to summarise. Return a single
  // informational message so the user understands the ConfirmationCard below.
  // Vault note is intentionally skipped — nothing was executed this run.
  if (state.pendingAction !== undefined) {
    return {
      summary:
        "Action queued for your confirmation — please review and approve " +
        "the request below before proceeding.",
    };
  }

  // ── Surface any missing inputs first ────────────────────────────────────
  if (state.missingInputs.length > 0) {
    lines.push(`Missing required inputs: ${state.missingInputs.join(", ")}.`);
    lines.push("Please provide the missing information and try again.");
    return { summary: lines.join(" ") };
  }

  // ── Report completed workflows ───────────────────────────────────────────
  if (state.fsResult) {
    lines.push("Financial statements generated successfully.");
  }

  if (state.payrollResult) {
    lines.push("Payroll run completed successfully.");
  }

  if (state.taxResult) {
    // Pull tax_payable from the nested result object if available
    const taxData = state.taxResult as Record<string, unknown>;
    const taxPayable = (taxData.result as Record<string, unknown>)?.tax_payable;
    const payableStr = taxPayable ? ` Tax payable: SGD ${taxPayable}.` : "";
    lines.push(`Corporate tax computation completed.${payableStr}`);
  }

  if (state.financialModelResult) {
    lines.push("Financial model projections generated successfully.");
  }

  // ── Report any errors ─────────────────────────────────────────────────────
  const errorEntries = Object.entries(state.errors);  // [nodeName, errorMessage]
  if (errorEntries.length > 0) {
    lines.push("The following errors occurred:");
    for (const [nodeName, message] of errorEntries) {
      // Format as "- FinancialStatementNode: <message>"
      const label = nodeName.replace(/Node$/, "").replace(/([A-Z])/g, " $1").trim();
      lines.push(`- ${label}: ${message}`);
    }
  }

  // ── Fallback if nothing ran ───────────────────────────────────────────────
  if (lines.length === 0) {
    lines.push("No workflows were executed. Please check your goal and try again.");
  }

  // Build the workflow completion text first (existing behaviour unchanged)
  let summaryText = lines.join(" ");

  // ── Append "Data used" section if any node recorded a Supabase fetch ────────
  // fetchedContext is populated by nodes that resolved data from Supabase in the
  // background (e.g. taxNode falling back to the latest saved FS output). Nodes
  // that received data via shared graph state do not write to fetchedContext.
  const contextEntries = Object.entries(state.fetchedContext);  // [nodeName, description]
  if (contextEntries.length > 0) {
    // Build one bullet line per entry; order follows insertion order of the object
    const bulletLines = contextEntries.map(([, description]) => `- ${description}`);
    // Append as a separate block after the workflow summary lines
    summaryText += "\nData used:\n" + bulletLines.join("\n");
  }

  // ── Append optional inputs advisories for each completed workflow ─────────
  // An advisory only appears when the workflow completed successfully (result present).
  // Advisories are appended in fixed order: FS → Payroll → Tax → Financial Model.
  // Each advisory block informs the user which inputs the agent defaulted and
  // where to go in the UI to adjust them if needed.

  if (state.fsResult) {
    // FS ran: going concern notes and depreciation method changes require Correction mode
    summaryText +=
      "\n\nOptional inputs not applied:\n" +
      "- Going concern notes or depreciation method changes — submit via Correction mode in this chat";
  }

  if (state.payrollResult) {
    // Payroll ran: agent defaults all AW/allowances/deductions/ytd_ow to zero
    summaryText +=
      "\n\nOptional inputs not applied:\n" +
      "- Additional wages (bonus, commission), allowances, deductions, or " +
      "YTD ordinary wages — go to Payroll in the left panel to adjust before finalising";
  }

  if (state.taxResult) {
    // Tax ran: agent hardcodes is_new_startup=false and tax_adjustments=[]
    summaryText +=
      "\n\nOptional inputs not applied:\n" +
      "- Tax adjustments (capital allowances, motor vehicle expenses, " +
      "donations, dividend income) — not applied; go to Corporate Tax in the left panel to add adjustments\n" +
      "- New start-up exemption — defaulted to Partial Tax Exemption; " +
      "go to Corporate Tax in the left panel to change if your company qualifies";
  }

  if (state.financialModelResult) {
    // Financial model ran: agent uses conservative defaults; projections are not saved
    summaryText +=
      "\n\nOptional inputs not applied:\n" +
      "- Growth rate assumptions — defaulted to conservative SG defaults " +
      "(5% revenue growth, 3% COGS growth, 3% OPEX growth); go to Financial Model in the left panel to adjust\n" +
      "- Projections are not saved — go to Financial Model in the left panel to review and save your model";
  }

  // ── V3.1: Write vault note ────────────────────────────────────────────────
  // Build all param objects from state, then call the vault writer.
  // writeVaultNote has its own internal try/catch — any error is logged and
  // swallowed there, so a vault failure cannot affect the summary return below.

  // Derive the list of workflows that completed in this run
  const completedWorkflows: string[] = [
    ...(state.fsResult             ? ["financial_statement"] : []),
    ...(state.payrollResult        ? ["payroll"]             : []),
    ...(state.taxResult            ? ["tax"]                 : []),
    ...(state.financialModelResult ? ["financial_model"]     : []),
  ];

  // Build inputsUsed from whichever state fields are defined
  const inputsUsed: Record<string, string> = {};
  if (state.financialYear !== undefined) {
    inputsUsed["Financial Year"] = state.financialYear;
  }
  if (state.payrollMonth !== undefined && state.payrollYear !== undefined) {
    inputsUsed["Payroll Month"] = `${state.payrollMonth}/${state.payrollYear}`;
  }
  if (state.yearOfAssessment !== undefined) {
    inputsUsed["Year of Assessment"] = state.yearOfAssessment;
  }
  if (state.projectionPeriodYears !== undefined) {
    inputsUsed["Projection Period"] = `${state.projectionPeriodYears} years`;
  }

  // Build outputsGenerated from result fields that carry a persisted ID
  const outputsGenerated: Record<string, string> = {};
  if (state.fsOutputId !== undefined) {
    outputsGenerated["Financial Statement"] = state.fsOutputId;  // UUID of the outputs row
  }
  if (state.payrollResult !== undefined) {
    const pr = state.payrollResult as Record<string, unknown>;
    if (pr.payroll_run_id) outputsGenerated["Payroll Run"] = pr.payroll_run_id as string;
  }
  if (state.taxResult !== undefined) {
    const tr = state.taxResult as Record<string, unknown>;
    if (tr.computation_id) outputsGenerated["Tax Computation"] = tr.computation_id as string;
  }
  if (state.financialModelResult !== undefined) {
    outputsGenerated["Financial Model"] = "Projections generated";
  }

  // Build optionalInputsNotApplied — fixed lists per workflow, only for completed ones
  const optionalInputsNotApplied: Record<string, string[]> = {};
  if (state.fsResult) {
    optionalInputsNotApplied["Financial Statement"] = [
      "Going concern notes",
      "Depreciation method changes",
    ];
  }
  if (state.payrollResult) {
    optionalInputsNotApplied["Payroll"] = [
      "Additional wages",
      "Allowances",
      "Deductions",
      "YTD ordinary wages",
    ];
  }
  if (state.taxResult) {
    optionalInputsNotApplied["Tax"] = [
      "Tax adjustments",
      "New start-up exemption review",
    ];
  }
  if (state.financialModelResult) {
    optionalInputsNotApplied["Financial Model"] = [
      "Growth rate assumption adjustments",
      "Model save",
    ];
  }

  // Await the write — writeVaultNote returns void and never throws
  await writeVaultNote({
    clientId:                 state.clientId,
    goal:                     state.goal,
    workflows:                completedWorkflows,
    inputsUsed,
    dataFetched:              state.fetchedContext,  // already Record<string, string>
    outputsGenerated,
    optionalInputsNotApplied,
    errors:                   state.errors,
  });

  return { summary: summaryText };
}
