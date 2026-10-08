import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { CopyField } from "@/components/copy-field";
import { env } from "@/lib/env";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { saveFormAction } from "../actions";
import { getForm, listForms, listPeople, type Form } from "../data";
import { formPath, htmlSnippet, iframeSnippet } from "../embed";
import { FORM_FIELD_LABELS, FORM_FIELDS, type FormField } from "../logic";
import { Back, PersonSelect, SubNav } from "./parts";

const DEFAULT_CONSENT = "I agree that this business may contact me by email or phone about my enquiry.";

export async function FormsPage({ ctx, basePath }: ModulePageProps) {
  const forms = await listForms(ctx.db);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Lead forms</h1>
          <p className="muted">Each form has its own page on this suite and a snippet for your website. What visitors send arrives in Leads.</p>
        </div>
        <Link href={`${basePath}/forms/new`} className="btn btn-primary">
          <Icon name="plus" className="size-4" /> New form
        </Link>
      </header>
      <SubNav basePath={basePath} current="forms" canManage />
      {forms.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No forms yet.</p>
          <p className="muted">Make one, then copy its snippet into your website.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="table" data-testid="form-list">
            <thead>
              <tr>
                <th>Form</th>
                <th>State</th>
                <th>Leads</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td>
                    <Link className="link font-medium" href={`${basePath}/forms/${f.id}`}>
                      {f.name}
                    </Link>
                  </td>
                  <td>{f.active ? <span className="badge badge-ok">On</span> : <span className="badge">Off</span>}</td>
                  <td>{f.leads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FormFields({ form, people }: { form: Form | null; people: { id: string; name: string }[] }) {
  const shown = new Set<FormField>((form?.fields as FormField[] | undefined) ?? ["email", "phone", "message"]);
  return (
    <>
      {form ? <input type="hidden" name="id" value={form.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Name (only your team sees it)</span>
          <input name="name" required maxLength={120} defaultValue={form?.name ?? ""} className="input" placeholder="e.g. Website contact form" />
        </label>
        <label className="block">
          <span className="label">Heading on the form</span>
          <input name="heading" maxLength={160} defaultValue={form?.heading ?? ""} className="input" placeholder="e.g. Ask for a quote" />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="label">Fields (name is always asked)</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {FORM_FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <input type="checkbox" name={`field_${f}`} defaultChecked={shown.has(f)} />
              <span>{FORM_FIELD_LABELS[f]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="label">Services to choose from</span>
        <textarea name="services" rows={3} maxLength={3000} defaultValue={form?.services.join("\n") ?? ""} className="input" placeholder={"One per line, e.g.\nLawn care\nHedge trimming"} />
        <span className="hint">Shown when “Service wanted” is ticked.</span>
      </label>
      <label className="block">
        <span className="label">Consent wording (the visitor must tick it)</span>
        <textarea name="consentText" rows={2} required maxLength={1000} defaultValue={form?.consentText ?? DEFAULT_CONSENT} className="input" />
        <span className="hint">In your own words. It is kept with each lead as it read when they ticked it.</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Thank-you message</span>
          <textarea name="thankYouMessage" rows={2} maxLength={1000} defaultValue={form?.thankYouMessage ?? ""} className="input" placeholder="Thank you. We have your message and will get back to you." />
        </label>
        <label className="block">
          <span className="label">Or send them to this page instead</span>
          <input name="redirectUrl" type="url" maxLength={500} defaultValue={form?.redirectUrl ?? ""} className="input" placeholder="https://www.example.com/thank-you" />
        </label>
        <label className="block">
          <span className="label">Websites that may show the form</span>
          <textarea name="embedOrigins" rows={2} maxLength={3000} defaultValue={form?.embedOrigins.join("\n") ?? ""} className="input" placeholder="https://www.example.com" />
          <span className="hint">For the iframe. Empty: any website may show it.</span>
        </label>
        <PersonSelect people={people} name="assigneeId" label="New leads go to" value={form?.assigneeId ?? null} emptyLabel="Everyone who gets new-lead alerts" />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="active" defaultChecked={form ? form.active : true} />
        <span>On (the public page takes submissions)</span>
      </label>
    </>
  );
}

export async function NewFormPage({ ctx, basePath }: ModulePageProps) {
  const people = await listPeople(ctx.db);
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/forms`} label="Lead forms" />
        <h1 className="h1">New lead form</h1>
      </header>
      <ActionForm action={saveFormAction} submit="Create form" className="card space-y-4">
        <FormFields form={null} people={people} />
      </ActionForm>
    </div>
  );
}

export async function FormPage({ ctx, params, basePath }: ModulePageProps) {
  const form = await getForm(ctx.db, /^[0-9a-f-]{36}$/i.test(params.formId ?? "") ? params.formId : "00000000-0000-0000-0000-000000000000");
  if (!form) notFound();
  const people = await listPeople(ctx.db);
  const url = env().publicUrl;
  const pub = { slug: form.slug, heading: form.heading, fields: form.fields as FormField[], services: form.services, consentText: form.consentText };
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/forms`} label="Lead forms" />
        <h1 className="h1">{form.name}</h1>
      </header>
      <section className="card space-y-3" aria-labelledby="share">
        <h2 className="h2" id="share">
          Put it on your website
        </h2>
        {!form.active ? <p className="notice notice-warn text-sm">This form is off: its page says it is not available and takes no submissions.</p> : null}
        <CopyField label="The form's own page (link to it, or share it)" value={`${url}${formPath(form.slug)}`} />
        <p className="text-sm">
          <a className="link" href={`${url}${formPath(form.slug)}`} target="_blank" rel="noreferrer" data-testid="hosted-form-link">
            Open the form&apos;s page
          </a>
        </p>
        <label className="block">
          <span className="label">Embed it (an iframe; paste where the form should appear)</span>
          <textarea readOnly rows={4} className="input font-mono text-xs" value={iframeSnippet(url, form.slug)} data-testid="iframe-snippet" />
        </label>
        <details>
          <summary className="link text-sm">Or a plain HTML form you can style yourself</summary>
          <textarea readOnly rows={10} className="input mt-2 font-mono text-xs" value={htmlSnippet(url, pub)} data-testid="html-snippet" />
          <p className="hint">It posts to this suite; the visitor then sees the thank-you message (or your page). If something is missing, they see this form&apos;s page with the message.</p>
        </details>
      </section>
      <ActionForm action={saveFormAction} submit="Save" className="card space-y-4">
        <FormFields form={form} people={people} />
      </ActionForm>
    </div>
  );
}
