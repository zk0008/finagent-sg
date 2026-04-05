/**
 * app/corrections/page.tsx
 *
 * Correction Review Interface — Phase 5.
 *
 * What this page does:
 * Displays all corrections submitted via the chatbot for a given client schema.
 * Accountants use this page to review user corrections before they are used
 * for fine-tuning (Phase 5, Task 6 — the export script reads "reviewed" status).
 *
 * Features:
 * - Table showing: date, message, status, linked output_id (if any)
 * - Filter by status: all / pending / reviewed
 * - "Mark as reviewed" button — PATCHes status to "reviewed" via API
 *
 * schemaName is passed as a query param: /corrections?schema=techsoft_pte_ltd
 * This mirrors how other pages in FinAgent-SG identify the active client.
 */

import { Suspense } from "react";
import CorrectionsContent from "./CorrectionsContent";

export default function CorrectionsPage() {
  return (
    <Suspense>
      <CorrectionsContent />
    </Suspense>
  );
}
