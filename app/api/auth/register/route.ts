/**
 * app/api/auth/register/route.ts
 *
 * POST /api/auth/register — Self-serve account registration.
 *
 * Accepts: { name, email, password }
 * Creates a row in public.users with role = 'accountant'.
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

const RegisterSchema = z.object({
  name:     z.string().min(1, "Name is required").trim(),
  email:    z.string().email("Invalid email address").toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  return NextResponse.json({ user }, { status: 201 });
}
