/**
 * lib/agents/graph.ts
 *
 * Defines, wires, and compiles the full LangGraph StateGraph for FinAgent-SG.
 * All seven nodes and all edges are registered here, even while nodes are stubs.
 * This file is the single source of truth for graph topology.
 *
 * Graph flow (high level):
 *   START
 *     → validationNode
 *         → END                      (if missingInputs.length > 0)
 *         → managerNode              (all inputs present)
 *             → financialStatementNode  (if runFS)
 *                 → taxNode             (if runTax)
 *                     → summaryNode → END
 *                 → summaryNode → END  (runTax is false)
 *             → payrollNode          (if runPayroll)
 *                 → summaryNode → END
 *             → financialModelNode   (if runFinancialModel)
 *                 → summaryNode → END
 *             → summaryNode → END    (no workers needed)
 *
 * When fully implemented, invoke this graph with:
 *   import graph from "@/lib/agents/graph";
 *   const result = await graph.invoke({ goal: "...", clientId: "..." });
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { GraphState } from "./state";
import {
  validationNode,
  managerNode,
  financialStatementNode,
  payrollNode,
  taxNode,
  financialModelNode,
  summaryNode,
} from "./nodes/index";

// Shorthand for the state type so the conditional edge functions are readable
type State = typeof GraphState.State;

const graph = new StateGraph(GraphState)

  // ── Register all seven nodes ────────────────────────────────────────────────
  .addNode("validationNode", validationNode)
  .addNode("managerNode", managerNode)
  .addNode("financialStatementNode", financialStatementNode)
  .addNode("payrollNode", payrollNode)
  .addNode("taxNode", taxNode)
  .addNode("financialModelNode", financialModelNode)
  .addNode("summaryNode", summaryNode)

  // ── Entry point ─────────────────────────────────────────────────────────────
  // The graph always starts at validationNode regardless of goal content
  .addEdge(START, "validationNode")

  // ── Edge 2: after validationNode ────────────────────────────────────────────
  // If any required inputs are missing, stop immediately (the caller must re-ask);
  // otherwise hand control to the Manager to decide which workers to run.
  .addConditionalEdges("validationNode", (state: State) => {
    if (state.missingInputs.length > 0) {
      return END;            // missing inputs → stop; caller reads state.missingInputs
    }
    return "managerNode";    // all inputs present → let Manager route to workers
  })

  // ── Edge 3: after managerNode ───────────────────────────────────────────────
  // Priority routing: FS first, then Payroll, then Financial Model.
  // Only one worker runs per graph invocation; the Manager sets exactly one flag.
  // If for some reason no flags are true, route directly to summary.
  .addConditionalEdges("managerNode", (state: State) => {
    if (state.runFS) return "financialStatementNode";            // FS takes priority (chains to taxNode if runTax)
    if (state.runPayroll) return "payrollNode";                  // then Payroll
    if (state.runTax) return "taxNode";                          // standalone Tax (taxNode resolves fsOutputId via Supabase)
    if (state.runFinancialModel) return "financialModelNode";    // then Financial Model
    return "summaryNode";    // no workers needed → go straight to summary
  })

  // ── Edge 4: after financialStatementNode ────────────────────────────────────
  // Tax computation reads from the FS output, so it must run after FS if needed.
  // fsOutputId is written by the FS node and is available in state here.
  .addConditionalEdges("financialStatementNode", (state: State) => {
    if (state.runTax) return "taxNode";    // chain into tax if Manager requested it
    return "summaryNode";                  // no tax → go straight to summary
  })

  // ── Edges 5–7: workers that always route straight to summary ────────────────
  .addEdge("payrollNode", "summaryNode")
  .addEdge("taxNode", "summaryNode")
  .addEdge("financialModelNode", "summaryNode")

  // ── Edge 8: summary is always the terminal node ─────────────────────────────
  .addEdge("summaryNode", END)

  // ── Compile ─────────────────────────────────────────────────────────────────
  // compile() validates the graph topology and returns a runnable CompiledStateGraph
  .compile();

export default graph;
