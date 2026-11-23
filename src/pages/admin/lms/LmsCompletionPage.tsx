import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { bestIntake, rto, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";
import type { Completion } from "@/pages/CertificatePage";
import SearchableSelect from "@/components/ui/SearchableSelect";

type Unit = { code: string; name: string; outcome: string | null; date: string | null };
type Row = { enrolmentId: string; studentId: string; studentName: string; enrolmentStatus: string; units: Unit[]; completions: Completion[] };

const select = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
const btn = "rounded-md border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50";

/** LMS > Completion: each student's unit results in an intake; issue a Certificate (every unit Competent) or a Statement of Attainment. */
export default function LmsCompletionPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list")])
      .then(([c, i]) => { setCourses(c); setIntakes(i); setCourseId(c[0]?.id ?? ""); }).catch((e) => setError(e.message));
  }, []);
  const courseIntakes = useMemo(() => intakes.filter((i) => i.courseId === courseId && (i.batchList?.length ?? 0) > 0), [intakes, courseId]);
  useEffect(() => { setIntakeId((o) => (courseIntakes.some((i) => i.id === o) ? o : bestIntake(courseIntakes))); }, [courseIntakes]);
  // The intake is the class group: its id is what course_completion_list calls p_batch.
  const batchId = courseIntakes.find((i) => i.id === intakeId)?.batchList?.[0]?.id ?? "";

  const load = useCallback(async () => {
    if (!batchId) { setRows([]); return; }
    const { data, error: e } = await supabase.rpc("course_completion_list", { p_batch: batchId });
    if (e) setError(e.message); else setRows((data ?? []) as Row[]);
  }, [batchId]);
  useEffect(() => { setRows(null); void load(); }, [load]);

  const issue = async (r: Row, kind: "certificate" | "statement") => {
    setBusy(r.enrolmentId + kind); setError(""); setMessage("");
    const { data, error: e } = await supabase.rpc("course_completion_issue", { p_enrolment: r.enrolmentId, p_kind: kind });
    setBusy("");
    if (e) { setError(e.message); return; }
    setMessage(`${kind === "certificate" ? "Certificate" : "Statement of attainment"} ${(data as Completion).certificateNo} issued for ${r.studentName}.`);
    void load();
  };
  const revoke = async (r: Row, c: Completion) => {
    const reason = window.prompt(`Why revoke ${c.certificateNo} for ${r.studentName}?`);
    if (!reason) return;
    setBusy(c.id); setError(""); setMessage("");
    const { error: e } = await supabase.rpc("course_completion_revoke", { p_id: c.id, p_reason: reason });
    setBusy("");
    if (e) setError(e.message); else { setMessage(`${c.certificateNo} revoked.`); void load(); }
  };

  return (
    <div className="mx-auto max-w-[1300px] space-y-5 pb-12">
      <header>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Completion &amp; certificates</h1>
        <p className="text-sm text-foreground-500">When every unit is marked Competent, issue the certificate and record of results. A statement of attainment lists the units achieved so far. RTO Managers issue and revoke.</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-foreground-500">Course<SearchableSelect className={select + " mt-1"} value={courseId} onChange={(e) => setCourseId(e.target.value)}>{courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</SearchableSelect></label>
        <label className="text-xs font-semibold text-foreground-500">Intake<SearchableSelect className={select + " mt-1"} value={intakeId} onChange={(e) => setIntakeId(e.target.value)}>{courseIntakes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</SearchableSelect></label>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {message ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p> : null}
      <section className="rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
        {!batchId ? <p className="py-8 text-center text-sm text-foreground-500">No intake of this course has its classes set up yet (<a className="font-semibold text-primary-700 underline" href="/admin/lms/intakes">open the intakes</a>).</p> : rows === null ? <p className="py-8 text-center text-sm text-foreground-500">Loading…</p>
          : !rows.length ? <p className="py-8 text-center text-sm text-foreground-500">No students in this intake.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
                  <th className="px-3 py-2">Student</th><th className="px-3 py-2">Units competent</th><th className="px-3 py-2">Documents</th><th className="px-3 py-2">Issue</th>
                </tr></thead>
                <tbody>{rows.map((r) => {
                  const c = r.units.filter((u) => u.outcome === "C").length;
                  const all = r.units.length > 0 && c === r.units.length;
                  const has = (k: string) => r.completions.some((x) => x.kind === k);
                  return (
                    <tr key={r.enrolmentId} className="border-b border-background-100 align-top">
                      <td className="px-3 py-2"><Link to={`/admin/students/${r.studentId}`} className="font-semibold text-primary-700 hover:underline">{r.studentName}</Link>
                        <span className="block text-xs capitalize text-foreground-500">{r.enrolmentStatus}</span></td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${all ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-700"}`}>{c} of {r.units.length}</span>
                        <details className="mt-1 text-xs text-foreground-600"><summary className="cursor-pointer">Units</summary>
                          <ul className="mt-1 space-y-0.5">{r.units.map((u) => <li key={u.code + u.name}>{u.code} {u.name}: <strong className={u.outcome === "C" ? "text-green-700" : u.outcome === "NYC" ? "text-red-700" : "text-foreground-500"}>{u.outcome === "C" ? "Competent" : u.outcome === "NYC" ? "Not yet competent" : "No result"}</strong></li>)}</ul>
                        </details>
                      </td>
                      <td className="px-3 py-2">{r.completions.length ? r.completions.map((x) => (
                        <div key={x.id} className="mb-1 flex flex-wrap items-center gap-2">
                          <Link to={`/certificate/${x.id}`} target="_blank" className="font-semibold text-primary-700 hover:underline">{x.kind === "certificate" ? "Certificate" : "Statement"} {x.certificateNo}</Link>
                          <button type="button" className={btn} disabled={!!busy} onClick={() => void revoke(r, x)}>Revoke</button>
                        </div>)) : <span className="text-xs text-foreground-500">None</span>}</td>
                      <td className="px-3 py-2"><div className="flex flex-wrap gap-2">
                        <button type="button" className={btn} disabled={!!busy || !all || has("certificate") || r.enrolmentStatus === "withdrawn"} title={all ? "" : "Every unit must be Competent"} onClick={() => void issue(r, "certificate")}>{busy === r.enrolmentId + "certificate" ? "Issuing…" : "Issue certificate"}</button>
                        <button type="button" className={btn} disabled={!!busy || c === 0 || has("statement") || r.enrolmentStatus === "withdrawn"} onClick={() => void issue(r, "statement")}>{busy === r.enrolmentId + "statement" ? "Issuing…" : "Statement of attainment"}</button>
                      </div></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}
