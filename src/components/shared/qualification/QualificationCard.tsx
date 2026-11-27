import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  DOCUMENT_KIND_LABELS, formatQualificationDate, openQualificationDocument, portalQualifications, qualificationTone, type PortalQualification,
} from "@/lib/qualification";

/**
 * QUALIFICATION on an application (staff, agent and student): shown once the application has a Qualification (from Enrolled).
 * Status, dates and the documents the student may see; staff get a link to the full Qualification. No reasons or internal notes.
 */
export default function QualificationCard({ applicationId, staffLink = false, refreshKey }: { applicationId: string; staffLink?: boolean; refreshKey?: string }) {
  const [rows, setRows] = useState<PortalQualification[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    portalQualifications(applicationId).then((data) => { if (live) { setRows(data ?? []); setError(""); } }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [applicationId, refreshKey]);
  if (!rows.length && !error) return null;
  const open = (id: string) => { void openQualificationDocument(id).catch((e) => setError(e instanceof Error ? e.message : String(e))); };
  return (
    <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-4" data-testid="qualification-card">
      <h2 className="flex items-center gap-2 font-heading text-base font-semibold text-foreground-900"><i className="ri-graduation-cap-line" aria-hidden="true" />Qualification</h2>
      {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
      <ul className="mt-3 space-y-3">
        {rows.map((q) => (
          <li key={q.id} className="rounded-md border border-background-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground-900">{[q.courseCode, q.courseName].filter(Boolean).join(" ")}</p>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${qualificationTone(q.status)}`} data-testid="qualification-status">{q.label}</span>
            </div>
            <p className="mt-1 text-xs text-foreground-600">
              {q.intakeName ? <>{q.intakeName} · </> : null}
              Start {formatQualificationDate(q.startDate) || "not set"}{q.endDate ? ` · End ${formatQualificationDate(q.endDate)}` : ""}
              {q.resumeDate ? ` · Resumes ${formatQualificationDate(q.resumeDate)}` : ""}
            </p>
            {q.documents.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {q.documents.map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => open(d.id)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-background-300 px-2 py-1 text-xs text-foreground-800 hover:bg-background-100">
                      <i className="ri-file-download-line" aria-hidden="true" />{d.title}<span className="text-foreground-500">({DOCUMENT_KIND_LABELS[d.kind] ?? d.kind})</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {staffLink ? <Link to={`/admin/qualifications/${q.id}`} className="mt-2 inline-block text-sm font-semibold text-primary-700 hover:underline">Open Qualification</Link> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
