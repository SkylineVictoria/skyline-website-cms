import { useEffect, useId, useMemo, useState } from "react";
import { ruleNumber, ruleText } from "@/lib/businessRules";
import { Button, Field, Modal, Select, TextInput, Toggle } from "../ui";
import FieldEditor, { type EditorField } from "@/components/signing/FieldEditor";
import PdfPages from "@/components/signing/PdfPages";
import RichTextEditor from "@/pages/admin/components/hrms/TemplateEditor";
import TemplatePreviewDialog from "./TemplatePreviewDialog";
import DocumentSections from "./DocumentSections";
import { LetterTestDialog, UnmappedTokens } from "./LetterTemplateTools";
import { LETTER_CATEGORY, loadLetterRegistry, rehostImagesIn } from "@/lib/offerLetters";
import { APPLICATION_FORM_CATEGORY, APPLICATION_FORM_TOKENS, DEFAULT_APPLICATION_FORM_TEMPLATE, unknownApplicationFormTokens } from "../../../../../supabase/functions/_shared/notification/application-form";
import { previewApplicationForm } from "@/pages/agency/lib/applicationPdf";
import { supabase } from "@/pages/admin/lib/supabase";
import { unmappedTokens, type LetterVariable } from "../../../../../supabase/functions/_shared/letter-variables";
import { isTemplateAsset } from "../../../../../supabase/functions/_shared/rich-html";
import { sectionsReport } from "@/lib/templateSections";
import { richPlainText, sanitizeRichHtml } from "../../../../../supabase/functions/_shared/rich-html";
import { docxText, listTemplateParts, paymentDraft, pdfBytes, signingAction, signingAdmin, templatePayment, validatePayment, type PaymentDraft, type SigningRole, type SigningTemplate, type TemplateField } from "@/lib/signingApi";
import { PaymentFields } from "./PaymentForm";
import { SIGN_CATEGORIES, SUBJECT_VARIABLES, signingVariables } from "../../../../../supabase/functions/_shared/signing";
import {
  PLACEHOLDERS, TEMPLATE_TYPES, isTemplateType, placeholderLabels, placeholdersFor, sanitizeTemplateHtml, templatePlaceholders, templateText, textToHtml,
  type PlaceholderSpec, type TemplateType,
} from "../../../../../supabase/functions/_shared/hr-template";

type Kind = "text" | "email" | "pdf";
type Draft = Pick<SigningTemplate, "name" | "title" | "audience" | "category" | "signing_mode" | "expiry_days" | "reminder_days" | "roles" | "fields">
  & { id: string | null; kind: Kind; body_html: string; header_html: string; footer_html: string; subject: string; source_pages: number | null; version: number }
  /** Stripe payment the signer is asked for (amount typed in dollars). */
  & { payment_enabled: boolean; payment: PaymentDraft };
const NO_PAYMENT = { payment_enabled: false, payment: paymentDraft(null) };
const paymentOf = (template: SigningTemplate) => ({ payment_enabled: Boolean(template.payment_enabled), payment: paymentDraft(templatePayment(template)) });
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const SENDER = "sender";
const EMAIL_TYPES = TEMPLATE_TYPES.filter((t) => t.kind === "email");
const blank = (kind: Kind = "text", category = "offer_letter"): Draft => ({
  id: null, name: "", title: "", body_html: "<p></p>", header_html: "", footer_html: "", subject: "", kind, audience: kind === "email" || category === "offer_letter" ? "employee" : "any", category,
  // Business Rules signing.default_signer_order / signing.request_expiry_default / signing.request_reminder_default.
  signing_mode: ruleText("signing.default_signer_order", "Sequential").toLowerCase().startsWith("parallel") ? "parallel" : "sequential",
  expiry_days: ruleNumber("signing.request_expiry_default", 14), reminder_days: ruleNumber("signing.request_reminder_default", 3), roles: [{ key: "signer1", label: "Signer", order: 1, required: true }], fields: [], source_pages: null, version: 0, ...NO_PAYMENT,
});
const roleKey = (label: string, taken: string[]) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 30) || "signer";
  let key = base, n = 2; while (taken.includes(key) || key === SENDER) key = `${base}_${n++}`;
  return key;
};
/** The variables a record fills by itself, as placeholder cards beside the editor. */
const RECORD_GROUP: Record<string, PlaceholderSpec["group"]> = { student: "Student", employee: "Employee record", agent: "Agent", agency: "Agency" };
function recordPlaceholders(audience: SigningTemplate["audience"]): PlaceholderSpec[] {
  const kinds = audience === "any" ? (["student", "employee", "agent", "agency"] as const) : [audience];
  const seen = new Set<string>();
  const out: PlaceholderSpec[] = [];
  for (const kind of kinds) for (const key of SUBJECT_VARIABLES[kind]) {
    if (seen.has(key)) continue; seen.add(key);
    const label = key.replace(/^(student|employee|agent|agency|course)\./, "").replaceAll("_", " ");
    out.push({ key, label: key === "current_date" ? "Today's date" : label.charAt(0).toUpperCase() + label.slice(1), sample: `[${key}]`, group: key === "current_date" ? "Document" : RECORD_GROUP[kind] });
  }
  return out;
}
/** The input is both the search box and the editable name. Only saved templates contribute suggestions. */
function TemplateNamePicker({ name, names, onChange, onSelect }: {
  name: string; names: string[]; onChange: (name: string) => void; onSelect: (name: string) => void;
}) {
  const id = useId();
  const input = () => document.getElementById(id) as HTMLInputElement | null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [addingName, setAddingName] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const query = search.trim().toLowerCase();
  const newName = name.trim();
  const matches = names.filter((value) => value.toLowerCase().includes(query));
  const canAdd = Boolean(newName) && !names.some((value) => value.toLowerCase() === newName.toLowerCase());
  const addChoice = { value: null, label: canAdd ? `+ Add new: ${newName}` : "+ Add new" };
  const choices = [addChoice, ...matches.map((value) => ({ value, label: value }))];

  const show = () => { setSearch(""); setHighlight(-1); setOpen(true); };
  const choose = (value: string | null) => {
    if (value === null && !canAdd) {
      input()?.focus();
      input()?.select();
      setAddingName(true);
      show();
      return;
    }
    onSelect(value ?? newName);
    input()?.focus();
    setAddingName(false);
    setOpen(false);
  };

  return <div className="min-w-0" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setAddingName(false); setOpen(false); } }}>
    <label htmlFor={id} className="mb-1.5 block text-label font-medium text-foreground-800">Template name <span aria-hidden="true" className="text-primary-600">*</span></label>
    <div className="relative">
      <TextInput id={id} inputMode="search" role="combobox" aria-required="true" aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined} aria-autocomplete="list"
        aria-activedescendant={open && choices[highlight] ? `${id}-option-${highlight}` : undefined}
        className="pr-11 !text-base md:!text-sm" value={name} maxLength={120} placeholder={addingName ? "Enter a new template name" : "Search or add a template name"} autoComplete="off"
        onFocus={show} onClick={() => { if (!open) show(); }}
        onChange={(event) => {
          onChange(event.target.value);
          setSearch(event.target.value);
          setHighlight(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setAddingName(false); setOpen(false); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else {
              const next = event.key === "ArrowDown" ? (highlight + 1) % choices.length : (highlight <= 0 ? choices.length - 1 : highlight - 1);
              setHighlight(next);
              document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: "nearest" });
            }
          }
          if (event.key === "Enter" && open) {
            event.preventDefault();
            if (choices[highlight]) choose(choices[highlight].value);
            else if (canAdd) choose(null);
          }
        }} data-testid="template-name" />
      <button type="button" tabIndex={-1} aria-label={open ? "Hide template names" : "Show template names"} className="absolute inset-y-0 right-0 w-11"
        onMouseDown={(event) => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { input()?.focus(); show(); } }}>
        <i className="ri-arrow-down-s-line" aria-hidden="true" />
      </button>
    </div>
    {open && <div className="mt-1 rounded-md border border-background-300 bg-background-50 shadow-sm">
      <div id={`${id}-options`} role="listbox" aria-label="Template names" className="max-h-48 overflow-y-auto">
        {choices.map(({ value, label }, index) => <button key={value === null ? "add-name" : `name:${value}`} id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1}
          aria-selected={highlight === -1 ? value === name : highlight === index}
          className={`block min-h-10 w-full break-words px-3 py-2 text-left text-sm hover:bg-background-100 ${value === null ? "font-medium text-primary-700" : ""} ${highlight === index ? "bg-background-200" : ""}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(value)}>{label}</button>)}
      </div>
    </div>}
  </div>;
}

/**
 * One editor for every template (the one table since 20261113170000): a letter or document to sign (rich text with placeholders, or a
 * ready-made PDF), or an email. Signer roles, placed fields, expiry and reminders apply to documents; a default per kind; versions.
 */
export default function TemplateEditor({ template, onClose, onSaved, newKind = "text", newCategory, audience, savedTemplates, lockCategory = false, separateLetterTitle = false }: {
  template: SigningTemplate | null; onClose: () => void; onSaved: (message: string, id?: string) => void; newKind?: Kind; newCategory?: string;
  audience?: SigningTemplate["audience"];
  savedTemplates: SigningTemplate[];
  lockCategory?: boolean;
  separateLetterTitle?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => template
    ? { ...template, id: template.id, kind: template.kind, body_html: template.body_html?.trim() ? template.body_html : textToHtml(template.body ?? ""), header_html: template.header_html ?? "", footer_html: template.footer_html ?? "", subject: template.subject ?? (template.kind === "email" ? template.title : ""), ...paymentOf(template) }
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
  /** APPLICATION-FORM-TEMPLATES: how a signed application is printed; its own {{variables}} (answers, declarations, signatures blocks). */
  const afm = draft.category === APPLICATION_FORM_CATEGORY;
  const afmVariables = useMemo<LetterVariable[]>(() => APPLICATION_FORM_TOKENS.map((t) => ({
    key: t.key, group: t.key.startsWith("institute.") ? "Institute" : t.key.startsWith("page.") ? "Page" : t.key.startsWith("student.") ? "Student" : t.key.startsWith("course.") ? "Course" : "Application",
    label: t.label, description: t.description, sourceKind: "render", source: "", format: t.key === "institute.logo" ? "image" : "text", inputType: "text", required: false, editableSource: false, aliases: [], sample: t.sample,
  })), []);
  const [afmPreview, setAfmPreview] = useState<{ ask: boolean; reference: string } | null>(null);
  useEffect(() => { if (loo && !registry) void loadLetterRegistry().then(setRegistry, (e: Error) => setError(e.message)); }, [loo, registry]);
  // A new Application form starts as the standard form (letterhead, title band, sections, signature, footer); everything stays editable.
  useEffect(() => {
    if (template || !afm || draft.header_html.trim() || draft.footer_html.trim()) return;
    setDraft((d) => ({ ...d, name: d.name || "Application for Enrolment", title: d.title || DEFAULT_APPLICATION_FORM_TEMPLATE.title, audience: "student",
      header_html: DEFAULT_APPLICATION_FORM_TEMPLATE.header_html ?? "", body_html: DEFAULT_APPLICATION_FORM_TEMPLATE.body_html, footer_html: DEFAULT_APPLICATION_FORM_TEMPLATE.footer_html ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when a new application form opens
  }, [template, afm]);
  // HOUSE-STYLE: a new document template starts with the house letterhead and footer presets (both stay editable).
  useEffect(() => {
    if (template || loo || afm || draft.kind !== "text" || isTemplateType(draft.category) || draft.header_html.trim() || draft.footer_html.trim()) return;
    let active = true;
    void listTemplateParts().then((parts) => {
      const header = parts.find((p) => p.kind === "header" && p.name === "SLIT house letterhead")?.html ?? "";
      const footer = parts.find((p) => p.kind === "footer" && p.name === "SLIT house footer")?.html ?? "";
      if (active && (header || footer)) setDraft((d) => (d.header_html.trim() || d.footer_html.trim() ? d : { ...d, header_html: header, footer_html: footer }));
    }, () => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when a new document template opens
  }, [template, loo, afm, draft.kind]);
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
  const useNameAsTitle = draft.kind !== "email" && !(separateLetterTitle && hrms);
  const documentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of savedTemplates) {
      if (item.kind === "email") continue;
      const name = item.name.trim();
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    return [...names.values()];
  }, [savedTemplates]);
  const setDocumentName = (name: string) => set({ name, title: name });
  const chooseDocumentName = (name: string) => {
    // Existing templates and explicit entry points (unit documents and the offer-letter drawer) keep their category.
    const categories = new Set(savedTemplates.filter((item) => item.kind !== "email"
      && item.name.trim().toLowerCase() === name.toLowerCase()
      && (draft.kind !== "pdf" || item.category !== LETTER_CATEGORY)
      && (!audience || SIGN_CATEGORIES[item.category]?.audience === audience || item.category === "other"))
      .map((item) => item.category));
    const category = !template && !lockCategory && categories.size === 1 ? [...categories][0] : draft.category;
    set({ name, title: name, category });
  };
  const changeKind = (kind: Kind) => {
    if (kind === draft.kind) return;
    if (kind === "email") {
      set({ kind, fields: [], audience: "employee", category: "offer_email" });
      return;
    }
    const presetCategory = newCategory && !EMAIL_TYPES.some((type) => type.type === newCategory) ? newCategory : "offer_letter";
    const category = draft.kind === "email" || (draft.kind === "pdf" && draft.category === "other" && presetCategory === LETTER_CATEGORY)
      ? presetCategory : draft.category;
    set({
      kind, fields: [], audience: draft.kind === "email" ? audience ?? blank(kind, category).audience : draft.audience,
      title: separateLetterTitle && isTemplateType(category) ? draft.title : draft.name,
      category: kind === "pdf" && category === LETTER_CATEGORY ? "other" : category,
    });
  };
  const signed = draft.kind !== "email" && !loo && !afm;
  // Stripe: every document template (text or PDF, students, agents or units) can ask for a payment; HRMS letters and emails cannot.
  const payable = draft.kind !== "email" && !hrms && !afm;
  const paymentSection = (compact: boolean) => <section className="space-y-3 rounded-md border border-background-300 p-3" data-testid="template-payment">
    <div className={`flex gap-3 ${compact ? "flex-col" : "flex-wrap items-center justify-between"}`}>
      <div className="text-sm"><p className="font-semibold">Payment</p>{!compact && <p className="text-foreground-600">Ask the signer to pay by card through Stripe (Integrations › Stripe must be connected). Each request made from this template starts with this payment; it can be changed or removed per request.</p>}</div>
      <Toggle checked={draft.payment_enabled} label="Require payment" onChange={(payment_enabled) => set({ payment_enabled })} />
    </div>
    {draft.payment_enabled && <PaymentFields compact={compact} testId="template-payment" value={draft.payment} onChange={(payment) => set({ payment })} />}
  </section>;
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
    ...(sections ? { header_html: sanitizeRichHtml(draft.header_html), footer_html: sanitizeRichHtml(draft.footer_html), bracket_variables: !loo && !afm } : {}), audience: loo || afm ? "student" : draft.audience, category: draft.category,
    signing_mode: draft.signing_mode, expiry_days: draft.expiry_days, reminder_days: draft.reminder_days, roles: draft.roles, fields: signed ? draft.fields : [],
    // Stripe: { enabled: false } switches the payment off; absent would leave the saved settings unchanged.
    payment: payable && draft.payment_enabled
      ? { enabled: true, amount: Number(draft.payment.amount), currency: draft.payment.currency.trim().toLowerCase(), description: draft.payment.description.trim(), timing: draft.payment.timing }
      : { enabled: false },
  });
  /** The same checks the database makes (hr.template_problem for letters and emails; the signing variable rules for the rest). */
  const check = () => {
    if (!draft.name.trim()) throw new Error("Give the template a name.");
    if (draft.kind === "email" ? !draft.subject.trim() : !draft.title.trim()) throw new Error(draft.kind === "email" ? "Enter the email subject." : hrms ? "Give the letter a title." : "Enter a document title.");
    if (draft.kind === "pdf") { if (!draft.id && !file) throw new Error("Choose the PDF for this template."); }
    else if (sections ? !richPlainText(html).trim() : !html.replace(/<[^>]*>|&nbsp;|\s/g, "")) throw new Error("The template has no text yet.");
    if (signed && draft.roles.some((r) => !r.label.trim())) throw new Error("Give every signer a role name.");
    if (payable && draft.payment_enabled) validatePayment(draft.payment);
    const text = draft.kind === "pdf" ? "" : html;
    if (hrms && spec) {
      const allowed = new Set([...placeholdersFor(draft.category as TemplateType).map((p) => p.key), ...(draft.kind === "email" ? [] : recordPlaceholders(draft.audience).map((p) => p.key))]);
      const unknown = templatePlaceholders(`${draft.kind === "email" ? draft.subject : draft.title} ${text}`).filter((k) => !allowed.has(k) && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(k));
      if (unknown.length) throw new Error(`${unknown.map((k) => `{{${k}}}`).join(", ")} cannot be used in this kind of template. Use the list on the right.`);
      const missing = spec.requires.filter((k) => !templatePlaceholders(text).includes(k));
      if (missing.length) throw new Error(`This email must contain ${missing.map((k) => `{{${k}}}`).join(" and ")} (${placeholderLabels(missing)}).`);
    }
    if (afm) {
      const unknown = unknownApplicationFormTokens(draft.title, draft.header_html, draft.body_html, draft.footer_html);
      if (unknown.length) throw new Error(`${unknown.map((k) => `{{${k}}}`).join(", ")} is not an application form variable. Use the variables listed in the editor.`);
      if (!/\{\{\s*application\.answers\s*\}\}/.test(draft.body_html)) throw new Error("The body must contain {{application.answers}}: it prints the student's answers.");
      if (!/\{\{\s*application\.signatures\s*\}\}/.test(draft.body_html)) throw new Error("The body must contain {{application.signatures}}: it prints the signature.");
    } else if (!loo) signingVariables([draft.title, text, ...draft.fields.filter((f) => f.role === SENDER).map((f) => f.value ?? "")].join("\n"));
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
    if (sections && !loo && !afm && !confirmed) { setConfirming(sectionsReport(draft, draft.title)); return; }
    setConfirming(null); setLetterCheck(false);
    const saved = draft.kind === "pdf" && file ? await signingAction<{ id?: string } | null>({ action: "template_upload", id: draft.id, template: payload() }, file)
      : await signingAdmin<{ id?: string } | null>("template_save", draft.id, payload());
    onSaved((draft.id ? "The template was saved as a new version." : "The template was added.") + (loo && unmapped.length ? " It is inactive until every variable is mapped." : "")
      + (afm ? " Applications already signed keep the form they were signed with; use Make default to print new ones with it." : ""), saved?.id ?? draft.id ?? undefined);
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
    <FieldEditor source={placing} owners={owners} fields={editorFields} onChange={(fields) => set({ fields: fromEditor(fields) })} panel={payable ? paymentSection(true) : undefined} />
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
  if (afmPreview?.ask) return <Modal open title="Test with an application" onClose={() => setAfmPreview(null)}
    footer={<><Button variant="outline" onClick={() => setAfmPreview(null)}>Cancel</Button>
      <Button disabled={busy || !afmPreview.reference.trim()} data-testid="application-form-test-run" onClick={() => void run(async () => {
        const { data, error: e } = await supabase.from("enrollment_applications").select("id").eq("reference", afmPreview.reference.trim()).maybeSingle();
        if (e || !data) throw new Error("No application has that reference.");
        setPreview(await previewApplicationForm({ title: draft.title, header_html: draft.header_html, body_html: draft.body_html, footer_html: draft.footer_html }, String(data.id)));
        setAfmPreview(null);
      })}>{busy ? "Preparing…" : "Show the PDF"}</Button></>}>
    <Field label="Application reference" hint="A submitted application, for example SLIT-2026-0148. Nothing is saved or sent.">
      <TextInput value={afmPreview.reference} onChange={(e) => setAfmPreview({ ask: true, reference: e.target.value })} data-testid="application-form-test-reference" /></Field>
    {error && <p role="alert" className={ALERT}>{error}</p>}
  </Modal>;
  if (previewWith && hrms) return <TemplatePreviewDialog template={{ id: draft.id, type: draft.category as TemplateType, name: draft.name, subject: draft.kind === "email" ? draft.subject : draft.title, bodyHtml: html }} onClose={() => setPreviewWith(false)} />;

  return <Modal open title={template ? `Edit ${kindLabel} (version ${draft.version})` : `New ${kindLabel}`} width="max-w-5xl" onClose={() => { if (!busy) onClose(); }}
    footer={<div className="flex w-full flex-wrap justify-end gap-2">
      {hrms && draft.kind !== "pdf" && <Button variant="outline" disabled={busy} onClick={() => setPreviewWith(true)} data-testid="template-draft-preview">Preview with an employee's details</Button>}
      {afm ? <>
        <Button variant="outline" disabled={busy} data-testid="application-form-preview-sample" onClick={() => void run(async () => {
          setPreview(await previewApplicationForm({ title: draft.title, header_html: draft.header_html, body_html: draft.body_html, footer_html: draft.footer_html }, null)); })}>Preview with sample application</Button>
        <Button variant="outline" disabled={busy} data-testid="application-form-test-open" onClick={() => setAfmPreview({ ask: true, reference: "" })}>Test with application</Button>
      </> : loo ? <>
        <Button variant="outline" disabled={busy || !registry} onClick={() => setLetterTest("sample")} data-testid="letter-preview-sample">Preview with sample application</Button>
        <Button variant="outline" disabled={busy || !registry} onClick={() => setLetterTest("application")} data-testid="letter-test-application-open">Test with application</Button>
      </> : draft.kind !== "email" && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { check(); const source = await documentSource(); setPreview(typeof source === "string" ? new Uint8Array(await (await fetch(source)).arrayBuffer()) : source); })}>Preview the PDF</Button>}
      <span className="flex-1" />
      <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button disabled={busy} onClick={() => void save()} data-testid="template-save">{busy ? "Saving…" : "Save template"}</Button></div>}>
    <div className="space-y-5" data-testid="template-dialog">
      {error && <p role="alert" className={ALERT} data-testid="template-error">{error}</p>}
      {draft.kind !== "email" && <div className="rounded-md border border-background-300 bg-background-100 px-3 py-2 text-sm" data-testid="template-used-for"><span className="text-foreground-600">Used for: </span><span className="font-semibold text-foreground-900">{({ student: "Students", employee: "Employees", agent: "Agents", agency: "Agencies / Businesses", any: "Anyone" } as const)[loo ? "student" : draft.audience]}</span></div>}
      {afm && <p className="rounded-md border border-background-300 bg-background-100 px-3 py-2 text-sm text-foreground-700" data-testid="application-form-help">This form prints a signed application: the PDF the student, the agent and SLIT admissions get and keep. {"{{application.answers}}"} prints every answer, {"{{application.declarations}}"} the declarations as agreed, {"{{application.signatures}}"} the signature. Each save is a new version; an application keeps the version it was signed with.</p>}
      {!template && !afm && <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Kind of template">
        <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "text"} onChange={() => changeKind("text")} /> Letter or document to sign (rich text with placeholders)</label>
        {audience !== "agent" && <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "email"} onChange={() => changeKind("email")} /> Email</label>}
        <label className="flex items-center gap-2"><input type="radio" checked={draft.kind === "pdf"} onChange={() => changeKind("pdf")} /> A ready-made PDF</label>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        {useNameAsTitle
          ? <TemplateNamePicker name={draft.name} names={documentNames} onChange={setDocumentName} onSelect={chooseDocumentName} />
          : <Field label="Template name" required hint="Only Admins see this."><TextInput value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} data-testid="template-name" /></Field>}
        {draft.kind === "email" && <>
          <Field label="Email subject" required hint="Placeholders work here too."><TextInput value={draft.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} data-testid="template-subject" /></Field>
          <Field label="Kind of email"><Select value={draft.category} disabled={Boolean(template)} onChange={(e) => set({ category: e.target.value, audience: "employee" })} data-testid="template-category">
            {EMAIL_TYPES.map((type) => <option key={type.type} value={type.type}>{type.label}</option>)}
          </Select></Field>
        </>}
        {separateLetterTitle && draft.kind !== "email" && hrms && <Field label="Letter title" required hint="Placeholders work here too."><TextInput value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} data-testid="template-subject" /></Field>}
        
      </div>
      {spec && <p className="text-sm text-foreground-600">{spec.description}</p>}
      {loo && registry && unmapped.length ? <UnmappedTokens template={letterParts()} registry={registry} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} /> : null}
      {sections ? <DocumentSections value={{ header_html: draft.header_html, body_html: draft.body_html, footer_html: draft.footer_html }} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onError={setError}
        storageImages {...(loo ? { letterVariables: registry ?? [] } : afm ? { letterVariables: afmVariables } : {})} />
      : draft.kind !== "pdf" ? <div className="space-y-2">
        <RichTextEditor key={draft.id ?? `new-${draft.kind}`} value={draft.body_html} onChange={(body_html) => setDraft((d) => ({ ...d, body_html }))} placeholders={placeholders} />
        <div className="flex flex-wrap items-center gap-4 text-xs text-foreground-600">
          {hrms && <span>A line that only holds an optional detail (department, hours per week, reporting manager, work location) is left out for a person who does not have it.</span>}
          {spec?.requires.length ? <span>This email must contain {spec.requires.map((k) => `{{${k}}}`).join(" and ")}: it is the link the person uses.</span> : null}
          {draft.kind === "text" && !sections && <label className="flex items-center gap-2">Import a Word document (.docx): <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-testid="docx-input"
            onChange={(e) => { const chosen = e.target.files?.[0]; if (chosen) void run(async () => { set({ body_html: textToHtml(await docxText(chosen)) }); }); }} /></label>}
        </div>
      </div> : <Field label={draft.id ? `PDF (${draft.source_pages ?? "?"} pages). Choose a file only to replace it` : "PDF document"} required={!draft.id} hint={`Up to ${ruleNumber("signing.pdf_upload_max_mib", 7)} MB, not password-protected. Variables are printed with Sender fields placed on the pages.`}>
        <input type="file" accept="application/pdf" data-testid="template-pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) set({ fields: draft.id ? draft.fields : [] }); }} /></Field>}

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
      {payable && paymentSection(false)}
      {versions && versions.length > 0 && <section><h3 className="mb-2 font-semibold">Versions</h3>
        <ul className="space-y-1 text-sm">{versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-3">Version {v.version} · {new Date(v.created_at).toLocaleString()} · {v.name}
          {v.version !== draft.version && <button type="button" className="text-primary-700 underline" disabled={busy} onClick={() => void run(async () => { await signingAdmin("template_restore", draft.id, { version: v.version }); onSaved(`Version ${v.version} restored as a new version.`); })}>Restore</button>}</li>)}</ul></section>}
    </div>
  </Modal>;
}
