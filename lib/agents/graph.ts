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
  // Three-branch routing in priority order:
  //   1. pendingActionConfirmed bypass — skip managerNode entirely when the graph
  //      was re-invoked after the user confirmed a write action. Workflow flags were
  //      already extracted by the LLM in the original run and are preserved in state
  //      by the confirm route. Going through managerNode again would cause the LLM's
  //      local accumulators (all starting at false) to overwrite those flags via the
  //      last-write-wins reducer, producing "No workflows were executed".
  //   2. missingInputs guard — stop early if validation found absent required fields.
  //   3. Normal path — hand control to managerNode to parse the goal and set flags.
  .addConditionalEdges("validationNode", (state: State) => {
    if (state.pendingActionConfirmed === true) {
      // Re-invocation after action confirmation — route directly to the first
      // flagged worker using the same priority order as the managerNode edge.
      // If no workflow flags are set (action-only goal), go straight to summary.
      if (state.runFS)             return "financialStatementNode";  // FS takes priority
      if (state.runPayroll)        return "payrollNode";              // then Payroll
      if (state.runTax)            return "taxNode";                  // then Tax
      if (state.runFinancialModel) return "financialModelNode";       // then Financial Model
      return "summaryNode";        // no workflow flags — emit action-complete summary
    }
    if (state.missingInputs.length > 0) {
      return END;            // missing inputs → stop; caller reads state.missingInputs
    }
    return "managerNode";    // all inputs present → let Manager route to workers
  })

  // ── Edge 3: after managerNode ───────────────────────────────────────────────
  // pendingAction check runs FIRST — when an action tool was queued for
  // confirmation, skip all workers and go directly to summaryNode which will
  // emit the "review and approve" message. Workflow flags and parameters are
  // preserved in state for when the graph is re-invoked after confirmation.
  // Priority routing for workflows: FS first (chains to taxNode if runTax),
  // then Payroll, standalone Tax, Financial Model. Fallback to summary if none.
  .addConditionalEdges("managerNode", (state: State) => {
    if (state.pendingAction) return "summaryNode";               // confirmation pending → skip workers
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
