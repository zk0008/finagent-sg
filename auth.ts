/**
 * auth.ts
 *
 * NextAuth.js v5 (beta) configuration for FinAgent-SG.
 * Authentication method: email/password only (Credentials provider).
 *
 * No OAuth, no magic links, no social login — not in scope for Phase 0.
 *
 * In Phase 0, user lookup is a stub (no database yet).
 * In production, replace the authorize function body with a real
 * Supabase query against the public.users table.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

// Zod schema for validating credentials at the NextAuth boundary
const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Validate input shape
        const parsed = CredentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // TODO (Phase 1+): Replace this stub with a real Supabase query.
        // Example:
        //   const user = await supabase
        //     .from('users')
        //     .select('*')
        //     .eq('email', parsed.data.email)
        //     .single();
        //   if (!user || !verifyPassword(parsed.data.password, user.password_hash)) return null;
        //   return { id: user.id, email: user.email, name: user.name };

        // Phase 0 stub: always reject (no users in DB yet)
        return null;
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",  // Custom login page — to be built in Phase 1
  },
});
