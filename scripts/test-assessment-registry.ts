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
import { adjustmentLayout, detailRows, titleSubline, htmlToBlocks, INFO_HEADING, workbookDetails, workbookNumbering } from "../src/lib/assessment/workbookLayout";
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
    // ASM-HEADER: the bundled Skyline logo as the header picture (the file is in the repo: public/templates/image.png)
    institution: { name: "INDOPACIFIC GLOBAL PTY LTD", lines: ["Level 8, 310 King Street", "Melbourne VIC - 3000", "RTO: 45989 CRICOS: 04114B"], logo: existsSync("public/templates/image.png") ? { bytes: new Uint8Array(readFileSync("public/templates/image.png")), type: "png" } : null },
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
  // ASM-COVER: page 0 is the "STUDENT WORKBOOK" cover (not numbered); "Page 1 of N" is the details page, as in the master workbook
  const body = pageTexts.slice(1);
  check("cover: the first page is the STUDENT WORKBOOK cover with the unit code and name and the student's name and ID, no header or footer", /S ?T ?U ?D ?E ?N ?T\s*W ?O ?R ?K ?B ?O ?O ?K/.test(pageTexts[0]) && pageTexts[0].includes("RIICWD525E Select Pavement surfacing") && /Student Name: Zara Test/.test(pageTexts[0]) && /Student ID: 5F0C1A2B/.test(pageTexts[0]) && !pageTexts[0].includes("Version Number") && !pageTexts[0].includes("Level 8"), pageTexts[0]);
  check("export: every page after the cover has the footer Version Number 1.0, Unit Code RIICWD525E and Page X of Y (cover not counted)", n > 10 && body.every((t, i) => t.includes("Version Number: 1.0") && t.includes("Unit Code: RIICWD525E") && t.includes(`Page ${i + 1} of ${n - 1}`)), n);
  check("header: every page after the cover has the address block and no legal-name line (the picture is the header)", body.every((t) => t.includes("Level 8, 310 King Street") && t.includes("RTO: 45989 CRICOS: 04114B") && !t.includes("INDOPACIFIC")));
  check("header: the header picture is drawn on every page after the cover and on the cover", (await Promise.all(Array.from({ length: n }, async (_, k) => ((await (await outDoc.getPage(k + 1)).getOperatorList()).fnArray as number[]).filter((op) => op === 85 || op === 82).length))).every((images) => images >= 1));
  check("export: the details page has the student name and ID, trainer, qualification and unit", /Student Full Name Zara Test/.test(pageTexts[1]) && /Student ID 5F0C1A2B/.test(pageTexts[1]) && /Trainer Full Name Alex Assessor/.test(pageTexts[1]) && pageTexts[1].includes("RII50520") && pageTexts[1].includes("Diploma of Civil Construction Design") && pageTexts[1].includes("Select Pavement surfacing"), pageTexts[1].slice(0, 400));
  check("title: the details page does not print the unit name twice under a title that already says it", (pageTexts[1].match(/RIICWD525E Select Pavement surfacing/g) ?? []).length === 0 && titleSubline("RIICWD525E Select Pavement surfacing", { code: "RIICWD525E", name: "Select Pavement surfacing" }) === null && titleSubline("Assessment 1", { code: "RIICWD525E", name: "Select Pavement surfacing" }) === "RIICWD525E Select Pavement surfacing", pageTexts[1].slice(0, 200));
  check("export: answers are in the document (long answer, a case-study part, a table cell), with the assessor's question feedback", allText.includes("UNIQUE-ANSWER-Q11") && allText.includes("UNIQUE-CHILD-ANSWER") && allText.includes("UNIQUE-GRID-CELL") && allText.includes("Assessor feedback: UNIQUE-FEEDBACK"));
  check("export: question bars with the Satisfactory Yes / No column, files listed by name", (allText.match(/Satisfactory Yes No/g) ?? []).length >= 20 && allText.includes("risk-register.pdf"));
  check("export: a results sheet after each task, attempts 1-3, with dates and assessors of the decided attempts", allText.includes("Assessment Task - 1 - Results Sheet") && allText.includes("Assessment Task - 2 - Results Sheet") && /First attempt Second attempt Third attempt/.test(allText) && allText.includes("Cost estimate incomplete.") && allText.includes("Sam Second") && allText.includes("05/11/2026") && !allText.includes("draft "), allText.match(/Assessment Task - 2 - Results Sheet.{0,300}/)?.[0]);
  check("export: the student's declaration and overall feedback are filled in", allText.includes("Signed (typed) by Zara Test on 10/11/2026") && allText.includes("Competent work."));
  check("export: Appendix A – Reasonable Adjustments is printed as the trainer recorded it", allText.includes("Appendix A – Reasonable Adjustments") && allText.includes("UNIQUE-RA-TASKS") && allText.includes("UNIQUE-RA-EXPLANATION") && allText.includes("Non-English speaking background") && /Reasonable adjustment strategy Applied/.test(allText) && /Trainer\/Assessor Name Alex Assessor/.test(allText) && allText.includes("09/11/2026"), allText.match(/Appendix A.{0,400}/)?.[0]);
  const numbered = await buildWorkbookPdf({ definition: wb.definition, history: { ...hist, student: { ...hist.student!, number: "SLIT-000123", ref: "SLIT-000123" } }, title: "x", institution: { name: "Skyline Institute of Technology", lines: [], logo: null }, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
  const cover = ((await (await (await pdf.getDocument({ data: numbered.slice(), verbosity: 0 }).promise).getPage(1)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ");
  check("export: the student number, when Skyline has one, is the cover's Student ID", /Student ID: SLIT-000123/.test(cover.replace(/\s+/g, " ")), cover.slice(0, 300));
  check("export: no picture data, instruction pages or assessor keys are printed", !allText.includes("data:image") && !allText.includes("Team Member Role Responsibilities") && !/model answer/i.test(allText));
  // items 1 / 3 / 7 on the shared layout: what the screens draw is what the PDF prints
  check("item 1: the marked export prints the information (compliance) pages after the cover, the task briefs still not", allText.includes(INFO_HEADING) && /Plagiarism/.test(pageTexts[2] ?? "") && /appeal/i.test(allText) && !allText.includes("Team Member Role Responsibilities"), pageTexts[2]?.slice(0, 200));
  const det = workbookDetails({ history: hist, definition: wb.definition });
  check("item 3: the details rows (student, ID, email, trainers) are the cover's, in the workbook's order", detailRows(det).every(([label, value]) => !value || pageTexts[1].includes(`${label} ${value}`)) && detailRows(det).map(([l]) => l).join("|") === "Student Full Name|Student ID|Student Email|Trainer Full Name", detailRows(det));
  check("item 3: qualification / unit come from the history first, else the workbook, else the assignment's unit", workbookDetails({ history: null, definition: wb.definition }).unit?.code === "RIICWD525E" && workbookDetails({ history: null, definition: { tasks: [] }, unit: { code: "CPCCPD2012", name: "Painting tools" } }).unit?.code === "CPCCPD2012" && workbookDetails({ history: { ...hist, assessment: { title: "x", unit: { code: "HIST01", name: "From history" } } }, definition: wb.definition }).unit?.code === "HIST01");
  const ra = flatQ.find((q) => q.type === "adjustment_record")!;
  const lay = adjustmentLayout(ra, { applied: true, strategies: ["Verbal assessment"], assessorName: "Alex Assessor", declared: true, date: "2026-11-09" }, (d) => d.split("-").reverse().join("/"));
  check("item 7: the adjustment layout: applied ticks, one row per strategy with its tick, the sign-off rows as printed", lay.facts.map(([l]) => l).every((l) => allText.includes(l)) && lay.strategies.length >= 30 && lay.strategies.filter(([, on]) => on).map(([t]) => t).join() === "Verbal assessment" && lay.sign.map(([l]) => l).every((l) => allText.includes(l)) && lay.sign[2][1] === "09/11/2026" && Boolean(lay.declaration), lay.facts);
  check("item 7: an unrecorded adjustment record lays out empty (no ticks, no values)", adjustmentLayout(ra, undefined).facts.every(([, c]) => (typeof c === "string" ? c === "" : c.ticks.every(([, on]) => !on))) && adjustmentLayout(ra, undefined).strategies.every(([, on]) => !on));
  // ASM-REVIEW: the wizard's page view numbers the bars from the same layout as the PDF
  const bars = [...workbookNumbering(wb.definition).values()];
  check("review: the page view's question bars (Q1 … and 2.1.3) are the PDF's: same count of Satisfactory Yes / No bars", bars.filter((b) => b.markable).length === (allText.match(/Satisfactory Yes No/g) ?? []).length && bars.some((b) => /^2\.\d+\.\d+$/.test(b.number)), [bars.filter((b) => b.markable).length, (allText.match(/Satisfactory Yes No/g) ?? []).length]);
  // ASM-REVIEW: the Workbook (PDF) view: the blank workbook prints the information pages and the briefs, and no attempt line
  const blank = await buildWorkbookPdf({ definition: wb.definition, blank: true, history: { student: null, trainers: [], assessment: null, attempts: [], complete: true }, title: "Select Pavement surfacing", institution: { name: "Skyline Institute of Technology", lines: [], logo: null }, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
  const blankDoc = await pdf.getDocument({ data: blank.slice(), verbosity: 0 }).promise;
  const blankTexts: string[] = [];
  for (let p = 1; p <= blankDoc.numPages; p++) blankTexts.push(((await (await blankDoc.getPage(p)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ").replace(/\s+/g, " "));
  const blankText = blankTexts.join("\n");
  check("review: the blank workbook has the information pages (plagiarism, appeals) and the task briefs, with the footer on every page", blankText.includes("Assessment information") && /Plagiarism/.test(blankText) && /appeal/i.test(blankText) && blankText.includes("Team Member Role Responsibilities") && blankTexts.slice(1).every((t, i) => t.includes(`Page ${i + 1} of ${blankDoc.numPages - 1}`) && t.includes("Unit Code: RIICWD525E")) && /Student Name:/.test(blankTexts[0]), blankDoc.numPages);
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

// ------------------------------------------------------------------ ASM-AI-IMPORT (2026-11-25): numbering, verbatim, matching, checks
{
  const { normalizeNumber, normalizePart } = await import("../supabase/functions/_shared/asm-import/numbering.ts");
  const { checkVerbatim, normText, similarity } = await import("../supabase/functions/_shared/asm-import/verbatim.ts");
  const { matchGuide, checkDocuments, bumpVersion } = await import("../supabase/functions/_shared/asm-import/match.ts");
  const { checkChunk, cleanOutline, planChunks, assemble, mockAnswer, outlineRequest, taskRequest } = await import("../supabase/functions/_shared/asm-import/pipeline.ts");
  const { createProvider, AiError, costUsd } = await import("../supabase/functions/_shared/asm-import/provider.ts");
  type AiOutline = import("../supabase/functions/_shared/asm-import/schema.ts").AiOutline;
  type AiTaskPart = import("../supabase/functions/_shared/asm-import/schema.ts").AiTaskPart;

  const n = (raw: string) => normalizeNumber(raw)?.canonical ?? null;
  const table: [string, string | null][] = [
    ["1.1", "1.1"], ["Q1.1", "1.1"], ["Question 1.1", "1.1"], ["Q 1.1.", "1.1"], ["1.1)", "1.1"], ["question 1.1:", "1.1"],
    ["1.1a", "1.1a"], ["1.1(a)", "1.1a"], ["1.1 a)", "1.1a"], ["1.1.a", "1.1a"], ["Q1.1-A", "1.1a"], ["1.1(iv)", "1.1iv"],
    ["2.1.3", "2.1.3"], ["Q2.1.3", "2.1.3"], ["A.1", "A.1"], ["a-1", "A.1"], ["A1", "A.1"], ["Section A.1", "A.1"], ["01.02", "1.2"],
    ["1", "1"], ["Q1", "1"], ["Task 2", "2"], ["Explain Ohm's law", null], ["", null],
  ];
  const wrong = table.filter(([raw, want]) => n(raw) !== want).map(([raw, want]) => `${raw} -> ${n(raw)} (want ${want})`);
  check("ai numbering: every provider's numbering normalises (1.1, Q1.1, Question 1.1, 1.1a, 1.1(a), 2.1.3, A.1, A1 …)", wrong.length === 0, wrong);
  check("ai numbering: base and part are split (1.2(c) -> base 1.2, part c)", normalizeNumber("1.2(c)")?.base === "1.2" && normalizeNumber("1.2(c)")?.part === "c");
  check("ai numbering: part labels on their own (a, (b), c), ii.)", ["a", "(b)", "c)", "ii."].map(normalizePart).join(",") === "a,b,c,ii" && normalizePart("1.2") === null);

  // verbatim: the PDF reads table cells line by line; another column's words sit between the question's words
  const page = "No. | Question | Satisfactory\n1.1 | Explain Ohm’s law and how it is used to | S / NS\nfind the current in a simple circuit.\n1.2 | Describe the PPE needed for cutting concrete.";
  check("ai verbatim: the exact words, split by another column and smart quotes, are verbatim", checkVerbatim("Explain Ohm's law and how it is used to find the current in a simple circuit.", [page]).status === "exact");
  check("ai verbatim: whitespace and line breaks do not matter", checkVerbatim("Describe  the PPE\nneeded for cutting concrete.", [page]).status === "exact");
  const para = checkVerbatim("Explain Ohm's law and how you use it to work out the current in a basic circuit.", [page]);
  check("ai verbatim: a reworded question is not verbatim, and the PDF wording is offered", para.status !== "exact" && Boolean(para.pdfText && /Ohm's law/.test(para.pdfText)), para);
  const small = checkVerbatim("Describe the PPE needed for cutting the concrete.", [page]);
  check("ai verbatim: one word added -> close (on the Check this list), not exact", small.status === "close", small);
  check("ai verbatim: text that is not in the PDF at all -> missing", checkVerbatim("List three hazards of working at heights on a scaffold.", [page]).status === "missing");
  check("ai verbatim: normText folds quotes, dashes, bullets and ligatures", normText("“ﬁre” – • safe…") === "\"fire\" - safe...", normText("“ﬁre” – • safe…"));
  check("ai similarity: same question in other words scores high, another question low", similarity("Explain Ohm's law and how it finds current", "Explain how Ohm's law is used to find the current") > 0.6 && similarity("Explain Ohm's law", "List two hazards on site") < 0.2);

  // the checks on a model answer (one chunk): paraphrase, low confidence, drawing, scanned page, evidence title, numbers
  const pages = [{ page: 4, text: page, scanned: false }, { page: 5, text: "2.1 | Upload a photo of the completed test bench setup.\nFigure 3 Wiring diagram of the test circuit", scanned: false }, { page: 6, text: "", scanned: true }];
  const raw: AiTaskPart = { title: "Task 1", number: "1", instructions: null, sections: [{ title: "Written questions", items: [
    { kind: "question", number: "Q1.1", text: "Explain Ohm's law and how it is used to find the current in a simple circuit.", parts: [], table: null, pages: [4], confidence: 0.95, reason: null, answer: null, look_for: null },
    { kind: "question", number: "Question 1.2", text: "Describe the protective equipment you need when cutting concrete.", parts: [], table: null, pages: [4], confidence: 0.9, reason: null, answer: null, look_for: null },
    { kind: "evidence", number: "2.1", text: "Upload a photo of the completed test bench setup.", parts: [], table: null, pages: [5], confidence: 0.6, reason: "Question type guessed", answer: null, look_for: null },
    { kind: "drawing", number: null, text: "Figure 3 Wiring diagram of the test circuit", parts: [], table: null, pages: [5], confidence: 0.9, reason: null, answer: null, look_for: null },
    { kind: "question", number: "2.2", text: "Record the readings shown on the meter.", parts: [], table: null, pages: [6], confidence: 0.9, reason: null, answer: null, look_for: null },
  ] }] };
  const checked = checkChunk(raw, { task: 0, from: 4, to: 6 }, pages)[0].items;
  check("ai check: numbers normalised (Q1.1 -> 1.1, Question 1.2 -> 1.2)", checked[0].canonical === "1.1" && checked[1].canonical === "1.2");
  check("ai check: a verbatim question has no flags", checked[0].verbatim === "exact" && checked[0].flags.length === 0, checked[0]);
  check("ai check: the reworded question goes on Check this with the PDF's wording", checked[1].flags.some((f) => /PDF/.test(f)) && Boolean(checked[1].pdfText), checked[1]);
  check("ai check: low confidence carries the model's reason", checked[2].flags.includes("Question type guessed"), checked[2].flags);
  check("ai check: a drawing is flagged to check its placement", checked[3].flags.includes("Drawing found, check its placement"));
  check("ai check: every item from a scanned page is flagged", checked[4].verbatim === "scanned" && checked[4].flags.includes("Read from a scanned page"));

  // the outline: codes must be printed; ranges inside the document; overlaps cut; no tasks -> one
  const docPages = [{ page: 1, text: "Unit Code | AURETR112 Qualification | AUR30620 Version 1.0", scanned: false }, { page: 2, text: "Task 1", scanned: false }, { page: 3, text: "Task 2", scanned: false }];
  const o = cleanOutline({ document_kind: "workbook", title: "WB", qualification_code: "AUR30620", qualification_name: "Cert III", unit_code: "AURETR999", unit_name: "Made up", version: "Version 1.0",
    tasks: [{ number: "1", title: "Written", kind: "written", first_page: 2, last_page: 3 }, { number: "2", title: "Project", kind: "project", first_page: 3, last_page: 9 }] } as AiOutline, docPages);
  check("ai outline: a unit code not printed in the document is dropped; a printed one kept", o.unit_code === null && o.qualification_code === "AUR30620", o);
  check("ai outline: version number kept as digits; overlapping and out-of-range pages fixed", o.version === "1.0" && o.tasks[0].last_page === 2 && o.tasks[1].first_page === 3 && o.tasks[1].last_page === 3, o.tasks);
  check("ai outline: no tasks found -> the whole document is one task", cleanOutline({ document_kind: "other", title: null, qualification_code: null, qualification_name: null, unit_code: null, unit_name: null, version: null, tasks: [] }, docPages).tasks.length === 1);
  const chunks = planChunks({ ...o, tasks: [{ number: "1", title: "Long", kind: "project", first_page: 1, last_page: 20 }] }, 8);
  check("ai plan: a long task is read 8 pages at a time (1-8, 9-16, 17-20)", JSON.stringify(chunks.map((c) => [c.from, c.to])) === "[[1,8],[9,16],[17,20]]");
  const tr = taskRequest("guide", o, { task: 0, from: 2, to: 2 }, docPages, new Map());
  check("ai request: the next page is context only, and the guide request asks for answers", /context only/.test((tr.input[0] as { text: string }).text) && /ANSWER GUIDE/.test(tr.instructions));
  check("ai request: the verbatim rule is part of every task request", /word for word/.test(taskRequest("workbook", o, { task: 0, from: 2, to: 2 }, docPages, new Map()).instructions));
  check("ai request: the outline names no provider's headings", !/Assessment Tasks*-|Occasion|SLIT|Skyline/i.test(outlineRequest("workbook", docPages).instructions));

  // the provider interface: unknown provider / missing key refused; mock answers; cost only when priced
  let refused = 0;
  try { createProvider({ provider: "openai", model: "x" }); } catch (e) { if (e instanceof AiError && e.code === "config") refused += 1; }
  try { createProvider({ provider: "other", model: "x", apiKey: "k" }); } catch (e) { if (e instanceof AiError) refused += 1; }
  check("ai provider: no key / unknown provider refused before any call", refused === 2);
  let sent = "";
  const fake = createProvider({ provider: "openai", model: "m-1", apiKey: "sk-test", fetch: (async (_u: string, init: RequestInit) => { sent = String(init.body); return new Response(JSON.stringify({ id: "r1", status: "completed", output_text: "{\"ok\":true}", usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200 }); }) as typeof fetch });
  const got = await fake.generate({ name: "t", schema: { type: "object" }, instructions: "i", input: [{ kind: "text", text: "hello" }, { kind: "image", dataUrl: "data:image/jpeg;base64,AA" }], maxOutputTokens: 10, timeoutMs: 1000 });
  const body = JSON.parse(sent);
  check("ai provider: OpenAI structured output (json_schema, strict), store off, image as input_image", body.text.format.type === "json_schema" && body.text.format.strict === true && body.store === false && body.input[0].content[1].type === "input_image" && (got.data as { ok: boolean }).ok === true);
  check("ai provider: usage counted, cost only with prices", got.usage.inputTokens === 1000 && costUsd(got.usage) === null && costUsd(got.usage, 2, 8) === 0.0036, [got.usage, costUsd(got.usage, 2, 8)]);
  const broke = createProvider({ provider: "openai", model: "m", apiKey: "k", fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch });
  let retry = false; try { await broke.generate({ name: "t", schema: {}, instructions: "", input: [], maxOutputTokens: 1, timeoutMs: 100 }); } catch (e) { retry = e instanceof AiError && e.retry; }
  check("ai provider: a 5xx is a retryable failure (the browser falls back if it keeps failing)", retry);

  // the answer guide: by number, part by part, whole question, guide split into parts, content suggestion (flagged), missing
  const qs = [
    { id: "q11", number: "Q1.1", text: "Explain Ohm's law and how it is used to find the current in a simple circuit.", parts: [] },
    { id: "q12", number: "1.2", text: "For each of the following, describe it.", parts: [{ id: "q12a", label: "a", text: "Series circuit" }, { id: "q12b", label: "b", text: "Parallel circuit" }, { id: "q12c", label: "c", text: "Voltage drop" }] },
    { id: "q13", number: "1.3", text: "Describe the protective equipment for cutting concrete.", parts: [] },
    { id: "q14", number: "1.4", text: "List the steps to isolate a circuit before testing.", parts: [{ id: "q14a", label: "a", text: "Step one" }] },
    { id: "q21", number: "2.1", text: "Upload a photo of the test bench.", parts: [] },
    { id: "q22", number: "2.2", text: "Record the meter readings for each load in the series circuit.", parts: [] },
  ];
  const guide = [
    { number: "Question 1.1", questionText: null, answer: "Current equals voltage over resistance (I = V / R).", lookFor: null, parts: [] },
    { number: "1.2(a)", questionText: null, answer: "One path for current.", lookFor: null, parts: [] },
    { number: "1.2 b)", questionText: null, answer: "Several paths.", lookFor: null, parts: [] },
    { number: "1.3a", questionText: null, answer: "Gloves.", lookFor: null, parts: [] },
    { number: "1.3b", questionText: null, answer: "Respirator.", lookFor: null, parts: [] },
    { number: "1.4", questionText: null, answer: "Isolate, tag, test for dead.", lookFor: null, parts: [] },
    { number: "2.1", questionText: null, answer: null, lookFor: "Photo shows the meter connected in series.", parts: [] },
    { number: "B.7", questionText: "Record the readings on the meter for each load in the series circuit", answer: "Readings within 5 %.", lookFor: null, parts: [] },
  ];
  const mo = matchGuide(qs, guide);
  const key = (id: string) => mo.keys.find((k) => k.questionId === id);
  check("ai match: Question 1.1 in the guide answers Q1.1 in the workbook", key("q11")?.via === "number" && /I = V \/ R/.test(key("q11")?.modelAnswer ?? ""));
  check("ai match: parts match part by part (1.2(a), 1.2 b)); part c has none", key("q12a")?.modelAnswer === "One path for current." && key("q12b")?.modelAnswer === "Several paths." && !key("q12c"));
  check("ai match: a guide that answers the whole question attaches to the question (1.4)", key("q14")?.modelAnswer === "Isolate, tag, test for dead." && !key("q14a"));
  check("ai match: a guide split into parts for a one-part question is put together, for review (1.3)", /Gloves/.test(key("q13")?.modelAnswer ?? "") && /Respirator/.test(key("q13")?.modelAnswer ?? "") && Boolean(key("q13")?.review));
  check("ai match: a project benchmark becomes What to look for (assessor guidance)", key("q21")?.assessorGuidance === "Photo shows the meter connected in series." && !key("q21")?.modelAnswer);
  check("ai match: numbering that does not line up is matched by content and always flagged", key("q22")?.via === "content" && /check it/.test(key("q22")?.review ?? ""), key("q22"));
  check("ai match: counts (answers matched / questions) and nothing left over", mo.matched === 6 && mo.total === 6 && mo.unused.length === 0 && mo.missing.length === 0, [mo.matched, mo.total, mo.missing, mo.unused.length]);
  const lone = matchGuide([{ id: "x", number: "3.1", text: "Explain torque.", parts: [] }], guide);
  check("ai match: a question the guide does not answer is listed as missing", lone.missing.includes("x") && lone.matched === 0);

  check("ai documents: same unit, same version -> ok", JSON.stringify(checkDocuments({ unitCode: "AURETR112", version: "1.0" }, { unitCode: "auretr112", version: "Version 1" })) === JSON.stringify({ unit: "same", version: "same", block: false, messages: [] }));
  const diff = checkDocuments({ unitCode: "AURETR112", version: "1.0" }, { unitCode: "AURETR113", version: "2.0" });
  check("ai documents: a different unit blocks; a different version warns", diff.block && diff.unit === "different" && diff.version === "different" && diff.messages.length === 2, diff);
  check("ai documents: a guide without a unit code is a warning, not a block", !checkDocuments({ unitCode: "AURETR112", version: null }, { unitCode: null, version: null }).block);
  check("ai version: edits bump 1.0 -> 1.1, 1.9 -> 1.10, 2 -> 2.1, none -> 1.1", [bumpVersion("1.0"), bumpVersion("1.9"), bumpVersion("2"), bumpVersion(null)].join(" ") === "1.1 1.10 2.1 1.1");

  // a second, different layout (synthetic until the owner sends a second provider's workbook): lettered sections, "Question n" numbering
  const otherPages = [
    { page: 1, text: "ASSESSMENT TOOL\nUnit: BSBWHS411 Implement and monitor WHS policies\nCourse: BSB40120 Certificate IV in Business\nDocument version 3.2", scanned: false },
    { page: 2, text: "Part A Knowledge\nQuestion A1: Name the WHS legislation that applies in your state.\nQuestion A2: Describe two consultation processes:\n(a) health and safety representatives\n(b) WHS committees", scanned: false },
  ];
  const otherOutline = cleanOutline({ document_kind: "workbook", title: "ASSESSMENT TOOL", qualification_code: "BSB40120", qualification_name: "Certificate IV in Business", unit_code: "BSBWHS411", unit_name: "Implement and monitor WHS policies", version: "Document version 3.2", tasks: [{ number: "A", title: "Part A Knowledge", kind: "written", first_page: 2, last_page: 2 }] } as AiOutline, otherPages);
  const otherChunk = checkChunk({ title: "Part A", number: "A", instructions: null, sections: [{ title: "Part A Knowledge", items: [
    { kind: "question", number: "Question A1", text: "Name the WHS legislation that applies in your state.", parts: [], table: null, pages: [2], confidence: 0.92, reason: null, answer: null, look_for: null },
    { kind: "multipart", number: "Question A2", text: "Describe two consultation processes:", parts: [{ label: "(a)", text: "health and safety representatives", answer: null }, { label: "(b)", text: "WHS committees", answer: null }], table: null, pages: [2], confidence: 0.9, reason: null, answer: null, look_for: null },
  ] }] }, { task: 0, from: 2, to: 2 }, otherPages);
  const otherDoc = assemble("workbook", otherOutline, [{ task: 0, from: 2, to: 2 }], [otherChunk], { provider: "test", model: "fixture", scannedPages: 0 });
  check("ai layout 2: codes, version and lettered numbering read from another provider's layout", otherDoc.unit?.code === "BSBWHS411" && otherDoc.qualification?.code === "BSB40120" && otherDoc.version === "3.2"
    && otherChunk[0].items.map((i) => i.canonical).join(",") === "A.1,A.2" && otherChunk[0].items[1].parts.map((p) => p.part).join("") === "ab" && otherDoc.summary.flagged === 0, [otherDoc.unit, otherDoc.version, otherChunk[0].items.map((i) => [i.canonical, i.flags])]);
  console.log("PENDING - ai layout 2 with a real second provider's workbook (the owner sends one)");
  console.log("PENDING - ai answer guide matching with a real answer guide (the owner sends one)");

  // the RIICWD525E workbook through the AI pipeline with the lab's stand-in model, and a synthetic answer guide from its numbering
  if (workbookPath) {
    const { pageTextsFromPdf } = await import("../src/lib/assessment/pageText");
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
    const texts = await pageTextsFromPdf(doc as unknown as PdfDocLike);
    const mock = createProvider({ provider: "mock", model: "lab", mock: mockAnswer });
    const outline = cleanOutline((await mock.generate(outlineRequest("workbook", texts))).data as AiOutline, texts);
    const plan = planChunks(outline);
    const results = [];
    for (const c of plan) results.push(checkChunk((await mock.generate(taskRequest("workbook", outline, c, texts, new Map()))).data as AiTaskPart, c, texts));
    const rd = assemble("workbook", outline, plan, results, { provider: "mock", model: "lab", scannedPages: 0 });
    const items = rd.tasks.flatMap((t) => t.sections.flatMap((s) => s.items));
    console.log(`  ai pipeline (stand-in model): ${JSON.stringify(rd.summary)} unit ${rd.unit?.code} version ${rd.version} chunks ${plan.length}`);
    check("ai pipeline: RIICWD525E unit and version read and confirmed in the text", rd.unit?.code === "RIICWD525E" && rd.version === "1.0", [rd.unit, rd.version]);
    check("ai pipeline: RIICWD525E text pages are not scanned; the stand-in's copied lines all pass the verbatim check", texts.every((p) => !p.scanned) && items.length > 10 && items.every((i) => i.verbatim === "exact"), items.filter((i) => i.verbatim !== "exact").slice(0, 3));
    const questions = items.filter((i) => i.canonical).map((i, k) => ({ id: `q${k}`, number: i.number, text: i.text, parts: [] }));
    const synthetic = questions.map((q) => ({ number: `Question ${q.number?.replace(/^Q/i, "")}`, questionText: q.text, answer: `Model answer for ${q.number}`, lookFor: null, parts: [] }));
    const sm = matchGuide(questions, synthetic);
    check("ai match: a synthetic answer guide numbered from RIICWD525E matches every question by number", sm.matched === questions.length && sm.keys.every((k) => k.via === "number"), [sm.matched, questions.length]);
  }
}
// ------------------------------------------------------------------ ASM-AI-IMPORT stage 2: the draft, the guide, the reader used
{
  const { definitionFromAi, applyGuide, chooseImportPath, matchQuestions, guideAnswersFromAi, guideAnswersFromParser } = await import("../src/lib/assessment/aiDraft");
  type CheckedDocument = import("../src/lib/assessment/aiDraft").CheckedDocument;
  type ImportStatus = import("../src/lib/assessment/aiDraft").ImportStatus;
  const item = (o: Partial<CheckedDocument["tasks"][0]["sections"][0]["items"][0]>) => ({ kind: "question" as const, number: null, canonical: null, text: "", parts: [], table: null, pages: [3], confidence: 0.95, answer: null, lookFor: null, verbatim: "exact" as const, pdfText: null, flags: [], ...o });
  const doc: CheckedDocument = {
    kind: "workbook", documentKind: "workbook", title: "Test and repair basic electrical circuits", qualification: { code: "AUR30620", name: "Cert III" }, unit: { code: "AURETR112", name: "Test and repair basic electrical circuits" }, version: "1.0",
    provider: "test", model: "fixture", summary: { tasks: 1, questions: 3, evidence: 1, drawings: 1, tables: 1, flagged: 2, answers: 0, scannedPages: 0 },
    tasks: [{ number: "1", title: "Written assessment", kind: "written", instructions: null, firstPage: 3, lastPage: 6, sections: [{ title: "Questions", items: [
      item({ kind: "instruction", text: "Answer in your own words, 50-150 words each." }),
      item({ number: "Q1.1", canonical: "1.1", text: "Explain Ohm's law and how it is used to find the current in a simple circuit." }),
      item({ kind: "multipart", number: "1.2", canonical: "1.2", text: "For each of the following, describe what it is.", parts: [
        { label: "a", part: "a", text: "Series circuit", answer: null, verbatim: "exact", pdfText: null }, { label: "b", part: "b", text: "Parallel circuit", answer: null, verbatim: "close", pdfText: "Parallel circuits" }] }),
      item({ kind: "table", number: "1.3", canonical: "1.3", text: "Record your readings.", table: { columns: ["Load", "Voltage"], rows: [["Lamp 1", ""], ["Lamp 2", ""]] }, flags: ["Table may be split across pages"] }),
      item({ kind: "evidence", number: "1.4", canonical: "1.4", text: "Upload a photo of the completed test bench." }),
      item({ kind: "drawing", text: "Wiring diagram of the test circuit", pages: [5], flags: ["Drawing found, check its placement"] }),
    ] }] }],
  };
  const def = definitionFromAi(doc, [{ page: 5, x: 0, top: 500, bottom: 300, width: 200, height: 200, src: "data:image/jpeg;base64,QQ==" }]);
  const qs = def.tasks[0].sections[0].questions;
  check("ai draft: item kinds become question types (instruction, long answer, parts, table, upload, drawing)", qs.map((q) => q.type).join(",") === "instruction,long_answer,case_study,table_grid,file_upload,instruction", qs.map((q) => q.type));
  check("ai draft: text kept word for word, printed number kept, original stored for traceability", qs[1].label === doc.tasks[0].sections[0].items[1].text && qs[1].importMeta?.number === "1.1" && qs[1].importMeta?.original === qs[1].label && qs[1].importMeta?.via === "ai");
  check("ai draft: parts are child questions numbered 1.2a / 1.2b; the reworded part is flagged with the PDF wording", qs[2].children?.map((c) => c.importMeta?.number).join(",") === "1.2a,1.2b" && Boolean(qs[2].children?.[1].importMeta?.flags?.length) && qs[2].children?.[1].importMeta?.pdfText === "Parallel circuits");
  check("ai draft: the table keeps its columns and rows", JSON.stringify((qs[3].config?.columns as { label: string }[]).map((c) => c.label)) === "[\"Load\",\"Voltage\"]" && (qs[3].config?.rows as unknown[]).length === 2);
  check("ai draft: the drawing carries the workbook's picture from its page and is flagged", /<img src="data:image\/jpeg/.test(String(qs[5].config?.html)) && qs[5].importMeta?.flags?.[0] === "Drawing found, check its placement");
  check("ai draft: no answer or guidance in the definition", forbiddenKey(def) === null && def.source?.unit?.code === "AURETR112" && def.source?.version === "1.0");
  check("ai draft: the PDF export numbers questions as printed", workbookNumbering(def).get(qs[1].id)?.number === "1.1");
  const mq = matchQuestions(def);
  check("ai draft: the matcher sees 1.1, 1.2 (parts a, b), 1.3, 1.4", mq.map((q) => `${q.number}:${q.parts.map((p) => p.label).join("")}`).join(" ") === "1.1: 1.2:ab 1.3: 1.4:", mq.map((q) => `${q.number}:${q.parts.map((p) => p.label).join("")}`));

  const guideDoc: CheckedDocument = { ...doc, kind: "guide", documentKind: "answer_guide", tasks: [{ ...doc.tasks[0], sections: [{ title: "Answers", items: [
    item({ number: "Question 1.1", canonical: "1.1", text: "Explain Ohm's law", answer: "I = V / R" }),
    item({ kind: "multipart", number: "1.2", canonical: "1.2", text: "Describe", parts: [{ label: "a", part: "a", text: "Series", answer: "One path", verbatim: "exact", pdfText: null }, { label: "b", part: "b", text: "Parallel", answer: "Many paths", verbatim: "exact", pdfText: null }] }),
    item({ kind: "evidence", number: "1.4", canonical: "1.4", text: "Photo", lookFor: "The meter is connected in series." }),
  ] }] }] };
  const answers = guideAnswersFromAi(guideDoc);
  const ok = applyGuide(def, { unitCode: "AURETR112", version: "1.0", answers });
  const k = (id: string | undefined) => ok.keys.find((x) => x.questionId === id);
  check("ai guide: answers attach by number and part by part; the benchmark is What to look for", k(qs[1].id)?.modelAnswer === "I = V / R" && k(qs[2].children?.[0].id)?.modelAnswer === "One path" && k(qs[2].children?.[1].id)?.modelAnswer === "Many paths" && k(qs[4].id)?.assessorGuidance === "The meter is connected in series.");
  check("ai guide: 1.3 has no answer -> listed as missing; counts 3 of 4", ok.outcome.missing.includes(qs[3].id) && ok.outcome.matched === 3 && ok.outcome.total === 4, [ok.outcome.matched, ok.outcome.total]);
  const blocked = applyGuide(def, { unitCode: "AURETR113", version: "1.0", answers });
  check("ai guide: a guide for another unit is blocked (no keys at all)", blocked.check.block && blocked.keys.length === 0 && /AURETR113/.test(blocked.check.messages[0]));
  check("ai guide: a different version is a warning only", applyGuide(def, { unitCode: "AURETR112", version: "2.0", answers }).keys.length === ok.keys.length && applyGuide(def, { unitCode: "AURETR112", version: "2.0", answers }).check.version === "different");

  const st = (o: Partial<ImportStatus>): ImportStatus => ({ id: "j", kind: "workbook", state: "done", fileName: "f.pdf", pages: 2, progress: { label: "", done: 1, total: 1 }, summary: {}, error: null, usage: {}, provider: "openai", model: "m", cached: false, result: doc, ...o });
  check("fallback: the AI's result is used when it finished", chooseImportPath({ status: st({}), timedOut: false }).path === "ai");
  check("fallback: failed / timed out / could not start / skipped -> the standard reader, with the reason shown", [
    chooseImportPath({ status: st({ state: "failed", result: null, error: "The AI reader answered 503." }), timedOut: false }),
    chooseImportPath({ status: st({ state: "running", result: null }), timedOut: true }),
    chooseImportPath({ status: null, timedOut: false }),
    chooseImportPath({ status: null, timedOut: false, skipped: true }),
  ].every((c) => c.path === "parser" && Boolean(c.reason)) && /503/.test(chooseImportPath({ status: st({ state: "failed", result: null, error: "The AI reader answered 503." }), timedOut: false }).reason ?? ""));
  if (workbookPath) {
    // the standard reader (fallback) on RIICWD525E, with a synthetic answer guide made from its own numbering
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdoc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
    const { lines, version } = await linesFromPdf(pdoc as unknown as PdfDocLike);
    const fb = buildFromLines(lines, { fileName: "RIICWD525E.pdf", version });
    const fq = matchQuestions(fb.definition);
    const synthetic = fq.map((q) => ({ number: `Q${q.number}`, questionText: q.text, answer: `Model answer ${q.number}`, lookFor: null, parts: q.parts.map((p) => ({ label: p.label, answer: `Part ${p.label}` })) }));
    const fbApplied = applyGuide({ ...fb.definition, source: { unit: fb.unit, version: fb.version } }, { unitCode: "RIICWD525E", version: "1.0", answers: synthetic });
    check("fallback path: the standard reader's RIICWD525E draft takes a synthetic guide by number, every question matched", fq.length > 20 && fbApplied.outcome.matched === fq.length && !fbApplied.check.block, [fbApplied.outcome.matched, fq.length]);
    check("fallback path: the parser's own keys become guide answers (assessor version input)", Array.isArray(guideAnswersFromParser(fb)));
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
