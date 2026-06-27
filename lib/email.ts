/**
 * lib/email.ts
 *
 * Resend email client singleton and sendEmail helper.
 * Used by auth hardening flows: email verification and password reset.
 *
 * Required environment variables:
 *   RESEND_API_KEY — Resend API key (from resend.com dashboard)
 *   EMAIL_FROM     — Sender address e.g. "FinAgent-SG <noreply@yourdomain.com>"
 */

import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY);

type SendEmailOptions = {
  to: string;
  subject: string;
  html: string;
};

type SendEmailResult =
  | { success: true; id: string }
  | { success: false };

export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<SendEmailResult> {
  const from = process.env.EMAIL_FROM ?? "FinAgent-SG <noreply@example.com>";

  try {
    const { data, error } = await resend.emails.send({ from, to, subject, html });

    if (error || !data?.id) {
      console.error("[email] Failed to send email:", error?.message ?? "No data returned");
      return { success: false };
    }

    return { success: true, id: data.id };
  } catch (err) {
    console.error("[email] Unexpected error:", (err as Error).message);
    return { success: false };
  }
}
