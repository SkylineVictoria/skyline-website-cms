import { useEffect, useMemo, useState } from "react";
import ActionDrawer, { ConfirmDialog } from "./ActionDrawer";
import SegmentedControl from "@/components/shared/application-form/SegmentedControl";
import { DocumentRow, Dropzone, RowAction } from "@/components/shared/application-form/DocumentUpload";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import LetterPreview, { VariableCheck, type BuiltLetter } from "@/components/shared/offer-letter/LetterPreview";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import {
  applicationCourses, courseMeta, expandFor, issueTemplateLetter, letterValues, loadLetterRegistry, loadLetterTemplates, saveLetterValueToSource, setCourseDiscount, toBase64,
  type ApplicationCourse, type LetterTemplate, type LetterValues, type OfferDepositInput,
} from "@/lib/offerLetters";
import { baseKey, blockingDetails, courseIndexOf, formatTyped, letterKeys, missingDetails, withChargeValues, withCourseValues, type LetterValue, type LetterVariable, type ManualFill } from "../../../../supabase/functions/_shared/letter-variables";
import { formatMoney } from "@/lib/signingApi";

/** The fee variables of the Fees section, in the letter's order (the total and the discount lines are calculated, never typed). */
const FEE_ORDER = ["fees.application", "fees.enrolment", "fees.registration", "fees.material", "fees.oshc", "fees.tuition", "fees.deposit"] as const;
import { CcAgent } from "./CcAgent";
import { sendCc, useCcDefault } from "@/lib/ccAgent";
import { saveOfferSigningLayout } from "@/lib/offerSigningLayout";
import { issueOfferLetter, offerLetterRecipient, type OfferRecipient } from "@/pages/agency/lib/portalApplications";

const MAX_BYTES = 3 * 1024 * 1024;
const INPUT = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

export interface OfferApplication {
  id: string;
  reference: string;
  studentName: string;
  studentId: string | null;
  course?: { title: string; code: string } | null;
  intake?: string;
}

/** What staff typed for one missing detail (the input as typed; printed formatted). */
interface Entry { input: string; mode: "letter" | "source" | "blank"; saved?: boolean }


/**
 * Issue offer letter. From a template: every {{variable}} is resolved from the application, its course / intake, the fee setup, the
 * agent / agency and the institute (application_letter_values); the letter is shown as the PDF that will be sent (A4, header and footer
 * on every page, page numbers). Missing details are listed in "Needs your input" with where they come from and an input each: fill for
 * this letter only, fill and save to the source (confirmed, only where allowed), or leave an optional one blank with a tick. Their
 * yellow marks in the preview focus the input. Send stays disabled ("Send (2 details missing)") until nothing blocks; a final check
 * lists what was filled by hand, and the database checks it all again. Or upload a ready-made PDF.
 */
export default function OfferLetterDrawer({ application, onClose, onSent, reviewIssues = 0 }: { application: OfferApplication; onClose: () => void; onSent: () => void; reviewIssues?: number }) {
  const [mode, setMode] = useState<"template" | "upload">("template");
  const [recipient, setRecipient] = useState<OfferRecipient | null>(null);
  const [registry, setRegistry] = useState<LetterVariable[] | null>(null);
  const [templates, setTemplates] = useState<LetterTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [values, setValues] = useState<LetterValues | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [conditions, setConditions] = useState("");
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [letter, setLetter] = useState<BuiltLetter | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmSource, setConfirmSource] = useState<{ key: string; variable: LetterVariable } | null>(null);
  // CC: the agent (or the agency's main email) gets a copy, on by default; recorded in the status history.
  const cc = useCcDefault(application.id);
  const [ccOn, setCcOn] = useState(true);
  const [finalCheck, setFinalCheck] = useState(false);
  // The application's course rows, for the discount each one carries into the letter (saved with application_course_discount_set).
  const [appCourses, setAppCourses] = useState<ApplicationCourse[] | null>(null);
  const [discountDraft, setDiscountDraft] = useState<Record<string, string>>({});
  // OFFER-DEPOSIT: the initial deposit the student pays through Stripe after signing: on by default; its amount is the letter's fees.deposit (one source).
  const [payOn, setPayOn] = useState(true);
  const [payNote, setPayNote] = useState("");

  useEffect(() => {
    void offerLetterRecipient(application.id).then(setRecipient, (e: Error) => setError(e.message));
    void loadLetterRegistry().then(setRegistry, (e: Error) => setError(e.message));
    void letterValues(application.id).then(setValues, (e: Error) => setError(e.message));
    void applicationCourses(application.id).then(setAppCourses, () => setAppCourses([]));
    reloadTemplates();
  }, [application.id]);
  /** The application course row behind the n-th course of the letter values (by its id, else by order). */
  const courseRowFor = (course: Record<string, LetterValue>, n: number): ApplicationCourse | undefined => {
    const id = String(courseMeta(course)._courseId ?? "");
    return appCourses?.find((r) => r.id === id || r.courseId === id) ?? appCourses?.[n];
  };
  const saveDiscount = async (row: ApplicationCourse) => {
    const typed = discountDraft[row.id];
    if (typed === undefined) return;
    const percent = Number(typed);
    if (!typed.trim() || !Number.isFinite(percent) || percent < 0 || percent > 100) { setError("Enter a discount between 0 and 100 percent."); return; }
    if (Math.abs(percent - row.discountPercent) < 0.001) { setDiscountDraft((d) => { const next = { ...d }; delete next[row.id]; return next; }); return; }
    setBusy(`discount-${row.id}`); setError("");
    try {
      await setCourseDiscount(row.id, percent);
      const [rows, next] = await Promise.all([applicationCourses(application.id), letterValues(application.id)]);
      setAppCourses(rows); setValues(next); setLetter(null);
      setDiscountDraft((d) => { const draft = { ...d }; delete draft[row.id]; return draft; });
    } catch (e) { setError(e instanceof Error ? e.message : "The discount could not be saved."); }
    finally { setBusy(""); }
  };
  /** Keep the selected template if it is still available. */
  function reloadTemplates() {
    setTemplates(null);
    void loadLetterTemplates().then((list) => {
      const usable = list.filter((t) => t.active).sort((a, b) => a.name.localeCompare(b.name));
      setTemplates(usable);
      setTemplateId((prev) => (prev && usable.some((t) => t.id === prev) ? prev : ""));
    }, (e: Error) => { setTemplates([]); setError(e.message); });
  }

  const template = templates?.find((t) => t.id === templateId) ?? null;
  const used = template ? { title: template.title, headerHtml: template.headerHtml, bodyHtml: bodyEdit ?? template.bodyHtml, footerHtml: template.footerHtml } : null;
  // Packaged offers: the course and fee variables of every course (key#n for the 2nd, 3rd... course).
  const flat = useMemo(() => (values ? withChargeValues(withCourseValues(values.values, values.courses), values.charges) : {}), [values]);
  const usedHtml = used ? expandFor(`${used.title}\n${used.headerHtml ?? ""}\n${used.bodyHtml ?? ""}\n${used.footerHtml ?? ""}`, values?.courses, values?.charges, Boolean(values?.context.gst)) : "";
  const dateFormat = values?.context.dateFormat ?? "DD/MM/YYYY";

  const missing = useMemo(() => (registry && values ? missingDetails(usedHtml, registry, flat) : []), [registry, values, usedHtml, flat]);
  // A detail saved to its source is no longer missing; the record of it stays for the history.
  const manual: ManualFill[] = useMemo(() => Object.entries(entries).flatMap(([key, e]): ManualFill[] => {
    const variable = registry?.find((v) => v.key === baseKey(key));
    if (!variable) return [];
    if (e.mode === "source") return e.saved ? [{ key, value: flat[key]?.value ?? "", mode: "source" }] : [];
    if (e.mode === "blank") return [{ key, value: "", mode: "blank" }];
    const value = formatTyped(variable, e.input, dateFormat);
    return value ? [{ key, value, mode: "letter" }] : [];
  }), [entries, registry, flat, dateFormat]);
  const blocking = blockingDetails(missing, manual);
  // OFFER-FEES: the first course's fee variables are one editable section (prefilled from LMS: the intake's fee lines, else the course's, else
  // the fee setup), so they never sit in "Needs your input"; a fee of a 2nd, 3rd... course (key#n) still does. The total is calculated.
  const isFeeKey = (key: string) => baseKey(key).startsWith("fees.");
  const usedKeys = useMemo(() => new Set(letterKeys(usedHtml)), [usedHtml]);
  const feeKeys = FEE_ORDER.filter((k) => usedKeys.has(k));
  const rawCents = (key: string): number | null => { const raw = flat[key]?.raw ?? ""; return /^-?[0-9]+(\.[0-9]+)?$/.test(raw) ? Math.round(Number(raw) * 100) : null; };
  const typedCents = (key: string): number | null => {
    const e = entries[key];
    if (!e || e.mode !== "letter" || !e.input.trim()) return null;
    const n = Number(e.input.replace(/^(AUD)?\$?\s*/i, "").replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  };
  /** What the letter prints for a fee: typed for this letter, else the LMS value (a blank left on purpose prints nothing). */
  const feeCents = (key: string): number | null => (entries[key]?.mode === "blank" ? null : typedCents(key) ?? rawCents(key));
  const discountPct = Number(String(values?.courses?.[0]?.["fees.discount_percent"]?.raw ?? values?.values["fees.discount_percent"]?.raw ?? "0").replace("%", "")) || 0;
  // The lines in the total, as LMS counts them: application (or enrolment), registration, material and tuition; the deposit and OSHC are not.
  const totalKeys = ["fees.registration", "fees.material", "fees.tuition", usedKeys.has("fees.application") || !usedKeys.has("fees.enrolment") ? "fees.application" : "fees.enrolment"];
  const discountOf = (tuition: number | null) => (tuition != null && discountPct > 0 ? Math.round(tuition * discountPct / 100) : 0);
  const sumOf = (get: (k: string) => number | null): number | null => { const tuition = get("fees.tuition"); if (tuition == null) return null; return totalKeys.reduce((s, k) => s + (get(k) ?? 0), 0) - discountOf(tuition); };
  // Other fee lines LMS counts (e.g. "other" lines) that this section does not show: the LMS total less the lines it does show.
  const otherLinesCents = (() => { const db = rawCents("fees.total"); const f = sumOf(rawCents); return db != null && f != null ? db - f : 0; })();
  const feesOverridden = feeKeys.some((k) => typedCents(k) != null || entries[k]?.mode === "blank");
  const totalCents = feesOverridden ? (() => { const f = sumOf(feeCents); return f == null ? null : f + otherLinesCents; })() : rawCents("fees.total");
  const tuitionCents = feeCents("fees.tuition");
  const discountCents = discountOf(tuitionCents);
  // The calculated lines follow the typed fees: total, and the discount lines when a discount applies.
  useEffect(() => {
    setEntries((prev) => {
      const next = { ...prev }; let changed = false;
      const sync = (key: string, cents: number | null) => {
        if (feesOverridden && cents != null) { const input = (cents / 100).toFixed(2); if (prev[key]?.input !== input || prev[key]?.mode !== "letter") { next[key] = { input, mode: "letter" }; changed = true; } }
        else if (!feesOverridden && prev[key]) { delete next[key]; changed = true; }
      };
      sync("fees.total", totalCents);
      if (discountPct > 0) { sync("fees.discount_amount", discountCents); sync("fees.tuition_after_discount", tuitionCents == null ? null : tuitionCents - discountCents); }
      return changed ? next : prev;
    });
  }, [feesOverridden, totalCents, discountCents, tuitionCents, discountPct]);
  const shownMissing = missing.filter((m) => !isFeeKey(m.key) || courseIndexOf(m.key) > 0);
  const blockingCount = blocking.length;
  const missingCount = missing.length;
  const inCms = typeof window !== "undefined" && window.location.pathname.startsWith("/admin");
  // OFFER-DEPOSIT: the payment amount is the letter's initial deposit, exactly as printed (the server refuses anything else).
  const depositCents = feeCents("fees.deposit");
  const courseDepositCents = rawCents("fees.deposit");
  const payPossible = depositCents != null && depositCents >= 50;
  const payDiffers = payPossible && depositCents !== courseDepositCents;
  const depositInput = (): OfferDepositInput | null => payOn && payPossible ? { amount: depositCents! / 100, currency: "AUD", description: "Initial deposit", note: payDiffers ? payNote.trim() : "" } : null;
  const payValid = true;
  const missingKeys = new Set(missing.map((m) => m.key));
  const sourceRecords = Object.entries(entries).filter(([key, e]) => e.mode === "source" && e.saved && !missingKeys.has(key));

  const setEntry = (key: string, patch: Partial<Entry>) => setEntries((prev) => ({ ...prev, [key]: { input: "", mode: "letter", ...prev[key], ...patch } }));
  const focusInput = (key: string) => {
    const el = document.getElementById(`letter-input-${key}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => el?.focus(), 150);
  };

  const saveToSource = async (target: { key: string }) => {
    setConfirmSource(null);
    setBusy(`source-${target.key}`); setError("");
    try {
      const next = await saveLetterValueToSource(application.id, target.key, entries[target.key]?.input ?? "");
      setValues(next);
      setEntry(target.key, { mode: "source", saved: true });
    } catch (e) { setError(e instanceof Error ? e.message : "The value could not be saved."); }
    finally { setBusy(""); }
  };

  const pickFile = (files: FileList | null) => {
    const picked = files?.[0];
    setError("");
    if (!picked) return;
    if (!/\.pdf$/i.test(picked.name) && picked.type !== "application/pdf") { setError("Upload the letter as a PDF."); return; }
    if (picked.size > MAX_BYTES) { setError("The letter must be 3 MB or smaller."); return; }
    setFile(picked);
  };

  const mismatch = Boolean(recipient?.declarationMismatch);
  // Open review problems (validation errors) block the letter unless an admin overrides them with a note.
  const needsOverride = mismatch || reviewIssues > 0;
  const fileName = `Offer letter ${application.reference || application.studentName}.pdf`.replace(/[\\/:*?"<>|]+/g, " ");
  const ready = Boolean(recipient?.email) && (!needsOverride || override.trim().length > 0) && !busy
    && (mode === "template" ? Boolean(template && letter && values && registry) && blocking.length === 0 && payValid : Boolean(file));
  const handFilled = [...manual.filter((m) => m.mode !== "source"), ...sourceRecords.map(([key]) => ({ key, value: flat[key]?.value ?? "", mode: "source" as const }))];

  const send = async () => {
    if (!ready) return;
    setFinalCheck(false);
    setBusy("send"); setError("");
    try {
      let issued: { id: string; bytes: Uint8Array } | null = null;
      if (mode === "upload" && file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        issued = { id: (await issueOfferLetter({ applicationId: application.id, source: "upload", fileName: file.name, contentBase64: toBase64(bytes), templateId: null, message: message.trim(), overrideNote: needsOverride ? override.trim() : "" })).id, bytes };
      } else if (template && letter) {
        issued = { id: (await issueTemplateLetter({ applicationId: application.id, templateId: template.id, templateVersion: template.version, fileName, contentBase64: toBase64(letter.bytes),
          manual: handFilled, conditions, message: message.trim(), overrideNote: needsOverride ? override.trim() : "", payment: depositInput() })).id, bytes: letter.bytes };
      }
      if (ccOn) await sendCc(application.id, "offer_letter_issued", cc);
      // The student signs online: where (initials, signature, date, YES / NO) is read from the letter and stored before the email goes
      // (the notification worker waits for it, up to 3 minutes).
      if (issued) await saveOfferSigningLayout(issued.id, issued.bytes);
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "The offer letter could not be sent."); setBusy(""); }
  };
  const clickSend = () => { if (mode === "template" && handFilled.length) setFinalCheck(true); else void send(); };
  const sendLabel = mode === "template" && blocking.length ? `Send (${blockingCount} ${blockingCount === 1 ? "detail" : "details"} missing)` : "Send offer letter";

  return (
    <ActionDrawer title="Issue offer letter" testId="offer-letter-drawer" wide={mode === "template"}
      subtitle={<>{application.studentName || "Application"}{application.reference ? <> &middot; {application.reference}</> : null}</>}
      busy={busy === "send"} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy === "send"} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">Cancel</button>
        <button type="button" onClick={clickSend} disabled={!ready} data-testid="send-offer-letter"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
          {busy === "send" ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-send-plane-line" aria-hidden="true" />}
          {sendLabel}
        </button>
      </>}>
      <div className={mode === "template" ? "grid gap-5 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]" : ""}>
        {mode === "template" && template && bodyEdit !== null ? (
          // The wording editor takes the whole drawer: the toolbar and the Insert variable panel beside a tall text area that scrolls on its own.
          <section className="min-w-0 lg:col-span-2" data-testid="offer-wording-section">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground-950">Wording of this letter <span className="font-normal text-foreground-500">· changes apply to this letter only; the template stays as it is</span></p>
              <button type="button" onClick={() => setBodyEdit(null)} data-testid="offer-edit-wording" className="text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Discard my wording changes</button>
            </div>
            <RichTextEditor mode="document" value={bodyEdit} onChange={setBodyEdit} letterVariables={registry ?? []} minHeight={Math.max(360, Math.round(window.innerHeight * 0.6))} maxHeight="62vh" label="Wording of this letter" testId="offer-wording-editor" />
          </section>
        ) : null}
        <div className="space-y-4">
          <div className="rounded-lg border border-background-200 bg-background-100/60 px-3 py-2.5" data-testid="offer-recipient">
            <p className={FORM_LABEL}>Sends to</p>
            {recipient ? (
              <>
                <p className="mt-1 text-sm text-foreground-900">
                  <span className="mr-1.5 rounded-full bg-background-50 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-foreground-700 ring-1 ring-background-200">{recipient.kind === "agent" ? "Agent" : "Student"}</span>
                  {recipient.name || "Unnamed"} <span className="text-foreground-500">&lt;{recipient.email || "no email"}&gt;</span>
                </p>
                <p className="mt-0.5 text-xs text-foreground-500">{recipient.reason}.</p>
              </>
            ) : <p className="mt-1 text-sm text-foreground-500">Working out the recipient&hellip;</p>}
            <CcAgent cc={cc} on={ccOn} onChange={setCcOn} recipientEmail={recipient?.email} />
          </div>

          {needsOverride ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5" data-testid="offer-mismatch">
              {mismatch ? <p className="flex items-start gap-1.5 text-sm text-amber-900"><i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />The declarant name and digital signature on the declaration do not match.</p> : null}
              {reviewIssues > 0 ? <p className="flex items-start gap-1.5 text-sm text-amber-900" data-testid="offer-review-issues"><i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />{reviewIssues === 1 ? "1 review item is still open" : `${reviewIssues} review items are still open`} (see Review). An admin can issue the letter anyway with a note.</p> : null}
              <label htmlFor="offer-override" className={`${FORM_LABEL} mt-2 block`}>Note to issue anyway <span className="text-red-600" aria-hidden="true">*</span></label>
              <textarea id="offer-override" rows={2} maxLength={500} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. Confirmed with the student by phone" className={`mt-1 ${INPUT}`} />
            </div>
          ) : null}

          <SegmentedControl<"template" | "upload"> label="How to make the letter" value={mode} onChange={setMode} testId="offer-mode"
            options={[{ value: "template", label: "Use template", icon: "ri-file-text-line" }, { value: "upload", label: "Upload letter", icon: "ri-upload-2-line" }]} />

          {mode === "template" ? (
            <>
              {templates?.length === 0 ? (
                <div className="rounded-lg border border-dashed border-background-300 bg-background-100/50 px-4 py-5 text-center" data-testid="offer-no-template">
                  <i className="ri-file-text-line text-2xl text-foreground-400" aria-hidden="true" />
                  <p className="mt-1 text-sm font-semibold text-foreground-900">No offer letter template yet</p>
                  <p className="mt-0.5 text-xs text-foreground-600">Student letters live in Sign &rsaquo; Templates (For: Students / Applications).</p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <button type="button" data-testid="offer-create-template"
                      onClick={() => window.open("/admin/signing/templates?new=student_offer_letter", "_blank", "noopener")}
                      className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600">
                      <i className="ri-add-line" aria-hidden="true" />Create template
                    </button>
                    <button type="button" onClick={reloadTemplates} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100">Refresh</button>
                  </div>
                  <button type="button" onClick={() => setMode("upload")} data-testid="offer-upload-instead" className="mt-2 text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Upload letter instead</button>
                </div>
              ) : (
                <div>
                  <label htmlFor="offer-template" className={`${FORM_LABEL} mb-1 block`}>Template</label>
                  <select id="offer-template" value={templateId} disabled={!templates?.length} onChange={(e) => { setTemplateId(e.target.value); setBodyEdit(null); setLetter(null); }}
                    className="h-10 w-full rounded-lg border border-background-300 bg-background-50 px-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40">
                    <option value="">{templates === null ? "Loading templates…" : "Choose a template"}</option>
                    {templates?.map((t) => <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}
                  </select>
                </div>
              )}

              {template && values?.courses?.length ? (
                <section className="rounded-lg border border-background-200 bg-background-100/60 p-3" data-testid="offer-courses" aria-label="Courses and fees">
                  <p className="text-sm font-semibold text-foreground-950">Courses and fees</p>
                  <p className="mb-2 mt-0.5 text-xs text-foreground-600">A discount is taken off the course's tuition in the letter; the deposit stays as it is.</p>
                  <ul className="space-y-2">
                    {values.courses.map((course, n) => {
                      const meta = courseMeta(course);
                      const row = courseRowFor(course, n);
                      const title = String(meta._title ?? course["course.name"]?.value ?? `Course ${n + 1}`);
                      const percent = course["fees.discount_percent"]?.value;
                      return (
                        <li key={row?.id ?? n} className="flex flex-wrap items-center gap-2 rounded-md border border-background-200 bg-background-50 px-2.5 py-2" data-testid="offer-course" data-discount={row?.discountPercent ?? 0}>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground-900">{title}</p>
                            <p className="text-xs text-foreground-600">Total {course["fees.total"]?.value || "not set"}{meta._discount === true ? <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold text-emerald-800" data-testid="offer-course-discount">{percent || `${row?.discountPercent ?? 0}%`} discount</span> : null}</p>
                          </div>
                          <label className="flex items-center gap-1.5 text-xs text-foreground-700">Discount %
                            <input type="number" min={0} max={100} step={0.5} inputMode="decimal" disabled={!row || busy.startsWith("discount")} data-testid={`course-discount-${n}`}
                              value={row ? discountDraft[row.id] ?? String(row.discountPercent) : ""}
                              onChange={(e) => { if (row) setDiscountDraft((d) => ({ ...d, [row.id]: e.target.value })); }}
                              onBlur={() => { if (row) void saveDiscount(row); }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              className="w-20 rounded-lg border border-background-300 bg-background-50 px-2 py-1 text-sm focus:border-primary-500 focus:outline-none" />
                          </label>
                          {busy === `discount-${row?.id}` ? <i className="ri-loader-4-line animate-spin text-foreground-500" aria-label="Saving" /> : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              {template && registry && values ? (
                <section className={`rounded-lg border p-3 ${blocking.length ? "border-amber-300 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/50"}`} data-testid="needs-input" aria-label="Needs your input">
                  <p className="text-sm font-semibold text-foreground-950">
                    {missing.length ? <>Needs your input <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-950" data-testid="needs-input-count">{blockingCount}</span></>
                      : <><i className="ri-check-line text-emerald-700" aria-hidden="true" /> Every detail is filled from the application</>}
                  </p>
                  {missing.length ? <p className="mb-2 mt-0.5 text-xs text-foreground-600">{blockingCount ? `${blockingCount} of ${missingCount} still to fill. ` : "All filled. "}Each is missing in its source; fill it here.</p> : null}
                  <ul className="space-y-3">
                    {shownMissing.map(({ key, variable, label }) => {
                      const entry = entries[key] ?? { input: "", mode: "letter" as const };
                      const done = !blocking.some((b) => b.key === key);
                      const id = `letter-input-${key}`;
                      const inputProps = { id, value: entry.input, disabled: entry.mode === "blank" || busy.startsWith("source"), "data-testid": id,
                        onChange: (e: { target: { value: string } }) => setEntry(key, { input: e.target.value, ...(entry.mode === "blank" ? { mode: "letter" as const } : {}) }) };
                      return (
                        <li key={key} className="rounded-md border border-background-200 bg-background-50 p-2.5" data-testid="needs-input-item" data-key={key}>
                          <div className="flex items-baseline justify-between gap-2">
                            <label htmlFor={id} className="text-sm font-medium text-foreground-900">{label}{variable.required ? <span className="text-red-600" aria-hidden="true"> *</span> : <span className="ml-1 text-xs font-normal text-foreground-500">optional</span>}</label>
                            {done ? <i className="ri-check-line text-emerald-700" aria-label="Filled" /> : null}
                          </div>
                          <p className="mb-1.5 text-2xs text-foreground-500">From {flat[key]?.source ?? variable.source}</p>
                          {variable.inputType === "textarea" ? <textarea rows={2} {...inputProps} className={INPUT} />
                            : variable.inputType === "money" ? <input type="number" min={0} step={0.01} inputMode="decimal" placeholder="e.g. 14500.00" {...inputProps} className={INPUT} />
                            : <input type={variable.inputType === "date" ? "date" : variable.inputType === "email" ? "email" : variable.inputType === "tel" ? "tel" : "text"}
                                placeholder={variable.inputType === "date" ? undefined : variable.sample} {...inputProps} className={INPUT} />}
                          {entry.input.trim() && entry.mode !== "blank" && variable.format !== "text" ? <p className="mt-1 text-2xs text-foreground-600">Prints as: {formatTyped(variable, entry.input, dateFormat)}</p> : null}
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="text-foreground-600">{entry.input.trim() && entry.mode === "letter" ? "Used for this letter only (recorded)." : ""}</span>
                            {variable.editableSource ? (
                              <button type="button" disabled={!entry.input.trim() || Boolean(busy)} onClick={() => setConfirmSource({ key, variable })} data-testid={`save-source-${key}`}
                                className="font-medium text-primary-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:text-foreground-400 disabled:no-underline">
                                {busy === `source-${key}` ? "Saving…" : "Fill and save to source"}
                              </button>
                            ) : <span className="text-foreground-400" title={`Change it in ${variable.source}`}>Saved only in its source screen</span>}
                            {!variable.required ? (
                              <label className="inline-flex items-center gap-1.5 text-foreground-700">
                                <input type="checkbox" checked={entry.mode === "blank"} data-testid={`leave-blank-${key}`}
                                  onChange={(e) => setEntry(key, e.target.checked ? { mode: "blank", input: "" } : { mode: "letter" })} />
                                Leave blank
                              </label>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {sourceRecords.length ? <p className="mt-2 text-xs text-emerald-800" data-testid="saved-to-source">Saved to source: {sourceRecords.map(([key]) => registry.find((v) => v.key === key)?.label).join(", ")}.</p> : null}
                </section>
              ) : null}

              {template && usedHtml.includes("offer.conditions") ? (
                <div>
                  <label htmlFor="offer-conditions" className={`${FORM_LABEL} mb-1 block`}>Offer conditions</label>
                  <textarea id="offer-conditions" rows={3} maxLength={2000} value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="One per line. Leave empty for Nil." className={INPUT} data-testid="offer-conditions" />
                </div>
              ) : null}

              {template && registry && values && feeKeys.length ? (
                <section className="rounded-lg border border-background-200 bg-background-100/60 p-3" data-testid="offer-fees" aria-label="Fees">
                  <p className="text-sm font-semibold text-foreground-950">Fees</p>
                  <p className="mb-2 mt-0.5 text-xs text-foreground-600">From LMS ({values.values["fees.tuition"]?.source ?? "the course's Fees"}). Leave a fee as it is, or type the amount for this letter.{inCms && values.context.courseId ? <> <a className="font-medium underline underline-offset-2" href={`/admin/courses/${encodeURIComponent(values.context.courseId)}/fees`} target="_blank" rel="noreferrer" data-testid="offer-fees-link">Course Fees in LMS</a></> : null}</p>
                  <ul className="space-y-2">
                    {feeKeys.map((key) => {
                      const variable = registry.find((v) => v.key === key); if (!variable) return null;
                      const entry = entries[key] ?? { input: "", mode: "letter" as const };
                      const db = flat[key]; const dbCents = rawCents(key); const printed = feeCents(key);
                      const id = `letter-input-${key}`;
                      return (
                        <li key={key} className="rounded-md border border-background-200 bg-background-50 p-2.5" data-testid="offer-fee" data-key={key}>
                          <div className="flex items-baseline justify-between gap-2">
                            <label htmlFor={id} className="text-sm font-medium text-foreground-900">{variable.label}{variable.required ? <span className="text-red-600" aria-hidden="true"> *</span> : null}</label>
                            {printed == null && variable.required ? <span className="text-xs text-amber-900">Needed</span> : printed != null ? <i className="ri-check-line text-emerald-700" aria-label="Filled" /> : null}
                          </div>
                          <p className="mb-1.5 text-2xs text-foreground-500">From {db?.source ?? variable.source}{dbCents == null ? " · not set in LMS" : ""}</p>
                          <input id={id} type="number" min={0} step={0.01} inputMode="decimal" value={entry.input} disabled={entry.mode === "blank" || busy.startsWith("source")} data-testid={id}
                            placeholder={dbCents != null ? (dbCents / 100).toFixed(2) : "e.g. 1500.00"} className={INPUT}
                            onChange={(e) => setEntry(key, { input: e.target.value, ...(entry.mode === "blank" ? { mode: "letter" as const } : {}) })} />
                          <p className="mt-1 text-2xs text-foreground-600">{printed != null ? <>Prints as: {entry.input.trim() && entry.mode === "letter" ? formatTyped(variable, entry.input, dateFormat) : db?.value}</> : entry.mode === "blank" ? "Left blank." : "Nothing to print yet."}</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="text-foreground-600">{entry.input.trim() && entry.mode === "letter" ? "Used for this letter only (recorded)." : ""}</span>
                            {variable.editableSource ? (
                              <button type="button" disabled={!entry.input.trim() || Boolean(busy)} onClick={() => setConfirmSource({ key, variable })} data-testid={`save-source-${key}`}
                                className="font-medium text-primary-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:text-foreground-400 disabled:no-underline">
                                {busy === `source-${key}` ? "Saving…" : "Fill and save to source"}
                              </button>
                            ) : <span className="text-foreground-400" title={`Change it in ${variable.source}`}>Saved only in its source screen</span>}
                            {!variable.required ? (
                              <label className="inline-flex items-center gap-1.5 text-foreground-700">
                                <input type="checkbox" checked={entry.mode === "blank"} data-testid={`leave-blank-${key}`} onChange={(e) => setEntry(key, e.target.checked ? { mode: "blank", input: "" } : { mode: "letter" })} /> Leave blank
                              </label>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                    {discountPct > 0 ? <li className="flex items-center justify-between rounded-md border border-dashed border-emerald-300 bg-emerald-50/50 px-2.5 py-2 text-sm" data-testid="offer-fee-discount"><span className="text-foreground-800">Discount {discountPct}% of tuition</span><span className="font-medium text-emerald-800">− {formatMoney(discountCents, "AUD")}</span></li> : null}
                    {usedKeys.has("fees.total") ? (
                      <li className="flex items-center justify-between rounded-md border border-background-300 bg-background-100 px-2.5 py-2 text-sm" data-testid="offer-fee-total">
                        <span><span className="font-semibold text-foreground-950">Total fees</span> <span className="text-2xs text-foreground-500">calculated{otherLinesCents ? ` · includes ${formatMoney(otherLinesCents, "AUD")} of other LMS fee lines` : ""}</span></span>
                        <span className="font-semibold text-foreground-950">{totalCents != null ? formatMoney(totalCents, "AUD") : <span className="text-amber-900">needs the tuition fee</span>}</span>
                      </li>
                    ) : null}
                  </ul>
                </section>
              ) : null}

              {template && values ? (
                <section className="rounded-lg border border-background-200 bg-background-100/60 p-3" data-testid="offer-deposit" aria-label="Initial deposit">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground-950">Initial deposit via Stripe</p>
                    <label className={`inline-flex items-center gap-1.5 text-xs ${payPossible ? "text-foreground-700" : "text-foreground-400"}`}><input type="checkbox" checked={payOn && payPossible} disabled={!payPossible} onChange={(e) => setPayOn(e.target.checked)} data-testid="offer-deposit-on" /> Ask for payment with this letter</label>
                  </div>
                  {!payPossible ? (
                    <p className="mt-0.5 text-xs text-foreground-600" data-testid="offer-deposit-missing">Set an initial deposit above to ask for payment.</p>
                  ) : payOn ? (
                    <>
                      <p className="mt-0.5 text-xs text-foreground-800" data-testid="offer-deposit-line">Student pays <strong>{formatMoney(depositCents!, "AUD")}</strong> (initial deposit) after signing, by card on the signing page; the offer is then marked accepted and paid.</p>
                      {payDiffers ? (
                        <div className="mt-2">
                          <label htmlFor="offer-deposit-note" className={`${FORM_LABEL} mb-1 block`}>Why this amount <span className="font-normal text-foreground-500">(the course's Fees say {courseDepositCents != null ? formatMoney(courseDepositCents, "AUD") : "nothing"}; recorded with the letter)</span></label>
                          <input id="offer-deposit-note" value={payNote} maxLength={500} onChange={(e) => setPayNote(e.target.value)} placeholder="e.g. Scholarship: half deposit agreed by the director" className={INPUT} data-testid="offer-deposit-note" />
                        </div>
                      ) : null}
                    </>
                  ) : <p className="mt-0.5 text-xs text-foreground-600">No payment is asked for with this letter.</p>}
                </section>
              ) : null}

              {template && bodyEdit === null ? (
                <div>
                  <button type="button" onClick={() => setBodyEdit(template.bodyHtml ?? "")} data-testid="offer-edit-wording"
                    className="text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">
                    Edit the wording for this letter
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-3">
              {file ? (
                <DocumentRow filename={file.name} pill={{ text: "Ready to send", tone: "ready" }}
                  actions={<RowAction title="Remove" icon="ri-delete-bin-line" label={`Remove ${file.name}`} onClick={() => setFile(null)} />} />
              ) : <Dropzone id="offer-upload" label="Choose the signed letter or drop it here" hint="PDF · max 3 MB" accept=".pdf,application/pdf" onFiles={pickFile} testId="offer-dropzone" />}
            </div>
          )}

          <div>
            <label htmlFor="offer-message" className={`${FORM_LABEL} mb-1 block`}>Message (optional)</label>
            <textarea id="offer-message" rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Added to the email with the letter" className={INPUT} />
          </div>
          {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        </div>

        {mode === "template" ? (
          <div className="min-w-0 space-y-3">
            {used && registry && values ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground-950">Preview {letter ? <span className="font-normal text-foreground-500">· {letter.pages} {letter.pages === 1 ? "page" : "pages"} · A4</span> : null}</p>
                  <button type="button" onClick={() => setShowCheck((v) => !v)} className="text-xs font-medium text-foreground-700 underline underline-offset-2" data-testid="toggle-variable-check">
                    {showCheck ? "Hide variable check" : "Variable check"}
                  </button>
                </div>
                {showCheck ? <VariableCheck html={usedHtml} registry={registry} values={flat} manual={manual} courses={values.courses} /> : null}
                <LetterPreview input={{ template: used, registry, values: values.values, courses: values.courses, charges: values.charges, gst: Boolean(values.context.gst), manual, conditions }} onBuilt={(made) => setLetter(made)} onMark={focusInput} testId="offer-letter-preview" />
              </>
            ) : (
              // A clean A4-shaped placeholder until a template is selected and the letter is made.
              <div className="flex aspect-[1/1.414] max-h-[70vh] w-full flex-col items-center justify-center rounded-lg border border-dashed border-background-300 bg-background-100/50 px-6 text-center" data-testid="offer-preview-placeholder">
                <i className={`${templates === null ? "ri-loader-4-line animate-spin" : "ri-file-paper-2-line"} text-3xl text-foreground-400`} aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-foreground-700">{templates === null ? "Loading the letter…" : templates.length === 0 ? "The preview appears here once there is a template." : "Preparing the preview…"}</p>
                <p className="mt-0.5 text-xs text-foreground-500">A4, with the header and footer on every page.</p>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {confirmSource ? (
        <ConfirmDialog title={`Save ${confirmSource.variable.label} to its source?`} confirmLabel="Save to source" busy={busy.startsWith("source")}
          body={<>“{formatTyped(confirmSource.variable, entries[confirmSource.key]?.input ?? "", dateFormat)}” will be saved in <strong>{confirmSource.variable.source}</strong> and used from now on, not only in this letter.</>}
          onConfirm={() => void saveToSource(confirmSource)} onClose={() => setConfirmSource(null)} />
      ) : null}
      {finalCheck ? (
        <ConfirmDialog title="Send the offer letter?" confirmLabel="Send offer letter" busy={busy === "send"} onConfirm={() => void send()} onClose={() => setFinalCheck(false)}
          body={<>These details were filled by hand and are recorded in the status history:</>}>
          <ul className="mt-2 space-y-0.5 text-sm" data-testid="final-check">
            {handFilled.map((m) => {
              const label = registry?.find((v) => v.key === m.key)?.label ?? m.key;
              return <li key={m.key}><span className="font-medium">{label}:</span> {m.mode === "blank" ? <em>left blank</em> : m.value} <span className="text-xs text-foreground-500">({m.mode === "letter" ? "this letter only" : m.mode === "source" ? "saved to source" : "optional"})</span></li>;
            })}
          </ul>
        </ConfirmDialog>
      ) : null}
    </ActionDrawer>
  );
}
