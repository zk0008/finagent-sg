/**
 * lib/agents/intentDetector.ts
 *
 * Pure TypeScript intent detector for the FinAgent-SG multi-agent system.
 * No LLM calls — rule-based keyword matching only.
 *
 * detectAgentIntent() inspects the user's chat message and decides whether it
 * is a compliance workflow goal that should be routed to /api/agent rather than
 * the standard /api/chat RAG chatbot.
 *
 * Detection logic:
 *   1. Each workflow flag (runFS, runPayroll, runTax, runFinancialModel) is set
 *      by matching a list of domain keywords against the lowercased message.
 *   2. isAgentGoal is true only when at least one workflow flag is set AND the
 *      message also contains an action verb — this filters out questions like
 *      "what is a financial statement?" which mention domain words but are not
 *      workflow requests.
 *   3. Temporal fields (financialYear, payrollMonth, etc.) are extracted from
 *      the message text with simple regex patterns when present.
 *
 * All matching is case-insensitive. No external dependencies.
 */

// ── Return type ───────────────────────────────────────────────────────────────

export interface AgentIntent {
  isAgentGoal:          boolean;
  runFS:                boolean;
  runPayroll:           boolean;
  runTax:               boolean;
  runFinancialModel:    boolean;
  financialYear?:       string;
  payrollMonth?:        number;
  payrollYear?:         number;
  yearOfAssessment?:    string;
  projectionPeriodYears?: number;
}

// ── Keyword tables ────────────────────────────────────────────────────────────

// Phrases that indicate the user wants the FS pipeline
const FS_KEYWORDS = [
  "financial statement",
  "trial balance",
  "balance sheet",
  "income statement",
  "profit and loss",
];

// Phrases that indicate the user wants the payroll pipeline
const PAYROLL_KEYWORDS = [
  "payroll",
  "cpf",
  "salary",
  "salaries",
  "pay slip",
  "payslip",
];

// Phrases that indicate the user wants the tax pipeline
const TAX_KEYWORDS = [
  "tax",
  "form c",
  "corporate tax",
  "income tax",
  "ya20",   // matches "YA2025", "YA2026" etc. when written without a space
  "ya",     // catches "YA 2026" (space-separated) which "ya20" misses
];

// Phrases that indicate the user wants the financial model pipeline
const MODEL_KEYWORDS = [
  "financial model",
  "projection",
  "scenario",
  "forecast",
  "budget",
];

// Action verbs that distinguish "do this task" from "explain this concept"
const ACTION_KEYWORDS = [
  "prepare",
  "generate",
  "run",
  "process",
  "compute",
  "create",
  "produce",
  "calculate",
];

// Full English month names mapped to their 1-based numeric equivalent
const MONTH_NAMES: Record<string, number> = {
  january:   1,
  february:  2,
  march:     3,
  april:     4,
  may:       5,
  june:      6,
  july:      7,
  august:    8,
  september: 9,
  october:   10,
  november:  11,
  december:  12,
};

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Returns true if the lowercased message contains any of the given keyword phrases.
 * Simple substring match — no stemming needed for this use case.
 */
function containsAny(lower: string, keywords: string[]): boolean {
  return keywords.some((kw) => lower.includes(kw));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Inspects a user chat message and returns a structured intent object.
 * All detection is rule-based — no LLM call, no async, no side effects.
 */
export function detectAgentIntent(message: string): AgentIntent {
  // Normalise once; every check below operates on this lowercase copy
  const lower = message.toLowerCase();

  // ── Workflow flags ─────────────────────────────────────────────────────────
  const runFS             = containsAny(lower, FS_KEYWORDS);
  const runPayroll        = containsAny(lower, PAYROLL_KEYWORDS);
  const runTax            = containsAny(lower, TAX_KEYWORDS);
  const runFinancialModel = containsAny(lower, MODEL_KEYWORDS);

  // ── Action check — must also mention a doing verb ─────────────────────────
  const hasAction = containsAny(lower, ACTION_KEYWORDS);

  // isAgentGoal requires at least one domain match plus an action verb
  const isAgentGoal =
    (runFS || runPayroll || runTax || runFinancialModel) && hasAction;

  // ── Optional field extraction ──────────────────────────────────────────────

  // financialYear / payrollYear — first 4-digit year in the 2020–2030 range
  // Both fields read from the same year in the message; caller uses which is relevant
  const yearMatch = message.match(/\b(202[0-9]|2030)\b/);
  const extractedYear = yearMatch ? yearMatch[1] : undefined;

  // yearOfAssessment — "YA2025", "ya 2026", etc.
  // Capture the full "YAXXXX" token, normalised to uppercase with no space
  const yaMatch = message.match(/\bya\s?(20\d{2})\b/i);
  const yearOfAssessment = yaMatch ? `YA${yaMatch[1]}` : undefined;

  // payrollMonth — month name (January–December) or standalone 1–12 digit
  let payrollMonth: number | undefined;

  // Try month name first (more specific than a bare number)
  const monthNameMatch = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/
  );
  if (monthNameMatch) {
    payrollMonth = MONTH_NAMES[monthNameMatch[1]];
  } else {
    // Fall back to a bare 1–12 number; require word boundaries to avoid
    // accidentally matching years or other numerals
    const monthNumMatch = message.match(/\b(1[0-2]|[1-9])\b/);
    if (monthNumMatch) {
      payrollMonth = parseInt(monthNumMatch[1], 10);
    }
  }

  // projectionPeriodYears — a number immediately followed by "year" or "years"
  // e.g. "3 year", "5-year", "three years" — only handles digit form here
  const projMatch = message.match(/\b(\d+)\s*-?\s*years?\b/i);
  const projectionPeriodYears = projMatch
    ? parseInt(projMatch[1], 10)
    : undefined;

  return {
    isAgentGoal,
    runFS,
    runPayroll,
    runTax,
    runFinancialModel,
    financialYear:         extractedYear,       // string e.g. "2025", or undefined
    payrollMonth,                               // number 1–12, or undefined
    payrollYear:           extractedYear        // same year token doubles as payroll year
      ? parseInt(extractedYear, 10)
      : undefined,
    yearOfAssessment,                           // string e.g. "YA2026", or undefined
    projectionPeriodYears,                      // number e.g. 3, or undefined
  };
}
