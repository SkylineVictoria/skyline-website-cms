// Intakes as cards (month, dates, status you can click, students against places, class setup line, "⋯" for Duplicate / Delete). A card
// opens the intake in a sheet whose address ends in #<intake id>. N = new intake.
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, DangerDialog, Field, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import IntakeSheet, { type SheetTab } from "@/pages/admin/components/rto/IntakeSheet";
import { Empty, MoreMenu, SkeletonCards, StatusPicker } from "@/pages/admin/components/rto/overlay";
import { useShortcuts } from "@/pages/admin/lib/useShortcuts";
import { supabase } from "@/pages/admin/lib/supabase";
import {
  monthYear, phase, rto, rtoFlow, shortDate, weeksOf, type CourseDetail, type IntakeDetail, type IntakeStatus, type RtoIntake,
} from "@/pages/admin/lib/rto";

export function IntakeCard({ intake: i, showCourse, canEdit, onOpen, onStatus, onDuplicate, onDelete }: {
  intake: RtoIntake; showCourse: boolean; canEdit: boolean; onOpen: () => void; onStatus: (s: IntakeStatus) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const group = (i.batchList ?? []).find((b) => b.id === i.id) ?? (i.batchList ?? [])[0] ?? null;
  const places = i.capacity ?? group?.capacity ?? null;
  const when = phase(i);
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="group flex min-w-0 cursor-pointer flex-col rounded-card border border-background-200 bg-background-50 p-4 text-left outline-none transition-shadow duration-150 ease-out hover:border-primary-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary-400">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* The intake's name (CPC30326_01-Dec-2026_Intake_Batch_COE), the start month under it. */}
          <p className="break-all font-heading text-base font-bold leading-snug text-foreground-950" title={i.customName || i.name}>{i.customName || i.name || monthYear(i.startDate)}</p>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{monthYear(i.startDate)}</p>
          {showCourse ? <p className="truncate text-sm font-medium text-foreground-700" title={i.courseName}>{i.courseName}</p> : null}
        </div>
        <StatusPicker status={i.status} canEdit={canEdit} onChange={onStatus} />
        {canEdit ? <MoreMenu label={`More actions for ${i.name}`} items={[
          { label: "Duplicate…", icon: "ri-file-copy-line", onClick: onDuplicate },
          { label: "Delete intake…", icon: "ri-delete-bin-line", danger: true, onClick: onDelete },
        ]} /> : null}
      </div>
      <p className="mt-1 text-xs text-foreground-500">
        {shortDate(i.startDate)} – {shortDate(i.endDate)}{i.endDate ? ` · ${weeksOf(i.startDate, i.endDate)} weeks` : ""}{when === "running" ? " · running" : when === "finished" ? " · finished" : ""}
      </p>
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs text-foreground-600">
          <span><span className="text-sm font-semibold tabular-nums text-foreground-900">{i.enrolled}</span>{places ? ` of ${places} places` : " students"}</span>
          {places && i.enrolled >= places ? <span className="font-medium text-accent-800">Full</span> : null}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background-200">
          <div className="h-full rounded-full bg-primary-500 transition-all duration-200" style={{ width: places ? `${Math.min(100, (i.enrolled / places) * 100)}%` : i.enrolled ? "100%" : "0%" }} />
        </div>
      </div>
      <div className="mt-3 flex min-h-[1.75rem] flex-wrap gap-1.5">
        {!group || !group.days.length ? <span className="text-xs text-foreground-400">Weekly timetable not selected yet</span> : (
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${group.isActive ? "border-secondary-200 bg-secondary-50 text-secondary-900" : "border-background-300 text-foreground-500"}`} title="Class days">
            <i className="ri-time-line mr-1" aria-hidden="true" />{group.days.join(" ")}
          </span>
        )}
      </div>
    </div>
  );
}

/** Cards + the intake sheet (#id in the address) + New intake (N) + Duplicate / Delete. Used by Courses › Intakes and a course's Intakes step. */
export function IntakesView({ intakes, loading, courseId, courses = [], canEdit, canEnrol, showCourse, onReload, empty }: {
  intakes: RtoIntake[]; loading: boolean; courseId?: string; courses?: { id: string; label: string }[]; canEdit: boolean; canEnrol: boolean; showCourse: boolean;
  onReload: () => void; empty?: { title: string; text: string };
}) {
  const { push } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const openId = /^#([0-9a-f-]{36})$/i.exec(location.hash)?.[1] ?? null;
  // ?wizard=1 (new course wizard): the intake opens on step 5, its class setup.
  const wizard = new URLSearchParams(location.search).get("wizard") === "1";
  const [start, setStart] = useState<{ tab?: SheetTab; addBatch?: boolean }>(() => (wizard ? { addBatch: true } : {}));
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<RtoIntake | null>(null);
  const [deleting, setDeleting] = useState<RtoIntake | null>(null);
  const [local, setLocal] = useState<Record<string, IntakeStatus>>({});
  useEffect(() => { setLocal({}); }, [intakes]);

  const open = useCallback((id: string, opts: { tab?: SheetTab; addBatch?: boolean } = {}) => { setStart(opts); navigate({ search: location.search, hash: id }); }, [navigate, location.search]);
  const close = useCallback(() => {
    const params = new URLSearchParams(location.search); params.delete("wizard");
    const search = params.toString();
    navigate({ search: search ? `?${search}` : "", hash: "" }, { replace: true });
  }, [navigate, location.search]);
  useShortcuts({ n: () => { if (canEdit) setCreating(true); } }, canEdit);

  const setStatus = (i: RtoIntake, status: IntakeStatus) => {
    const before = local[i.id] ?? i.status;
    if (status === before) return;
    setLocal((m) => ({ ...m, [i.id]: status }));
    rto("intake_save", { id: i.id, status }).then(() => {
      onReload();
      push(`${i.customName || i.name || monthYear(i.startDate)} is now ${status[0].toUpperCase()}${status.slice(1)}.`, "success", { label: "Undo", onClick: () => setStatus({ ...i, status }, before) });
    }).catch((e) => { setLocal((m) => ({ ...m, [i.id]: before })); push(e instanceof Error ? e.message : "Not saved.", "error"); });
  };
  // A course runs only with an intake (owner, 2026-11-20): deleting its last intake deletes the course and its units too.
  const lastOfCourse = (i: RtoIntake | null) => !!i && intakes.filter((x) => x.courseId === i.courseId).length === 1;
  const remove = async (i: RtoIntake) => {
    try {
      const r = await rto<{ deleted: boolean; freed?: number }>("intake_delete", { intakeId: i.id });
      push(r?.freed ? `${i.name} deleted. ${r.freed} student${r.freed === 1 ? " needs" : "s need"} a new intake.` : `${i.name} deleted.`);
      if (openId === i.id) close();
      const course = await rto<CourseDetail>("course_get", { courseId: i.courseId }).catch(() => null);
      if (course && !course.intakes.length) {
        const { error } = await supabase.rpc("rto_course_delete", { p_course_id: i.courseId, p_force: true });
        if (error) push(`${i.courseCode} has no intake now but was not deleted: ${error.message}`, "error");
        else push(`${i.courseCode} had no other intake, so the course and its units were deleted too.`);
      }
      onReload();
    } catch (e) { push(e instanceof Error ? e.message : "Not deleted.", "error"); }
  };

  return (
    <>
      {canEdit ? <div className="mb-3 flex items-center justify-end gap-2"><span className="hidden text-xs text-foreground-400 sm:inline">Press N</span><Button icon="ri-add-line" onClick={() => setCreating(true)}>New intake</Button></div> : null}
      {loading ? <SkeletonCards /> : intakes.length === 0 ? (
        <Empty icon="ri-calendar-event-line" title={empty?.title ?? "No intakes yet"} text={empty?.text ?? (canEdit ? "Create one: pick a start date and the timeline is laid out from the course." : "An RTO Manager creates intakes.")}
          action={canEdit ? <Button icon="ri-add-line" onClick={() => setCreating(true)}>New intake</Button> : undefined} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {intakes.map((i) => (
            <IntakeCard key={i.id} intake={{ ...i, status: local[i.id] ?? i.status }} showCourse={showCourse} canEdit={canEdit} onOpen={() => open(i.id)}
              onStatus={(s) => setStatus(i, s)} onDuplicate={() => setDuplicating(i)} onDelete={() => setDeleting(i)} />
          ))}
        </div>
      )}
      {openId ? (
        <IntakeSheet key={openId} intakeId={openId} canEdit={canEdit} canEnrol={canEnrol} startTab={start.tab} startAddBatch={start.addBatch} wizard={wizard}
          onClose={close} onChanged={onReload} onDuplicate={setDuplicating} onDelete={setDeleting} />
      ) : null}
      <NewIntakeDrawer open={creating} onClose={() => setCreating(false)} courses={courses} courseId={courseId}
        onCreated={(d: IntakeDetail, addBatch) => { setCreating(false); onReload(); push(`${d.intake.name} created.`); open(d.intake.id, addBatch ? { addBatch: true } : { tab: "timeline" }); }} />
      {duplicating ? <DuplicateDrawer intake={duplicating} onClose={() => setDuplicating(null)} onDone={(d) => { setDuplicating(null); onReload(); push(`${d.intake.name} created as a draft.`); open(d.intake.id); }} /> : null}
      <DangerDialog open={deleting !== null} title={`Delete ${deleting?.name ?? "this intake"}?`} intro={deleting ? `${deleting.courseCode} · ${shortDate(deleting.startDate)}` : undefined}
        items={[
          "Its timeline, weekly timetable and classes",
          "Students in it are taken out and wait to be placed in a new intake (Override: place a student)",
          ...(lastOfCourse(deleting) ? [`It is the last intake of ${deleting?.courseCode}: a course runs only with an intake, so the course, its units and its master timetable are deleted too`] : []),
        ]}
        confirmLabel="Yes, delete"
        onCancel={() => setDeleting(null)} onConfirm={() => { const i = deleting; setDeleting(null); if (i) void remove(i); }} />
    </>
  );
}

function DuplicateDrawer({ intake, onClose, onDone }: { intake: RtoIntake; onClose: () => void; onDone: (d: IntakeDetail) => void }) {
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { onDone(await rtoFlow<IntakeDetail>("intake_duplicate", { intakeId: intake.id, startDate: start })); }
    catch (e) { setError(e instanceof Error ? e.message : "Not copied."); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open title={`Duplicate ${monthYear(intake.startDate)} intake`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !start} onClick={() => void save()}>{busy ? "Copying…" : "Duplicate"}</Button></>}>
      <ErrorNote text={error} />
      <Field label="New start date" required hint={`This one starts ${shortDate(intake.startDate)}. Every unit date moves by the same number of days.`}>
        <TextInput type="date" autoFocus value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <p className="text-sm text-foreground-600">Copied: the timeline, trainers, class times and rooms. Not copied: students. The copy starts as a draft.</p>
    </Drawer>
  );
}
