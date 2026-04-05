/**
 * next.config.ts
 *
 * Next.js 15 configuration for FinAgent-SG.
 * App Router is enabled by default.
 * This file will be extended in later phases to support:
 * - Vercel Blob file storage
 * - Streaming response configuration
 * - External image domains
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit uses readFileSync to load font .afm files from node_modules.
  // When bundled by Next.js/Turbopack, the file paths get rewritten and
  // the font files cannot be found (ENOENT). Marking pdfkit as an external
  // package tells Next.js to require() it at runtime instead of bundling it,
  // so the font paths remain correct.
  serverExternalPackages: ["pdfkit", "chromadb", "@chroma-core/default-embed"],

  // Turbopack issue suppression:
  // @chroma-core/default-embed v0.1.9 ships a .d.cts (CJS) type declaration
  // that contains ESM import syntax. Turbopack treats this as a module-format
  // mismatch and fails the build. Since both chromadb and @chroma-core/default-embed
  // are in serverExternalPackages (never bundled — loaded at runtime via require()),
  // this file is never actually executed by the bundle. We suppress the false-alarm
  // error so the build can proceed.
  turbopack: {
    ignoreIssue: [
      {
        path: /node_modules\/@chroma-core\/default-embed\/dist\/cjs\/default-embed\.d\.cts/,
      },
    ],
  },
};

export default nextConfig;
