import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import CarouselControls from "@/components/feature/CarouselControls";
import CoursesDrift from "@/components/feature/CoursesDrift";
import { GAP, viewsFor } from "@/components/feature/carouselLayout";
import CourseCard from "@/components/feature/CourseCard";
import type { Course } from "@/data/courses";
import type { CoursesCarouselSettings } from "@/lib/publicData";

const DRAG_THRESHOLD = 5;

export interface CoursesCarouselProps {
  courses: Course[];
  settings: CoursesCarouselSettings;
  loading?: boolean;
}

/**
 * Horizontal course carousel built on CSS scroll-snap: native touch swipe, mouse drag, arrows, dots and keyboard.
 * Autoplay is optional (CMS setting), restarts after any manual interaction, pauses on hover (if configured), on keyboard
 * focus, while touching and while the tab is hidden, and never runs under prefers-reduced-motion.
 */
function SlideCarousel({ courses, settings, loading = false }: CoursesCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const [views, setViews] = useState(1.15);
  const [page, setPage] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [holds, setHolds] = useState({ hover: false, focus: false, touch: false, hidden: false });
  const [tick, setTick] = useState(0);

  const perPage = Math.max(1, Math.floor(views));
  const slideCount = courses.length + 1; // the trailing "View all courses" tile counts as a slide
  const pages = Math.max(1, Math.ceil(slideCount / perPage));

  const hold = useCallback((key: "hover" | "focus" | "touch" | "hidden", value: boolean) => setHolds((prev) => (prev[key] === value ? prev : { ...prev, [key]: value })), []);
  /** Restarts the autoplay timer from zero. */
  const restart = useCallback(() => setTick((value) => value + 1), []);

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
    const track = trackRef.current;
    if (!track) return;
    const update = () => setViews(viewsFor(track.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(track);
    return () => observer.disconnect();
  }, [loading, courses.length]);

  const stepWidth = () => {
    const slide = trackRef.current?.firstElementChild as HTMLElement | null;
    return slide ? slide.getBoundingClientRect().width + GAP : 0;
  };

  const scrollToLeft = useCallback(
    (left: number) => trackRef.current?.scrollTo({ left, behavior: reduced ? "auto" : "smooth" }),
    [reduced],
  );

  /** One page forward or back; wraps around at either end so the carousel loops. */
  const go = useCallback(
    (direction: 1 | -1) => {
      const track = trackRef.current;
      const step = stepWidth();
      if (!track || !step) return;
      const max = track.scrollWidth - track.clientWidth;
      if (direction > 0) scrollToLeft(track.scrollLeft >= max - 2 ? 0 : Math.min(track.scrollLeft + perPage * step, max));
      else scrollToLeft(track.scrollLeft <= 2 ? max : Math.max(track.scrollLeft - perPage * step, 0));
    },
    [perPage, scrollToLeft],
  );

  const manual = (direction: 1 | -1) => {
    go(direction);
    restart();
  };

  const handleScroll = () => {
    const track = trackRef.current;
    const step = stepWidth();
    if (!track || !step) return;
    const atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
    setPage(atEnd ? pages - 1 : Math.min(pages - 1, Math.floor(Math.round(track.scrollLeft / step) / perPage)));
  };

  const paused = holds.focus || holds.touch || holds.hidden || (settings.pauseOnHover && holds.hover);
  const autoplay = settings.autoSlide && !reduced && !loading && pages > 1;
  useEffect(() => {
    if (!autoplay || paused) return;
    const timer = window.setTimeout(() => {
      go(1);
      restart();
    }, settings.intervalSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [autoplay, paused, settings.intervalSeconds, tick, go, restart]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    if ((event.target as HTMLElement).closest("input, select, textarea")) return;
    event.preventDefault();
    manual(event.key === "ArrowRight" ? 1 : -1);
  };

  /* Mouse drag; touch uses the browser's native swipe. */
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || event.pointerType !== "mouse" || event.button !== 0) return;
    suppressClick.current = false;
    drag.current = { x: event.clientX, left: track.scrollLeft, moved: false };
    restart();
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const state = drag.current;
    if (!track || !state) return;
    const delta = event.clientX - state.x;
    if (!state.moved && Math.abs(delta) > DRAG_THRESHOLD) {
      state.moved = true;
      track.setPointerCapture(event.pointerId);
      track.style.scrollSnapType = "none";
    }
    if (state.moved) track.scrollLeft = state.left - delta;
  };
  const endDrag = () => {
    const track = trackRef.current;
    const state = drag.current;
    drag.current = null;
    if (!track || !state?.moved) return;
    suppressClick.current = true;
    track.style.scrollSnapType = "";
    const step = stepWidth();
    if (step) scrollToLeft(Math.round(track.scrollLeft / step) * step);
    restart();
  };

  if (loading) {
    return (
      <div className="flex gap-6 overflow-hidden" aria-busy="true" aria-label="Loading courses">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-[26rem] w-[85%] shrink-0 animate-pulse rounded-card border border-background-200 bg-background-50 sm:w-[46%] lg:w-[31%] xl:w-[23.5%]" />
        ))}
      </div>
    );
  }

  const slideStyle = { flex: `0 0 calc((100% - ${GAP}px * ${views - 1}) / ${views})` };

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
        ref={trackRef}
        tabIndex={0}
        aria-live={autoplay && !paused ? "off" : "polite"}
        onScroll={handleScroll}
        onTouchStart={() => hold("touch", true)}
        onTouchEnd={() => { hold("touch", false); restart(); }}
        onTouchCancel={() => { hold("touch", false); restart(); }}
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
        style={{ gap: GAP }}
        className="-my-3 flex cursor-grab snap-x snap-mandatory overflow-x-auto overscroll-x-contain py-3 [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 active:cursor-grabbing [&::-webkit-scrollbar]:hidden"
        data-product-shop
      >
        {courses.map((course, index) => (
          <div key={course.slug} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${slideCount}`} style={slideStyle} className="snap-start">
            <CourseCard course={course} />
          </div>
        ))}
        <div role="group" aria-roledescription="slide" aria-label={`${slideCount} of ${slideCount}`} style={slideStyle} className="snap-start">
          <Link
            to="/our-courses"
            className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 rounded-card border border-dashed border-primary-300 bg-background-50 p-6 text-center font-heading text-base font-semibold text-primary-700 transition-all duration-300 hover:-translate-y-1 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            <i className="ri-arrow-right-circle-line text-3xl" aria-hidden="true" />
            View all courses
          </Link>
        </div>
      </div>

      <CarouselControls
        pages={pages}
        page={page}
        onPrevious={() => manual(-1)}
        onNext={() => manual(1)}
        onPage={(index) => {
          scrollToLeft(index * perPage * stepWidth());
          restart();
        }}
      />
    </div>
  );
}

/** Continuous drift (a marquee) or slide by slide, as set in the CMS. */
export default function CoursesCarousel(props: CoursesCarouselProps) {
  return props.settings.motion === "drift" && !props.loading ? <CoursesDrift {...props} /> : <SlideCarousel {...props} />;
}
