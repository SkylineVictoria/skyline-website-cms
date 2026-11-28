// Courses whose last scheduled cycle ends within ALERT_MONTHS (Business Rule lms.master_plan_alert_months, 12) (owner, 2026-11-20). Every admin page opens the alert once a week
// for each admin until more cycles are scheduled ("Remind me next week" records this week as seen, on the server); the dashboard
// also shows a banner. From LOCK_MONTHS (lms.master_plan_lock_months, 3) before the end the course is locked: no new intakes, enrolments or class time changes.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { ALERT_MONTHS, LOCK_MONTHS, MAX_YEARS } from "@/pages/admin/lib/masterDates";

interface Due { courseId: string; code: string; name: string; planEnd: string; daysLeft: number; locked: boolean; cyclesPlanned: number; seenThisWeek: boolean }
const day = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function MasterTimetableDue({ banner = false, weeklyPopup = false }: { banner?: boolean; weeklyPopup?: boolean }) {
  const [due, setDue] = useState<Due[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    supabase.rpc("rto_master_cycles", { p_action: "alerts", p_data: {} }).then(({ data, error }) => {
      if (!live || error || !Array.isArray(data) || !data.length) return;
      const list = data as Due[];
      setDue(list);
      if (weeklyPopup && list.some(item => !item.seenThisWeek)) setOpen(true);
    });
    return () => { live = false; };
  }, [weeklyPopup]);

  if (!due.length) return null;
  const later = () => { setOpen(false); // A Supabase query only runs once it is awaited / then-ed: without .then the "seen" row was never saved and the popup came back on every page.
    // rule-policy: technical alert-seen-save Sends the existing weekly "seen" record; the one-week reminder interval is unchanged.
    void supabase.rpc("rto_master_cycles", { p_action: "alerts_seen", p_data: {} }).then(({ error }) => { if (error) console.warn("Could not save the reminder", error.message); }); };
  const locked = due.filter(item => item.locked);
  return <>
    {banner ? <div role="alert" className={"mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm " + (locked.length ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900")}>
      <span><i className={(locked.length ? "ri-lock-line" : "ri-calendar-event-line") + " mr-1"} aria-hidden="true" />
        {locked.length ? `${locked.map(item => item.code).join(", ")} ${locked.length === 1 ? "is" : "are"} locked until more cycles are scheduled.`
          : `${due.length === 1 ? due[0].code + "'s" : due.length + " courses'"} last scheduled cycle ends within ${ALERT_MONTHS} month${ALERT_MONTHS === 1 ? "" : "s"}: schedule more cycles.`}</span>
      <button type="button" className="font-semibold underline" onClick={() => setOpen(true)}>Show</button>
    </div> : null}
    <Modal open={open} title="Schedule more cycles" onClose={later} width="max-w-2xl"
      footer={<div className="flex justify-end"><Button variant="outline" onClick={later}>Remind me next week</Button></div>}>
      <p className="text-sm text-foreground-700">The last scheduled cycle of these courses ends within {ALERT_MONTHS} month{ALERT_MONTHS === 1 ? "" : "s"}. Open the course's Weekly Calendar, raise
        <b> Qualification cycles</b> or <b>Calendar till</b> (up to {MAX_YEARS} years) and save. {LOCK_MONTHS} month{LOCK_MONTHS === 1 ? "" : "s"} before the end the course is locked: no new intakes, enrolments or class time changes.</p>
      <ul className="mt-3 divide-y divide-background-200 rounded-lg border border-background-200">
        {due.map(item => <li key={item.courseId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          <span className="min-w-0"><b className="text-foreground-950">{item.code}</b> <span className="text-foreground-700">{item.name}</span>
            <span className={"block text-xs " + (item.locked ? "font-semibold text-red-700" : "text-foreground-600")}>
              {item.locked ? <><i className="ri-lock-line mr-1" aria-hidden="true" />Locked: </> : null}
              {item.daysLeft < 0 ? `Ended ${day(item.planEnd)}` : `Last cycle ends ${day(item.planEnd)} (${item.daysLeft} day${item.daysLeft === 1 ? "" : "s"} left)`} · {item.cyclesPlanned} cycle{item.cyclesPlanned === 1 ? "" : "s"} scheduled</span></span>
          <Link to={`/admin/lms/master-calendar?course=${encodeURIComponent(item.courseId)}`} onClick={later}
            className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Open Weekly Calendar</Link>
        </li>)}
      </ul>
    </Modal>
  </>;
}
