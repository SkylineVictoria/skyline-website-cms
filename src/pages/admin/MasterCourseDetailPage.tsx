import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, SectionTabs, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { courseCategories } from "@/pages/admin/lib/seed";
import { ErrorNote, FeesEditor, IntakeRow, ReadOnlyNote, Avatars } from "@/pages/admin/components/rto/shared";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { money, rto, shortDate, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

const TABS = [
  { id: "course", label: "Course", icon: "ri-information-line" }, { id: "units", label: "Units", icon: "ri-book-2-line" },
  { id: "fees", label: "Fees", icon: "ri-money-dollar-circle-line" }, { id: "intakes", label: "Intakes", icon: "ri-calendar-event-line" },
  { id: "batches", label: "Batches", icon: "ri-group-line" }, { id: "website", label: "Website", icon: "ri-global-line" },
];

/** Master Data › Courses › a course. RTO Managers edit; everyone else sees it read-only (the website tab is open to website editors). */
export default function MasterCourseDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { push } = useToast();
  const { reload } = useAdminData();
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [websiteOnly, setWebsiteOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, me] = await Promise.all([rto<CourseDetail>("course_get", { courseId: id }), rto<{ rtoManager: boolean; admin: boolean }>("me")]);
      setDetail(d); setCanEdit(me.rtoManager); setWebsiteOnly(!me.rtoManager && !me.admin); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The course did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: string, data: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const out = await rto<CourseDetail | RtoCourse>(action, { courseId: id, ...data });
      if ("course" in out) setDetail(out); else setDetail((d) => (d ? { ...d, course: out } : d));
      reload(); // the website editor's copy of the course stays in step
      push(done);
    } catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); }
    finally { setBusy(false); }
  };

  if (error) return <Card className="p-8"><ErrorNote text={error} /><div className="mt-4"><Link to="/admin/course-fees" className="text-sm text-primary-600">Back to Courses</Link></div></Card>;
  if (!detail) return <p className="py-10 text-center text-foreground-500">Loading course…</p>;
  const c = detail.course;
  const tabs = websiteOnly ? TABS.filter((t) => t.id === "website") : TABS;
  const tab = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : tabs[0].id;

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-4 border-b border-background-200 bg-background-100/95 px-1 pb-3 pt-1 backdrop-blur">
        <Link to="/admin/course-fees" className="mb-1 inline-flex items-center gap-1 text-[13px] font-medium text-foreground-500 hover:text-primary-600"><i className="ri-arrow-left-line" aria-hidden="true" />Courses</Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-bold text-foreground-950">{c.code ? `${c.code} ` : ""}{c.name}</h1>
          <StatusBadge status={c.status} />{c.isActive ? null : <Badge>Inactive</Badge>}
        </div>
        <p className="mt-1 text-sm text-foreground-500">{[c.cricos && `CRICOS ${c.cricos}`, c.duration, `${c.activeUnits} units`, c.totalCents ? `Total ${money(c.totalCents)}` : null, c.nextIntake ? `Next intake ${shortDate(c.nextIntake)}` : null].filter(Boolean).join(" · ")}</p>
      </div>
      <SectionTabs tabs={tabs} active={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      {!canEdit && tab !== "website" ? <div className="mb-3"><ReadOnlyNote>Only an RTO Manager can change courses, units, fees, intakes and batches.</ReadOnlyNote></div> : null}

      {tab === "course" ? <CourseFacts course={c} readOnly={!canEdit} busy={busy} onSave={(data) => void run("course_save", data, "Course saved.")} /> : null}
      {tab === "units" ? <UnitsTab units={detail.units} readOnly={!canEdit} busy={busy} onSave={(units) => void run("units_save", { units }, "Units saved.")} /> : null}
      {tab === "fees" ? (
        <Card className="p-5"><FeesEditor items={detail.fees} readOnly={!canEdit} busy={busy} onSave={(items) => void run("fees_save", { items }, "Fees saved. Offer letters use them from now on.")} /></Card>
      ) : null}
      {tab === "intakes" ? (
        <div className="space-y-2">
          {canEdit ? <div className="flex justify-end"><Button icon="ri-add-line" onClick={() => setDrawer(true)}>New intake</Button></div> : null}
          {detail.intakes.length ? detail.intakes.map((i) => <IntakeRow key={i.id} intake={i} showCourse={false} />)
            : <Card><EmptyState icon="ri-calendar-event-line" title="No intakes yet" description={canEdit ? "Create the first intake; its schedule is generated from the active units." : "An RTO Manager creates intakes."} /></Card>}
        </div>
      ) : null}
      {tab === "batches" ? (
        <div className="space-y-2">
          {detail.batches.length ? detail.batches.map((b) => (
            <Link key={b.id} to={`/admin/intakes/${b.intakeId}?tab=batches`} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-background-200 bg-background-50 px-4 py-3 hover:border-primary-300">
              <div><p className="font-medium text-foreground-900">{b.name} <span className="font-normal text-foreground-500">· {b.intakeName}</span></p>
                <p className="text-xs text-foreground-500">{[b.classroom, b.classDays.join(" "), b.startTime && `${b.startTime}–${b.endTime ?? ""}`].filter(Boolean).join(" · ") || "No class times yet"}</p></div>
              <div className="flex items-center gap-4"><span className="text-sm tabular-nums text-foreground-700">{b.students.filter((s) => s.status === "active").length}{b.capacity ? ` / ${b.capacity}` : ""} students</span><Avatars names={b.trainers.map((t) => t.name)} /></div>
            </Link>
          )) : <Card><EmptyState icon="ri-group-line" title="No batches yet" description="Batches are created inside an intake." /></Card>}
        </div>
      ) : null}
      {tab === "website" ? <WebsiteTab detail={detail} busy={busy} onSave={(data) => void run("website_save", data, "Website settings saved.")} /> : null}

      <NewIntakeDrawer open={drawer} onClose={() => setDrawer(false)} courses={[]} courseId={c.id} />
    </div>
  );
}

function CourseFacts({ course, readOnly, busy, onSave }: { course: RtoCourse; readOnly: boolean; busy: boolean; onSave: (data: Record<string, unknown>) => void }) {
  const initial = { name: course.name, code: course.code, cricos: course.cricos, category: course.category, trainingPackage: course.trainingPackage, duration: course.duration,
    mode: course.mode, campus: course.campus ?? "", tgaUrl: course.tgaUrl ?? "", isActive: course.isActive };
  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [course]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  return (
    <Card className="p-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Course name" required><TextInput disabled={readOnly} value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field></div>
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
      {readOnly ? null : <div className="mt-5 flex justify-end"><Button disabled={busy || !dirty || !form.name.trim()} onClick={() => onSave(form)}>{busy ? "Saving…" : "Save course"}</Button></div>}
    </Card>
  );
}

function UnitsTab({ units, readOnly, busy, onSave }: { units: RtoUnit[]; readOnly: boolean; busy: boolean; onSave: (units: RtoUnit[]) => void }) {
  const [rows, setRows] = useState<RtoUnit[]>(units);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  useEffect(() => { setRows(units); }, [units]);
  const set = (i: number, patch: Partial<RtoUnit>) => setRows((list) => list.map((u, x) => (x === i ? { ...u, ...patch } : u)));
  const remove = (i: number) => setRows((list) => (list[i].scheduled ? list.map((u, x) => (x === i ? { ...u, isActive: false } : u)) : list.filter((_, x) => x !== i)));
  const drop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    setRows((list) => { const next = [...list]; const [moved] = next.splice(dragFrom, 1); next.splice(to, 0, moved); return next; });
    setDragFrom(null);
  };
  const dirty = JSON.stringify(rows) !== JSON.stringify(units);
  const invalid = rows.some((u) => !u.code.trim() || !u.name.trim() || !(u.defaultWeeks >= 1));
  return (
    <Card className="p-0">
      {rows.length === 0 ? <EmptyState icon="ri-book-2-line" title="No units yet" description={readOnly ? undefined : "Add the units of competency in delivery order."} /> : (
        <div className="divide-y divide-background-200">
          <div className="hidden grid-cols-[1.5rem_8rem_minmax(0,1fr)_7rem_5rem_5rem_5rem_2.5rem] gap-2 px-4 py-2 text-xs font-medium text-foreground-500 md:grid">
            <span /><span>Code</span><span>Name</span><span>Type</span><span>Weeks</span><span>Hours</span><span>Active</span><span />
          </div>
          {rows.map((u, i) => (
            <div key={u.id ?? `new-${i}`} draggable={!readOnly} onDragStart={() => setDragFrom(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}
              className={`grid grid-cols-[1.5rem_8rem_minmax(0,1fr)] items-center gap-2 px-4 py-2 md:grid-cols-[1.5rem_8rem_minmax(0,1fr)_7rem_5rem_5rem_5rem_2.5rem] ${u.isActive ? "" : "opacity-60"}`}>
              <i className={`ri-draggable text-foreground-400 ${readOnly ? "invisible" : "cursor-grab"}`} aria-hidden="true" />
              <TextInput disabled={readOnly} value={u.code} aria-label="Unit code" onChange={(e) => set(i, { code: e.target.value })} />
              <TextInput disabled={readOnly} value={u.name} aria-label="Unit name" onChange={(e) => set(i, { name: e.target.value })} />
              <Select disabled={readOnly} value={u.unitType} aria-label="Core or elective" onChange={(e) => set(i, { unitType: e.target.value as RtoUnit["unitType"] })}>
                <option value="core">Core</option><option value="elective">Elective</option>
              </Select>
              <TextInput disabled={readOnly} inputMode="numeric" value={String(u.defaultWeeks)} aria-label="Default weeks" onChange={(e) => set(i, { defaultWeeks: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
              <TextInput disabled={readOnly} inputMode="numeric" value={u.nominalHours === null ? "" : String(u.nominalHours)} aria-label="Nominal hours"
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
          <p className="text-xs text-foreground-500">Drag to reorder. A unit used in a schedule can only be deactivated.</p>
          <Button disabled={busy || !dirty || invalid} onClick={() => onSave(rows)}>{busy ? "Saving…" : "Save units"}</Button>
        </div>
      )}
    </Card>
  );
}

function WebsiteTab({ detail, busy, onSave }: { detail: CourseDetail; busy: boolean; onSave: (data: Record<string, unknown>) => void }) {
  const c = detail.course;
  const initial = { showFees: c.showFees, feeNote: c.feeNote ?? "", seoTitle: c.seoTitle ?? "", seoDescription: c.seoDescription ?? "", homepageCarousel: c.homepageCarousel };
  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const open = detail.intakes.filter((i) => i.status === "open" && i.startDate >= new Date().toISOString().slice(0, 10)).slice(0, 3);
  const checklist = [
    { ok: Boolean(c.image), label: "Image", where: "Media & Files" }, { ok: Boolean(c.shortDescription), label: "Overview", where: "Overview" },
    { ok: Boolean(c.category), label: "Category", where: "Course tab" },
  ];
  const fact = (label: string, value: string, tab: string) => (
    <div className="flex items-start justify-between gap-3 border-b border-background-200 py-2 last:border-0">
      <div><p className="text-xs text-foreground-500">{label}</p><p className="text-sm text-foreground-900">{value || "—"}</p></div>
      <Link to={`?tab=${tab}`} className="whitespace-nowrap text-xs font-medium text-primary-600 hover:underline">Edit in Course</Link>
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
          <div className="flex justify-end"><Button disabled={busy || JSON.stringify(form) === JSON.stringify(initial)} onClick={() => onSave(form)}>{busy ? "Saving…" : "Save website settings"}</Button></div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="mb-1 font-heading text-sm font-semibold">Facts on the website</h2>
          {fact("Name", c.name, "course")}{fact("Code / CRICOS", [c.code, c.cricos].filter(Boolean).join(" · "), "course")}
          {fact("Units", `${c.activeUnits} active`, "units")}{fact("Duration", c.duration, "course")}
          {fact("Fees", c.totalCents ? `Total ${money(c.totalCents)}` : "", "fees")}
          {fact("Next open intakes", open.map((i) => shortDate(i.startDate)).join(", "), "intakes")}
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="font-heading text-sm font-semibold">Publish checklist</h2><StatusBadge status={c.status} /></div>
          <ul className="space-y-1.5">
            {checklist.map((x) => <li key={x.label} className="flex items-center gap-2 text-sm"><i className={x.ok ? "ri-checkbox-circle-fill text-primary-500" : "ri-error-warning-line text-foreground-400"} aria-hidden="true" />{x.label}{x.ok ? null : <span className="text-xs text-foreground-500">— add in {x.where}</span>}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
