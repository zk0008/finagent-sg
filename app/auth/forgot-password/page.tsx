/**
 * app/auth/forgot-password/page.tsx
 *
 * Forgot password page.
 * User enters their email; always shows a generic success message after
 * submit regardless of whether the account exists.
 */

"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email }),
      });
      setSubmitted(true);
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
            {submitted ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-foreground">Check your email</p>
                <p className="text-sm text-muted-foreground">
                  If an account with that email exists, a password reset link has been sent.
                  The link expires in 1 hour.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <p className="text-sm font-medium text-foreground">Reset your password</p>

                <div className="space-y-1">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@firm.com.sg"
                    required
                    autoComplete="email"
                  />
                </div>

                {error && (
                  <p className="text-sm text-destructive">{error}</p>
                )}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send reset link"}
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
