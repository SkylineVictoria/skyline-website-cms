import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Field, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { rto, type CourseDetail, type IntakeDetail, type IntakeStatus, type RtoUnit } from "@/pages/admin/lib/rto";

type Mode = "durations" | "fit";

/**
 * Pick a course and a start date, then the units: core units are always scheduled, electives are chosen. "Use unit durations" lays
 * each unit out for its default weeks; "Fit to end date" shares the working days up to the end date evenly. Holidays are skipped.
 */
export default function NewIntakeDrawer({ open, onClose, courses, courseId }: {
  open: boolean; onClose: () => void; courses: { id: string; label: string; campus?: string | null }[]; courseId?: string;
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ courseId: courseId ?? "", startDate: "", endDate: "", campus: "", capacity: "", status: "draft" as IntakeStatus, name: "", generate: true, mode: "durations" as Mode });
  const [units, setUnits] = useState<RtoUnit[] | null>(null);
  const [electives, setElectives] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const chosen = form.courseId || courseId || "";

  useEffect(() => {
    if (!open || !chosen) { setUnits(null); return; }
    let live = true;
    setUnits(null); setElectives(new Set());
    rto<CourseDetail>("course_get", { courseId: chosen }).then((d) => { if (live) setUnits(d.units.filter((u) => u.isActive)); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Units did not load."); });
    return () => { live = false; };
  }, [open, chosen]);

  const core = (units ?? []).filter((u) => u.unitType === "core");
  const optional = (units ?? []).filter((u) => u.unitType === "elective");
  const picked = [...core, ...optional.filter((u) => u.id && electives.has(u.id))];
  const weeks = picked.reduce((s, u) => s + (u.defaultWeeks || 0), 0);

  const save = async () => {
    if (!chosen || !form.startDate) { setError("Choose a course and a start date."); return; }
    if (form.generate && form.mode === "fit" && (!form.endDate || form.endDate < form.startDate)) { setError("Choose an end date after the start date."); return; }
    setBusy(true); setError("");
    try {
      const out = await rto<IntakeDetail>("intake_save", {
        courseId: chosen, startDate: form.startDate, campus: form.campus, capacity: form.capacity, status: form.status, name: form.name, generate: form.generate,
        unitIds: picked.map((u) => u.id), fitEnd: form.generate && form.mode === "fit" ? form.endDate : "",
      });
      onClose();
      navigate(`/admin/intakes/${out.intake.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "The intake was not created."); }
    finally { setBusy(false); }
  };

  return (
    <Drawer open={open} title="New intake" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? "Creating…" : form.generate ? "Create & generate schedule" : "Create intake"}</Button></>}>
      <ErrorNote text={error} />
      {courseId ? null : (
        <Field label="Course" required>
          <Select value={form.courseId} onChange={(e) => set({ courseId: e.target.value, campus: courses.find((c) => c.id === e.target.value)?.campus ?? form.campus })}>
            <option value="">Choose a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Start date" required><TextInput type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Campus / delivery location"><TextInput value={form.campus} onChange={(e) => set({ campus: e.target.value })} /></Field>
        <Field label="Capacity"><TextInput inputMode="numeric" value={form.capacity} onChange={(e) => set({ capacity: e.target.value.replace(/\D/g, "") })} /></Field>
      </div>
      <Field label="Status" hint="Only Open intakes are offered on the website and the enrolment form.">
        <Select value={form.status} onChange={(e) => set({ status: e.target.value as IntakeStatus })}>
          <option value="draft">Draft</option><option value="open">Open</option><option value="full">Full</option><option value="closed">Closed</option>
        </Select>
      </Field>
      <Field label="Name" hint="Leave blank for the automatic name, e.g. “BSB50120 Feb 2027 – Nov 2027”."><TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>

      <div className="space-y-3 rounded-md bg-background-100 p-3">
        <Toggle checked={form.generate} onChange={(v) => set({ generate: v })} label="Generate schedule" />
        {form.generate ? (
          <>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Schedule mode">
              {([["durations", "Use unit durations"], ["fit", "Fit to end date"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={form.mode === id} onClick={() => set({ mode: id })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${form.mode === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700"}`}>{label}</button>
              ))}
            </div>
            {form.mode === "fit" ? <Field label="End date" required hint="Working days up to this date are shared evenly between the selected units; public holidays are skipped."><TextInput type="date" value={form.endDate} min={form.startDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
              : <p className="text-xs text-foreground-500">Each unit runs for its default weeks of working days ({weeks} weeks in total), skipping confirmed public holidays.</p>}
            {!chosen ? <p className="text-xs text-foreground-500">Choose a course to see its units.</p> : units === null ? <p className="text-xs text-foreground-500">Loading units…</p> : units.length === 0 ? (
              <p className="text-xs text-foreground-500">This course has no active units yet. Add them in the course’s Units tab.</p>
            ) : (
              <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-background-200 bg-background-50 p-2">
                <p className="px-1 pb-1 text-xs font-medium text-foreground-500">{picked.length} of {units.length} units · core units are always included</p>
                {[...core, ...optional].map((u) => {
                  const isCore = u.unitType === "core", on = isCore || (u.id ? electives.has(u.id) : false);
                  return (
                    <label key={u.id} className={`flex items-center gap-2 rounded px-1 py-1 text-sm ${isCore ? "text-foreground-600" : "cursor-pointer hover:bg-background-100"}`}>
                      <input type="checkbox" checked={on} disabled={isCore} onChange={() => setElectives((s) => { const next = new Set(s); if (u.id) { if (next.has(u.id)) next.delete(u.id); else next.add(u.id); } return next; })} />
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{u.code}</span> {u.name}</span>
                      {isCore ? <i className="ri-lock-line text-foreground-400" aria-label="Core unit" /> : <Badge>Elective</Badge>}
                      <span className="text-xs tabular-nums text-foreground-500">{u.defaultWeeks}w</span>
                    </label>
                  );
                })}
              </div>
            )}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
