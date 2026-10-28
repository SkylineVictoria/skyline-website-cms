import { Link } from "react-router-dom";
import type { Course } from "@/data/courses";

export default function CourseCard({ course }: { course: Course }) {
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-card border border-background-200 bg-background-50 transition-all duration-300 hover:-translate-y-1 hover:border-primary-300">
      <Link to={`/courses/${course.slug}`} className="relative block h-48 w-full overflow-hidden bg-background-100">
        {course.image ? (
          <img
            src={course.image}
            alt={course.imageAlt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-top transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-secondary-100 text-secondary-500">
            <i className="ri-graduation-cap-line text-4xl" aria-hidden="true" />
          </span>
        )}
        {course.duration ? (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background-50/95 px-3 py-1 font-label text-[11px] font-semibold text-foreground-800 backdrop-blur">
            <i className="ri-time-line text-primary-600" aria-hidden="true" />
            {course.duration}
          </span>
        ) : null}
      </Link>
      <div className="flex flex-1 flex-col p-5">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-secondary-100 px-3 py-1 font-label text-[11px] font-semibold uppercase tracking-wide text-secondary-900">
          {course.category}
        </span>
        <h3 className="mt-3 font-heading text-base font-semibold leading-snug text-foreground-950">
          <Link to={`/courses/${course.slug}`} className="transition-colors hover:text-primary-600">
            {course.name}
          </Link>
        </h3>
        {course.summary ? (
          <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-foreground-600">{course.summary}</p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-foreground-600">
            Contact us for the full course brochure, intake dates and fees.
          </p>
        )}
        <Link
          to={`/courses/${course.slug}`}
          className="mt-auto inline-flex items-center gap-2 pt-4 text-sm font-semibold text-primary-600 transition-colors hover:text-primary-700"
        >
          Read More
          <i className="ri-arrow-right-line transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}