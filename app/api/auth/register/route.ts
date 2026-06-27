/**
 * app/api/auth/register/route.ts
 *
 * POST /api/auth/register — Self-serve account registration.
 *
 * Accepts: { name, email, password }
 * Creates a row in public.users with role = 'accountant'.
 * Sends a verification email; the user must click it before they can sign in.
 * Returns 201 { user: { id, email, name } } on success.
 *
 * Errors:
 *   400 — validation failure
 *   409 — email already registered
 *   500 — DB insert failure
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabaseClient";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rateLimit";

const RegisterSchema = z.object({
  name:     z.string().min(1, "Name is required").trim(),
  email:    z.string().email("Invalid email address").toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`register:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many registration attempts. Please try again later." },
      { status: 429 }
    );
  }

  let body: z.infer<typeof RegisterSchema>;
  try {
    const raw = await req.json();
    body = RegisterSchema.parse(raw);
  } catch (err) {
    const message =
      err instanceof z.ZodError ? (err.issues?.[0]?.message ?? err.message) : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Duplicate email check
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("email", body.email)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  const password_hash = await bcrypt.hash(body.password, 12);

  const { data: user, error: insertError } = await supabase
    .from("users")
    .insert({
      name:          body.name,
      email:         body.email,
      password_hash,
      role:          "accountant",
    })
    .select("id, email, name")
    .single();

  if (insertError || !user) {
    console.error("[register] Failed to create user:", insertError?.message);
    return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
  }

  // Generate verification token and send email.
  // Failure does not block the 201 response — user can request a resend.
  try {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await supabase.from("verification_tokens").insert({
      user_id:    user.id,
      token,
      expires_at: expiresAt,
    });

    const verificationUrl = `${process.env.NEXTAUTH_URL}/auth/verify-email?token=${token}`;

    const emailResult = await sendEmail({
      to:      body.email,
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
      console.error("[register] Verification email failed to send for:", body.email);
    }
  } catch (err) {
    console.error("[register] Failed to generate/send verification email:", (err as Error).message);
  }

  return NextResponse.json({ user }, { status: 201 });
}
