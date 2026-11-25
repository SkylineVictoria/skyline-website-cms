/**
 * ASM-AI-IMPORT: question numbering, normalised the same way for any provider's workbook or answer guide.
 * Pure logic (Deno, browser and Node tests). Never tied to one provider's headings.
 *
 *   "1.1", "Q1.1", "Question 1.1", "Q 1.1.", "1.1)"      -> 1.1
 *   "1.1a", "1.1(a)", "1.1 a)", "1.1.a", "Q1.1-A"        -> 1.1a   (base 1.1, part a)
 *   "2.1.3", "Q2.1.3"                                     -> 2.1.3
 *   "A.1", "a-1", "Section A.1"                           -> A.1
 *   "01.02"                                               -> 1.2
 */
export interface QNumber {
  /** The canonical form, part included ("1.1a"). */
  canonical: string;
  /** Without the part ("1.1"). */
  base: string;
  /** The part letter(s), lower case ("a", "ii"), or null. */
  part: string | null;
}

const PREFIX = /^(?:section|activity|question|questions|ques|qn|item|task|no|q)\s*[.:#\-]?\s*/i;

/** The canonical number of a raw label, or null when it is not a number. */
export function normalizeNumber(raw: string | null | undefined): QNumber | null {
  if (raw == null) return null;
  let s = String(raw).normalize("NFKC").trim().replace(/[\u2010-\u2015\u2212]/g, "-");
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, "");
  s = s.replace(/\s+/g, "").replace(/[)\].:,;]+$/, "").replace(/^[([]+/, "");
  const m = /^(?:([A-Za-z])[.-]?)?(\d{1,3}(?:[.-]\d{1,3})*)(?:[.-]?\(?([A-Za-z]{1,4})\)?)?$/.exec(s);
  if (!m) {
    // a lettered section on its own ("A", "B.") is a number too, but only a single capital letter
    const letter = /^([A-Z])$/.exec(s);
    return letter ? { canonical: letter[1], base: letter[1], part: null } : null;
  }
  const lead = m[1] ? `${m[1].toUpperCase()}.` : "";
  const digits = m[2].split(/[.-]/).map((d) => String(Number(d))).join(".");
  const part = m[3] ? m[3].toLowerCase() : null;
  const base = `${lead}${digits}`;
  return { canonical: `${base}${part ?? ""}`, base, part };
}

/** A part label on its own ("a", "(b)", "c)", "ii.") -> "a" / "b" / "c" / "ii"; null when it is not one. */
export function normalizePart(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).normalize("NFKC").trim().replace(/^part\s*/i, "").replace(/^\(+/, "").replace(/[).:\]]+$/, "").trim();
  return /^[A-Za-z]{1,4}$/.test(s) ? s.toLowerCase() : null;
}

/** Sort key so 1.2 < 1.10 < 2.1 and A.1 < A.2 < 1.1 never collide ("A.1" sorts before numeric numbers). */
export function numberSortKey(n: QNumber | null): string {
  if (!n) return "~";
  const segs = n.base.split(".").map((p) => (/^\d+$/.test(p) ? p.padStart(4, "0") : `!${p}`));
  return `${segs.join(".")}${n.part ? `~${n.part}` : ""}`;
}

/** "1.1a" with the part split off the base given (when the model put the part in the number). */
export function joinNumber(base: string, part: string | null): string {
  return `${base}${part ?? ""}`;
}
