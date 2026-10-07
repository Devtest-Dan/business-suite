import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { TimezoneSelect } from "@/components/timezone-select";
import { can, requireViewer } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatDateTime, timezones } from "@/lib/format";
import { businessProfile, getSetting } from "@/lib/settings";
import { saveBusiness } from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default async function BusinessSettingsPage() {
  const viewer = await requireViewer();
  if (!(await can(viewer, "settings.manage"))) return <p className="muted">Your role does not change the business details.</p>;
  const business = await businessProfile();
  const backup = await getSetting("backup");
  return (
    <div className="space-y-6">
      <ActionForm action={saveBusiness} submit="Save" className="card max-w-2xl space-y-4">
        <h2 className="h2">Business</h2>
        <label className="block">
          <span className="label">Business name</span>
          <input name="name" required maxLength={120} defaultValue={business.name} className="input" />
        </label>
        <label className="block">
          <span className="label">Timezone</span>
          <TimezoneSelect name="timezone" zones={timezones()} defaultValue={business.timezone} />
          <span className="hint">Every date in the suite is shown in this timezone.</span>
        </label>
        <div className="space-y-2">
          <span className="label">Logo</span>
          {business.logoFileId ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by the suite itself
            <img src="/logo" alt="Current logo" className="size-16 rounded-lg border border-line object-contain" />
          ) : null}
          <input type="file" name="logo" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="block text-sm" />
          {business.logoFileId ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="removeLogo" className="size-4" /> Remove the logo
            </label>
          ) : null}
          <span className="hint">PNG, JPEG, WebP or SVG, under 2 MB. Shown on the sign-in page and in the menu.</span>
        </div>
      </ActionForm>
      <section className="card max-w-2xl space-y-1 text-sm">
        <h2 className="h2">This server</h2>
        <p>
          Version <span className="font-mono">{env().version}</span> at <span className="font-mono">{env().publicUrl}</span>
        </p>
        <p className="muted">
          Files are stored {env().s3 ? "in your S3-compatible bucket" : "on this server's disk (included in the nightly backup)"}. Updates and backups: docs/DEPLOY.md in the suite.
        </p>
        <p data-testid="last-backup">
          {backup
            ? backup.ok
              ? `Last backup: ${formatDateTime(backup.at, business.timezone)} (${Math.max(1, Math.round((backup.bytes ?? 0) / 1024))} KB${backup.offsite ? ", with an off-site copy" : ", on this server only"}).`
              : `The last backup FAILED on ${formatDateTime(backup.at, business.timezone)}: ${backup.error}. Check it with: business-suite logs backup`
            : "No backup has run yet. The first runs tonight; or run: sudo business-suite backup"}
        </p>
      </section>
    </div>
  );
}
