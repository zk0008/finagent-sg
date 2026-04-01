/**
 * proxy.ts
 *
 * Next.js proxy (formerly middleware) for FinAgent-SG.
 * Runs NextAuth session checks on all routes except public ones.
 *
 * Renamed from middleware.ts to proxy.ts per Next.js 16.2 convention.
 * Export renamed from `middleware` to `proxy` accordingly.
 *
 * In Phase 0, authentication is not enforced (login page not built yet).
 * This file is here to make the auth wiring visible — enforcement
 * will be added in Phase 1 when the login page is built.
 */

export { auth as proxy } from "@/auth";

export const config = {
  // Protect all routes except static files, images, and the login page
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|login).*)"],
};
