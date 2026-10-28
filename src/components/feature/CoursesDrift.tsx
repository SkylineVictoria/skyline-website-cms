import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import CarouselControls from "@/components/feature/CarouselControls";
import { GAP, viewsFor } from "@/components/feature/carouselLayout";
import CourseCard from "@/components/feature/CourseCard";
import type { CoursesCarouselProps } from "@/components/feature/CoursesCarousel";
import type { DriftSpeed } from "@/lib/publicData";

/** Pixels per second, the same at every screen width. */
const SPEED: Record<DriftSpeed, number> = { slow: 20, medium: 40, fast: 70 };
const DRAG_THRESHOLD = 5;
const EASE_PER_SECOND = 6; // how quickly the drift speeds up / slows down when it is paused or resumed
const TWEEN_MS = 600;

const wrap = (value: number, length: number) => (length > 0 ? ((value % length) + length) % length : 0);

/**
 * Continuous drift: the cards glide left at a constant speed like a marquee. The list is rendered twice and the strip is moved
 * with a transform, wrapping by exactly one list length, so the loop has no jump. Pausing and resuming ease the speed, so the
 * strip never jumps. Dragging, the arrows, the dots and the keyboard move the strip; the drift carries on from where they left it.
 */
export default function CoursesDrift({ courses, settings }: CoursesCarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const position = useRef(0); // px the strip has moved left, kept in [0, loopWidth)
  const velocity = useRef(0);
  const tween = useRef<{ from: number; to: number; start: number; duration: number } | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const wake = useRef<() => void>(() => {});
  const shownPage = useRef(0);

  const [width, setWidth] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [holds, setHolds] = useState({ hover: false, focus: false, drag: false, hidden: false });
  const [page, setPage] = useState(0);

  const views = viewsFor(width || 1280);
  const perPage = Math.max(1, Math.floor(views));
  const slideCount = courses.length + 1; // the trailing "View all courses" tile counts as a slide
  const slideWidth = width ? (width - GAP * (views - 1)) / views : 280;
  const step = slideWidth + GAP;
  const loopWidth = slideCount * step;
  const pages = Math.max(1, Math.ceil(slideCount / perPage));
  const fits = width > 0 && loopWidth - GAP <= width + 1;

  const hold = useCallback((key: "hover" | "focus" | "drag" | "hidden", value: boolean) => setHolds((prev) => (prev[key] === value ? prev : { ...prev, [key]: value })), []);
  const paused = holds.focus || holds.drag || holds.hidden || (settings.pauseOnHover && holds.hover);
  const drifting = settings.autoSlide && !fits && width > 0 && (!reduced || playing);
  const pausedRef = useRef(paused);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => hold("hidden", document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [hold]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setWidth(viewport.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const paint = useCallback(() => {
    position.current = wrap(position.current, loopWidth);
    if (stripRef.current) stripRef.current.style.transform = `translate3d(${-position.current}px,0,0)`;
    const next = Math.min(pages - 1, Math.floor(Math.round(position.current / step) / perPage));
    if (next !== shownPage.current) {
      shownPage.current = next;
      setPage(next);
    }
  }, [loopWidth, pages, perPage, step]);

  // One animation loop while drifting. It eases the speed toward zero when paused (and back up on resume) and goes idle at rest.
  useEffect(() => {
    pausedRef.current = paused;
    if (!drifting && !tween.current) {
      velocity.current = 0;
      paint();
      return;
    }
    let raf = 0;
    let last: number | null = null;
    const frame = (now: number) => {
      const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.1); // a long gap (hidden tab) never turns into a jump
      last = now;
      const active = tween.current;
      if (active) {
        const t = Math.min(1, (now - active.start) / active.duration);
        position.current = active.from + (active.to - active.from) * (1 - Math.pow(1 - t, 3));
        if (t >= 1) tween.current = null;
      } else if (drifting) {
        const target = pausedRef.current ? 0 : SPEED[settings.driftSpeed];
        velocity.current += (target - velocity.current) * Math.min(1, dt * EASE_PER_SECOND);
        if (Math.abs(target - velocity.current) < 0.05) velocity.current = target;
        position.current += velocity.current * dt;
      }
      paint();
      const resting = !tween.current && (!drifting || (pausedRef.current && velocity.current === 0));
      raf = resting ? 0 : window.requestAnimationFrame(frame);
      if (resting) last = null;
    };
    wake.current = () => {
      if (!raf) raf = window.requestAnimationFrame(frame);
    };
    wake.current();
    return () => {
      window.cancelAnimationFrame(raf);
      wake.current = () => {};
    };
  }, [drifting, paused, paint, settings.driftSpeed]);

  /** Glides the strip by `distance` px (or jumps, for reduced motion) and then lets the drift carry on from there. */
  const glide = useCallback(
    (distance: number) => {
      const from = position.current;
      tween.current = { from, to: from + distance, start: performance.now(), duration: reduced ? 1 : TWEEN_MS };
      wake.current();
      // When not drifting the effect has no loop running; start one for the glide.
      if (!drifting) {
        let raf = 0;
        const frame = (now: number) => {
          const active = tween.current;
          if (!active) return;
          const t = Math.min(1, (now - active.start) / active.duration);
          position.current = active.from + (active.to - active.from) * (1 - Math.pow(1 - t, 3));
          if (t >= 1) tween.current = null;
          paint();
          raf = tween.current ? window.requestAnimationFrame(frame) : 0;
        };
        raf = window.requestAnimationFrame(frame);
      }
    },
    [drifting, paint, reduced],
  );

  const move = (direction: 1 | -1) => glide(direction * perPage * step);
  const goToPage = (index: number) => {
    const target = index * perPage * step;
    let delta = wrap(target - position.current, loopWidth);
    if (delta > loopWidth / 2) delta -= loopWidth; // the shorter way round
    glide(delta);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    move(event.key === "ArrowRight" ? 1 : -1);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || fits) return;
    suppressClick.current = false;
    tween.current = null;
    drag.current = { x: event.clientX, from: position.current, moved: false };
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = event.clientX - state.x;
    if (!state.moved && Math.abs(delta) > DRAG_THRESHOLD) {
      state.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      hold("drag", true);
    }
    if (state.moved) {
      position.current = state.from - delta;
      paint();
    }
  };
  const endDrag = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) return;
    suppressClick.current = true;
    hold("drag", false);
    wake.current();
  };

  const copies = fits ? [0] : [0, 1];
  const slideStyle = { width: slideWidth, flex: "0 0 auto" };

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Our courses"
      onKeyDown={handleKeyDown}
      onMouseEnter={() => hold("hover", true)}
      onMouseLeave={() => hold("hover", false)}
      onFocus={(event) => { if ((event.target as HTMLElement).matches(":focus-visible")) hold("focus", true); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold("focus", false); }}
    >
      <div
        ref={viewportRef}
        tabIndex={0}
        aria-live={drifting && !paused ? "off" : "polite"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{ touchAction: "pan-y" }}
        className={`-my-3 overflow-hidden py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${fits ? "" : "cursor-grab active:cursor-grabbing"}`}
        data-product-shop
      >
        <div ref={stripRef} className="flex w-max will-change-transform" style={{ gap: GAP, paddingRight: GAP }}>
          {copies.flatMap((copy) => {
            const hidden = copy === 1;
            const extra = hidden ? ({ "aria-hidden": true, inert: true } as Record<string, unknown>) : {};
            return [
              ...courses.map((course, index) => (
                <div key={`${copy}-${course.slug}`} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${slideCount}`} style={slideStyle} {...extra}>
                  <CourseCard course={course} />
                </div>
              )),
              <div key={`${copy}-all`} role="group" aria-roledescription="slide" aria-label={`${slideCount} of ${slideCount}`} style={slideStyle} {...extra}>
                <Link
                  to="/our-courses"
                  className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 rounded-card border border-dashed border-primary-300 bg-background-50 p-6 text-center font-heading text-base font-semibold text-primary-700 transition-all duration-300 hover:-translate-y-1 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                >
                  <i className="ri-arrow-right-circle-line text-3xl" aria-hidden="true" />
                  View all courses
                </Link>
              </div>,
            ];
          })}
        </div>
      </div>

      {fits ? null : (
        <CarouselControls
          pages={pages}
          page={page}
          onPrevious={() => move(-1)}
          onNext={() => move(1)}
          onPage={goToPage}
          extra={
            reduced && settings.autoSlide ? (
              <button
                type="button"
                aria-pressed={playing}
                onClick={() => setPlaying((value) => !value)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
              >
                <i className={playing ? "ri-pause-line" : "ri-play-line"} aria-hidden="true" />
                {playing ? "Pause" : "Play"}
              </button>
            ) : null
          }
        />
      )}
    </div>
  );
}
