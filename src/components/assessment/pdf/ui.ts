import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";

/**
 * ASM-QUESTION-POLISH (owner 2026-11-27): the shared look of the student's wizard, Preview as learner and the trainer's marking:
 * soft cards (a hairline ring and a low shadow instead of a border), one focus ring, SLIT's colour only on what acts or is current.
 */
export const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1";
export const SOFT_CARD = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_6px_20px_-8px_rgba(16,24,40,0.10)] ring-1 ring-foreground-950/[0.06]";
export const CARD = `${SOFT_CARD} p-4 sm:p-6`;
export const EYEBROW = "text-xs font-semibold uppercase tracking-[0.08em] text-primary-700";
export const PRIMARY = `inline-flex min-h-[48px] cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 text-base font-semibold text-white shadow-sm transition-[background-color,box-shadow,transform] hover:bg-primary-700 hover:shadow active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${FOCUS}`;
export const SECONDARY = `inline-flex min-h-[48px] cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-white px-4 text-base font-semibold text-foreground-800 shadow-[0_1px_2px_rgba(16,24,40,0.05)] ring-1 ring-foreground-950/10 transition-colors hover:text-primary-700 hover:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
/** A step's content coming in (a short fade and rise; nothing moves for people who ask for less motion). */
export const STEP_IN = "motion-safe:animate-step-in";

/* ------------------------------------------------------------------ Workbook / Text */
export type QuestionMode = "workbook" | "text";
const WIDE = "(min-width: 768px)";
const keyOf = (who: string) => `skyline.asm.questionMode.${who}`;
function stored(who: string): QuestionMode | null {
  try { const v = window.localStorage.getItem(keyOf(who)); return v === "workbook" || v === "text" ? v : null; } catch { return null; }
}

/**
 * How a question is shown: as printed in the workbook (a crop of the PDF) or as text read from it. Default: Workbook on a wide screen,
 * Text on a phone; the person's own choice is remembered in this browser (per student / trainer).
 */
export function useQuestionMode(who: "student" | "trainer"): [QuestionMode, (m: QuestionMode) => void] {
  const wide = () => typeof window !== "undefined" && !!window.matchMedia?.(WIDE).matches;
  const [mode, setMode] = useState<QuestionMode>(() => stored(who) ?? (wide() ? "workbook" : "text"));
  useEffect(() => {
    // no choice made yet: follow the screen (a phone turned to landscape, a window made narrow)
    const mq = window.matchMedia?.(WIDE); if (!mq) return;
    const on = () => { if (!stored(who)) setMode(mq.matches ? "workbook" : "text"); };
    mq.addEventListener?.("change", on); return () => mq.removeEventListener?.("change", on);
  }, [who]);
  const choose = useCallback((m: QuestionMode) => { setMode(m); try { window.localStorage.setItem(keyOf(who), m); } catch { /* private window: this visit only */ } }, [who]);
  return [mode, choose];
}

/* ------------------------------------------------------------------ the sticky question */
/**
 * The page's sticky top bar (the wizard's progress bar, the marking header) offers a slot just under it: on a phone the question
 * puts its compact bar there once its card has scrolled away. `top` is where the slot starts, from the top of the scroll area, so a
 * question card sticking on a wide screen stops just under the bar.
 */
export const StickySlot = createContext<{ el: HTMLElement | null; top: number }>({ el: null, top: 0 });
export const useStickySlot = () => useContext(StickySlot);

/** Height of the app's own sticky header (the student portal's) when the page itself scrolls; 0 inside a dialog's scroll area. */
export function useAppHeaderOffset(root: HTMLElement | null): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    if (!root) return;
    let scroller: HTMLElement | null = root.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const header = scroller ? null : document.querySelector<HTMLElement>("[data-app-header]");
    if (!header) { setH(0); return; }
    const measure = () => setH(Math.round(header.getBoundingClientRect().height));
    measure();
    const o = new ResizeObserver(measure); o.observe(header);
    return () => o.disconnect();
  }, [root]);
  return h;
}

/** The height of an element, kept up to date. */
export function useHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setH(Math.round(el.getBoundingClientRect().height));
    measure();
    const o = new ResizeObserver(measure); o.observe(el);
    return () => o.disconnect();
  }, [el]);
  return h;
}
