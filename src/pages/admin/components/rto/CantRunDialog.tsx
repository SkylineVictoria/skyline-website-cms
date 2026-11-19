// "Class can't run" (CLASS-RESCHEDULE): pick a reason, the system tries the admin's rules for it and suggests a new time
// (Accept / Next option / Decide later), or staff pick a time themselves. No class is ever just cancelled.
import { useEffect, useState } from "react";
import { Button, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { rtoFlow, type LocationRooms } from "@/pages/admin/lib/rto";
import {
  candidateLine, candidateTitle, dayText, hhmm, reschedule, STEP_LABEL, whenText,
  type Candidate, type Change, type History, type Suggestion,
} from "@/pages/admin/lib/reschedule";

const KIND: Record<Change["kind"], string> = {
  moved: "Moved", waiting: "Waiting for a new time", trainer: "Trainer changed", room: "Room changed", joined: "Joined another intake",
  spread: "Made up with longer classes", online: "Moved online", extended: "Made longer",
};

export default function CantRunDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: (message: string) => void }) {
  const [info, setInfo] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sug, setSug] = useState<Suggestion | null>(null);
  const [index, setIndex] = useState(0);
  const [manual, setManual] = useState(false);
  const [m, setM] = useState({ date: "", start: "", end: "", roomId: "" });
  const [rooms, setRooms] = useState<LocationRooms[]>([]);

  useEffect(() => {
    reschedule<History>("history", { sessionId }).then((h) => {
      setInfo(h);
      const waitingKey = h.reasons.find((r) => r.label === h.session.reason)?.key;
      setReason(waitingKey ?? "");
      setM({ date: h.session.date, start: hhmm(h.session.start), end: hhmm(h.session.end), roomId: h.session.roomId ?? "" });
    }).catch((e) => setError(e instanceof Error ? e.message : "The class did not load."));
  }, [sessionId]);
  useEffect(() => { if (manual && !rooms.length) rtoFlow<LocationRooms[]>("locations_rooms").then(setRooms).catch(() => undefined); }, [manual, rooms.length]);

  const s = info?.session;
  const current: Candidate | undefined = sug?.candidates[index];
  const needReason = !s?.needsReschedule;
  const run = async (action: "apply" | "later", choice?: Candidate) => {
    setBusy(true); setError("");
    try {
      const out = await reschedule<{ notified: number; new?: string }>(action, { sessionId, reason, note, notify, choice });
      onDone(action === "later"
        ? `The class waits on Classes to reschedule.${out.notified ? ` ${out.notified} people told.` : ""}`
        : `Class rescheduled${out.new ? `: ${out.new}` : ""}.${out.notified ? ` ${out.notified} people told.` : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "The class was not changed."); }
    finally { setBusy(false); }
  };
  const find = async () => {
    setBusy(true); setError(""); setSug(null); setIndex(0);
    try {
      const out = await reschedule<Suggestion>("suggest", { sessionId, reason });
      if (out.mode === "apply" && out.candidates.length) { setBusy(false); await run("apply", out.candidates[0]); return; }
      setSug(out);
    } catch (e) { setError(e instanceof Error ? e.message : "No suggestion."); }
    finally { setBusy(false); }
  };

  const footer = !info ? null : !info.canReschedule ? <Button variant="outline" onClick={onClose}>Close</Button> : manual ? (
    <div className="flex flex-wrap justify-between gap-2">
      <Button variant="outline" onClick={() => setManual(false)}>Back</Button>
      <Button disabled={busy || !m.date || !m.start || !m.end || m.end <= m.start || (needReason && !reason)}
        onClick={() => void run("apply", { step: "manual", date: m.date, start: m.start, end: m.end, roomId: m.roomId || null, trainerId: s?.trainerId ?? null })}>
        {busy ? "Saving…" : "Save new time"}</Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="outline" className="border-amber-300 text-amber-800" disabled={busy || !reason || !!s?.needsReschedule} onClick={() => void run("later")}
        title={s?.needsReschedule ? "This class is already waiting" : "Put it on Classes to reschedule"}>Decide later</Button>
      <div className="flex flex-wrap gap-2">
        {sug && sug.candidates.length > 1 ? <Button variant="outline" disabled={busy} onClick={() => setIndex((index + 1) % sug.candidates.length)}>Next option ({index + 1} of {sug.candidates.length})</Button> : null}
        {current ? <Button disabled={busy} onClick={() => void run("apply", current)}>{busy ? "Saving…" : "Accept"}</Button>
          : <Button disabled={busy || !reason} onClick={() => void find()}>{busy ? "Looking…" : sug ? "Look again" : "Find a new time"}</Button>}
      </div>
    </div>
  );

  return (
    <Modal open title="Class can't run" onClose={onClose} width="max-w-xl" footer={footer}>
      {!info ? <p className="text-sm text-foreground-500">{error || "Loading…"}</p> : <div className="space-y-4">
        <div>
          <h3 className="font-heading text-lg font-bold text-foreground-950">{s!.unitCode} <span className="text-sm font-normal text-foreground-600">{s!.unitName}</span></h3>
          <p className="text-sm text-foreground-600">{whenText(s!.date, s!.start, s!.end)} · {s!.delivery === "online" ? "Online" : s!.roomName ?? "No room"} · {s!.trainerName ?? "No trainer"} · {s!.intakeName}</p>
          {s!.unitEnds ? <p className="text-xs text-foreground-500">The unit ends {dayText(s!.unitEnds)}: the new time must be before then.</p> : null}
          {s!.needsReschedule ? <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><i className="ri-time-line mr-1" aria-hidden="true" />Waiting for a new time{s!.reason ? `: ${s!.reason}` : ""}{s!.note ? ` (${s!.note})` : ""}.</p> : null}
        </div>

        {info.canReschedule ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-foreground-700">Reason{needReason ? " *" : ""}
              <Select className="mt-1 w-full" value={reason} onChange={(e) => { setReason(e.target.value); setSug(null); }}>
                <option value="">Choose…</option>{info.reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select></label>
            <label className="block text-xs font-semibold text-foreground-700">Note (kept on the class, added to the message)
              <TextInput className="mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Trainer unwell" /></label>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Tell the students and trainers (email, and text when connected)</label>

          {manual ? <div className="rounded-lg border border-background-200 p-3">
            <p className="mb-2 text-sm font-semibold">Pick a time myself</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs font-semibold sm:col-span-3">Date<TextInput type="date" className="mt-1 w-full" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} /></label>
              <label className="block text-xs font-semibold">Starts<TextInput type="time" className="mt-1 w-full" value={m.start} onChange={(e) => setM({ ...m, start: e.target.value })} /></label>
              <label className="block text-xs font-semibold">Ends<TextInput type="time" className="mt-1 w-full" value={m.end} onChange={(e) => setM({ ...m, end: e.target.value })} /></label>
              <label className="block text-xs font-semibold">Room<Select className="mt-1 w-full" value={m.roomId} onChange={(e) => setM({ ...m, roomId: e.target.value })}>
                <option value="">Intake's room</option>
                {rooms.map((l) => <optgroup key={l.id ?? "other"} label={l.name}>{l.rooms.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ""}</option>)}</optgroup>)}
              </Select></label>
            </div>
            <p className="mt-2 text-xs text-foreground-500">The same checks apply: before the unit ends, not a holiday or term break, room and trainer free and available.</p>
          </div> : <>
            {sug ? <div className="rounded-lg border border-background-200 p-3 text-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">Rules tried</p>
              {sug.tried.length ? sug.tried.map((t, i) => <p key={i} className={t.found ? "font-semibold text-emerald-700" : "text-red-700"}>
                {t.found ? "✓" : "✕"} {i + 1}. {STEP_LABEL[t.step]}{t.found ? `: ${t.found} found` : `: ${t.why ?? "nothing free"}`}</p>)
                : <p className="text-foreground-500">This reason has no steps switched on.</p>}
            </div> : null}
            {current ? <div className="rounded-xl border-2 border-emerald-400 bg-emerald-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Suggested · {STEP_LABEL[current.step as keyof typeof STEP_LABEL]}</p>
              <p className="font-heading text-lg font-bold text-foreground-950">{candidateTitle(current)}</p>
              <p className="text-sm text-foreground-700">{candidateLine(current)}</p>
              {notify ? <p className="mt-1 text-xs text-foreground-600">{sug!.groupSize} students and the trainers will be told.</p> : null}
            </div> : sug ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">No rule found a time. Pick a time yourself, or Decide later to keep it on Classes to reschedule.</p> : null}
            <button type="button" className="text-sm font-semibold text-primary-700 hover:underline" onClick={() => setManual(true)}>Pick a time myself</button>
          </>}
        </> : <p className="text-sm text-foreground-600">Only an RTO Manager can reschedule classes.</p>}

        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        {info.history.length ? <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">Class history</p>
          <ul className="divide-y divide-background-200 rounded-lg border border-background-200 text-sm">
            {info.history.map((h, i) => <li key={i} className="px-3 py-2">
              <span className="font-semibold">{KIND[h.kind]}</span>
              {h.old?.date ? <> {whenText(h.old.date, h.old.start ?? "", h.old.end ?? "")}</> : null}
              {h.new && typeof h.new.date === "string" && h.kind !== "waiting" ? <> → {whenText(h.new.date as string, h.new.start as string, h.new.end as string)}</> : null}
              <span className="block text-xs text-foreground-500">{[h.reason, h.note, h.by, new Date(h.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), h.notified ? `${h.notified} told` : ""].filter(Boolean).join(" · ")}</span>
            </li>)}
          </ul>
        </div> : null}
      </div>}
    </Modal>
  );
}
