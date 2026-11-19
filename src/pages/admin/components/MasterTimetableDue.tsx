// Dashboard popup: courses whose master timetable ends within three months (or has ended) and have no next cycle yet. The next
// cycle is never made automatically: an RTO Manager enters the term breaks for that period and creates it on the course's Master
// timetable tab. The popup comes back on every visit to the dashboard until that is done ("Remind me later" hides it for this
// browser session only).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";

interface Due { courseId: string; code: string; name: string; endDate: string; daysLeft: number }
const KEY = "master-timetable-due-later";
const day = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function MasterTimetableDue() {
  const [due, setDue] = useState<Due[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    supabase.rpc("rto_master_timetable", { p_action: "due", p_data: {} }).then(({ data, error }) => {
      if (!live || error || !Array.isArray(data) || !data.length) return;
      setDue(data as Due[]);
      let later = false;
      try { later = window.sessionStorage.getItem(KEY) === "1"; } catch { /* private mode: show it */ }
      setOpen(!later);
    });
    return () => { live = false; };
  }, []);

  if (!due.length) return null;
  const later = () => { try { window.sessionStorage.setItem(KEY, "1"); } catch { /* ignore */ } setOpen(false); };
  const overdue = due.some(item => item.daysLeft < 0);
  return <>
    <div role="alert" className={"mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm " + (overdue ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900")}>
      <span><i className="ri-calendar-event-line mr-1" aria-hidden="true" />{due.length === 1 ? `The master timetable of ${due[0].code}` : `${due.length} master timetables`} {overdue ? "need" : "will need"} the next cycle: enter the term breaks, then create it.</span>
      <button type="button" className="font-semibold underline" onClick={() => setOpen(true)}>Show</button>
    </div>
    <Modal open={open} title="Master timetable: term breaks needed" onClose={later} width="max-w-2xl"
      footer={<div className="flex justify-end"><Button variant="outline" onClick={later}>Remind me later</Button></div>}>
      <p className="text-sm text-foreground-700">These courses reach the end of their master timetable soon. The system cannot make the next cycle until the term breaks for that period are entered.
        Open the course, add the term breaks, then choose <b>Create the next cycle</b>.</p>
      <ul className="mt-3 divide-y divide-background-200 rounded-lg border border-background-200">
        {due.map(item => <li key={item.courseId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          <span className="min-w-0"><b className="text-foreground-950">{item.code}</b> <span className="text-foreground-700">{item.name}</span>
            <span className={"block text-xs " + (item.daysLeft < 0 ? "font-semibold text-red-700" : "text-foreground-600")}>
              {item.daysLeft < 0 ? `Ended ${day(item.endDate)}: no classes are planned after that day` : `Ends ${day(item.endDate)} (${item.daysLeft} day${item.daysLeft === 1 ? "" : "s"} left)`}</span></span>
          <Link to={`/admin/lms/courses?course=${encodeURIComponent(item.courseId)}&tab=master`} onClick={() => setOpen(false)}
            className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Open Weekly Calendar</Link>
        </li>)}
      </ul>
    </Modal>
  </>;
}
