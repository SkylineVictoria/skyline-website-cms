import { useEffect, useRef, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "../ui";
import FieldEditor, { type EditorField } from "@/components/signing/FieldEditor";
import PdfPages from "@/components/signing/PdfPages";
import { docxText, pdfBytes, signingAction, signingAdmin, type SigningRole, type SigningTemplate, type TemplateField } from "@/lib/signingApi";
import { SIGN_CATEGORIES, SUBJECT_VARIABLES, signingVariables } from "../../../../../supabase/functions/_shared/signing";

type Draft = Pick<SigningTemplate, "name" | "title" | "kind" | "audience" | "category" | "signing_mode" | "expiry_days" | "reminder_days" | "roles" | "fields"> & { id: string | null; body: string; source_pages: number | null; version: number };
const blank = (): Draft => ({ id: null, name: "", title: "", body: "Dear {{student.first_name}},\n\n", kind: "text", audience: "any", category: "other", signing_mode: "sequential", expiry_days: 14, reminder_days: 3,
  roles: [{ key: "signer1", label: "Signer", order: 1, required: true }], fields: [], source_pages: null, version: 0 });
const SENDER = "sender";
const roleKey = (label: string, taken: string[]) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 30) || "signer";
  let key = base, n = 2; while (taken.includes(key) || key === SENDER) key = `${base}_${n++}`;
  return key;
};

/** Create or edit a template: its text or PDF, variables, signer roles, where each signer's fields go, expiry and reminders, and its versions. */
export default function TemplateEditor({ template, onClose, onSaved }: { template: SigningTemplate | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => template ? { ...template, body: template.body ?? "", id: template.id } : blank());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [placing, setPlacing] = useState<string | Uint8Array | null>(null); const [preview, setPreview] = useState<Uint8Array | null>(null);
  const [versions, setVersions] = useState<Array<{ version: number; created_at: string; name: string }> | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => { if (template) void signingAdmin<Array<{ version: number; created_at: string; name: string }>>("template_versions", template.id).then(setVersions).catch(() => setVersions([])); }, [template]);

  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); } };
  const payload = () => ({ name: draft.name.trim(), title: draft.title.trim(), body: draft.kind === "text" ? draft.body : null, kind: draft.kind, audience: draft.audience, category: draft.category,
    signing_mode: draft.signing_mode, expiry_days: draft.expiry_days, reminder_days: draft.reminder_days, roles: draft.roles, fields: draft.fields });
  const check = () => {
    if (!draft.name.trim() || !draft.title.trim()) throw new Error("Enter a template name and a document title.");
    if (draft.kind === "text" && !draft.body.trim()) throw new Error("Enter the document text, or import a Word document.");
    if (draft.kind === "pdf" && !draft.id && !file) throw new Error("Choose the PDF for this template.");
    if (draft.roles.some((r) => !r.label.trim())) throw new Error("Give every signer a role name.");
    signingVariables([draft.title, draft.kind === "text" ? draft.body : "", ...draft.fields.filter((f) => f.role === SENDER).map((f) => f.value ?? "")].join("\n"));
  };
  const save = () => run(async () => {
    check();
    if (draft.kind === "pdf" && file) await signingAction({ action: "template_upload", id: draft.id, template: payload() }, file);
    else await signingAdmin("template_save", draft.id, payload());
    onSaved(draft.id ? "Template saved as a new version." : "Template created.");
  });
  const documentSource = async (): Promise<string | Uint8Array> => {
    if (draft.kind === "pdf") return file ? new Uint8Array(await file.arrayBuffer()) : (await signingAction<{ url: string }>({ action: "template_url", id: draft.id })).url;
    return pdfBytes((await signingAction<{ pdfBase64: string }>({ action: "template_preview", template: { ...payload(), fields: [] } })).pdfBase64);
  };
  const insert = (variable: string) => {
    const area = body.current; const token = `{{${variable}}}`;
    if (!area) { set({ body: draft.body + token }); return; }
    const at = area.selectionStart ?? draft.body.length;
    set({ body: draft.body.slice(0, at) + token + draft.body.slice(area.selectionEnd ?? at) });
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(at + token.length, at + token.length); });
  };
  const owners = [...draft.roles.map((r) => ({ id: r.key, label: r.label || r.key })), ...(draft.kind === "pdf" ? [{ id: SENDER, label: "Sender (printed text / variables)", textOnly: true }] : [])];
  const editorFields: EditorField[] = draft.fields.map((f, i) => ({ key: `t${i}`, type: f.type, owner: f.role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required !== false, label: f.label ?? "", value: f.value }));
  const fromEditor = (fields: EditorField[]): TemplateField[] => fields.map((f) => ({ type: f.type, role: f.owner, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, value: f.value ?? "" }));
  const setRole = (index: number, patch: Partial<SigningRole>) => set({ roles: draft.roles.map((r, i) => i === index ? { ...r, ...patch } : r) });
  const variables = draft.audience === "any" ? [...new Set(Object.values(SUBJECT_VARIABLES).flat())] : SUBJECT_VARIABLES[draft.audience];

  if (placing) return <Modal open title={`Place fields: ${draft.name || "template"}`} width="max-w-6xl" onClose={() => setPlacing(null)} footer={<Button onClick={() => setPlacing(null)}>Done placing fields</Button>}>
    {draft.kind === "text" && <p className="mb-3 text-sm text-foreground-600">The sample shows [variable] where a value will go. Long values can move text, so place signature fields near the end of the document, and check the preview of each request.</p>}
    <FieldEditor source={placing} owners={owners} fields={editorFields} onChange={(fields) => set({ fields: fromEditor(fields) })} />
  </Modal>;
  if (preview) return <Modal open title="Template preview" width="max-w-4xl" onClose={() => setPreview(null)}><PdfPages source={preview} /></Modal>;

  return <Modal open title={template ? `Edit template (version ${draft.version})` : "New template"} width="max-w-4xl" onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="outline" disabled={busy} onClick={() => void run(async () => { check(); const source = await documentSource(); setPreview(typeof source === "string" ? new Uint8Array(await (await fetch(source)).arrayBuffer()) : source); })}>Preview</Button>
      <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save template"}</Button></>}>
    <div className="space-y-5">
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Template name" required><TextInput value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Document title" required hint="Shown to signers. Variables are allowed."><TextInput value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Used for"><Select value={draft.audience} onChange={(e) => set({ audience: e.target.value as Draft["audience"] })}><option value="any">Anyone</option><option value="student">Students</option><option value="employee">Employees</option><option value="agent">Agents</option></Select></Field>
        <Field label="Document type"><Select value={draft.category} onChange={(e) => set({ category: e.target.value })}>{Object.entries(SIGN_CATEGORIES).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}</Select></Field>
      </div>
      {!template && <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "text"} onChange={() => set({ kind: "text", fields: [] })} /> Text with variables (or a Word document)</label>
        <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "pdf"} onChange={() => set({ kind: "pdf", fields: [] })} /> A ready-made PDF</label></div>}
      {draft.kind === "text" ? <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Insert a variable"><Select value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} data-testid="insert-variable"><option value="">Choose…</option>{variables.map((v) => <option key={v} value={v}>{`{{${v}}}`}</option>)}</Select></Field>
          <Field label="Import a Word document (.docx)" hint="The text is brought in; formatting is not kept."><input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-testid="docx-input"
            onChange={(e) => { const chosen = e.target.files?.[0]; if (chosen) void run(async () => { set({ body: await docxText(chosen) }); }); }} /></Field>
        </div>
        <Field label="Document text" required hint="Plain text with {{variables}}; blank lines between paragraphs. Any other name, such as {{salary}}, is typed when the request is made.">
          <textarea ref={body} rows={12} value={draft.body} maxLength={40000} onChange={(e) => set({ body: e.target.value })} data-testid="template-body"
            className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100" /></Field>
      </div> : <Field label={draft.id ? `PDF (${draft.source_pages ?? "?"} pages). Choose a file only to replace it` : "PDF document"} required={!draft.id} hint="Up to 7 MB, not password-protected. Variables are printed with Sender fields placed on the pages.">
        <input type="file" accept="application/pdf" data-testid="template-pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) set({ fields: draft.id ? draft.fields : [] }); }} /></Field>}

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
      {versions && versions.length > 0 && <section><h3 className="mb-2 font-semibold">Versions</h3>
        <ul className="space-y-1 text-sm">{versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-3">Version {v.version} · {new Date(v.created_at).toLocaleString()} · {v.name}
          {v.version !== draft.version && <button type="button" className="text-primary-700 underline" disabled={busy} onClick={() => void run(async () => { await signingAdmin("template_restore", draft.id, { version: v.version }); onSaved(`Version ${v.version} restored as a new version.`); })}>Restore</button>}</li>)}</ul></section>}
    </div>
  </Modal>;
}
