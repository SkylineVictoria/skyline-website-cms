import { useState } from "react";

type TermsDeclarationProps = {
  heading: string;
  terms: string[];
  /** Inside a page card (the compact application form): no box of its own and a neutral "agree to all" row. */
  plain?: boolean;
};

export default function TermsDeclaration({ heading, terms, plain = false }: TermsDeclarationProps) {
  const [checked, setChecked] = useState<boolean[]>(() => terms.map(() => false));
  const [open, setOpen] = useState(false);

  const agreedCount = checked.filter(Boolean).length;
  const allChecked = terms.length > 0 && agreedCount === terms.length;

  const toggleAll = () => {
    const next = !allChecked;
    setChecked(terms.map(() => next));
    if (next) setOpen(true);
  };

  const toggleOne = (index: number) => {
    setChecked((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  return (
    <div className={plain ? "" : "rounded-card border border-background-200 bg-background-100/70 p-4 md:p-5"}>
      <p className="text-sm font-semibold text-foreground-900">{heading}</p>

      <label className={plain ? "mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-background-300 p-3" : "mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-primary-200 bg-primary-50/70 p-3.5"}>
        <input
          type="checkbox"
          checked={allChecked}
          onChange={toggleAll}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary-500"
        />
        <span>
          <span className="block text-sm font-semibold text-foreground-950">
            I agree to all Terms &amp; Conditions
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-foreground-600">
            Ticking this accepts every clause below. You can uncheck any individual clause afterwards.
          </span>
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-primary-600 transition-colors hover:text-primary-700"
        >
          <i className={open ? "ri-arrow-up-s-line text-base" : "ri-arrow-down-s-line text-base"} aria-hidden="true" />
          {open ? "Hide Terms & Conditions" : "Read & review Terms & Conditions"}
        </button>
        <span className="text-xs font-medium text-foreground-500">
          {agreedCount} of {terms.length} agreed
        </span>
      </div>

      {open ? (
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1.5">
          {terms.map((term, index) => (
            <label
              key={`term-${index}`}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-background-200 bg-background-50 p-3 transition-colors hover:border-primary-200"
            >
              <input
                type="checkbox"
                name="declaration[]"
                value={term}
                checked={checked[index]}
                onChange={() => toggleOne(index)}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary-500"
              />
              <span className="text-xs leading-relaxed text-foreground-700">{term}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}