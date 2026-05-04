/**
 * lib/agents/state.ts
 *
 * Defines the shared graph state for the FinAgent-SG multi-agent system.
 * This single object is what every LangGraph node reads from and writes back to.
 *
 * Two representations are exported:
 *   AgentStateSchema  — Zod schema used for runtime validation at API boundaries
 *   AgentState        — TypeScript type inferred from the Zod schema
 *   GraphState        — LangGraph Annotation.Root required by StateGraph constructor
 *
 * When fully wired, the graph invoke call looks like:
 *   await graph.invoke({ goal: "...", clientId: "..." })
 * All other fields default to their zero values and are populated by nodes.
 */

import { z } from "zod";
import { Annotation } from "@langchain/langgraph";

// ─── Zod schema ──────────────────────────────────────────────────────────────

export const AgentStateSchema = z.object({
  // The raw natural-language goal the user typed into chat
  goal: z.string(),

  // UUID or slug identifying which client company this run is for
  clientId: z.string(),

  // Field names found missing by the Validation node; empty means inputs are OK
  missingInputs: z.array(z.string()),

  // Worker-enable flags — the Manager node sets these based on the parsed goal
  runFS: z.boolean(),              // run Financial Statement worker
  runPayroll: z.boolean(),         // run Payroll worker
  runTax: z.boolean(),             // run Corporate Tax worker
  runFinancialModel: z.boolean(),  // run Financial Model worker

  // Temporal parameters each worker needs — undefined until Manager populates them
  financialYear: z.string().optional(),                          // e.g. "2025"
  payrollMonth: z.number().int().min(1).max(12).optional(),      // 1–12
  payrollYear: z.number().int().optional(),                      // e.g. 2025
  yearOfAssessment: z.string().optional(),                       // e.g. "YA2026"
  projectionPeriodYears: z.number().int().optional(),            // e.g. 3

  // Cross-node data: FS node writes fsOutputId so Tax and Financial Model can read it
  fsOutputId: z.string().optional(),

  // Structured results written by each worker after it finishes
  fsResult: z.record(z.string(), z.unknown()).optional(),
  payrollResult: z.record(z.string(), z.unknown()).optional(),
  taxResult: z.record(z.string(), z.unknown()).optional(),
  financialModelResult: z.record(z.string(), z.unknown()).optional(),

  // Error bag keyed by node name; any node that throws writes here instead of crashing
  errors: z.record(z.string(), z.string()),

  // Final human-readable summary produced by the Summary node, posted to chat
  summary: z.string().optional(),
});

// Inferred TypeScript type — used in node function signatures throughout the agents layer
export type AgentState = z.infer<typeof AgentStateSchema>;

// ─── LangGraph Annotation ────────────────────────────────────────────────────
// Annotation.Root is what StateGraph() expects as its constructor argument.
// Each field uses an explicit last-write-wins reducer so node return values
// simply overwrite the previous value (no merging or appending).

export const GraphState = Annotation.Root({
  // User's raw goal text — required at invoke time, no sensible default
  goal: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),

  // Which client company this run is for
  clientId: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),

  // List of missing input names; Validation node replaces the whole array
  missingInputs: Annotation<string[]>({
    reducer: (_prev: string[], next: string[]) => next,
    default: () => [],  // empty means "all inputs present"
  }),

  // Worker-enable flags; default false so nothing runs unless Manager enables it
  runFS: Annotation<boolean>({
    reducer: (_prev: boolean, next: boolean) => next,
    default: () => false,
  }),
  runPayroll: Annotation<boolean>({
    reducer: (_prev: boolean, next: boolean) => next,
    default: () => false,
  }),
  runTax: Annotation<boolean>({
    reducer: (_prev: boolean, next: boolean) => next,
    default: () => false,
  }),
  runFinancialModel: Annotation<boolean>({
    reducer: (_prev: boolean, next: boolean) => next,
    default: () => false,
  }),

  // Temporal parameters; undefined until the Manager node sets them
  financialYear: Annotation<string | undefined>({
    reducer: (_prev: string | undefined, next: string | undefined) => next,
    default: () => undefined,
  }),
  payrollMonth: Annotation<number | undefined>({
    reducer: (_prev: number | undefined, next: number | undefined) => next,
    default: () => undefined,
  }),
  payrollYear: Annotation<number | undefined>({
    reducer: (_prev: number | undefined, next: number | undefined) => next,
    default: () => undefined,
  }),
  yearOfAssessment: Annotation<string | undefined>({
    reducer: (_prev: string | undefined, next: string | undefined) => next,
    default: () => undefined,
  }),
  projectionPeriodYears: Annotation<number | undefined>({
    reducer: (_prev: number | undefined, next: number | undefined) => next,
    default: () => undefined,
  }),

  // FS output DB row ID — written by FS node, read by Tax and Financial Model nodes
  fsOutputId: Annotation<string | undefined>({
    reducer: (_prev: string | undefined, next: string | undefined) => next,
    default: () => undefined,
  }),

  // Worker results — each worker writes its own slot; other nodes read them
  fsResult: Annotation<object | undefined>({
    reducer: (_prev: object | undefined, next: object | undefined) => next,
    default: () => undefined,
  }),
  payrollResult: Annotation<object | undefined>({
    reducer: (_prev: object | undefined, next: object | undefined) => next,
    default: () => undefined,
  }),
  taxResult: Annotation<object | undefined>({
    reducer: (_prev: object | undefined, next: object | undefined) => next,
    default: () => undefined,
  }),
  financialModelResult: Annotation<object | undefined>({
    reducer: (_prev: object | undefined, next: object | undefined) => next,
    default: () => undefined,
  }),

  // Error bag keyed by node name; starts empty, nodes append on failure
  errors: Annotation<Record<string, string>>({
    reducer: (_prev: Record<string, string>, next: Record<string, string>) => next,
    default: () => ({}),
  }),

  // Final summary text; undefined until the Summary node writes it
  summary: Annotation<string | undefined>({
    reducer: (_prev: string | undefined, next: string | undefined) => next,
    default: () => undefined,
  }),
});