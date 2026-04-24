/**
 * app/api/receipts/save/route.ts
 *
 * API route: POST /api/receipts/save
 *
 * Saves confirmed receipt line items to the receipts table in the client's
 * Supabase schema. Part of Improvement B — Receipt Segregation (Prompt B3).
 *
 * Request body (JSON):
 *   schemaName:    string  — client's Supabase schema (e.g. "techsoft_pte_ltd")
 *   period:        string  — transaction period (e.g. "March 2026")
 *   incomeItems:   ReceiptLineItem[]
 *   expenseItems:  ReceiptLineItem[]
 *
 * Response:
 *   { saved: number }         — count of rows inserted
 *   { error: string }         — on failure
 *
 * Uses the same supabase singleton and .schema(schemaName) pattern established
 * throughout the project (see app/api/tax/compute/route.ts for reference).
 *
 * This route does not generate or return the trial balance — that is handled
 * client-side via lib/receiptToTrialBalance.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { auth } from "@/auth";
import type { ReceiptLineItem } from "@/app/api/receipts/extract/route";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    schemaName:   string;
    period:       string;
    incomeItems:  ReceiptLineItem[];
    expenseItems: ReceiptLineItem[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { schemaName, period, incomeItems, expenseItems } = body;

  if (!schemaName || typeof schemaName !== "string" || !schemaName.trim()) {
    return NextResponse.json(
      { error: "Field 'schemaName' is required." },
      { status: 400 }
    );
  }

  if (!period || typeof period !== "string" || !period.trim()) {
    return NextResponse.json(
      { error: "Field 'period' is required." },
      { status: 400 }
    );
  }

  if (!Array.isArray(incomeItems) || !Array.isArray(expenseItems)) {
    return NextResponse.json(
      { error: "Fields 'incomeItems' and 'expenseItems' must be arrays." },
      { status: 400 }
    );
  }

  // ── Build insert rows ───────────────────────────────────────────────────────

  type ReceiptRow = {
    period:                string;
    type:                  "income" | "expense";
    description:           string;
    amount:                number;
    currency:              string;
    extraction_confidence: string;
  };

  function toRows(
    items: ReceiptLineItem[],
    type: "income" | "expense"
  ): ReceiptRow[] {
    return items
      .filter((item) => item.description?.trim() && item.amount != null)
      .map((item) => ({
        period:                period.trim(),
        type,
        description:           item.description.trim(),
        amount:                parseFloat(item.amount) || 0,
        currency:              "SGD",
        extraction_confidence: item.extraction_confidence,
      }));
  }

  const rows: ReceiptRow[] = [
    ...toRows(incomeItems,  "income"),
    ...toRows(expenseItems, "expense"),
  ];

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No valid items to save." },
      { status: 422 }
    );
  }

  // ── Insert into client schema ───────────────────────────────────────────────

  const { error: dbError } = await supabase
    .schema(schemaName.trim())
    .from("receipts")
    .insert(rows);

  if (dbError) {
    console.error("[/api/receipts/save] Supabase error:", dbError.message);
    return NextResponse.json(
      { error: `Database error: ${dbError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ saved: rows.length });
}
