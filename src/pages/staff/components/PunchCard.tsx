import { useCallback, useEffect, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { getTimeStatus, punch, type PunchKind, type TimeStatus } from "@/lib/hrmsApi";
import { FLAG_LABEL, PUNCH_LABEL, STATE_LABEL, elapsedLabel, fmtDate, fmtTime, minutesToHm, tzAbbrev } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;

/** My HR > Punch card: only the punches the state machine allows right now, a live timer, and today's shifts in the HR timezone. */
export default function PunchCard({ onChange }: { onChange?: () => void } = {}) {
  const [status, setStatus] = useState<TimeStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0); // server clock minus browser clock
  const [tick, setTick] = useState(Date.now());

  const load = useCallback(async () => {
    try { const s = await getTimeStatus(); setStatus(s); setOffset(new Date(s.serverNow).getTime() - Date.now()); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Your punch status could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => setTick(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  // Re-read once a minute so a punch from another device shows up.
  useEffect(() => { const t = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(t); }, [load]);

  const doPunch = async (kind: PunchKind) => {
    setBusy(true); setError("");
    try { const s = await punch(kind, isMobile() ? "mobile" : "web"); setStatus(s); setOffset(new Date(s.serverNow).getTime() - Date.now()); onChange?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The punch could not be recorded."); await load(); }
    finally { setBusy(false); }
  };

  const now = tick + offset;
  const tz = status?.timezone ?? "Australia/Melbourne";
  const working = status?.state === "punch_in" || status?.state === "break_end";
  const onBreak = status?.state === "break_start";
  return (
    <div data-testid="my-hr-punch">
      {error ? <p role="alert" className={`mb-3 ${ALERT}`} data-testid="punch-error">{error}</p> : null}
      {!status ? <p className="text-sm text-foreground-600">Loading…</p> : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-foreground-600">Now {fmtTime(now, tz)} {tzAbbrev(now, tz)} · {fmtDate(status.today)}</p>
              <p className="font-heading text-xl font-bold text-foreground-950" data-testid="punch-state">{STATE_LABEL[status.state] ?? status.state}</p>
              {status.openShift ? (
                <p className="text-sm text-foreground-700" data-testid="punch-timer">
                  Since {fmtTime(status.openShift.startedAt, tz)} · <span className="font-mono tabular-nums">{elapsedLabel(status.openShift.startedAt, now)}</span>
                  {onBreak && status.since ? <span className="ml-2">(on a break since {fmtTime(status.since, tz)})</span> : null}
                  {status.openShift.flags.length ? <span className="ml-2 text-primary-800">{status.openShift.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}</span> : null}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {status.nextKinds.map((k) => (
                <Button key={k} variant={k === "punch_in" || k === "break_end" ? "primary" : "outline"} disabled={busy} onClick={() => void doPunch(k)} data-testid={`punch-${k}`} className="min-w-[8rem]">
                  {PUNCH_LABEL[k]}
                </Button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-600">Today</h3>
            {status.todayShifts.length ? (
              <ul className="mt-1 divide-y divide-background-200" data-testid="punch-today">
                {status.todayShifts.map((s) => (
                  <li key={s.startedAt} className="py-1.5 text-sm text-foreground-800">
                    {fmtTime(s.startedAt, tz)} – {s.endedAt ? fmtTime(s.endedAt, tz) : <em>{working || onBreak ? "now" : "open"}</em>} {tzAbbrev(s.startedAt, tz)} · {minutesToHm(s.workedMinutes)} worked{s.breakMinutes ? `, ${minutesToHm(s.breakMinutes)} break` : ""}
                    {s.flags.filter((f) => f !== "missing_punch_out" || !s.isOpen).map((f) => <span key={f} className="ml-2 rounded-full bg-primary-50 px-2 py-0.5 text-2xs text-primary-900">{FLAG_LABEL[f] ?? f}</span>)}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-sm text-foreground-600">No shift yet today.</p>}
          </div>
        </>
      )}
    </div>
  );
}
