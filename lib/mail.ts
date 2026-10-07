import "server-only";
import nodemailer from "nodemailer";
import { unseal } from "@/lib/crypto";
import { getSetting, type SmtpSettings } from "@/lib/settings";

/**
 * Email through the owner's own SMTP account (their email provider or a
 * delivery service). When no SMTP is set, the suite shows links to copy
 * instead of sending them.
 */
export async function smtpSettings(): Promise<SmtpSettings | null> {
  const saved = await getSetting("smtp");
  if (saved?.host) return saved;
  return null;
}

export async function mailConfigured(): Promise<boolean> {
  return (await smtpSettings()) !== null;
}

export async function sendMail(message: { to: string; subject: string; text: string }): Promise<void> {
  const smtp = await smtpSettings();
  if (!smtp) throw new Error("Email is not set up. Add SMTP details in Settings → Email.");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ? unseal(smtp.password) : "" } : undefined,
    connectionTimeout: 15_000,
  });
  await transport.sendMail({ from: smtp.from, to: message.to, subject: message.subject, text: message.text });
}
