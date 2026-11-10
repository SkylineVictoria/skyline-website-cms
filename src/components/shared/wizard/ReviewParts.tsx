import type { ReactNode } from "react";

/** The pieces of a "Review and submit" page: what is still missing, and one card per section with its Edit button. */

export function EditSectionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${label}`}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-background-300 bg-background-50 px-2 py-1 text-xs font-semibold text-primary-700 hover:bg-primary-50"
    >
      <i className="ri-pencil-line" aria-hidden="true" />
      Edit
    </button>
  );
}

/** What still needs attention (each item opens its section when `onOpen` is given), or the "all complete" line. */
export function ReviewMissing({ items }: { items: ReadonlyArray<{ text: string; onOpen?: () => void }> }) {
  return items.length > 0 ? (
    <div className="rounded-card border border-primary-200 bg-primary-50 p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-primary-900">
        <i className="ri-error-warning-line" aria-hidden="true" />
        {items.length} required item{items.length === 1 ? "" : "s"} still need attention
      </p>
      <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.text} className="text-xs text-primary-900">
            {!item.onOpen ? (
              <span className="flex items-start gap-2">
                <i className="ri-arrow-right-s-line mt-px" aria-hidden="true" />
                {item.text}
              </span>
            ) : (
              <button type="button" onClick={item.onOpen} className="flex cursor-pointer items-start gap-2 text-left underline-offset-2 hover:underline">
                <i className="ri-arrow-right-s-line mt-px" aria-hidden="true" />
                {item.text}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <div className="rounded-card border border-accent-200 bg-accent-50 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-accent-900">
        <i className="ri-checkbox-circle-line" aria-hidden="true" />
        All required fields are complete.
      </p>
    </div>
  );
}

/** One section of the review: icon, title, the Edit button, then its rows. */
export function ReviewCard({ icon, title, edit, children }: { icon: string; title: string; edit?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-card border border-background-200 bg-background-50 p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground-950">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-100 text-primary-700">
            <i className={icon} aria-hidden="true" />
          </span>
          {title}
        </p>
        {edit}
      </div>
      {children}
    </div>
  );
}
