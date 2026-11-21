/**
 * The progress of a wizard as a few stages (a slim bar each) instead of one pill per step: done stages are filled, the current one is
 * part filled, and the line under it says which step of how many this is. Clicking a stage goes to its first step (the wizard decides
 * whether that is allowed). `after` names the stage that follows the wizard (Review), shown as an unfilled bar that cannot be clicked.
 */
export interface WizardStage {
  id: string;
  title: string;
  /** Index of its first and last step in the wizard's step list. */
  from: number;
  to: number;
  /** A step of this stage is uploading or being read. */
  busy?: boolean;
}

export default function WizardStages({ stages, current, total, stepTitle, onSelect, after }: {
  stages: readonly WizardStage[];
  /** Index of the current step in the wizard's step list. */
  current: number;
  total: number;
  /** The current step's title, shown under the bars. */
  stepTitle: string;
  onSelect: (index: number) => void;
  after?: string;
}) {
  return (
    <div className="border-b border-background-200 px-5 pb-3.5 pt-4 md:px-6" data-testid="wizard-stages">
      <ol className="flex gap-1.5" aria-label="Progress">
        {stages.map((stage, i) => {
          const here = current >= stage.from && current <= stage.to;
          const done = current > stage.to;
          const span = stage.to - stage.from + 1;
          const fill = done ? 100 : here ? Math.round(((current - stage.from + 0.5) / span) * 100) : 0;
          return (
            <li key={stage.id} className="min-w-0 flex-1">
              <button type="button" onClick={() => onSelect(stage.from)} aria-current={here ? "step" : undefined}
                className="group flex w-full cursor-pointer flex-col gap-1.5 text-left">
                <span className="h-1.5 w-full overflow-hidden rounded-full bg-background-200">
                  <span className={`block h-full rounded-full transition-[width] duration-300 ${done ? "bg-green-600" : "bg-primary-500"}`} style={{ width: `${fill}%` }} />
                </span>
                <span className={`flex items-center gap-1 truncate text-xs ${here ? "font-semibold text-foreground-950" : "text-foreground-500 group-hover:text-foreground-800"}`}>
                  {stage.busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : done ? <i className="ri-check-line text-green-700" aria-hidden="true" /> : null}
                  <span className="truncate">{i + 1} · {stage.title}</span>
                </span>
              </button>
            </li>
          );
        })}
        {after ? (
          <li className="min-w-0 flex-1" aria-hidden="true">
            <span className="flex w-full flex-col gap-1.5">
              <span className="h-1.5 w-full rounded-full bg-background-200" />
              <span className="truncate text-xs text-foreground-400">{stages.length + 1} · {after}</span>
            </span>
          </li>
        ) : null}
      </ol>
      <p className="mt-2.5 text-xs text-foreground-500">Step {current + 1} of {total} · <span className="font-medium text-foreground-700">{stepTitle}</span></p>
    </div>
  );
}
