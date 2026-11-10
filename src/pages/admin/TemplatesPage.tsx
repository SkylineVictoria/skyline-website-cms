import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Field, Modal, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import TemplateEditor from "@/pages/admin/components/hrms/TemplateEditor";
import { TEMPLATE_PROSE } from "@/pages/admin/lib/onboardingText";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { archiveTemplate, duplicateTemplate, listTemplates, saveTemplate, setDefaultTemplate, templatePerson, type HrTemplate } from "@/lib/hrTemplatesApi";
import {
  TEMPLATE_TYPES, placeholderLabels, placeholdersFor, renderMessage, sampleValues, sanitizeTemplateHtml, templatePlaceholders, templateValues,
  type TemplatePerson, type TemplateType,
} from "../../../supabase/functions/_shared/hr-template";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const SAMPLE_LINKS = { signing_link: "https://your-site/staff/welcome (personal link)", login_url: "https://your-site/login", document_link: "https://your-site/staff/onboard (personal link)",
  link_expiry: "24 November 2026", rejected_documents: "Passport: the photo page is cut off" };

interface Draft { id: string | null; type: TemplateType; name: string; subject: string; bodyHtml: string }

/** What stops a draft from being saved (the database checks the same things in hr_admin_template_save). */
function draftProblem(draft: Draft): string | null {
  const spec = TEMPLATE_TYPES.find((t) => t.type === draft.type)!;
  if (!draft.name.trim()) return "Give the template a name.";
  if (!draft.subject.trim()) return spec.kind === "letter" ? "Give the letter a title." : "Enter the email subject.";
  const body = sanitizeTemplateHtml(draft.bodyHtml);
  if (!body.replace(/<[^>]*>|&nbsp;|\s/g, "")) return "The template has no text yet.";
  const allowed = new Set(placeholdersFor(draft.type).map((p) => p.key));
  const used = templatePlaceholders(`${draft.subject} ${body}`);
  const unknown = used.filter((k) => !allowed.has(k));
  if (unknown.length) return `${unknown.map((k) => `{{${k}}}`).join(", ")} cannot be used in this kind of template. Use the list on the right.`;
  const missing = spec.requires.filter((k) => !templatePlaceholders(body).includes(k));
  if (missing.length) return `This email must contain ${missing.map((k) => `{{${k}}}`).join(" and ")} (${placeholderLabels(missing)}).`;
  return null;
}

/**
 * HRMS > Templates (Admin only): offer letters and the onboarding emails. Create, edit, duplicate, archive and preview; one
 * default per kind (a different one can be chosen when sending). A preview fills the template with a chosen employee's real
 * details, or with sample details. A letter already made for someone keeps its own saved copy, so edits here never change it.
 */
export default function TemplatesPage() {
  const [templates, setTemplates] = useState<HrTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [busy, setBusy] = useState("");
  const [previewing, setPreviewing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try { setTemplates(await listTemplates()); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The templates could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await work(); await load(); setNotice(done); }
    catch (e) { setError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(""); }
  };

  const save = async () => {
    if (!draft || busy) return;
    const problem = draftProblem(draft);
    if (problem) { setDraftError(problem); return; }
    setBusy("save"); setDraftError("");
    try {
      await saveTemplate(draft.id, { type: draft.type, name: draft.name.trim(), subject: draft.subject.trim(), bodyHtml: sanitizeTemplateHtml(draft.bodyHtml) });
      setDraft(null); await load(); setNotice(draft.id ? "The template was saved." : "The template was added.");
    } catch (e) { setDraftError(e instanceof Error ? e.message : "The template could not be saved."); }
    finally { setBusy(""); }
  };

  const draftSpec = draft ? TEMPLATE_TYPES.find((t) => t.type === draft.type)! : null;
  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Templates" description="Offer letters and the emails sent during onboarding. Placeholders such as {{first_name}} are filled in for each person."
        actions={<label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-700"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} data-testid="templates-show-archived" /> Show archived</label>} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`} data-testid="templates-error">{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="templates-notice">{notice}</p> : null}
      {!templates && !error ? <p className="text-sm text-foreground-600" role="status">Loading…</p> : null}

      {templates ? (
        <div className="space-y-5">
          {TEMPLATE_TYPES.map((spec) => {
            const mine = templates.filter((t) => t.type === spec.type && (showArchived || !t.archivedAt));
            return (
              <Card key={spec.type} className="p-5"><section data-testid={`templates-${spec.type}`}>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-heading text-base font-bold text-foreground-950">{spec.label}</h2>
                    <p className="text-sm text-foreground-600">{spec.description}</p>
                  </div>
                  <Button size="sm" variant="outline" icon="ri-add-line" data-testid={`template-new-${spec.type}`}
                    onClick={() => { setDraft({ id: null, type: spec.type, name: "", subject: "", bodyHtml: "<p></p>" }); setDraftError(""); }}>New {spec.label.toLowerCase()}</Button>
                </div>
                {mine.length ? (
                  <ul className="divide-y divide-background-200 rounded-md border border-background-200">
                    {mine.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-testid="template-row" data-template-id={t.id}>
                        <div className="min-w-0 flex-1 basis-56">
                          <p className="text-sm font-semibold text-foreground-950">{t.name}
                            {t.isDefault ? <span className="ml-2 align-middle"><Badge tone="success">Default</Badge></span> : null}
                            {t.archivedAt ? <span className="ml-2 align-middle"><Badge tone="muted">Archived</Badge></span> : null}</p>
                          <p className="truncate text-xs text-foreground-600">{spec.kind === "letter" ? "Title" : "Subject"}: {t.subject} · updated {day(t.updatedAt)}</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setPreviewing({ id: t.id, type: t.type, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml })} data-testid="template-preview">Preview</Button>
                          {t.archivedAt ? (
                            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`restore-${t.id}`, () => archiveTemplate(t.id, false), "The template was restored.")} data-testid="template-restore">Restore</Button>
                          ) : <>
                            <Button size="sm" variant="outline" onClick={() => { setDraft({ id: t.id, type: t.type, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml }); setDraftError(""); }} data-testid="template-edit">Edit</Button>
                            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`copy-${t.id}`, () => duplicateTemplate(t.id), "A copy was made.")} data-testid="template-duplicate">Duplicate</Button>
                            {t.isDefault ? null : <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`default-${t.id}`, () => setDefaultTemplate(t.id), `“${t.name}” is now the default.`)} data-testid="template-make-default">Make default</Button>}
                            {t.isDefault ? null : <Button size="sm" variant="ghost" disabled={Boolean(busy)}
                              onClick={() => { if (window.confirm(`Archive “${t.name}”? It stays on file and can be restored, but is not offered when sending.`)) void act(`archive-${t.id}`, () => archiveTemplate(t.id, true), "The template was archived."); }} data-testid="template-archive">Archive</Button>}
                          </>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-foreground-500">No {spec.label.toLowerCase()} yet{spec.kind === "email" ? ": the built-in email is used until you add one" : ""}.</p>}
              </section></Card>
            );
          })}
        </div>
      ) : null}

      {draft && draftSpec ? (
        <Modal open width="max-w-5xl" title={`${draft.id ? "Edit" : "New"} ${draftSpec.label.toLowerCase()}`} onClose={() => { if (!busy) setDraft(null); }}
          footer={<>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setPreviewing(draft)} data-testid="template-draft-preview">Preview</Button>
            <span className="flex-1" />
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={Boolean(busy)} onClick={() => void save()} data-testid="template-save">{busy === "save" ? "Saving…" : "Save template"}</Button>
          </>}>
          <div className="space-y-3" data-testid="template-dialog">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Template name" required hint="Only Admins see this."><TextInput maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="template-name" /></Field>
              <Field label={draftSpec.kind === "letter" ? "Letter title" : "Email subject"} required hint="Placeholders work here too.">
                <TextInput maxLength={200} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} data-testid="template-subject" /></Field>
            </div>
            <TemplateEditor key={draft.id ?? `new-${draft.type}`} value={draft.bodyHtml} onChange={(bodyHtml) => setDraft((d) => (d ? { ...d, bodyHtml } : d))} placeholders={placeholdersFor(draft.type)} />
            <p className="text-xs text-foreground-600">A line that only holds an optional detail (department, hours per week, reporting manager, work location) is left out for a person who does not have it, so no bare label is shown.</p>
            {draftSpec.requires.length ? <p className="text-xs text-foreground-600">This email must contain {draftSpec.requires.map((k) => `{{${k}}}`).join(" and ")}: it is the link the person uses.</p> : null}
            {draftError ? <p role="alert" className={ALERT} data-testid="template-error">{draftError}</p> : null}
          </div>
        </Modal>
      ) : null}

      {previewing ? <PreviewDialog template={previewing} onClose={() => setPreviewing(null)} /> : null}
    </div>
  );
}

/** A template filled in with a chosen employee's real details (or sample details). Links are shown as examples. */
function PreviewDialog({ template, onClose }: { template: Draft; onClose: () => void }) {
  const [people, setPeople] = useState<StaffListRow[]>([]);
  const [search, setSearch] = useState("");
  const [personId, setPersonId] = useState("");
  const [person, setPerson] = useState<TemplatePerson | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => { void adminListStaff([], search, 25, 0).then((d) => { if (live) setPeople(d.rows); }, () => { if (live) setPeople([]); }); }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [search]);
  useEffect(() => {
    if (!personId) { setPerson(null); setError(""); return; }
    let live = true;
    templatePerson(personId).then((p) => { if (live) { setPerson(p); setError(""); } }, (e) => { if (live) { setPerson(null); setError(e instanceof Error ? e.message : "That person's details could not be loaded."); } });
    return () => { live = false; };
  }, [personId]);

  const rendered = useMemo(() => renderMessage(template, person ? templateValues(person, SAMPLE_LINKS) : { ...sampleValues(), ...SAMPLE_LINKS }), [template, person]);
  const gaps = [...rendered.missing, ...rendered.unknown];
  const kind = TEMPLATE_TYPES.find((t) => t.type === template.type)!.kind;
  return (
    <Modal open width="max-w-4xl" title={`Preview: ${template.name || "new template"}`} onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="space-y-3" data-testid="template-preview-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Find an employee"><TextInput placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="template-preview-search" /></Field>
          <Field label="Fill it in with">
            <Select value={personId} onChange={(e) => setPersonId(e.target.value)} data-testid="template-preview-person">
              <option value="">Sample details</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
            </Select>
          </Field>
        </div>
        {error ? <p role="alert" className={ALERT}>{error}</p> : null}
        {gaps.length ? <p role="alert" className={ALERT} data-testid="template-preview-missing">{person ? "This person has no value for" : "No value for"} <strong>{placeholderLabels(gaps)}</strong>. Sending is refused until every placeholder used has a value.</p> : null}
        <p className="text-[13px] font-medium text-foreground-800">{kind === "letter" ? "Title" : "Subject"}: <span className="font-normal" data-testid="template-preview-subject">{rendered.subject}</span></p>
        <div className="max-h-[52vh] overflow-y-auto rounded-md border border-background-300 bg-white px-6 py-5 shadow-sm">
          {/* Sanitised by renderMessage (allow-list rebuild); every value is escaped. */}
          <div className={TEMPLATE_PROSE} data-testid="template-preview-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
        <p className="text-xs text-foreground-600">Links are examples here. The real personal link is made when the email is sent{kind === "letter" ? "; the letter is saved as a PDF" : ""}.</p>
      </div>
    </Modal>
  );
}
