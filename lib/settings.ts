import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import type { Sealed } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

export interface BusinessProfile {
  name: string;
  timezone: string;
  logoFileId: string | null;
}

export type AiProviderKind = "none" | "anthropic" | "openai";

export interface AiSettings {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: Sealed | null;
  /** Replace names, emails, phone numbers and similar before anything is sent. */
  redact: boolean;
  maxTokens: number;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** true: TLS from the start (port 465); false: STARTTLS when offered. */
  secure: boolean;
  user: string;
  password: Sealed | null;
  from: string;
}

export interface VapidSettings {
  publicKey: string;
  privateKey: Sealed;
}

interface SettingMap {
  business: BusinessProfile;
  ai: AiSettings;
  smtp: SmtpSettings | null;
  vapid: VapidSettings | null;
  setup: { completedAt: string } | null;
  /** Written by scripts/backup.mjs after each run. */
  backup: BackupStatus | null;
}

export interface BackupStatus {
  ok: boolean;
  at: string;
  name: string;
  bytes?: number;
  offsite?: string | null;
  error?: string;
}

export const AI_DEFAULTS: Record<Exclude<AiProviderKind, "none">, { baseUrl: string; model: string; label: string }> = {
  // DeepSeek's Anthropic-compatible endpoint: the cheap default.
  anthropic: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash", label: "Anthropic Messages API (DeepSeek by default)" },
  // Ollama (or any OpenAI-compatible server) on the same machine or network.
  openai: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", label: "OpenAI-compatible API (a local Ollama by default)" },
};

const DEFAULTS: SettingMap = {
  business: { name: "Our business", timezone: "UTC", logoFileId: null },
  ai: { provider: "none", baseUrl: AI_DEFAULTS.anthropic.baseUrl, model: AI_DEFAULTS.anthropic.model, apiKey: null, redact: true, maxTokens: 2000 },
  smtp: null,
  vapid: null,
  setup: null,
  backup: null,
};

export async function getSetting<K extends keyof SettingMap>(key: K): Promise<SettingMap[K]> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key));
  if (!row) return DEFAULTS[key];
  const value = row.value as SettingMap[K];
  // Merge objects with their defaults so a newer field always has a value.
  if (value && typeof value === "object" && DEFAULTS[key] && typeof DEFAULTS[key] === "object") {
    return { ...(DEFAULTS[key] as object), ...(value as object) } as SettingMap[K];
  }
  return value;
}

export async function setSetting<K extends keyof SettingMap>(key: K, value: SettingMap[K], updatedBy: string | null): Promise<void> {
  await db()
    .insert(settings)
    .values({ key, value: value as unknown as object, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as object, updatedBy, updatedAt: new Date() } });
}

export const businessProfile = cache(() => getSetting("business"));

/** True once the owner account exists. */
export async function isSetupDone(): Promise<boolean> {
  return (await getSetting("setup")) !== null;
}
