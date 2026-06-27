/**
 * app/auth/verify-email/page.tsx
 *
 * Email verification status page.
 *
 * ?status=success — email verified; prompt to sign in
 * ?status=invalid — link invalid or expired; show resend form
 * (no param)      — just registered; show "check your email" + resend form
 */

"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const status = searchParams.get("status");

  const [email, setEmail] = useState("");
  const [resendLoading, setResendLoading] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResendError(null);
    setResendLoading(true);
    try {
      await fetch("/api/auth/resend-verification", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email }),
      });
      setResendDone(true);
    } catch {
      setResendError("Something went wrong. Please try again.");
    } finally {
      setResendLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md flex flex-col gap-4">
        <Card>
          <CardHeader className="text-center pb-2">
            <h1 className="text-lg font-semibold">FinAgent-SG</h1>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">

            {/* ── Success ── */}
            {status === "success" && (
              <>
                <p className="text-sm font-medium text-foreground">Email verified</p>
                <p className="text-sm text-muted-foreground">
                  Your email has been verified. You can now sign in to your account.
                </p>
                <a
                  href="/auth/login"
                  className="text-sm text-primary underline hover:opacity-80 transition-opacity duration-150"
                >
                  Sign in
                </a>
              </>
            )}

            {/* ── Invalid / expired ── */}
            {status === "invalid" && (
              <>
                <p className="text-sm font-medium text-foreground">Link invalid or expired</p>
                <p className="text-sm text-muted-foreground">
                  This verification link is invalid or has expired. Request a new one below.
                </p>
              </>
            )}

            {/* ── No status — just registered ── */}
            {!status && (
              <>
                <p className="text-sm font-medium text-foreground">Check your email</p>
                <p className="text-sm text-muted-foreground">
                  A verification link has been sent to your email address. Click it to activate your account.
                </p>
              </>
            )}

            {/* ── Resend form — shown when status is absent or invalid ── */}
            {status !== "success" && (
              resendDone ? (
                <p className="text-sm text-muted-foreground pt-2 border-t border-border">
                  If an account with that email exists, a new verification link has been sent.
                </p>
              ) : (
                <form onSubmit={handleResend} className="space-y-3 pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground pt-1">Resend verification email</p>
                  <div className="space-y-1">
                    <Label htmlFor="resend-email">Email</Label>
                    <Input
                      id="resend-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="jane@firm.com.sg"
                      required
                    />
                  </div>
                  {resendError && (
                    <p className="text-sm text-destructive">{resendError}</p>
                  )}
                  <Button
                    type="submit"
                    variant="outline"
                    className="w-full"
                    disabled={resendLoading}
                  >
                    {resendLoading
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : "Resend verification email"
                    }
                  </Button>
                </form>
              )
            )}

          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Already verified?{" "}
          <a
            href="/auth/login"
            className="text-primary underline hover:opacity-80 transition-opacity duration-150"
          >
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
