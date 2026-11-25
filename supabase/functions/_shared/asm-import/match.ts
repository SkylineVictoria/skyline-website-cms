/**
 * ASM-AI-IMPORT: the answer guide matched to the workbook's questions, and the two documents checked against each other.
 *
 *  - By normalised number (numbering.ts): "Q1.2" in the guide answers "1.2" in the workbook.
 *  - Parts match part by part (1.2a -> part a of 1.2); a guide that answers the whole question attaches to the question.
 *  - Numbering that does not line up: a match is SUGGESTED by content (the guide repeats the question), always flagged for review.
 *  - Project-task benchmarks ("what to look for") become assessor guidance. Answers only ever reach asm_question_keys.
 *  - Unit codes must be the same (a mismatch blocks); different versions are a warning.
 */
import { normalizeNumber } from "./numbering.ts";
import { normText, similarity } from "./verbatim.ts";

export interface MatchQuestion {
  /** The question's id in the draft definition. */
  id: string;
  /** Its number as printed in the workbook ("Q1.2", "2.1.3"). */
  number: string | null;
  text: string;
  /** Lettered parts (child questions) with their own ids. */
  parts: { id: string; label: string; text: string }[];
}
export interface GuideAnswer {
  number: string | null;
  /** The question as the guide repeats it (for a content match). */
  questionText: string | null;
  answer: string | null;
  lookFor: string | null;
  parts: { label: string; answer: string | null; text?: string | null }[];
}
export interface MatchedKey {
  questionId: string;
  modelAnswer: string | null;
  assessorGuidance: string | null;
  via: "number" | "part" | "content";
  /** Set when the admin must check it (a content match, or a guide answer split across parts). */
  review: string | null;
}
export interface MatchOutcome {
  keys: MatchedKey[];
  /** Questions answered (a question counts when it or every one of its parts has an answer). */
  matched: number;
  total: number;
  /** Question ids with no answer from the guide. */
  missing: string[];
  /** Guide answers that went nowhere. */
  unused: GuideAnswer[];
}

const canon = (n: string | null) => normalizeNumber(n);
const join = (...xs: (string | null | undefined)[]) => xs.map((x) => (x ?? "").trim()).filter(Boolean).join("\n\n") || null;
const hasContent = (a: GuideAnswer) => Boolean(a.answer || a.lookFor || a.parts.some((p) => p.answer));

export function matchGuide(questions: MatchQuestion[], guide: GuideAnswer[], minContentScore = 0.55): MatchOutcome {
  const answers = guide.filter(hasContent);
  const byNumber = new Map<string, GuideAnswer>();
  for (const a of answers) { const c = canon(a.number); if (c && !byNumber.has(c.canonical)) byNumber.set(c.canonical, a); }
  const used = new Set<GuideAnswer>();
  const keys: MatchedKey[] = [];
  const answered = new Set<string>();
  const add = (k: MatchedKey) => { keys.push(k); };

  for (const q of questions) {
    const n = canon(q.number);
    if (!n) continue;
    const whole = byNumber.get(n.base);
    if (q.parts.length) {
      let partsDone = 0;
      for (const p of q.parts) {
        const label = (normalizeNumber(`${n.base}${p.label}`)?.part) ?? p.label.toLowerCase();
        const direct = byNumber.get(`${n.base}${label}`);
        const nested = whole?.parts.find((x) => (normalizeNumber(`${n.base}${x.label}`)?.part ?? x.label.toLowerCase()) === label && x.answer);
        if (direct) { used.add(direct); add({ questionId: p.id, modelAnswer: join(direct.answer, ...direct.parts.map((x) => x.answer)), assessorGuidance: direct.lookFor, via: "part", review: null }); partsDone += 1; }
        else if (nested) { add({ questionId: p.id, modelAnswer: nested.answer, assessorGuidance: null, via: "part", review: null }); partsDone += 1; }
      }
      if (whole) used.add(whole);
      if (whole && (whole.answer || whole.lookFor || partsDone === 0)) {
        // the guide answers the whole question (or its parts could not be told apart): attach to the question itself
        const leftover = partsDone === 0 ? whole.parts.filter((x) => x.answer).map((x) => `${x.label}) ${x.answer}`) : [];
        add({ questionId: q.id, modelAnswer: join(whole.answer, ...leftover), assessorGuidance: whole.lookFor, via: "number", review: null });
        answered.add(q.id);
      } else if (partsDone === q.parts.length) answered.add(q.id);
      else if (partsDone > 0) answered.add(q.id);
      continue;
    }
    if (whole) {
      used.add(whole);
      add({ questionId: q.id, modelAnswer: join(whole.answer, ...whole.parts.filter((x) => x.answer).map((x) => `${x.label}) ${x.answer}`)), assessorGuidance: whole.lookFor, via: "number", review: null });
      answered.add(q.id);
      continue;
    }
    // the guide split a single question into parts (1.3a, 1.3b): put them together, for review
    const split = answers.filter((a) => { const c = canon(a.number); return c?.base === n.base && c.part; });
    if (split.length) {
      split.forEach((a) => used.add(a));
      add({ questionId: q.id, modelAnswer: join(...split.map((a) => `${canon(a.number)?.part}) ${a.answer ?? ""}`)), assessorGuidance: join(...split.map((a) => a.lookFor)), via: "number", review: "The guide answers this question in parts" });
      answered.add(q.id);
    }
  }

  // numbering that does not line up: suggest by content, never silently
  const open = questions.filter((q) => !answered.has(q.id));
  const free = answers.filter((a) => !used.has(a) && a.questionText);
  for (const q of open) {
    const scored = free.filter((a) => !used.has(a)).map((a) => ({ a, s: similarity(q.text, a.questionText ?? "") })).sort((x, y) => y.s - x.s);
    const best = scored[0];
    if (!best || best.s < minContentScore || (scored[1] && scored[1].s > best.s - 0.05)) continue;
    used.add(best.a);
    add({ questionId: q.id, modelAnswer: join(best.a.answer, ...best.a.parts.filter((x) => x.answer).map((x) => `${x.label}) ${x.answer}`)), assessorGuidance: best.a.lookFor, via: "content",
      review: `Matched by content to guide ${best.a.number ? `question ${best.a.number}` : "answer"}: check it` });
    answered.add(q.id);
  }

  const total = questions.filter((q) => q.number || q.text).length;
  return {
    keys, matched: questions.filter((q) => answered.has(q.id)).length, total,
    missing: questions.filter((q) => !answered.has(q.id)).map((q) => q.id),
    unused: answers.filter((a) => !used.has(a)),
  };
}

export interface DocumentCheck {
  unit: "same" | "different" | "unknown";
  version: "same" | "different" | "unknown";
  /** A different unit blocks using the guide. */
  block: boolean;
  messages: string[];
}

const codeOf = (c: string | null | undefined) => (c ?? "").replace(/\s+/g, "").toUpperCase();
const versionOf = (v: string | null | undefined) => { const m = /\d+(?:\.\d+)*/.exec(v ?? ""); return m ? m[0].replace(/(\.0+)+$/, "") : ""; };

export function checkDocuments(workbook: { unitCode: string | null; version: string | null }, guide: { unitCode: string | null; version: string | null }): DocumentCheck {
  const wu = codeOf(workbook.unitCode); const gu = codeOf(guide.unitCode);
  const wv = versionOf(workbook.version); const gv = versionOf(guide.version);
  const unit = wu && gu ? (wu === gu ? "same" : "different") : "unknown";
  const version = wv && gv ? (wv === gv ? "same" : "different") : "unknown";
  const messages: string[] = [];
  if (unit === "different") messages.push(`The answer guide is for ${gu}, the workbook for ${wu}: use the guide for ${wu}.`);
  if (unit === "unknown") messages.push(`The ${!gu ? "answer guide" : "workbook"} does not print its unit code: check they belong together.`);
  if (version === "different") messages.push(`Different versions: workbook ${normText(workbook.version ?? "")}, answer guide ${normText(guide.version ?? "")}.`);
  return { unit, version, block: unit === "different", messages };
}

/** "1.0" -> "1.1", "2" -> "2.1", "1.9" -> "1.10"; null stays "1.1" (a first edit of an unversioned import). */
export function bumpVersion(v: string | null | undefined): string {
  const m = /^(\d+)(?:\.(\d+))?/.exec((v ?? "").trim());
  if (!m) return "1.1";
  return `${m[1]}.${(Number(m[2] ?? 0) || 0) + 1}`;
}
