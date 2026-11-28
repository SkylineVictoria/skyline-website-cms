import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { PendingUpload, WizardDoc, WizardStep } from "@/pages/agency/lib/wizardConfig";
import { DOCUMENT_ACCEPT } from "../../../../supabase/functions/_shared/validation/person";
import { guessDocumentType } from "@/pages/agency/lib/bulkDocuments";

/**
 * BULK-DOCUMENTS (owner 2026-11-28: "upload all docs in one shot, then only the missing ones, then the card view and submit"). The
 * same screen for the student, the agent and SLIT staff (one wizard, one code): every file dropped at once, each with its document
 * type found by scanning it (document-classify; no choosing), uploaded in one go through the same checked upload as the
 * one-at-a-time steps (a file that is not what it says is refused and shown here). Then the checklist asks only for what is still
 * missing. Automatic sorting by the document reader replaces the guess once its service can be deployed.
 */
export interface BulkStep {
  step: WizardStep;
  /** Needed before the application can go on (passport, English, academic; the visa when the residency answers need it). */
  required: boolean;
  docs: WizardDoc[];
  pending: PendingUpload[];
  /** Why the last file for this document was refused (wrong document, expired passport…). */
  problem?: string;
  /** Shown instead of the document when it is met another way (English without a test result). */
  metOtherwise?: string;
}

/** A file chosen in the bulk upload: scanned to find which document it is, then attached to that document automatically. */
interface Staged {
  key: string; file: File;
  /** scanning: being read; ready: its document is known; other: not a document the application asks for; unclear: not readable;
   *  failed: the scanner is not available (the person then says what it is, the only case with a choice). */
  status: "scanning" | "ready" | "other" | "unclear" | "failed";
  type: string; detected?: string;
}

export default function BulkDocumentUpload({ steps, onUpload, onRemove, residency, onOneByOne, locked, classify }: {
  steps: BulkStep[];
  onUpload: (stepId: string, files: File[], passportComing?: boolean) => void;
  onRemove: (doc: WizardDoc) => Promise<void>;
  /** The residency questions (shown once the passport is read: they decide whether a visa is needed). */
  residency?: ReactNode;
  /** Switch to one document at a time (the guided steps), e.g. for the English options without a test result. */
  onOneByOne: (stepId?: string) => void;
  locked?: boolean;
  /** Reads a file and says which document it is (the wizard step id, "" when none); throws when the scanner is unavailable. */
  classify: (file: File) => Promise<{ step: string; type: string }>;
}) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const known = new Set(steps.map((s) => s.step.id as string));
  const update = (key: string, patch: Partial<Staged>) => setStaged((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const stage = (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const added: Staged[] = Array.from(files).map((file) => ({ key: crypto.randomUUID(), file, status: "scanning", type: "" }));
    setStaged((prev) => [...prev, ...added]);
    // Three at a time, so a big batch does not flood the scanner.
    const queue = [...added];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const found = await classify(item.file);
          if (found.type === "Unclear") update(item.key, { status: "unclear", detected: found.type });
          else if (found.step && known.has(found.step)) update(item.key, { status: "ready", type: found.step, detected: found.type });
          else update(item.key, { status: "other", detected: found.type });
        } catch {
          const guess = guessDocumentType(item.file.name);
          update(item.key, { status: "failed", type: known.has(guess) ? guess : "" });
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  };
  // Once every file is scanned, the ones that were recognised are attached at once (the passport first: the others are checked against it).
  const scanning = staged.some((item) => item.status === "scanning");
  useEffect(() => {
    if (scanning || locked) return;
    const go = staged.filter((item) => (item.status === "ready" || item.status === "failed") && item.type);
    if (!go.length || staged.some((item) => item.status === "failed" && !item.type)) return;
    const byType = new Map<string, File[]>();
    for (const item of go) byType.set(item.type, [...(byType.get(item.type) ?? []), item.file]);
    const passportComing = byType.has("passport");
    for (const [type, files] of [...byType].sort(([a], [b]) => (a === "passport" ? -1 : b === "passport" ? 1 : 0))) {
      const target = steps.find((s) => s.step.id === type);
      // A single document keeps the last file found for it (the others would replace it anyway).
      if (target) onUpload(type, target.step.multiple ? files : files.slice(-1), passportComing);
    }
    const sent = new Set(go.map((item) => item.key));
    setStaged((prev) => prev.filter((item) => !sent.has(item.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the scanning of a batch finishes
  }, [scanning, staged.length, staged.map((item) => item.status + item.type).join()]);
  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); stage(event.dataTransfer.files); };
  const titleOf = (id: string) => steps.find((s) => s.step.id === id)?.step.title ?? id;

  return (
    <div className="space-y-5" data-testid="bulk-documents">
      <div>
        <h2 className="text-lg font-semibold text-foreground-950">Upload all the documents at once</h2>
        <p className="mt-1 text-sm text-foreground-600">
          Select every file together: {steps.map((s) => `${s.step.short}${s.required ? "" : " (optional)"}`).join(", ")}. Each file is scanned and attached to the right document for you.
        </p>
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center ${dragging ? "border-primary-500 bg-primary-50" : "border-background-300 bg-background-50"}`}>
        <i className="ri-upload-cloud-2-line text-3xl text-primary-600" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground-800">Drop the files here, or</p>
        <button type="button" disabled={locked} onClick={() => input.current?.click()}
          className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Choose files</button>
        <input ref={input} type="file" multiple accept={DOCUMENT_ACCEPT} className="hidden" data-testid="bulk-files"
          onChange={(e) => { stage(e.target.files); e.target.value = ""; }} />
        <p className="text-2xs text-foreground-500">PDF, JPG or PNG, up to 10 MB each.</p>
      </div>

      {staged.length ? (
        <section className="space-y-2 rounded-lg border border-background-300 p-3" data-testid="bulk-staged">
          <p className="text-sm font-semibold">{scanning ? `Scanning ${staged.filter((x) => x.status === "scanning").length} of ${staged.length} file${staged.length === 1 ? "" : "s"} to see which document each one is…` : "These files were not attached:"}</p>
          {staged.map((item, index) => (
            <div key={item.key} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`bulk-file-${index}`} data-status={item.status}>
              <i className={item.status === "scanning" ? "ri-loader-4-line animate-spin text-primary-600" : item.status === "ready" ? "ri-checkbox-circle-fill text-emerald-600" : "ri-error-warning-line text-amber-700"} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={item.file.name}>{item.file.name}</span>
              <span className="text-xs text-foreground-600">
                {item.status === "scanning" ? "Scanning…" : item.status === "ready" ? titleOf(item.type)
                  : item.status === "other" ? "Not one of the documents this application needs"
                  : item.status === "unclear" ? "Could not be read clearly. Upload a clearer, complete copy"
                  : "Scanning is unavailable: what is it?"}
              </span>
              {item.status === "failed" ? (
                <select value={item.type} data-testid={`bulk-type-${index}`} aria-label={`Document type of ${item.file.name}`}
                  onChange={(e) => update(item.key, { type: e.target.value })}
                  className={`rounded-md border px-2 py-1.5 text-sm ${item.type ? "border-background-300" : "border-red-400 bg-red-50"}`}>
                  <option value="">Choose the type…</option>
                  {steps.map((s) => <option key={s.step.id} value={s.step.id}>{s.step.title}</option>)}
                </select>
              ) : null}
              {item.status !== "scanning" ? <button type="button" onClick={() => setStaged((prev) => prev.filter((x) => x.key !== item.key))} aria-label={`Remove ${item.file.name}`}
                className="rounded p-1 text-foreground-500 hover:bg-background-200"><i className="ri-close-line" aria-hidden="true" /></button> : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="space-y-2" data-testid="bulk-checklist">
        <h3 className="text-sm font-semibold text-foreground-900">Documents</h3>
        {steps.map((s) => {
          const reading = s.pending.some((p) => !p.error) || s.docs.some((d) => d.extraction === "queued" || d.extraction === "processing");
          const have = s.docs.length > 0 || !!s.metOtherwise;
          const state = reading ? "reading" : have ? "done" : s.required ? "missing" : "optional";
          return (
            <div key={s.step.id} className={`rounded-lg border p-3 text-sm ${state === "missing" ? "border-amber-300 bg-amber-50" : "border-background-200"}`} data-testid={`bulk-item-${s.step.id}`} data-state={state}>
              <div className="flex flex-wrap items-center gap-2">
                <i className={`${state === "done" ? "ri-checkbox-circle-fill text-emerald-600" : state === "reading" ? "ri-loader-4-line animate-spin text-primary-600" : state === "missing" ? "ri-error-warning-line text-amber-700" : "ri-checkbox-blank-circle-line text-foreground-400"}`} aria-hidden="true" />
                <span className="font-medium text-foreground-900">{s.step.title}</span>
                <span className="text-xs text-foreground-600">{state === "done" ? (s.metOtherwise ?? s.docs.map((d) => d.filename).join(", ")) : state === "reading" ? "Uploading and reading…" : state === "missing" ? "Still needed" : "Optional"}</span>
                <span className="flex-1" />
                {s.docs.map((d) => (
                  <button key={d.id} type="button" disabled={locked} onClick={() => void onRemove(d)} className="text-xs font-semibold text-foreground-600 hover:underline">Remove {d.filename}</button>
                ))}
                {state === "missing" || state === "optional" || (s.step.multiple && state === "done") ? (
                  <label className="cursor-pointer rounded-md border border-background-300 bg-white px-2.5 py-1 text-xs font-semibold text-primary-700 hover:bg-background-100">
                    {state === "done" ? "Add another" : `Upload ${s.step.noun}`}
                    <input type="file" className="hidden" multiple={s.step.multiple} accept={DOCUMENT_ACCEPT} disabled={locked} data-testid={`bulk-missing-${s.step.id}`}
                      onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) onUpload(s.step.id, files); }} />
                  </label>
                ) : null}
              </div>
              {s.problem ? <p role="alert" className="mt-1 text-xs text-red-700">{s.problem}</p> : null}
              {s.pending.filter((p) => p.error).map((p) => <p key={p.key} role="alert" className="mt-1 text-xs text-red-700">{p.file.name}: {p.error}</p>)}
              {s.step.id === "english" && state === "missing" ? (
                <button type="button" onClick={() => onOneByOne("english")} className="mt-1 text-xs font-semibold text-primary-700 underline" data-testid="bulk-english-other">
                  No English test result? See the other ways to meet it
                </button>
              ) : null}
            </div>
          );
        })}
      </section>

      {residency ? <section className="rounded-lg border border-background-300 p-3">{residency}</section> : null}

      <p className="text-xs text-foreground-600">
        Prefer one document at a time? <button type="button" className="font-semibold text-primary-700 underline" onClick={() => onOneByOne()} data-testid="bulk-one-by-one">Switch to the step-by-step upload</button>
      </p>
    </div>
  );
}

/** The first choice on the documents: all at once, or one at a time (the guided steps). */
export function DocumentModeChoice({ onBulk, onSteps }: { onBulk: () => void; onSteps: () => void }) {
  const card = (title: string, sub: string, icon: string, onClick: () => void, testId: string, recommended = false) => (
    <button type="button" onClick={onClick} data-testid={testId}
      className="flex flex-1 flex-col items-start gap-2 rounded-xl border border-background-300 bg-white p-5 text-left transition-colors hover:border-primary-500 hover:bg-primary-50">
      <span className="flex items-center gap-2"><i className={`${icon} text-2xl text-primary-600`} aria-hidden="true" />
        <span className="text-base font-semibold text-foreground-950">{title}</span>
        {recommended ? <span className="rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-semibold uppercase text-primary-800">Fastest</span> : null}</span>
      <span className="text-sm text-foreground-600">{sub}</span>
    </button>
  );
  return (
    <div className="space-y-4" data-testid="document-mode">
      <div>
        <h2 className="text-lg font-semibold text-foreground-950">How would you like to add the documents?</h2>
        <p className="mt-1 text-sm text-foreground-600">We need the passport, the visa (if any), the English test result and the academic documents; a driving licence is optional.</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        {card("Upload all at once", "Select every file together. We ask only for what is missing, then you check the details on one page and submit.", "ri-stack-line", onBulk, "doc-mode-bulk", true)}
        {card("One document at a time", "A guided screen for each document and question.", "ri-list-ordered", onSteps, "doc-mode-steps")}
      </div>
    </div>
  );
}
