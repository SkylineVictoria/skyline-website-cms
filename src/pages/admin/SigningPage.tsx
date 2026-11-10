import { useCallback, useEffect, useState } from "react";
import { Button, Field, Modal, PageHeader, Select, TextInput } from "./components/ui";
import { signingAction, signingAdmin, type SigningContext, type SigningRequest, type SigningTemplate } from "@/lib/signingApi";
import { fillSigningTemplate, signingVariables } from "../../../supabase/functions/_shared/signing";

const TEXTAREA = "w-full min-h-48 rounded border border-background-300 p-3 text-sm";
export default function SigningPage() {
  const [context, setContext] = useState<SigningContext>({ templates: [], requests: [] });
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState<SigningTemplate | null>(null); const [compose, setCompose] = useState(false);
  const [templateId, setTemplateId] = useState(""); const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const [title, setTitle] = useState(""); const [values, setValues] = useState<Record<string, string>>({}); const [file, setFile] = useState<File | undefined>();
  const [pdf, setPdf] = useState(""); const [audit, setAudit] = useState<Array<{ event: string; at: string }> | null>(null);
  const [filter, setFilter] = useState("");
  const load = useCallback(async () => setContext(await signingAdmin<SigningContext>("list")), []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  const act = async (work: () => Promise<unknown>, message = "") => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const selected = context.templates.find((t) => t.id === templateId);
  let variables: string[] = [], preview = "", previewError = "";
  if (selected && !file) {
    try {
      variables = signingVariables(`${selected.title}\n${selected.body}`).filter((k) => !["full_name", "email"].includes(k));
      preview = fillSigningTemplate(selected.body, { ...values, full_name: name, email });
    } catch (e) { previewError = e instanceof Error ? e.message : "Check template values."; }
  }
  const save = () => act(async () => {
    if (!template) return;
    if (!template.name.trim() || !template.title.trim() || !template.body.trim()) throw new Error("Enter a template name, document title and document text.");
    signingVariables(`${template.title}\n${template.body}`);
    await signingAdmin("template_save", template.id || null, { name: template.name, title: template.title, body: template.body }); setTemplate(null);
  }, "Template saved.");
  const create = () => act(async () => {
    await signingAction<SigningRequest>({ action: "create", recipientName: name, recipientEmail: email, title, templateId, values }, file);
    setCompose(false); setFile(undefined); setValues({});
  }, "Draft saved. Open the PDF to review it, then select Send for signature.");
  const view = (id: string) => act(async () => setPdf((await signingAction<{ url: string }>({ action: "admin_url", id })).url));
  return <div className="space-y-6">
    <PageHeader title="Documents & Signatures" description="Prepare a document, fill its variables and send a private signing link to a student, employee or other recipient." />
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded border border-green-300 p-3">{notice}</p>}
    <div className="flex flex-wrap gap-3"><Button onClick={() => { setCompose(true); setName(""); setEmail(""); setTitle(""); setFile(undefined); setValues({}); }}>New signing request</Button>
      <Button variant="outline" onClick={() => setTemplate({ id: "", name: "", title: "", body: "Dear {{full_name}},\n\n" })}>New template</Button>
      <Button variant="outline" disabled={busy} onClick={() => void act(load)}>Refresh status</Button></div>
    <section className="rounded border p-4"><h2 className="text-lg font-semibold">Reusable templates</h2>
      <p className="my-2 text-sm text-foreground-600">Use variables such as {"{{full_name}}, {{course_name}}, {{start_date}}, {{salary}}"}. Each request keeps its own fixed copy.</p>
      <div className="flex flex-wrap gap-2">{context.templates.map((t) => <Button key={t.id} variant="outline" onClick={() => setTemplate({ ...t })}>{t.name}</Button>)}
        {!context.templates.length && <p className="text-sm">No templates yet. Create one, or upload a PDF in a new request.</p>}</div>
    </section>
    <Field label="Find a request"><TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, email or document title" /></Field>
    <div className="space-y-3">{context.requests.filter((r) => `${r.title} ${r.recipient_name} ${r.recipient_email}`.toLowerCase().includes(filter.toLowerCase())).map((r) => {
      const closed = ["signed", "declined", "void"].includes(r.state);
      const expired = !closed && r.expires_at && new Date(r.expires_at).getTime() < Date.now();
      return <article key={r.id} className="rounded border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div>
        <h3 className="font-semibold">{r.title}</h3><p className="text-sm">{r.recipient_name} · {r.recipient_email}</p>
        <p className="mt-1 text-sm font-medium">{expired ? "Expired" : r.state.replaceAll("_", " ")}</p>{r.delivery_error && <p className="text-sm text-red-700">{r.delivery_error}</p>}
      </div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void view(r.id)}>{r.state === "signed" ? "Signed PDF" : "Preview PDF"}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(async () => setAudit((await signingAdmin<{ events: Array<{ event: string; at: string }> }>("detail", r.id)).events))}>History</Button>
        {!closed && <><Button disabled={busy} onClick={() => { if (window.confirm(`Send “${r.title}” to ${r.recipient_email} for signature? Any previous link will stop working.`)) void act(() => signingAction({ action: "send", id: r.id }), "Signing email sent."); }}>{r.state === "draft" ? "Send for signature" : "Send again"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Void this request and disable its signing link?")) void act(() => signingAdmin("void", r.id), "Request voided."); }}>Void</Button></>}
      </div></div></article>;
    })}{!context.requests.length && <p>No signing requests yet.</p>}</div>
    {template && <Modal open title={template.id ? "Edit template" : "New template"} onClose={() => { if (!busy) setTemplate(null); }} footer={<Button disabled={busy} onClick={() => void save()}>Save template</Button>}>
      <div className="space-y-4"><Field label="Template name" required><TextInput value={template.name} maxLength={120} onChange={(e) => setTemplate({ ...template, name: e.target.value })} /></Field>
        <Field label="Document title" required><TextInput value={template.title} maxLength={200} onChange={(e) => setTemplate({ ...template, title: e.target.value })} /></Field>
        <Field label="Document text" required hint="Plain text with {{variables}}. Use blank lines between paragraphs."><textarea className={TEXTAREA} value={template.body} maxLength={40000} onChange={(e) => setTemplate({ ...template, body: e.target.value })} /></Field>
        {error && <p role="alert">{error}</p>}</div>
    </Modal>}
    {compose && <Modal open title="Prepare signing request" width="max-w-4xl" onClose={() => { if (!busy) setCompose(false); }} footer={<Button disabled={busy || (!file && (!selected || !!previewError))} onClick={() => void create()}>Save draft for review</Button>}>
      <div className="space-y-4"><div className="grid gap-4 md:grid-cols-2"><Field label="Recipient full name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></Field>
        <Field label="Recipient email" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
        <Field label="Template"><Select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setValues({}); }} disabled={!!file}><option value="">Choose a template</option>{context.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="Or upload a ready-made PDF" hint="Up to 7 MB. Variables are filled in templates; an uploaded PDF is sent as supplied."><input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0])} /></Field>
        {file ? <Field label="Document title" required><TextInput maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field> : <>
          <div className="grid gap-4 md:grid-cols-2">{variables.map((key) => <Field key={key} label={key.replaceAll("_", " ")} required><TextInput value={values[key] ?? ""} maxLength={2000} onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></Field>)}</div>
          {previewError ? <p className="text-sm">{previewError}</p> : preview && <pre className="whitespace-pre-wrap rounded border bg-background-50 p-4 font-sans text-sm">{preview}</pre>}
        </>}{error && <p role="alert">{error}</p>}
      </div>
    </Modal>}
    {pdf && <Modal open title="Review document" width="max-w-5xl" onClose={() => setPdf("")}><a href={pdf} target="_blank" rel="noreferrer" className="underline">Open / download PDF</a><iframe title="Document preview" src={pdf} className="mt-3 h-[70vh] w-full" referrerPolicy="no-referrer" /><p className="mt-2 text-sm">If the link expires, close this preview and open it again.</p></Modal>}
    {audit && <Modal open title="Signing history" onClose={() => setAudit(null)}><ol className="space-y-3">{audit.map((e, i) => <li key={i}>{e.event.replaceAll("_", " ")} — {new Date(e.at).toLocaleString()}</li>)}</ol></Modal>}
  </div>;
}
