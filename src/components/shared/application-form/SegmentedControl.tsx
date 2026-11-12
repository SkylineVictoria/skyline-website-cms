import type { CSSProperties } from "react";

/**
 * Segmented controls (36px): a neutral track with a white thumb that slides (200ms) under the chosen option, shown in orange.
 * SegmentedControl is a button group for a choice the page keeps in state (how to fill the address, add a visa, give academic
 * details). SegmentedRadios wraps native radio inputs, so a form's own answers (Gender, Yes / No) keep their names, values and
 * required rules and are read and restored exactly as before; the thumb follows the checked input (CSS :has).
 */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  /** Shown as the option's tooltip. */
  hint?: string;
}

export default function SegmentedControl<T extends string>({ label, value, options, onChange, disabled, testId }: {
  label: string;
  value: T | "";
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const index = options.findIndex((option) => option.value === value);
  const style = { "--seg-count": options.length, "--seg-index": Math.max(0, index) } as CSSProperties;
  return (
    <div role="radiogroup" aria-label={label} className="seg-track" style={style} data-selected={index >= 0 ? "" : undefined} data-testid={testId}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.hint}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="seg-item"
        >
          {option.icon ? <i className={`${option.icon} hidden text-base leading-none sm:inline`} aria-hidden="true" /> : null}
          <span className="truncate">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SegmentedRadios({ name, label, options, required, disabled }: {
  name: string;
  label: string;
  options: readonly string[];
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    // At input height (40px) here: it sits in a row of inputs.
    <div role="radiogroup" aria-label={label} className="seg-track" style={{ "--seg-count": options.length, height: 40 } as CSSProperties}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((option) => (
        <label key={option} className="seg-item">
          <input type="radio" name={name} value={option} required={required} disabled={disabled} className="sr-only" />
          <span className="truncate">{option}</span>
        </label>
      ))}
    </div>
  );
}
