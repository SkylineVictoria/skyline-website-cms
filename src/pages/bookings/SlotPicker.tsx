import { useEffect, useMemo, useState } from "react";
import { freeSlots, formatTime, viewerTimezone } from "@/lib/bookingApi";

const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Free times of one meeting type for the next two months, shown in the viewer's own time zone: pick a day, then a time. */
export default function SlotPicker({ handle, type, token, selected, onPick, reload = 0 }: {
  handle: string; type: string; token?: string; selected: string; onPick: (iso: string) => void; reload?: number;
}) {
  const [slots, setSlots] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [day, setDay] = useState("");
  useEffect(() => {
    let active = true;
    setSlots(null); setError("");
    freeSlots(handle, type, token).then((s) => { if (active) setSlots(s); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [handle, type, token, reload]);
  const days = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots ?? []) { const k = dayKey(s); map.set(k, [...(map.get(k) ?? []), s]); }
    return [...map.entries()];
  }, [slots]);
  useEffect(() => { if (days.length && !days.some(([k]) => k === day)) setDay(days[0][0]); }, [days, day]);

  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!slots) return <p role="status" className="text-sm text-foreground-600">Loading free times…</p>;
  if (!days.length) return <p className="text-sm text-foreground-700">No free times in the next two months.</p>;
  const times = days.find(([k]) => k === day)?.[1] ?? [];
  return (
    <div data-testid="slot-picker">
      <div className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Days with free times">
        {days.map(([k, list]) => {
          const d = new Date(list[0]);
          return (
            <button key={k} type="button" role="tab" aria-selected={k === day} onClick={() => setDay(k)}
              className={`min-w-[64px] shrink-0 rounded-md border px-2 py-2 text-center text-xs ${k === day ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 text-foreground-700 hover:bg-background-100"}`}>
              <span className="block font-medium">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="block text-base font-bold">{d.getDate()}</span>
              <span className="block">{d.toLocaleDateString(undefined, { month: "short" })}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {times.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} aria-pressed={selected === s}
            className={`rounded-md border px-2 py-2 text-sm font-medium ${selected === s ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 text-foreground-800 hover:border-primary-400"}`}>
            {formatTime(s)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-foreground-500">Times are shown in your time zone ({viewerTimezone().replace(/_/g, " ")}).</p>
    </div>
  );
}
