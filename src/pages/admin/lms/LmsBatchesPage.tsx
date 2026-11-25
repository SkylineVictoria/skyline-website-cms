import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import SearchableSelect from "@/components/ui/SearchableSelect";
import IntakeBatchesPanel from "@/pages/admin/components/rto/IntakeBatchesPanel";
import { bestIntake, rto, type IntakeDetail, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

const select = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";

/**
 * LMS > Batches (owner 2026-11-25): the class batches (B1 / B2 / B3) of an intake on their own page: pick the course and the intake,
 * then the same panel as the intake sheet's Batches tab (batches, class times, classes, students and their batches).
 * ?intake=<id> opens that intake directly.
 */
export default function LmsBatchesPage() {
  const [query, setQuery] = useSearchParams();
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [role, setRole] = useState({ rtoManager: false, admin: false });
  const [courseId, setCourseId] = useState("");
  const [units, setUnits] = useState<{ unitId: string; code: string }[]>([]);
  const [error, setError] = useState("");
  const intakeId = query.get("intake") ?? "";

  useEffect(() => {
    Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{ rtoManager: boolean; admin: boolean }>("me")])
      .then(([c, i, me]) => {
        setCourses(c); setIntakes(i); setRole(me);
        const fromUrl = i.find((x) => x.id === query.get("intake"));
        setCourseId(fromUrl?.courseId ?? c.find((x) => i.some((y) => y.courseId === x.id))?.id ?? c[0]?.id ?? "");
      })
      .catch((e: Error) => setError(e.message));
    // Loaded once; the intake in the address is read on the first load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const courseIntakes = useMemo(() => intakes.filter((i) => i.courseId === courseId), [intakes, courseId]);
  const setIntake = (id: string) => setQuery((q) => { const n = new URLSearchParams(q); if (id) n.set("intake", id); else n.delete("intake"); return n; }, { replace: true });
  useEffect(() => {
    if (!courseId || !intakes.length) return;
    if (!courseIntakes.some((i) => i.id === intakeId)) setIntake(bestIntake(courseIntakes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, courseIntakes]);

  useEffect(() => {
    setUnits([]);
    if (!intakeId) return;
    let live = true;
    rto<IntakeDetail>("intake_get", { intakeId })
      .then((d) => { if (live) setUnits(d.schedule.map((r) => ({ unitId: r.unitId, code: r.code }))); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [intakeId]);

  const canEdit = role.rtoManager;
  const canAssign = role.rtoManager || role.admin;

  return (
    <div className="mx-auto max-w-[1300px] space-y-5 pb-12">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Batches</h1>
        <p className="mt-1 text-sm text-foreground-600">Class batches of an intake: their class times, classes and students. Unit dates follow the intake&apos;s master timetable.</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-foreground-700">Course
          <SearchableSelect className={`mt-1 ${select}`} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </SearchableSelect>
        </label>
        <label className="block text-xs font-semibold text-foreground-700">Intake
          <SearchableSelect className={`mt-1 ${select}`} value={intakeId} onChange={(e) => setIntake(e.target.value)} disabled={!courseIntakes.length}>
            {courseIntakes.length ? null : <option value="">No intakes for this course</option>}
            {courseIntakes.map((i) => <option key={i.id} value={i.id}>{i.name || i.startDate}</option>)}
          </SearchableSelect>
        </label>
      </div>

      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {intakeId ? (
        <div className="rounded-card border border-background-200 bg-background-50 p-4">
          <IntakeBatchesPanel key={intakeId} intakeId={intakeId} canEdit={canEdit} canAssign={canAssign} units={units} />
        </div>
      ) : courseId && !courseIntakes.length ? (
        <p className="text-sm text-foreground-600">This course has no intakes yet. Add one under LMS › Intakes; its first batch B1 is made automatically.</p>
      ) : null}
    </div>
  );
}
