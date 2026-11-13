import type { OnboardingStep } from "@/lib/staffApi";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const full = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The nine onboarding stages as circles joined by a line (the style of WizardSteps, extended): a completed step is a filled orange
 * circle with a tick and its line is filled, the step the person is on is outlined and labelled "Current", later steps are grey.
 * The date a step was reached is under its label (the full date and time on hover). On a narrow screen the steps stack vertically.
 * `closed` (rejected / inactive): the steps reached stay ticked and nothing is current.
 */
export default function OnboardingStepper({ steps, closed }: { steps: OnboardingStep[]; closed: "rejected" | "inactive" | null }) {
  return (
    <ol className="flex flex-col lg:flex-row" aria-label="Onboarding progress" data-testid="onboarding-stepper">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        // The line after a step is filled once the NEXT step has been reached.
        const lineDone = !last && steps[i + 1].state !== "todo";
        const circle = step.state === "done" ? "border-primary-500 bg-primary-500 text-background-50"
          : step.state === "current" ? "border-primary-500 bg-background-50 text-primary-700 ring-4 ring-primary-100"
            : "border-background-300 bg-background-100 text-foreground-400";
        return (
          <li key={step.key} className="relative flex min-w-0 flex-1 gap-3 pb-5 last:pb-0 lg:flex-col lg:items-center lg:gap-2 lg:pb-0"
            aria-current={step.state === "current" ? "step" : undefined} data-testid={`onboarding-step-${step.key}`} data-state={step.state}>
            {!last ? <>
              {/* vertical line (stacked) */}
              <span aria-hidden="true" className={`absolute left-[15px] top-8 bottom-0 w-0.5 lg:hidden ${lineDone ? "bg-primary-500" : "bg-background-300"}`} />
              {/* horizontal line (desktop): from the centre of this circle to the centre of the next */}
              <span aria-hidden="true" className={`absolute left-1/2 top-[15px] hidden h-0.5 w-full lg:block ${lineDone ? "bg-primary-500" : "bg-background-300"}`} />
            </> : null}
            <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${circle}`}>
              {step.state === "done" ? <i className="ri-check-line text-base" aria-hidden="true" /> : i + 1}
            </span>
            <span className="min-w-0 lg:px-1 lg:text-center">
              <span className={`block text-sm leading-tight lg:text-xs ${step.state === "todo" ? "text-foreground-500" : "font-semibold text-foreground-950"}`}>{step.label}</span>
              {step.state === "current" ? <span className="mt-1 inline-block rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-primary-800">Current</span> : null}
              {step.at && step.state !== "todo" ? <time dateTime={step.at} title={full(step.at)} className="mt-0.5 block text-2xs text-foreground-600">{day(step.at)}</time> : null}
              <span className="sr-only">{step.state === "done" ? "completed" : step.state === "current" ? "current step" : "not started"}</span>
            </span>
          </li>
        );
      })}
      {closed ? <li className="sr-only">This application is {closed}.</li> : null}
    </ol>
  );
}
