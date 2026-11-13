// "+ Students": a command palette. Type to search the course's students, pick several (click, or ↑ ↓ and Enter), choose the batch
// and how they study, then add them all at once.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Select, Toggle } from "@/pages/admin/components/ui";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { rto, type EnrolmentType, type IntakeDetail, type StudentOption } from "@/pages/admin/lib/rto";

export interface PickerBatch { id: string; name: string; capacity: number | null; enrolled: number; studentIds: string[] }
export interface StudentsAdded { out: IntakeDetail; batchId: string; studentIds: string[]; names: string[] }

export default function StudentPicker({ courseId, batches, batchId, rtoManager, onClose, onAdded }: {
  courseId: string; batches: PickerBatch[]; batchId?: string; rtoManager: boolean; onClose: () => void; onAdded: (added: StudentsAdded) => void;
}) {
  const [target, setTarget] = useState(batchId || batches[0]?.id || "");
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [found, setFound] = useState<StudentOption[] | null>(null);
  const [picked, setPicked] = useState<Map<string, StudentOption>>(new Map());
  const [type, setType] = useState<EnrolmentType>("CoE");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      rto<StudentOption[]>("student_search", { courseId, q, all }).then((list) => { if (live) { setFound(list); setCursor(0); } })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Search failed."); });
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [courseId, q, all]);

  const batch = batches.find((b) => b.id === target);
  const inBatch = new Set(batch?.studentIds ?? []);
  const list = (found ?? []).filter((s) => !inBatch.has(s.id));
  const toggle = (s: StudentOption) => setPicked((m) => { const next = new Map(m); if (next.has(s.id)) next.delete(s.id); else next.set(s.id, s); return next; });
  const free = batch?.capacity ? batch.capacity - batch.enrolled : null;
  const tooMany = free !== null && picked.size > free;

  const add = async () => {
    if (!target || !picked.size) return;
    setBusy(true); setError("");
    try {
      const ids = [...picked.keys()];
      const out = await rto<IntakeDetail>("enrol", { batchId: target, students: ids.map((id) => ({ id, type })) });
      onAdded({ out, batchId: target, studentIds: ids, names: [...picked.values()].map((s) => s.name) });
    } catch (e) { setError(e instanceof Error ? e.message : "Not added."); }
    finally { setBusy(false); }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(list.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && picked.size) void add();
      else if (list[cursor]) toggle(list[cursor]);
    }
  };
  useEffect(() => { box.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" }); }, [cursor]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[8vh]" role="dialog" aria-modal="true" aria-label="Add students" onKeyDown={keys}>
      <button type="button" aria-label="Close" className="modal-backdrop-in absolute inset-0 cursor-default bg-foreground-950/40" onClick={onClose} />
      <div className="modal-in relative flex max-h-[84vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-background-200 bg-background-50 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-background-200 px-4">
          <i className="ri-search-line text-lg text-foreground-400" aria-hidden="true" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students by name or email" aria-label="Search students"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-[15px] text-foreground-900 outline-none placeholder:text-foreground-400" />
          <kbd className="hidden rounded border border-background-300 px-1.5 text-2xs text-foreground-500 sm:inline">Esc</kbd>
        </div>
        {picked.size ? (
          <div className="flex flex-wrap gap-1.5 border-b border-background-200 px-4 py-2">
            {[...picked.values()].map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-primary-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary-900">
                {s.name}<button type="button" aria-label={`Remove ${s.name}`} className="rounded-full p-0.5 hover:bg-primary-100" onClick={() => toggle(s)}><i className="ri-close-line" aria-hidden="true" /></button>
              </span>
            ))}
          </div>
        ) : null}
        <div ref={box} className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-multiselectable="true" aria-label="Students">
          {found === null ? <p className="px-4 py-6 text-center text-sm text-foreground-500">Searching…</p>
            : list.length === 0 ? <p className="px-4 py-6 text-center text-sm text-foreground-500">{q ? "No student matches." : "No students to add. A student appears here once they apply for this course."}</p>
            : list.map((s, i) => {
              const on = picked.has(s.id);
              return (
                <button key={s.id} type="button" role="option" aria-selected={on} data-index={i} onMouseEnter={() => setCursor(i)} onClick={() => toggle(s)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === cursor ? "bg-background-100" : ""}`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300"}`}>{on ? <i className="ri-check-line text-sm" aria-hidden="true" /> : null}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground-900">{s.name}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></span>
                  {s.linked === false ? <Badge tone="warn">No application yet</Badge> : null}
                </button>
              );
            })}
        </div>
        <div className="space-y-2 border-t border-background-200 bg-background-100/60 px-4 py-3">
          <ErrorNote text={error} />
          {rtoManager ? <Toggle checked={all} onChange={setAll} label="Also show students who have not applied for this course" /> : null}
          {tooMany ? <p className="text-xs text-amber-800">{batch?.name} has {free} place{free === 1 ? "" : "s"} left.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Batch" className="w-auto" value={target} onChange={(e) => setTarget(e.target.value)}>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.capacity ? ` · ${b.enrolled}/${b.capacity}` : ""}</option>)}
            </Select>
            <Select aria-label="How they study" className="w-auto" value={type} onChange={(e) => setType(e.target.value as EnrolmentType)}>
              <option value="CoE">CoE</option><option value="VoE">VoE</option><option value="Domestic">Domestic</option>
            </Select>
            <Button className="ml-auto" disabled={busy || !picked.size || !target} onClick={() => void add()}>
              {busy ? "Adding…" : picked.size ? `Add ${picked.size} student${picked.size === 1 ? "" : "s"}` : "Add students"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
