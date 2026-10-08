import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import { mailConfigured } from "@/lib/mail";
import type { ModulePageProps } from "@/lib/modules/contract";
import { saveSequenceAction, sequenceActiveAction } from "../actions";
import { getSettings } from "../data";
import { PLACEHOLDERS } from "../logic";
import { MAX_STEPS } from "../schemas";
import { getSequence, kickDueEmails, listSequences, NO_ADDRESS_MESSAGE, recentSends, type Step } from "../sequences";
import { Back, SubNav } from "./parts";

const STARTER: { delayDays: number; subject: string; body: string }[] = [
  { delayDays: 0, subject: "Thanks for contacting {business_name}", body: "Hi {first_name},\n\nThank you for asking about {service}. When is a good time for a quick call? Reply to this email with a time that suits you.\n\n{business_name}" },
  { delayDays: 3, subject: "Still thinking about {service}?", body: "Hi {first_name},\n\nI wanted to check whether you still need help with {service}. Reply here and we will pick it up from there.\n\n{business_name}" },
  { delayDays: 7, subject: "Shall we close your enquiry?", body: "Hi {first_name},\n\nWe have not heard back, so this is the last email about your enquiry. If you still want help with {service}, reply any time.\n\n{business_name}" },
];

async function Warnings({ ctx }: { ctx: ModulePageProps["ctx"] }) {
  const [settings, mail] = await Promise.all([getSettings(ctx.db), mailConfigured()]);
  return (
    <>
      {!settings.postalAddress ? (
        <p className="notice notice-warn text-sm" data-testid="no-address">
          {NO_ADDRESS_MESSAGE}
        </p>
      ) : null}
      {!mail ? <p className="notice notice-warn text-sm">Email is not set up, so no sequence email can go out. The owner adds the SMTP details in Settings → Email.</p> : null}
    </>
  );
}

export async function SequencesPage({ ctx, basePath }: ModulePageProps) {
  kickDueEmails();
  const sequences = await listSequences(ctx.db);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Email sequences</h1>
          <p className="muted">A few follow-up emails over a few days, for leads nobody has reached yet. They stop by themselves when the lead replies, is contacted, converted or disqualified, or unsubscribes. Email only: no text messages.</p>
        </div>
        <Link href={`${basePath}/sequences/new`} className="btn btn-primary">
          <Icon name="plus" className="size-4" /> New sequence
        </Link>
      </header>
      <SubNav basePath={basePath} current="sequences" canManage />
      <Warnings ctx={ctx} />
      {sequences.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No sequences yet.</p>
          <p className="muted">Start one: three short emails over a week is a good size.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="table" data-testid="sequence-list">
            <thead>
              <tr>
                <th>Sequence</th>
                <th>State</th>
                <th>Emails</th>
                <th>Leads in it now</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className="link font-medium" href={`${basePath}/sequences/${s.id}`}>
                      {s.name}
                    </Link>
                  </td>
                  <td>{s.active ? <span className="badge badge-ok">On</span> : <span className="badge">Off</span>}</td>
                  <td>
                    {s.steps} over {s.lastDay} day{s.lastDay === 1 ? "" : "s"}
                  </td>
                  <td>{s.activeLeads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StepFields({ steps }: { steps: Pick<Step, "delayDays" | "subject" | "body">[] }) {
  const rows = Array.from({ length: MAX_STEPS }, (_, i) => steps[i] ?? null);
  return (
    <div className="space-y-4">
      <p className="hint">
        Placeholders: {PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}. The suite adds your business name, your postal address and an unsubscribe link at the foot of every email. Leave an email empty to drop it.
      </p>
      {rows.map((s, i) => (
        <fieldset key={i} className="space-y-2 rounded-md border border-line p-3">
          <legend className="label px-1">Email {i + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <label className="block">
              <span className="label">Day</span>
              <input name={`step_${i + 1}_day`} type="number" min={0} max={60} defaultValue={s?.delayDays ?? (i === 0 ? 0 : "")} className="input" />
            </label>
            <label className="block">
              <span className="label">Subject</span>
              <input name={`step_${i + 1}_subject`} maxLength={200} defaultValue={s?.subject ?? ""} className="input" />
            </label>
          </div>
          <label className="block">
            <span className="label">Email</span>
            <textarea name={`step_${i + 1}_body`} rows={5} maxLength={5000} defaultValue={s?.body ?? ""} className="input" />
          </label>
        </fieldset>
      ))}
    </div>
  );
}

export async function NewSequencePage({ basePath }: ModulePageProps) {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/sequences`} label="Email sequences" />
        <h1 className="h1">New email sequence</h1>
        <p className="muted">Day 0 goes out as soon as the enrolment is approved; the others on the day after it that you write. A starting draft is filled in: change it to sound like you.</p>
      </header>
      <ActionForm action={saveSequenceAction} submit="Create sequence" className="card space-y-4">
        <label className="block">
          <span className="label">Name</span>
          <input name="name" required maxLength={120} className="input" placeholder="e.g. New enquiry follow-up" />
        </label>
        <StepFields steps={STARTER} />
      </ActionForm>
    </div>
  );
}

export async function SequencePage({ ctx, params, basePath }: ModulePageProps) {
  kickDueEmails();
  const seq = await getSequence(ctx.db, params.sequenceId ?? "");
  if (!seq) notFound();
  const sends = await recentSends(ctx.db, seq.id);
  const tz = ctx.business.timezone;
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <Back href={`${basePath}/sequences`} label="Email sequences" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="h1">{seq.name}</h1>
          {seq.active ? <span className="badge badge-ok">On</span> : <span className="badge">Off</span>}
        </div>
      </header>
      <Warnings ctx={ctx} />
      <ActionForm action={sequenceActiveAction} submit={seq.active ? "Switch off" : "Switch on"} className="card space-y-2" submitClassName={seq.active ? "btn" : "btn btn-primary"}>
        <input type="hidden" name="sequenceId" value={seq.id} />
        <input type="hidden" name="active" value={seq.active ? "off" : "on"} />
        <p className="text-sm">{seq.active ? "On: leads can be enrolled. Switching it off stops the emails not sent yet." : "Off: nobody can be enrolled and nothing is sent."}</p>
      </ActionForm>
      <ActionForm action={saveSequenceAction} submit="Save" className="card space-y-4">
        <input type="hidden" name="id" value={seq.id} />
        <label className="block">
          <span className="label">Name</span>
          <input name="name" required maxLength={120} defaultValue={seq.name} className="input" />
        </label>
        <StepFields steps={seq.steps} />
        <p className="hint">Changes apply to the emails not sent yet.</p>
      </ActionForm>
      <section className="card space-y-2">
        <h2 className="h2">Latest emails</h2>
        {sends.length === 0 ? (
          <p className="muted text-sm">Nobody is enrolled yet. Tick leads in the Leads list and send them this sequence.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="sequence-sends">
            {sends.map((s) => (
              <li key={s.id}>
                <Link className="link" href={`${basePath}/leads/${s.leadId}`}>
                  {s.leadName}
                </Link>
                : email {s.position} · {s.status === "sent" ? `sent ${formatDateTime(s.sentAt, tz)}` : s.status === "scheduled" ? `due ${formatDateTime(s.dueAt, tz)}` : s.status}
                {s.error ? <span className="block text-xs text-danger">{s.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
