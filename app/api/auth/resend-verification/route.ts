/**
 * app/api/auth/resend-verification/route.ts
 *
 * POST /api/auth/resend-verification
 *
 * Accepts: { email }
 * Deletes any existing verification token for the user, generates a new one,
 * and sends a fresh verification email. Always returns 200 to avoid leaking
 * whether an account exists for the given email.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabaseClient";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rateLimit";

const ResendSchema = z.object({
  email: z.string().email("Invalid email address").toLowerCase(),
});

const GENERIC_RESPONSE = {
  message: "If an account exists, a verification email has been sent.",
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`resend-verification:${ip}`, 3, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: z.infer<typeof ResendSchema>;
  try {
    const raw = await req.json();
    body = ResendSchema.parse(raw);
  } catch {
    // Return generic 200 — do not reveal input validation errors (email enumeration)
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  // Look up user — silently succeed if not found
  const { data: user } = await supabase
    .from("users")
    .select("id, email, email_verified")
    .eq("email", body.email)
    .maybeSingle();

  if (!user || user.email_verified) {
    // No account, or already verified — return generic success either way
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  // Delete all existing verification tokens for this user
  await supabase
    .from("verification_tokens")
    .delete()
    .eq("user_id", user.id);

  // Generate new token valid for 24 hours
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await supabase.from("verification_tokens").insert({
    user_id:    user.id,
    token,
    expires_at: expiresAt,
  });

  if (insertError) {
    console.error("[resend-verification] Failed to insert token:", insertError.message);
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  const verificationUrl = `${process.env.NEXTAUTH_URL}/auth/verify-email?token=${token}`;

  const emailResult = await sendEmail({
    to:      user.email as string,
    subject: "Verify your email — FinAgent-SG",
    html: `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1917;max-width:480px;margin:0 auto;padding:32px 16px;">
  <p style="font-size:14px;font-weight:600;margin:0 0 4px;">FinAgent-SG</p>
  <h1 style="font-size:18px;font-weight:600;margin:0 0 16px;">Verify your email address</h1>
  <p style="font-size:14px;line-height:1.6;margin:0 0 24px;">Click the button below to verify your email and activate your account. This link expires in 24 hours.</p>
  <a href="${verificationUrl}" style="display:inline-block;background-color:#3D6B52;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;">Verify email</a>
  <p style="font-size:13px;color:#6B6560;margin:32px 0 0;line-height:1.6;">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#3D6B52;">${verificationUrl}</span></p>
  <p style="font-size:12px;color:#9B9490;margin:24px 0 0;">If you didn't sign up for FinAgent-SG, you can ignore this email.</p>
</body>
</html>`,
  });

  if (!emailResult.success) {
    console.error("[resend-verification] Email failed to send for:", user.email);
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
}
