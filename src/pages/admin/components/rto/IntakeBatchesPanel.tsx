import { shortDate } from "@/pages/admin/lib/rto";
// LMS-BATCHES (2026-11-25): the intake sheet's Batches tab. An intake (CoE or VoE, following its Master's unit dates) holds class batches
// B1 / B2 / B3, each with its own room, seats, default trainer and weekly class times; a student can be in one or more batches (a whole-
// course batch, plus optional batches for single units). Views: Class (every class), Daily (by day), Weekly (weekday x batch).
// Batches are archived, never deleted.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { rto, rtoFlow, type LocationRooms, type StaffOption } from "@/pages/admin/lib/rto";
import {
  archiveBatch, assignBatches, batchLabel, batchMembers, batchSessions, listBatches, saveBatch, saveBatchTimes, WEEKDAY_SHORT,
  type BatchClassTime, type BatchMember, type BatchSessionRow, type IntakeBatch,
} from "@/pages/admin/lib/batches";

type View = "class" | "daily" | "weekly";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const mondayOf = (s: string) => { const d = new Date(`${s}T00:00:00`); const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return iso(d); };
const niceDate = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

export default function IntakeBatchesPanel({ intakeId, canEdit, canAssign, units }: {
  intakeId: string; canEdit: boolean; canAssign: boolean; units: { unitId: string; code: string }[];
}) {
  const { push } = useToast();
  const [batches, setBatches] = useState<IntakeBatch[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [editing, setEditing] = useState<Partial<IntakeBatch> | null>(null);
  const [timesFor, setTimesFor] = useState<IntakeBatch | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    void listBatches(intakeId, showArchived).then(setBatches).catch((e: Error) => { setError(e.message); setBatches([]); });
  }, [intakeId, showArchived]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    void rtoFlow<LocationRooms[]>("locations_rooms").then((l) => setRooms(l.flatMap((x) => x.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, name: x.name ? `${r.name} · ${x.name}` : r.name }))))).catch(() => setRooms([]));
    void rto<StaffOption[]>("staff_list").then(setStaff).catch(() => setStaff([]));
  }, []);

  const live = (batches ?? []).filter((b) => !b.archivedAt);

  const save = async () => {
    if (!editing) return;
    try {
      await saveBatch({ id: editing.id, intakeId, code: editing.code ?? undefined, name: editing.name ?? "", roomId: editing.roomId ?? null,
        capacity: editing.capacity ?? null, defaultTrainerId: editing.defaultTrainerId ?? null });
      push(editing.id ? "Batch saved." : "Batch added."); setEditing(null); load();
    } catch (e) { push((e as Error).message, "error"); }
  };
  const archive = async (b: IntakeBatch) => {
    const reason = window.prompt(`Archive ${b.code}? Its students move to the intake's first other batch and its future classes are removed. Reason:`, "");
    if (reason === null) return;
    try { await archiveBatch(b.id, reason); push(`${b.code} archived.`); load(); } catch (e) { push((e as Error).message, "error"); }
  };

  return (
    <div className="space-y-6" data-testid="intake-batches">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-heading text-base font-semibold text-foreground-950">Class batches</h3>
            <p className="text-sm text-foreground-600">Each batch has its own dates, units, weekly class times, room and trainer; its students follow its classes.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-foreground-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
            {canEdit ? <Button size="sm" icon="ri-add-line" onClick={() => setEditing({ code: `B${(batches?.length ?? 0) + 1}` })} data-testid="batch-add">Add batch</Button> : null}
          </div>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {batches === null ? <SkeletonLines /> : batches.length === 0 ? <Empty icon="ri-group-line" title="No batches yet" text="Add the first batch (B1)." /> : (
          <ul className="grid gap-3 md:grid-cols-2">
            {batches.map((b) => (
              <li key={b.id} className={`rounded-card border border-background-200 bg-background-50 p-4 ${b.archivedAt ? "opacity-60" : ""}`} data-testid={`batch-${b.code}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground-950">{batchLabel(b)} {b.archivedAt ? <Badge tone="muted">Archived</Badge> : null}</p>
                    {b.startDate ? <p className="text-xs font-semibold text-foreground-800">{shortDate(b.startDate)} – {shortDate(b.endDate ?? null)}{b.unitDates ? ` · ${b.unitDates} unit${b.unitDates === 1 ? "" : "s"}` : ""}</p> : null}
                    {(() => { const n = Math.max(b.students, b.unitStudents ?? 0); return <p className="text-xs text-foreground-600">{b.room ?? "No room"} · {b.trainer ?? "No default trainer"} · {b.capacity ? `${n} of ${b.capacity} seats` : `${n} student${n === 1 ? "" : "s"}`}</p>; })()}
                  </div>
                  {canEdit && !b.archivedAt ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => setEditing(b)}>Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => setTimesFor(b)}>Class times</Button>
                      <Button size="sm" variant="ghost" icon="ri-archive-line" aria-label={`Archive ${b.code}`} onClick={() => void archive(b)} />
                    </div>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-foreground-700">
                  {b.classTimes.length ? b.classTimes.map((t) => `${WEEKDAY_SHORT[t.weekday - 1]} ${t.start}–${t.end}`).join(" · ") : "No weekly class times yet"}
                  {b.classTimes.length ? ` · ${b.weeklyHours} h a week · ${b.upcoming} classes ahead` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {editing ? (
          <div className="rounded-card border border-primary-200 bg-background-50 p-4" data-testid="batch-form">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Code"><TextInput value={editing.code ?? ""} maxLength={10} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name"><TextInput value={editing.name ?? ""} maxLength={120} placeholder="e.g. Evening group" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Seats"><TextInput type="number" min={1} value={editing.capacity ?? ""} onChange={(e) => setEditing({ ...editing, capacity: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="Room">
                <Select value={editing.roomId ?? ""} onChange={(e) => setEditing({ ...editing, roomId: e.target.value || null })}>
                  <option value="">No room</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </Field>
              <Field label="Default trainer">
                <Select value={editing.defaultTrainerId ?? ""} onChange={(e) => setEditing({ ...editing, defaultTrainerId: e.target.value || null })}>
                  <option value="">None</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => void save()} data-testid="batch-save">{editing.id ? "Save batch" : "Add batch"}</Button>
            </div>
          </div>
        ) : null}
        {timesFor ? <ClassTimesEditor batch={timesFor} rooms={rooms} staff={staff} onClose={() => setTimesFor(null)} onSaved={() => { setTimesFor(null); load(); }} /> : null}
      </section>

      <BatchTimetable intakeId={intakeId} batches={live} />
      <BatchStudents intakeId={intakeId} batches={live} units={units} canAssign={canAssign} onChanged={load} />
    </div>
  );
}

function ClassTimesEditor({ batch, rooms, staff, onClose, onSaved }: {
  batch: IntakeBatch; rooms: { id: string; name: string }[]; staff: StaffOption[]; onClose: () => void; onSaved: () => void;
}) {
  const { push } = useToast();
  const [rows, setRows] = useState<BatchClassTime[]>(batch.classTimes.length ? batch.classTimes : [{ weekday: 1, start: "09:00", end: "13:00", sessionType: "theory", roomId: null, trainerId: null }]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<BatchClassTime>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const hours = rows.reduce((h, r) => { const [a, b] = [r.start, r.end].map((t) => { const [x, y] = t.split(":").map(Number); return x * 60 + y; }); return h + Math.max(0, b - a) / 60; }, 0);
  const save = async () => {
    if (rows.some((r) => !r.start || !r.end || r.end <= r.start)) { push("Each class needs a start before its end.", "error"); return; }
    setBusy(true);
    try {
      const out = await saveBatchTimes(batch.id, rows);
      const short = out.classes?.short ?? [];
      push(`${batch.code}: ${out.times} weekly class time${out.times === 1 ? "" : "s"} saved, ${out.classes?.created ?? 0} classes planned.${short.length ? ` Short of hours: ${short.map((s) => `${s.code} (${s.hoursShort} h)`).join(", ")}.` : ""}`, short.length ? "error" : undefined);
      onSaved();
    } catch (e) { push((e as Error).message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-card border border-primary-200 bg-background-50 p-4" data-testid="batch-times">
      <p className="mb-2 font-medium text-foreground-950">{batchLabel(batch)}: weekly class times <span className="text-sm font-normal text-foreground-600">({Math.round(hours * 10) / 10} h a week)</span></p>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="grid gap-2 sm:grid-cols-[7rem_6rem_6rem_8rem_1fr_1fr_auto]">
            <Select aria-label="Day" value={String(r.weekday)} onChange={(e) => set(i, { weekday: Number(e.target.value) })}>{WEEKDAY_SHORT.map((d, k) => <option key={d} value={k + 1}>{d}</option>)}</Select>
            <TextInput aria-label="Start" type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} />
            <TextInput aria-label="End" type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} />
            <Select aria-label="Study type" value={r.sessionType} onChange={(e) => set(i, { sessionType: e.target.value as BatchClassTime["sessionType"] })}>
              <option value="theory">Theory</option><option value="practical">Practical</option><option value="assessment">Assessment</option>
            </Select>
            <Select aria-label="Room" value={r.roomId ?? ""} onChange={(e) => set(i, { roomId: e.target.value || null })}><option value="">Batch room</option>{rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <Select aria-label="Trainer" value={r.trainerId ?? ""} onChange={(e) => set(i, { trainerId: e.target.value || null })}><option value="">Batch trainer</option>{staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setRows(rows.filter((_, k) => k !== i))} />
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setRows([...rows, { weekday: 1, start: "09:00", end: "13:00", sessionType: "theory", roomId: null, trainerId: null }])}>Add class time</Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void save()}>{busy ? "Planning…" : "Save and plan classes"}</Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-foreground-600">Saving plans this intake's classes again from today (classes changed by hand and past classes stay). Each batch gets the full unit hours within the Master's unit dates.</p>
    </div>
  );
}

function BatchTimetable({ intakeId, batches }: { intakeId: string; batches: IntakeBatch[] }) {
  const [view, setView] = useState<View>("weekly");
  const [from, setFrom] = useState(mondayOf(iso(new Date())));
  const [only, setOnly] = useState("");
  const [rows, setRows] = useState<BatchSessionRow[] | null>(null);
  const span = view === "class" ? 27 : 6;
  useEffect(() => {
    setRows(null);
    void batchSessions({ intakeId, batchId: only || undefined, from, to: addDays(from, span) }).then(setRows).catch(() => setRows([]));
  }, [intakeId, only, from, span]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(from, i)), [from]);
  const shown = only ? batches.filter((b) => b.id === only) : batches;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-base font-semibold text-foreground-950">Batch timetable</h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-background-300" role="tablist" aria-label="View">
            {(["class", "daily", "weekly"] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                className={`px-3 py-1 text-sm ${view === v ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700"}`}>{v === "class" ? "Class" : v === "daily" ? "Daily" : "Weekly"}</button>
            ))}
          </div>
          <Select aria-label="Batch" className="!w-auto" value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">All batches</option>{batches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b)}</option>)}
          </Select>
          <Button size="sm" variant="outline" icon="ri-arrow-left-s-line" aria-label="Earlier" onClick={() => setFrom(addDays(from, -(span + 1)))} />
          <span className="text-sm text-foreground-700">{niceDate(from)} – {niceDate(addDays(from, span))}</span>
          <Button size="sm" variant="outline" icon="ri-arrow-right-s-line" aria-label="Later" onClick={() => setFrom(addDays(from, span + 1))} />
        </div>
      </div>
      {rows === null ? <SkeletonLines /> : rows.length === 0 ? <p className="text-sm text-foreground-600">No classes in these dates.</p> : view === "weekly" ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead><tr><th className="p-2 text-left font-medium text-foreground-600">Batch</th>{days.map((d) => <th key={d} className="p-2 text-left font-medium text-foreground-600">{niceDate(d)}</th>)}</tr></thead>
            <tbody>{shown.map((b) => (
              <tr key={b.id} className="border-t border-background-200 align-top">
                <td className="p-2 font-medium text-foreground-900">{b.code}</td>
                {days.map((d) => <td key={d} className="p-2">{rows.filter((r) => r.batchId === b.id && r.date === d).map((r) => (
                  <div key={r.id} className={`mb-1 rounded border px-1.5 py-1 ${r.status === "cancelled" ? "border-background-300 line-through opacity-60" : "border-primary-200 bg-primary-50"}`}>
                    <div className="font-medium">{r.start}–{r.end}</div><div>{r.unitCode ?? "—"} · {r.sessionType}</div><div className="text-foreground-600">{r.room ?? ""}{r.trainer ? ` · ${r.trainer}` : ""}</div>
                  </div>))}</td>)}
              </tr>))}</tbody>
          </table>
        </div>
      ) : view === "daily" ? (
        <div className="space-y-3">{days.filter((d) => rows.some((r) => r.date === d)).map((d) => (
          <div key={d}><p className="mb-1 text-sm font-semibold text-foreground-900">{niceDate(d)}</p>
            <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.filter((r) => r.date === d).map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 px-3 py-1.5 text-sm"><span className="font-medium">{r.start}–{r.end}</span><Badge tone="secondary">{r.batch}</Badge><span>{r.unitCode ?? "—"} {r.unitName ?? ""}</span><span className="text-foreground-600">{r.sessionType} · {r.room ?? "no room"}{r.trainer ? ` · ${r.trainer}` : ""}</span></li>))}</ul>
          </div>))}</div>
      ) : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.map((r) => (
          <li key={r.id} className="grid gap-1 px-3 py-1.5 text-sm sm:grid-cols-[8rem_7rem_4rem_1fr_1fr]">
            <span>{niceDate(r.date)}</span><span>{r.start}–{r.end}</span><Badge tone="secondary">{r.batch}</Badge><span>{r.unitCode ?? "—"} · {r.sessionType}</span><span className="text-foreground-600">{r.room ?? "no room"}{r.trainer ? ` · ${r.trainer}` : ""}{r.status === "cancelled" ? " · cancelled" : ""}</span>
          </li>))}</ul>
      )}
    </section>
  );
}

function BatchStudents({ intakeId, batches, units, canAssign, onChanged }: {
  intakeId: string; batches: IntakeBatch[]; units: { unitId: string; code: string }[]; canAssign: boolean; onChanged: () => void;
}) {
  const { push } = useToast();
  const [members, setMembers] = useState<BatchMember[] | null>(null);
  const [edit, setEdit] = useState<{ enrolmentId: string; whole: string[]; perUnit: { batchId: string; unitId: string }[] } | null>(null);
  const load = useCallback(() => { void batchMembers(intakeId).then(setMembers).catch(() => setMembers([])); }, [intakeId]);
  useEffect(() => { load(); }, [load]);
  const code = (id: string) => batches.find((b) => b.id === id)?.code ?? "archived";
  const save = async () => {
    if (!edit) return;
    if (!edit.whole.length) { push("Choose at least one batch for the whole course.", "error"); return; }
    try {
      await assignBatches(edit.enrolmentId, [...edit.whole.map((batchId) => ({ batchId })), ...edit.perUnit.filter((p) => p.batchId && p.unitId)]);
      push("Batches saved."); setEdit(null); load(); onChanged();
    } catch (e) { push((e as Error).message, "error"); }
  };
  return (
    <section className="space-y-3">
      <h3 className="font-heading text-base font-semibold text-foreground-950">Students and their batches</h3>
      {members === null ? <SkeletonLines /> : members.length === 0 ? <p className="text-sm text-foreground-600">No active students in this intake.</p> : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{members.map((m) => (
          <li key={m.enrolmentId} className="px-3 py-2 text-sm" data-testid={`batch-member-${m.studentId}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 font-medium text-foreground-900">{m.name}</span>
              <span className="text-xs text-foreground-600">Course {m.courseStart ?? "?"} – {m.courseEnd ?? "?"}</span>
              {m.batches.map((b, i) => <Badge key={i} tone={b.unitId ? "accent" : "secondary"}>{code(b.batchId)}{b.unitCode ? ` · ${b.unitCode} only` : ""}</Badge>)}
              {canAssign ? <Button size="sm" variant="outline" onClick={() => setEdit({ enrolmentId: m.enrolmentId, whole: m.batches.filter((b) => !b.unitId).map((b) => b.batchId), perUnit: m.batches.filter((b) => b.unitId).map((b) => ({ batchId: b.batchId, unitId: b.unitId as string })) })}>Change batches</Button> : null}
            </div>
            {edit?.enrolmentId === m.enrolmentId ? (
              <div className="mt-2 space-y-2 rounded-md bg-background-100 p-3">
                <div><span className="mb-1 block text-xs font-medium text-foreground-800">Whole-course batches (one or more)</span>
                  <div className="flex flex-wrap gap-1.5">{batches.map((b) => {
                    const on = edit.whole.includes(b.id);
                    return <button key={b.id} type="button" aria-pressed={on} onClick={() => setEdit({ ...edit, whole: on ? edit.whole.filter((x) => x !== b.id) : [...edit.whole, b.id] })}
                      className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary-400 bg-primary-50 font-medium text-primary-800" : "border-background-300 text-foreground-600"}`}>{on ? "✓ " : ""}{batchLabel(b)}</button>;
                  })}</div></div>
                <div><span className="mb-1 block text-xs font-medium text-foreground-800">A single unit with another batch (e.g. a missed unit)</span>
                  {edit.perUnit.map((p, i) => (
                    <div key={i} className="mb-1 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <Select aria-label="Unit" value={p.unitId} onChange={(e) => setEdit({ ...edit, perUnit: edit.perUnit.map((x, k) => (k === i ? { ...x, unitId: e.target.value } : x)) })}><option value="">Unit</option>{units.map((u) => <option key={u.unitId} value={u.unitId}>{u.code}</option>)}</Select>
                      <Select aria-label="Batch" value={p.batchId} onChange={(e) => setEdit({ ...edit, perUnit: edit.perUnit.map((x, k) => (k === i ? { ...x, batchId: e.target.value } : x)) })}><option value="">Batch</option>{batches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b)}</option>)}</Select>
                      <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setEdit({ ...edit, perUnit: edit.perUnit.filter((_, k) => k !== i) })} />
                    </div>))}
                  <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setEdit({ ...edit, perUnit: [...edit.perUnit, { batchId: "", unitId: "" }] })}>Add unit batch</Button></div>
                <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button size="sm" onClick={() => void save()}>Save batches</Button></div>
              </div>
            ) : null}
          </li>))}</ul>
      )}
      <p className="text-xs text-foreground-600">A student's classes and attendance follow their batches; their assessment windows follow the Master unit dates. Every change is logged.</p>
    </section>
  );
}
