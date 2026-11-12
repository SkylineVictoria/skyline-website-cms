import { useEffect, useId, useRef, useState } from "react";

/**
 * A small (i) beside a label or title that holds the longer help text. It opens on hover, focus or tap, stays inside the viewport
 * (fixed position, clamped), and closes on Escape, blur or scroll. It sits next to the <label>, never inside it, so the field's
 * accessible name stays the label alone; the text is the button's description.
 */
export default function InfoTip({ text, label = "More information" }: { text: string; label?: string }) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(256, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    setPos({ left, top: rect.bottom + 6, width });
  };
  const hide = () => setPos(null);

  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [pos]);

  return (
    <span className="inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-describedby={id}
        onFocus={show}
        onBlur={hide}
        onClick={() => (pos ? hide() : show())}
        onKeyDown={(event) => { if (event.key === "Escape") hide(); }}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full text-foreground-400 transition-colors hover:text-foreground-700 focus-visible:text-foreground-700"
      >
        <i className="ri-information-line text-base leading-none" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!pos}
        style={pos ? { position: "fixed", left: pos.left, top: pos.top, width: pos.width } : undefined}
        className="z-[90] rounded-lg border border-background-200 bg-background-50 px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-foreground-700 shadow-sm"
      >
        {text}
      </span>
    </span>
  );
}
