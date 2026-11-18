// Bulk sync with the CRICOS register: every course registered to the site's provider code is linked to its CMS
// course (by CRICOS code, else qualification code) and filled, or created as a draft course; new courses then get
// their Training.gov.au details and core units through the tga-course-import sync.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import { listProviderCourses, loadCricos, lookupCricos, saveCricos, siteProviderCode, type ProviderCourse } from "@/pages/admin/lib/cricos";

type Plan = "linked" | "fill" | "create" | "conflict";
interface Row { course: ProviderCourse; plan: Plan; target: RtoCourse | null; note: string }
const aud = (value: number | null) => value === null ? "" : value.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const norm = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

function plan(course: ProviderCourse, courses: RtoCourse[]): Row {
  const linked = courses.find(c => norm(c.cricos) === course.cricos_course_code);
  if (linked) return { course, plan: "linked", target: linked, note: `Already on ${linked.code}` };
  const same = courses.find(c => course.vet_national_code && norm(c.code) === norm(course.vet_national_code));
  if (same && norm(same.cricos)) return { course, plan: "conflict", target: same, note: `${same.code} already has CRICOS ${same.cricos}` };
  if (same) return { course, plan: "fill", target: same, note: `Fill CRICOS on ${same.code}` };
  return { course, plan: "create", target: null, note: "Create a draft course" };
}

export default function CricosBulkSync({ open, courses, onClose, onDone }: {
  open: boolean; courses: RtoCourse[]; onClose: () => void; onDone: () => void;
}) {
  const [provider, setProvider] = useState("");
  const [register, setRegister] = useState<ProviderCourse[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withTga, setWithTga] = useState(true);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRegister(null); setResults({}); setError(""); setLoading(true);
    siteProviderCode().then(async code => {
      const list = await listProviderCourses(code);
      if (!live) return;
      setProvider(code); setRegister(list);
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not read the CRICOS register."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open]);

  const rows = useMemo(() => (register ?? []).map(course => plan(course, courses)), [register, courses]);
  useEffect(() => {
    setSelected(new Set(rows.filter(row => !row.course.expired && (row.plan === "fill" || row.plan === "create")).map(row => row.course.cricos_course_code)));
  }, [rows]);

  async function tgaSync(courseId: string) {
    const { data, error: syncError } = await invokeTga<{ coreAdded?: number }>({ action: "sync", courseId });
    if (syncError || !data) return "Training.gov.au details not filled (use Sync on the course).";
    return `Training.gov.au details filled${data.coreAdded ? `, ${data.coreAdded} core units added` : ""}.`;
  }

  async function run() {
    setRunning(true); setError("");
    for (const row of rows.filter(r => selected.has(r.course.cricos_course_code))) {
      const code = row.course.cricos_course_code;
      setResults(r => ({ ...r, [code]: "Working…" }));
      try {
        if (row.target) {
          const current = await loadCricos(row.target.id);
          if (current.fetchedAt) { setResults(r => ({ ...r, [code]: "Skipped: the course already has CRICOS details (use Fetch to compare)." })); continue; }
        }
        const lookup = await lookupCricos(code);
        const id = await saveCricos(row.target?.id ?? null, { fields: lookup.fields, locations: lookup.locations, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at, edited: [] });
        const detail = await rto<CourseDetail>("course_get", { courseId: id });
        if (!detail.course.duration?.trim() && typeof lookup.fields.cricos_duration_weeks === "number") {
          await rto("course_save", { courseId: id, duration: `${lookup.fields.cricos_duration_weeks} weeks` });
        }
        let message = row.target ? `CRICOS filled on ${row.target.code}.` : `Draft course ${detail.course.code} created.`;
        if (!row.target && withTga) { setResults(r => ({ ...r, [code]: message + " Filling Training.gov.au…" })); message += " " + await tgaSync(id); }
        setResults(r => ({ ...r, [code]: message }));
      } catch (e) {
        setResults(r => ({ ...r, [code]: `Failed: ${e instanceof Error ? e.message : "error"}` }));
      }
    }
    setRunning(false);
    onDone();
  }

  const toggle = (code: string, on: boolean) => setSelected(s => { const next = new Set(s); if (on) next.add(code); else next.delete(code); return next; });
  const done = Object.keys(results).length > 0 && !running;

  return <Modal open={open} title={`Sync CRICOS courses${provider ? ` · provider ${provider}` : ""}`} width="max-w-5xl" onClose={() => { if (!running) onClose(); }}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withTga} disabled={running} onChange={e => setWithTga(e.target.checked)} />
        Also fill Training.gov.au details and core units on new courses (slower)</label>
      <div className="flex gap-2">
        <Button variant="outline" disabled={running} onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
        {!done ? <Button disabled={running || loading || !selected.size} onClick={() => void run()}>{running ? "Syncing…" : `Sync ${selected.size} course${selected.size === 1 ? "" : "s"}`}</Button> : null}
      </div>
    </div>}>
    {loading ? <p className="text-sm text-foreground-500">Reading the CRICOS register…</p> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {register ? <div className="space-y-3 text-sm">
      <p className="text-foreground-600">{register.length} course{register.length === 1 ? " is" : "s are"} registered on CRICOS for {provider}. Ticked rows are filled or created as draft courses; courses that already have CRICOS details are not changed. Electives, intakes and fees are still set on each course.</p>
      <table className="w-full text-left">
        <thead><tr className="border-b border-background-200 text-xs text-foreground-500">
          <th className="py-2 pr-2" /><th className="py-2 pr-2">CRICOS</th><th className="py-2 pr-2">Course</th><th className="py-2 pr-2">Weeks</th><th className="py-2 pr-2">Total cost</th><th className="py-2">In the CMS</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.course.cricos_course_code} className="border-b border-background-100 align-top">
          <td className="py-2 pr-2"><input type="checkbox" aria-label={`Sync ${row.course.cricos_course_code}`} disabled={running || row.plan === "linked" || row.plan === "conflict"}
            checked={selected.has(row.course.cricos_course_code)} onChange={e => toggle(row.course.cricos_course_code, e.target.checked)} /></td>
          <td className="py-2 pr-2 font-semibold">{row.course.cricos_course_code}</td>
          <td className="py-2 pr-2">{row.course.vet_national_code ?? "—"} · {row.course.course_name}{row.course.expired ? <span className="ml-1 text-amber-700">(expired)</span> : null}</td>
          <td className="py-2 pr-2">{row.course.duration_weeks ?? "—"}</td>
          <td className="py-2 pr-2">{aud(row.course.total_cost)}</td>
          <td className="py-2">{results[row.course.cricos_course_code] ?? <span className={row.plan === "conflict" ? "text-amber-700" : "text-foreground-600"}>{row.note}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
  </Modal>;
}
