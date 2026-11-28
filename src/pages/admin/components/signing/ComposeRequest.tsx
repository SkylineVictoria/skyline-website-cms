import { useEffect, useMemo, useState } from "react";
import { ruleNumber, ruleText } from "@/lib/businessRules";
import { Button, Field, Modal, Select, TextArea, TextInput } from "../ui";
import PdfPages from "@/components/signing/PdfPages";
import { describePayment, paymentSet, pdfBytes, samePayment, signingAction, signingAdmin, templatePayment, type PaymentInput, type SigningRequest, type SigningSubject, type SigningTemplate } from "@/lib/signingApi";
import { PaymentPanel } from "./PaymentForm";
import { SIGN_CATEGORIES, signingVariables, templateVariables } from "../../../../../supabase/functions/_shared/signing";
import { templatePlaceholders, templateValues } from "../../../../../supabase/functions/_shared/hr-template";
import { templatePerson } from "@/lib/hrTemplatesApi";
import RichTextEditor from "@/pages/admin/components/hrms/TemplateEditor";
import DocRichTextEditor from "@/pages/admin/components/RichTextEditor";
import { richPlainText } from "../../../../../supabase/functions/_shared/rich-html";
import { tokenReport, variableKeys } from "../../../../../supabase/functions/_shared/template-variables";
import OfferLetterDrawer from "@/components/shared/application-status/OfferLetterDrawer";
import { getStudent, type ApplicationRow } from "@/pages/admin/lib/businessData";
import { LETTER_CATEGORY } from "@/lib/offerLetters";
import { putPdfOnLetterhead } from "@/lib/letterheadDesigner";

export interface SubjectPreset { type: "student" | "employee" | "agent" | "agency"; id: string; name?: string }
interface Person { role: string; label: string; name: string; email: string; order: number; required: boolean }
const person = (n: number): Person => ({ role: `signer${n}`, label: n === 1 ? "Signer" : `Signer ${n}`, name: "", email: "", order: n, required: true });
const SUBJECT_LABEL = { student: "Student", employee: "Employee", agent: "Agent", agency: "Agency" } as const;
const SUBJECT_PLURAL = { student: "students", employee: "employees", agent: "agents", agency: "agencies" } as const;
/** The agent onboarding blanks (F04, P06, F05) go only through the business onboarding flow; document-signing refuses them here too. */
const ONBOARDING_KEYS = new Set(["agent_application_form", "agent_agreement", "agent_referee_check_form"]);
/**
 * A template that is filled from one of the student's applications (2026-11-21): the student offer letter (its course, fee and
 * intake variables and {{#each courses}} blocks come from the application). It is prepared and sent by the Applications offer
 * builder (OfferLetterDrawer), opened here for the chosen application, so the offer is recorded exactly as from Applications.
 */
const needsApplication = (t: SigningTemplate) => t.category === LETTER_CATEGORY;

/**
 * Prepare a signing request: a template (its variables filled from the chosen student, employee or agent) or a ready-made PDF, one or more
 * recipients in order, the signing order, expiry, reminders and a message. It is saved as a draft; nothing is emailed until it is sent.
 */
export default function ComposeRequest({ templates, templatesLoading = false, preset, initialSource = "template", onClose, onCreated, onOfferSent }: {
  templates: SigningTemplate[];
  /** The page is still loading its templates: "Loading templates…", never the empty-state message. */
  templatesLoading?: boolean;
  preset?: SubjectPreset;
  /** Where the form starts: a saved template, or a one-time PDF (the business Documents tab when no agency template exists, 2026-11-24). */
  initialSource?: "template" | "upload";
  onClose: () => void;
  /** `warning`: the request exists, but something after it (changing its payment) failed. */
  onCreated: (request: SigningRequest, warning?: string) => void;
  /** An offer letter prepared from an application was sent (the offer flow made the request); without it the dialog just closes. */
  onOfferSent?: (message: string) => void;
}) {
  const [source, setSource] = useState<"template" | "upload">(initialSource);
  const [templateId, setTemplateId] = useState(""); const [file, setFile] = useState<File | undefined>(); const [title, setTitle] = useState("");
  /** LETTERHEAD-ON-DOCUMENTS (owner 2026-11-28): a one-time PDF is put on the letterhead (shrunk to fit) unless unticked. */
  const [onLetterhead, setOnLetterhead] = useState(true);
  const [category, setCategory] = useState("other");
  const [subjectType, setSubjectType] = useState<"" | SubjectPreset["type"]>(preset?.type ?? ""); const [subjectId, setSubjectId] = useState(preset?.id ?? "");
  const [query, setQuery] = useState(""); const [matches, setMatches] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [subject, setSubject] = useState<SigningSubject | null>(null);
  const [people, setPeople] = useState<Person[]>([person(1)]);
  // Business Rules signing.default_signer_order / signing.request_expiry_default / signing.request_reminder_default (the database defaults read the same).
  const [mode, setMode] = useState<"sequential" | "parallel">(() => (ruleText("signing.default_signer_order", "Sequential").toLowerCase().startsWith("parallel") ? "parallel" : "sequential"));
  const [expiry, setExpiry] = useState(() => ruleNumber("signing.request_expiry_default", 14)); const [reminder, setReminder] = useState(() => ruleNumber("signing.request_reminder_default", 3));
  const [message, setMessage] = useState(""); const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [preview, setPreview] = useState<Uint8Array | null>(null);
  /** The text of THIS copy when the administrator edits it (text templates only; the template is untouched); `copyIsHtml` for a rich template. */
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copyIsHtml, setCopyIsHtml] = useState(false);
  /** Stripe: the payment this request will ask for (the template's to start with, when it has one; added, changed or removed here). */
  const [payment, setPayment] = useState<PaymentInput | null>(null);
  // Emails are not signed; every other active template whose "Used for" matches the person type is offered (its current version is what
  // "create" uses). 2026-11-21: the student offer letter is offered too (it was left out, so "A student" had an empty list): it needs
  // one of the student's applications and is prepared from it below.
  const usable = useMemo(() => templates.filter((t) => t.status === "active" && t.category !== "application_form" && t.kind !== "email" && !ONBOARDING_KEYS.has(t.system_key ?? "")
    && (!subjectType || t.audience === "any" || t.audience === subjectType)), [templates, subjectType]);
  const template = usable.find((t) => t.id === templateId);
  const fromApplication = source === "template" && !!template && needsApplication(template);
  // The chosen student's applications, for a template filled from an application.
  const [applications, setApplications] = useState<ApplicationRow[] | null>(null);
  const [applicationId, setApplicationId] = useState("");
  const [offerOpen, setOfferOpen] = useState(false);
  useEffect(() => {
    setApplicationId(""); setApplications(null);
    if (subjectType !== "student" || !subjectId) return;
    let live = true;
    void getStudent(subjectId).then((s) => { if (live) setApplications(s?.applications ?? []); }, () => { if (live) setApplications([]); });
    return () => { live = false; };
  }, [subjectType, subjectId]);
  const application = applications?.find((a) => a.id === applicationId) ?? null;

  // The record's own values (name, address, course…) and the first recipient.
  useEffect(() => {
    if (!subjectType || !subjectId) { setSubject(null); return; }
    let live = true;
    void signingAdmin<SigningSubject>("subject_values", subjectId, { type: subjectType }).then(async (s) => {
      // An employee's letter variables of HRMS > Templates ({{job_title}}, {{job_location}}…) fill too.
      if (subjectType === "employee") {
        try { const letter = templateValues(await templatePerson(subjectId)); s = { ...s, values: { ...Object.fromEntries(Object.entries(letter).filter(([, v]) => String(v ?? "").trim())), ...s.values } }; } catch { /* the signing names still fill */ }
      }
      if (!live) return; setSubject(s);
      setPeople((rows) => rows.map((r, i) => i === 0 && !r.name && !r.email ? { ...r, name: s.name, email: s.email } : r));
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [subjectType, subjectId]);
  useEffect(() => {
    if (!subjectType || subjectId || query.trim().length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => { void signingAdmin<typeof matches>("subject_search", null, { type: subjectType, query }).then(setMatches).catch(() => setMatches([])); }, 250);
    return () => clearTimeout(timer);
  }, [subjectType, subjectId, query]);
  // A template brings its signer roles and settings.
  useEffect(() => {
    if (source !== "template" || !template) return;
    setPeople((rows) => template.roles.map((role, i) => ({ role: role.key, label: role.label, order: role.order, required: role.required, name: rows[i]?.name ?? "", email: rows[i]?.email ?? "" })));
    setMode(template.signing_mode); setExpiry(template.expiry_days); setReminder(template.reminder_days); setTyped({}); setCopyText(null);
    setPayment(templatePayment(template));
  }, [source, template]);
  // A request made from a template gets the template's payment by itself; payment_set after create is only for what the administrator added, changed or removed.
  const asked = source === "template" ? templatePayment(template) : null;

  let variables: string[] = [];
  // TPL-02: the [Variables] of a sectioned template (by their record key) and the [tokens] the signer fills in.
  let bracketVariables: Array<{ name: string; key: string }> = [];
  let signerTokens: string[] = [];
  if (source === "template" && template && !fromApplication) {
    try { variables = templateVariables(template).filter((v) => !["full_name", "email"].includes(v)); } catch { variables = []; }
    if (template.bracket_variables) {
      const texts = [template.title, richPlainText(template.header_html ?? ""), richPlainText(template.body_html ?? template.body ?? ""), richPlainText(template.footer_html ?? "")];
      bracketVariables = variableKeys(texts).filter((v) => !["full_name", "email"].includes(v.key));
      signerTokens = tokenReport(texts).fields;
    }
  }
  const valueOf = (key: string) => typed[key] ?? subject?.values[key] ?? "";
  const values = Object.fromEntries([...variables, ...bracketVariables.map((v) => v.key)].map((v) => [v, valueOf(v)]).filter(([, value]) => value.trim()));
  const setPerson = (index: number, patch: Partial<Person>) => setPeople(people.map((p, i) => i === index ? { ...p, ...patch } : p));
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); } };
  const body = () => ({ recipients: people, signingMode: mode, expiryDays: expiry, reminderDays: reminder, message, ...(subjectType && subjectId ? { subjectType, subjectId } : {}), ...(copyText !== null ? (copyIsHtml ? { html: copyText } : { text: copyText }) : {}) });
  let copyLeft: string[] = [];
  if (copyText !== null) { try { copyLeft = copyIsHtml ? templatePlaceholders(copyText) : signingVariables(copyText); } catch { copyLeft = ["…"]; } }
  const create = () => run(async () => {
    if (source === "upload" && !file) throw new Error("Choose the PDF to send.");
    if (source === "template" && !template) throw new Error("Choose a template.");
    const upload = source === "upload" && file && onLetterhead ? new File([await putPdfOnLetterhead(new Uint8Array(await file.arrayBuffer())) as Uint8Array<ArrayBuffer>], file.name, { type: "application/pdf" }) : file;
    const record = source === "upload" ? await signingAction<SigningRequest>({ action: "create", title, category, ...body() }, upload) : await signingAction<SigningRequest>({ action: "create", templateId, values, ...body() });
    // The function's create does not carry a payment: the database copies the template's; anything else is a second call.
    if (!samePayment(payment, asked)) {
      try {
        const result = await paymentSet(record.id, payment);
        onCreated({ ...record, payment: result?.payment ?? null });
      } catch (e) {
        onCreated(record, `The request was saved ${asked ? `with the template's payment of ${describePayment(asked)}` : "without a payment"}; ${payment ? "setting" : "removing"} the payment failed: ${e instanceof Error ? e.message : "please try again"}.`);
      }
      return;
    }
    onCreated(record);
  });

  if (preview) return <Modal open title="Preview with these values" width="max-w-4xl" onClose={() => setPreview(null)}><p className="mb-3 text-sm text-foreground-600">[name] marks a variable that still has no value.</p><PdfPages source={preview} /></Modal>;
  // A template filled from an application: the Applications offer builder, for this application, with this template chosen.
  if (offerOpen && fromApplication && application) return <OfferLetterDrawer initialTemplateId={templateId}
    application={{ id: application.id, reference: application.reference, studentName: subject?.name ?? preset?.name ?? "", studentId: subjectId,
      course: application.courses[0] ? { title: application.courses[0].title, code: application.courses[0].code } : null, intake: application.intake }}
    onClose={() => setOfferOpen(false)} onSent={() => { if (onOfferSent) onOfferSent(`Offer letter for ${application.reference || "the application"} sent.`); else onClose(); }} />;
  const noTemplates = source === "template" && usable.length === 0 && !templatesLoading;
  return <Modal open title="New signing request" width="max-w-4xl" onClose={() => { if (!busy) onClose(); }}
    footer={fromApplication ? <Button disabled={!application} data-testid="compose-from-application" onClick={() => setOfferOpen(true)}>Prepare the letter from this application</Button>
      : <>{source === "template" && template && <Button variant="outline" disabled={busy} onClick={() => void run(async () => setPreview(pdfBytes(copyText !== null
        ? (await signingAction<{ pdfBase64: string }>({ action: "preview", templateId, values, ...body() })).pdfBase64
        : (await signingAction<{ pdfBase64: string }>({ action: "template_preview", id: templateId, values, ...(subjectType && subjectId ? { subjectType, subjectId } : {}) })).pdfBase64)))}>Preview document</Button>}
      {source === "template" && template?.kind === "text" && copyText === null && <Button variant="outline" disabled={busy} data-testid="edit-copy" onClick={() => void run(async () => { const p = await signingAction<{ text: string; isHtml?: boolean }>({ action: "preview", templateId, values, ...body() }); setCopyIsHtml(Boolean(p.isHtml)); setCopyText(p.text); })}>Edit the text of this copy</Button>}
      <Button disabled={busy} data-testid="continue-to-place-fields" onClick={() => void create()}>{busy ? "Preparing fields…" : "Continue to place fields"}</Button></>}>
    <div className="space-y-5">
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
      <section className="grid gap-4 md:grid-cols-2">
        <Field label="This document is for" hint="Optional. Fills the variables and lists the document on that person's record.">
          <Select value={subjectType} disabled={!!preset} onChange={(e) => { setSubjectType(e.target.value as typeof subjectType); setSubjectId(""); setQuery(""); setTemplateId(""); }}>
            <option value="">Nobody in particular</option><option value="student">A student</option><option value="employee">An employee</option><option value="agent">An agent</option><option value="agency">An agency</option></Select></Field>
        {subjectType && (subjectId ? <div className="text-sm"><p className="mb-1.5 text-label font-medium text-foreground-800">{SUBJECT_LABEL[subjectType]}</p>
          <p className="rounded-md border border-background-300 px-3 py-2">{subject?.name ?? preset?.name ?? "Loading…"}{subject?.email ? ` · ${subject.email}` : ""}{!preset && <button type="button" className="ml-3 text-primary-700 underline" onClick={() => { setSubjectId(""); setSubject(null); }}>Change</button>}</p></div>
          : <div><Field label={`Find the ${SUBJECT_LABEL[subjectType].toLowerCase()}`}><TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder={subjectType === "agency" ? "Business name, ABN or code" : "Name or email"} data-testid="subject-search" /></Field>
            {matches.length > 0 && <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-background-300 text-sm">{matches.map((m) => <li key={m.id}><button type="button" className="block w-full px-3 py-2 text-left hover:bg-background-100" onClick={() => setSubjectId(m.id)}>{m.name} · {m.email}</button></li>)}</ul>}</div>)}
      </section>
      <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="radio" checked={source === "template"} onChange={() => setSource("template")} /> Use existing template</label>
        <label className="flex items-center gap-2"><input type="radio" checked={source === "upload"} onChange={() => { setSource("upload"); setPeople(people.length ? people : [person(1)]); }} /> One-time sign (upload PDF)</label></div>
      {source === "template" ? <>
        <Field label="Template" required><Select value={templateId} disabled={noTemplates} onChange={(e) => setTemplateId(e.target.value)} data-testid="compose-template">
          <option value="">{templatesLoading && !usable.length ? "Loading templates…" : noTemplates ? "No active templates" : "Choose a template"}</option>
          {usable.map((t) => { const locked = needsApplication(t) && !(subjectType === "student" && subjectId);
            return <option key={t.id} value={t.id} disabled={locked}>{t.name} ({SIGN_CATEGORIES[t.category]?.label ?? t.category}){locked ? " — Choose a student first" : ""}</option>; })}</Select></Field>
        {noTemplates ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="compose-no-templates">
          No active templates for {subjectType ? SUBJECT_PLURAL[subjectType] : "signing"} — create one in <a href="/admin/signing/templates" className="font-semibold underline">Templates</a>.</p> : null}
        {fromApplication && <section className="space-y-2 rounded-md border border-background-300 p-3" data-testid="compose-application">
          <p className="text-sm text-foreground-700">{template!.name} is filled from one of {subject?.name ?? "the student"}&apos;s applications (course, intake, fees). It is prepared and sent as an offer letter, exactly as from Applications › Send offer letter.</p>
          <Field label="Application" required>{applications === null ? <p className="text-sm text-foreground-500">Loading the student&apos;s applications…</p>
            : applications.length === 0 ? <p className="text-sm text-amber-800" data-testid="compose-no-applications">This student has no application yet. Start one in Applications first.</p>
            : <Select value={applicationId} onChange={(e) => setApplicationId(e.target.value)} data-testid="compose-application-select"><option value="">Choose an application</option>
              {applications.map((a) => <option key={a.id} value={a.id}>{[a.reference || "Draft", a.courses.map((c) => c.code || c.title).filter(Boolean).join(", "), a.intake ? `Intake ${a.intake}` : "", a.status.replace(/_/g, " ")].filter(Boolean).join(" · ")}</option>)}</Select>}</Field>
        </section>}
        {copyText !== null && <section className="space-y-2"><h3 className="font-semibold">Text of this copy</h3>
          <p className="text-sm text-foreground-600">Changes apply to this request only; the template is not changed. The history records that this copy was edited.</p>
          {copyIsHtml && template?.bracket_variables ? <DocRichTextEditor mode="document" value={copyText} onChange={setCopyText} minHeight={260} label="Body of this copy" />
            : copyIsHtml ? <RichTextEditor value={copyText} onChange={setCopyText} placeholders={[]} minHeight={260} /> : <TextArea rows={10} value={copyText} maxLength={40000} onChange={(e) => setCopyText(e.target.value)} data-testid="copy-text" />}
          {copyLeft.length > 0 && <p role="alert" className="text-sm text-red-700">Still to fill in: {copyLeft.map((k) => `{{${k}}}`).join(", ")}</p>}
          <button type="button" className="text-sm text-primary-700 underline" onClick={() => setCopyText(null)}>Discard my edits</button></section>}
        {variables.length > 0 && copyText === null && <section><h3 className="mb-2 font-semibold">Variables</h3><div className="grid gap-3 md:grid-cols-2">{variables.map((key) => <Field key={key} label={`{{${key}}}`} required hint={subject?.values[key] && typed[key] === undefined ? "Filled from the record. You can correct it here." : undefined}>
          <TextInput value={valueOf(key)} maxLength={2000} onChange={(e) => setTyped({ ...typed, [key]: e.target.value })} /></Field>)}</div></section>}
        {bracketVariables.length > 0 && copyText === null && <section data-testid="compose-bracket-variables"><h3 className="mb-2 font-semibold">Variables</h3><div className="grid gap-3 md:grid-cols-2">{bracketVariables.map(({ name, key }) => <Field key={key} label={`[${name}]`} required hint={subject?.values[key] && typed[key] === undefined ? "Filled from the record. You can correct it here." : undefined}>
          <TextInput value={valueOf(key)} maxLength={2000} onChange={(e) => setTyped({ ...typed, [key]: e.target.value })} data-testid={`bracket-value-${key}`} /></Field>)}</div></section>}
        {signerTokens.length > 0 && <p className="rounded-md border border-background-300 bg-background-50 p-3 text-sm" data-testid="compose-signer-fields">The first signer fills in {signerTokens.map((n) => `[${n}]`).join(", ")} on the signing screen before signing; their initials go wherever [Student Initial] is.</p>}
      </> : <div className="grid gap-4 md:grid-cols-2">
        <Field label="PDF document" required hint={`Up to ${ruleNumber("signing.pdf_upload_max_mib", 7)} MB. This request will not create or change any saved template.`}><input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0])} data-testid="compose-file" /></Field>
        <label className="flex items-center gap-2 text-sm" data-testid="compose-letterhead"><input type="checkbox" className="h-4 w-4" checked={onLetterhead} onChange={(e) => setOnLetterhead(e.target.checked)} data-testid="compose-use-letterhead" />
          <span><span className="font-medium">Put on letterhead</span> <span className="text-xs text-foreground-600">each page is shrunk to fit between the letterhead header and footer (logo, RTO, CRICOS from Website Settings)</span></span></label>
        <Field label="Document title" required><TextInput maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Document type"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(SIGN_CATEGORIES).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}</Select></Field>
      </div>}
      {!fromApplication && <>
      <section className="space-y-3"><h3 className="font-semibold">Recipients</h3>{subjectType === "agency" && <p className="text-sm text-foreground-600" data-testid="compose-agency-recipient">The first signer is the business's agency admin (point of contact); change it here if someone else signs for the business.</p>}
        {people.map((p, i) => <div key={p.role} className="grid items-end gap-2 rounded-md border border-background-300 p-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <Field label={source === "template" ? `${p.label}: full name` : "Full name"} required><TextInput value={p.name} maxLength={150} onChange={(e) => setPerson(i, { name: e.target.value })} data-testid={`recipient-name-${i}`} /></Field>
          <Field label="Email" required><TextInput type="email" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} data-testid={`recipient-email-${i}`} /></Field>
          {source === "upload" ? <Field label="Role"><TextInput value={p.label} maxLength={80} onChange={(e) => setPerson(i, { label: e.target.value })} /></Field> : <p className="pb-2 text-sm text-foreground-600">{p.required ? "Required" : "Optional"} · order {p.order}</p>}
          {source === "upload" && <div className="flex items-center gap-3 pb-2 text-sm"><label className="flex items-center gap-1">Order <input type="number" min={1} max={50} value={p.order} onChange={(e) => setPerson(i, { order: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} className="w-14 rounded border border-background-300 px-2 py-1" /></label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={p.required} onChange={(e) => setPerson(i, { required: e.target.checked })} /> Required</label>
            {people.length > 1 && <button type="button" className="text-red-700 underline" onClick={() => setPeople(people.filter((_, x) => x !== i))}>Remove</button>}</div>}
        </div>)}
        {source === "upload" && people.length < 10 && <Button variant="outline" size="sm" onClick={() => setPeople([...people, person(Math.max(...people.map((p) => Number(p.role.replace(/\D/g, "")) || 0)) + 1)])} data-testid="add-recipient">Add a recipient</Button>}
      </section>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Signing order"><Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} data-testid="compose-mode"><option value="sequential">One after another</option><option value="parallel">Everyone at once</option></Select></Field>
        <Field label="Expires after (days)"><TextInput type="number" min={1} max={365} value={expiry} onChange={(e) => setExpiry(Math.min(365, Math.max(1, Number(e.target.value) || ruleNumber("signing.request_expiry_default", 14))))} /></Field>
        <Field label="Remind every (days)" hint="0 = no reminders"><TextInput type="number" min={0} max={60} value={reminder} onChange={(e) => setReminder(Math.min(60, Math.max(0, Number(e.target.value) || 0)))} /></Field>
      </div>
      <Field label="Message to the recipients" hint="Optional. Included in the invitation email."><TextArea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
      <PaymentPanel key={`${source}:${templateId}`} testId="compose-payment" current={payment} title={(source === "template" ? template?.title : title) || "Payment"} editable busy={busy} onSave={setPayment}>
        <p className="text-foreground-600">{asked ? `This template asks for ${describePayment(asked)}; a change here applies to this request only.` : "The signer pays by card through Stripe (Integrations › Stripe must be connected)."}</p>
      </PaymentPanel>
      </>}
    </div>
  </Modal>;
}
