import type { ReactNode } from "react";

/**
 * English step, for a student without an IELTS, PTE or TOEFL result:
 *   1. "Do you have proof of at least 2 years of study in Australia?"  Yes -> upload it (the `upload` slot).
 *   2. No -> "Are you willing to complete a Cambridge English course with Skyline?"  Yes -> continue.
 *   3. No -> a dialog: the English requirement is not met, back to the English options.
 */
export type AusStudyAnswer = "" | "Yes" | "No";
export type CambridgeAnswer = "" | "Yes" | "No";

export const ENGLISH_PATHWAY = {
  test: "English test",
  ausStudy: "Australian study (2+ years)",
  cambridge: "Cambridge English course",
} as const;

function YesNo({ name, value, onChange, legend, hint }: { name: string; value: string; onChange: (v: "Yes" | "No") => void; legend: string; hint?: string }) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-foreground-900">{legend}</legend>
      {hint ? <p className="mt-1 text-xs text-foreground-500">{hint}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-xs">
        {(["Yes", "No"] as const).map((option) => {
          const selected = value === option;
          return (
            <label key={option}
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm font-semibold transition-colors ${selected ? "border-primary-500 bg-primary-50 text-primary-800 ring-1 ring-primary-500" : "border-background-300 bg-background-50 text-foreground-700 hover:border-primary-300"}`}>
              <input type="radio" name={name} value={option} checked={selected} onChange={() => onChange(option)} className="sr-only" />
              {option}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export default function EnglishAlternative({ ausStudy, cambridge, onAusStudy, onCambridge, onBack, upload, error }: {
  ausStudy: AusStudyAnswer;
  cambridge: CambridgeAnswer;
  onAusStudy: (value: "Yes" | "No") => void;
  onCambridge: (value: "Yes" | "No") => void;
  /** Back to uploading an IELTS / PTE / TOEFL result. */
  onBack: () => void;
  /** The upload area for the Australian study proof, shown after "Yes". */
  upload: ReactNode;
  error?: string;
}) {
  return (
    <div className="space-y-6" data-testid="english-alternative">
      <div>
        <h3 className="font-heading text-lg font-semibold text-foreground-950">No IELTS, PTE or TOEFL result</h3>
        <p className="mt-1 text-sm text-foreground-600">
          You can still meet our English requirement with at least 2 years of study in Australia, or by completing a Cambridge
          English course with Skyline.
        </p>
      </div>

      <YesNo name="aus_study_2yrs" value={ausStudy} onChange={onAusStudy}
        legend="Do you have proof of at least 2 years of study in Australia?"
        hint="For example a completion letter, certificate or transcripts from an Australian school, college or university." />

      {ausStudy === "Yes" ? (
        <div className="rounded-lg border border-background-200 bg-background-100/60 p-4">
          <p className="mb-3 text-sm font-semibold text-foreground-900">Upload your proof of Australian study</p>
          {upload}
        </div>
      ) : null}

      {ausStudy === "No" ? (
        <YesNo name="cambridge_course" value={cambridge} onChange={onCambridge}
          legend="Are you willing to complete a Cambridge English course with Skyline?"
          hint="You will study the Cambridge English course with us before or alongside your main course." />
      ) : null}

      {ausStudy === "No" && cambridge === "Yes" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900" role="status">
          <i className="ri-checkbox-circle-line mr-1.5" aria-hidden="true" />
          Thank you. We will include the Cambridge English course in your application. Select Next to continue.
        </div>
      ) : null}

      {error ? <p className="text-sm text-primary-700" role="alert">{error}</p> : null}

      <button type="button" onClick={onBack} className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-primary-700 hover:text-primary-800">
        <i className="ri-arrow-left-line" aria-hidden="true" />
        I have an IELTS, PTE or TOEFL result to upload
      </button>
    </div>
  );
}

/** Shown when the student says No to the Cambridge English course: the application cannot go further on this path. */
export function EnglishNotMetDialog({ open, onBack }: { open: boolean; onBack: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground-950/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="english-not-met-title" aria-describedby="english-not-met-text" data-testid="english-not-met">
      <div className="w-full max-w-md rounded-lg bg-background-50 p-6 shadow-xl">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-700">
          <i className="ri-error-warning-line" aria-hidden="true" />
        </span>
        <h2 id="english-not-met-title" className="mt-4 font-heading text-lg font-bold text-foreground-950">We can&rsquo;t accept your application yet</h2>
        <p id="english-not-met-text" className="mt-2 text-sm leading-relaxed text-foreground-700">
          Our courses require proof of English. Without an IELTS, PTE or TOEFL result, at least 2 years of study in Australia, or a
          Cambridge English course with Skyline, we are not able to accept your application because the English language
          requirement is not met.
        </p>
        <p className="mt-2 text-sm text-foreground-700">You can go back to the English step and choose another option.</p>
        <button type="button" autoFocus onClick={onBack}
          className="mt-5 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600">
          <i className="ri-arrow-go-back-line" aria-hidden="true" />
          Back to English options
        </button>
      </div>
    </div>
  );
}
