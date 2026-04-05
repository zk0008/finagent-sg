/**
 * app/auth/error/page.tsx
 *
 * NextAuth error page (Phase 6).
 *
 * NextAuth redirects here when an authentication error occurs
 * (e.g. expired session, misconfigured provider).
 * Shows a friendly message and a link back to the login page.
 */

"use client";

import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  Configuration: "There is a server configuration error. Please contact support.",
  AccessDenied: "You do not have permission to sign in.",
  Verification: "The verification link has expired or has already been used.",
  Default: "An authentication error occurred. Please try signing in again.",
};

export default function AuthErrorPage() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error") ?? "Default";
  const message = ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.Default;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-lg font-semibold">FinAgent-SG</h1>
          <CardTitle className="text-base font-medium text-muted-foreground mt-1">
            Authentication Error
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">{message}</p>
          <a href="/auth/login" className="inline-flex items-center justify-center w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium px-4 py-2 hover:bg-primary/90 transition-colors">
            Back to sign in
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
