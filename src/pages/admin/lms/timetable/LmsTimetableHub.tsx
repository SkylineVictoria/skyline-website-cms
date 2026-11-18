// LMS > Timetable: Today strip + Calendar, Trainers, Rooms, Students, Intakes timeline and Setup (weekly class timing per intake).
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/pages/admin/components/ui";
import RoomsBoard from "@/pages/admin/components/rto/RoomsBoard";
import { rto, todayIso } from "@/pages/admin/lib/rto";
import LmsTimetablePage from "../LmsTimetablePage";
import ClassCalendar from "./ClassCalendar";
import TrainersWeek from "./TrainersWeek";
import StudentsView from "./StudentsView";
import IntakesTimeline from "./IntakesTimeline";
import { loadCalendar, loadPeople, type CalClass, type CalPeople } from "./calendarData";

const TABS = [
  { id: "calendar", label: "Calendar", icon: "ri-calendar-2-line" },
  { id: "trainers", label: "Trainers", icon: "ri-user-star-line" },
  { id: "rooms", label: "Rooms", icon: "ri-door-open-line" },
  { id: "students", label: "Students", icon: "ri-group-line" },
  { id: "intakes", label: "Intakes timeline", icon: "ri-bar-chart-horizontal-line" },
  { id: "setup", label: "Setup", icon: "ri-settings-3-line" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function LmsTimetableHub() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("view"))?.id ?? "calendar") as TabId;
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

  if (me && !allowed) return <div><PageHeader title="Timetable" /><LmsTimetablePage /></div>;

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
      <div className="-mb-px flex gap-1 overflow-x-auto border-b border-background-200" role="tablist" aria-label="Timetable views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === "calendar" ? {} : { view: t.id }, { replace: true })}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
            <i className={t.icon} aria-hidden="true" />{t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {!me ? <p className="text-sm text-foreground-500">Loading…</p>
          : tab === "calendar" ? <ClassCalendar people={people} />
          : tab === "trainers" ? <TrainersWeek people={people} />
          : tab === "rooms" ? <RoomsBoard canEdit={me.rtoManager} />
          : tab === "students" ? <StudentsView people={people} />
          : tab === "intakes" ? <IntakesTimeline />
          : <LmsTimetablePage />}
      </div>
    </div>
  );
}
