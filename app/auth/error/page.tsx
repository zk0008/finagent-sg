/**
 * app/auth/error/page.tsx
 *
 * NextAuth error page (Phase 6).
 *
 * NextAuth redirects here when an authentication error occurs
 * (e.g. expired session, misconfigured provider).
 * Shows a friendly message and a link back to the login page.
 */

import { Suspense } from "react";
import AuthErrorContent from "./AuthErrorContent";

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorContent />
    </Suspense>
  );
}
