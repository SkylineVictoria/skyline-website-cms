import type { ReactNode } from "react";

const NAV_BUTTON =
  "hidden h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-background-300 bg-background-50 text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 sm:flex";

interface Props {
  pages: number;
  page: number;
  onPrevious: () => void;
  onNext: () => void;
  onPage: (index: number) => void;
  /** Extra control shown after the arrows, e.g. a play / pause button. */
  extra?: ReactNode;
}

/** Previous / next arrows (hidden on mobile, where swipe is enough) and pagination dots. */
export default function CarouselControls({ pages, page, onPrevious, onNext, onPage, extra }: Props) {
  if (pages <= 1 && !extra) return null;
  return (
    <div className="mt-6 flex items-center justify-center gap-4">
      {pages > 1 ? (
        <>
          <button type="button" aria-label="Previous courses" onClick={onPrevious} className={NAV_BUTTON}>
            <i className="ri-arrow-left-s-line text-xl" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-2" role="group" aria-label="Choose courses page">
            {Array.from({ length: pages }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`Go to courses page ${index + 1} of ${pages}`}
                aria-current={index === page ? "true" : undefined}
                onClick={() => onPage(index)}
                className={`h-2.5 cursor-pointer rounded-full transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 ${index === page ? "w-6 bg-primary-600" : "w-2.5 bg-background-300 hover:bg-primary-300"}`}
              />
            ))}
          </div>
          <button type="button" aria-label="Next courses" onClick={onNext} className={NAV_BUTTON}>
            <i className="ri-arrow-right-s-line text-xl" aria-hidden="true" />
          </button>
        </>
      ) : null}
      {extra}
    </div>
  );
}
