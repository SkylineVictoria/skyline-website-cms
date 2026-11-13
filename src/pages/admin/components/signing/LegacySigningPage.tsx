import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, Modal, PageHeader, Select, TextInput } from "../ui";
import { signingAction, signingAdmin, type LegacySigningContext as SigningContext, type SigningPreview, type LegacySigningRequest as SigningRequest, type LegacySigningTemplate as SigningTemplate } from "@/lib/signingApi";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { templatePerson } from "@/lib/hrTemplatesApi";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";
import { fillSigningTemplate, signingVariables } from "../../../../../supabase/functions/_shared/signing";
import { PLACEHOLDERS, templateValues, type PlaceholderSpec } from "../../../../../supabase/functions/_shared/hr-template";

const TEXTAREA = "w-full min-h-48 rounded border border-background-300 p-3 text-sm";
const ALERT = "rounded border border-primary-200 bg-primary-50 p-3 text-sm text-primary-900";
/** The record variables a signing template may use (the same names as letter templates, without the email link ones). */
const RECORD_VARIABLES: PlaceholderSpec[] = PLACEHOLDERS.filter((p) => !p.only && p.group !== "Links");
const RECORD_KEYS = new Set(RECORD_VARIABLES.map((p) => p.key));
type Step = "fill" | "preview" | "edit";

function pdfBlobUrl(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

/**
 * Documents & Signatures. Templates are plain text with {{variables}} inserted from a picker: the staff record's variables
 * (full name, job title, job location, job type, pay type, start date, manager, company, today …) and any custom variable typed
 * in. A request is composed for a staff member (their record fills the variables; what is empty is flagged, never sent raw) or
 * for someone else (typed values). Flow: template › fill / confirm › preview the PDF exactly as it will be sent › edit the text of
 * this copy (optional; the template is untouched) › save the draft › send for e-signing. The sent text is stored with the request.
 */
/** The released first-stage Documents & Signatures page (main 0059351), shown while the hosted database is that version. */
export default function LegacySigningPage() {
  const [context, setContext] = useState<SigningContext>({ templates: [], requests: [] });
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState<SigningTemplate | null>(null); const [compose, setCompose] = useState(false);
  const [templateId, setTemplateId] = useState(""); const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const [title, setTitle] = useState(""); const [values, setValues] = useState<Record<string, string>>({}); const [file, setFile] = useState<File | undefined>();
  const [recipientKind, setRecipientKind] = useState<"staff" | "other">("staff");
  const [staffSearch, setStaffSearch] = useState(""); const [staffRows, setStaffRows] = useState<StaffListRow[]>([]); const [staff, setStaff] = useState<StaffListRow | null>(null);
  const [record, setRecord] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("fill"); const [preview, setPreview] = useState<SigningPreview | null>(null); const [pdfUrl, setPdfUrl] = useState("");
  const [draft, setDraft] = useState(""); const [edited, setEdited] = useState<string | null>(null); const [composeError, setComposeError] = useState("");
  const [pdf, setPdf] = useState(""); const [audit, setAudit] = useState<Array<{ event: string; at: string }> | null>(null);
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => setContext(await signingAdmin<SigningContext>("list")), []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  useEffect(() => {
    if (!compose || recipientKind !== "staff") return;
    let live = true;
    const timer = window.setTimeout(() => {
      void adminListStaff([], staffSearch, 25, 0).then((data) => { if (live) setStaffRows(data.rows); }, () => { if (live) setStaffRows([]); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [compose, recipientKind, staffSearch]);

  const act = async (work: () => Promise<unknown>, message = "") => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const chooseStaff = async (row: StaffListRow | null) => {
    setStaff(row); setRecord({}); setPreview(null); setEdited(null); setStep("fill");
    if (!row) return;
    setName(row.name); setEmail(row.email);
    try { setRecord(templateValues(await templatePerson(row.id))); } catch (e) { setComposeError(e instanceof Error ? e.message : "The staff record could not be read."); }
  };

  const selected = context.templates.find((t) => t.id === templateId);
  const variables = useMemo(() => {
    if (!selected) return [] as string[];
    try { return signingVariables(`${selected.title}\n${selected.body}`).filter((k) => !["full_name", "email"].includes(k)); } catch { return []; }
  }, [selected]);
  // What each variable will be filled with: the staff record first, then what was typed; '' = still missing.
  const filled = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of variables) out[key] = (recipientKind === "staff" && RECORD_KEYS.has(key) ? record[key] : undefined) || values[key] || "";
    return { ...out, full_name: name.trim(), email: email.trim() };
  }, [variables, record, values, name, email, recipientKind]);
  const missing = variables.filter((k) => !filled[k]);
  let clientPreview = "", previewError = "";
  if (selected && !file) {
    try { clientPreview = fillSigningTemplate(selected.body, filled); } catch (e) { previewError = e instanceof Error ? e.message : "Check the values."; }
  }

  const insertVariable = (key: string) => {
    if (!template) return;
    const el = bodyRef.current; const token = `{{${key}}}`;
    if (!el) { setTemplate({ ...template, body: `${template.body}${token}` }); return; }
    const start = el.selectionStart ?? template.body.length, end = el.selectionEnd ?? start;
    const body = `${template.body.slice(0, start)}${token}${template.body.slice(end)}`;
    setTemplate({ ...template, body });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };
  const save = () => act(async () => {
    if (!template) return;
    if (!template.name.trim() || !template.title.trim() || !template.body.trim()) throw new Error("Enter a template name, document title and document text.");
    signingVariables(`${template.title}\n${template.body}`);
    await signingAdmin("template_save", template.id || null, { name: template.name, title: template.title, body: template.body }); setTemplate(null);
  }, "Template saved.");

  const requestBody = (text: string | null) => ({
    recipientName: name, recipientEmail: email, title, templateId, values: filled, profileId: recipientKind === "staff" ? staff?.id ?? null : null, ...(text ? { text } : {}),
  });
  const showPreview = async (text: string | null) => {
    if (busy) return; setBusy(true); setComposeError("");
    try {
      const made = await signingAction<SigningPreview>({ action: "preview", ...requestBody(text) });
      setPreview(made); setEdited(made.edited ? made.text : null);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(pdfBlobUrl(made.pdfBase64)); setStep("preview");
    } catch (e) { setComposeError(e instanceof Error ? e.message : "The preview could not be made."); }
    finally { setBusy(false); }
  };
  const create = () => act(async () => {
    await signingAction<SigningRequest>({ action: "create", ...requestBody(edited) }, file);
    closeCompose();
  }, "Draft saved exactly as previewed. Select Send for signature when you are ready.");
  const closeCompose = () => { setCompose(false); setFile(undefined); setValues({}); setStaff(null); setRecord({}); setPreview(null); setEdited(null); setStep("fill"); setComposeError(""); };
  const view = (id: string) => act(async () => setPdf((await signingAction<{ url: string }>({ action: "admin_url", id })).url));
  const draftLeft = step === "edit" ? (() => { try { return signingVariables(draft); } catch { return ["…"]; } })() : [];
  const canSave = file ? Boolean(name && email && title) : step === "preview" && Boolean(preview) && !missing.length;

  return <div className="space-y-6">
    <PageHeader title="Documents & Signatures" description="Prepare a document from a template, fill its variables from the staff record, preview and edit it, then send a private signing link." />
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded border border-green-300 p-3">{notice}</p>}
    <div className="flex flex-wrap gap-3"><Button onClick={() => { closeCompose(); setCompose(true); setName(""); setEmail(""); setTitle(""); setTemplateId(""); setRecipientKind("staff"); }} data-testid="signing-new">New signing request</Button>
      <Button variant="outline" onClick={() => setTemplate({ id: "", name: "", title: "", body: "Dear {{full_name}},\n\n" })} data-testid="signing-new-template">New template</Button>
      <Button variant="outline" disabled={busy} onClick={() => void act(load)}>Refresh status</Button></div>
    <section className="rounded border p-4"><h2 className="text-lg font-semibold">Reusable templates</h2>
      <p className="my-2 text-sm text-foreground-600">Variables such as {"{{employee_full_name}}, {{job_title}}, {{job_location}}, {{job_type}}, {{pay_type}}, {{start_date}}, {{company_name}}, {{today_date}}"} are filled from the staff record when the request is made; add your own (for example {"{{course_name}}"}) and type its value per request. Each request keeps its own fixed copy.</p>
      <div className="flex flex-wrap gap-2">{context.templates.map((t) => <Button key={t.id} variant="outline" onClick={() => setTemplate({ ...t })}>{t.name}</Button>)}
        {!context.templates.length && <p className="text-sm">No templates yet. Create one, or upload a PDF in a new request.</p>}</div>
    </section>
    <Field label="Find a request"><TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, email or document title" /></Field>
    <div className="space-y-3">{context.requests.filter((r) => `${r.title} ${r.recipient_name} ${r.recipient_email}`.toLowerCase().includes(filter.toLowerCase())).map((r) => {
      const closed = ["signed", "declined", "void"].includes(r.state);
      const expired = !closed && r.expires_at && new Date(r.expires_at).getTime() < Date.now();
      return <article key={r.id} className="rounded border p-4" data-testid={`signing-request-${r.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div>
        <h3 className="font-semibold">{r.title}{r.edited ? <span className="ml-2 rounded bg-secondary-100 px-1.5 py-0.5 text-xs font-semibold text-secondary-900">Edited copy</span> : null}</h3>
        <p className="text-sm">{r.recipient_name} · {r.recipient_email}{r.profile_id ? <> · <Link to={staffEmployeePath(r.profile_id)} className="text-primary-700 hover:underline">staff record</Link></> : null}</p>
        <p className="mt-1 text-sm font-medium">{expired ? "Expired" : r.state.replaceAll("_", " ")}</p>{r.delivery_error && <p className="text-sm text-red-700">{r.delivery_error}</p>}
      </div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void view(r.id)}>{r.state === "signed" ? "Signed PDF" : "Preview PDF"}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(async () => setAudit((await signingAdmin<{ events: Array<{ event: string; at: string }> }>("detail", r.id)).events))}>History</Button>
        {!closed && <><Button disabled={busy} onClick={() => { if (window.confirm(`Send “${r.title}” to ${r.recipient_email} for signature? Any previous link will stop working.`)) void act(() => signingAction({ action: "send", id: r.id }), "Signing email sent."); }} data-testid={`signing-send-${r.id}`}>{r.state === "draft" ? "Send for signature" : "Send again"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Void this request and disable its signing link?")) void act(() => signingAdmin("void", r.id), "Request voided."); }}>Void</Button></>}
      </div></div></article>;
    })}{!context.requests.length && <p>No signing requests yet.</p>}</div>

    {template && <Modal open width="max-w-4xl" title={template.id ? "Edit template" : "New template"} onClose={() => { if (!busy) setTemplate(null); }} footer={<Button disabled={busy} onClick={() => void save()} data-testid="signing-template-save">Save template</Button>}>
      <div className="space-y-4"><div className="grid gap-4 md:grid-cols-2"><Field label="Template name" required><TextInput value={template.name} maxLength={120} onChange={(e) => setTemplate({ ...template, name: e.target.value })} data-testid="signing-template-name" /></Field>
        <Field label="Document title" required hint="May use variables too, for example “Agreement: {{job_title}}”."><TextInput value={template.title} maxLength={200} onChange={(e) => setTemplate({ ...template, title: e.target.value })} data-testid="signing-template-title" /></Field></div>
        <div className="grid gap-3 lg:grid-cols-[1fr_250px]">
          <Field label="Document text" required hint="Plain text with {{variables}}. Use blank lines between paragraphs."><textarea ref={bodyRef} className={TEXTAREA} value={template.body} maxLength={40000} onChange={(e) => setTemplate({ ...template, body: e.target.value })} data-testid="signing-template-body" /></Field>
          <aside className="rounded-md border border-background-200 bg-background-100 p-3" aria-label="Variables">
            <p className="text-label font-semibold text-foreground-900">Variables</p>
            <p className="mb-2 text-xs text-foreground-600">Click one to insert it at the cursor. These are filled from the staff record; anything else you type as {"{{my_variable}}"} is asked for per request.</p>
            <div className="max-h-[40vh] space-y-3 overflow-y-auto pr-1">
              {(["Person", "Job and pay", "Company"] as const).map((group) => <div key={group}>
                <p className="mb-1 text-2xs font-bold uppercase tracking-wide text-foreground-500">{group}</p>
                <ul className="space-y-1">{RECORD_VARIABLES.filter((p) => p.group === group).map((p) => <li key={p.key}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVariable(p.key)} data-testid={`signing-variable-${p.key}`} title={`Example: ${p.sample}`}
                    className="w-full cursor-pointer rounded border border-background-300 bg-background-50 px-2 py-1 text-left text-xs hover:border-primary-300 hover:bg-primary-50">
                    <span className="block font-medium text-foreground-900">{p.label}</span><code className="text-2xs text-foreground-600">{`{{${p.key}}}`}</code></button></li>)}</ul>
              </div>)}
              <CustomVariable onInsert={insertVariable} />
            </div>
          </aside>
        </div>
        {error && <p role="alert" className={ALERT}>{error}</p>}</div>
    </Modal>}

    {compose && <Modal open title="Prepare signing request" width="max-w-5xl" onClose={() => { if (!busy) closeCompose(); }}
      footer={<>
        {step !== "fill" && !file ? <Button variant="outline" disabled={busy} onClick={() => setStep(step === "edit" ? "preview" : "fill")}>Back</Button> : null}
        {step === "fill" && !file ? <Button disabled={busy || !selected || missing.length > 0 || !name.trim() || !email.trim()} onClick={() => void showPreview(edited)} data-testid="signing-preview">{busy ? "Making the preview…" : "Preview the PDF"}</Button> : null}
        {step === "preview" && !file ? <Button variant="outline" disabled={busy} onClick={() => { setDraft(edited ?? preview?.text ?? ""); setStep("edit"); }} data-testid="signing-edit">Edit this document</Button> : null}
        {step === "edit" ? <>{edited ? <Button variant="outline" disabled={busy} onClick={() => { setEdited(null); void showPreview(null); }}>Discard my changes</Button> : null}
          <Button disabled={busy || draftLeft.length > 0} onClick={() => void showPreview(draft)} data-testid="signing-edit-preview">{busy ? "Making the preview…" : "Preview with my changes"}</Button></> : null}
        {(file || step === "preview") ? <Button disabled={busy || !canSave} onClick={() => void create()} data-testid="signing-save-draft">Save draft for sending</Button> : null}
      </>}>
      <div className="space-y-4">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-600" aria-label="Steps">
          {(["fill", "preview", "edit"] as Step[]).map((s, i) => <li key={s} className={s === step ? "font-semibold text-foreground-950" : ""}>{i + 1}. {s === "fill" ? "Recipient, template and details" : s === "preview" ? "Preview" : "Edit (optional)"}</li>)}
          <li>4. Save, then send</li>
        </ol>
        {step === "fill" ? <>
          <Field label="Who signs">
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={recipientKind === "staff"} onChange={() => { setRecipientKind("staff"); setPreview(null); }} /> A staff member (their record fills the variables)</label>
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={recipientKind === "other"} onChange={() => { setRecipientKind("other"); void chooseStaff(null); setName(""); setEmail(""); }} /> Someone else</label>
            </div>
          </Field>
          {recipientKind === "staff" ? <div className="grid gap-4 md:grid-cols-2">
            <Field label="Find a staff member" hint="Search by name or email."><TextInput value={staffSearch} onChange={(e) => setStaffSearch(e.target.value)} data-testid="signing-staff-search" /></Field>
            <Field label="Staff member" required><Select value={staff?.id ?? ""} onChange={(e) => void chooseStaff(staffRows.find((r) => r.id === e.target.value) ?? null)} data-testid="signing-staff">
              <option value="">Choose…</option>{staff && !staffRows.some((r) => r.id === staff.id) ? <option value={staff.id}>{staff.name || staff.email}</option> : null}
              {staffRows.map((r) => <option key={r.id} value={r.id}>{r.name || r.email}{r.jobTitle ? ` · ${r.jobTitle}` : ""}</option>)}
            </Select></Field>
          </div> : null}
          <div className="grid gap-4 md:grid-cols-2"><Field label="Recipient full name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={150} data-testid="signing-name" /></Field>
            <Field label="Recipient email" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="signing-email" /></Field></div>
          <Field label="Template"><Select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setValues({}); setPreview(null); setEdited(null); }} disabled={!!file} data-testid="signing-template"><option value="">Choose a template</option>{context.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Or upload a ready-made PDF" hint="Up to 7 MB. Variables are filled in templates; an uploaded PDF is sent as supplied."><input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0])} /></Field>
          {file ? <Field label="Document title" required><TextInput maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field> : selected ? <>
            {variables.length ? <div className="rounded-md border border-background-200 p-3">
              <p className="mb-2 text-label font-semibold text-foreground-900">Variables in “{selected.name}”</p>
              <div className="grid gap-3 md:grid-cols-2" data-testid="signing-variables">{variables.map((key) => {
                const fromRecord = recipientKind === "staff" && RECORD_KEYS.has(key);
                const value = filled[key];
                return <div key={key} data-testid={`signing-variable-row-${key}`}>
                  <Field label={`{{${key}}}`} required hint={fromRecord ? (value ? "From the staff record." : "Empty on the staff record: add it to their employment or pay details, or type it here.") : undefined}>
                    {fromRecord && value ? <p className="rounded border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm">{value}</p>
                      : <TextInput value={values[key] ?? ""} maxLength={2000} onChange={(e) => setValues({ ...values, [key]: e.target.value })} aria-invalid={!value} className={!value ? "border-primary-400 bg-primary-50" : undefined} />}
                  </Field>
                </div>; })}</div>
              {missing.length ? <p role="alert" className={`mt-2 ${ALERT}`} data-testid="signing-missing">Still empty: <strong>{missing.map((k) => `{{${k}}}`).join(", ")}</strong>. Nothing is sent with a raw variable in it.</p> : null}
            </div> : null}
            {previewError && !missing.length ? <p className="text-sm">{previewError}</p> : clientPreview ? <details className="rounded border bg-background-50 p-3"><summary className="cursor-pointer text-sm font-medium">Text (filled in)</summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm" data-testid="signing-text-preview">{highlight(clientPreview, missing)}</pre></details> : null}
          </> : null}
        </> : null}
        {step === "preview" && preview ? <div className="space-y-2" data-testid="signing-pdf-preview">
          <p className="text-sm"><strong>{preview.title}</strong>{preview.edited ? <span className="ml-2 rounded bg-secondary-100 px-1.5 py-0.5 text-xs font-semibold text-secondary-900">Edited for this document</span> : null}</p>
          <p className="text-xs text-foreground-600">This is the PDF that will be sent for signing: the same letterhead, fonts and “Document” header as the final copy.</p>
          {pdfUrl ? <iframe title="Document preview" src={pdfUrl} className="h-[60vh] w-full rounded border bg-white" referrerPolicy="no-referrer" /> : null}
        </div> : null}
        {step === "edit" ? <div className="space-y-2" data-testid="signing-edit-step">
          <p className="text-sm">Change the text of <strong>this document only</strong>. The template “{selected?.name}” stays as it is.</p>
          <textarea className={`${TEXTAREA} min-h-[50vh]`} value={draft} maxLength={40000} onChange={(e) => setDraft(e.target.value)} data-testid="signing-edit-text" />
          {draftLeft.length ? <p role="alert" className={ALERT}>The text still has {draftLeft.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it before previewing.</p> : null}
        </div> : null}
        {composeError && <p role="alert" className={ALERT} data-testid="signing-compose-error">{composeError}</p>}
        {error && <p role="alert" className={ALERT}>{error}</p>}
      </div>
    </Modal>}
    {pdf && <Modal open title="Review document" width="max-w-5xl" onClose={() => setPdf("")}><a href={pdf} target="_blank" rel="noreferrer" className="underline">Open / download PDF</a><iframe title="Document preview" src={pdf} className="mt-3 h-[70vh] w-full" referrerPolicy="no-referrer" /><p className="mt-2 text-xs text-foreground-600">This link works for 60 seconds.</p></Modal>}
    {audit && <Modal open title="Signing history" onClose={() => setAudit(null)}><ol className="space-y-3">{audit.map((e, i) => <li key={i}>{e.event.replaceAll("_", " ")} — {new Date(e.at).toLocaleString()}</li>)}</ol></Modal>}
  </div>;
}

/** Unfilled variables stand out in the text preview. */
function highlight(text: string, missing: string[]) {
  if (!missing.length) return text;
  const parts = text.split(/(\{\{\s*[a-z][a-z0-9_]*\s*\}\})/g);
  return parts.map((part, i) => (/^\{\{/.test(part) ? <mark key={i} className="rounded bg-primary-100 px-1 text-primary-900">{part}</mark> : part));
}

function CustomVariable({ onInsert }: { onInsert: (key: string) => void }) {
  const [key, setKey] = useState("");
  const clean = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "");
  return <div>
    <p className="mb-1 text-2xs font-bold uppercase tracking-wide text-foreground-500">Custom</p>
    <div className="flex gap-1"><TextInput value={key} placeholder="course_name" onChange={(e) => setKey(e.target.value)} data-testid="signing-custom-variable" />
      <Button size="sm" variant="outline" disabled={!clean} onMouseDown={(e) => e.preventDefault()} onClick={() => { onInsert(clean); setKey(""); }}>Insert</Button></div>
    <p className="mt-1 text-2xs text-foreground-600">Lowercase letters, numbers and underscores. Its value is typed when a request is made.</p>
  </div>;
}
