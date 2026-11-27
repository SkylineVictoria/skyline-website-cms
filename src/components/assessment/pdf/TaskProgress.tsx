import { useLayoutEffect, useRef, useState } from "react";

/**
 * ASM-PROGRESS-BAR (owner 2026-11-27): the progress of the student's wizard, Preview as learner and the trainer's marking: one
 * continuous bar (6 px, rounded) filled by the overall progress (step X of Y), a small tick where each task starts and, when they fit,
 * the task labels under it at those places ("Task 1", "Task 2"…; the current task in SLIT orange, a finished task with ✓). Any number
 * of tasks: when the labels do not fit side by side (many tasks, a phone), only the ticks stay on the bar and the current task's
 * name shows above it ("Task 2 of 3 · Practical"), always on a phone; labels never overlap and are never cut. No segments for the steps outside the
 * tasks (your details, review & submit).
 */
export interface ProgressTask {
  number: string;
  title: string;
  /** where the task starts: the 0-based index of its first step */
  start: number;
  done: boolean;
}

const GAP = 10;
/** narrower than this (a phone): the current task's name above the bar instead of the labels, so the title is never cut */
// rule-policy: technical progress-labels-width Layout only: below this width the bar shows the caption instead of the task labels.
const LABELS_MIN_WIDTH = 480;

// rule-policy: technical progress-aria-label Accessible name of the progress bar, overridden by the marking view.
export default function TaskProgress({ tasks, index, total, currentTask, outside, label = "Progress", onCompact }: {
  tasks: ProgressTask[];
  /** the current step, 0-based */
  index: number;
  total: number;
  /** the current task's number, or null on a step outside the tasks */
  currentTask: string | null;
  /** the caption of a step outside the tasks while the labels are hidden ("Your details", "Review & submit") */
  outside?: string;
  label?: string;
  /** told whether the labels are hidden (the caption shown instead) */
  onCompact?: (compact: boolean) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ compact: boolean; lefts: number[] }>({ compact: false, lefts: [] });
  const at = (start: number) => (total > 0 ? Math.min(1, Math.max(0, start / total)) : 0);
  const key = tasks.map((t) => `${t.number}:${t.start}:${t.done}`).join("|") + `|${total}|${currentTask}`;

  useLayoutEffect(() => {
    const el = wrap.current; const m = measure.current;
    if (!el || !m) return;
    const run = () => {
      const W = el.clientWidth;
      const widths = [...m.children].map((c) => Math.ceil((c as HTMLElement).getBoundingClientRect().width));
      const lefts: number[] = [];
      let fits = W >= LABELS_MIN_WIDTH && widths.length === tasks.length;
      tasks.forEach((t, i) => {
        // under its tick; pulled back only as far as needed to stay inside the bar's width
        const left = Math.max(0, Math.min(at(t.start) * W, W - (widths[i] ?? 0)));
        if (i > 0 && left < lefts[i - 1] + (widths[i - 1] ?? 0) + GAP) fits = false;
        lefts.push(left);
      });
      setLayout((p) => (p.compact === !fits && p.lefts.join() === lefts.join() ? p : { compact: !fits, lefts }));
    };
    run();
    const o = new ResizeObserver(run); o.observe(el);
    return () => o.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { onCompact?.(layout.compact); }, [layout.compact, onCompact]);

  const pct = total > 0 ? Math.min(100, ((index + 1) / total) * 100) : 0;
  const cur = tasks.find((t) => t.number === currentTask);
  const state = (t: ProgressTask) => (t.number === currentTask ? "current" : t.done ? "done" : "todo");
  const text = (t: ProgressTask) => <>{t.done ? <span aria-hidden="true">✓ </span> : null}Task {t.number}</>;
  return <div ref={wrap} className="relative mt-2" data-testid="task-progress" data-mode={layout.compact ? "compact" : "labels"} data-tasks={tasks.length}>
    {layout.compact ? <p className="mb-1.5 truncate text-xs font-semibold text-foreground-800" data-testid="progress-caption">
      {cur ? <><span className="text-primary-700">Task {cur.number} of {tasks.length}</span>{cur.title ? <span className="font-normal text-foreground-600"> · {cur.title}</span> : null}</> : outside ?? ""}</p> : null}
    <div className="relative h-1.5 rounded-full bg-background-200" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-label={label}
      aria-valuetext={`Step ${index + 1} of ${total}${cur ? `, task ${cur.number} of ${tasks.length}` : ""}`} data-testid="progress-track">
      {/* // rule-policy: technical progress-fill Display only: the bar is filled by the current step of all steps. */}
      <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary-500 to-primary-600 transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} data-testid="progress-fill" />
      {tasks.map((t) => <span key={t.number} className={`absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full ${state(t) === "current" ? "bg-primary-700" : "bg-foreground-950/30"}`}
        style={{ left: `calc(${at(t.start) * 100}% - ${at(t.start) > 0 ? 1 : 0}px)` }} data-testid="progress-tick" data-task={t.number} aria-hidden="true" />)}
    </div>
    {/* the labels, measured off screen, then placed (or the caption above instead) */}
    <div ref={measure} className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap text-2xs font-semibold" aria-hidden="true">
      {tasks.map((t) => <span key={t.number}>{text(t)}</span>)}
    </div>
    {!layout.compact ? <div className="relative mt-1 h-4" data-testid="progress-labels">
      {tasks.map((t, i) => <span key={t.number} className={`absolute top-0 whitespace-nowrap text-2xs ${state(t) === "current" ? "font-semibold text-primary-700" : state(t) === "done" ? "font-semibold text-foreground-700" : "font-semibold text-foreground-500"}`}
        style={{ left: layout.lefts[i] ?? 0 }} title={t.title ? `Task ${t.number} · ${t.title}` : undefined} data-testid="progress-label" data-task={t.number} data-state={state(t)}>{text(t)}</span>)}
    </div> : null}
  </div>;
}
