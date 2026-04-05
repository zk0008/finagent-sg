/**
 * app/api/auth/[...nextauth]/route.ts
 *
 * NextAuth.js v5 catch-all route handler.
 * Exports GET and POST from the handlers object defined in auth.ts.
 * Required for all NextAuth endpoints (/api/auth/session, /api/auth/signin, etc.).
 */

import { handlers } from "@/auth";

export const { GET, POST } = handlers;
