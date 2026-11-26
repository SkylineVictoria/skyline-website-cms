import { useEffect, useState } from "react";
import DocumentPreviewModal from "@/pages/agency/components/DocumentPreviewModal";
import { buildSignedApplicationPdf, getSignedCopy, type SignedCopy } from "@/pages/agency/lib/applicationPdf";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";

const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");

/**
 * APPLICATION-DRAWN-SIGNATURE (owner 2026-11-26: "a view like the business page to manage signed copies"): the application's signed
 * copy on the Documents tab: who signed and when, the drawn signature(s), the declarations agreed, View (on the page) / Download of the
 * signed PDF. To change a submitted application: Take action › Action required sends it back; the student signs again (a new copy).
 */
export default function SignedApplicationCard({ application }: { application: ApplicationDetail }) {
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
  const fileName = `signed-application-${(application.reference || application.id).replace(/[^A-Za-z0-9-]/g, "")}.pdf`;

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
      setError("The signed copy could not be made. Try again.");
    } finally { setBusy(""); }
  };

  return (
    <section className="mb-4 rounded-card border border-background-200 bg-background-50 p-5" data-testid="signed-application">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Signed application</h2>
          <p className="text-sm text-foreground-600">{signed
            ? `Signed by ${copy.signatures[0]?.name || copy.handoff?.signedBy || copy.declarations[0]?.name || "the student"} on ${when(copy.signatures[0]?.signedAt || copy.handoff?.signedAt || copy.declarations[0]?.at)}`
            : "Not signed yet. The student signs on the last screen of the application."}</p>
        </div>
        {signed ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => void build("view")} className="rounded border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 disabled:opacity-50" data-testid="signed-view">{busy === "view" ? "Preparing…" : "View signed copy"}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void build("download")} className="rounded border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 disabled:opacity-50" data-testid="signed-download">{busy === "download" ? "Preparing…" : "Download"}</button>
          </div>
        ) : null}
      </div>
      {signed ? (
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-3">
            {copy.signatures.length ? copy.signatures.map((s) => (
              <div key={s.role} className="rounded-lg border border-background-200 bg-white p-3">
                <p className="text-xs font-semibold text-foreground-600">{s.role === "guardian" ? "Parent / guardian" : "Student"}</p>
                <img src={s.png} alt={`Signature of ${s.name}`} className="mt-1 h-16 max-w-full object-contain" />
                <p className="mt-1 text-xs text-foreground-700">{s.name} · {when(s.signedAt)}{s.ip ? ` · ${s.ip}` : ""}</p>
              </div>
            )) : <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Signed before drawn signatures were added: the declarations below are the signature record.</p>}
          </div>
          <ul className="space-y-1.5 text-sm">
            {copy.declarations.map((d) => (
              <li key={`${d.key}-${d.role}-${d.at}`} className="flex items-start gap-2">
                <i className="ri-checkbox-circle-fill mt-0.5 text-emerald-600" aria-hidden="true" />
                <span><span className="font-medium text-foreground-900">{d.title}</span>
                  <span className="block text-xs text-foreground-500">{d.guardian ? `${d.guardian} (parent / guardian)` : d.name} · {when(d.at)}{d.ip ? ` · ${d.ip}` : ""}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {signed ? <p className="mt-3 text-xs text-foreground-500">To change the signed application, use Take action › Action required: it goes back to the student, who corrects it and signs again (a new signed copy).</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-red-800">{error}</p> : null}
      {preview ? <DocumentPreviewModal url={preview} filename={fileName} onClose={() => setPreview(null)} onDownload={() => { setPreview(null); void build("download"); }} /> : null}
    </section>
  );
}
