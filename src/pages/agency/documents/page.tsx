import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { supabase } from "@/pages/admin/lib/supabase";
import { getDocumentSignedUrl, listApplicationDocuments, listApplications, type ApplicationListRow, type DocumentRow } from "@/pages/agency/lib/portalApplications";

const PdfPages = lazy(() => import("@/components/signing/PdfPages"));
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function PortalDocumentsPage() {
  const [apps, setApps] = useState<ApplicationListRow[]>([]);
  const [docs, setDocs] = useState<Array<DocumentRow & { application: ApplicationListRow }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [opening, setOpening] = useState("");
  /** The document shown in the page (owner, 2026-11-23: preview in the browser, not a download). */
  const [viewing, setViewing] = useState<{ doc: DocumentRow; url: string; bytes: Uint8Array | null } | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const applications = await listApplications();
      const perApplication = await Promise.all(applications.map(async (application) => (await listApplicationDocuments(application.id)).map((doc) => ({ ...doc, application }))));
      setApps(applications); setDocs(perApplication.flat());
    } catch (e) { setError(e instanceof Error ? e.message : "We could not load your documents."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Preview shows the file inside the page (PDF pages or the picture); Download saves it. A short-lived link is made on each click. */
  const openFile = async (doc: DocumentRow, download: boolean) => {
    setFileError(""); setOpening(doc.id + (download ? ":d" : ""));
    try {
      if (download) {
        const url = await getDocumentSignedUrl(doc.storagePath, 300, doc.filename);
        if (!url) throw new Error("The file could not be opened.");
        window.location.href = url;
        return;
      }
      // The file is read here and handed to the viewer (no second fetch by the viewer, which can be refused).
      const { data, error } = await supabase.storage.from("enrollment-documents").download(doc.storagePath);
      if (error || !data) throw new Error(error?.message || "The file could not be read.");
      const bytes = new Uint8Array(await data.arrayBuffer());
      setViewing(old => { if (old?.url.startsWith("blob:")) URL.revokeObjectURL(old.url); return { doc, url: URL.createObjectURL(new Blob([bytes], { type: doc.mimeType || data.type })), bytes }; });
    } catch (e) {
      setFileError(`${doc.filename}: ${e instanceof Error ? e.message : "the file could not be opened."}`);
    } finally { setOpening(""); }
  };
  const isPdf = (doc: DocumentRow) => doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.filename);
  const isImage = (doc: DocumentRow) => doc.mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(doc.filename);
  useEffect(() => {
    if (!viewing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setViewing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  const button = "rounded-lg border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50";
  return (
    <div>
      <PageHeading eyebrow="Documents" title="Documents" description="The documents uploaded with your applications. Preview or download any of them." />
      <div className="mt-6 space-y-3">
        {loading ? <PortalLoading label="Loading your documents…" /> : null}
        {error ? <PortalError message={error} /> : null}
        {fileError ? <PortalError message={fileError} /> : null}
        {!loading && !error && docs.length === 0 ? <div className="rounded-card border border-dashed border-background-300 p-6 text-sm text-foreground-600">No documents are attached to your {apps.length} application{apps.length === 1 ? "" : "s"} yet.</div> : null}
        {!loading && !error && docs.length > 0 ? <div className="rounded-card border border-background-200 bg-background-50"><ResponsiveTable>
          <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-700"><tr>
            <th className="px-4 py-3">Document</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">Uploaded</th><th className="px-4 py-3">File</th>
          </tr></thead>
          <tbody>{docs.map((doc) => {
            return <tr key={doc.id} className="border-t border-background-200 align-top">
              <td className="px-4 py-3"><p className="break-all font-medium">{doc.filename}</p>
                <p className="text-xs text-foreground-500">{doc.category}{doc.fileSize ? ` · ${size(doc.fileSize)}` : ""}{doc.isCurrent ? "" : " · older version"}</p></td>
              <td className="px-4 py-3"><Link className="font-semibold text-primary-700 hover:underline" to={`/agency/applications/${doc.application.id}`}>{doc.application.reference || "Open application"}</Link></td>
              <td className="px-4 py-3 text-xs text-foreground-700">{doc.createdAt ? new Date(doc.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}</td>
              <td className="px-4 py-3"><div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={!doc.storagePath || !!opening} onClick={() => void openFile(doc, false)}>{opening === doc.id ? "Opening…" : "Preview"}</button>
                <button type="button" className={button} disabled={!doc.storagePath || !!opening} onClick={() => void openFile(doc, true)}>{opening === doc.id + ":d" ? "Preparing…" : "Download"}</button>
              </div></td>
            </tr>;
          })}</tbody>
        </ResponsiveTable></div> : null}
      </div>
      {viewing ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={() => setViewing(null)}>
        <div role="dialog" aria-modal="true" aria-label={`Preview of ${viewing.doc.filename}`} className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-background-50 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
            <p className="min-w-0 truncate text-sm font-semibold">{viewing.doc.filename}</p>
            <div className="flex shrink-0 gap-2">
              <button type="button" className={button} onClick={() => void openFile(viewing.doc, true)}>Download</button>
              <button type="button" className={button} onClick={() => setViewing(null)} aria-label="Close preview">Close</button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-background-200 p-3">
            {isPdf(viewing.doc) ? <Suspense fallback={<p className="p-6 text-center text-sm text-foreground-600">Loading the document…</p>}><PdfPages source={viewing.bytes ?? viewing.url} /></Suspense>
              : isImage(viewing.doc) ? <img src={viewing.url} alt={viewing.doc.filename} className="mx-auto max-h-[75vh] max-w-full rounded bg-white object-contain" />
              : <p className="p-6 text-center text-sm text-foreground-700">This file type cannot be shown in the browser. Use Download to open it.</p>}
          </div>
        </div>
      </div> : null}
    </div>
  );
}
