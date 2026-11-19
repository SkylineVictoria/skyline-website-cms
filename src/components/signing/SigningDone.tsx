import { useState, type ReactNode } from "react";
import { WIZARD_PRIMARY_CLASS } from "@/components/shared/wizard/WizardShell";
import { formatSignedAt } from "@/lib/signedTime";

/**
 * The page after signing (owner 2026-11-20), shared by every signing link: the F04 application, the referee check, the agent agreement,
 * offer letters and HR documents. A tick, one line of thanks, the signed time in Melbourne time, "What happens next" (stacked on a phone,
 * in a row from a tablet up) and the Download button in the same section. The button asks the server for a new link on every click, so
 * nothing on the page goes stale; only the signed document is ever offered.
 */

export type NextStep = readonly [icon: string, label: string];

/** The tick drawn once after signing (no motion when the reader asks for less: index.css). */
export function SuccessTick() {
  return (
    <svg viewBox="0 0 52 52" className="f04-tick-pop h-16 w-16 text-primary-600" aria-hidden="true" data-testid="f04-success-tick">
      <circle className="f04-tick-circle" cx="26" cy="26" r="24" fill="none" stroke="currentColor" strokeWidth="3" />
      <path className="f04-tick-check" d="M15 27 l7 7 l15 -16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Download signed PDF: a new short-lived link from the server on every click; a short message with Try again when that fails. */
export function DownloadSigned({ fetchUrl, label = "Download signed PDF", testId = "download-signed" }: { fetchUrl: () => Promise<string>; label?: string; testId?: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const url = await fetchUrl();
      if (!url) throw new Error("no link");
      // The link answers with "attachment": the file downloads and the page stays where it is.
      const a = document.createElement("a");
      a.href = url; a.rel = "noopener"; a.download = "";
      document.body.appendChild(a); a.click(); a.remove();
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" className={WIZARD_PRIMARY_CLASS} onClick={() => void download()} disabled={busy} aria-busy={busy} data-testid={testId}>
        <i className={busy ? "ri-loader-4-line animate-spin" : "ri-download-line"} aria-hidden="true" />{busy ? "Preparing…" : label}
      </button>
      {failed ? (
        <p role="alert" className="flex flex-wrap items-center justify-center gap-x-2 text-sm text-red-700" data-testid={`${testId}-error`}>
          The download could not start.
          <button type="button" className="cursor-pointer font-medium underline underline-offset-2" onClick={() => void download()} data-testid={`${testId}-retry`}>Try again</button>
        </p>
      ) : null}
    </div>
  );
}

export default function SigningDone({ message, note, signedAt, steps, fetchUrl, downloadLabel, downloadTestId, testId, children }: {
  /** The one line of thanks ("Thank you. Your application has been submitted."). */
  message: ReactNode;
  /** A smaller line under it (who receives a copy, what is still needed). */
  note?: ReactNode;
  signedAt?: string | null;
  /** "What happens next": up to four short steps. */
  steps?: readonly NextStep[];
  /** A fresh link to the signed document; no Download button without it. */
  fetchUrl?: () => Promise<string>;
  downloadLabel?: string;
  downloadTestId?: string;
  testId?: string;
  /** Anything that belongs after the download (the deposit card on an offer). */
  children?: ReactNode;
}) {
  const when = formatSignedAt(signedAt);
  return (
    <div className="flex flex-col items-center text-center" data-testid="signing-done">
      <div role="status" className="flex flex-col items-center gap-3 py-2 text-sm text-foreground-800" data-testid={testId}>
        <SuccessTick />
        <p className="text-base font-semibold text-foreground-950">{message}</p>
        {note ? <p className="max-w-prose text-sm text-foreground-600">{note}</p> : null}
        {when ? <p className="text-xs text-foreground-500" data-testid="signed-at">Signed {when}</p> : null}
      </div>
      <section className="mt-5 flex w-full flex-col items-center gap-5" aria-label="What happens next" data-testid="next-steps">
        {steps?.length ? <>
          <h3 className="text-sm font-semibold text-foreground-900">What happens next</h3>
          <ol className="grid w-full max-w-sm grid-cols-1 gap-2 md:max-w-none md:auto-cols-fr md:grid-flow-col md:grid-cols-none md:gap-3" data-testid="next-steps-list">
            {steps.map(([icon, label], i) => (
              <li key={label} className="flex min-w-0 items-center gap-3 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2.5 text-left text-sm text-foreground-900 md:flex-col md:justify-start md:gap-2 md:px-4 md:py-3 md:text-center">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700" aria-hidden="true"><i className={icon} /></span>
                <span className="min-w-0 break-words"><span className="sr-only">Step {i + 1}: </span>{label}</span>
              </li>
            ))}
          </ol>
        </> : null}
        {fetchUrl ? <DownloadSigned fetchUrl={fetchUrl} label={downloadLabel} testId={downloadTestId} /> : null}
      </section>
      {children ? <div className="mt-5 w-full text-left">{children}</div> : null}
    </div>
  );
}
