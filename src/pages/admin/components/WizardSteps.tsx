/** The step strip of an admin wizard (New job post, Add staff member): numbered steps, the current one highlighted, done ones ticked. */
export default function WizardSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2" aria-label="Steps">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={label} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${state === "current" ? "bg-primary-500 text-background-50" : state === "done" ? "bg-secondary-100 text-secondary-800" : "bg-background-200 text-foreground-500"}`}>
              {state === "done" ? <i className="ri-check-line" aria-hidden="true" /> : i + 1}
            </span>
            <span className={`text-sm ${state === "current" ? "font-semibold text-foreground-950" : "text-foreground-600"}`}>{label}</span>
            {i < steps.length - 1 ? <span className="mx-1 h-px w-6 bg-background-300" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
