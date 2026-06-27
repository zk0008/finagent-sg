/**
 * app/api/auth/forgot-password/route.ts
 *
 * POST /api/auth/forgot-password
 *
 * Accepts: { email }
 * Generates a one-time password reset token (1 hour expiry) and sends a
 * reset link to the user's email. Always returns 200 regardless of whether
 * the email exists, to prevent account enumeration.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabaseClient";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rateLimit";

const ForgotSchema = z.object({
  email: z.string().email().toLowerCase(),
});

const GENERIC_RESPONSE = {
  message: "If an account exists, a password reset email has been sent.",
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`forgot-password:${ip}`, 3, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: z.infer<typeof ForgotSchema>;
  try {
    const raw = await req.json();
    body = ForgotSchema.parse(raw);
  } catch {
    // Generic 200 — do not reveal validation errors (email enumeration)
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  // Look up user — silently succeed if not found
  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("email", body.email)
    .maybeSingle();

  if (!user) {
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  // Remove any existing reset tokens for this user before issuing a new one
  await supabase
    .from("password_reset_tokens")
    .delete()
    .eq("user_id", user.id);

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  const { error: insertError } = await supabase.from("password_reset_tokens").insert({
    user_id:    user.id,
    token,
    expires_at: expiresAt,
  });

  if (insertError) {
    console.error("[forgot-password] Failed to insert reset token:", insertError.message);
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  const resetUrl = `${process.env.NEXTAUTH_URL}/auth/reset-password?token=${token}`;

  const emailResult = await sendEmail({
    to:      user.email as string,
    subject: "Reset your password — FinAgent-SG",
    html: `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1917;max-width:480px;margin:0 auto;padding:32px 16px;">
  <p style="font-size:14px;font-weight:600;margin:0 0 4px;">FinAgent-SG</p>
  <h1 style="font-size:18px;font-weight:600;margin:0 0 16px;">Reset your password</h1>
  <p style="font-size:14px;line-height:1.6;margin:0 0 24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
  <a href="${resetUrl}" style="display:inline-block;background-color:#3D6B52;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;">Reset password</a>
  <p style="font-size:13px;color:#6B6560;margin:32px 0 0;line-height:1.6;">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#3D6B52;">${resetUrl}</span></p>
  <p style="font-size:12px;color:#9B9490;margin:24px 0 0;">If you didn't request a password reset, you can ignore this email. Your password will not change.</p>
</body>
</html>`,
  });

  if (!emailResult.success) {
    console.error("[forgot-password] Email failed to send for:", user.email);
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
}
