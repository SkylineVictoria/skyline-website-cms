import { useEffect, useState } from "react";
import DocumentPreviewModal from "@/pages/agency/components/DocumentPreviewModal";
import { buildSignedApplicationPdf, getSignedCopy, signedSummary, type SignedCopy } from "@/pages/agency/lib/applicationPdf";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";

const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "—");

/**
 * SIGNED-APPLICATION (owner 2026-11-27): the read-only record of what was signed, on the Review & signature tab (and the Documents tab)
 * for the student, the agent and SLIT staff alike: "Signed by <student> on <date>" with the drawn signature, the parent / guardian for an
 * under-18 student, the declarations in the wording the student agreed to (ticked, read-only), and the signed application as a PDF
 * built from the submission snapshot. No signing certificate details (IP, signing key, user agent, hashes) are shown anywhere.
 * A signed application cannot be changed (database rule): to correct it, staff send it back with Action required and the student
 * signs again.
 */
export default function SignedApplicationCard({ application, compact = false }: { application: ApplicationDetail; compact?: boolean }) {
  const [copy, setCopy] = useState<SignedCopy | null | undefined>(undefined);
  const [busy, setBusy] = useState<"" | "view" | "download">("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSignedCopy(application.id).then((c) => { if (live) setCopy(c); });
    return () => { live = false; };
  }, [application.id, application.status, application.submittedAt]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  if (copy === undefined || copy === null) return null;
  const signed = copy.signatures.length > 0 || copy.declarations.length > 0;
  if (!signed) return null;
  const who = signedSummary(copy, application.studentName || "the student");
  const student = copy.signatures.find((s) => s.role === "student");
  const guardianSignature = copy.signatures.find((s) => s.role === "guardian");
  const guardian = copy.guardian ?? (guardianSignature ? { name: guardianSignature.name, relationship: null, at: guardianSignature.signedAt } : null);
  const declarations = copy.declarations.filter((d) => d.role !== "guardian");
  const fileName = `signed-application-${(copy.submission?.reference || application.reference || application.id).replace(/[^A-Za-z0-9-]/g, "")}.pdf`;

  const build = async (kind: "view" | "download") => {
    setBusy(kind); setError("");
    try {
      const bytes = await buildSignedApplicationPdf(application, copy);
      const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type: "application/pdf" }));
      if (kind === "view") { setPreview(url); return; }
      const link = document.createElement("a");
      link.href = url; link.download = fileName;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("The signed application could not be made. Try again.");
    } finally { setBusy(""); }
  };

  return (
    <section className="mb-4 rounded-card border border-emerald-200 bg-background-50 p-5" data-testid="signed-application">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <i className="ri-quill-pen-fill text-lg text-emerald-700" aria-hidden="true" />
            <h2 className="font-heading text-lg font-semibold">Signed</h2>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-2xs font-semibold uppercase text-emerald-900">Read-only</span>
          </div>
          <p className="mt-1 text-sm text-foreground-800" data-testid="signed-by">Signed by <span className="font-semibold">{who.name}</span> on {day(who.at)}</p>
          {copy.formTemplate ? <p className="mt-0.5 text-xs text-foreground-500" data-testid="signed-form-template">Printed from the application form “{copy.formTemplate.name}”{copy.formTemplate.version ? ` (version ${copy.formTemplate.version})` : ""}, as it was when the student signed.</p> : null}
          {copy.storedCopy ? <p className="mt-0.5 text-xs text-foreground-500" data-testid="signed-stored">The signed application was emailed to the student, the agent and SLIT admissions, and is kept here.</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!compact ? (
            <button type="button" disabled={Boolean(busy)} onClick={() => void build("view")}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 disabled:opacity-60">
              <i className="ri-eye-line" aria-hidden="true" />{busy === "view" ? "Preparing…" : "View"}
            </button>
          ) : null}
          <button type="button" disabled={Boolean(busy)} onClick={() => void build("download")} data-testid="signed-download"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-xs font-semibold text-background-50 hover:bg-primary-600 disabled:opacity-60">
            <i className="ri-file-pdf-2-line" aria-hidden="true" />{busy === "download" ? "Preparing…" : "Download signed application (PDF)"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <figure className="rounded-lg border border-background-200 bg-white p-3" data-testid="signed-student">
          <figcaption className="text-xs font-semibold text-foreground-600">Student</figcaption>
          {student ? <img src={student.png} alt={`Signature of ${student.name}`} className="mt-1 h-16 max-w-full object-contain" />
            : <p className="mt-1 text-xs text-foreground-600">Signed by ticking the declarations (before drawn signatures were added).</p>}
          <p className="mt-1 text-xs text-foreground-700">{student?.name || who.name} · {day(student?.signedAt || who.at)}</p>
        </figure>
        {guardian ? (
          <figure className="rounded-lg border border-background-200 bg-white p-3" data-testid="signed-guardian">
            <figcaption className="text-xs font-semibold text-foreground-600">Parent / guardian</figcaption>
            {guardianSignature ? <img src={guardianSignature.png} alt={`Signature of ${guardianSignature.name}`} className="mt-1 h-16 max-w-full object-contain" />
              : <p className="mt-1 text-xs text-foreground-600">Not signed yet.</p>}
            <p className="mt-1 text-xs text-foreground-700">{guardianSignature?.name || guardian.name}{guardian.relationship ? ` (${guardian.relationship})` : ""}{guardianSignature ? ` · ${day(guardianSignature.signedAt)}` : ""}</p>
          </figure>
        ) : null}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-foreground-900">Declarations agreed</h3>
      <ul className="mt-2 space-y-2" data-testid="signed-declarations">
        {declarations.map((d) => (
          <li key={`${d.key}-${d.at}`} className="rounded-lg border border-background-200 bg-white p-3">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked readOnly disabled className="mt-1 h-4 w-4 accent-emerald-600" aria-label={`${d.title}: agreed`} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground-900">{d.title}</span>
                {!compact && d.body ? <span className="mt-1 block max-h-48 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-foreground-700" data-testid="signed-declaration-text">{d.body}</span> : null}
                {!d.body ? <span className="mt-1 block text-xs text-foreground-500">The wording of this version is not stored.</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-foreground-500">This application is signed and cannot be changed. To correct it, SLIT admissions sends it back with Action required: the student corrects it and signs again. The student's own record can still be updated.</p>
      {error ? <p role="alert" className="mt-2 text-sm text-red-800">{error}</p> : null}
      {preview ? <DocumentPreviewModal url={preview} filename={fileName} onClose={() => setPreview(null)} onDownload={() => { setPreview(null); void build("download"); }} /> : null}
    </section>
  );
}
