import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * Shown on the applications list right after an application is submitted (passed in the navigation state): a clear confirmation with the
 * reference, what happens next in three plain steps, and one way to open the application.
 */
export default function SubmittedBanner() {
  const state = useLocation().state as { submittedReference?: string; submittedName?: string; submittedPath?: string } | null;
  const [open, setOpen] = useState(Boolean(state?.submittedReference));
  if (!open || !state?.submittedReference) return null;
  const steps = [
    { title: "We have your application", text: "It is with SLIT admissions now." },
    { title: "We check the documents", text: "Usually within 2 working days. We email you if something is missing." },
    { title: "You receive the offer letter", text: "It is signed online, then the deposit is paid." },
  ];
  return (
    <section className="mb-6 rounded-card border border-accent-200 bg-accent-50 p-5 sm:p-6" role="status" aria-label="Application submitted" data-testid="submitted-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <i className="ri-check-line text-2xl" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground-950">Application submitted</h2>
            <p className="text-sm text-foreground-700">
              Reference <strong>{state.submittedReference}</strong>{state.submittedName ? ` · ${state.submittedName}` : ""}
            </p>
          </div>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Dismiss" className="cursor-pointer text-foreground-600 hover:opacity-70">
          <i className="ri-close-line text-lg" aria-hidden="true" />
        </button>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-2.5">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? "bg-emerald-600 text-white" : "border border-background-300 bg-background-50 text-foreground-500"}`}>
              {i === 0 ? <i className="ri-check-line" aria-hidden="true" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground-950">{step.title}</span>
              <span className="block text-xs text-foreground-600">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {state.submittedPath ? (
        <div className="mt-4">
          <Link to={state.submittedPath} className="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600">
            View application <i className="ri-arrow-right-line" aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
