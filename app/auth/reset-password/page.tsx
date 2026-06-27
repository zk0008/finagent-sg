/**
 * app/auth/reset-password/page.tsx
 *
 * Password reset page — linked from the reset email.
 * Reads ?token= from the URL. Shows new password form if token is present,
 * or an error state if it is missing.
 */

"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ token, password }),
      });
      const data = await res.json() as { message?: string; error?: string };

      if (res.ok) {
        setSuccess(true);
      } else {
        setError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md flex flex-col gap-4">
        <Card>
          <CardHeader className="text-center pb-2">
            <h1 className="text-lg font-semibold">FinAgent-SG</h1>
          </CardHeader>

          <CardContent>
            {/* No token in URL */}
            {!token && (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-foreground">Invalid reset link</p>
                <p className="text-sm text-muted-foreground">
                  This reset link is missing or malformed.
                </p>
                <a
                  href="/auth/forgot-password"
                  className="text-sm text-primary underline hover:opacity-80 transition-opacity duration-150"
                >
                  Request a new reset link
                </a>
              </div>
            )}

            {/* Token present, reset complete */}
            {token && success && (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-foreground">Password reset</p>
                <p className="text-sm text-muted-foreground">
                  Your password has been reset. You can now sign in with your new password.
                </p>
                <a
                  href="/auth/login"
                  className="text-sm text-primary underline hover:opacity-80 transition-opacity duration-150"
                >
                  Sign in
                </a>
              </div>
            )}

            {/* Token present, show form */}
            {token && !success && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <p className="text-sm font-medium text-foreground">Choose a new password</p>

                <div className="space-y-1">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    required
                    autoComplete="new-password"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="confirm-password">Confirm new password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    required
                    autoComplete="new-password"
                  />
                </div>

                {error && (
                  <p className="text-sm text-destructive">{error}</p>
                )}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Reset password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          <a
            href="/auth/login"
            className="text-primary underline hover:opacity-80 transition-opacity duration-150"
          >
            Back to sign in
          </a>
        </p>
      </div>
    </div>
  );
}
