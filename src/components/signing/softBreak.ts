import { createElement, Fragment, type ReactNode } from "react";

/** Where a long email or web address may wrap: after "@", ".", "/", "-", "_", "?", "&", "=". */
export const SOFT_BREAK_AFTER = /([@./_?&=-])/;

/**
 * An email or web address with line-break opportunities (<wbr>) after its separators, so it wraps at "@" or "." and never splits a word
 * (owner 2026-11-20: "emails don't break mid-word"). Plain text otherwise. No JSX, so the offline tests load it directly.
 */
export function softBreak(text: string | null | undefined): ReactNode {
  const value = String(text ?? "");
  if (!value) return value;
  const parts = value.split(SOFT_BREAK_AFTER);
  return parts.map((part, i) => createElement(Fragment, { key: i }, part, SOFT_BREAK_AFTER.test(part) && i < parts.length - 1 ? createElement("wbr") : null));
}
