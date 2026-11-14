import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "../ui";
import FieldEditor, { type EditorField } from "@/components/signing/FieldEditor";
import PdfPages from "@/components/signing/PdfPages";
import RichTextEditor from "@/pages/admin/components/hrms/TemplateEditor";
import TemplatePreviewDialog from "./TemplatePreviewDialog";
import DocumentSections from "./DocumentSections";
import { LetterTestDialog, UnmappedTokens } from "./LetterTemplateTools";
import { LETTER_CATEGORY, loadLetterRegistry, rehostImagesIn } from "@/lib/offerLetters";
import { supabase } from "@/pages/admin/lib/supabase";
import { unmappedTokens, type LetterVariable } from "../../../../../supabase/functions/_shared/letter-variables";
import { isTemplateAsset } from "../../../../../supabase/functions/_shared/rich-html";
import { sectionsReport } from "@/lib/templateSections";
import { richPlainText, sanitizeRichHtml } from "../../../../../supabase/functions/_shared/rich-html";
import { docxText, pdfBytes, signingAction, signingAdmin, type SigningRole, type SigningTemplate, type TemplateField } from "@/lib/signingApi";
import { SIGN_CATEGORIES, SUBJECT_VARIABLES, signingVariables } from "../../../../../supabase/functions/_shared/signing";
import {
  PLACEHOLDERS, TEMPLATE_TYPES, isTemplateType, placeholderLabels, placeholdersFor, sanitizeTemplateHtml, templatePlaceholders, templateText, textToHtml,
  type PlaceholderSpec, type TemplateType,
} from "../../../../../supabase/functions/_shared/hr-template";

type Kind = "text" | "email" | "pdf";
type Draft = Pick<SigningTemplate, "name" | "title" | "audience" | "category" | "signing_mode" | "expiry_days" | "reminder_days" | "roles" | "fields">
  & { id: string | null; kind: Kind; body_html: string; header_html: string; footer_html: string; subject: string; is_default: boolean; source_pages: number | null; version: number };
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const SENDER = "sender";
const EMAIL_TYPES = TEMPLATE_TYPES.filter((t) => t.kind === "email");
const blank = (kind: Kind = "text", category = "offer_letter"): Draft => ({
  id: null, name: "", title: "", body_html: "<p></p>", header_html: "", footer_html: "", subject: "", is_default: false, kind, audience: kind === "email" || category === "offer_letter" ? "employee" : "any", category,
  signing_mode: "sequential", expiry_days: 14, reminder_days: 3, roles: [{ key: "signer1", label: "Signer", order: 1, required: true }], fields: [], source_pages: null, version: 0,
});
const roleKey = (label: string, taken: string[]) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 30) || "signer";
  let key = base, n = 2; while (taken.includes(key) || key === SENDER) key = `${base}_${n++}`;
  return key;
};
/** The variables a record fills by itself, as placeholder cards beside the editor. */
const RECORD_GROUP: Record<string, PlaceholderSpec["group"]> = { student: "Student", employee: "Employee record", agent: "Agent" };
function recordPlaceholders(audience: SigningTemplate["audience"]): PlaceholderSpec[] {
  const kinds = audience === "any" ? (["student", "employee", "agent"] as const) : [audience];
  const seen = new Set<string>();
  const out: PlaceholderSpec[] = [];
  for (const kind of kinds) for (const key of SUBJECT_VARIABLES[kind]) {
    if (seen.has(key)) continue; seen.add(key);
    const label = key.replace(/^(student|employee|agent|agency|course)\./, "").replaceAll("_", " ");
    out.push({ key, label: key === "current_date" ? "Today's date" : label.charAt(0).toUpperCase() + label.slice(1), sample: `[${key}]`, group: key === "current_date" ? "Document" : RECORD_GROUP[kind] });
  }
  return out;
}
/** The categories a kind may have: emails have their own five; letters and documents the signing ones. */
/** For a new template the audience is chosen first: only its types are offered (students: the Letter of Offer and the student documents). */
const categoryOptions = (kind: Kind, audience?: SigningTemplate["audience"]): Array<[string, string]> => kind === "email" ? EMAIL_TYPES.map((t) => [t.type, t.label])
  : Object.entries(SIGN_CATEGORIES).filter(([, c]) => !audience || audience === "any" || c.audience === audience || c.audience === "any").map(([key, c]) => [key, c.label]);

/**
 * One editor for every template (the one table since 20261113170000): a letter or document to sign (rich text with placeholders, or a
 * ready-made PDF), or an email. Signer roles, placed fields, expiry and reminders apply to documents; a default per kind; versions.
 */
export default function TemplateEditor({ template, onClose, onSaved, newKind = "text", newCategory, audience }: {
  template: SigningTemplate | null; onClose: () => void; onSaved: (message: string, id?: string) => void; newKind?: Kind; newCategory?: string;
  /** A new template: the audience chosen first (only its types are offered). */ audience?: SigningTemplate["audience"];
}) {
  const [draft, setDraft] = useState<Draft>(() => template
    ? { ...template, id: template.id, kind: template.kind, body_html: template.body_html?.trim() ? template.body_html : textToHtml(template.body ?? ""), header_html: template.header_html ?? "", footer_html: template.footer_html ?? "", subject: template.subject ?? (template.kind === "email" ? template.title : ""), is_default: Boolean(template.is_default) }
    : { ...blank(newKind, newCategory ?? (newKind === "email" ? "offer_email" : "offer_letter")), ...(audience ? { audience } : {}) });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [placing, setPlacing] = useState<string | Uint8Array | null>(null); const [preview, setPreview] = useState<Uint8Array | null>(null);
  const [previewWith, setPreviewWith] = useState(false);
  /** Sectioned documents: what the template asks for, shown before it is saved (TPL-02). */
  const [confirming, setConfirming] = useState<ReturnType<typeof sectionsReport> | null>(null);
  const [versions, setVersions] = useState<Array<{ version: number; created_at: string; name: string }> | null>(null);
  /** Student offer letters (LOO): the {{variable}} registry, the save check of unmapped tokens, and the test dialog. */
  const [registry, setRegistry] = useState<LetterVariable[] | null>(null);
  const [letterCheck, setLetterCheck] = useState(false);
  const [letterTest, setLetterTest] = useState<"sample" | "application" | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => { if (template) void signingAdmin<Array<{ version: number; created_at: string; name: string }>>("template_versions", template.id).then(setVersions).catch(() => setVersions([])); }, [template]);

  const hrms = isTemplateType(draft.category);
  const loo = draft.category === LETTER_CATEGORY;
  useEffect(() => { if (loo && !registry) void loadLetterRegistry().then(setRegistry, (e: Error) => setError(e.message)); }, [loo, registry]);
  // A new student letter starts with the standard SLIT letterhead and footer (from the database; both stay editable).
  useEffect(() => {
    if (template || !loo || draft.header_html.trim() || draft.footer_html.trim()) return;
    let active = true;
    void Promise.all([supabase.rpc("letter_standard_header"), supabase.rpc("letter_standard_footer", { p_title: (draft.title || "LETTER OF OFFER AND WRITTEN AGREEMENT").toUpperCase(), p_version: "Version 1.0" })])
      .then(([h, f]) => { if (active && !h.error && !f.error) setDraft((d) => (d.header_html.trim() || d.footer_html.trim() ? d : { ...d, header_html: String(h.data ?? ""), footer_html: String(f.data ?? "") })); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when a new student letter opens
  }, [template, loo]);
  const spec = hrms ? TEMPLATE_TYPES.find((t) => t.type === draft.category) : undefined;
  const signed = draft.kind !== "email" && !loo;
  // A document template (not an HRMS letter or email, not a PDF) has a header, a body and a footer, and [Variable] tokens.
  const sections = draft.kind === "text" && !hrms;
  const html = sections ? sanitizeRichHtml(draft.body_html) : sanitizeTemplateHtml(draft.body_html);
  const placeholders: PlaceholderSpec[] = draft.kind === "pdf" ? [] : [
    ...(hrms ? placeholdersFor(draft.category as TemplateType) : PLACEHOLDERS.filter((p) => !p.only)),
    ...(draft.kind === "email" ? [] : recordPlaceholders(draft.audience)),
  ];
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); } };
  const payload = () => ({
    name: draft.name.trim(), title: (draft.kind === "email" ? draft.subject : draft.title).trim(), subject: draft.kind === "email" ? draft.subject.trim() : null,
    body_html: draft.kind === "pdf" ? null : html, body: draft.kind === "pdf" ? null : sections ? richPlainText(html).slice(0, 200000) || null : templateText(html), kind: draft.kind,
    ...(sections ? { header_html: sanitizeRichHtml(draft.header_html), footer_html: sanitizeRichHtml(draft.footer_html), bracket_variables: !loo } : {}), audience: loo ? "student" : draft.audience, category: draft.category,
    signing_mode: draft.signing_mode, expiry_days: draft.expiry_days, reminder_days: draft.reminder_days, roles: draft.roles, fields: signed ? draft.fields : [], is_default: draft.is_default,
  });
  /** The same checks the database makes (hr.template_problem for letters and emails; the signing variable rules for the rest). */
  const check = () => {
    if (!draft.name.trim()) throw new Error("Give the template a name.");
    if (draft.kind === "email" ? !draft.subject.trim() : !draft.title.trim()) throw new Error(draft.kind === "email" ? "Enter the email subject." : hrms ? "Give the letter a title." : "Enter a document title.");
    if (draft.kind === "pdf") { if (!draft.id && !file) throw new Error("Choose the PDF for this template."); }
    else if (sections ? !richPlainText(html).trim() : !html.replace(/<[^>]*>|&nbsp;|\s/g, "")) throw new Error("The template has no text yet.");
    if (signed && draft.roles.some((r) => !r.label.trim())) throw new Error("Give every signer a role name.");
    const text = draft.kind === "pdf" ? "" : html;
    if (hrms && spec) {
      const allowed = new Set([...placeholdersFor(draft.category as TemplateType).map((p) => p.key), ...(draft.kind === "email" ? [] : recordPlaceholders(draft.audience).map((p) => p.key))]);
      const unknown = templatePlaceholders(`${draft.kind === "email" ? draft.subject : draft.title} ${text}`).filter((k) => !allowed.has(k) && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(k));
      if (unknown.length) throw new Error(`${unknown.map((k) => `{{${k}}}`).join(", ")} cannot be used in this kind of template. Use the list on the right.`);
      const missing = spec.requires.filter((k) => !templatePlaceholders(text).includes(k));
      if (missing.length) throw new Error(`This email must contain ${missing.map((k) => `{{${k}}}`).join(" and ")} (${placeholderLabels(missing)}).`);
    }
    if (!loo) signingVariables([draft.title, text, ...draft.fields.filter((f) => f.role === SENDER).map((f) => f.value ?? "")].join("\n"));
  };
  const letterParts = () => ({ title: draft.title, header_html: draft.header_html, body_html: draft.body_html, footer_html: draft.footer_html });
  const unmapped = loo && registry ? unmappedTokens(Object.values(letterParts()).join("\n"), registry) : [];
  /** Offer letters keep no embedded pictures: any left from an older version or a Word import go to template-assets before saving. */
  const rehostSections = async () => {
    const patch: Partial<Draft> = {};
    let failed = 0;
    for (const field of ["header_html", "body_html", "footer_html"] as const) {
      const srcs = [...draft[field].matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
      if (!srcs.some((src) => !isTemplateAsset(src))) continue;
      const result = await rehostImagesIn(draft[field]);
      patch[field] = result.html; failed += result.failed;
    }
    if (Object.keys(patch).length) setDraft((d) => ({ ...d, ...patch }));
    if (failed) throw new Error(`${failed} picture(s) could not be copied to the picture store. Insert them again with Insert image.`);
  };
  const save = (confirmed = false) => run(async () => {
    check();
    if (loo && !confirmed) { await rehostSections(); setLetterCheck(true); return; }
    if (sections && !loo && !confirmed) { setConfirming(sectionsReport(draft, draft.title)); return; }
    setConfirming(null); setLetterCheck(false);
    const saved = draft.kind === "pdf" && file ? await signingAction<{ id?: string } | null>({ action: "template_upload", id: draft.id, template: payload() }, file)
      : await signingAdmin<{ id?: string } | null>("template_save", draft.id, payload());
    onSaved((draft.id ? "The template was saved as a new version." : "The template was added.") + (loo && unmapped.length ? " It is inactive until every variable is mapped." : ""), saved?.id ?? draft.id ?? undefined);
  });
  const documentSource = async (): Promise<string | Uint8Array> => {
    if (draft.kind === "pdf") return file ? new Uint8Array(await file.arrayBuffer()) : (await signingAction<{ url: string }>({ action: "template_url", id: draft.id })).url;
    return pdfBytes((await signingAction<{ pdfBase64: string }>({ action: "template_preview", template: { ...payload(), fields: [] } })).pdfBase64);
  };
  const owners = [...draft.roles.map((r) => ({ id: r.key, label: r.label || r.key })), ...(draft.kind === "pdf" ? [{ id: SENDER, label: "Sender (printed text / variables)", textOnly: true }] : [])];
  const editorFields: EditorField[] = draft.fields.map((f, i) => ({ key: `t${i}`, type: f.type, owner: f.role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required !== false, label: f.label ?? "", value: f.value }));
  const fromEditor = (fields: EditorField[]): TemplateField[] => fields.map((f) => ({ type: f.type, role: f.owner, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, value: f.value ?? "" }));
  const setRole = (index: number, patch: Partial<SigningRole>) => set({ roles: draft.roles.map((r, i) => i === index ? { ...r, ...patch } : r) });
  const kindLabel = draft.kind === "email" ? "email" : draft.kind === "pdf" ? "PDF template" : hrms ? "letter" : "document template";

  if (placing) return <Modal open fill title={`Place fields: ${draft.name || "template"}`} width="max-w-6xl" onClose={() => setPlacing(null)} footer={<Button onClick={() => setPlacing(null)}>Done placing fields</Button>}>
    {draft.kind === "text" && <p className="mb-3 shrink-0 text-sm text-foreground-600">The sample shows [variable] where a value will go. Long values can move text, so place signature fields near the end of the document, and check the preview of each request.</p>}
    <FieldEditor source={placing} owners={owners} fields={editorFields} onChange={(fields) => set({ fields: fromEditor(fields) })} />
  </Modal>;
  if (preview) return <Modal open title="Template preview (PDF)" width="max-w-4xl" onClose={() => setPreview(null)}><PdfPages source={preview} /></Modal>;
  if (confirming) {
    const { report, warnings } = confirming;
    const list = (items: string[]) => items.length ? <ul className="ml-5 list-disc">{items.map((n) => <li key={n}><code>[{n}]</code></li>)}</ul> : <p className="text-foreground-600">None.</p>;
    return <Modal open title="Check the variables before saving" width="max-w-2xl" onClose={() => setConfirming(null)}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>Back to editing</Button><Button disabled={busy} onClick={() => void save(true)} data-testid="template-save-confirm">{busy ? "Saving…" : "Save template"}</Button></>}>
      <div className="space-y-4 text-sm" data-testid="template-variable-check">
        {error && <p role="alert" className={ALERT}>{error}</p>}
        {warnings.length > 0 && <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3"><p className="font-semibold">Check these brackets</p><ul className="ml-5 list-disc">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
        <section data-testid="signer-fields"><h3 className="font-semibold">Filled in by the signer before signing ({report.fields.length})</h3>
          <p className="mb-1 text-foreground-600">Each of these is a box the signer must complete on the signing screen. If one is a typing mistake for a variable, go back and fix it.</p>{list(report.fields)}</section>
        <section><h3 className="font-semibold">Filled from the record ({report.known.length})</h3>{list(report.known)}</section>
        <section><h3 className="font-semibold">Filled automatically ({report.automatic.length})</h3>{list(report.automatic)}</section>
      </div>
    </Modal>;
  }
  if (letterTest && registry) return <LetterTestDialog template={letterParts()} registry={registry} mode={letterTest} onClose={() => setLetterTest(null)} />;
  if (letterCheck && registry) {
    return <Modal open title="Check the variables before saving" width="max-w-2xl" onClose={() => setLetterCheck(false)}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setLetterCheck(false)}>Back to editing</Button>
        <Button disabled={busy} onClick={() => void save(true)} data-testid="template-save-confirm">{busy ? "Saving…" : unmapped.length ? "Save as inactive" : "Save template"}</Button></>}>
      <div className="space-y-3 text-sm" data-testid="letter-variable-check">
        {error && <p role="alert" className={ALERT}>{error}</p>}
        <UnmappedTokens template={letterParts()} registry={registry} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <p className="text-foreground-600">Each saved version is kept: letters already issued keep the version they were made from.</p>
      </div>
    </Modal>;
  }
  if (previewWith && hrms) return <TemplatePreviewDialog template={{ id: draft.id, type: draft.category as TemplateType, name: draft.name, subject: draft.kind === "email" ? draft.subject : draft.title, bodyHtml: html }} onClose={() => setPreviewWith(false)} />;

  return <Modal open title={template ? `Edit ${kindLabel} (version ${draft.version})` : `New ${kindLabel}`} width="max-w-5xl" onClose={() => { if (!busy) onClose(); }}
    footer={<>
      {hrms && draft.kind !== "pdf" && <Button variant="outline" disabled={busy} onClick={() => setPreviewWith(true)} data-testid="template-draft-preview">Preview with an employee's details</Button>}
      {loo ? <>
        <Button variant="outline" disabled={busy || !registry} onClick={() => setLetterTest("sample")} data-testid="letter-preview-sample">Preview with sample application</Button>
        <Button variant="outline" disabled={busy || !registry} onClick={() => setLetterTest("application")} data-testid="letter-test-application-open">Test with application</Button>
      </> : draft.kind !== "email" && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { check(); const source = await documentSource(); setPreview(typeof source === "string" ? new Uint8Array(await (await fetch(source)).arrayBuffer()) : source); })}>Preview the PDF</Button>}
      <span className="flex-1" />
      <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button disabled={busy} onClick={() => void save()} data-testid="template-save">{busy ? "Saving…" : "Save template"}</Button></>}>
    <div className="space-y-5" data-testid="template-dialog">
      {error && <p role="alert" className={ALERT} data-testid="template-error">{error}</p>}
      {!template && <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Kind of template">
        <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "text"} onChange={() => set({ kind: "text", fields: [], category: isTemplateType(draft.category) && draft.category !== "offer_letter" ? "offer_letter" : draft.category })} /> Letter or document to sign (rich text with placeholders)</label>
        {audience !== "agent" && <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "email"} onChange={() => set({ kind: "email", fields: [], audience: "employee", category: EMAIL_TYPES.some((t) => t.type === draft.category) ? draft.category : "offer_email" })} /> Email</label>}
        <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "pdf"} onChange={() => set({ kind: "pdf", fields: [], category: isTemplateType(draft.category) && draft.category !== "offer_letter" ? "other" : draft.category })} /> A ready-made PDF</label>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Template name" required hint="Only Admins see this."><TextInput value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} data-testid="template-name" /></Field>
        {draft.kind === "email"
          ? <Field label="Email subject" required hint="Placeholders work here too."><TextInput value={draft.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} data-testid="template-subject" /></Field>
          : <Field label={hrms ? "Letter title" : "Document title"} required hint={hrms ? "Placeholders work here too; it is also the PDF's name." : "Shown to signers. Variables are allowed."}><TextInput value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} data-testid="template-subject" /></Field>}
        <Field label={draft.kind === "email" ? "Kind of email" : "Document type"}>
          <Select value={draft.category} disabled={Boolean(template) && hrms} onChange={(e) => set({ category: e.target.value, ...(isTemplateType(e.target.value) ? { audience: "employee" } : {}) })} data-testid="template-category">
            {categoryOptions(draft.kind, template ? undefined : audience).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select>
        </Field>
        {draft.kind !== "email" && <Field label="Used for"><Select value={loo ? "student" : draft.audience} disabled={hrms || loo || audience === "agent"} onChange={(e) => set({ audience: e.target.value as Draft["audience"] })}><option value="any">Anyone</option><option value="student">Students</option><option value="employee">Employees</option><option value="agent">Agents / Businesses</option></Select></Field>}
      </div>
      {spec && <p className="text-sm text-foreground-600">{spec.description}</p>}
      {loo && registry && unmapped.length ? <UnmappedTokens template={letterParts()} registry={registry} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} /> : null}
      {sections ? <DocumentSections value={{ header_html: draft.header_html, body_html: draft.body_html, footer_html: draft.footer_html }} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onError={setError}
        {...(loo ? { letterVariables: registry ?? [], storageImages: true } : {})} />
      : draft.kind !== "pdf" ? <div className="space-y-2">
        <RichTextEditor key={draft.id ?? `new-${draft.kind}`} value={draft.body_html} onChange={(body_html) => setDraft((d) => ({ ...d, body_html }))} placeholders={placeholders} />
        <div className="flex flex-wrap items-center gap-4 text-xs text-foreground-600">
          {hrms && <span>A line that only holds an optional detail (department, hours per week, reporting manager, work location) is left out for a person who does not have it.</span>}
          {spec?.requires.length ? <span>This email must contain {spec.requires.map((k) => `{{${k}}}`).join(" and ")}: it is the link the person uses.</span> : null}
          {draft.kind === "text" && !sections && <label className="flex items-center gap-2">Import a Word document (.docx): <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-testid="docx-input"
            onChange={(e) => { const chosen = e.target.files?.[0]; if (chosen) void run(async () => { set({ body_html: textToHtml(await docxText(chosen)) }); }); }} /></label>}
        </div>
      </div> : <Field label={draft.id ? `PDF (${draft.source_pages ?? "?"} pages). Choose a file only to replace it` : "PDF document"} required={!draft.id} hint="Up to 7 MB, not password-protected. Variables are printed with Sender fields placed on the pages.">
        <input type="file" accept="application/pdf" data-testid="template-pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) set({ fields: draft.id ? draft.fields : [] }); }} /></Field>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.is_default} onChange={(e) => set({ is_default: e.target.checked })} data-testid="template-default" /> Default {draft.kind === "email" ? "email of this kind" : `${SIGN_CATEGORIES[draft.category]?.label.toLowerCase() ?? "template"} (proposed first when one is sent)`}</label>

      {signed && <>
        <section className="space-y-2"><h3 className="font-semibold">Signers</h3>
          <p className="text-sm text-foreground-600">One row per person who signs, for example Employee, HR Manager, Director. The order is used when signing one after another.</p>
          {draft.roles.map((role, i) => <div key={role.key} className="flex flex-wrap items-center gap-2">
            <TextInput className="!w-56" aria-label={`Signer ${i + 1} role`} value={role.label} maxLength={80} placeholder="Role, e.g. Employee" onChange={(e) => setRole(i, { label: e.target.value })} />
            <label className="flex items-center gap-1 text-sm">Order <input type="number" min={1} max={50} value={role.order} onChange={(e) => setRole(i, { order: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} className="w-16 rounded border border-background-300 px-2 py-1.5" /></label>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={role.required} onChange={(e) => setRole(i, { required: e.target.checked })} /> Required</label>
            {draft.roles.length > 1 && <button type="button" className="text-sm text-red-700 underline" onClick={() => set({ roles: draft.roles.filter((_, x) => x !== i), fields: draft.fields.filter((f) => f.role !== role.key) })}>Remove</button>}
          </div>)}
          {draft.roles.length < 10 && <Button variant="outline" size="sm" onClick={() => set({ roles: [...draft.roles, { key: roleKey(`signer ${draft.roles.length + 1}`, draft.roles.map((r) => r.key)), label: "", order: draft.roles.length + 1, required: true }] })}>Add a signer</Button>}
        </section>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Signing order"><Select value={draft.signing_mode} onChange={(e) => set({ signing_mode: e.target.value as Draft["signing_mode"] })}><option value="sequential">One after another</option><option value="parallel">Everyone at once</option></Select></Field>
          <Field label="Expires after (days)"><TextInput type="number" min={1} max={365} value={draft.expiry_days} onChange={(e) => set({ expiry_days: Math.min(365, Math.max(1, Number(e.target.value) || 14)) })} /></Field>
          <Field label="Remind every (days)" hint="0 = no reminders"><TextInput type="number" min={0} max={60} value={draft.reminder_days} onChange={(e) => set({ reminder_days: Math.min(60, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
        </div>
        <section className="flex flex-wrap items-center gap-3 rounded-md border border-background-300 p-3">
          <div className="grow text-sm"><p className="font-semibold">Signature and other fields</p><p className="text-foreground-600">{draft.fields.length ? `${draft.fields.length} placed.` : "None placed: each signer's signature is then added on a signature page at the end."}</p></div>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { check(); setPlacing(await documentSource()); })} data-testid="place-fields">Place fields on the document</Button>
        </section>
      </>}
      {versions && versions.length > 0 && <section><h3 className="mb-2 font-semibold">Versions</h3>
        <ul className="space-y-1 text-sm">{versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-3">Version {v.version} · {new Date(v.created_at).toLocaleString()} · {v.name}
          {v.version !== draft.version && <button type="button" className="text-primary-700 underline" disabled={busy} onClick={() => void run(async () => { await signingAdmin("template_restore", draft.id, { version: v.version }); onSaved(`Version ${v.version} restored as a new version.`); })}>Restore</button>}</li>)}</ul></section>}
    </div>
  </Modal>;
}
