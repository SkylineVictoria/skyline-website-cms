/**
 * The step pills across the top of a wizard: the current step is highlighted, a completed step is filled and shows a tick, a
 * step whose file is uploading or being read shows a spinner. Clicking a pill asks the wizard to go there (the wizard decides).
 */
export interface WizardStepperItem {
  id: string;
  short: string;
  icon: string;
  busy?: boolean;
  /** Completed. Left out, every step before the current one counts as completed. */
  done?: boolean;
}

export default function WizardStepper({ items, current, onSelect }: { items: readonly WizardStepperItem[]; current: number; onSelect: (index: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-background-200 px-5 py-3.5 md:px-6">
      {items.map((item, index) => {
        const active = index === current;
        const done = item.done ?? index < current;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(index)}
            className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              active
                ? "border-primary-300 bg-primary-50 text-primary-700"
                : done
                  ? "border-background-200 bg-background-100 text-foreground-600"
                  : "border-background-200 bg-background-50 text-foreground-400"
            }`}
          >
            {item.busy ? (
              <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
            ) : (
              <i className={done ? "ri-check-line" : item.icon} aria-hidden="true" />
            )}
            {item.short}
          </button>
        );
      })}
    </div>
  );
}
