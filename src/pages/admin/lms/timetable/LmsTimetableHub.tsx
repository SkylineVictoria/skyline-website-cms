// LMS > Timetable: Today strip + one calendar of every class (filter by course, intake, trainer, room or student). Classes are created in
// Timetable › Create timetable. TIMETABLE-TIDY (owner 2026-11-28: "tons of garbage calendars"): the Trainers, Rooms, Students and
// Intakes timeline tabs are gone (trainers', rooms' and students' weeks stay in Bookings › Availability; old ?view= links open the calendar).
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/pages/admin/components/ui";
import { rto, todayIso } from "@/pages/admin/lib/rto";
import ClassCalendar from "./ClassCalendar";
import { loadCalendar, loadPeople, type CalClass, type CalPeople } from "./calendarData";

export default function LmsTimetableHub() {
  const [me, setMe] = useState<{ rtoManager: boolean; admin: boolean } | null>(null);
  const [people, setPeople] = useState<CalPeople | null>(null);
  const [today, setToday] = useState<CalClass[] | null>(null);
  const allowed = !!me && (me.admin || me.rtoManager);

  useEffect(() => { rto<{ rtoManager: boolean; admin: boolean }>("me").then(setMe).catch(() => setMe({ rtoManager: false, admin: false })); }, []);
  useEffect(() => {
    if (!allowed) return;
    loadPeople().then(setPeople).catch(() => setPeople(null));
    loadCalendar(todayIso(), todayIso()).then(setToday).catch(() => setToday([]));
  }, [allowed]);

  const strip = useMemo(() => {
    const list = today ?? [];
    const now = new Date().toTimeString().slice(0, 5);
    return [
      { label: "Classes today", value: list.length },
      { label: "Trainers teaching", value: new Set(list.flatMap((c) => c.trainers.map((t) => t.id))).size },
      { label: "Rooms in use", value: new Set(list.map((c) => c.roomId).filter(Boolean)).size },
      { label: "Students in class", value: list.reduce((s, c) => s + c.students, 0) },
      { label: "Waiting for attendance", value: list.filter((c) => c.end <= now && c.attendance !== "final").length, warn: true },
    ];
  }, [today]);

  if (me && !allowed) return <div><PageHeader title="Timetable" /><p className="text-sm text-foreground-600">The timetable is for Admins and RTO Managers.</p></div>;

  return (
    <div className="space-y-4">
      <PageHeader title="Timetable" description="Every class across courses and intakes: who teaches, who studies, which room, and when." />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Today">
        {strip.map((s) => (
          <div key={s.label} className={`rounded-card border px-3 py-2 ${s.warn && s.value ? "border-amber-300 bg-amber-50" : "border-background-200 bg-background-50"}`}>
            <p className="text-xs text-foreground-500">{s.label}</p>
            <p className={`font-heading text-2xl font-bold ${s.warn && s.value ? "text-amber-800" : "text-foreground-950"}`}>{today ? s.value : "…"}</p>
          </div>
        ))}
      </div>
      {!me ? <p className="text-sm text-foreground-500">Loading…</p> : <ClassCalendar people={people} />}
    </div>
  );
}

