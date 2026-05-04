# PHASES_V3.md — FinAgent-SG Phase V3: Multi-Agent Architecture

## Overview

Phase V3 transforms FinAgent-SG from a tool-assisted LLM application into a true agentic system using **LangGraph.js** (`@langchain/langgraph`) as the orchestration layer. The chatbot becomes the entry point to a graph-based multi-agent pipeline where a Validation Node checks required inputs upfront, a Manager Node parses the user's goal, and specialised Worker Nodes execute the four core compliance workflows.

LangGraph.js was chosen over manual TypeScript implementation and CrewAI because:
- It is native TypeScript — no Python microservice, no second deployment, stays in the existing Next.js codebase
- Its node/edge model directly encodes the rule-based sequencing decisions locked in this phase
- Shared graph state natively handles result passing between nodes (e.g. FS output → Tax node)
- Its streaming support integrates with the existing SSE pattern already in the stack
- Langfuse (already self-hosted) is integrated via the existing `getLangfuse()` singleton — `langfuse-langchain` was excluded due to a `@langchain/core` version conflict with LangGraph

The existing API routes, computation engines, and Supabase schemas are **unchanged**. The agent layer is a new orchestration layer built entirely on top.

---

## Architecture

```
User Goal (chat)
      ↓
app/api/agent/route.ts              ← new API route, SSE streaming, Langfuse trace
      ↓
LangGraph.js StateGraph             ← new orchestration layer
      ↓
┌──────────────────────────────────────────┐
│  Validation Node                         │  ← pure TypeScript, no LLM call
│  checks clientId + all required inputs   │  ← reads nothing from Supabase
└──────────────┬───────────────────────────┘
               │ missing inputs → return list to user, stop
               │ all inputs present → continue
               ↓
┌──────────────────────────────────────────┐
│  Manager Node (GPT-4.1)                  │  ← parses goal, sets run flags
└──────┬───────┬───────┬───────────────────┘
       │       │       │
  [edges — rule-based, hardcoded in TypeScript]
       │       │       │
  FS Node  Payroll  Financial Model Node
       │    Node
       │  [FS output written to shared graph state]
       ↓
  Tax Node     ← runs after FS Node (chain) OR standalone with Supabase fsOutputId fallback
       │
       ↓
┌──────────────────────────────────────────┐
│  Summary Node                            │  ← collects results, posts to chat
└──────────────────────────────────────────┘
      ↓
Existing API routes  [app/api/]            ← unchanged
      ↓
Existing computation engines              ← unchanged
      ↓
Existing Supabase per-client schemas      ← unchanged
```

---

## Key Design Decisions (locked)

- **Framework**: LangGraph.js (`@langchain/langgraph`) — TypeScript, installed as npm package, no Python
- **Sequencing**: Rule-based, hardcoded as graph edges in TypeScript. LLM decides which workers to invoke; edges enforce order
- **FS → Tax chain**: When both FS and Tax are requested, FS runs first and passes `fsOutputId` via shared state. When Tax is requested standalone, `taxNode` falls back to querying Supabase for the latest saved FS output
- **FS → Financial Model**: Same pattern as Tax — chain when FS is also requested, Supabase fallback when standalone
- **Input validation**: Validation Node runs before any LLM call. Missing inputs are listed to the user; nothing executes until all are present
- **Client selection**: `clientId` must be explicitly selected by the user via the dropdown. If not selected, the agent prompts for it — no default assumption
- **Database as source of truth**: Worker nodes read saved data from Supabase — users never re-enter data already saved via the manual UI
- **Observability**: Manual Langfuse trace via existing `getLangfuse()` singleton — records goal, clientId, and final summary per run
- **Additive only**: Manual UI continues to work as-is. The graph is an additional entry point, not a replacement

---

## New Files Added

| File | Purpose |
|---|---|
| `lib/agents/state.ts` | LangGraph Annotation state schema shared by all nodes |
| `lib/agents/graph.ts` | Compiled StateGraph — all 7 nodes registered, all edges wired |
| `lib/agents/nodes/index.ts` | All 7 node implementations |
| `lib/agents/intentDetector.ts` | Pure keyword intent detection — no LLM, no external calls |
| `app/api/agent/route.ts` | SSE entry point — invokes graph, emits progress events, Langfuse trace |
| `app/api/financial-statements/generate/route.ts` | Agent-facing FS wrapper — re-runs generation from saved classified accounts |
| `app/api/payroll/process/route.ts` | Agent-facing payroll wrapper — loads employees from DB, runs computePayroll |
| `app/api/financial-model/generate/route.ts` | Agent-facing model wrapper — loads FS output, runs runAllScenarios |
| `app/api/tax/agent/route.ts` | Agent-facing tax wrapper — separate from /api/tax/compute (UI route unchanged) |
| `components/AgentProgressPanel.tsx` | Renders per-node progress and summary in chat UI |

## Modified Files

| File | What Changed |
|---|---|
| `lib/agents/state.ts` | Added fetchedContext field — merge-reducer Record<string, string> tracking what each node fetched from Supabase |
| `app/page.tsx` | Added `clientSelected` state; passed to ChatbotPanel |
| `components/ChatbotPanel.tsx` | Added intent detection branch, agent state vars, AgentProgressPanel render |
| `proxy.ts` | Added 4 exact-path exemptions for agent-internal routes (each still protected by `verifySchemaAccess`) |
| `package.json` | Added `@langchain/langgraph`, `@langchain/core`, `@langchain/openai` |

---

## Improvements

### V3-A — LangGraph.js Installation and Graph Scaffold
**Status**: [x] Complete

Installed `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`. Created `lib/agents/state.ts`, `lib/agents/graph.ts`, `lib/agents/nodes/index.ts` (stubs). Full StateGraph wired with all 7 nodes and edges. tsc clean.

### V3-B — Validation Node and Worker Nodes
**Status**: [x] Complete

All 7 stubs replaced with real implementations. Four agent-facing wrapper routes created. `taxNode` and `financialModelNode` both include Supabase `fsOutputId` fallback for standalone runs. tsc clean.

**Bug found and fixed during V3-B**: Worker nodes were calling `res.json()` before checking `res.ok`, causing opaque HTML parse errors when the route returned a non-2xx response. Fixed: `res.ok` checked first; body read as text on failure. All four wrapper routes also wrapped in top-level try/catch to prevent Next.js HTML 500 pages.

### V3-C — Agent API Route and SSE Streaming
**Status**: [x] Complete

Created `app/api/agent/route.ts` with SSE streaming using existing pattern. Langfuse integration via manual `getLangfuse()` trace — `langfuse-langchain` excluded due to `@langchain/core@1.x` vs `@langchain/core@0.3.x` version conflict. Created `components/AgentProgressPanel.tsx` matching existing WorkflowPanel Tailwind style.

### V3-D — Chat UI Integration
**Status**: [x] Complete

Created `lib/agents/intentDetector.ts` — pure keyword matching, no LLM call. Modified `components/ChatbotPanel.tsx` to detect agent goals and route to `/api/agent`. `AgentProgressPanel` renders below message list when agent is running or complete. Standard `/api/chat` path entirely unchanged.

**Bugs found and fixed post V3-D**:
- Auth redirect: internal fetch from worker nodes had no session cookie → `proxy.ts` returned 301 → HTML login page → parse error. Fixed: 4 exact-path exemptions added to `proxy.ts`; each route retains `verifySchemaAccess()` as its own auth layer
- Client selection assumption: `clientId` defaulted to `"techsoft_pte_ltd"` silently. Fixed: `clientSelected` prop added; agent blocked with missing input message until user explicitly selects a client
- Tax intent not detected: `"YA 2026"` (space-separated) not matched by `"ya20"` keyword. Fixed: added `"ya"` to `TAX_KEYWORDS`
- Tax node not reachable standalone: `graph.ts` conditional edge after `managerNode` never routed to `taxNode` when `runFS` was false. Fixed: `runTax && !runFS` now routes directly to `taxNode`; Supabase fallback handles `fsOutputId` resolution

### V3-E — PHASES_V3.md
**Status**: [x] Complete

---

## Smoke Test Results (all passing)

| Test | Result |
|---|---|
| FS generation with client selected | ✅ |
| Payroll end-to-end with employee data | ✅ |
| Tax standalone (client with saved FS) | ✅ |
| Tax standalone (client without saved FS) | ✅ Correct error — no false execution |
| Financial model standalone (Supabase fallback) | ✅ |
| Multi-workflow FS + Tax in sequence | ✅ |
| No client selected | ✅ Blocked with missing input message |
| Missing payroll inputs | ✅ Blocked with missing input message |

---

## Known Gaps (post-commit backlog)

These are confirmed gaps found during smoke testing. They do not affect correctness of the agent orchestration layer — they are UI and output improvements.

| Gap | Description |
|---|---|
| Output transparency | RESOLVED — Nodes write fetchedContext entries describing what Supabase data was fetched (fiscal year, employee count, FS output date). summaryNode appends a Data used section to the summary when fetchedContext is non-empty. |
| Placeholder chat text | RESOLVED — Floating hint panel added to chat input showing example commands for all three modes (agent, question, correction). Panel stays visible while typing, hides on outside click, text is selectable. |
| Chat UI polish | RESOLVED — Dummy placeholder conversation removed. Welcome message added. Chatbot heading updated to "FinAgent". Subtitle updated to "Run workflows · Ask questions · Submit corrections". |
| Download capability | After agent completes a workflow, user needs to download outputs (payslips, PDFs). Currently no download UI is triggered by agent-generated runs |
| Payroll history view | Agent-generated payroll runs are saved to Supabase but the PayrollWorkflow UI has no past-runs loader — downloads require in-session state |

---

## Deferred

- **Receipt-to-trial-balance agent loop** — deferred to a future phase
- **Multi-currency support** — remains deferred from V2
- **LangGraph Platform** — using open-source LangGraph.js only; cloud platform not required

---

## V3.1 — Planned: Obsidian Knowledge Store

After each agent run, write a structured markdown note to a local Obsidian vault recording what was run, what data was fetched, and what the outputs were. Over time the vault becomes a compounding knowledge base of every compliance run per client. The agent queries this vault in future runs to improve responses — for example, recalling a client's prior depreciation method or CPF contribution pattern.

**Approach**: Based on the Karpathy LLM Wiki pattern — plain markdown files replace vector retrieval for run history. No new infrastructure required locally. Vault lives outside the Next.js project as a separate folder.

**Deployment note**: Obsidian is local-first. V3.1 targets local development only for now — vault persistence in a deployed environment (Vercel has no persistent filesystem) is deferred.

**Scope** (to be detailed in V3.1 planning):
- After each successful agent run, write a `.md` note to `vault/runs/{clientId}/YYYY-MM-DD-{workflow}.md`
- Note contains: client, workflow, inputs used, data fetched from Supabase, output summary, any errors
- Manager Node reads recent vault notes for the client at the start of each run to inform its response
- No change to existing Supabase storage — vault is additive

---

## Implementation Order (V3 complete — next: V3.1 after known gaps resolved)

- [x] V3-A — LangGraph.js installation and graph scaffold
- [x] V3-B — Validation Node and Worker Nodes
- [x] V3-C — Agent API route and SSE streaming
- [x] V3-D — Chat UI integration
- [x] V3-E — PHASES_V3.md
- [x] Known gaps — placeholder text, chat UI polish, post-completion guidance, output transparency (download capability and payroll history view remain open)
- [ ] V3.1 — Obsidian knowledge store (local dev only)
