import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

interface ImportedDocument { id: string; document_type: string | null; title: string | null; file_name: string; mime_type: string; file_size: number; storage_path: string; added_in_source: string | null; imported_at: string }

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (v: string | null) => (v ? new Date(`${v.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" }) : "—");
const icon = (mime: string) => (mime === "application/pdf" ? "ri-file-pdf-2-line" : mime.startsWith("image/") ? "ri-image-line" : "ri-file-text-line");

/**
 * Student › Documents (AXCELERATE-DOCUMENTS): the student's files from aXcelerate's portfolio (passport, visa, English test, certificates ...),
 * kept as aXcelerate had them; Refresh from aXcelerate brings new ones. Staff only; each opens through a short-lived private link.
 */
export default function StudentImportedDocuments({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<ImportedDocument[] | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  useEffect(() => {
    let live = true;
    void supabase.from("student_external_documents").select("id,document_type,title,file_name,mime_type,file_size,storage_path,added_in_source,imported_at")
      .eq("student_id", studentId).order("document_type").order("file_name")
      .then(({ data, error: e }) => { if (!live) return; if (e) { setError(e.message); setRows([]); } else setRows((data ?? []) as ImportedDocument[]); });
    return () => { live = false; };
  }, [studentId]);
  const open = async (d: ImportedDocument) => {
    setOpening(d.id); setError("");
    const { data, error: e } = await supabase.storage.from("axcelerate-documents").createSignedUrl(d.storage_path, 120);
    setOpening("");
    if (e || !data?.signedUrl) { setError(e?.message ?? "The file could not be opened."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  return <section className="rounded-xl border border-background-200 bg-background-50" data-testid="student-imported-documents">
    <h3 className="flex items-center gap-2 border-b border-background-200 px-4 py-3 font-heading text-sm font-semibold text-foreground-900">
      <i className="ri-folder-download-line text-primary-600" aria-hidden="true" />From aXcelerate
      {rows?.length ? <span className="font-normal text-foreground-500">{rows.length}</span> : null}
    </h3>
    {error ? <p role="alert" className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    {!rows ? <p className="px-4 py-3 text-sm text-foreground-500">Loading…</p>
      : !rows.length ? <p className="px-4 py-3 text-sm text-foreground-600">No documents from aXcelerate yet. Use Refresh from aXcelerate to bring the student's portfolio files.</p>
      : <ul className="divide-y divide-background-200">{rows.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <i className={icon(d.mime_type) + " text-xl text-foreground-500"} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground-950">{d.document_type || d.title || "Document"}</span>
          <span className="block truncate text-xs text-foreground-500">{d.file_name} · {size(d.file_size)} · added {day(d.added_in_source ?? d.imported_at)}</span>
        </span>
        <button type="button" disabled={opening === d.id} onClick={() => void open(d)}
          className="inline-flex items-center gap-1 rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">
          <i className="ri-external-link-line" aria-hidden="true" />{opening === d.id ? "Opening…" : "Open"}</button>
      </li>)}</ul>}
  </section>;
}
