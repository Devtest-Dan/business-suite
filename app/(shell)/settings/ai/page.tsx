import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { can, requireViewer } from "@/lib/auth/session";
import { AI_DEFAULTS, getSetting } from "@/lib/settings";
import { saveAi, testAi } from "../actions";

export const metadata: Metadata = { title: "AI settings" };

export default async function AiSettingsPage() {
  const viewer = await requireViewer();
  if (!(await can(viewer, "settings.ai"))) return <p className="muted">Only the owner chooses the AI provider.</p>;
  const ai = await getSetting("ai");
  return (
    <div className="max-w-2xl space-y-6">
      <ActionForm action={saveAi} submit="Save" className="card space-y-4">
        <div>
          <h2 className="h2">AI provider</h2>
          <p className="muted text-sm">
            The assistant and every app&apos;s AI tools use this. Whatever the AI wants to change waits in Approvals for a person.
          </p>
        </div>
        <label className="block">
          <span className="label">Provider</span>
          <select name="provider" defaultValue={ai.provider} className="input">
            <option value="none">None (AI switched off)</option>
            <option value="anthropic">{AI_DEFAULTS.anthropic.label}</option>
            <option value="openai">{AI_DEFAULTS.openai.label}</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Address (base URL)</span>
          <input name="baseUrl" required defaultValue={ai.baseUrl} className="input font-mono" />
          <span className="hint">
            DeepSeek: <code>{AI_DEFAULTS.anthropic.baseUrl}</code> · Ollama on this server: <code>http://ollama:11434/v1</code> (see docs/DEPLOY.md) · Ollama elsewhere:{" "}
            <code>{AI_DEFAULTS.openai.baseUrl}</code>
          </span>
        </label>
        <label className="block">
          <span className="label">Model</span>
          <input name="model" required defaultValue={ai.model} className="input font-mono" />
          <span className="hint">
            DeepSeek: <code>{AI_DEFAULTS.anthropic.model}</code> (cheaper) or <code>deepseek-v4-pro</code>. Ollama: the name you pulled, e.g. <code>{AI_DEFAULTS.openai.model}</code>.
          </span>
        </label>
        <label className="block">
          <span className="label">API key</span>
          <input name="apiKey" type="password" autoComplete="off" placeholder={ai.apiKey ? "A key is saved. Type a new one to replace it." : "Paste the key"} className="input font-mono" />
          <span className="hint">Stored encrypted. A local Ollama needs no key.</span>
        </label>
        {ai.apiKey ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="clearKey" className="size-4" /> Remove the saved key
          </label>
        ) : null}
        <label className="block">
          <span className="label">Longest reply (tokens)</span>
          <input name="maxTokens" type="number" min={256} max={32000} defaultValue={ai.maxTokens} className="input" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="redact" defaultChecked={ai.redact} className="mt-0.5 size-4" />
          <span>
            Redact personal details before sending (names, emails, phone numbers, card and id numbers, street addresses and anything that looks like a key).
            Recommended for a provider outside your server.
          </span>
        </label>
      </ActionForm>
      {ai.provider !== "none" ? (
        <ActionForm action={testAi} submit="Send a test message" submitClassName="btn" className="card space-y-3">
          <h2 className="h2">Check it works</h2>
          <p className="muted text-sm">Sends one short message to the model and shows the answer.</p>
        </ActionForm>
      ) : null}
    </div>
  );
}
