/**
 * app/api/auth/register/route.ts
 *
 * Registration is disabled in production.
 * New accounts are created by the administrator directly in Supabase.
 */

import { NextResponse } from "next/server";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ error: "Registration is not available." }, { status: 404 });
}
