/**
 * app/api/auth/verify-email/route.ts
 *
 * GET /api/auth/verify-email?token=<token>
 *
 * Validates an email verification token. On success, sets email_verified = true
 * on the user, deletes the single-use token, and redirects to the verify-email
 * status page with ?status=success. On any failure, redirects with ?status=invalid.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(`${baseUrl}/auth/verify-email?status=invalid`);
  }

  // Fetch the token row — rejects if expired
  const { data: tokenRow, error } = await supabase
    .from("verification_tokens")
    .select("id, user_id, expires_at")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())  // expired rows return no result
    .maybeSingle();

  if (error || !tokenRow) {
    return NextResponse.redirect(`${baseUrl}/auth/verify-email?status=invalid`);
  }

  // Mark the user's email as verified
  const { error: updateError } = await supabase
    .from("users")
    .update({ email_verified: true })
    .eq("id", tokenRow.user_id);

  if (updateError) {
    console.error("[verify-email] Failed to set email_verified:", updateError.message);
    return NextResponse.redirect(`${baseUrl}/auth/verify-email?status=invalid`);
  }

  // Delete token — single use only
  await supabase.from("verification_tokens").delete().eq("id", tokenRow.id);

  return NextResponse.redirect(`${baseUrl}/auth/verify-email?status=success`);
}
