/**
 * app/api/auth/reset-password/route.ts
 *
 * POST /api/auth/reset-password
 *
 * Accepts: { token, password }
 * Validates the reset token, hashes the new password, updates the user,
 * also marks email_verified = true (link access proves email ownership),
 * and deletes the single-use token.
 *
 * Errors:
 *   400 — token invalid/expired, or validation failure
 *   500 — DB update failure
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabaseClient";

const ResetSchema = z.object({
  token:    z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof ResetSchema>;
  try {
    const raw = await req.json();
    body = ResetSchema.parse(raw);
  } catch (err) {
    const message =
      err instanceof z.ZodError ? (err.issues?.[0]?.message ?? err.message) : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Look up the token — must exist and not be expired
  const { data: tokenRow, error: tokenError } = await supabase
    .from("password_reset_tokens")
    .select("id, user_id, expires_at")
    .eq("token", body.token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired." },
      { status: 400 }
    );
  }

  const password_hash = await bcrypt.hash(body.password, 12);

  // Update password; also verify email since link access proves ownership
  const { error: updateError } = await supabase
    .from("users")
    .update({ password_hash, email_verified: true })
    .eq("id", tokenRow.user_id);

  if (updateError) {
    console.error("[reset-password] Failed to update user:", updateError.message);
    return NextResponse.json(
      { error: "Failed to reset password. Please try again." },
      { status: 500 }
    );
  }

  // Delete token — single use only
  await supabase.from("password_reset_tokens").delete().eq("id", tokenRow.id);

  return NextResponse.json({ message: "Password has been reset." }, { status: 200 });
}
