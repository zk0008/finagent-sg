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

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { MODEL_ROUTES } from "@/lib/modelRouter";
import { supabase } from "@/lib/supabaseClient";  // used by taxNode and financialModelNode Supabase fallback
import { GraphState } from "../state";

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
 * Pure TypeScript guard — no LLM call, no external fetch.
 * Checks that all inputs required by the flagged workflows are present in state.
 * Populates state.missingInputs if anything is absent; graph routes to END if so.
 * If everything is present, returns unchanged state and graph continues to manager.
 */
export function validationNode(state: State): NodeReturn {
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

  if (missing.length > 0) {
    // Write the list and stop — the conditional edge routes to END on non-empty array
    return { missingInputs: missing };
  }

  // All inputs present — clear any stale missing list and let the graph continue
  return { missingInputs: [] };
}

// ─── Node 2: Manager Node ────────────────────────────────────────────────────

/**
 * Parses the user's natural language goal using GPT-4.1 and writes the extracted
 * run flags and temporal parameters back into graph state.
 * Uses the same model identifier as FS generation (accuracy-critical routing).
 */
export async function managerNode(state: State): Promise<NodeReturn> {
  // System prompt instructs the LLM to return only JSON — no markdown, no commentary
  const systemPrompt = `You are a compliance workflow manager for a Singapore private limited company accounting system. Given a user goal, extract the following as JSON and nothing else:
- runFS: boolean — true if goal involves financial statements or trial balance
- runPayroll: boolean — true if goal involves payroll or CPF
- runTax: boolean — true if goal involves corporate tax or Form C
- runFinancialModel: boolean — true if goal involves financial model, projections or scenarios
- financialYear: string or null — e.g. '2025'
- payrollMonth: number or null — 1 to 12
- payrollYear: number or null — e.g. 2025
- yearOfAssessment: string or null — e.g. 'YA2026'
- projectionPeriodYears: number or null — e.g. 3
Respond with valid JSON only. No explanation, no markdown.`;

  let parsed: {
    runFS:                 boolean;
    runPayroll:            boolean;
    runTax:                boolean;
    runFinancialModel:     boolean;
    financialYear:         string | null;
    payrollMonth:          number | null;
    payrollYear:           number | null;
    yearOfAssessment:      string | null;
    projectionPeriodYears: number | null;
  };

  try {
    // generateText returns raw text; we parse it as JSON ourselves
    const { text } = await generateText({
      model:  openai(MODEL_ROUTES.fs_generation),  // "gpt-4.1" — accuracy critical routing
      system: systemPrompt,
      prompt: state.goal,   // the user's natural language goal goes here
    });

    // Strip any accidental markdown code fences the model might add
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    parsed = JSON.parse(cleaned);

  } catch (err) {
    // If the LLM call or JSON parse fails, disable all workers and record the error
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

  // Map null → undefined so the state fields stay as T | undefined (not null)
  return {
    runFS:                 parsed.runFS,
    runPayroll:            parsed.runPayroll,
    runTax:                parsed.runTax,
    runFinancialModel:     parsed.runFinancialModel,
    financialYear:         parsed.financialYear         ?? undefined,
    payrollMonth:          parsed.payrollMonth          ?? undefined,
    payrollYear:           parsed.payrollYear           ?? undefined,
    yearOfAssessment:      parsed.yearOfAssessment      ?? undefined,
    projectionPeriodYears: parsed.projectionPeriodYears ?? undefined,
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
export function summaryNode(state: State): NodeReturn {
  const lines: string[] = [];

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

  return { summary: summaryText };
}
