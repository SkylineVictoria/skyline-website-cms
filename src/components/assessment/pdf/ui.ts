import { createContext, useContext, useLayoutEffect, useState } from "react";

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
