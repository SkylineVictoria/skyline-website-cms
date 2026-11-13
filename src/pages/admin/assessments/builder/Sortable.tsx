import type { ReactNode } from "react";

/** The drag handle of a sortable row (spread the hook's `handleProps(index)` onto it). */
export function DragHandle({ label = "Drag to reorder", ...rest }: { label?: string } & Record<string, unknown>) {
  return <span role="button" tabIndex={-1} aria-label={label} title={label} className="cursor-grab select-none px-1 text-foreground-400 hover:text-foreground-700 active:cursor-grabbing" {...rest}><i className="ri-draggable" aria-hidden="true" /></span>;
}

/** Keyboard-friendly reordering beside the drag handle. */
export function UpDown({ index, length, onMove }: { index: number; length: number; onMove: (from: number, to: number) => void }): ReactNode {
  return (
    <span className="inline-flex">
      <button type="button" aria-label="Move up" disabled={index === 0} className="px-0.5 text-foreground-500 hover:text-foreground-800 disabled:opacity-30" onClick={() => onMove(index, index - 1)}><i className="ri-arrow-up-s-line" aria-hidden="true" /></button>
      <button type="button" aria-label="Move down" disabled={index >= length - 1} className="px-0.5 text-foreground-500 hover:text-foreground-800 disabled:opacity-30" onClick={() => onMove(index, index + 1)}><i className="ri-arrow-down-s-line" aria-hidden="true" /></button>
    </span>
  );
}
