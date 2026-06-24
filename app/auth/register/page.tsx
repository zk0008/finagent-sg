/**
 * app/auth/register/page.tsx
 *
 * Two-step self-serve signup flow.
 *
 * Step 1 — "Create your account": name, email, password, confirm password.
 *   POST /api/auth/register → on 201, advance to step 2.
 *
 * Step 2 — "Set up your company": company details.
 *   signIn("credentials") to obtain a session, then POST /api/clients.
 *   Shows a "Setting up your workspace…" loading screen while running.
 *   On success: redirect to /.
 *
 * All state is local useState — no context, no state library.
 */

"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// Stored after step 1 succeeds; password is kept in memory to authenticate in step 2.
interface AccountData {
  id: string;
  email: string;
  name: string;
  password: string;
}

export default function RegisterPage() {
  const router = useRouter();

  // ── Step tracking ──────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2>(1);

  // ── Step 1 state ───────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [step1Loading, setStep1Loading] = useState(false);

  // Populated on step 1 success; read in step 2.
  const [accountData, setAccountData] = useState<AccountData | null>(null);

  // ── Step 2 state ───────────────────────────────────────────────────────────
  const [companyName, setCompanyName] = useState("");
  const [uen, setUen] = useState("");
  const [companyType, setCompanyType] = useState("private_ltd");
  const [fyeDate, setFyeDate] = useState("2025-12-31");
  const [revenue, setRevenue] = useState("0");
  const [totalAssets, setTotalAssets] = useState("0");
  const [employeeCount, setEmployeeCount] = useState("0");
  const [shareholderCount, setShareholderCount] = useState("1");
  const [hasCorporateShareholders, setHasCorporateShareholders] = useState(false);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  // When true, replaces the form with the "Setting up…" loading screen.
  const [settingUp, setSettingUp] = useState(false);

  // When true, shows the back-warning banner inside step 2.
  const [showBackWarning, setShowBackWarning] = useState(false);

  // ── Step 1 submit ──────────────────────────────────────────────────────────
  async function handleStep1Submit(e: React.FormEvent) {
    e.preventDefault();
    setStep1Error(null);

    if (password.length < 8) {
      setStep1Error("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setStep1Error("Passwords do not match");
      return;
    }

    setStep1Loading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json() as { user?: { id: string; email: string; name: string }; error?: string };

      if (res.status === 201 && data.user) {
        setAccountData({ ...data.user, password });
        setStep(2);
      } else if (res.status === 409) {
        setStep1Error("An account with this email already exists");
      } else if (res.status === 400) {
        setStep1Error(data.error ?? "Invalid input. Please check your details.");
      } else {
        setStep1Error("Something went wrong. Please try again.");
      }
    } catch {
      setStep1Error("Something went wrong. Please try again.");
    } finally {
      setStep1Loading(false);
    }
  }

  // ── Step 2 submit ──────────────────────────────────────────────────────────
  async function handleStep2Submit(e: React.FormEvent) {
    e.preventDefault();
    setStep2Error(null);
    setSettingUp(true);

    try {
      // Authenticate first so /api/clients can read the session.
      const signInResult = await signIn("credentials", {
        email: accountData!.email,
        password: accountData!.password,
        redirect: false,
      });

      if (signInResult?.error) {
        setStep2Error("Authentication failed. Please sign in manually to complete setup.");
        setSettingUp(false);
        return;
      }

      // Create the client company.
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:                       companyName,
          uen,
          company_type:               companyType,
          fye_date:                   fyeDate,
          revenue,
          total_assets:               totalAssets,
          employee_count:             parseInt(employeeCount, 10) || 0,
          shareholder_count:          parseInt(shareholderCount, 10) || 1,
          has_corporate_shareholders: hasCorporateShareholders,
        }),
      });

      const data = await res.json() as { error?: string };

      if (res.ok) {
        router.push("/");
      } else {
        setStep2Error(data.error ?? "Failed to create company. Please try again.");
        setSettingUp(false);
      }
    } catch {
      setStep2Error("Something went wrong. Please try again.");
      setSettingUp(false);
    }
  }

  // ── "Setting up…" loading screen ───────────────────────────────────────────
  if (settingUp) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 flex flex-col items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Setting up your workspace…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Main layout ────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md flex flex-col gap-4">
        <Card>
          <CardHeader className="text-center pb-2">
            <h1 className="text-lg font-semibold">FinAgent-SG</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Step {step} of 2</p>
          </CardHeader>

          <CardContent>
            {/* ── STEP 1 ── */}
            {step === 1 && (
              <form onSubmit={handleStep1Submit} className="space-y-4">
                <p className="text-sm font-medium text-foreground">Create your account</p>

                <div className="space-y-1">
                  <Label htmlFor="name">Full name</Label>
                  <Input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Tan"
                    required
                    autoComplete="name"
                  />
                </div>

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

                <div className="space-y-1">
                  <Label htmlFor="password">Password</Label>
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
                  <Label htmlFor="confirm-password">Confirm password</Label>
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

                {step1Error && (
                  <p className="text-sm text-destructive">{step1Error}</p>
                )}

                <Button type="submit" className="w-full" disabled={step1Loading}>
                  {step1Loading ? "Creating account…" : "Continue"}
                </Button>
              </form>
            )}

            {/* ── STEP 2 ── */}
            {step === 2 && (
              <form onSubmit={handleStep2Submit} className="space-y-4">
                <p className="text-sm font-medium text-foreground">Set up your company</p>

                {/* Back warning banner */}
                {showBackWarning && (
                  <div className="rounded-md border border-[#E8D9A8] bg-[#FBF3DE] p-3 text-sm text-[#B5841A]">
                    <p className="mb-2">Your account was already created. Going back means your company won&apos;t be set up — you&apos;ll need to add it manually after signing in.</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowBackWarning(false)}
                        className="text-xs font-medium underline cursor-pointer"
                      >
                        Continue setup
                      </button>
                      <span className="text-[#C8A855]">·</span>
                      <a href="/auth/login" className="text-xs font-medium underline cursor-pointer">
                        Sign in instead
                      </a>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1 col-span-2">
                    <Label htmlFor="company-name">Company name</Label>
                    <Input
                      id="company-name"
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="TechSoft Pte Ltd"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="uen">UEN</Label>
                    <Input
                      id="uen"
                      type="text"
                      value={uen}
                      onChange={(e) => setUen(e.target.value)}
                      placeholder="201912345K"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="company-type">Company type</Label>
                    <select
                      id="company-type"
                      value={companyType}
                      onChange={(e) => setCompanyType(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    >
                      <option value="private_ltd">Private Limited</option>
                      <option value="exempt_private">Exempt Private</option>
                      <option value="public_ltd">Public Limited</option>
                      <option value="sole_prop">Sole Proprietorship</option>
                      <option value="partnership">Partnership</option>
                      <option value="llp">LLP</option>
                    </select>
                  </div>

                  <div className="space-y-1 col-span-2">
                    <Label htmlFor="fye-date">Financial year end</Label>
                    <Input
                      id="fye-date"
                      type="date"
                      value={fyeDate}
                      onChange={(e) => setFyeDate(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="revenue">Annual revenue (SGD)</Label>
                    <Input
                      id="revenue"
                      type="number"
                      min="0"
                      value={revenue}
                      onChange={(e) => setRevenue(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="total-assets">Total assets (SGD)</Label>
                    <Input
                      id="total-assets"
                      type="number"
                      min="0"
                      value={totalAssets}
                      onChange={(e) => setTotalAssets(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="employee-count">No. of employees</Label>
                    <Input
                      id="employee-count"
                      type="number"
                      min="0"
                      value={employeeCount}
                      onChange={(e) => setEmployeeCount(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="shareholder-count">No. of shareholders</Label>
                    <Input
                      id="shareholder-count"
                      type="number"
                      min="1"
                      value={shareholderCount}
                      onChange={(e) => setShareholderCount(e.target.value)}
                      required
                    />
                  </div>

                  <div className="col-span-2 flex items-center gap-2">
                    <input
                      id="corporate-shareholders"
                      type="checkbox"
                      checked={hasCorporateShareholders}
                      onChange={(e) => setHasCorporateShareholders(e.target.checked)}
                      className="h-4 w-4 rounded border-input cursor-pointer"
                    />
                    <Label htmlFor="corporate-shareholders" className="cursor-pointer font-normal">
                      Has corporate shareholders
                    </Label>
                  </div>
                </div>

                {step2Error && (
                  <p className="text-sm text-destructive">{step2Error}</p>
                )}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowBackWarning(true)}
                    disabled={showBackWarning}
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1">
                    Create company
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        {/* "Already have an account?" — shown on step 1 only */}
        {step === 1 && (
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/auth/login" className="text-primary underline hover:opacity-80 transition-opacity duration-150">
              Sign in
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
