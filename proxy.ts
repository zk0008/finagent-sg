/**
 * proxy.ts
 *
 * Next.js proxy (formerly middleware) for FinAgent-SG.
 * Enforces authentication on all app routes (Phase 6).
 *
 * Public routes (no auth required):
 *   /auth/login     — login page
 *   /auth/register  — registration page
 *   /auth/error     — NextAuth error page
 *   /api/auth/*     — NextAuth internals (signIn, signOut, session)
 *
 * All other routes redirect unauthenticated users to /auth/login.
 */

import { auth } from "@/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths — always accessible without auth
  const isPublic =
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/auth/");

  if (isPublic) return NextResponse.next();

  const session = await auth();
  if (!session) {
    const loginUrl = new URL("/auth/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
