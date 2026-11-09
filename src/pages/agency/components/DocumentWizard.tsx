import { useState } from "react";
import { Field, TextInput } from "@/pages/admin/components/ui";
import WizardDocumentStep from "@/pages/agency/components/WizardDocumentStep";
import type { PendingUpload, WizardDoc, WizardExtractionState, WizardStep } from "@/pages/agency/lib/wizardConfig";
import { checklist, expiryState, todayIso, type ChecklistItem, type DocumentKind, type ReviewState } from "@/lib/documentChecklist";

/**
 * DocumentWizard: a document-collection screen driven by a step config and an adapter, so it does not know whose documents
 * it holds or where they are stored. The staff workspace uses it today (Documents step and the post-submit checklist); the
 * student ApplicationWizard can move onto it later (docs/TASKS.md HR-01).
 *
 *   - `steps`: what to ask for, in order. Each pairs a DocumentKind (required, expiry rule, multiple files) with the
 *     WizardStep text and icon shown by the existing WizardDocumentStep.
 *   - `documents`: the current files, already in WizardDocument form.
 *   - `adapter`: how to upload / remove / open (signed URL) / correct an expiry date / ask for a reading. Every method
 *     resolves once the caller has its fresh data; the component then re-renders from `documents`.
 */

export interface WizardDocument {
  id: string; category: string; filename: string; fileSize: number; storagePath: string;
  extraction: WizardExtractionState; error?: string; extracted?: Record<string, string>;
  expiryDate: string | null; status: ReviewState; reviewNote: string;
}

export interface DocumentWizardStep { kind: DocumentKind; step: WizardStep }

export interface DocumentAdapter {
  upload: (kind: DocumentKind, file: File, expiryDate: string | null, replaces?: string) => Promise<void>;
  remove: (doc: WizardDocument) => Promise<void>;
  signedUrl: (doc: WizardDocument) => Promise<string>;
  /** Optional: correct the expiry date of a file already uploaded. */
  setExpiry?: (doc: WizardDocument, expiryDate: string) => Promise<void>;
  /** Optional: ask for a reading again after a failure. */
  extract?: (doc: WizardDocument) => Promise<void>;
}

const slug = (category: string) => category.toLowerCase().replace(/\s+/g, "-");
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const toStepDoc = (d: WizardDocument): WizardDoc => ({ id: d.id, category: d.category, filename: d.filename, fileSize: d.fileSize, storagePath: d.storagePath, extraction: d.extraction, error: d.error, extracted: d.extracted });

/* ------------------------------------------------------------------ collecting documents */

export function DocumentWizard({ steps, documents, adapter, testIdPrefix = "doc", notice }: {
  steps: readonly DocumentWizardStep[]; documents: readonly WizardDocument[]; adapter: DocumentAdapter; testIdPrefix?: string; notice?: string;
}) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [expiryError, setExpiryError] = useState<Record<string, string>>({});

  const upload = async (kind: DocumentKind, file: File, key = `${kind.category}-${Date.now()}-${file.name}`) => {
    setPending((list) => [...list.filter((p) => p.key !== key), { key, category: kind.category, file }]);
    try {
      await adapter.upload(kind, file, kind.expiry === "none" ? null : expiry[kind.category] || null);
      setPending((list) => list.filter((p) => p.key !== key));
    } catch (e) { setPending((list) => list.map((p) => (p.key === key ? { ...p, error: e instanceof Error ? e.message : "The upload failed." } : p))); }
  };

  const pick = (kind: DocumentKind, files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    if (kind.expiry === "required" && !expiry[kind.category]) { setExpiryError((e) => ({ ...e, [kind.category]: "Enter the expiry date first." })); return; }
    setExpiryError((e) => ({ ...e, [kind.category]: "" }));
    for (const file of kind.multiple ? list : list.slice(0, 1)) void upload(kind, file);
  };

  /** A date typed for a type that already has its (single) file corrects that file's date straight away. */
  const changeExpiry = (kind: DocumentKind, value: string) => {
    setExpiry((e) => ({ ...e, [kind.category]: value }));
    const current = kind.multiple ? undefined : documents.find((d) => d.category === kind.category);
    if (!current || !value || !adapter.setExpiry) return;
    void adapter.setExpiry(current, value).then(() => setExpiryError((e) => ({ ...e, [kind.category]: "" })),
      (e: unknown) => setExpiryError((x) => ({ ...x, [kind.category]: e instanceof Error ? e.message : "Could not save the date." })));
  };

  return (
    <div className="space-y-8">
      {notice ? <p className={ALERT}>{notice}</p> : null}
      {steps.map(({ kind, step }) => {
        const current = kind.multiple ? undefined : documents.find((d) => d.category === kind.category);
        return (
          <div key={kind.category} data-testid={`${testIdPrefix}-doc-${slug(kind.category)}`}>
            {!kind.required ? <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">Optional</p> : null}
            {kind.expiry !== "none" ? (
              <div className="mb-3 max-w-xs">
                <Field label={`${kind.label} expiry date`} required={kind.expiry === "required"}
                  hint={current ? "Saved with the uploaded file." : kind.expiry === "required" ? "Enter it before you upload." : "Optional."}>
                  <TextInput type="date" min={todayIso()} value={expiry[kind.category] ?? current?.expiryDate ?? ""} data-testid={`${testIdPrefix}-expiry-${slug(kind.category)}`}
                    onChange={(e) => changeExpiry(kind, e.target.value)} />
                </Field>
                {expiryError[kind.category] ? <p role="alert" className="mt-1 text-xs text-primary-900">{expiryError[kind.category]}</p> : null}
              </div>
            ) : null}
            <WizardDocumentStep step={step}
              docs={documents.filter((d) => d.category === kind.category).map(toStepDoc)}
              pending={pending.filter((p) => p.category === kind.category)} dismissed={dismissed}
              onPickFiles={(files) => pick(kind, files)}
              onRetryUpload={(item) => void upload(kind, item.file, item.key)}
              onDropUpload={(item) => setPending((list) => list.filter((p) => p.key !== item.key))}
              onRetryDoc={(doc) => { const d = documents.find((x) => x.id === doc.id); if (d && adapter.extract) void adapter.extract(d); }}
              onDismissDoc={(doc) => setDismissed((s) => new Set(s).add(doc.id))}
              onRemoveDoc={async (doc) => { const d = documents.find((x) => x.id === doc.id); if (d) await adapter.remove(d); }}
              signedUrl={(doc) => { const d = documents.find((x) => x.id === doc.id); return d ? adapter.signedUrl(d) : Promise.reject(new Error("The document could not be opened.")); }} />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ checklist with review status, notes and re-upload */

const STATE_CHIP: Record<ChecklistItem["state"], { text: string; cls: string }> = {
  missing: { text: "Missing", cls: "bg-background-200 text-foreground-800" },
  pending: { text: "Pending review", cls: "bg-secondary-100 text-foreground-900" },
  approved: { text: "Approved", cls: "bg-accent-100 text-accent-900" },
  rejected: { text: "Rejected", cls: "bg-primary-100 text-primary-900" },
};
const EXPIRY_TEXT = { none: "", ok: "", soon: "expires soon", expired: "expired" } as const;

function ExpiryText({ date }: { date: string | null }) {
  if (!date) return null;
  const state = expiryState(date);
  return (
    <span className={state === "soon" || state === "expired" ? "font-semibold text-primary-800" : ""} data-expiry={state}>
      Expires {new Date(`${date}T00:00:00`).toLocaleDateString()}{EXPIRY_TEXT[state] ? ` (${EXPIRY_TEXT[state]})` : ""}
    </span>
  );
}

export function DocumentChecklist({ kinds, documents, adapter, canReupload, testIdPrefix = "doc" }: {
  kinds: readonly DocumentKind[]; documents: readonly WizardDocument[]; adapter: DocumentAdapter; canReupload: boolean; testIdPrefix?: string;
}) {
  const [error, setError] = useState("");
  const items = checklist(kinds, documents);
  const open = async (doc: WizardDocument) => {
    setError("");
    try { window.open(await adapter.signedUrl(doc), "_blank", "noopener,noreferrer"); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  };
  return (
    <div className="space-y-3">
      {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      <ul className="space-y-3" data-testid={`${testIdPrefix}-checklist`}>
        {items.map((item) => (
          <li key={item.kind.category} className="rounded-md border border-background-200 px-3 py-2.5 text-sm" data-testid={`${testIdPrefix}-check-${slug(item.kind.category)}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-foreground-950">{item.kind.label}{item.kind.required ? "" : " (optional)"}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_CHIP[item.state].cls}`} data-state={item.state}>
                {item.state === "missing" && !item.kind.required ? "Not provided" : STATE_CHIP[item.state].text}
              </span>
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {documents.filter((d) => d.category === item.kind.category).map((doc) => (
                <li key={doc.id} className="text-xs text-foreground-700">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <button type="button" className="cursor-pointer font-semibold text-primary-700 underline" onClick={() => void open(doc)}>{doc.filename}</button>
                    {item.kind.multiple ? <span>{STATE_CHIP[doc.status].text}</span> : null}
                    <ExpiryText date={doc.expiryDate} />
                  </div>
                  {doc.status === "rejected" ? (
                    <div className="mt-1 rounded-md bg-primary-50 px-2.5 py-1.5 text-primary-900">
                      <p><strong>What to fix:</strong> {doc.reviewNote}</p>
                      {canReupload ? <Reupload kind={item.kind} doc={doc} adapter={adapter} testIdPrefix={testIdPrefix} /> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Replace one rejected document after submission (the new file starts as pending review), or correct only its date. */
function Reupload({ kind, doc, adapter, testIdPrefix }: { kind: DocumentKind; doc: WizardDocument; adapter: DocumentAdapter; testIdPrefix: string }) {
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const takesExpiry = kind.expiry !== "none";
  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (kind.expiry === "required" && !expiry) { setError("Enter the expiry date of the new document first."); return; }
    void run(() => adapter.upload(kind, file, takesExpiry ? expiry || null : null, kind.multiple ? doc.id : undefined), "The upload failed.");
  };
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3">
      {takesExpiry ? (
        <label className="text-xs">
          <span className="mb-1 block font-medium text-foreground-800">New expiry date{kind.expiry === "optional" ? " (optional)" : ""}</span>
          <input type="date" min={todayIso()} value={expiry} onChange={(e) => setExpiry(e.target.value)} className="rounded-md border border-background-300 bg-background-50 px-2 py-1 text-foreground-900" data-testid={`${testIdPrefix}-reupload-expiry-${doc.id}`} />
        </label>
      ) : null}
      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-primary-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-primary-800 ${busy ? "opacity-60" : ""}`}>
        <i className="ri-upload-2-line" aria-hidden="true" />{busy ? "Uploading…" : "Upload a new file"}
        <input type="file" className="sr-only" disabled={busy} accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" data-testid={`${testIdPrefix}-reupload-${doc.id}`}
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      {takesExpiry && adapter.setExpiry ? (
        <button type="button" disabled={busy || !expiry} onClick={() => void run(() => adapter.setExpiry!(doc, expiry), "The date could not be saved.")} data-testid={`${testIdPrefix}-reexpiry-${doc.id}`}
          className="cursor-pointer text-xs font-semibold text-primary-700 underline disabled:cursor-not-allowed disabled:opacity-50">Only the date was wrong: save the new date</button>
      ) : null}
      {error ? <p role="alert" className="w-full text-primary-900">{error}</p> : null}
    </div>
  );
}
