/**
 * app/layout.tsx
 *
 * Root layout for FinAgent-SG.
 * Wraps every page with the global font, base styles, and NextAuth SessionProvider.
 *
 * Phase 6:
 * - SessionProvider added so client components can call useSession() / signOut().
 * - validateEnv() called on startup to catch missing environment variables early.
 */

import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import "./globals.css";
import { validateEnv } from "@/lib/validateEnv";

// Validate required env vars on server startup — throws clearly if any are missing
validateEnv();

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FinAgent-SG",
  description: "AI-powered financial statement preparation for Singapore companies",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
