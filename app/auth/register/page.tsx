/**
 * app/auth/register/page.tsx
 *
 * Registration is disabled in production.
 * New accounts are created by the administrator directly in Supabase.
 */

import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-lg font-semibold">FinAgent-SG</h1>
        </CardHeader>
        <CardContent className="text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            Account registration is not available.
          </p>
          <p className="text-sm text-muted-foreground">
            Contact your administrator to get access.
          </p>
          <a href="/auth/login" className="text-sm underline hover:text-foreground">
            Back to sign in
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
