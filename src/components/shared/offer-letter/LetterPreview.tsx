import { useEffect, useRef, useState } from "react";
import PdfPages from "@/components/signing/PdfPages";
import { buildLetterPdf, type LetterPdfInput } from "@/lib/offerLetters";
import { baseKey, courseIndexOf, letterKeys, type LetterValue, type LetterVariable, type ManualFill } from "../../../../supabase/functions/_shared/letter-variables";

export interface BuiltLetter { bytes: Uint8Array; pages: number; missing: string[]; marks: Array<{ key: string; page: number; x: number; y: number; w: number; h: number }> }

/**
 * The letter as it will be sent: the PDF made in the browser from the template and the values (A4, header and footer on every page,
 * page numbers), drawn page by page. Every missing variable prints as [Label] on yellow; its box is a button that calls `onMark` so the
 * drawer can focus that detail's input. The PDF is rebuilt (debounced) whenever the template or a value changes.
 */
export default function LetterPreview({ input, onBuilt, onMark, testId = "letter-preview" }: {
  input: LetterPdfInput; onBuilt?: (letter: BuiltLetter | null, error: string) => void; onMark?: (key: string) => void; testId?: string;
}) {
  const [letter, setLetter] = useState<BuiltLetter | null>(null);
  const [error, setError] = useState("");
  const [building, setBuilding] = useState(false);
  const built = useRef(onBuilt); built.current = onBuilt;
  const signature = JSON.stringify([input.template, input.values, input.manual, input.conditions, input.sample, input.registry.length]);

  useEffect(() => {
    let cancelled = false;
    setBuilding(true);
    const timer = window.setTimeout(() => {
      void buildLetterPdf(input).then((made) => {
        if (cancelled) return;
        const next = { bytes: made.bytes, pages: made.pages, missing: made.missing, marks: made.marks };
        setLetter(next); setError(""); built.current?.(next, "");
      }, (e: Error) => {
        if (cancelled) return;
        setLetter(null); setError(e.message || "The letter could not be made."); built.current?.(null, e.message || "The letter could not be made.");
      }).finally(() => { if (!cancelled) setBuilding(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when what it prints changes (signature)
  }, [signature]);

  return (
    <div className="relative" data-testid={testId} data-pages={letter?.pages ?? 0} data-missing={letter?.missing.join(",") ?? ""}>
      {building ? <p className="absolute right-2 top-2 z-10 rounded bg-background-50/90 px-2 py-0.5 text-2xs text-foreground-600 shadow-sm" role="status"><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Updating…</p> : null}
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {letter ? (
        <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-background-200 bg-background-100 p-3">
          <PdfPages source={letter.bytes} maxWidth={720} overlay={(page, size) => letter.marks.filter((m) => m.page === page).map((m, i) => (
            <button key={`${m.key}-${i}`} type="button" onClick={() => onMark?.(m.key)} data-testid="letter-mark" data-key={m.key} title="Missing: click to fill it in"
              className="absolute cursor-pointer rounded-sm ring-2 ring-amber-400/80 hover:ring-amber-600"
              style={{ left: m.x * size.width, top: m.y * size.height, width: Math.max(8, m.w * size.width), height: m.h * size.height }} />
          ))} />
        </div>
      ) : !error ? <p className="rounded-lg border border-background-200 p-6 text-center text-sm text-foreground-500" role="status">Making the letter…</p> : null}
    </div>
  );
}

/** Variable check: each variable the template uses, its value for this application, where it comes from and whether it is filled. */
export function VariableCheck({ html, registry, values, manual = [], testId = "variable-check" }: {
  html: string; registry: readonly LetterVariable[]; values: Record<string, LetterValue>; manual?: readonly ManualFill[]; testId?: string;
}) {
  const byKey = new Map(registry.map((v) => [v.key, v]));
  const fills = new Map(manual.map((m) => [m.key, m]));
  const keys = letterKeys(html).filter((k) => byKey.get(baseKey(k))?.sourceKind !== "render");
  if (!keys.length) return <p className="text-sm text-foreground-500">The template uses no variables.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-background-200" data-testid={testId}>
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="bg-background-100 text-foreground-600"><tr><th className="px-2 py-1.5 font-medium">Variable</th><th className="px-2 py-1.5 font-medium">Value</th><th className="px-2 py-1.5 font-medium">Source</th></tr></thead>
        <tbody className="divide-y divide-background-200">
          {keys.map((key) => {
            const spec = byKey.get(baseKey(key));
            const value = values[key];
            const fill = fills.get(key);
            const shown = fill && fill.mode !== "blank" && fill.value.trim() ? fill.value : value && !value.missing ? value.value : "";
            const state = fill?.mode === "letter" ? "Typed for this letter" : fill?.mode === "source" ? "Saved to source" : fill?.mode === "blank" ? "Left blank" : null;
            return (
              <tr key={key} data-testid="variable-check-row" data-key={key} className={!shown && fill?.mode !== "blank" && spec?.sourceKind !== "entered" ? "bg-amber-50/70" : ""}>
                <td className="px-2 py-1.5 align-top"><span className="font-medium text-foreground-900">{spec?.label ?? key}{courseIndexOf(key) ? ` (course ${courseIndexOf(key) + 1})` : ""}</span><br /><code className="text-2xs text-foreground-500">{`{{${key}}}`}</code></td>
                <td className="whitespace-pre-line px-2 py-1.5 align-top text-foreground-900" data-testid="variable-check-value">{shown || <span className="text-amber-800">{spec?.required ? "Missing (required)" : "Missing"}</span>}</td>
                <td className="px-2 py-1.5 align-top text-foreground-600">{state ? <span className="font-medium text-foreground-800">{state}</span> : (value?.source ?? spec?.source)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
