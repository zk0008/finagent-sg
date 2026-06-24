/**
 * app/api/agent/confirm/route.ts
 *
 * POST /api/agent/confirm — Handles user Yes/No responses to ConfirmationCard.
 *
 * Full implementation (V3.2-B):
 *   1. Validates and authenticates the request.
 *   2. For confirmed=false: returns plain JSON { status: "cancelled" }.
 *   3. For confirmed=true:
 *      a. Executes the confirmed action against the relevant existing route
 *         (add_employee, update_employee, add_client) or directly via Supabase
 *         (configure_tax).
 *      b. If the action fails: returns plain JSON 500 error — no streaming.
 *      c. If the action succeeds: switches to SSE and re-invokes the LangGraph
 *         graph with pendingAction cleared and preserved workflow flags intact.
 *
 * SSE events emitted (same shape as app/api/agent/route.ts plus one new event):
 *   { event: "action:executed",        data: { message: string } }
 *   { event: "node:started",           data: { node: string } }
 *   { event: "node:complete",          data: { node: string, result: object } }
 *   { event: "node:error",             data: { node: string, error: string } }
 *   { event: "validation:missing",     data: { fields: string[] } }
 *   { event: "graph:complete",         data: { summary: string, completedRuns: object[] } }
 *   { event: "graph:error",            data: { error: string } }
 *
 * Request body (confirmed=true):
 *   {
 *     confirmed: true,
 *     action:   { tool, params, description },
 *     clientId: string,
 *     goal:     string,              — original goal for graph re-invocation
 *     runFS, runPayroll, runTax, runFinancialModel: boolean,
 *     financialYear?, payrollMonth?, payrollYear?,
 *     yearOfAssessment?, projectionPeriodYears?
 *   }
 */

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { verifySchemaAccess } from "@/lib/schemaAccess";
import { supabase } from "@/lib/supabaseClient";
import graph from "@/lib/agents/graph";
import { GraphState } from "@/lib/agents/state";

// Full state type inferred from the LangGraph Annotation
type AgentState = typeof GraphState.State;

// Base URL for internal HTTP calls — same pattern as worker nodes in nodes/index.ts
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

// Maps LLM human-readable citizenship values to CPF engine codes.
// addEmployeeTool uses z.enum(["Singapore Citizen","Singapore PR","Foreigner"]);
// cpfEngine.ts getCPFRates() expects "SC" | "SPR_1" | "SPR_2" | "SPR_3" | "foreigner".
// "Singapore PR" → "SPR_3" by default (PR year not captured by the tool).
function mapCitizenshipToCpfCode(value: unknown): string {
  switch (value) {
    case "Singapore Citizen": return "SC";
    case "Singapore PR":      return "SPR_3";
    case "Foreigner":         return "foreigner";
    default:                  return String(value);  // passthrough if already a DB code
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  // ── Parse request body ─────────────────────────────────────────────────────
  let body: {
    confirmed:             boolean;
    action:                { tool: string; params: Record<string, unknown>; description: string };
    clientId:              string;
    goal:                  string;
    runFS?:                boolean;
    runPayroll?:           boolean;
    runTax?:               boolean;
    runFinancialModel?:    boolean;
    financialYear?:        string;
    payrollMonth?:         number;
    payrollYear?:          number;
    yearOfAssessment?:     string;
    projectionPeriodYears?: number;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { confirmed, action, clientId } = body;

  // Validate required fields — same guards as the original stub
  if (typeof confirmed !== "boolean") {
    return new Response(
      JSON.stringify({ error: "confirmed must be a boolean" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!action || typeof action !== "object" || typeof action.tool !== "string") {
    return new Response(
      JSON.stringify({ error: "action must be an object with a tool field" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!clientId || typeof clientId !== "string") {
    return new Response(
      JSON.stringify({ error: "clientId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!body.goal || typeof body.goal !== "string") {
    return new Response(
      JSON.stringify({ error: "goal is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Cancel path — plain JSON, no execution ─────────────────────────────────
  if (!confirmed) {
    return new Response(
      JSON.stringify({ status: "cancelled", message: "Action cancelled." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Auth check ─────────────────────────────────────────────────────────────
  // Must run before any data writes — same guard used by all agent routes
  const session = await auth();
  const userId = session?.user?.id as string | undefined;
  const userRole = (session?.user as { role?: string })?.role;
  const allowed = await verifySchemaAccess(clientId, userId, userRole);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Reject unknown tools before executing anything ─────────────────────────
  const { tool, params } = action;
  const knownTools = ["add_employee", "update_employee", "delete_employee", "add_client", "configure_tax"];
  if (!knownTools.includes(tool)) {
    return new Response(
      JSON.stringify({ error: `Unknown action tool: ${tool}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Execute the confirmed action synchronously before starting SSE ─────────
  // Done here (not inside the stream) so that a failure can return a plain JSON
  // error response — once the SSE ReadableStream starts we cannot return non-2xx.
  // newClientSchemaName is only populated by the add_client handler — carried through
  // to the graph:complete SSE event so ChatbotPanel can auto-switch the active client.
  let actionResult: { success: boolean; message?: string; error?: string; newClientSchemaName?: string };

  // ── add_employee ────────────────────────────────────────────────────────────
  if (tool === "add_employee") {
    // Resolve entity_id from the shared registry — employees table FK requires it
    const { data: schemaRow, error: schemaError } = await supabase
      .from("client_schemas")
      .select("entity_id")
      .eq("schema_name", clientId)
      .single();

    if (schemaError || !schemaRow) {
      // Registry lookup failed — cannot insert without entity_id
      actionResult = {
        success: false,
        error:   `Could not resolve entity for client ${clientId}`,
      };
    } else {
      // POST to the existing payroll employees route; map camelCase params to snake_case
      const res = await fetch(`${APP_URL}/api/payroll/employees`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          schemaName:     clientId,
          entity_id:      (schemaRow as { entity_id: string }).entity_id,
          name:           params.name,
          dob:            params.dob,
          citizenship:    mapCitizenshipToCpfCode(params.citizenship),
          monthly_salary: params.monthlySalary,   // tool uses camelCase → route uses snake_case
          nric_fin:       params.nricFin ?? null,  // optional — null if not provided
        }),
      });

      if (res.ok) {
        actionResult = {
          success: true,
          message: `Employee ${String(params.name)} added successfully.`,
        };
      } else {
        const err = await res.json() as { error?: string };
        actionResult = { success: false, error: err.error ?? `HTTP ${res.status}` };
      }
    }

  // ── update_employee ─────────────────────────────────────────────────────────
  } else if (tool === "update_employee") {
    const employeeName = params.employeeName as string;  // always present — required by updateEmployeeTool

    // Phase 1: resolve the employee UUID.
    // Use params.employeeId if the LLM provided it; otherwise query by name.
    let employeeUUID: string | null = params.employeeId
      ? (params.employeeId as string)   // LLM knew the UUID — use it directly
      : null;                            // not provided — look up by name below

    if (!employeeUUID) {
      // Case-insensitive ilike so "sarah lee" matches "Sarah Lee" in the DB
      const { data: empRow, error: empError } = await supabase
        .schema(clientId)
        .from("employees")
        .select("id")
        .ilike("name", employeeName)
        .single();

      if (!empError && empRow) {
        employeeUUID = (empRow as { id: string }).id;  // found — stash the UUID
      }
      // If lookup failed, employeeUUID stays null; outer if/else handles the error below
    }

    // Phase 2: either report "not found" or execute the PUT.
    // Single if/else so TypeScript can verify actionResult is always assigned.
    if (!employeeUUID) {
      // Could not resolve UUID — LLM omitted it and name lookup returned nothing
      actionResult = {
        success: false,
        error:   `No employee named "${employeeName}" found.`,
      };
    } else {
      // Build the update body — only include fields that were provided in tool params.
      // Guard against empty strings in addition to undefined: the LLM sometimes passes
      // optional string fields as "" when the user did not supply a value, which causes
      // Postgres to reject typed columns (e.g. date "" → "invalid input syntax for type date").
      const updateBody: Record<string, unknown> = { schemaName: clientId };
      if (params.name          !== undefined && params.name          !== "") updateBody.name           = params.name;
      if (params.dob           !== undefined && params.dob           !== "") updateBody.dob            = params.dob;            // empty string → Postgres date error
      if (params.citizenship   !== undefined && params.citizenship   !== "") updateBody.citizenship    = mapCitizenshipToCpfCode(params.citizenship);  // map human-readable → CPF code
      if (params.monthlySalary !== undefined)                                updateBody.monthly_salary = params.monthlySalary;  // number — no empty-string risk
      if (params.nricFin       !== undefined && params.nricFin       !== "") updateBody.nric_fin       = params.nricFin;        // camelCase → snake_case

      // PUT to the existing payroll employees/[id] route; UUID goes in the URL
      const res = await fetch(`${APP_URL}/api/payroll/employees/${employeeUUID}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(updateBody),
      });

      if (res.ok) {
        actionResult = {
          success: true,
          message: `Employee ${employeeName} updated successfully.`,
        };
      } else {
        const errText = await res.text();  // PUT may return plain text on error
        actionResult = { success: false, error: errText || `HTTP ${res.status}` };
      }
    }

  // ── delete_employee ─────────────────────────────────────────────────────────
  } else if (tool === "delete_employee") {
    const employeeName = params.employeeName as string;  // always present — used in messages and lookup

    // Phase 1: resolve the employee UUID.
    // Use params.employeeId if the LLM provided it; otherwise query by name.
    let employeeUUID: string | null = params.employeeId
      ? (params.employeeId as string)   // LLM already knew the UUID — use it directly
      : null;                            // not provided — look up by name below

    if (!employeeUUID) {
      // Case-insensitive ilike so "sarah tan" matches "Sarah Tan" in the DB
      const { data: empRow, error: empError } = await supabase
        .schema(clientId)
        .from("employees")
        .select("id")
        .ilike("name", employeeName)
        .single();

      if (!empError && empRow) {
        employeeUUID = (empRow as { id: string }).id;  // found — stash the UUID
      }
      // If lookup failed, employeeUUID stays null; outer if/else handles the error below
    }

    // Phase 2: either report "not found" or execute the DELETE.
    // Single if/else here so TypeScript can verify actionResult is always assigned.
    if (!employeeUUID) {
      // Could not resolve UUID — either LLM omitted it and name lookup returned nothing
      actionResult = {
        success: false,
        error:   `No employee named "${employeeName}" found.`,
      };
    } else {
      // Valid UUID in hand — DELETE to the existing payroll employees/[id] route;
      // schemaName is passed as a query param per the DELETE handler's signature
      const res = await fetch(
        `${APP_URL}/api/payroll/employees/${employeeUUID}?schemaName=${encodeURIComponent(clientId)}`,
        {
          method:  "DELETE",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (res.ok) {
        actionResult = {
          success: true,
          message: `Employee ${employeeName} deleted successfully.`,
        };
      } else {
        const errText = await res.text();  // DELETE may return plain text on error
        actionResult = { success: false, error: errText || `HTTP ${res.status}` };
      }
    }

  // ── add_client ──────────────────────────────────────────────────────────────
  } else if (tool === "add_client") {
    // Forward the session cookie so /api/clients can call auth() and read the session.
    const cookieHeader = req.headers.get("cookie") ?? "";

    const clientRes = await fetch(`${APP_URL}/api/clients`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie":        cookieHeader,
      },
      body: JSON.stringify({
        name:                       String(params.companyName ?? ""),
        uen:                        String(params.uen ?? ""),
        company_type:               String(params.company_type ?? "private_ltd"),
        fye_date:                   String(params.fye_date ?? "2025-12-31"),
        revenue:                    String(params.revenue ?? "0"),
        total_assets:               String(params.total_assets ?? "0"),
        employee_count:             typeof params.employee_count === "number" ? params.employee_count : 0,
        shareholder_count:          typeof params.shareholder_count === "number" ? params.shareholder_count : 1,
        has_corporate_shareholders: Boolean(params.has_corporate_shareholders ?? false),
      }),
    });

    if (clientRes.status === 201) {
      const data = await clientRes.json() as { client: { name: string; schema_name: string } };
      actionResult = {
        success:             true,
        message:             `Client ${data.client.name} has been created. You can now select them and run workflows.`,
        newClientSchemaName: data.client.schema_name,
      };
    } else {
      const err = await clientRes.json() as { error?: string };
      actionResult = { success: false, error: err.error ?? `HTTP ${clientRes.status}` };
    }

  // ── configure_tax ───────────────────────────────────────────────────────────
  } else {
    // No existing route — update entities table directly via Supabase.
    // accounting_profit_override and revenue_override columns are added in V3.2-E.
    const updateData: Record<string, unknown> = {};
    if (params.accountingProfitOverride !== undefined) {
      updateData.accounting_profit_override = params.accountingProfitOverride;
    }
    if (params.revenueOverride !== undefined) {
      updateData.revenue_override = params.revenueOverride;
    }

    if (Object.keys(updateData).length === 0) {
      // Neither field was provided — nothing to update
      actionResult = { success: false, error: "No override values provided" };
    } else {
      // Fetch the first entity for this client schema — each schema has exactly one entity
      const { data: entity, error: entityError } = await supabase
        .schema(clientId)
        .from("entities")
        .select("id")
        .limit(1)
        .single();

      if (entityError || !entity) {
        actionResult = {
          success: false,
          error:   `Could not find entity for client ${clientId}`,
        };
      } else {
        const { error: updateError } = await supabase
          .schema(clientId)
          .from("entities")
          .update(updateData)
          .eq("id", (entity as { id: string }).id);

        if (updateError) {
          // Detect "column not found" errors — these columns are added in V3.2-E
          const isColumnMissing =
            updateError.message.toLowerCase().includes("column") ||
            updateError.message.toLowerCase().includes("does not exist");

          actionResult = {
            success: false,
            error:   isColumnMissing
              ? "Tax override columns not yet configured — will be available after V3.2-E"
              : updateError.message,
          };
        } else {
          actionResult = { success: true, message: "Tax overrides configured successfully." };
        }
      }
    }
  }

  // ── Action failed — return plain JSON error before starting SSE ────────────
  // Once the ReadableStream starts, we can only emit SSE events — no JSON errors.
  if (!actionResult.success) {
    return new Response(
      JSON.stringify({ error: actionResult.error }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Action succeeded — switch to SSE for graph re-invocation ──────────────
  const {
    goal,
    runFS             = false,
    runPayroll        = false,
    runTax            = false,
    runFinancialModel = false,
    financialYear,
    payrollMonth,
    payrollYear,
    yearOfAssessment,
    projectionPeriodYears,
  } = body;

  // Whether there are any workflow nodes to run after the confirmed action
  const hasWorkflows = runFS || runPayroll || runTax || runFinancialModel;

  // Same encoder/ReadableStream/controller pattern as app/api/agent/route.ts
  const encoder = new TextEncoder();

  const sseStream = new ReadableStream({
    async start(controller) {
      // Encodes and enqueues one SSE data line — payload is an embedded JSON object
      function send(payload: object): void {
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }

      // First event: notify the client the action was executed successfully
      send({ event: "action:executed", data: { message: actionResult.message } });

      // ── Skip graph re-invocation when no workflows are preserved ────────────
      // Action-only goals (e.g. "add employee") have no workflow flags. Emit
      // graph:complete immediately so the UI transitions to the done state.
      if (!hasWorkflows) {
        send({
          event: "graph:complete",
          data:  {
            summary:             actionResult.message ?? "",
            completedRuns:       [],
            executedAction:      action.tool,           // signals action-only completion; UI uses this to trigger re-fetches
            newClientSchemaName: actionResult.newClientSchemaName ?? null,  // non-null only for add_client; UI uses this to auto-switch active client
          },
        });
        controller.close();
        return;
      }

      // ── Build re-invocation state ───────────────────────────────────────────
      // pendingAction is cleared — the confirmed action is done.
      // pendingActionConfirmed: true signals to the graph that confirmation occurred.
      // All preserved workflow flags and temporal parameters are passed through.
      const initialState: AgentState = {
        goal,
        clientId,
        missingInputs:         [],         // validationNode will re-check from scratch
        runFS,
        runPayroll,
        runTax,
        runFinancialModel,
        financialYear,
        payrollMonth,
        payrollYear,
        yearOfAssessment,
        projectionPeriodYears,
        fsOutputId:            undefined,
        fsResult:              undefined,
        payrollResult:         undefined,
        taxResult:             undefined,
        financialModelResult:  undefined,
        errors:                {},
        fetchedContext:        {},
        vaultContext:          "",
        ragContext:            "",      // no RAG query on confirm re-invocation
        pendingAction:         undefined,  // cleared — action is confirmed and done
        pendingActionConfirmed: true,      // hook for future managerNode optimisation
        summary:               undefined,
      };

      // ── Run ID accumulators — same pattern as app/api/agent/route.ts ────────
      let finalSummary:         string | undefined;
      let fsRunId:              string | undefined;
      let payRunId:             string | undefined;
      let taxRunId:             string | undefined;
      let fmRunId:              string | undefined;
      let agentProjectionYears: number | undefined =
        typeof initialState.projectionPeriodYears === "number"
          ? initialState.projectionPeriodYears
          : undefined;

      try {
        // Stream the graph in "updates" mode — each chunk is { nodeName: partialState }
        const graphStream = await graph.stream(
          initialState,
          { streamMode: "updates" } as Parameters<typeof graph.stream>[1]
        );

        for await (const chunk of graphStream) {
          const nodeName   = Object.keys(chunk)[0];
          const nodeUpdate = (chunk as Record<string, Partial<AgentState>>)[nodeName];

          send({ event: "node:started", data: { node: nodeName } });

          // Check if this node wrote an error for itself in the errors map
          const errorsMap = nodeUpdate?.errors as Record<string, string> | undefined;
          const nodeError = errorsMap?.[nodeName];

          if (nodeError) {
            send({ event: "node:error", data: { node: nodeName, error: nodeError } });
          } else {
            send({ event: "node:complete", data: { node: nodeName, result: nodeUpdate } });
          }

          // Early exit if validationNode found missing inputs
          if (nodeName === "validationNode") {
            const missing = nodeUpdate?.missingInputs;
            if (Array.isArray(missing) && missing.length > 0) {
              send({ event: "validation:missing", data: { fields: missing } });
              controller.close();
              return;
            }
          }

          // Capture summary as it comes out of summaryNode
          if (nodeUpdate?.summary) {
            finalSummary = nodeUpdate.summary;
          }

          // Pick up run IDs for the completedRuns payload — same logic as route.ts
          if (nodeName === "financialStatementNode" && nodeUpdate?.fsOutputId) {
            fsRunId = nodeUpdate.fsOutputId as string;
          }
          if (nodeName === "payrollNode") {
            const pr = nodeUpdate?.payrollResult as Record<string, unknown> | undefined;
            if (pr?.payroll_run_id) payRunId = pr.payroll_run_id as string;
          }
          if (nodeName === "taxNode") {
            const tr = nodeUpdate?.taxResult as Record<string, unknown> | undefined;
            if (tr?.computation_id) taxRunId = tr.computation_id as string;
          }
          if (nodeName === "financialModelNode") {
            const mr = nodeUpdate?.financialModelResult as Record<string, unknown> | undefined;
            if (mr?.source_output_id) fmRunId = mr.source_output_id as string;
          }
          if (typeof nodeUpdate?.projectionPeriodYears === "number") {
            agentProjectionYears = nodeUpdate.projectionPeriodYears;
          }
        }

        // Build completedRuns array from accumulated run IDs
        const completedRuns: Array<{
          workflow:               string;
          runId:                  string;
          projectionPeriodYears?: number;
        }> = [];
        if (fsRunId)  completedRuns.push({ workflow: "fs",             runId: fsRunId  });
        if (payRunId) completedRuns.push({ workflow: "payroll",        runId: payRunId });
        if (taxRunId) completedRuns.push({ workflow: "tax",            runId: taxRunId });
        if (fmRunId)  completedRuns.push({
          workflow:              "financialModel",
          runId:                 fmRunId,
          projectionPeriodYears: typeof agentProjectionYears === "number" ? agentProjectionYears : 3,
        });

        send({
          event: "graph:complete",
          data:  { summary: finalSummary ?? "", completedRuns },
        });

      } catch (err) {
        // Unhandled graph error — emit and let the client handle it
        send({ event: "graph:error", data: { error: (err as Error).message } });
      } finally {
        // Always close the stream — same rule as app/api/agent/route.ts
        controller.close();
      }
    },
  });

  // Return SSE response with the same headers used by all other SSE routes
  return new Response(sseStream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",  // prevents nginx/Vercel from buffering the stream
    },
  });
}
