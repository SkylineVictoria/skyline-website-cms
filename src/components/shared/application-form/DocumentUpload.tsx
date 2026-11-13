import { useState, type DragEvent, type ReactNode, type RefObject } from "react";

/**
 * The pieces every document upload on the form and in the wizards is built from: a compact dashed dropzone (click or drop, with a
 * one-line file hint), a compact row for a stored file (icon, name, status pill, icon actions), and a friendly failure line with
 * "Try again" and "Fill manually". The reading state in between is DocumentReadingState.
 */

export function Dropzone({ id, name, label, hint, multiple, disabled, accept, inputRef, testId, onFiles }: {
  id?: string;
  /** The input's name (kept where the form reads it). */
  name?: string;
  label: string;
  hint: string;
  multiple?: boolean;
  disabled?: boolean;
  accept: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  testId?: string;
  onFiles: (files: FileList | null) => void;
}) {
  const [over, setOver] = useState(false);
  const drag = {
    onDragOver: (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); if (!disabled && !over) setOver(true); },
    onDragLeave: (event: DragEvent<HTMLLabelElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); },
    onDrop: (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); event.stopPropagation(); setOver(false); if (!disabled && event.dataTransfer.files.length) onFiles(event.dataTransfer.files); },
  };
  return (
    <label
      htmlFor={id}
      data-testid={testId}
      {...drag}
      className={`flex h-10 items-center gap-2 rounded-lg border border-dashed px-3 text-sm transition-colors duration-150 ${
        disabled ? "cursor-not-allowed border-background-300 text-foreground-400 opacity-60"
          : over ? "cursor-copy border-primary-400 bg-primary-50 text-foreground-900"
            : "cursor-pointer border-background-300 bg-background-50 text-foreground-600 hover:border-foreground-400 hover:text-foreground-900"
      }`}
    >
      <i className={`${over ? "ri-download-2-line" : "ri-upload-2-line"} text-base leading-none`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{over ? "Drop to upload" : label}</span>
      <span className="hidden shrink-0 text-xs text-foreground-400 sm:inline">{hint}</span>
      <input ref={inputRef} id={id} name={name} type="file" accept={accept} multiple={multiple} disabled={disabled}
        onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }} className="sr-only" />
    </label>
  );
}

export interface Pill { text: string; tone: "neutral" | "ready" | "warn" | "failed"; spin?: boolean; title?: string }

const PILL_TONE: Record<Pill["tone"], string> = {
  neutral: "bg-background-100 text-foreground-600",
  ready: "bg-emerald-50 text-emerald-800",
  warn: "bg-amber-50 text-amber-800",
  failed: "bg-red-50 text-red-700",
};

export function DocumentRow({ filename, pill, actions, children, testId }: {
  filename: string;
  pill: Pill;
  actions: ReactNode;
  /** Under the row: a note such as an expiry warning or a failure line. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="open-in" data-testid={testId}>
      <div className="flex h-10 items-center gap-2 rounded-lg border border-background-300 bg-background-50 pl-3 pr-1">
        <i className="ri-file-text-line shrink-0 text-base leading-none text-foreground-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground-900" title={filename}>{filename}</span>
        <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ${PILL_TONE[pill.tone]}`} title={pill.title}>
          {pill.spin ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : null}
          {pill.text}
        </span>
        <div className="flex shrink-0 items-center">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function RowAction({ title, icon, label, disabled, busy, onClick }: { title: string; icon: string; label: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={label} disabled={disabled} onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900 disabled:cursor-not-allowed disabled:opacity-50">
      <i className={`${busy ? "ri-loader-4-line animate-spin" : icon} text-base leading-none`} aria-hidden="true" />
    </button>
  );
}

/** Reading did not work: a friendly line, "Try again" and "Fill manually". Nothing here blocks the form. */
export function ReadFailure({ message, onRetry, onManual }: { message?: string; onRetry?: () => void; onManual: () => void }) {
  return (
    <div className="fade-in mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-700" role="alert">
      <span className="flex items-center gap-1.5">
        <i className="ri-emotion-unhappy-line text-base leading-none text-amber-600" aria-hidden="true" />
        {message || "We couldn’t read this one."}
      </span>
      {onRetry ? <button type="button" onClick={onRetry} className="cursor-pointer font-medium text-foreground-900 underline underline-offset-2 hover:text-primary-700">Try again</button> : null}
      <button type="button" onClick={onManual} className="cursor-pointer font-medium text-foreground-900 underline underline-offset-2 hover:text-primary-700">Fill manually</button>
    </div>
  );
}
