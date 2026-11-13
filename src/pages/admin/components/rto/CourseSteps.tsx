// The course wizard's steps (Details, Units & Timetable, Website): the former Master Data course tabs, with autosave.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, EmptyState, Field, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { courseCategories } from "@/pages/admin/lib/seed";
import { mayRefresh, useAutosave } from "@/pages/admin/lib/useAutosave";
import { money, shortDate, stepPath, type CourseDetail, type CourseStep, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

function SaveHint({ autosave, busy, dirty, onSave, disabled, label }: { autosave: boolean; busy: boolean; dirty: boolean; onSave: () => void; disabled: boolean; label: string }) {
  if (autosave) return <p className="text-xs text-foreground-500">{busy ? "Saving…" : dirty ? "Changes are saved automatically." : "All changes saved."}</p>;
  return <Button disabled={busy || !dirty || disabled} onClick={onSave}>{busy ? "Saving…" : label}</Button>;
}

/** Details: the course's facts (name, codes, category, duration, campus, active). */
export function CourseFacts({ course, readOnly, busy, onSave, autosave = false }: {
  course: RtoCourse; readOnly: boolean; busy: boolean; onSave: (data: Record<string, unknown>) => void; autosave?: boolean;
}) {
  const initial = { name: course.name, variantLabel: course.variantLabel ?? "", code: course.code, cricos: course.cricos, category: course.category, trainingPackage: course.trainingPackage, duration: course.duration,
    mode: course.mode, campus: course.campus ?? "", tgaUrl: course.tgaUrl ?? "", isActive: course.isActive };
  const [form, setForm] = useState(initial);
  const formRef = useRef(form);
  formRef.current = form;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const sent = useAutosave(form, { enabled: autosave && !readOnly, dirty, valid: Boolean(form.name.trim()), save: (v) => onSave(v) });
  useEffect(() => { if (mayRefresh(sent, formRef.current)) setForm(initial); sent.current = null; }, [course]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Card className="p-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Course name" required><TextInput disabled={readOnly} value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field></div>
        <Field label="Variant" hint="Optional, e.g. 52 weeks. Shown after the name wherever the course is picked or printed."><TextInput disabled={readOnly} value={form.variantLabel} onChange={(e) => set({ variantLabel: e.target.value })} /></Field>
        <Field label="Course code"><TextInput disabled={readOnly} value={form.code} onChange={(e) => set({ code: e.target.value })} /></Field>
        <Field label="CRICOS code"><TextInput disabled={readOnly} value={form.cricos} onChange={(e) => set({ cricos: e.target.value })} /></Field>
        <Field label="Category">
          <Select disabled={readOnly} value={form.category} onChange={(e) => set({ category: e.target.value })}>
            {form.category && !courseCategories.includes(form.category) ? <option value={form.category}>{form.category}</option> : null}
            {form.category ? null : <option value="">Choose a category</option>}
            {courseCategories.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </Field>
        <Field label="Training package"><TextInput disabled={readOnly} value={form.trainingPackage} onChange={(e) => set({ trainingPackage: e.target.value })} /></Field>
        <Field label="Duration" hint="As shown to students, e.g. 52 weeks."><TextInput disabled={readOnly} value={form.duration} onChange={(e) => set({ duration: e.target.value })} /></Field>
        <Field label="Delivery mode"><TextInput disabled={readOnly} value={form.mode} onChange={(e) => set({ mode: e.target.value })} /></Field>
        <Field label="Campus"><TextInput disabled={readOnly} value={form.campus} onChange={(e) => set({ campus: e.target.value })} /></Field>
        <Field label="training.gov.au link"><TextInput disabled={readOnly} value={form.tgaUrl} placeholder="https://training.gov.au/…" onChange={(e) => set({ tgaUrl: e.target.value })} /></Field>
        <div className="md:col-span-2"><Toggle disabled={readOnly} checked={form.isActive} onChange={(v) => set({ isActive: v })} label="Active (offered for new intakes and enrolments)" /></div>
      </div>
      {readOnly ? null : <div className="mt-5 flex justify-end"><SaveHint autosave={autosave} busy={busy} dirty={dirty} disabled={!form.name.trim()} label="Save course" onSave={() => onSave(form)} /></div>}
    </Card>
  );
}

/** The master timetable at a glance: each active unit as a bar as long as its weeks, in delivery order. */
export function TimetablePreview({ units }: { units: RtoUnit[] }) {
  const active = units.filter((u) => u.isActive && u.code.trim());
  const weeks = active.reduce((s, u) => s + (u.defaultWeeks || 0), 0);
  const core = active.filter((u) => u.unitType === "core").reduce((s, u) => s + (u.defaultWeeks || 0), 0);
  const hours = active.reduce((s, u) => s + (u.nominalHours ?? 0), 0);
  if (!active.length) return null;
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-sm font-semibold text-foreground-950">Master timetable</h3>
        <p className="text-xs text-foreground-600"><strong className="text-foreground-900">{weeks} weeks</strong> (about {Math.round(weeks / 4.345)} months) · {active.length} units{hours ? ` · ${hours} hours` : ""}{core !== weeks ? ` · core only ${core} weeks` : ""}</p>
      </div>
      <div className="flex h-6 w-full overflow-hidden rounded" role="img" aria-label={`${weeks} weeks across ${active.length} units`}>
        {active.map((u, i) => (
          <div key={u.id ?? `n${i}`} title={`${u.code} · ${u.defaultWeeks} weeks${u.unitType === "elective" ? " · elective" : ""}`}
            className={`h-full border-r border-background-50 last:border-0 ${u.unitType === "elective" ? "bg-secondary-300" : "bg-primary-400"}`} style={{ width: `${(u.defaultWeeks / weeks) * 100}%` }} />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-foreground-500">Each new intake is generated from this list: active units in this order, each for its weeks of working days, skipping public holidays.</p>
    </Card>
  );
}

/** "2", "2.5" -> weeks in half steps (0.5 to 104), else null. */
const halfWeeks = (text: string) => { const n = Number(text); return Number.isFinite(n) && n >= 0.5 && n <= 104 && Math.round(n * 2) === n * 2 ? n : null; };
/** Weeks with half weeks: the text is kept while typing ("2.") and the number is passed on when it is a valid length. */
function WeeksInput({ value, onChange, disabled }: { value: number; onChange: (weeks: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (halfWeeks(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TextInput disabled={disabled} inputMode="decimal" aria-label="Weeks" value={text} title="Weeks; half weeks allowed (e.g. 1.5)"
      className={halfWeeks(text) === null ? "border-primary-500" : ""}
      onChange={(e) => { const t = e.target.value.replace(/[^\d.]/g, ""); setText(t); const w = halfWeeks(t); if (w !== null) onChange(w); }} />
  );
}

/** Units & Timetable: the course's master timetable (units with weeks and hours, order, core / elective, active). */
export function UnitsTab({ units, readOnly, busy, onSave, autosave = false }: { units: RtoUnit[]; readOnly: boolean; busy: boolean; onSave: (units: RtoUnit[]) => void; autosave?: boolean }) {
  const [rows, setRows] = useState<RtoUnit[]>(units);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkWeeks, setBulkWeeks] = useState("");
  const dirty = JSON.stringify(rows) !== JSON.stringify(units);
  const invalid = rows.some((u) => !u.code.trim() || !u.name.trim() || !(u.defaultWeeks >= 0.5));
  const sent = useAutosave(rows, { enabled: autosave && !readOnly, dirty, valid: !invalid, save: (v) => onSave(v), delay: 1500 });
  useEffect(() => {
    if (mayRefresh(sent, rowsRef.current)) setRows(units);
    else if (sent.current) {
      // Typed on while saving: keep the edits, and give the units that were new when sent the ids the server made.
      const was = JSON.parse(sent.current) as RtoUnit[];
      setRows((list) => list.map((r, i) => (r.id || was[i]?.id || !units[i]?.id ? r : { ...r, id: units[i].id })));
    }
    sent.current = null;
    setSelected(new Set());
  }, [units]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSel = (i: number) => setSelected((s) => { const next = new Set(s); if (next.has(i)) next.delete(i); else next.add(i); return next; });
  const applyWeeks = () => { const w = halfWeeks(bulkWeeks); if (w === null) return; setRows((list) => list.map((u, x) => (selected.has(x) ? { ...u, defaultWeeks: w } : u))); setSelected(new Set()); setBulkWeeks(""); };
  const set = (i: number, patch: Partial<RtoUnit>) => setRows((list) => list.map((u, x) => (x === i ? { ...u, ...patch } : u)));
  const remove = (i: number) => setRows((list) => (list[i].scheduled ? list.map((u, x) => (x === i ? { ...u, isActive: false } : u)) : list.filter((_, x) => x !== i)));
  const drop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    setRows((list) => { const next = [...list]; const [moved] = next.splice(dragFrom, 1); next.splice(to, 0, moved); return next; });
    setDragFrom(null); setSelected(new Set());
  };
  return (
    <div className="space-y-3">
      <TimetablePreview units={rows} />
      <Card className="p-0">
        {readOnly || rows.length === 0 ? null : (
          <div className="sticky top-0 z-[1] flex flex-wrap items-center gap-2 border-b border-background-200 bg-background-50 px-4 py-2 text-sm">
            <label className="flex items-center gap-1.5"><input type="checkbox" aria-label="Select all units" checked={selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((_, x) => x)) : new Set())} />{selected.size ? `${selected.size} selected` : "Select"}</label>
            {selected.size ? (<><span className="text-foreground-500">Set weeks to</span><TextInput inputMode="numeric" className="w-20" aria-label="Weeks for selected units" value={bulkWeeks} onChange={(e) => setBulkWeeks(e.target.value.replace(/[^\d.]/g, ""))} /><Button size="sm" variant="outline" disabled={halfWeeks(bulkWeeks) === null} onClick={applyWeeks}>Apply</Button></>) : null}
          </div>
        )}
        {rows.length === 0 ? <EmptyState icon="ri-book-2-line" title="No units yet" description={readOnly ? undefined : "Add the units of competency in delivery order, with their weeks and hours."} /> : (
          <div className="divide-y divide-background-200">
            <div className="hidden grid-cols-[1.5rem_8rem_minmax(0,1fr)_7rem_5rem_5rem_5rem_2.5rem] gap-2 px-4 py-2 text-xs font-medium text-foreground-500 md:grid">
              <span /><span>Code</span><span>Name</span><span>Type</span><span>Weeks</span><span>Hours</span><span>Active</span><span />
            </div>
            {rows.map((u, i) => (
              <div key={u.id ?? `new-${i}`} draggable={!readOnly} onDragStart={() => setDragFrom(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}
                className={`grid grid-cols-[1.5rem_8rem_minmax(0,1fr)] items-center gap-2 px-4 py-2 md:grid-cols-[1.5rem_8rem_minmax(0,1fr)_7rem_5rem_5rem_5rem_2.5rem] ${u.isActive ? "" : "opacity-60"}`}>
                {readOnly ? <span /> : <input type="checkbox" aria-label={`Select ${u.code || "unit"}`} checked={selected.has(i)} onChange={() => toggleSel(i)} className="cursor-pointer" />}
                <TextInput disabled={readOnly} value={u.code} aria-label="Unit code" onChange={(e) => set(i, { code: e.target.value })} />
                <TextInput disabled={readOnly} value={u.name} aria-label="Unit name" onChange={(e) => set(i, { name: e.target.value })} />
                <Select disabled={readOnly} value={u.unitType} aria-label="Core or elective" onChange={(e) => set(i, { unitType: e.target.value as RtoUnit["unitType"] })}>
                  <option value="core">Core</option><option value="elective">Elective</option>
                </Select>
                <WeeksInput disabled={readOnly} value={u.defaultWeeks} onChange={(w) => set(i, { defaultWeeks: w })} />
                <TextInput disabled={readOnly} inputMode="numeric" value={u.nominalHours === null ? "" : String(u.nominalHours)} aria-label="Hours"
                  onChange={(e) => set(i, { nominalHours: e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} />
                <Toggle disabled={readOnly} checked={u.isActive} onChange={(v) => set(i, { isActive: v })} />
                {readOnly ? <span /> : <Button variant="ghost" size="sm" icon={u.scheduled ? "ri-eye-off-line" : "ri-delete-bin-line"} aria-label={u.scheduled ? "Deactivate unit" : "Remove unit"}
                  title={u.scheduled ? "This unit is used in an intake schedule, so it is deactivated instead of removed." : "Remove"} onClick={() => remove(i)} />}
              </div>
            ))}
          </div>
        )}
        {readOnly ? null : (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-background-200 px-4 py-3">
            <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => setRows((list) => [...list, { code: "", name: "", unitType: "core", defaultWeeks: 4, nominalHours: null, isActive: true }])}>Add unit</Button>
            <p className="text-xs text-foreground-500">{invalid ? "Each unit needs a code, a name and at least half a week." : "Drag to reorder. A unit used in a schedule can only be deactivated."}</p>
            <SaveHint autosave={autosave} busy={busy} dirty={dirty} disabled={invalid} label="Save units" onSave={() => onSave(rows)} />
          </div>
        )}
      </Card>
    </div>
  );
}

/** Website: marketing settings; facts are read-only here with a link to the step that owns them. */
export function WebsiteTab({ detail, busy, onSave, autosave = false }: { detail: CourseDetail; busy: boolean; onSave: (data: Record<string, unknown>) => void; autosave?: boolean }) {
  const c = detail.course;
  const initial = { showFees: c.showFees, feeNote: c.feeNote ?? "", seoTitle: c.seoTitle ?? "", seoDescription: c.seoDescription ?? "", homepageCarousel: c.homepageCarousel };
  const [form, setForm] = useState(initial);
  const formRef = useRef(form);
  formRef.current = form;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const sent = useAutosave(form, { enabled: autosave, dirty, valid: true, save: (v) => onSave(v) });
  useEffect(() => { if (mayRefresh(sent, formRef.current)) setForm(initial); sent.current = null; }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const open = detail.intakes.filter((i) => i.status === "open" && i.startDate >= new Date().toISOString().slice(0, 10)).slice(0, 3);
  const checklist = [
    { ok: Boolean(c.image), label: "Image", where: "Media & Files" }, { ok: Boolean(c.shortDescription), label: "Overview", where: "Overview" },
    { ok: Boolean(c.category), label: "Category", where: "Details" },
  ];
  const fact = (label: string, value: string, step: CourseStep) => (
    <div className="flex items-start justify-between gap-3 border-b border-background-200 py-2 last:border-0">
      <div><p className="text-xs text-foreground-500">{label}</p><p className="text-sm text-foreground-900">{value || "—"}</p></div>
      <Link to={stepPath(c.id, step)} className="whitespace-nowrap text-xs font-medium text-primary-600 hover:underline">Edit</Link>
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-heading text-base font-semibold">Marketing content</h2>
            <Link to={`/admin/courses/${encodeURIComponent(c.slug)}`}><Button size="sm" icon="ri-edit-line">Edit overview, requirements & media</Button></Link></div>
          <p className="text-sm text-foreground-600">Overview, entry requirements, career outcomes, images, files and links are edited on one page, with drafts, publishing and history.</p>
        </Card>
        <Card className="space-y-4 p-5">
          <h2 className="font-heading text-base font-semibold">Fees and search</h2>
          <Toggle checked={form.showFees} onChange={(v) => set({ showFees: v })} label="Show fees on the website" />
          <Field label="Fee note" hint="Shown under the fees, e.g. “Laptops and software are not included.”"><TextArea rows={2} value={form.feeNote} onChange={(e) => set({ feeNote: e.target.value })} /></Field>
          <Toggle checked={form.homepageCarousel} onChange={(v) => set({ homepageCarousel: v })} label="Show in the homepage carousel" />
          <Field label="SEO title"><TextInput value={form.seoTitle} maxLength={120} onChange={(e) => set({ seoTitle: e.target.value })} /></Field>
          <Field label="SEO description"><TextArea rows={2} maxLength={320} value={form.seoDescription} onChange={(e) => set({ seoDescription: e.target.value })} /></Field>
          <div className="flex justify-end"><SaveHint autosave={autosave} busy={busy} dirty={dirty} disabled={false} label="Save website settings" onSave={() => onSave(form)} /></div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="mb-1 font-heading text-sm font-semibold">Facts on the website</h2>
          {fact("Name", c.name, "details")}{fact("Code / CRICOS", [c.code, c.cricos].filter(Boolean).join(" · "), "details")}
          {fact("Units", `${c.activeUnits} active`, "timetable")}{fact("Duration", c.duration, "details")}
          {fact("Fees", c.totalCents ? `Total ${money(c.totalCents)}` : "", "fees")}
          {fact("Next open intakes", open.map((i) => shortDate(i.startDate)).join(", "), "intakes")}
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="font-heading text-sm font-semibold">Publish checklist</h2><StatusBadge status={c.status} /></div>
          <ul className="space-y-1.5">
            {checklist.map((x) => <li key={x.label} className="flex items-center gap-2 text-sm"><i className={x.ok ? "ri-checkbox-circle-fill text-primary-500" : "ri-error-warning-line text-foreground-400"} aria-hidden="true" />{x.label}{x.ok ? null : <span className="text-xs text-foreground-500">— add in {x.where}</span>}</li>)}
          </ul>
          {c.status !== "Published" ? <p className="mt-2 text-xs text-foreground-500">Publish from the content page (Edit overview, requirements & media).</p> : null}
        </Card>
      </div>
    </div>
  );
}
