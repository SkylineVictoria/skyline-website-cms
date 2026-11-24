import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { friendlyDbError, shortDate } from "@/pages/admin/lib/rto";
import SearchableSelect from "@/components/ui/SearchableSelect";

type Options = {
  applications: { id: string; reference: string; status: string; courseCode: string | null }[];
  intakes: { id: string; name: string; courseCode: string; courseName: string; startDate: string; endDate: string | null; load: string; joinDates?: { date: string; firstDay: boolean; unitCode: string | null; unitName: string | null }[] }[];
};

/**
 * Re-add to intake (owner, 2026-11-23): after a course was deleted and created again, an Admin or RTO Manager links one of the
 * student's applications to an open intake of the new course and places the student there in one step, with a reason
 * (rto_readd_to_intake, 20261123191517). Shown on the CMS student page. The join date is day one or any unit start date
 * of the intake (joinDates, 20261123211517).
 */
export default function ReAddToIntake({ studentId, onDone }: { studentId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [application, setApplication] = useState("");
  const [intake, setIntake] = useState("");
  const [joinOn, setJoinOn] = useState("");
  const [reason, setReason] = useState("Course was deleted and created again; back in the new intake.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(""); setDone("");
    void supabase.rpc("rto_readd_options", { p_student: studentId }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(friendlyDbError(e.message)); return; }
      const o = data as Options;
      setOptions(o);
      // Start with an application that lost its course, and an intake of the course it names (else the first one).
      const lost = o.applications.find((a) => !a.courseCode) ?? o.applications[0];
      setApplication(lost?.id ?? "");
      setIntake((o.intakes.find((i) => lost?.courseCode && i.courseCode === lost.courseCode) ?? o.intakes[0])?.id ?? "");
    });
    return () => { live = false; };
  }, [open, studentId]);

  const chosen = useMemo(() => options?.intakes.find((i) => i.id === intake), [options, intake]);
  const joinDates = useMemo(() => chosen?.joinDates ?? [], [chosen]);
  // A new intake starts on its first join date (day one, else the next unit start); none listed = today / day one.
  useEffect(() => { setJoinOn(joinDates[0]?.date ?? ""); }, [joinDates]);
  const submit = async () => {
    if (!application || !intake || !reason.trim()) return;
    setBusy(true); setError("");
    const { data, error: e } = await supabase.rpc("rto_readd_to_intake", { p_student: studentId, p_application: application, p_intake: intake, p_reason: reason.trim(), p_on: joinOn || null });
    setBusy(false);
    if (e) { setError(friendlyDbError(e.message)); return; }
    const r = data as { batch?: string; joinedOn?: string } | null;
    setDone(`Added to ${r?.batch ?? chosen?.name ?? "the intake"}${r?.joinedOn ? `, joining ${shortDate(r.joinedOn)}` : ""}.`);
    onDone?.();
  };
  const field = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";

  return <>
    <Button variant="outline" icon="ri-user-add-line" onClick={() => setOpen(true)}>Re-add to intake</Button>
    <Modal open={open} title="Re-add to intake" width="max-w-lg" onClose={() => { if (!busy) setOpen(false); }}
      footer={<div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{done ? "Close" : "Cancel"}</Button>
        {done ? null : <Button disabled={busy || !application || !intake || !reason.trim()} onClick={() => void submit()}>{busy ? "Adding…" : "Re-add to intake"}</Button>}
      </div>}>
      <div className="space-y-3 text-sm">
        <p className="text-foreground-600">Use this when the student's course was deleted and created again (or they need to join another intake). Their application is linked to the intake's course and they are placed in it from the join date you pick: the intake's first day or the start of any unit.</p>
        {options === null && !error ? <p className="text-foreground-500">Loading…</p> : null}
        {options ? <>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-foreground-600">Application</span>
            <SearchableSelect className={field} value={application} disabled={busy || !!done} onChange={(e) => setApplication(e.target.value)}>
              {options.applications.length ? null : <option value="">No submitted application</option>}
              {options.applications.map((a) => <option key={a.id} value={a.id}>{a.reference} · {a.status.replace(/_/g, " ")} · {a.courseCode ?? "course missing"}</option>)}
            </SearchableSelect></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-foreground-600">Intake</span>
            <SearchableSelect className={field} value={intake} disabled={busy || !!done} onChange={(e) => setIntake(e.target.value)}>
              {options.intakes.length ? null : <option value="">No open intake</option>}
              {options.intakes.map((i) => <option key={i.id} value={i.id}>{i.courseCode} · {i.name} · {i.load.toUpperCase()} · {shortDate(i.startDate)}{i.endDate ? ` – ${shortDate(i.endDate)}` : ""}</option>)}
            </SearchableSelect></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-foreground-600">Joins on</span>
            <SearchableSelect className={field} value={joinOn} disabled={busy || !!done || !chosen} onChange={(e) => setJoinOn(e.target.value)}>
              {joinDates.length ? null : <option value="">Today (no upcoming unit start)</option>}
              {joinDates.map((d) => <option key={d.date} value={d.date}>{shortDate(d.date)} · {d.firstDay ? "day one of the intake" : d.unitCode ? `${d.unitCode}${d.unitName ? ` ${d.unitName}` : ""}` : "unit start"}</option>)}
            </SearchableSelect></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-foreground-600">Reason (kept on the record)</span>
            <textarea className={field} rows={2} maxLength={500} value={reason} disabled={busy || !!done} onChange={(e) => setReason(e.target.value)} /></label>
        </> : null}
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{error}</p> : null}
        {done ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-green-800">{done}</p> : null}
      </div>
    </Modal>
  </>;
}
