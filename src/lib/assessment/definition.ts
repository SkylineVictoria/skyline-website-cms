import { newId, withSchema } from "./registry";
import type { Definition, Question, Section, Task } from "./types";

export const emptyDefinition = (): Definition => ({ instructions: "", tasks: [] });
export const newTask = (title = "New task"): Task => ({ id: newId("t"), title, instructions: "", sections: [{ id: newId("s"), title: "Section 1", questions: [] }] });
export const newSection = (title = "New section"): Section => ({ id: newId("s"), title, questions: [] });

export interface FlatQuestion { task: Task; section: Section; question: Question; parent: Question | null; depth: number; number: string }

/** Every question in reading order with its numbering (1.1, 1.2, 1.2a …), children included. */
export function flattenQuestions(def: Definition): FlatQuestion[] {
  const out: FlatQuestion[] = [];
  def.tasks.forEach((task, ti) => {
    let n = 0;
    task.sections.forEach((section) => {
      const walk = (q: Question, parent: Question | null, depth: number, prefix: string) => {
        out.push({ task, section, question: q, parent, depth, number: prefix });
        (q.children ?? []).forEach((c, ci) => walk(c, q, depth + 1, `${prefix}${String.fromCharCode(97 + (ci % 26))}`));
      };
      section.questions.forEach((q) => {
        if (q.type === "instruction" || q.type === "content") { out.push({ task, section, question: q, parent: null, depth: 0, number: "" }); return; }
        n += 1; walk(q, null, 0, `${ti + 1}.${n}`);
      });
    });
  });
  return out;
}

export function findQuestion(def: Definition, id: string): Question | undefined {
  return flattenQuestions(def).find((f) => f.question.id === id)?.question;
}

/** Replaces a question (by id) anywhere in the tree; the schema is recomputed. */
export function updateQuestion(def: Definition, id: string, patch: (q: Question) => Question): Definition {
  const walk = (list: Question[]): Question[] => list.map((q) => (q.id === id ? withSchema(patch(q)) : q.children ? { ...q, children: walk(q.children) } : q));
  return { ...def, tasks: def.tasks.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, questions: walk(s.questions) })) })) };
}

export function removeQuestion(def: Definition, id: string): Definition {
  const walk = (list: Question[]): Question[] => list.filter((q) => q.id !== id).map((q) => (q.children ? { ...q, children: walk(q.children) } : q));
  return { ...def, tasks: def.tasks.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, questions: walk(s.questions) })) })) };
}

/** A deep copy with fresh ids everywhere (question bank insert, duplicate, template). Option ids are kept: answers key on them. */
export function cloneQuestion(q: Question): Question {
  const copy = structuredClone(q);
  const walk = (x: Question) => { x.id = newId("q"); (x.children ?? []).forEach(walk); (x.criteria ?? []).forEach((c) => { c.id = newId("c"); }); };
  walk(copy);
  return copy;
}

export function cloneTask(t: Task): Task {
  return { ...structuredClone(t), id: newId("t"), sections: t.sections.map(cloneSection) };
}
export function cloneSection(s: Section): Section {
  return { ...structuredClone(s), id: newId("s"), questions: s.questions.map(cloneQuestion) };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = list.slice(); const [item] = out.splice(from, 1); out.splice(to, 0, item); return out;
}

/** Ids of every question that may be referenced by a condition (those before the given question in reading order). */
export function earlierQuestionIds(def: Definition, id: string): { id: string; label: string; type: string }[] {
  const all = flattenQuestions(def).filter((f) => f.question.type !== "instruction" && f.question.type !== "content");
  const idx = all.findIndex((f) => f.question.id === id);
  return (idx < 0 ? all : all.slice(0, idx)).map((f) => ({ id: f.question.id, label: `${f.number} ${f.question.label || f.question.type}`, type: f.question.type }));
}

export const countQuestions = (def: Definition) => flattenQuestions(def).filter((f) => f.question.type !== "instruction" && f.question.type !== "content").length;
