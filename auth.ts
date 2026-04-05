/**
 * auth.ts
 *
 * NextAuth.js v5 (beta) configuration for FinAgent-SG.
 * Authentication method: email/password only (Credentials provider).
 *
 * Phase 6: authorize() now queries public.users in Supabase and verifies
 * the password hash with bcryptjs. User id, email, name, and role are
 * stored in the JWT session token.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabaseClient";

// Zod schema for validating credentials at the NextAuth boundary
const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
        const parsed = CredentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        // Look up the user in public.users
        const { data: user } = await supabase
          .from("users")
          .select("id, email, name, role, password_hash")
          .eq("email", email)
          .maybeSingle();

        if (!user) return null;

        // Verify the password against the stored bcrypt hash
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Persist id and role into the JWT token
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "accountant";
      }
      return token;
    },
    // Expose id and role on the session object
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/login",
    error: "/auth/error",
  },
});
