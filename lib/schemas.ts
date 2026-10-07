import { z } from "zod";

/** Shared by the forms (for messages) and the actions (for real validation). */

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Enter an email address.")
  .max(254, "That email address is too long.")
  .email("That does not look like an email address. Check it and try again.");

export const passwordField = z
  .string()
  .min(10, "Use at least 10 characters. A few words in a row is easy to remember and hard to guess.")
  .max(200, "Use at most 200 characters.");

export const nameField = z.string().trim().min(1, "Enter a name.").max(100, "Keep the name under 100 characters.");

export const setupSchema = z
  .object({
    setupCode: z.string().trim().max(200).optional().default(""),
    businessName: z.string().trim().min(1, "Enter the business name.").max(120, "Keep the business name under 120 characters."),
    timezone: z.string().trim().min(1, "Choose a timezone."),
    name: nameField,
    email: emailField,
    password: passwordField,
    confirm: z.string(),
    aiKey: z.string().trim().max(500).optional().default(""),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords are different. Type the same password twice." });

export const signInSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Enter your password.").max(200),
});

export const acceptInviteSchema = z
  .object({
    token: z.string().min(20).max(100),
    name: nameField,
    password: passwordField,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords are different. Type the same password twice." });

export const resetSchema = z
  .object({
    token: z.string().min(20).max(100),
    password: passwordField,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords are different. Type the same password twice." });

export const forgotSchema = z.object({ email: emailField });

export const inviteRoles = ["admin", "member", "guest"] as const;

export const inviteSchema = z.object({
  email: emailField,
  role: z.enum(inviteRoles, { message: "Choose a role: admin, member or guest." }),
});

export const changeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(inviteRoles, { message: "Choose a role: admin, member or guest." }),
});

export const userIdSchema = z.object({ userId: z.string().uuid() });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: passwordField,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords are different. Type the same password twice." });

export const businessSchema = z.object({
  name: z.string().trim().min(1, "Enter the business name.").max(120, "Keep the business name under 120 characters."),
  timezone: z.string().trim().min(1, "Choose a timezone."),
});

export const aiSchema = z.object({
  provider: z.enum(["none", "anthropic", "openai"], { message: "Choose a provider." }),
  baseUrl: z.string().trim().url("Enter the provider's address, starting with https:// or http://."),
  model: z.string().trim().min(1, "Enter a model name.").max(100),
  apiKey: z.string().trim().max(500).optional().default(""),
  clearKey: z.string().optional(),
  redact: z.string().optional(),
  maxTokens: z.coerce.number().int().min(256, "Allow at least 256 tokens.").max(32_000, "32,000 tokens is the most."),
});

export const smtpSchema = z.object({
  host: z.string().trim().max(200).default(""),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.string().optional(),
  user: z.string().trim().max(200).default(""),
  password: z.string().max(500).optional().default(""),
  from: z.string().trim().max(200).default(""),
});

export const testEmailSchema = z.object({ to: emailField });

export const searchSchema = z.object({ q: z.string().trim().max(200).default("") });

export const assistantSchema = z.object({
  conversationId: z.string().uuid().optional().or(z.literal("")),
  message: z.string().trim().min(1, "Type a question or a request.").max(4000, "Keep the message under 4,000 characters."),
});

export const declineSchema = z.object({
  approvalId: z.string().uuid(),
  reason: z.string().trim().max(500).optional().default(""),
});
