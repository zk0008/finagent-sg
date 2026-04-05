/**
 * app/api/admin/costs/route.ts
 *
 * GET /api/admin/costs — Last 30 days token usage and estimated cost (Phase 6, Task 8).
 *
 * Admin role required — returns 403 for non-admin sessions.
 *
 * Queries the Langfuse REST API (/api/public/observations?type=GENERATION) and computes estimated cost:
 *   GPT-4.1:      $2.00/1M input,  $8.00/1M output
 *   GPT-4.1-mini: $0.40/1M input,  $1.60/1M output
 *
 * Response:
 *   {
 *     period: { from: string, to: string }
 *     models: { model: string, input_tokens: number, output_tokens: number, cost_usd: number }[]
 *     total_cost_usd: number
 *   }
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Pricing per token (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4.1":      { input: 2.00 / 1_000_000, output: 8.00 / 1_000_000 },
  "gpt-4.1-mini": { input: 0.40 / 1_000_000, output: 1.60 / 1_000_000 },
};

type LangfuseGeneration = {
  model?: string | null;
  usage?: {
    input?: number;
    output?: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null;
};

export async function GET(): Promise<NextResponse> {
  // Require admin session
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const langfuseHost = process.env.LANGFUSE_HOST ?? "http://localhost:3001";
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
  const auth64 = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);

  try {
    // Fetch generations from Langfuse REST API
    // Self-hosted Langfuse v2 uses /api/public/observations?type=GENERATION
    const url = new URL(`${langfuseHost}/api/public/observations`);
    url.searchParams.set("type", "GENERATION");
    url.searchParams.set("fromStartTime", fromDate.toISOString());
    url.searchParams.set("toStartTime", toDate.toISOString());
    url.searchParams.set("limit", "100");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${auth64}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Langfuse API returned ${res.status}: ${body}`);
    }

    const data: { data?: LangfuseGeneration[] } = await res.json();
    const generations = data.data ?? [];

    // Aggregate token usage per model
    const modelStats: Record<string, { input: number; output: number }> = {};

    for (const gen of generations) {
      const model = (gen.model ?? "unknown").toLowerCase();
      const inputTokens = gen.usage?.input ?? gen.usage?.promptTokens ?? 0;
      const outputTokens = gen.usage?.output ?? gen.usage?.completionTokens ?? 0;

      if (!modelStats[model]) modelStats[model] = { input: 0, output: 0 };
      modelStats[model].input += inputTokens;
      modelStats[model].output += outputTokens;
    }

    // Compute estimated cost per model
    let totalCost = 0;
    const models = Object.entries(modelStats).map(([model, tokens]) => {
      const pricing = MODEL_PRICING[model];
      const cost = pricing
        ? tokens.input * pricing.input + tokens.output * pricing.output
        : 0;
      totalCost += cost;
      return {
        model,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cost_usd: Math.round(cost * 10_000) / 10_000,
      };
    });

    return NextResponse.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      models,
      total_cost_usd: Math.round(totalCost * 10_000) / 10_000,
    });
  } catch (err) {
    console.error("[admin/costs] Failed to fetch Langfuse data:", err);
    return NextResponse.json(
      { error: "Failed to fetch cost data from Langfuse" },
      { status: 500 }
    );
  }
}
