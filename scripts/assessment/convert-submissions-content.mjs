// Converts the assessment content that Submissions hardcodes in SOURCE (never its database) into Skyline's assessment import
// format (Master Data › Assessments › New assessment › "From a JSON export"). Read-only on the Submissions checkout; no network.
//
//   node scripts/assessment/convert-submissions-content.mjs [path-to-Submissions] [output-dir]
//
// Sources (docs/assessment-integration/AUDIT.md, module S-B2 "Actual assessment content embedded in source"):
//   src/lib/defaultFormSteps.ts      the 15 policy sections, Reasonable Adjustment and the Student declaration
//   src/lib/appendixAMatrixData.ts   Appendix A: the Reasonable Adjustment strategies matrix (assessor only)
//   src/data/formDefinition.json     the legacy Learner Evaluation form (details, three Likert sets, comments, declarations)
// Unit-specific question banks live only in Submissions' live database and are NOT converted (brief 4.7: no live access).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SUBMISSIONS = path.resolve(process.argv[2] ?? "C:/Users/goura/Desktop/Submissions");
const OUT = path.resolve(process.argv[3] ?? "docs/assessment-integration/imports");
const read = (rel) => readFileSync(path.join(SUBMISSIONS, rel), "utf8");

let counter = 0;
const id = (prefix) => `${prefix}_${(++counter).toString(36).padStart(3, "0")}`;
const text = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** Evaluates a TS array literal after stripping the type annotations the files use (no imports are executed). */
function evalArray(source, constName, extraConsts = "") {
  const start = source.indexOf(`const ${constName}`);
  if (start < 0) throw new Error(`${constName} not found`);
  const tail = source.slice(start);
  const end = tail.search(/\n\];/);
  if (end < 0) throw new Error(`${constName}: closing ]; not found`);
  const block = tail.slice(0, end + 3).replace(/^const\s+\w+\s*:[\s\S]*?=\s*\[/, `const ${constName} = [`).replace(/:\s*StepDef\[\]/, "");
  return vm.runInNewContext(`${extraConsts}\n${block}\n${constName};`, {}, { timeout: 1000 });
}

// ------------------------------------------------------------------ 1. Student Pack: policies, Reasonable Adjustment, declaration
const stepsSrc = read("src/lib/defaultFormSteps.ts");
const consts = stepsSrc.split("\n").filter((l) => /^const (READ_ONLY_VISIBLE|TRAINER_ONLY_EDIT|STUDENT_ONLY|DEFAULT_ROLES|READ_ONLY_EDIT|TRAINER_OFFICE_VISIBLE|TRAINER_OFFICE_EDIT|ALL_CAN_EDIT) =/.test(l)).join("\n");
const steps = evalArray(stepsSrc, "DEFAULT_STEPS_5_TO_20", consts);

function mapQuestion(q, roleHint) {
  const base = { id: id("q"), label: text(q.label), helpText: q.help_text && q.type !== "instruction_block" ? text(q.help_text) : undefined, required: Boolean(q.required) };
  const assessorOnly = roleHint === "trainer";
  switch (q.type) {
    case "instruction_block": return { id: base.id, type: "instruction", label: base.label, markingMode: "none", config: { html: text(q.help_text ?? q.label), attachments: [] } };
    case "yes_no": return { ...base, type: "single_choice", assessorOnly, markingMode: "none", config: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], allowOther: false, layout: "list" }, responseSchema: { type: "string", enum: ["yes", "no"] } };
    case "short_text": return { ...base, type: "short_answer", assessorOnly, markingMode: "none", config: { minWords: null, maxWords: 100, placeholder: "" }, responseSchema: { type: "string", maxWords: 100 } };
    case "long_text": return { ...base, type: "long_answer", assessorOnly, markingMode: "none", config: { minWords: null, maxWords: null, richText: true }, responseSchema: { type: "string" } };
    case "signature": return { ...base, type: "declaration", assessorOnly, markingMode: "none", config: { text: text(q.help_text) }, responseSchema: { type: "object", requiredKeys: ["agreed", "signature"] } };
    default: return { ...base, type: "short_answer", assessorOnly, markingMode: "none", config: {}, responseSchema: { type: "string" } };
  }
}
const policySections = steps.map((step) => ({
  id: id("s"), title: text(step.title),
  description: step.sections[0]?.description ? text(step.sections[0].description) : undefined,
  questions: step.sections.flatMap((sec) => sec.questions.map((q) => mapQuestion(q, q.role_editability?.trainer && !q.role_editability?.student ? "trainer" : "student"))),
}));
const studentPack = {
  format: "skyline-assessment/1", exportedAt: new Date().toISOString(), source: "Submissions src/lib/defaultFormSteps.ts (DEFAULT_STEPS_5_TO_20)",
  title: "Student Pack: information, policies and declaration", code: "SUBMISSIONS-PACK", description: "The policy sections, the Reasonable Adjustment record and the student declaration every Submissions Student Pack carried. Use it as a template task in front of the unit's own tasks.",
  definition: { instructions: "Read each section. Where a section asks you a question, answer it before you continue.", tasks: [{ id: id("t"), title: "Student Pack information", instructions: "", sections: policySections }] },
  keys: [], mappings: [],
};

// ------------------------------------------------------------------ 2. Appendix A: Reasonable Adjustment strategies matrix (assessor only)
const matrixSrc = read("src/lib/appendixAMatrixData.ts");
const table1 = evalArray(matrixSrc.replace(/export const/g, "const"), "APPENDIX_A_TABLE1");
const table2 = evalArray(matrixSrc.replace(/export const/g, "const"), "APPENDIX_A_TABLE2");
const matrixQuestions = [...table1, ...table2].map((row) => ({
  id: id("q"), type: "observation_checklist", assessorOnly: true, required: false, markingMode: "observation",
  label: `${text(row.category?.label ?? row.area?.label ?? row.label ?? "Category")}: reasonable adjustment`,
  helpText: "Tick the issues identified and the strategies applied.",
  config: { items: [...(row.issues ?? []).map((i) => ({ id: i.id, text: `Issue: ${i.label}` })), ...(row.strategies ?? []).map((s) => ({ id: s.id, text: `Strategy: ${s.label}` }))], allowNotes: true },
  responseSchema: { type: "object" },
}));
const appendixA = {
  format: "skyline-assessment/1", exportedAt: new Date().toISOString(), source: "Submissions src/lib/appendixAMatrixData.ts (APPENDIX_A_TABLE1/2)",
  title: "Appendix A: Reasonable adjustment strategies and declaration", code: "SUBMISSIONS-APPENDIX-A", description: "The assessor's record of reasonable adjustment: the issues identified, the strategies applied and the trainer declaration. Assessor-only; students never see it.",
  definition: { instructions: "", tasks: [{ id: id("t"), title: "Reasonable adjustment record", instructions: "Completed by the trainer / assessor when a reasonable adjustment applies.", sections: [
    { id: id("s"), title: "Adjustment applied", questions: [
      { id: id("q"), type: "single_choice", assessorOnly: true, required: true, markingMode: "none", label: "Was a reasonable adjustment applied to this assessment?", config: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], allowOther: false, layout: "list" }, responseSchema: { type: "string", enum: ["yes", "no"] } },
      { id: id("q"), type: "long_answer", assessorOnly: true, required: false, markingMode: "none", label: "Describe the adjustment and the task(s) it applied to", config: { richText: true }, responseSchema: { type: "string" } },
    ] },
    { id: id("s"), title: "Strategies matrix", questions: matrixQuestions },
    { id: id("s"), title: "Trainer / assessor declaration", questions: [
      { id: id("q"), type: "declaration", assessorOnly: true, required: false, markingMode: "none", label: "Trainer / assessor declaration", config: { text: "I declare that I have attached all relevant evidence to provide reasonable adjustment to the student and that the adjustment maintains the integrity of the assessment." }, responseSchema: { type: "object", requiredKeys: ["agreed", "signature"] } },
    ] },
  ] }] },
  keys: [], mappings: [],
};

// ------------------------------------------------------------------ 3. Learner Evaluation (legacy Training Evaluation Form JSON)
const legacy = JSON.parse(read("src/data/formDefinition.json"));
const evalSections = [];
for (const page of legacy.pages ?? []) {
  for (const sec of page.sections ?? []) {
    const section = { id: id("s"), title: text(sec.title ?? sec.label ?? ""), questions: [] };
    const assessorOnly = sec.fields?.every((f) => f.roleScope === "office") || /office use/i.test(sec.title ?? "");
    if (sec.type === "detailsTable") for (const f of sec.fields ?? []) section.questions.push({ id: id("q"), type: f.type === "date" ? "date" : "short_answer", assessorOnly: f.roleScope === "office" || f.roleScope === "trainer", required: f.roleScope === "student", markingMode: "none", label: text(f.label), config: {}, responseSchema: f.type === "date" ? { type: "string", format: "date" } : { type: "string" } });
    else if (sec.type === "likertMatrix") for (const q of sec.questions ?? []) section.questions.push({ id: id("q"), type: "likert", required: false, markingMode: "none", label: text(q.question), config: { min: 1, max: (sec.scaleLabels ?? []).length || 5, labels: sec.scaleLabels ?? [] }, responseSchema: { type: "integer", minimum: 1, maximum: (sec.scaleLabels ?? []).length || 5 } });
    else if (sec.type === "textarea") section.questions.push({ id: id("q"), type: "long_answer", required: false, markingMode: "none", label: text(sec.label), config: { richText: false }, responseSchema: { type: "string" } });
    else if (sec.type === "checkboxGroup") section.questions.push({ id: id("q"), type: "multi_choice", required: true, markingMode: "none", label: text(sec.title), config: { options: (sec.options ?? []).map((o) => ({ id: o.fieldId, label: text(o.label) })), allowOther: false, minSelected: (sec.options ?? []).length }, responseSchema: { type: "array", items: { type: "string", enum: (sec.options ?? []).map((o) => o.fieldId) }, minItems: (sec.options ?? []).length, uniqueItems: true } });
    else if (sec.type === "signatureBlock") section.questions.push({ id: id("q"), type: "declaration", assessorOnly: sec.roleScope === "trainer" || sec.roleScope === "office", required: sec.roleScope === "student", markingMode: "none", label: text(sec.label), config: { text: "" }, responseSchema: { type: "object", requiredKeys: ["agreed", "signature"] } });
    if (assessorOnly) section.questions.forEach((q) => { q.assessorOnly = true; });
    if (section.questions.length) evalSections.push(section);
  }
}
const learnerEvaluation = {
  format: "skyline-assessment/1", exportedAt: new Date().toISOString(), source: "Submissions src/data/formDefinition.json (legacy Training Evaluation Form)",
  title: "Learner evaluation (training evaluation and feedback)", code: "SUBMISSIONS-EVALUATION", description: "The learner evaluation that followed every Student Pack: participant information, the Logistics / Trainer / Learning rating scales, comments and declarations. Not marked.",
  definition: { instructions: legacy.meta?.title ? `${legacy.meta.title}` : "", tasks: [{ id: id("t"), title: "Learner evaluation", instructions: "Your feedback is not assessed; it helps improve the training.", sections: evalSections }] },
  keys: [], mappings: [],
};

mkdirSync(OUT, { recursive: true });
const files = [["submissions-student-pack-policies.json", studentPack], ["submissions-appendix-a-reasonable-adjustment.json", appendixA], ["submissions-learner-evaluation.json", learnerEvaluation]];
for (const [name, value] of files) {
  const forbidden = JSON.stringify(value.definition).match(/"(key|answerKey|modelAnswer|assessorGuidance|assessorNotes|rubricAssessor)"\s*:/);
  if (forbidden) throw new Error(`${name}: assessor-only key ${forbidden[1]} inside the definition`);
  writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + "\n");
  const n = value.definition.tasks.flatMap((t) => t.sections.flatMap((s) => s.questions)).length;
  console.log(`${name}: ${value.definition.tasks.length} task, ${value.definition.tasks[0].sections.length} sections, ${n} questions`);
}
