/**
 * Assessment Management: the question-type registry and the client-side mirrors of the database's validation and conditions.
 * Pure logic, no network. Run: npm run test:assessment-registry
 *
 * The fixture is the same definition the pgTAP suite (supabase/tests/assessment_management.sql) submits, so a rule that passes
 * here and there is the same rule on both sides of the wire.
 */
import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-assessment-registry"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import { conditionMet } from "../src/lib/assessment/conditions";
import { cloneQuestion, countQuestions, earlierQuestionIds, flattenQuestions, moveItem, removeQuestion, updateQuestion } from "../src/lib/assessment/definition";
import { attachmentCapable, attachmentSettings, newQuestion, QUESTION_TYPES, questionType, withSchema } from "../src/lib/assessment/registry";
import type { Definition, Question, Responses, ResultRow, Section, Task } from "../src/lib/assessment/types";
import { buildResultsSheet, historyFromAttempts, type AttemptHistory } from "../src/lib/assessment/resultsSheet";
import { buildWorkbookPdf, questionOutcome } from "../src/lib/assessment/workbookPdf";
import { forbiddenKey, schemaCheck, validateDefinition, validateResponses } from "../src/lib/assessment/validate";
import { buildFromLines, definitionText, imageRegionsFromPdf, linesFromDocxHtml, linesFromPdf, type PdfDocLike, type PdfOps } from "../src/lib/assessment/workbookImport";
import { autoTitle, decideFiling, filingCourseId, needsUnitStep } from "../src/lib/assessment/workbookFiling";
import { htmlToBlocks, workbookNumbering } from "../src/lib/assessment/workbookLayout";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let passed = 0; let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`ok - ${name}`); } else { failed += 1; console.log(`NOT OK - ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}

const definition: Definition = {
  instructions: "Read everything first.",
  tasks: [
    { id: "t1", title: "Knowledge questions", sections: [{ id: "s1", title: "Part A", questions: [
      { id: "q_intro", type: "instruction", label: "Welcome", markingMode: "none" },
      { id: "q_short", type: "short_answer", label: "Describe PPE", required: true, markingMode: "criteria", responseSchema: { type: "string", minWords: 2, maxWords: 50 }, criteria: [{ id: "c1", text: "Names two items" }] },
      { id: "q_single", type: "single_choice", label: "Pick one", required: true, markingMode: "auto", config: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, responseSchema: { type: "string", enum: ["a", "b"] } },
      { id: "q_cond", type: "short_answer", label: "Why A?", required: true, markingMode: "criteria", showIf: { questionId: "q_single", op: "eq", value: "a" }, responseSchema: { type: "string" } },
      { id: "q_multi", type: "multi_choice", label: "Pick many", required: true, markingMode: "auto", responseSchema: { type: "array", items: { type: "string", enum: ["x", "y", "z"] }, minItems: 1 } },
      { id: "q_tf", type: "true_false", label: "The sky is blue", required: true, markingMode: "auto", responseSchema: { type: "boolean" } },
      { id: "q_match", type: "matching", label: "Match", required: true, markingMode: "auto", responseSchema: { type: "object", requiredKeys: ["l1", "l2"] } },
      { id: "q_order", type: "ordering", label: "Order", required: true, markingMode: "auto", responseSchema: { type: "array", minItems: 3, maxItems: 3, uniqueItems: true } },
      { id: "q_num", type: "number", label: "How many", required: true, markingMode: "auto", responseSchema: { type: "number", minimum: 0, maximum: 100 } },
      { id: "q_date", type: "date", label: "When", required: true, markingMode: "criteria", responseSchema: { type: "string", format: "date" } },
      { id: "q_file", type: "file_upload", label: "Upload evidence", required: true, markingMode: "criteria", responseSchema: { type: "array", minFiles: 1, maxFiles: 3 } },
      { id: "q_url", type: "url", label: "Link", required: false, markingMode: "criteria", responseSchema: { type: "string", format: "url" } },
    ] }] },
    { id: "t2", title: "Practical", sections: [{ id: "s2", title: "Scenario", questions: [
      { id: "q_case", type: "case_study", label: "Case", markingMode: "criteria", children: [{ id: "q_case_a", type: "short_answer", label: "What first?", required: true, markingMode: "criteria", responseSchema: { type: "string" } }] },
      { id: "q_rep", type: "repeating_group", label: "Hazards", required: true, markingMode: "criteria", responseSchema: { type: "array", minItems: 1, maxItems: 5 }, children: [{ id: "q_rep_h", type: "short_answer", label: "Hazard", required: true, markingMode: "none", responseSchema: { type: "string" } }, { id: "q_rep_r", type: "number", label: "Risk", required: true, markingMode: "none", responseSchema: { type: "integer", minimum: 1, maximum: 5 } }] },
      { id: "q_obs", type: "observation_checklist", label: "Observed", required: true, markingMode: "observation", responseSchema: { type: "object", requiredKeys: ["o1", "o2"] }, config: { items: [{ id: "o1", text: "Wears PPE" }, { id: "o2", text: "Isolates power" }] } },
    ] }] },
  ],
};
const responses = { q_short: "Gloves and safety glasses protect hands and eyes", q_single: "a", q_cond: "Because A is safest", q_multi: ["x", "y"], q_tf: false, q_match: { l1: "r1", l2: "r2" }, q_order: ["1", "2", "3"], q_num: 7, q_date: "2026-11-20", q_file: ["f1"], q_url: "https://example.test/x", q_case: { q_case_a: "Call for help" }, q_rep: [{ q_rep_h: "Dust", q_rep_r: 3 }] };

// Registry
check("every required type of the brief is registered", ["instruction", "short_answer", "long_answer", "single_choice", "multi_choice", "true_false", "matching", "ordering", "fill_blanks", "table_grid", "likert", "number", "date", "file_upload", "url", "case_study", "repeating_group", "observation_checklist", "third_party_report", "declaration"].every((t) => questionType(t)));
check("auto-check is offered only to objective types", QUESTION_TYPES.filter((t) => t.markingModes.includes("auto")).every((t) => ["single_choice", "multi_choice", "true_false", "matching", "ordering", "fill_blanks", "number", "date"].includes(t.id)));
check("assessor-only types never default to student marking (observation, or none for a record)", QUESTION_TYPES.filter((t) => t.assessorOnly).every((t) => t.defaultMarkingMode === "observation" || t.defaultMarkingMode === "none"));
const sc = newQuestion("single_choice");
check("a new single choice writes an enum schema from its options", JSON.stringify(sc.responseSchema?.enum) === JSON.stringify(["a", "b"]));
const sc2 = withSchema({ ...sc, config: { ...sc.config, options: [{ id: "x", label: "X" }], allowOther: true } });
check("allowing Other drops the enum", sc2.responseSchema?.enum === undefined && sc2.responseSchema?.type === "string");
const fb = withSchema({ ...newQuestion("fill_blanks"), config: { text: "a [blank] b [blank] c [blank]" } });
check("fill in the blanks counts its blanks", fb.responseSchema?.minItems === 3 && fb.responseSchema?.maxItems === 3);
const rg = newQuestion("repeating_group");
check("a repeating group starts with an empty children list", Array.isArray(rg.children) && rg.children.length === 0);
check("an instruction has no response schema", newQuestion("instruction").responseSchema === undefined);

// Conditions (mirror of asm_condition_met)
check("eq", conditionMet({ questionId: "q_single", op: "eq", value: "a" }, responses));
check("neq", conditionMet({ questionId: "q_single", op: "neq", value: "b" }, responses));
check("in", conditionMet({ questionId: "q_single", op: "in", value: ["a", "z"] }, responses));
check("notIn on a missing answer is true", conditionMet({ questionId: "nope", op: "notIn", value: ["a"] }, responses));
check("contains on an array", conditionMet({ questionId: "q_multi", op: "contains", value: "y" }, responses));
check("gt / lte on numbers", conditionMet({ questionId: "q_num", op: "gt", value: 5 }, responses) && conditionMet({ questionId: "q_num", op: "lte", value: 7 }, responses));
check("empty / notEmpty", conditionMet({ questionId: "nope", op: "empty" }, responses) && conditionMet({ questionId: "q_short", op: "notEmpty" }, responses));
check("all / any groups", conditionMet({ all: [{ questionId: "q_single", op: "eq", value: "a" }, { questionId: "q_tf", op: "eq", value: false }] }, responses) && conditionMet({ any: [{ questionId: "q_single", op: "eq", value: "b" }, { questionId: "q_tf", op: "eq", value: false }] }, responses));
check("no condition is always true", conditionMet(undefined, responses));

// Schema checks (mirror of asm_schema_check)
check("minWords", schemaCheck({ type: "string", minWords: 2 }, "one") === "minWords");
check("maxWords passes at the limit", schemaCheck({ type: "string", maxWords: 2 }, "one two") === null);
check("enum", schemaCheck({ type: "string", enum: ["a", "b"] }, "c") === "enum");
check("array items enum", schemaCheck({ type: "array", items: { type: "string", enum: ["x"] } }, ["x", "q"]) === "items");
check("uniqueItems", schemaCheck({ type: "array", uniqueItems: true }, ["1", "1"]) === "uniqueItems");
check("minimum / maximum", schemaCheck({ type: "number", minimum: 0, maximum: 100 }, 500) === "maximum" && schemaCheck({ type: "number", minimum: 0 }, -1) === "minimum");
check("integer", schemaCheck({ type: "integer" }, 1.5) === "type" && schemaCheck({ type: "integer" }, 2) === null);
check("date format", schemaCheck({ type: "string", format: "date" }, "20-11-2026") === "format" && schemaCheck({ type: "string", format: "date" }, "2026-11-20") === null);
check("url format", schemaCheck({ type: "string", format: "url" }, "example.test") === "format" && schemaCheck({ type: "string", format: "url" }, "https://example.test/x") === null);
check("requiredKeys", schemaCheck({ type: "object", requiredKeys: ["l1", "l2"] }, { l1: "r1" }) === "requiredKeys");
check("minFiles", schemaCheck({ type: "array", minFiles: 1 }, []) === "minFiles");
check("null passes (required is checked separately)", schemaCheck({ type: "string", minWords: 5 }, null) === null);

// Response validation (mirror of asm_validate_responses)
check("the full fixture validates clean for the student", validateResponses(definition, responses, "student").length === 0, validateResponses(definition, responses, "student"));
const e1 = validateResponses(definition, { ...responses, q_short: undefined, q_num: 500 }, "student");
check("a missing required answer and an out-of-range number are both named", e1.some((e) => e.questionId === "q_short" && e.code === "required") && e1.some((e) => e.questionId === "q_num" && e.code === "maximum"), e1);
check("conditional: the follow-up is required when A was chosen", validateResponses(definition, { ...responses, q_cond: undefined }, "student").some((e) => e.questionId === "q_cond"));
check("conditional: choosing B hides the follow-up", validateResponses(definition, { ...responses, q_single: "b", q_cond: undefined }, "student").length === 0);
check("nested: a case study child is validated with a dotted path", validateResponses(definition, { ...responses, q_case: {} }, "student").some((e) => e.questionId === "q_case.q_case_a"));
check("nested: a repeating group entry is validated with its index", validateResponses(definition, { ...responses, q_rep: [{ q_rep_h: "Dust", q_rep_r: 9 }] }, "student").some((e) => e.questionId === "q_rep[0].q_rep_r" && e.code === "maximum"));
check("an empty repeating group is refused when required", validateResponses(definition, { ...responses, q_rep: [] }, "student").some((e) => e.questionId === "q_rep"));
check("assessor-only questions are skipped for the student", !validateResponses(definition, responses, "student").some((e) => e.questionId === "q_obs"));
check("the assessor pass requires the observation checklist", validateResponses(definition, {}, "assessor").some((e) => e.questionId === "q_obs" && e.code === "required"));
check("the assessor pass accepts a complete checklist", validateResponses(definition, { q_obs: { o1: true, o2: false } }, "assessor").length === 0);

// Definition validation and the assessor-data guard (mirror of asm_validate_definition / asm_jsonb_forbidden_key)
check("the fixture definition is structurally valid", validateDefinition(definition).length === 0, validateDefinition(definition));
check("a model answer inside the definition is caught", forbiddenKey({ tasks: [{ id: "t", sections: [{ id: "s", questions: [{ id: "q", type: "short_answer", modelAnswer: "x" }] }] }] }) === "modelAnswer");
check("duplicate ids are caught", validateDefinition({ tasks: [{ id: "t", title: "", sections: [{ id: "s", title: "", questions: [{ id: "q", type: "short_answer", label: "" }, { id: "q", type: "number", label: "" }] }] }] }).some((e) => e.code === "duplicate_id"));
check("an unknown marking mode is caught", validateDefinition({ tasks: [{ id: "t", title: "", sections: [{ id: "s", title: "", questions: [{ id: "q", type: "short_answer", label: "", markingMode: "magic" as Question["markingMode"] }] }] }] }).some((e) => e.code === "marking_mode"));

// Definition helpers
check("flatten sees every question including children", flattenQuestions(definition).length === 18);
check("numbering skips instructions and letters children", flattenQuestions(definition).find((f) => f.question.id === "q_short")?.number === "1.1" && flattenQuestions(definition).find((f) => f.question.id === "q_case_a")?.number === "2.1a");
check("countQuestions excludes content", countQuestions(definition) === 17);
check("earlier questions only are condition candidates", earlierQuestionIds(definition, "q_cond").map((c) => c.id).join(",") === "q_short,q_single");
const renamed = updateQuestion(definition, "q_case_a", (q) => ({ ...q, label: "Renamed" }));
check("updateQuestion reaches children and keeps ids", flattenQuestions(renamed).find((f) => f.question.id === "q_case_a")?.question.label === "Renamed");
check("removeQuestion removes a child", flattenQuestions(removeQuestion(definition, "q_rep_r")).length === 17);
const copy = cloneQuestion(definition.tasks[1].sections[0].questions[1]);
check("cloneQuestion gives every nested question a fresh id", copy.id !== "q_rep" && copy.children?.every((c) => !["q_rep_h", "q_rep_r"].includes(c.id)) === true);
check("moveItem reorders", moveItem([1, 2, 3], 0, 2).join("") === "231" && moveItem([1, 2, 3], 5, 0).join("") === "123");

// ASM-IMPORT: an attachment on any answerable question
check("every answerable type except file_upload, containers, assessor records and the declaration can take an attachment", QUESTION_TYPES.filter((t) => attachmentCapable(t.id)).map((t) => t.id).sort().join(",") === "date,fill_blanks,likert,long_answer,matching,multi_choice,number,ordering,short_answer,single_choice,table_grid,true_false,url");
check("a new question starts with attachments off", newQuestion("short_answer").config?.allowAttachment === false && attachmentSettings(newQuestion("short_answer")) === null);
const withAttach: Question = withSchema({ ...newQuestion("short_answer"), id: "q_att", config: { ...newQuestion("short_answer").config, allowAttachment: true, attachmentMaxFiles: 2, attachmentAccept: ["image/png"] } });
check("allowAttachment gives the box its limits and leaves the answer's schema alone", JSON.stringify(attachmentSettings(withAttach)) === JSON.stringify({ maxFiles: 2, maxMb: 25, accept: ["image/png"] }) && withAttach.responseSchema?.type === "string");
check("file_upload stays the upload-only type (no attachment box)", attachmentSettings({ ...newQuestion("file_upload"), config: { allowAttachment: true } }) === null);
const attachDef: Definition = { tasks: [{ id: "t", title: "T", sections: [{ id: "s", title: "S", questions: [withAttach] }] }] };
check("an answer with an attachment validates (the files are evidence rows, the answer is the text)", validateResponses(attachDef, { q_att: "See the attached photo" }, "student").length === 0);
check("an attachment does not replace a required answer", validateResponses(attachDef, {}, "student").some((e) => e.questionId === "q_att" && e.code === "required"));

// ASM-REVIEW: an edited text block (rich text, never shown as HTML) prints as headings, paragraphs, lists, tables and pictures
{
  const blocks = htmlToBlocks(`<h4>Submission</h4><p>Upload <strong>all</strong> files &amp; photos.</p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><figure><img src="data:image/jpeg;base64,AAA" alt=""></figure><p>End</p>`);
  check("review: htmlToBlocks keeps the order and kinds of an edited block", JSON.stringify(blocks.map((b) => b.kind)) === JSON.stringify(["heading", "para", "item", "item", "item", "table", "image", "para"]) && blocks[1].kind === "para" && blocks[1].text === "Upload all files & photos." && blocks[4].kind === "item" && blocks[4].marker === "1." && blocks[5].kind === "table" && blocks[5].head && blocks[5].rows[1].join() === "1,2", blocks);
  check("review: plain text (no tags) prints one paragraph per line", htmlToBlocks("Line one\nLine two").length === 2);
}

// ASM-WIZARD-SKIP: the Qualification & unit step is skipped when the page already chose the unit the assessment goes to
{
  const page = { courseId: "c-cpc", unitId: "u-cm2008", unitCode: "CPCCCM2008" };
  const courses = [{ id: "c-cpc", code: "CPC30620" }, { id: "c-rii", code: "RII50520" }];
  const same = decideFiling({ workbook: { qualificationCode: "CPC30620", unitCode: "CPCCCM2008" }, page, courses, unitsOfCourse: [{ id: "u-cm2008", code: "CPCCCM2008" }] });
  check("unit step: workbook unit = page unit -> skipped", !needsUnitStep({ page, decision: same, changeRequested: false }), same);
  const other = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page, courses, unitsOfCourse: [{ id: "u-525", code: "RIICWD525E" }] });
  check("unit step: workbook unit RIICWD525E vs page CPCCCM2008 -> shown, with the mismatch warning", other.mismatch && needsUnitStep({ page, decision: other, changeRequested: false }), other);
  const missing = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page, courses: [courses[0]], unitsOfCourse: [{ id: "u-cm2008", code: "CPCCCM2008" }] });
  check("unit step: a workbook unit Skyline does not have -> shown", needsUnitStep({ page, decision: missing, changeRequested: false }));
  const sameUnitOtherCourse = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "CPCCCM2008" }, page, courses, unitsOfCourse: [{ id: "u-cm2008-rii", code: "CPCCCM2008" }] });
  check("unit step: the same unit code but filed under another course -> shown", needsUnitStep({ page, decision: sameUnitOtherCourse, changeRequested: false }), sameUnitOtherCourse);
  // ASM-REVIEW bug 5: the RIICWD525E workbook uploaded while CPCCPD2012 is selected: a mismatch whether or not Skyline has RII50520
  const pd = { courseId: "c-cpc", unitId: "u-pd2012", unitCode: "CPCCPD2012" };
  const withRii = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page: pd, courses, unitsOfCourse: [{ id: "u-525", code: "RIICWD525E" }] });
  const noRii = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page: pd, courses: [courses[0]], unitsOfCourse: [{ id: "u-pd2012", code: "CPCCPD2012" }] });
  const riiNoUnit = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page: pd, courses, unitsOfCourse: [{ id: "u-526", code: "RIICWD526E" }] });
  check("mismatch: RIICWD525E workbook on the CPCCPD2012 page -> warned in every case (course + unit in Skyline, course missing, unit missing)", [withRii, noRii, riiNoUnit].every((d) => d.mismatch && needsUnitStep({ page: pd, decision: d, changeRequested: false })), [withRii, noRii, riiNoUnit]);
  check("unit step: manual create with the page's unit -> skipped", !needsUnitStep({ page, decision: null, changeRequested: false }));
  check("unit step: Change pressed -> shown", needsUnitStep({ page, decision: same, changeRequested: true }));
  check("unit step: the page has no unit selected -> shown", needsUnitStep({ page: { courseId: "c-cpc", unitId: "" }, decision: null, changeRequested: false }));
  const unit = { code: "CPCCCM2008", name: "Erect and dismantle restricted height scaffolding" };
  check("title: manual create -> \"<unit code> — <unit name>\"", autoTitle(null, unit) === "CPCCCM2008 — Erect and dismantle restricted height scaffolding", autoTitle(null, unit));
  check("title: workbook -> the cover's title, else the unit", autoTitle("  Select Pavement surfacing ", unit) === "Select Pavement surfacing" && autoTitle("", unit) === "CPCCCM2008 — Erect and dismantle restricted height scaffolding");
}

// ASM-IMPORT: the RIICWD525E workbook (PDF). The file is not in the repo: ASM_WORKBOOK=<path>, else the repo root or Downloads.
const workbookPath = [process.env.ASM_WORKBOOK, "DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf", `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf`].find((p) => p && existsSync(p));
if (!workbookPath) console.log("SKIP - RIICWD525E workbook parser (file not found; set ASM_WORKBOOK)");
else {
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
  const { lines, version } = await linesFromPdf(doc as unknown as PdfDocLike);
  // ASM-WORKBOOK: the pictures as the browser finds them (the JPEG itself is drawn in the browser; a stand-in here)
  const regions = await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps);
  const wb = buildFromLines(lines, { fileName: "RIICWD525E.pdf", version, images: regions.map((r) => ({ ...r, src: `data:image/jpeg;base64,UElD${r.page}` })) });
  const [t1, t2] = wb.definition.tasks;
  const top = (t: Task) => t.sections.flatMap((s) => s.questions).filter((q) => q.type !== "instruction");
  const all = flattenQuestions(wb.definition).map((f) => f.question);
  console.log(`  workbook: ${JSON.stringify(wb.stats)}`);
  check("workbook: title and unit from the cover", wb.unitCode === "RIICWD525E" && /Select Pavement surfacing/i.test(wb.title), wb.title);
  check("workbook: qualification and unit, code and name, from its details table", JSON.stringify(wb.qualification) === JSON.stringify({ code: "RII50520", name: "Diploma of Civil Construction Design" }) && JSON.stringify(wb.unit) === JSON.stringify({ code: "RIICWD525E", name: "Select Pavement surfacing" }), [wb.qualification, wb.unit]);
  // where it is filed when the page has another unit selected (CPCCCM2008 on CPC30220) and Skyline has RII50520 > RIICWD525E
  const courses = [{ id: "c-cpc", code: "CPC30220" }, { id: "c-rii", code: "RII50520" }];
  const page = { courseId: "c-cpc", unitId: "u-cm2008", unitCode: "CPCCCM2008" };
  const wbCodes = { qualificationCode: wb.qualification?.code ?? null, unitCode: wb.unit?.code ?? null };
  check("filing: the workbook's qualification decides which course's units are loaded", filingCourseId({ workbook: wbCodes, page, courses }) === "c-rii");
  const d1 = decideFiling({ workbook: wbCodes, page, courses, unitsOfCourse: [{ id: "u-525", code: "RIICWD525E" }, { id: "u-526", code: "RIICWD526E" }] });
  check("filing: page unit CPCCCM2008 vs workbook RIICWD525E -> warning, defaults to the workbook's course and unit", d1.mismatch && d1.source === "workbook" && d1.courseId === "c-rii" && d1.unitId === "u-525" && /RIICWD525E, not CPCCCM2008/.test(d1.message), d1);
  check("unit step: the RIICWD525E workbook on the CPCCCM2008 page -> the step is shown", needsUnitStep({ page, decision: d1, changeRequested: false }));
  const cpcOnly = [{ id: "c-cpc", code: "CPC30220" }];
  const d2 = decideFiling({ workbook: { qualificationCode: "RII50520", unitCode: "RIICWD525E" }, page, courses: cpcOnly, unitsOfCourse: [{ id: "u-cm2008", code: "CPCCCM2008" }] });
  check("filing: a qualification / unit Skyline does not have -> said so, nothing pre-selected (never the page's unit)", d2.source === "pick" && d2.courseMissing && d2.unitMissing && d2.unitId === "" && d2.courseId === "" && /not in Skyline/.test(d2.message), d2);
  const d3 = decideFiling({ workbook: { qualificationCode: "CPC30220", unitCode: "CPCCCM2008" }, page, courses: cpcOnly, unitsOfCourse: [{ id: "u-cm2008", code: "cpcccm2008" }] });
  check("filing: the same unit as the page (codes compared without case) -> no warning", !d3.mismatch && d3.source === "workbook" && d3.unitId === "u-cm2008", d3);
  const d4 = decideFiling({ workbook: { qualificationCode: null, unitCode: null }, page, courses: cpcOnly, unitsOfCourse: [] });
  check("filing: a workbook that names no unit -> the page's unit, with a visible note to check it", d4.source === "page" && d4.unitId === "u-cm2008" && /does not name its unit/.test(d4.message), d4);
  check("workbook: two tasks (written assessment, project with role-play)", wb.definition.tasks.length === 2 && /written/i.test(t1.title) && /project/i.test(t2.title) && /role-play\)$/.test(t2.title), wb.definition.tasks.map((t) => t.title));
  check("workbook: task 1 has the six written questions (Q1.1-Q1.5 + references), all long answers or parts", top(t1).filter((q) => ["long_answer", "case_study"].includes(q.type)).length === 6, top(t1).map((q) => q.type));
  check("workbook: Q1.2 keeps its sixteen parts a-p", top(t1)[1]?.type === "case_study" && top(t1)[1].children?.length === 16);
  const s21 = t2.sections.find((s) => s.title.startsWith("2.1")); const s22 = t2.sections.find((s) => s.title.startsWith("2.2"));
  check("workbook: task 2 has its sub-tasks 2.1 (Occasion 1) and 2.2 (Occasion 2) as sections", Boolean(s21 && s22) && /Occasion 1/.test(s21!.title) && /Occasion 2/.test(s22!.title), t2.sections.map((s) => s.title));
  const answerable = (s: Section | undefined) => (s?.questions ?? []).filter((q) => !["instruction", "observation_checklist", "file_upload"].includes(q.type)).length;
  check("workbook: 11 questions in 2.1 (Q2.1.1-Q2.1.11) and 11 in 2.2 (Q2.2.1-Q2.2.10 + references)", answerable(s21) === 11 && answerable(s22) === 11, [answerable(s21), answerable(s22)]);
  check("workbook: the role-play gives an assessor observation checklist in 2.1", (s21?.questions ?? []).some((q) => q.type === "observation_checklist" && q.assessorOnly === true && (q.config?.items as unknown[]).length >= 3));
  check("workbook: at least one question takes attachments", all.some((q) => q.config?.allowAttachment === true));
  // ASM-WORKBOOK item 5: every evidence item of the project takes files; the written task (task 1) gets none by guessing
  const attachedIn = (q: Question): boolean => q.config?.allowAttachment === true || (q.children ?? []).some(attachedIn);
  const evidenceItems = [s21, s22].flatMap((s) => s?.questions ?? []).filter((q) => ["case_study", "table_grid", "long_answer"].includes(q.type) && !/^references/i.test(q.label));
  check("workbook: every Task 2 evidence item (2.1 and 2.2) takes an upload", evidenceItems.length >= 20 && evidenceItems.every(attachedIn), evidenceItems.filter((q) => !attachedIn(q)).map((q) => q.label));
  check("workbook: Task 1 written questions take no attachments (no guessing); its supporting-evidence upload stays", !top(t1).some((q) => q.type !== "file_upload" && attachedIn(q)) && top(t1).some((q) => q.type === "file_upload"));
  check("workbook: Q2.2.10 \"Upload … Screenshot\" still takes its upload on the box that asks", all.some((q) => q.config?.allowAttachment === true && /upload/i.test(q.label)));
  const htmlOf = (s: Section | undefined) => (s?.questions ?? []).filter((q) => q.type === "instruction").map((q) => String(q.config?.html ?? "")).join("");
  const cut = (s: string, open: string, close: string) => s.split(open).slice(1).map((x) => x.split(close)[0]);
  const rowsOf = (html: string, header: string[]) => { const head = header.map((h) => `<th>${h}</th>`).join(""); const t = cut(html, "<table>", "</table>").find((x) => x.includes(head)); return t ? cut(t, "<tr>", "</tr>").slice(1).map((r) => cut(r, "<td>", "</td>")) : []; };
  const ev21 = rowsOf(htmlOf(s21), ["Task", "Instructions", "Evidence to submit"]); const ev22 = rowsOf(htmlOf(s22), ["Task", "Instructions", "Evidence to submit"]);
  check("workbook: the 2.1 Task / Instructions / Evidence to submit table is a real table, rows across pages, wrapped cells joined", ev21.length >= 8 && ev21[0][0] === "Interpret Work Requirements" && ev21[0][2] === "Work Requirement Clarification Record" && /^Review the project plan, drawings, and design brief to clarify scope/.test(ev21[0][1]) && ev21.some((r) => r[2] === "Completed Risk Assessment Worksheet"), ev21.map((r) => r[0]));
  check("workbook: the 2.2 evidence table is kept too", ev22.length >= 8 && ev22[0][2] === "Work Requirement Clarification Record", ev22.map((r) => r[0]));
  const team = rowsOf(htmlOf(s21), ["Team Member", "Role", "Responsibilities"]);
  check("workbook: the project plan's Team Member table continues over the page (repeated header not a row)", team.length === 5 && team[0][0] === "Candidate (You)" && team[4][0] === "Local Council" && !team.some((r) => r[0] === "Team Member"), team.map((r) => r[0]));
  check("workbook: pictures: the two drawings (pages 44 and 75) are found, the header logo and banner on every page are not", regions.length === 2 && regions[0].page === 44 && regions[1].page === 75, regions);
  check("workbook: each drawing sits in its part's instructions where it is in the PDF (2.1 before \"5. Relevant Plans\", 2.2 in the design brief)", /<figure><img src="data:image\/jpeg;base64,UElD44"[^>]*><\/figure><p>5\. Relevant Plans/.test(htmlOf(s21)) && htmlOf(s22).includes("base64,UElD75") && wb.stats.images === 2 && !wb.warnings.some((w) => /picture/.test(w)), wb.warnings);
  check("workbook: version and source (qualification, unit, version) are kept on the definition for the PDF export", wb.version === "1.0" && wb.definition.source?.version === "1.0" && wb.definition.source?.unit?.code === "RIICWD525E" && wb.definition.source?.qualification?.code === "RII50520", wb.definition.source);

  // ASM-WORKBOOK item 6: the results sheet of the RIICWD525E assessment: attempt 1 Not Satisfactory on task 2, attempt 2 Satisfactory,
  // attempt 3 being marked; one row per task, three attempts, dates / assessor / feedback from the decided attempts only
  const [task1, task2] = wb.definition.tasks;
  const hist: AttemptHistory = {
    student: { id: "5f0c1a2b-0000-4000-8000-000000000001", ref: "5F0C1A2B", name: "Zara Test", email: "zara.test@example.com" },
    trainers: ["Alex Assessor"], complete: true,
    assessment: { title: "RIICWD525E Select Pavement surfacing", versionNo: 1, unit: { code: "RIICWD525E", name: "Select Pavement surfacing" }, qualification: { code: "RII50520", name: "Diploma of Civil Construction Design" } },
    attempts: [
      { id: "a1", attemptNo: 1, state: "final", submittedAt: "2026-11-02T01:00:00Z", returnedAt: "2026-11-05T02:00:00Z", finalisedAt: null, outcome: "NYS", overallFeedback: "Redo the cost estimate.", assessor: "Alex Assessor",
        tasks: [{ taskId: task1.id, outcome: "S", feedback: "Good answers.", signedAt: "2026-11-05T01:00:00Z", assessor: "Alex Assessor" }, { taskId: task2.id, outcome: "NYS", feedback: "Cost estimate incomplete.", signedAt: "2026-11-05T01:00:00Z", assessor: "Alex Assessor" }] },
      { id: "a2", attemptNo: 2, state: "returned", submittedAt: "2026-11-10T01:00:00Z", returnedAt: "2026-11-12T03:00:00Z", finalisedAt: null, outcome: "S", overallFeedback: "Competent work.", assessor: "Sam Second",
        tasks: [{ taskId: task1.id, outcome: "S", feedback: "", signedAt: "2026-11-12T02:00:00Z", assessor: "Sam Second" }, { taskId: task2.id, outcome: "S", feedback: "Now complete.", signedAt: "2026-11-12T02:00:00Z", assessor: "Sam Second" }] },
      { id: "a3", attemptNo: 3, state: "marking", submittedAt: "2026-11-20T01:00:00Z", returnedAt: null, finalisedAt: null, outcome: null, overallFeedback: "", assessor: null,
        tasks: [{ taskId: task2.id, outcome: "S", feedback: "draft", signedAt: "2026-11-21T01:00:00Z", assessor: "Alex Assessor" }] },
    ],
  };
  const sheet = buildResultsSheet(wb.definition, hist, 3);
  const t2row = sheet.rows[1];
  check("results sheet: one row per task, three attempt columns", sheet.rows.length === 2 && sheet.attemptsShown === 3 && sheet.rows.every((r) => r.cells.length === 3) && sheet.rows[0].title === task1.title);
  check("results sheet: task 2 attempt 1 Not Satisfactory with its feedback, date (returned) and assessor; attempt 2 Satisfactory by the second assessor", t2row.cells[0].result === "NS" && t2row.cells[0].decided && t2row.cells[0].feedback === "Cost estimate incomplete." && t2row.cells[0].date === "2026-11-05T02:00:00Z" && t2row.cells[0].assessor === "Alex Assessor" && t2row.cells[1].result === "S" && t2row.cells[1].assessor === "Sam Second", t2row.cells);
  check("results sheet: an attempt still being marked is shown as not decided", !t2row.cells[2].decided && t2row.cells[2].result === "S" && sheet.rows[0].cells[2].result === null && !sheet.rows[0].cells[2].empty);
  check("results sheet: overall outcome per attempt (NS, S, not decided)", sheet.overall[0].result === "NS" && sheet.overall[1].result === "S" && !sheet.overall[2].decided && sheet.overall[0].feedback === "Redo the cost estimate.");
  const four = buildResultsSheet(wb.definition, { ...hist, attempts: [...hist.attempts, { ...hist.attempts[1], id: "a4", attemptNo: 4 }] }, 3);
  check("results sheet: an extra attempt opened by an administrator adds a column; void attempts are left out", four.attemptsShown === 4 && buildResultsSheet(wb.definition, { ...hist, attempts: [{ ...hist.attempts[0], state: "void" }] }, 3).rows[0].cells[0].empty);
  const fromLoaded = historyFromAttempts([{ id: "x1", assignmentId: "as", versionId: "v", studentId: "abcdef12-3456-4789-8000-000000000000", attemptNo: 1, state: "returned", responses: {}, assessorResponses: {}, responsesHash: "h", declaration: { signature: "Zara Test", agreed: true }, receiptNo: "R1", dueAt: null, outcome: "S", overallFeedback: "ok", startedAt: "", submittedAt: "2026-11-02T00:00:00Z", returnedAt: "2026-11-03T00:00:00Z", finalisedAt: null, rowVersion: 3, evidence: [], results: [], taskResults: [{ taskId: task1.id, rollupSuggested: null, outcome: "S", feedback: "", signedAt: "2026-11-03T00:00:00Z" }], feedback: [], reassessments: [] }], { studentName: "Zara Test" });
  check("results sheet: before asm_attempt_history is released the loaded attempt still gives the sheet (no assessor names)", !fromLoaded.complete && fromLoaded.student?.ref === "ABCDEF12" && buildResultsSheet(wb.definition, fromLoaded).rows[0].cells[0].result === "S" && fromLoaded.attempts[0].declarationName === "Zara Test");

  // ASM-WORKBOOK item 8: "Export as workbook PDF" of attempt 2, read back with pdf.js
  const flatQ = flattenQuestions(wb.definition).map((f) => f.question);
  const q11 = top(t1)[0];
  const q12 = top(t1)[1];
  const grid = flatQ.find((q) => q.type === "table_grid" && /Document Review Checklist/.test(q.label))!;
  const obs = flatQ.find((q) => q.type === "observation_checklist")!;
  const decl = flatQ.find((q) => q.type === "declaration")!;
  const gridCols = grid.config?.columns as { id: string }[]; const gridRows = grid.config?.rows as { id: string }[];
  const responses: Responses = {
    [q11.id]: "UNIQUE-ANSWER-Q11 The Road Management Act 2004 and WHS legislation apply to pavement selection.",
    [q12.id]: { [q12.children![0].id]: "UNIQUE-CHILD-ANSWER policies for surfacing" },
    [grid.id]: { [gridRows[0].id]: { [gridCols[0].id]: "Geotechnical report", [gridCols[1].id]: "UNIQUE-GRID-CELL reviewed" } },
    [decl.id]: { agreed: true, signature: "Zara Test" },
  };
  const results: ResultRow[] = [
    { questionId: q11.id, criterionId: null, suggestedOutcome: null, outcome: "S", score: null, rubricLevelId: null, feedback: "UNIQUE-FEEDBACK clear answer", markedAt: null },
    { questionId: q12.id, criterionId: "c1", suggestedOutcome: null, outcome: "NYS", score: null, rubricLevelId: null, feedback: "", markedAt: null },
  ];
  check("export: a question's S / NS tick comes from its own result, else from its criteria", questionOutcome(results, q11) === "S" && questionOutcome(results, q12) === "NYS" && questionOutcome(results, grid) === null);
  const pdfBytes = await buildWorkbookPdf({
    definition: wb.definition, history: hist, title: "Select Pavement surfacing", maxAttempts: 3,
    institution: { name: "Skyline Institute of Technology", lines: ["Level 8, 310 King Street", "Melbourne VIC - 3000", "RTO: 45989 CRICOS: 04114B"], logo: null },
    attempt: { attemptNo: 2, responses, assessorResponses: { [obs.id]: Object.fromEntries((obs.config?.items as { id: string }[]).map((it, i) => [it.id, i === 0])),
      [flatQ.find((q) => q.type === "adjustment_record")!.id]: { applied: true, tasks: "UNIQUE-RA-TASKS Task 1 written questions", categories: ["Non-English speaking background"], strategies: ["Verbal assessment"], explanation: "UNIQUE-RA-EXPLANATION answered orally", assessorName: "Alex Assessor", date: "2026-11-09", declared: true } }, results, submittedAt: "2026-11-10T01:00:00Z", receiptNo: "R-2", declaration: { signature: "Zara Test", agreed: true },
      evidence: [{ id: "e1", questionId: flatQ.find((q) => q.config?.allowAttachment === true && /Completed Risk Assessment/i.test(q.label))!.id, groupIndex: null, byAssessor: false, path: "p", fileName: "risk-register.pdf", mime: "application/pdf", bytes: 10, createdAt: "" }] },
  });
  if (process.env.ASM_PDF_OUT) writeFileSync(process.env.ASM_PDF_OUT, pdfBytes); // to look at the layout: ASM_PDF_OUT=<path>.pdf
  const outDoc = await pdf.getDocument({ data: pdfBytes.slice(), verbosity: 0 }).promise;
  const pageTexts: string[] = [];
  for (let p = 1; p <= outDoc.numPages; p++) pageTexts.push(((await (await outDoc.getPage(p)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ").replace(/\s+/g, " "));
  const allText = pageTexts.join("\n");
  const n = outDoc.numPages;
  check("export: every page has the footer Version Number 1.0, Unit Code RIICWD525E and Page X of Y", n > 10 && pageTexts.every((t, i) => t.includes("Version Number: 1.0") && t.includes("Unit Code: RIICWD525E") && t.includes(`Page ${i + 1} of ${n}`)), n);
  check("export: every page has the institution header", pageTexts.every((t) => t.includes("Skyline Institute of Technology") && t.includes("Level 8, 310 King Street") && t.includes("RTO: 45989 CRICOS: 04114B")));
  check("export: the cover has the student name and ID, trainer, qualification and unit", /Student Full Name Zara Test/.test(pageTexts[0]) && /Student ID 5F0C1A2B/.test(pageTexts[0]) && /Trainer Full Name Alex Assessor/.test(pageTexts[0]) && pageTexts[0].includes("RII50520") && pageTexts[0].includes("Diploma of Civil Construction Design") && pageTexts[0].includes("Select Pavement surfacing"), pageTexts[0].slice(0, 400));
  check("export: answers are in the document (long answer, a case-study part, a table cell), with the assessor's question feedback", allText.includes("UNIQUE-ANSWER-Q11") && allText.includes("UNIQUE-CHILD-ANSWER") && allText.includes("UNIQUE-GRID-CELL") && allText.includes("Assessor feedback: UNIQUE-FEEDBACK"));
  check("export: question bars with the Satisfactory Yes / No column, files listed by name", (allText.match(/Satisfactory Yes No/g) ?? []).length >= 20 && allText.includes("risk-register.pdf"));
  check("export: a results sheet after each task, attempts 1-3, with dates and assessors of the decided attempts", allText.includes("Assessment Task - 1 - Results Sheet") && allText.includes("Assessment Task - 2 - Results Sheet") && /First attempt Second attempt Third attempt/.test(allText) && allText.includes("Cost estimate incomplete.") && allText.includes("Sam Second") && allText.includes("05/11/2026") && !allText.includes("draft "), allText.match(/Assessment Task - 2 - Results Sheet.{0,300}/)?.[0]);
  check("export: the student's declaration and overall feedback are filled in", allText.includes("Signed (typed) by Zara Test on 10/11/2026") && allText.includes("Competent work."));
  check("export: Appendix A – Reasonable Adjustments is printed as the trainer recorded it", allText.includes("Appendix A – Reasonable Adjustments") && allText.includes("UNIQUE-RA-TASKS") && allText.includes("UNIQUE-RA-EXPLANATION") && allText.includes("Non-English speaking background") && /Reasonable adjustment strategy Applied/.test(allText) && /Trainer\/Assessor Name Alex Assessor/.test(allText) && allText.includes("09/11/2026"), allText.match(/Appendix A.{0,400}/)?.[0]);
  const numbered = await buildWorkbookPdf({ definition: wb.definition, history: { ...hist, student: { ...hist.student!, number: "SLIT-000123", ref: "SLIT-000123" } }, title: "x", institution: { name: "Skyline Institute of Technology", lines: [], logo: null }, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
  const cover = ((await (await (await pdf.getDocument({ data: numbered.slice(), verbosity: 0 }).promise).getPage(1)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ");
  check("export: the student number, when Skyline has one, is the cover's Student ID", /Student ID SLIT-000123/.test(cover.replace(/\s+/g, " ")), cover.slice(0, 300));
  check("export: no picture data, instruction pages or assessor keys are printed", !allText.includes("data:image") && !allText.includes("Team Member Role Responsibilities") && !/model answer/i.test(allText));
  // ASM-REVIEW: the wizard's page view numbers the bars from the same layout as the PDF
  const bars = [...workbookNumbering(wb.definition).values()];
  check("review: the page view's question bars (Q1 … and 2.1.3) are the PDF's: same count of Satisfactory Yes / No bars", bars.filter((b) => b.markable).length === (allText.match(/Satisfactory Yes No/g) ?? []).length && bars.some((b) => /^2\.\d+\.\d+$/.test(b.number)), [bars.filter((b) => b.markable).length, (allText.match(/Satisfactory Yes No/g) ?? []).length]);
  // ASM-REVIEW: the Workbook (PDF) view: the blank workbook prints the information pages and the briefs, and no attempt line
  const blank = await buildWorkbookPdf({ definition: wb.definition, blank: true, history: { student: null, trainers: [], assessment: null, attempts: [], complete: true }, title: "Select Pavement surfacing", institution: { name: "Skyline Institute of Technology", lines: [], logo: null }, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
  const blankDoc = await pdf.getDocument({ data: blank.slice(), verbosity: 0 }).promise;
  const blankTexts: string[] = [];
  for (let p = 1; p <= blankDoc.numPages; p++) blankTexts.push(((await (await blankDoc.getPage(p)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ").replace(/\s+/g, " "));
  const blankText = blankTexts.join("\n");
  check("review: the blank workbook has the information pages (plagiarism, appeals) and the task briefs, with the footer on every page", blankText.includes("Assessment information") && /Plagiarism/.test(blankText) && /appeal/i.test(blankText) && blankText.includes("Team Member Role Responsibilities") && blankTexts.every((t, i) => t.includes(`Page ${i + 1} of ${blankDoc.numPages}`) && t.includes("Unit Code: RIICWD525E")), blankDoc.numPages);
  check("review: the blank workbook prints no attempt, answers or assessor keys", !/Attempt 1/.test(blankText) && !blankText.includes("UNIQUE-") && !/model answer/i.test(blankText) && !blankText.includes("data:image"));
  const tables = all.filter((q) => q.type === "table_grid");
  check("workbook: Q2.2.3's table is titled from the line above it (Site Condition Evaluation), no table is \"Complete the table\"", tables.some((q) => q.label === "Site Condition Evaluation") && !tables.some((q) => /complete the table/i.test(q.label)), tables.map((q) => q.label));
  const selected = all.filter((q) => q.label === "Selected Option");
  check("workbook: \"Selected Option: AC10 Asphalt\" -> label Selected Option, the sample as help text", selected.length >= 1 && selected.some((q) => /AC10 Asphalt/.test(String(q.helpText ?? q.config?.placeholder ?? ""))) && !all.some((q) => /AC10 Asphalt/.test(q.label)), selected.map((q) => [q.label, q.helpText]));
  const memo = all.find((q) => q.type === "case_study" && /Traffic Category Justification Memo – Occasion 2/.test(q.label));
  check("workbook: the memo's To / From / Subject lines are help text, not the question", Boolean(memo) && /To: Senior Engineer/.test(memo!.helpText ?? "") && !/Senior Engineer/.test(`${memo!.label} ${String(memo!.config?.scenario ?? "")}`), memo && [memo.label, memo.config?.scenario, memo.helpText]);
  check("workbook: fill-in tables become table_grid with their columns", all.some((q) => q.type === "table_grid" && JSON.stringify(q.config?.columns).includes("Controls Implemented")));
  check("workbook: one student declaration per task, with its wording", wb.definition.tasks.every((t) => t.sections.some((s) => s.questions.some((q) => q.type === "declaration" && /own work/.test(String(q.config?.text))))));
  const text = definitionText(wb.definition);
  const leaks = ["Level 8, 310 King Street", "RTO: 45989", "info@slit.edu.au", "+61 3 9125 1661", "Version Number", "Page 1 of", "Unit Code: RIICWD525E | Page"].filter((x) => text.includes(x));
  check("workbook: no header / footer text anywhere in the definition", leaks.length === 0, leaks);
  // Appendix A is kept, but only inside the trainer's adjustment record (item 7), never as student questions or instructions
  const studentText = definitionText({ ...wb.definition, tasks: wb.definition.tasks.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, questions: s.questions.filter((q) => q.type !== "adjustment_record") })) })) });
  check("workbook: the marking checklist, results sheets and evaluation form are skipped; Appendix A only in the adjustment record", !/ASSESSMENT MARKING CHECKLIST|Results Sheet|Learner Evaluation|First attempt:|Reasonable Adjustment Strategies/i.test(studentText));

  // item 4 as the workbook does it: one Satisfactory Yes / No per question (the bar "Q3 | 2.1.3 | Satisfactory"), not per box
  const kids = all.filter((q) => wb.definition.tasks.some((t) => t.sections.some((s) => s.questions.some((p) => (p.children ?? []).includes(q)))));
  check("marking: each imported question is marked once (no default criterion); the boxes inside a question are not marked on their own", kids.length > 50 && kids.every((q) => q.markingMode === "none" && !q.criteria) && top(t1).filter((q) => q.type !== "file_upload" && q.type !== "declaration").every((q) => q.markingMode === "criteria" && !q.criteria?.length), kids.length);

  // ASM-WORKBOOK item 1: the information pages before Task 1, read-only, before the student starts
  const info = wb.definition.instructions ?? "";
  const infoTitles = [...info.matchAll(/<h4>(.*?)<\/h4>/g)].map((m) => m[1]);
  check("info pages: submission, reasonable adjustment, feedback, plagiarism, collusion, outcome, reassessment, due date, confidentiality, appeals, RPL, special needs, declaration", wb.stats.infoSections === 15 && ["Assessment Submission Method", "Reasonable Adjustment", "Plagiarism", "Collusion", "Competency outcome", "Reassessment", "Fail to complete by due date", "Confidentiality", "Assessment appeals process", "Recognised prior learning", "Special needs", "Student declaration"].every((x) => infoTitles.includes(x)), infoTitles);
  check("info pages: the details forms, the task list and the assessors' own instructions are left out", !/Student Full Name|Qualification Code|Evidence number|Fill out assessment outcome records/.test(info) && !infoTitles.some((x) => /details|qualification|assessment tasks|instructions to complete/i.test(x)), infoTitles);
  check("info pages: the submission method says online through the LMS; the text is kept (plagiarism wording)", info.includes("submitted online through the Learning Management System") && /Plagiarism is presenting another person.s work as your own/.test(info) && !/Student signature|\(Please describe here\)/i.test(info));
  // ASM-WORKBOOK item 7: Appendix A becomes the trainer's reasonable adjustment record at the end of the last task
  const raSection = t2.sections[t2.sections.length - 1];
  const raQ = raSection?.questions[0];
  const raStrategies = (raQ?.config?.strategies as string[] | undefined) ?? [];
  check("adjustment record: the last section of task 2 is Appendix A with one assessor-only, unmarked, optional record", /Appendix A/.test(raSection?.title ?? "") && raQ?.type === "adjustment_record" && raQ.assessorOnly === true && raQ.markingMode === "none" && raQ.required === false && !raQ.criteria, raQ);
  check("adjustment record: the strategies of both matrices, wrapped lines joined, no declarations or explanation sentences", raStrategies.length >= 30 && raStrategies[0] === "Verbal assessment" && raStrategies.includes("Use methods that do not require a higher level of language or literacy than is required to perform the job role") && raStrategies.includes("Provide information or course materials in an accessible format, e.g. a textbook in braille") && !raStrategies.some((x) => /^I declare|trainer\/assessor must/i.test(x)) && raQ?.importMeta?.confidence === "high", raStrategies);
  check("adjustment record: its explanation is Appendix A's text; a student is never asked to fill it in", /^Students with carer responsibilities/.test(String(raQ?.config?.intro)) && !validateResponses(wb.definition, {}, "student").some((e) => e.questionId === raQ?.id));
  check("adjustment record: the results sheet still counts the two tasks only (the record is not marked)", buildResultsSheet(wb.definition, { student: null, trainers: [], assessment: null, attempts: [], complete: true }).rows.length === 2);
  check("workbook: every imported question names its source page", all.every((q) => typeof q.importMeta?.page === "number"));
  check("workbook: no NUL characters (pdf.js tick boxes) that Postgres would refuse in jsonb", !JSON.stringify(wb.definition).includes("\\u0000"));
  check("workbook: the draft is structurally valid and carries no assessor data", validateDefinition(wb.definition).length === 0 && forbiddenKey(wb.definition) === null, validateDefinition(wb.definition));
}

// ASM-IMPORT parser rules on a small Word document (always runs): table caption, sample text, attachments only from wording
{
  const html = [
    "<p><strong>Assessment Task 1 – Practical</strong></p>",
    "<p>1. Complete the hazard register for the site.</p><p><strong>Hazard register</strong></p>",
    "<table><tr><td><p>Hazard</p></td><td><p>Risk</p></td><td><p>Control</p></td></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></table>",
    "<p>2. Calculate the area of the carpark in square metres.</p><p></p><p></p><p></p>",
    "<p>3. Take a photo of your completed formwork and attach it.</p><p></p><p></p><p></p>",
    "<p>4. Record your selection.</p><p>Selected Option: AC10 Asphalt</p><p>Short answer</p><p>Reason:</p><p>Short answer</p><p></p><p></p><p></p>",
    "<p>5. Write the memo to the engineer.</p><p>To: Senior Engineer</p><p>From: Site Engineer</p><p>Short answer</p><p></p><p></p><p></p>",
  ].join("");
  const r = buildFromLines(linesFromDocxHtml(html), { fileName: "rules.docx" });
  const qs = flattenQuestions(r.definition).map((f) => f.question);
  const byText = (re: RegExp) => qs.find((q) => re.test(q.label));
  const table = qs.find((q) => q.type === "table_grid");
  check("rules: a table takes its title from the bold line above it", table?.label === "Hazard register" && JSON.stringify((table?.config?.columns as { label: string }[]).map((c) => c.label)) === JSON.stringify(["Hazard", "Risk", "Control"]), table && [table.label, table.config?.columns]);
  check("rules: a calculation question gets no attachment (no guessing)", byText(/calculate the area/i)?.config?.allowAttachment !== true);
  check("rules: \"take a photo … attach it\" allows attachments", byText(/take a photo/i)?.config?.allowAttachment === true);
  const sel = qs.find((q) => q.label === "Selected Option");
  check("rules: \"Selected Option: AC10 Asphalt\" -> label Selected Option, the sample as placeholder / help text", Boolean(sel) && /AC10 Asphalt/.test(String(sel!.helpText ?? sel!.config?.placeholder ?? "")) && !qs.some((q) => /AC10/.test(q.label)), sel && [sel.label, sel.helpText, sel.config?.placeholder]);
  const memoQ = byText(/write the memo/i);
  check("rules: To / From lines in the question are help text, not the label", Boolean(memoQ) && /To: Senior Engineer · From: Site Engineer/.test(memoQ!.helpText ?? "") && !/Senior Engineer/.test(memoQ!.label), memoQ && [memoQ.label, memoQ.helpText]);
}

// ASM-IMPORT: a Word assessor version with a model-answer column: the answers go to the keys only
{
  const { zipSync, strToU8 } = await import("fflate");
  const p = (t: string, bold = false) => `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const tc = (t: string) => `<w:tc>${p(t)}</w:tc>`;
  const tr = (...cells: string[]) => `<w:tr>${cells.map(tc).join("")}</w:tr>`;
  const body = [
    p("Assessor Marking Guide", true), p("CPCWHS1001 Prepare to work safely"),
    p("Assessment Task 1 – Knowledge questions", true),
    `<w:tbl>${tr("No.", "Question", "Student answer", "Model answer")}${tr("1", "Describe the PPE needed for cutting concrete.", "", "Gloves, safety glasses, hearing and dust protection.")}${tr("2", "List two hazards on a construction site.", "", "Falls from height; moving plant.")}</w:tbl>`,
    p("3. Explain why a site induction is required?"), p("Model answer: it explains the site's hazards, rules and emergency procedures."), p(""), p(""), p(""),
    p("Student declaration", true), p("I declare that this work is my own."),
  ].join("");
  const docx = zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  });
  const mammothMod = await import("mammoth");
  const mammoth = (mammothMod as unknown as { default?: typeof mammothMod }).default ?? mammothMod;
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(docx) } as unknown as { arrayBuffer: ArrayBuffer }, { ignoreEmptyParagraphs: false } as Parameters<typeof mammoth.convertToHtml>[1]);
  const wd = buildFromLines(linesFromDocxHtml(html), { fileName: "assessor.docx" });
  const qs = flattenQuestions(wd.definition).map((f) => f.question).filter((q) => q.type !== "instruction");
  const keyText = wd.keys.map((k) => k.modelAnswer ?? "").join(" | ");
  const dtext = definitionText(wd.definition);
  check("docx: recognised as an assessor version", wd.assessorVersion);
  check("docx: the table rows and the numbered paragraph are questions", qs.filter((q) => q.type === "long_answer").length === 3, qs.map((q) => `${q.type}:${q.label}`));
  check("docx: the three model answers are keys of those questions", wd.keys.length === 3 && /Gloves, safety glasses/.test(keyText) && /moving plant/.test(keyText) && /emergency procedures/.test(keyText) && wd.keys.every((k) => qs.some((q) => q.id === k.questionId)), wd.keys);
  check("docx: no model answer text is in the definition", !/Gloves, safety glasses|moving plant|emergency procedures/.test(dtext) && forbiddenKey(wd.definition) === null);
  check("docx: the declaration is kept", qs.some((q) => q.type === "declaration" && /my own/.test(String(q.config?.text))), qs.map((q) => q.type));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
