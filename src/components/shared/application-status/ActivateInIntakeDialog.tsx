import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./ActionDrawer";
import type { StatusResult } from "./StatusDialogs";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import { supabase } from "@/pages/admin/lib/supabase";
import type { StatusAction } from "@/lib/applicationStatuses";
import { changeApplicationStatus } from "@/pages/agency/lib/portalApplications";
import SearchableSelect from "@/components/ui/SearchableSelect";

type JoinDate = { date: string; firstDay: boolean; unitCode: string | null; unitName: string | null };
type Intake = { id: string; name: string; courseCode: string; startDate: string; endDate: string | null; load: string; joinDates?: JoinDate[] };
type Options = { studentId: string; courseCodes: string[]; intakes: Intake[] };

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });

/**
 * ACTIVE-NEEDS-INTAKE (owner, 2026-11-23): moving an application to Active first asks for the intake and the join date (day one or a
 * unit start). The student is placed (rto_activate_in_intake), then the status moves; the database refuses Active without a
 * placement in an intake of the application's course (a0_application_active_guard, 20261123221517).
 */
export default function ActivateInIntakeDialog({ application, action, onClose, onDone }: {
  application: { id: string; studentName: string };
  action: StatusAction;
  onClose: () => void;
  onDone: (result: StatusResult) => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [intake, setIntake] = useState("");
  const [joinOn, setJoinOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void supabase.rpc("rto_activate_options", { p_application: application.id }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(e.message); return; }
      const o = data as Options;
      // Only intakes of the application's course; if it names no course that still exists, every open intake.
      const own = o.intakes.filter((i) => o.courseCodes.includes(i.courseCode));
      const list = own.length ? own : o.intakes;
      setOptions({ ...o, intakes: list });
      setIntake(list[0]?.id ?? "");
    });
    return () => { live = false; };
  }, [application.id]);

  const chosen = useMemo(() => options?.intakes.find((i) => i.id === intake), [options, intake]);
  const joinDates = useMemo(() => chosen?.joinDates ?? [], [chosen]);
  useEffect(() => { setJoinOn(joinDates[0]?.date ?? ""); }, [joinDates]);

  const confirm = async () => {
    if (!intake) { setError("Choose an intake."); return; }
    if (!joinOn) { setError("Choose a start date: the intake's first day or a unit start."); return; }
    setBusy(true); setError("");
    try {
      const placed = await supabase.rpc("rto_activate_in_intake", { p_application: application.id, p_intake: intake, p_on: joinOn, p_reason: "Activated in an intake" });
      if (placed.error) throw new Error(placed.error.message);
      onDone(await changeApplicationStatus(application.id, action.action, { note: `Placed in ${chosen?.name ?? "the intake"} from ${joinOn}` }));
    } catch (e) { setError(e instanceof Error ? e.message : "The student could not be activated."); }
    finally { setBusy(false); }
  };

  const field = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
  return (
    <ConfirmDialog title="Activate in an intake" confirmLabel={busy ? "Activating…" : "Activate"} busy={busy} onClose={onClose} onConfirm={() => void confirm()}
      body={`${application.studentName || "The student"} becomes Active only once placed in an intake. Choose the intake and the unit they start with.`}>
      <div className="mt-2 space-y-3">
        {options === null && !error ? <p className="text-sm text-foreground-500">Loading intakes…</p> : null}
        {options ? <>
          <label className="block"><span className={`${FORM_LABEL} mb-1 block`}>Intake</span>
            <SearchableSelect className={field} value={intake} disabled={busy} onChange={(e) => setIntake(e.target.value)} data-testid="activate-intake">
              {options.intakes.length ? null : <option value="">No open intake for this course</option>}
              {options.intakes.map((i) => <option key={i.id} value={i.id}>{i.courseCode} · {i.name} · {i.load.toUpperCase()} · {day(i.startDate)}{i.endDate ? ` – ${day(i.endDate)}` : ""}</option>)}
            </SearchableSelect></label>
          <label className="block"><span className={`${FORM_LABEL} mb-1 block`}>Starts on (unit)</span>
            <SearchableSelect className={field} value={joinOn} disabled={busy || !chosen} onChange={(e) => setJoinOn(e.target.value)} data-testid="activate-join">
              {joinDates.length ? null : <option value="">No upcoming unit start in this intake</option>}
              {joinDates.map((d) => <option key={d.date} value={d.date}>{day(d.date)} · {d.firstDay ? "day one of the intake" : d.unitCode ? `${d.unitCode}${d.unitName ? ` ${d.unitName}` : ""}` : "unit start"}</option>)}
            </SearchableSelect></label>
        </> : null}
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
