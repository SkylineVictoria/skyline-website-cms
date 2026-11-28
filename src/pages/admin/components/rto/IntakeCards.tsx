// Intakes as cards (month, dates, status you can click, students against places, class setup line, "⋯" for Duplicate / Delete). A card
// opens the intake in a sheet whose address ends in #<intake id>. N = new intake.
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DangerDialog } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import IntakeSheet, { type SheetTab } from "@/pages/admin/components/rto/IntakeSheet";
import { Empty, MoreMenu, SkeletonCards, StatusPicker } from "@/pages/admin/components/rto/overlay";
import {
  monthYear, phase, rto, shortDate, weeksOf, type IntakeStatus, type RtoIntake,
} from "@/pages/admin/lib/rto";

export function IntakeCard({ intake: i, showCourse, canEdit, onOpen, onStatus, onDelete }: {
  intake: RtoIntake; showCourse: boolean; canEdit: boolean; onOpen: () => void; onStatus: (s: IntakeStatus) => void; onDelete: () => void;
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
          <p className="break-words font-heading text-base font-bold leading-snug text-foreground-950" title={i.customName || i.name}>{i.customName || i.name || monthYear(i.startDate)}</p>
          {/* A rolling intake is named after its course; a dated one shows its start month and (on the all-courses list) its course. */}
          {i.endDate ? <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{monthYear(i.startDate)}</p> : <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Rolling intake</p>}
          {showCourse && !(i.customName || i.name || "").includes(i.courseName) ? <p className="truncate text-sm font-medium text-foreground-700" title={i.courseName}>{i.courseName}</p> : null}
        </div>
        <StatusPicker status={i.status} canEdit={canEdit} onChange={onStatus} />
        {canEdit ? <MoreMenu label={`More actions for ${i.name}`} items={[
          { label: "Archive intake…", icon: "ri-archive-line", danger: true, onClick: onDelete },
        ]} /> : null}
      </div>
      <p className="mt-1 text-xs text-foreground-500">
        {i.endDate ? <>{shortDate(i.startDate)} – {shortDate(i.endDate)} · {weeksOf(i.startDate, i.endDate)} weeks{when === "running" ? " · running" : when === "finished" ? " · finished" : ""}</> : <>Ongoing since {shortDate(i.startDate)}</>}
      </p>
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs text-foreground-600">
          <span><span className="text-sm font-semibold tabular-nums text-foreground-900">{i.enrolled}</span>{places ? ` of ${places} places` : " students"}</span>
          {places && i.enrolled >= places ? <span className="font-medium text-accent-800">Full</span> : null}
        </div>
        {places ? <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background-200">
          <div className="h-full rounded-full bg-primary-500 transition-all duration-200" style={{ width: `${Math.min(100, (i.enrolled / places) * 100)}%` }} />
        </div> : null}
      </div>
      <div className="mt-3 flex min-h-[1.75rem] flex-wrap gap-1.5">
        {!group || !group.days.length ? <span className="text-xs text-foreground-500">{i.endDate ? "Weekly timetable not selected yet" : "Open to see its batches and timetable"}</span> : (
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
  const [deleting, setDeleting] = useState<RtoIntake | null>(null);
  const [local, setLocal] = useState<Record<string, IntakeStatus>>({});
  useEffect(() => { setLocal({}); }, [intakes]);

  const open = useCallback((id: string, opts: { tab?: SheetTab; addBatch?: boolean } = {}) => { setStart(opts); navigate({ search: location.search, hash: id }); }, [navigate, location.search]);
  const close = useCallback(() => {
    const params = new URLSearchParams(location.search); params.delete("wizard");
    const search = params.toString();
    navigate({ search: search ? `?${search}` : "", hash: "" }, { replace: true });
  }, [navigate, location.search]);

  const setStatus = (i: RtoIntake, status: IntakeStatus) => {
    const before = local[i.id] ?? i.status;
    if (status === before) return;
    setLocal((m) => ({ ...m, [i.id]: status }));
    rto("intake_save", { id: i.id, status }).then(() => {
      onReload();
      push(`${i.customName || i.name || monthYear(i.startDate)} is now ${status[0].toUpperCase()}${status.slice(1)}.`, "success", { label: "Undo", onClick: () => setStatus({ ...i, status }, before) });
    }).catch((e) => { setLocal((m) => ({ ...m, [i.id]: before })); push(e instanceof Error ? e.message : "Not saved.", "error"); });
  };
  // LMS-BATCHES (2026-11-25, owner): intakes are archived, never deleted (an unfinished wizard intake is still removed); the course stays.
  const remove = async (i: RtoIntake) => {
    try {
      const r = await rto<{ deleted: boolean; archived?: boolean; freed?: number }>("intake_delete", { intakeId: i.id });
      const what = r?.archived === false ? "removed" : "archived";
      push(r?.freed ? `${i.name} ${what}. ${r.freed} student${r.freed === 1 ? " needs" : "s need"} a new intake.` : `${i.name} ${what}.`);
      if (openId === i.id) close();
      onReload();
    } catch (e) { push(e instanceof Error ? e.message : "Not archived.", "error"); }
  };

  return (
    <>
      {loading ? <SkeletonCards /> : intakes.length === 0 ? (
        <Empty icon="ri-calendar-event-line" title={empty?.title ?? "No intakes yet"} text={empty?.text ?? "A course gets its CoE and VoE intakes when its course wizard is finished (LMS › Courses)."} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {intakes.map((i) => (
            <IntakeCard key={i.id} intake={{ ...i, status: local[i.id] ?? i.status }} showCourse={showCourse} canEdit={canEdit} onOpen={() => open(i.id)}
              onStatus={(s) => setStatus(i, s)} onDelete={() => setDeleting(i)} />
          ))}
        </div>
      )}
      {openId ? (
        <IntakeSheet key={openId} intakeId={openId} canEdit={canEdit} canEnrol={canEnrol} startTab={start.tab} startAddBatch={start.addBatch} wizard={wizard}
          onClose={close} onChanged={onReload} onDelete={setDeleting} />
      ) : null}
      <DangerDialog open={deleting !== null} title={`Archive ${deleting?.name ?? "this intake"}?`} intro={deleting ? `${deleting.courseCode} · ${shortDate(deleting.startDate)}` : undefined}
        items={[
          "The intake is closed and kept with its batches, classes, attendance and history (nothing is deleted)",
          "Students in it are withdrawn from it and wait to be placed in a new intake (Override: place a student)",
        ]}
        confirmLabel="Yes, archive"
        onCancel={() => setDeleting(null)} onConfirm={() => { const i = deleting; setDeleting(null); if (i) void remove(i); }} />
    </>
  );
}
