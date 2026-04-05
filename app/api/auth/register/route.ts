/**
 * app/api/auth/register/route.ts
 *
 * POST /api/auth/register — New user registration (Phase 6).
 *
 * What this route does:
 * 1. Validates the request body with Zod (name, email, password, confirmPassword).
 * 2. Checks that the email is not already registered in public.users.
 * 3. Hashes the password with bcryptjs (12 rounds).
 * 4. Inserts the new user into public.users.
 * 5. Returns { success: true, email } on success.
 *
 * Request body:
 *   { name: string, email: string, password: string, confirmPassword: string }
 *
 * Response (200): { success: true, email: string }
 * Error (400): { error: string } — validation or duplicate email
 * Error (500): { error: string } — DB write failure
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabaseClient";

const RegisterSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof RegisterSchema>;
  try {
    const raw = await req.json();
    body = RegisterSchema.parse(raw);
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? (err.issues?.[0]?.message ?? err.message)
        : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { name, email, password } = body;

  // Check for duplicate email
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 400 }
    );
  }

  // Hash password with bcrypt (12 rounds — good balance of security and speed)
  const passwordHash = await bcrypt.hash(password, 12);

  const { error } = await supabase.from("users").insert({
    name,
    email,
    password_hash: passwordHash,
    role: "accountant",
  });

  if (error) {
    console.error("[register] Failed to insert user:", error);
    return NextResponse.json(
      { error: "Failed to create account. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, email });
}
