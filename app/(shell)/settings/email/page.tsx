import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { can, requireViewer } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { saveSmtp, sendTestEmail } from "../actions";

export const metadata: Metadata = { title: "Email settings" };

export default async function EmailSettingsPage() {
  const viewer = await requireViewer();
  if (!(await can(viewer, "settings.manage"))) return <p className="muted">Your role does not change settings.</p>;
  const smtp = await getSetting("smtp");
  return (
    <div className="max-w-2xl space-y-6">
      <ActionForm action={saveSmtp} submit="Save" className="card space-y-4">
        <div>
          <h2 className="h2">Sending email</h2>
          <p className="muted text-sm">
            Use your own email provider&apos;s SMTP details, or a delivery service&apos;s. Until this is set, invite and reset links are shown for you to copy.
            Leave the host empty to switch sending off.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="label">SMTP host</span>
            <input name="host" defaultValue={smtp?.host ?? ""} placeholder="smtp.example.com" className="input" />
          </label>
          <label className="block">
            <span className="label">Port</span>
            <input name="port" type="number" defaultValue={smtp?.port ?? 587} className="input" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="secure" defaultChecked={smtp?.secure ?? false} className="size-4" /> TLS from the start (port 465). Leave off for 587 (STARTTLS).
        </label>
        <label className="block">
          <span className="label">User name</span>
          <input name="user" defaultValue={smtp?.user ?? ""} autoComplete="off" className="input" />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input name="password" type="password" autoComplete="off" placeholder={smtp?.password ? "Saved. Type a new one to replace it." : ""} className="input" />
        </label>
        <label className="block">
          <span className="label">From</span>
          <input name="from" defaultValue={smtp?.from ?? ""} placeholder="Team <team@yourbusiness.com>" className="input" />
        </label>
      </ActionForm>
      {smtp ? (
        <ActionForm action={sendTestEmail} submit="Send test email" submitClassName="btn" className="card flex flex-wrap items-end gap-3">
          <label className="block min-w-60 flex-1">
            <span className="label">Send a test to</span>
            <input name="to" type="email" required defaultValue={viewer.email} className="input" />
          </label>
        </ActionForm>
      ) : null}
    </div>
  );
}
