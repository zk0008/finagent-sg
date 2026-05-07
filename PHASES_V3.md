# PHASES_V3.md — FinAgent-SG Phase V3: Multi-Agent Architecture

## Overview

Phase V3 transforms FinAgent-SG from a tool-assisted LLM application 
into a true agentic system. It is built in three layers on top of 
the existing Phases 0–7 foundation:

**Layer 1 — Multi-Agent Orchestration (V3 core)**
Uses LangGraph.js (`@langchain/langgraph`) as the orchestration layer. 
The chatbot becomes the entry point to a graph-based multi-agent 
pipeline where a Validation Node checks required inputs upfront, a 
Manager Node parses the user's goal using native OpenAI tool calling, 
and specialised Worker Nodes execute the four core compliance workflows. 
The Manager Node supports multi-intent messages — a single natural 
language instruction can trigger multiple tools in sequence (e.g. 
"Add employee John and run payroll for May 2026"). Write operations 
require explicit Yes/No confirmation from the user before execution.

**Layer 2 — Obsidian Knowledge Store (V3.1)**
After each agent run, Q&A interaction, and correction submission, 
a structured markdown note is written to a local Obsidian vault. 
The Manager Node and Q&A chatbot read the last 5 notes per client 
before each LLM call, injecting prior run history as system prompt 
context. This gives the agent a compounding memory of each client's 
workflows, preferences, and corrections — a true second brain. All 
interactions are observable in Langfuse with vault context recorded 
in the trace input.

**Layer 3 — Tool Calling (V3.2, in progress)**
Replaces manual JSON parsing in the Manager Node with native Vercel 
AI SDK tool calling. Extends tool calling to high-impact locations: 
RAG knowledge base queries, tax adjustment identification, and action 
tools (add/update employee, add client, configure tax overrides). 
Each tool has a Zod-validated schema. Action tools require sequential 
Yes/No confirmation before any write operation executes.

LangGraph.js was chosen over manual TypeScript implementation and 
CrewAI because:
- It is native TypeScript — no Python microservice, no second 
  deployment, stays in the existing Next.js codebase
- Its node/edge model directly encodes rule-based sequencing decisions
- Shared graph state natively handles result passing between nodes
- Its streaming support integrates with the existing SSE pattern
- Langfuse (already self-hosted) integrates via the existing 
  getLangfuse() singleton

The existing API routes, computation engines, and Supabase schemas 
are **unchanged**. All three layers are additive on top.

---

## Architecture

```
User Goal (chat)
↓
app/api/agent/route.ts          ← SSE streaming, Langfuse trace
↓
LangGraph.js StateGraph         ← orchestration layer
↓
┌─────────────────────────────────────────────────────┐
│  Validation Node                                    │
│  checks clientId + all required inputs              │
│  reads Supabase for hard constraints (e.g. prior FS)│
└──────────────────┬──────────────────────────────────┘
                   │ missing → list to user, stop
                   │ confirmed re-invocation → bypass to worker directly
                   │ all present → continue
                   ↓
┌─────────────────────────────────────────────────────┐
│  Manager Node (GPT-4.1 + native tool calling)       │
│  reads last 5 Obsidian vault notes for client       │
│  calls tools: run_fs, run_payroll, compute_tax,     │
│  generate_model, add_employee, update_employee,     │
│  add_client, configure_tax                          │
│  multi-intent: multiple tools called per message    │
│  action tools → pendingAction (confirmation first)  │
└──────┬───────┬───────┬───────────────────────────── ┘
       │       │       │
  [edges — rule-based, hardcoded in TypeScript]
       │       │       │
  FS Node  Payroll  Financial Model Node
       │    Node
       │  [fsOutputId written to shared graph state]
       ↓
  Tax Node  ← chain after FS, OR standalone Supabase fallback
       │
       ↓
┌─────────────────────────────────────────────────────┐
│  Summary Node                                       │
│  collects results + fetchedContext + optional       │
│  inputs advisory                                    │
│  writes Obsidian vault note after every run         │
└─────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────┐
│  Obsidian Vault  ~/finagent-vault/{clientId}/       │
│  ← agent runs, Q&A, corrections all written here   │
│  ← Manager Node reads last 5 notes per client      │
└─────────────────────────────────────────────────────┘
↓
Existing API routes  [app/api/]     ← unchanged
↓
Existing computation engines       ← unchanged
↓
Existing Supabase per-client schemas ← unchanged

Confirmation flow (action tools only):
User message → Manager Node calls action tool
↓
pendingAction set in graph state
↓
ConfirmationCard rendered in chat (Yes/No buttons)
↓
Yes → POST /api/agent/confirm → execute action → re-invoke graph
No  → cancel, report to user
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
| Hard constraints and optional inputs advisory | RESOLVED — validationNode updated with FS prior-run Supabase check. summaryNode appends per-workflow optional inputs advisory after each completed workflow. accountingProfit and revenue confirmed not needed — auto-derived server-side from classified_accounts. |
| Download capability | RESOLVED — Agent signals completed runs via completedRuns payload in graph:complete SSE event. Each left panel component auto-loads the agent-generated run from Supabase and jumps to results/download view. Three new GET routes created for FS, payroll, and tax rehydration. Financial Model re-calls generate route with agent's projectionPeriodYears. Two bugs fixed post-implementation: projectionPeriodYears hardcoded to 3 in auto-load (fixed), tax_adjustments stored as JSON string instead of JSONB array causing 500 crash (fixed). |
| Payroll history view | Agent-generated payroll runs are saved to Supabase but the PayrollWorkflow UI has no past-runs loader — downloads require in-session state |

---

## Deferred

- **Receipt-to-trial-balance agent loop** — deferred to a future phase
- **Multi-currency support** — remains deferred from V2
- **LangGraph Platform** — using open-source LangGraph.js only; cloud platform not required

---

## V3.1 — Obsidian Knowledge Store
**Status**: [x] Complete

After each agent run, Q&A interaction, and correction submission, a structured markdown note is written to a local Obsidian vault folder configured via FINAGENT_VAULT_PATH environment variable (outside the project root). The Manager Node and Q&A chatbot read the last 5 notes per client before each LLM call and inject them as system prompt context. All interactions are visible in Langfuse with vaultContext recorded in the trace input.

Files added:
- lib/agents/vaultWriter.ts — writes structured markdown notes with Obsidian wiki-link tags ([[clientId]] [[workflow]])
- lib/agents/vaultReader.ts — reads last 5 notes per client, returns concatenated string

Files modified:
- lib/agents/state.ts — added vaultContext field
- lib/agents/nodes/index.ts — managerNode reads vault context and injects into system prompt; summaryNode writes vault note after each run; console.log confirms vault context loading
- app/api/agent/route.ts — vaultContext captured from graph state and recorded in Langfuse trace input
- app/api/chat/route.ts — vault context read and injected into Q&A system prompt; correction and Q&A vault notes written after each interaction; existing chat_response Langfuse trace updated to include vaultContext

Environment variable required:
  FINAGENT_VAULT_PATH=/absolute/path/to/obsidian/vault

Note: langfuse-langchain excluded due to @langchain/core version conflict — per-node Langfuse spans not available; trace-level observability only.

---

## V3.2 — Tool Calling
**Status**: [ ] Not started

Replaces manual JSON parsing in the Manager Node with native OpenAI
tool calling via Vercel AI SDK generateText with tools. Adds tool
calling to three additional high-impact locations. Introduces a
sequential Yes/No confirmation flow in the chat UI for all write
operations.

### Key design decisions (locked)
- Tool calling uses Vercel AI SDK generateText with tools — same SDK
  already in use, no new dependencies
- Multi-intent: LLM can call multiple tools in one message pass —
  each tool call is processed sequentially
- Write operations (add employee, add client, configure tax) require
  explicit Yes/No confirmation from user before execution
- Confirmation UI: inline Yes/No button card in chat, sequential —
  one pending action at a time
- FS configuration via agent already works through existing corrections
  pipeline — no new tool needed
- All financial arithmetic remains bignumber.js

### New tools defined

| Tool | Purpose | Confirmation required |
|---|---|---|
| run_financial_statement | Trigger FS workflow | No |
| run_payroll | Trigger payroll workflow | No |
| compute_tax | Trigger tax computation | No |
| generate_financial_model | Trigger financial model | No |
| query_knowledge_base | Query RAG vector store | No |
| submit_correction | Submit correction from Manager Node | No |
| identify_tax_adjustments | Propose SG tax adjustments | Yes |
| add_employee | Create employee record | Yes |
| update_employee | Update employee record | Yes |
| delete_employee | Delete employee record | Yes |
| update_employee (name resolution) | Update employee record with name-based UUID lookup | Yes |
| add_client | Create new client schema | Yes |
| configure_tax | Set accounting_profit and revenue overrides | Yes |

### Schema change
Add two nullable override fields to entities table in buildSchemaSQL():
- accounting_profit_override NUMERIC(15,2)
- revenue_override NUMERIC(15,2)

Tax agent route checks overrides first, falls back to derived values
if null.

### New graph state fields
- pendingAction: object | undefined — proposed action details written
  by Manager Node when a confirmation-required tool is called
- pendingActionConfirmed: boolean | undefined — set by user Yes/No
  response before graph resumes
- ragContext: string — RAG answer generated by Manager Node when query_knowledge_base tool is called; appended to summary

### Implementation steps
- [x] V3.2-A — Manager Node multi-intent tool calling (query_knowledge_base and submit_correction added to Manager Node; system prompt strengthened for reliable multi-intent dispatch)
- [x] V3.2-B — RAG Chatbot query_knowledge_base tool
- V3.2-C — Tax Agent identify_tax_adjustments + check_startup_eligibility
- [x] V3.2-D — Action tools: add/update/delete employee (add_client deferred — graceful redirect to Clients tab)
- V3.2-E — Tax profit/revenue override (schema change + configure_tax tool)
- [x] V3.2-F — Confirmation UI component
- V3.2-G — PHASES_V3.md update

---

## Implementation Order (V3 complete — next: V3.1 after known gaps resolved)

- [x] V3-A — LangGraph.js installation and graph scaffold
- [x] V3-B — Validation Node and Worker Nodes
- [x] V3-C — Agent API route and SSE streaming
- [x] V3-D — Chat UI integration
- [x] V3-E — PHASES_V3.md
- [x] Known gaps — placeholder text, chat UI polish, post-completion guidance, output transparency, download capability — left panel auto-load
- [x] V3.1 — Obsidian knowledge store (local dev only)
- [ ] V3.2 — Tool calling (4 high impact locations)
  - [x] V3.2-F — Confirmation UI component
  - [x] V3.2-A — Manager Node multi-intent tool calling
  - [x] V3.2-B — RAG Chatbot query_knowledge_base and submit_correction tools
  - [x] V3.2-A system prompt — reliable multi-intent dispatch with query_knowledge_base and submit_correction in Manager Node
  - [x] V3.2-D — Action tools: add/update/delete employee
  - [x] V3.2-D fixes — update_employee name resolution, intentDetector salary keyword removal, correction routing fix, hint panel three-section update
