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
  serverExternalPackages: ["pdfkit"],
};

export default nextConfig;
