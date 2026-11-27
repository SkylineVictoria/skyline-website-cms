import { useEffect, useState } from "react";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { supabase } from "@/pages/admin/lib/supabase";
import { DOCUMENT_KIND_LABELS, formatQualificationDate, openQualificationDocument, qualificationTone, type PortalQualification } from "@/lib/qualification";

type MyQualification = PortalQualification & { type: string };

/** Student portal › My qualification: each course the student is enrolled in (status, intake, dates) and the documents they may see. */
export default function MyQualificationPage() {
  const [rows, setRows] = useState<MyQualification[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void supabase.rpc("portal_my_qualifications").then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(e.message); setRows([]); return; }
      setError(""); setRows((data ?? []) as MyQualification[]);
    });
    return () => { live = false; };
  }, [reload]);
  const open = (id: string) => { void openQualificationDocument(id).catch((e) => setError(e instanceof Error ? e.message : String(e))); };
  return (
    <div data-testid="my-qualification">
      <PageHeading eyebrow="Study" title="My qualification" description="The course you are enrolled in, its intake, your status and dates, and your documents." />
      <div className="mt-5 space-y-4">
        {error ? <PortalError message={error} onRetry={() => setReload((n) => n + 1)} /> : null}
        {rows === null ? <PortalLoading label="Loading your qualification…" />
          : rows.length === 0 ? <PortalEmpty icon="ri-graduation-cap-line" title="No qualification yet" message="Your qualification appears here once you are enrolled in a course." />
          : rows.map((q) => (
            <section key={q.id} className="rounded-card border border-background-200 bg-background-50 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="font-heading text-base font-semibold text-foreground-900">{[q.courseCode, q.courseName].filter(Boolean).join(" ")}</h2>
                  {q.intakeName ? <p className="text-sm text-foreground-600">{q.intakeName}</p> : null}
                </div>
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${qualificationTone(q.status)}`}>{q.label}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-foreground-500">Start</dt><dd className="text-foreground-900">{formatQualificationDate(q.startDate) || "Not set"}</dd></div>
                <div><dt className="text-xs text-foreground-500">End</dt><dd className="text-foreground-900">{formatQualificationDate(q.endDate) || "Not set"}</dd></div>
                {q.resumeDate ? <div><dt className="text-xs text-foreground-500">Resumes</dt><dd className="text-foreground-900">{formatQualificationDate(q.resumeDate)}</dd></div> : null}
              </dl>
              {q.documents.length ? (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {q.documents.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => open(d.id)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-background-300 px-2.5 py-1.5 text-xs text-foreground-800 hover:bg-background-100">
                        <i className="ri-file-download-line" aria-hidden="true" />{d.title}<span className="text-foreground-500">({DOCUMENT_KIND_LABELS[d.kind] ?? d.kind})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-3 text-xs text-foreground-500">No documents yet.</p>}
            </section>
          ))}
      </div>
    </div>
  );
}
