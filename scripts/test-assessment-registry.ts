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
import { adjustmentLayout, detailRows, titleSubline, htmlToBlocks, INFO_HEADING, workbookDetails, workbookNumbering, OCCASION_TITLE } from "../src/lib/assessment/workbookLayout";
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
    { kind: "evidence", number: "2.1", text: "Upload a photo of the completed test bench setup.", parts: [], table: null, pages: [5], confidence: 0.4, reason: "Question type guessed", answer: null, look_for: null },
    { kind: "drawing", number: null, text: "Figure 3 Wiring diagram of the test circuit", parts: [], table: null, pages: [5], confidence: 0.9, reason: null, answer: null, look_for: null },
    { kind: "question", number: "2.2", text: "Record the readings shown on the meter.", parts: [], table: null, pages: [6], confidence: 0.9, reason: null, answer: null, look_for: null },
    { kind: "evidence", number: "2.3", text: "Upload a photo of the completed test bench setup.", parts: [], table: null, pages: [5], confidence: 0.62, reason: "Kind guessed", answer: null, look_for: null },
    { kind: "question", number: "2.4", text: "Describe the test bench you would build for a motor.", parts: [], table: null, pages: [5], confidence: 0.62, reason: "Text hard to read", answer: null, look_for: null },
  ] }] };
  const oneTask = { document_kind: "workbook", title: null, qualification_code: null, qualification_name: null, unit_code: null, unit_name: null, version: null, tasks: [{ number: "1", title: "Task 1", kind: "written", first_page: 4, last_page: 6 }] } as AiOutline;
  const checkedDoc = assemble("workbook", oneTask, [{ task: 0, from: 4, to: 6 }], [checkChunk(raw, { task: 0, from: 4, to: 6 }, pages)], { provider: "test", model: "fixture", scannedPages: 1 });
  const checked = checkedDoc.tasks[0].sections[0].items;
  check("ai check: numbers normalised (Q1.1 -> 1.1, Question 1.2 -> 1.2)", checked[0].canonical === "1.1" && checked[1].canonical === "1.2");
  check("ai check: a verbatim question has no flags", checked[0].verbatim === "exact" && checked[0].flags.length === 0, checked[0]);
  check("ai check: the reworded question goes on Check this with the PDF's wording and what differs", checked[1].flags.some((f) => /^Wording differs from the PDF on page 4 \(not in the PDF: .*protective.*\)/.test(f) || /^Text not found in the PDF on page 4/.test(f)) && Boolean(checked[1].pdfText), checked[1].flags);
  check("ai check: below 50 % confidence the model's reason is on the list, with the confidence", checked[2].flags.some((f) => f === "The AI reader was unsure (40 %): Question type guessed"), checked[2].flags);
  check("ai check: a drawing is not flagged just for being a drawing", checked[3].flags.length === 0, checked[3].flags);
  check("ai check: every item from a scanned page is flagged, with the page", checked[4].verbatim === "scanned" && checked[4].flags.some((f) => /^Read from a scanned page 6/.test(f)), checked[4].flags);
  check("ai check: confidence 62 % with the text found in the PDF -> not flagged (calibrated threshold)", checked[5].flags.length === 0, checked[5].flags);
  check("ai check: confidence 62 % with the text NOT found in the PDF -> flagged with the model's reason", checked[6].flags.some((f) => f === "The AI reader was unsure (62 %): Text hard to read"), checked[6].flags);

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
// ------------------------------------------------------------------ ASM-AI-IMPORT reader 2 (2026-11-25): formatting is never a difference
{
  const { checkVerbatim, stripRunningText, compareTokens, stripLeadingNumber } = await import("../supabase/functions/_shared/asm-import/verbatim.ts");
  const { normalizeNumber } = await import("../supabase/functions/_shared/asm-import/numbering.ts");
  const { checkChunk, assemble, flagsOf, READER_VERSION } = await import("../supabase/functions/_shared/asm-import/pipeline.ts");
  type AiOutline = import("../supabase/functions/_shared/asm-import/schema.ts").AiOutline;
  type AiItem = import("../supabase/functions/_shared/asm-import/schema.ts").AiItem;
  const v = (item: string, page: string | string[]) => checkVerbatim(item, Array.isArray(page) ? page : [page]);
  const same = (item: string, page: string | string[]) => v(item, page).status === "exact";

  // each normalisation case on its own
  check("norm: curly / straight quotes are the same", same("Explain the \"site\" plan's scope.", "Explain the “site” plan’s scope."));
  check("norm: en / em dashes, minus and hyphen are the same", same("Do a pre-start check - daily.", "Do a pre–start check — daily."));
  check("norm: bullets (• · ▪ ) are not words", same("• Read the workbook • Conduct research", "· Read the workbook\n Conduct research") && same("Read the workbook Conduct research", "▪ Read the workbook ▪ Conduct research"));
  check("norm: ligatures ﬁ ﬂ read as fi fl", same("final floor finish", "ﬁnal ﬂoor ﬁnish"));
  check("norm: a non-breaking space is a space", same("approx. 650 m2 of surface", "approx. 650 m2 of surface"));
  check("norm: soft hyphens and zero-width characters are invisible", same("intermodal facilities", "inter­modal facil​ities"));
  check("norm: a word hyphenated over a line break is joined (role-\\nplays = role-plays; inter-\\nmodal = intermodal)", same("including role-plays (if applicable)", "including role-\nplays (if applicable)") && same("design of intermodal facilities", "design of inter-\nmodal facilities") && same("role-plays", "role- plays"));
  check("norm: a path broken after a slash is joined (MATLAB/ AUTOCAD/)", same("GeoGebra/MATLAB/AUTOCAD/ Handwritten", "GeoGebra/MATLAB/\nAUTOCAD/ Handwritten"));
  check("norm: case and punctuation the model added or dropped are not differences; the PDF's text is used", (() => { const r = v("Relevant Plans and Sketch Drawing. Drawing ID: CP-002.", "Relevant Plans and Sketch Drawing\nDrawing ID: CP-002"); return r.status === "exact" && r.text === "Relevant Plans and Sketch Drawing Drawing ID: CP-002"; })(), v("Relevant Plans and Sketch Drawing. Drawing ID: CP-002.", "Relevant Plans and Sketch Drawing\nDrawing ID: CP-002"));
  check("norm: the item number is left out on both sides (1.2, a., Q3, (iv))", same("1.2 Describe the PPE needed.", "Q1.2 | Describe the PPE needed.") && same("a. Describe the PPE needed.", "(a) Describe the PPE needed.") && same("Q3 Describe the PPE needed.", "3. Describe the PPE needed.") && stripLeadingNumber("(iv) Name it") === "Name it" && stripLeadingNumber("Question 2.1: Name it") === "Name it");
  check("norm: the number is not stripped from text that starts with a word (A new site...)", stripLeadingNumber("A new site plan") === "A new site plan" && stripLeadingNumber("e.g. a plan") === "e.g. a plan");
  check("norm: compare tokens keep the PDF's raw words", compareTokens("role-\nplays (What?)").map((t) => `${t.raw}:${t.core}`).join(" ") === "role-plays:roleplays (What?):what");

  // running headers / footers, including a question that crosses a page break
  const header = "Level 8, 310 King Street\nMelbourne VIC – 3000\nRTO: 45989 CRICOS: 04114B";
  const footer = (n: number) => `Version Number: 1.0 | Unit Code: RIICWD525E | Page ${n} of 102`;
  const book = [1, 2, 3, 4, 5].map((n) => ({ page: n, scanned: false, text: `${header}\nQ${n + 10} | Q2.1.${n} | Satisfactory\nBody text of page ${n}.\n${n === 3 ? "Provide your answer solutions to the" : "Write your answer below."}\n${footer(n)}` }));
  book[3].text = `${header}\nfollowing questions using your own words.\nQ14 | Q2.1.4 | Satisfactory\n${footer(4)}`;
  const stripped = stripRunningText(book);
  check("headers: the address block and the Version / Unit / Page footer are removed from every page", stripped.every((p) => !/King Street|CRICOS|Version Number|Page \d of/.test(p.text)), stripped.map((p) => p.text));
  check("headers: a question's table heading at the top of every page (Q11 | Q2.1.1 | Satisfactory, Q12 | Q2.1.2 …) stays", stripped.filter((p) => /Q2\.1\.\d \| Satisfactory/.test(p.text)).length === 5, stripped.map((p) => p.text));
  // an answer guide repeats "Model answer: … question N …" on every page at varying places: content, not a header
  const guidePages = [1, 2, 3, 4, 5].map((n) => ({ page: n, scanned: false, text: [...Array.from({ length: n % 3 }, (_, k) => `Benchmark ${n}.${k}`), `Model answer: the sample answer for question 2.2.${n} of the workbook`, ...Array.from({ length: 1 + ((n * 2) % 4) }, (_, k) => `Body line ${k} of answer ${n}`), `Version Number: 1.0 | Page ${n} of 5`].join("\n") }));
  check("headers: a line repeated on every page at varying places ('Model answer: … question 2.2.N') is kept; the footer at the same place goes", stripRunningText(guidePages).every((p) => /Model answer/.test(p.text) && !/Version Number/.test(p.text)), stripRunningText(guidePages).map((p) => p.text));
  const crossing = "Provide your answer solutions to the following questions using your own words.";
  check("headers: a question crossing a page break is found once the header / footer is gone (and not before)", v(crossing, [stripped[2].text, stripped[3].text]).status === "exact" && v(crossing, [book[2].text, book[3].text]).status !== "exact", [v(crossing, [book[2].text, book[3].text]).status]);

  // table cells read line by line
  const twoCol = "Assessment description | This assessment task is a written task that includes a set of questions for which you are\n(What?)\nrequired to provide written answer solutions.";
  const col = v("Assessment description (What?) This assessment task is a written task that includes a set of questions for which you are required to provide written answer solutions.", twoCol);
  check("columns: a label cell's second line printed among the next cell's lines is the PDF's text (reflowed), not a mismatch", col.status === "exact" && col.text === "Assessment description (What?) This assessment task is a written task that includes a set of questions for which you are required to provide written answer solutions.", col);
  const threeCol = "Conduct Site and Risk | Analyse site survey, identify | Site Condition Evaluation\nAssessment | hazards (e.g., drainage, | Report\npoor subgrade), complete a\nbasic risk assessment.";
  check("columns: a three-column row (activity | description | evidence) gives each cell's words in reading order", same("Conduct Site and Risk Assessment Analyse site survey, identify hazards (e.g., drainage, poor subgrade), complete a basic risk assessment.", threeCol));
  const where = v("Assessment context (Where and in what condition?) Assessment is conducted in a safe environment in the training room, where you are required to answer.", "Assessment context | Assessment is conducted in a safe\nenvironment in the training room, where you\n(Where and in what condition?)\nare required to answer.");
  check("columns: a word in two cells goes to the right one (the label's 'Where', the text's 'where')", where.status === "exact" && where.text === "Assessment context (Where and in what condition?) Assessment is conducted in a safe environment in the training room, where you are required to answer.", where.text);
  const amp = v("Prepare Pavement Type Comparison Table & Selection Report", "Prepare Pavement | Pavement Type Comparison\nType Comparison | Table & Selection Report");
  check("rebuild: signs between the PDF's words (& + -) are kept in the PDF's text", amp.status === "exact" && /Table & Selection Report/.test(amp.text ?? ""), amp.text);
  check("norm: a bullet glyph with no Unicode (NUL) or a symbol-font glyph is not a word", (() => { const r = v("This task may be completed in: a workplace or a simulated workplace", "This task may be completed in:\n\u0000 a workplace or\n a simulated workplace"); return r.status === "exact" && r.text === "This task may be completed in: a workplace or a simulated workplace"; })());
  check("columns: a table heading split mid-word over two lines (Conseque / nce) is found",same("Identified Hazard | Potential Risk | Consequence | Likelihood", "Identified | Potential | Conseque | Likelihood\nHazard | Risk | nce"));

  // real differences are still reported, with what differs
  const para = "To gather evidence of your ability to apply knowledge consistently to select pavement surfacing in civil construction.";
  const changed = v("To gather evidence of your ability to apply knowledge consistently to choose pavement surfacing in civil construction.", para);
  check("diff: a changed word -> close, the model's word named as not in the PDF and the PDF's word as left out", changed.status === "close" && changed.diff?.added.join(" ") === "choose" && changed.diff?.left.join(" ") === "select", changed);
  const dropped = v("To gather evidence of your ability to apply knowledge in civil construction.", para);
  check("diff: text left out in the middle of a paragraph is not accepted (no table there) and is named", dropped.status !== "exact" && dropped.diff?.left.join(" ") === "consistently to select pavement surfacing", dropped);
  const added = v("To gather evidence of your ability to apply knowledge consistently to select pavement surfacing in civil construction and road works.", para);
  check("diff: text the model added is named", added.status === "close" && added.diff?.added.join(" ") === "and road works.", added);
  check("diff: text that is not on the page at all -> missing", v("List three hazards of working at heights on a scaffold.", para).status === "missing");

  // numbers
  check("numbers: two printed side by side (Q12 | Q2.2.1, Q3 / Q2.1.3) -> the most specific one", normalizeNumber("Q12 | Q2.2.1")?.canonical === "2.2.1" && normalizeNumber("Q3 / Q2.1.3")?.canonical === "2.1.3");
  const base = { kind: "question" as const, canonical: null, text: "x", parts: [], table: null, pages: [22], confidence: 0.95, answer: null, lookFor: null, verbatim: "exact" as const, pdfText: null, flags: [] };
  check("numbers: a heading in the number field (References) is not flagged; a broken number with digits is", flagsOf({ ...base, number: "References" }).length === 0 && flagsOf({ ...base, number: "1..2x?" })[0] === "\"1..2x?\" is not a question number: check the numbering on page 22");

  // assemble: continuation across a chunk, several tables of one question, repeated assembly does not pile flags up
  const pagesX = [
    { page: 14, scanned: false, text: "Q1.2 | Name the layers of a flexible pavement:\na. Wearing course" },
    { page: 15, scanned: false, text: "b. Base course" },
    { page: 16, scanned: false, text: "c. Subbase\nd. Subgrade" },
    { page: 17, scanned: false, text: "Q3 | Hazard | Risk\nControl | Owner" },
    { page: 30, scanned: false, text: "Q1.2 | Name the layers again" },
  ];
  const it = (o: Partial<AiItem>): AiItem => ({ kind: "question", number: null, text: "", parts: [], table: null, pages: [14], confidence: 0.95, reason: null, answer: null, look_for: null, ...o });
  const c1 = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Written", items: [
    it({ kind: "multipart", number: "Q1.2", text: "Name the layers of a flexible pavement:", parts: [{ label: "a.", text: "Wearing course", answer: null }, { label: "b.", text: "Base course", answer: null }], pages: [14, 15] }),
  ] }] }, { task: 0, from: 14, to: 15 }, pagesX);
  const c2 = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Written (continued)", items: [
    it({ kind: "multipart", number: "Q1.2", text: "", parts: [{ label: "c.", text: "Subbase", answer: null }, { label: "d.", text: "Subgrade", answer: null }], pages: [16], confidence: 0.62, reason: "The parent question stem is not shown on these pages" }),
    it({ kind: "table", number: "Q3", text: "Hazard | Risk", table: { columns: ["Hazard", "Risk"], rows: [] }, pages: [17] }),
    it({ kind: "table", number: "Q3", text: "Control | Owner", table: { columns: ["Control", "Owner"], rows: [] }, pages: [17] }),
    it({ kind: "question", number: "Q1.2", text: "Name the layers again", pages: [30] }),
  ] }] }, { task: 0, from: 16, to: 30 }, pagesX);
  const outlineX = { document_kind: "workbook", title: null, qualification_code: null, qualification_name: null, unit_code: null, unit_name: null, version: null, tasks: [{ number: "1", title: "T", kind: "written", first_page: 14, last_page: 30 }] } as AiOutline;
  const chunksX = [{ task: 0, from: 14, to: 15 }, { task: 0, from: 16, to: 30 }];
  const saved = JSON.stringify([c1, c2]);
  const a1 = assemble("workbook", outlineX, chunksX, [c1, null], { provider: "t", model: "t", scannedPages: 0 });
  const ax = assemble("workbook", outlineX, chunksX, [c1, c2], { provider: "t", model: "t", scannedPages: 0 });
  const ay = assemble("workbook", outlineX, chunksX, [c1, c2], { provider: "t", model: "t", scannedPages: 0 });
  const itemsX = ax.tasks[0].sections.flatMap((s) => s.items);
  check("assemble: a question with parts continued in the next chunk is joined back up (a-d, pages 14-16), its low-confidence stem doubt gone", itemsX[0].parts.map((p) => p.part).join("") === "abcd" && itemsX[0].pages.join(",") === "14,15,16" && itemsX[0].flags.length === 0 && !itemsX.some((i, k) => k > 0 && i.kind === "multipart"), itemsX.map((i) => [i.number, i.parts.length, i.flags]));
  check("assemble: two tables of the same question on the same page are not 'number appears twice'", itemsX.filter((i) => i.canonical === "3").every((i) => i.flags.length === 0), itemsX.filter((i) => i.canonical === "3").map((i) => i.flags));
  check("assemble: the same number far away is flagged once, naming the other page", itemsX.find((i) => i.pages[0] === 30)?.flags.join("|") === "Number 1.2 is also used for another question on pages 14, 15, 16: renumber one of them before publishing", itemsX.find((i) => i.pages[0] === 30)?.flags);
  check("assemble: putting the document together again (after every chunk) neither changes the saved chunks nor repeats a flag", JSON.stringify([c1, c2]) === saved && JSON.stringify(ax) === JSON.stringify(ay) && a1.summary.flagged === 0);

  // pictures: the browser marks them, the checks add one the model did not place
  const pp = [{ page: 44, scanned: false, pictures: 1, text: "5. Relevant Plans\n[Picture]\nSite Location Plan - shows alignment and access" }, { page: 45, scanned: false, pictures: 0, text: "Next page" }];
  const withPic = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Plans", items: [it({ kind: "instruction", text: "Relevant Plans Site Location Plan - shows alignment and access", pages: [44] }), it({ kind: "instruction", text: "Next page", pages: [45] })] }] }, { task: 0, from: 44, to: 45 }, pp);
  const picItems = withPic[0].items;
  check("pictures: a picture the model did not place becomes a drawing after the last item printed on its page", picItems.map((i) => i.kind).join(",") === "instruction,drawing,instruction" && picItems[1].pages[0] === 44 && picItems[1].added === true, picItems.map((i) => [i.kind, i.pages]));
  const placedPic = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Plans", items: [it({ kind: "drawing", text: "", pages: [44] })] }] }, { task: 0, from: 44, to: 45 }, pp);
  check("pictures: a picture the model placed is not added twice", placedPic[0].items.filter((i) => i.kind === "drawing").length === 1);
  check("pictures: the [Picture] marker is not a word of the page (it never makes text 'not found')", same("Relevant Plans Site Location Plan - shows alignment and access", stripRunningText(pp)[0].text));
  check("reader version: 2 or later (part of the cache key)", READER_VERSION >= 2);

  // RIICWD525E: the live AI reader's answers (asm_import_jobs 59772736, 2026-11-25), rebuilt from the job, through the new checks
  const answersPath = [process.env.ASM_AI_ANSWERS, workbookPath ? workbookPath.replace(/\.pdf$/i, ".ai-answers.json") : null].find((p) => p && existsSync(p));
  if (!workbookPath || !answersPath) console.log("SKIP - RIICWD525E AI answers regression (workbook or its .ai-answers.json not found; set ASM_WORKBOOK / ASM_AI_ANSWERS)");
  else {
    const { pageTextsFromPdf } = await import("../src/lib/assessment/pageText");
    const { definitionFromAi, mergeParserExtras } = await import("../src/lib/assessment/aiDraft");
    const { checkRows } = await import("../src/lib/assessment/checkList");
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
    const regions = await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps);
    const texts = await pageTextsFromPdf(doc as unknown as PdfDocLike, regions);
    const rec = JSON.parse(readFileSync(answersPath, "utf8")) as { outline: AiOutline; plan: { task: number; from: number; to: number }[]; answers: import("../supabase/functions/_shared/asm-import/schema.ts").AiTaskPart[] };
    const t0 = Date.now();
    const results = rec.plan.map((c, k) => checkChunk(rec.answers[k], c, texts));
    const ms = Date.now() - t0;
    const rd = assemble("workbook", rec.outline, rec.plan, results, { provider: "openai", model: "recorded", scannedPages: 0 });
    const items = rd.tasks.flatMap((t) => t.sections.flatMap((s) => s.items));
    const flagged = items.filter((i) => i.flags.length);
    console.log(`  RIICWD525E recorded AI answers, reader ${READER_VERSION}: ${JSON.stringify(rd.summary)} (checks ${ms} ms)`);
    for (const f of flagged) console.log(`    flag p${f.pages.join(",")} ${f.kind} ${f.number ?? ""}: ${f.flags.join(" | ")}`);
    check("RIICWD525E: pictures on pages 44 and 75 marked in the page text", texts[43].pictures === 1 && texts[74].pictures === 1 && texts.reduce((n, p) => n + p.pictures, 0) === 2, regions.map((r) => r.page));
    check("RIICWD525E: 2 drawings (pages 44 and 75)", rd.summary.drawings === 2 && items.filter((i) => i.kind === "drawing").map((i) => i.pages[0]).join(",") === "44,75", items.filter((i) => i.kind === "drawing").map((i) => i.pages));
    check("RIICWD525E: at most 5 items flagged (was 48 AI items + 3 standard-reader extras)", rd.summary.flagged <= 5, rd.summary.flagged);
    const generic = /^(Wording differs slightly from the PDF|Text not found in the PDF|Low confidence|Number appears twice|Unusual question number|Evidence item without a clear title|Table may be split across pages|Drawing found, check its placement|Check this)$/;
    check("RIICWD525E: every flag says what to check (no generic or type-only flags)", flagged.every((i) => i.flags.every((f) => !generic.test(f) && f.length > 30)), flagged.map((i) => i.flags));
    check("RIICWD525E: every instruction / question text is the PDF's own (exact) except the flagged ones", items.filter((i) => !i.flags.length).every((i) => ["exact", "empty"].includes(i.verbatim) && i.parts.every((p) => ["exact", "empty"].includes(p.verbatim))), items.filter((i) => !i.flags.length && i.verbatim !== "exact" && i.verbatim !== "empty").map((i) => [i.pages, i.verbatim]));
    check("RIICWD525E: no text is used that the PDF does not print (the label cell kept with its line: 'Assessment description (What?)')", items.some((i) => i.text.startsWith("Assessment description (What?) This assessment task")), items.filter((i) => /^Assessment description/.test(i.text)).map((i) => i.text.slice(0, 80)));
    check("RIICWD525E: Q1.2 is one question with parts a-p (the chunk boundary at page 16 joined)", items.filter((i) => i.canonical === "1.2").length === 1 && items.find((i) => i.canonical === "1.2")?.parts.length === 16, items.filter((i) => i.canonical === "1.2").map((i) => i.parts.length));
    check("RIICWD525E: checks run inside the Edge Function's CPU budget (under 1.5 s for the whole document here)", ms < 1500, ms);
    // the wizard's list: the AI draft plus the standard reader's extras, as ImportWizard counts its "import checks"
    const { lines, version } = await linesFromPdf(doc as unknown as PdfDocLike);
    const pictures = regions.map((r) => ({ ...r, src: `data:image/jpeg;base64,UElD${r.page}` }));
    const parsed = buildFromLines(lines, { fileName: "RIICWD525E.pdf", version, images: pictures });
    const draft = mergeParserExtras(definitionFromAi(rd, pictures), parsed.definition, rd.tasks.map((t) => ({ firstPage: t.firstPage, lastPage: t.lastPage })));
    const rows = checkRows(draft, workbookNumbering(draft));
    for (const r of rows) console.log(`    wizard row ${r.number || "-"}: ${r.reason}`);
    check("RIICWD525E: the wizard shows at most 5 import checks, each with a specific reason", rows.length <= 5 && rows.every((r) => !generic.test(r.reason)), rows.map((r) => r.reason));
    // ASM-OVERVIEW: a drawing is supporting material of its task (with its pages), no longer a block among the questions
    check("RIICWD525E: both drawings carry their picture in the draft", draft.tasks.flatMap((t) => t.materials ?? []).filter((m) => m.kind === "drawing" && /<img/.test(m.html)).length + flattenQuestions(draft).filter((f) => /<img/.test(String(f.question.config?.html ?? ""))).length === 2);
  }
}
// ------------------------------------------------------------------ ASM-IMPORT-CLASSIFY (2026-11-25): item types, auto-resolved differences
{
  const { classifyByRules, isResponseLabel, RULES_DECIDE, mockClassifyAnswer, readClassification, classifyRequest } = await import("../supabase/functions/_shared/asm-import/classify.ts");
  const { checkChunk, assemble, pendingClassification, applyClassification, READER_VERSION } = await import("../supabase/functions/_shared/asm-import/pipeline.ts");
  const { definitionFromAi, mergeParserExtras } = await import("../src/lib/assessment/aiDraft");
  const { checkRows, autoResolvedRows, reopenAutoResolved, autoResolvedNotes, isSectionHeading } = await import("../src/lib/assessment/checkList");
  type AiOutline = import("../supabase/functions/_shared/asm-import/schema.ts").AiOutline;
  type AiItem = import("../supabase/functions/_shared/asm-import/schema.ts").AiItem;
  type AiTaskPart = import("../supabase/functions/_shared/asm-import/schema.ts").AiTaskPart;
  type Sections = ReturnType<typeof checkChunk>;
  const { isAnswerable } = await import("../src/lib/assessment/registry");
  const plainTextOf = (q: Question) => String(q.config?.html ?? q.label ?? "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&");
  const rule = (kind: string, number: string | null, text: string) => classifyByRules({ kind, number, text });
  const decided = (c: { confidence: number }) => c.confidence >= RULES_DECIDE;

  // the BSBHRM613 / RIICWD525E report-template cases (pages 65-67 of the live import that raised the flags)
  const heads = [["1.", "Introduction"], ["2.", "Project Description"], ["4.", "Supporting Calculations"], ["5.", "Risk Considerations"]].map(([n, t]) => rule("question", n, t));
  check("classify: the four numbered report sections (Introduction, Project Description, Supporting Calculations, Risk Considerations) are section headings, decided by the rules", heads.every((c) => c.type === "section_heading" && decided(c) && c.by === "rules"), heads);
  check("classify: 'Short answer' is a response label (also 'Long answer', 'Word count: 200', '(5 marks)', '150-200 words')", ["Short answer", "Long answer", "Word count: 200", "(5 marks)", "150-200 words"].every((t) => rule("question", null, t).type === "response_label" && isResponseLabel(t)));
  const real = rule("question", "Q2.1.4", "Describe the hazards of resurfacing a carpark while it stays open");
  check("classify: a real 'Describe…' question is a question", real.type === "question" && decided(real), real);
  check("classify: a question mark, a command verb or a question number keeps a short line a question ('Why?', 'List three hazards', 'Q8 Surfacing Selection Plan Document')", rule("question", null, "Why?").type === "question" && rule("question", null, "List three hazards").type === "question" && rule("question", "Q8", "Surfacing Selection Plan Document").type === "question" && decided(rule("question", "Q8", "Surfacing Selection Plan Document")));
  check("classify: a field prompt ending in ':' ('Justification:', 'Selected Option:') is a question, decided by the rules", ["Justification:", "Selected Option:"].every((t) => { const c = rule("question", null, t); return c.type === "question" && decided(c); }));
  const field = rule("question", null, "Prepared by");
  check("classify: a short unnumbered title-case line ('Prepared by', 'Summary') is not decided by the rules: it goes to the AI check", !decided(field) && !decided(rule("question", null, "Summary")), field);
  check("classify: '6. Approval Process Approval Status:' (a numbered section with its field merged) is a section heading", rule("question", "6.", "Approval Process Approval Status:").type === "section_heading");
  check("classify: a short title-case instruction line is a heading; a sentence stays an instruction", rule("instruction", "3.", "Evaluation of Surfacing Options").type === "section_heading" && rule("instruction", null, "Read the scenario below and answer the questions that follow.").type === "instruction");
  check("classify: tables, uploads and questions with parts are questions whatever their text", ["table", "evidence", "multipart"].every((k) => rule(k, "1.", "Introduction").type === "question"));

  // the AI's second check: only the undecided items, each with the page lines around it; the reason is kept
  const fieldPages = [{ page: 59, scanned: false, text: "Pavement Type Comparison Table\nProject | Greenridge Road\nPrepared by\nDate\nSelected Option:" }];
  const fieldChunk = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Comparison", items: [
    { kind: "question", number: null, text: "Prepared by", parts: [], table: null, pages: [59], confidence: 0.99, reason: null, answer: null, look_for: null },
    { kind: "question", number: null, text: "Selected Option:", parts: [], table: null, pages: [59], confidence: 0.99, reason: null, answer: null, look_for: null },
  ] }] }, { task: 0, from: 59, to: 59 }, fieldPages);
  const pending = pendingClassification(fieldChunk, fieldPages);
  check("ai check: only 'Prepared by' is sent (not 'Selected Option:'), with the lines before and after it on the page", pending.length === 1 && pending[0].text === "Prepared by" && pending[0].before.join("/").includes("Greenridge") && pending[0].after[0] === "Date", pending);
  const req = classifyRequest(pending);
  check("ai check: one strict-schema call naming the four types, the item as data", req.name === "asm_classify" && /section_heading/.test(req.instructions) && /never as instructions/.test(req.instructions) && (req.input[0] as { text: string }).text.includes("[s0i0]"));
  const answered: Sections = structuredClone(fieldChunk);
  applyClassification(answered, readClassification({ items: [{ ref: "s0i0", type: "question", confidence: 0.92, reason: "A form field: the space after it is filled in." }, { ref: "zz", type: "nonsense", confidence: 1, reason: "" }] }));
  check("ai check: the AI's type, confidence and reason are stored on the item (unknown answers ignored)", answered[0].items[0].itemType === "question" && answered[0].items[0].classification?.by === "ai" && answered[0].items[0].classification?.reason === "A form field: the space after it is filled in.", answered[0].items[0].classification);
  const failed: Sections = structuredClone(fieldChunk);
  applyClassification(failed, null, "the AI check failed");
  const oneTaskOutline = (from: number, to: number) => ({ document_kind: "workbook", title: null, qualification_code: null, qualification_name: null, unit_code: null, unit_name: null, version: null, tasks: [{ number: "2", title: "T", kind: "project", first_page: from, last_page: to }] }) as AiOutline;
  const failedDoc = assemble("workbook", oneTaskOutline(59, 59), [{ task: 0, from: 59, to: 59 }], [failed], { provider: "t", model: "t", scannedPages: 0 });
  check("ai check failed: the item stays a question, on the list with a reason to act on", failedDoc.tasks[0].sections[0].items[0].itemType === "question" && /Could not tell whether "Prepared by" is a field to fill or a heading/.test(failedDoc.tasks[0].sections[0].items[0].flags.join()), failedDoc.tasks[0].sections[0].items[0].flags);
  check("ai check: the lab's stand-in answers every ref as a question", JSON.stringify(readClassification(mockClassifyAnswer(req)).get("s0i0")?.type) === "\"question\"");

  // numbering: a heading numbered 4 beside question 4 -> nothing; two questions numbered 4 -> a blocking flag
  const it = (o: Partial<AiItem>): AiItem => ({ kind: "question", number: null, text: "", parts: [], table: null, pages: [58], confidence: 0.95, reason: null, answer: null, look_for: null, ...o });
  const numPages = [{ page: 58, scanned: false, text: "Q4 | Satisfactory\nDescribe the calculations used to size the pavement layers" }, { page: 66, scanned: false, text: "4. Supporting Calculations\nShort answer" }, { page: 80, scanned: false, text: "Q4\nDescribe the drainage design for the carpark" }];
  const run = (items: AiItem[]) => {
    const chunk = { task: 0, from: 58, to: 80 };
    const sec = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Task 2", items }] } as AiTaskPart, chunk, numPages);
    applyClassification(sec, readClassification(mockClassifyAnswer(classifyRequest(pendingClassification(sec, numPages)))));
    return assemble("workbook", oneTaskOutline(58, 80), [chunk], [sec], { provider: "t", model: "t", scannedPages: 0 }).tasks[0].sections.flatMap((s) => s.items);
  };
  const q4 = it({ number: "Q4", text: "Describe the calculations used to size the pavement layers" });
  const withHeading = run([q4, it({ number: "4.", text: "Supporting Calculations", pages: [66] })]);
  check("numbering: a heading numbered 4 plus a question numbered 4 -> no flag on either; the heading carries an auto-resolved note", withHeading.every((i) => i.flags.length === 0 && !i.blocking) && withHeading[1].itemType === "section_heading" && withHeading[1].autoResolved?.[0]?.rule === "heading_number", withHeading.map((i) => [i.itemType, i.flags, i.autoResolved]));
  const twoQuestions = run([q4, it({ number: "Q4", text: "Describe the drainage design for the carpark", pages: [80] })]);
  check("numbering: two questions numbered 4 still raise a blocking flag", twoQuestions[1].blocking === true && /^Number 4 is also used for another question on page 58: renumber one of them before publishing$/.test(twoQuestions[1].flags.join("|")), twoQuestions.map((i) => [i.flags, i.blocking]));

  // wording: a difference that is only an answer box label or a number is resolved by rule and noted
  const apPages = [{ page: 67, scanned: false, text: "6. Approval Process\nShort answer\nApproval Status:\nShort answer\nQ9 | Q2.1.9\nList the approvals the council needs." }];
  const apSec = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Approval", items: [it({ number: "6.", text: "Approval Process Approval Status:", pages: [67] }), it({ number: "Q9", text: "List the approvals the council needs.", pages: [67] })] }] } as AiTaskPart, { task: 0, from: 67, to: 67 }, apPages);
  const ap = assemble("workbook", oneTaskOutline(67, 67), [{ task: 0, from: 67, to: 67 }], [apSec], { provider: "t", model: "t", scannedPages: 0 }).tasks[0].sections[0].items;
  check("wording: 'Approval Process Approval Status:' with 'Short answer' left out -> no flag; auto-resolved with the rule and the ignored text", ap[0].flags.length === 0 && ap[0].verbatim === "exact" && ap[0].autoResolved?.some((n) => n.rule === "response_label" && n.text === "Short answer" && /answer box's label/.test(n.note)), ap[0]);
  const numDiff = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Q", items: [it({ text: "Explain the traffic category", pages: [70] })] }] } as AiTaskPart, { task: 0, from: 70, to: 70 }, [{ page: 70, scanned: false, text: "Explain the 7. traffic category" }]);
  check("wording: a number printed inside the text ('7.') is numbering, not wording -> resolved by rule", numDiff[0].items[0].verbatim === "exact" && numDiff[0].items[0].autoResolved?.[0]?.rule === "numbering", numDiff[0].items[0]);
  const realDiff = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Q", items: [it({ text: "Explain the traffic category", pages: [70] })] }] } as AiTaskPart, { task: 0, from: 70, to: 70 }, [{ page: 70, scanned: false, text: "Explain the expected traffic category" }]);
  check("wording: a real word left out ('expected') is still a difference, not auto-resolved", realDiff[0].items[0].verbatim !== "exact" && !realDiff[0].items[0].autoResolved?.length);
  const labelItem = run([q4, it({ text: "Short answer", pages: [58] })]);
  check("response label: a 'Short answer' line read as an item is not a question; noted on the question it belongs to", labelItem.length === 1 && labelItem[0].autoResolved?.some((n) => n.rule === "response_label"), labelItem.map((i) => [i.text, i.autoResolved]));

  // the draft: headings are section labels (no answer, no "what the trainer should look for"); Auto-resolved list, Reopen, audit notes
  const hdDoc = assemble("workbook", oneTaskOutline(58, 80), [{ task: 0, from: 58, to: 80 }], [(() => { const sec = checkChunk({ title: "T", number: null, instructions: null, sections: [{ title: "Task 2", items: [q4, it({ number: "4.", text: "Supporting Calculations", pages: [66] }), it({ number: "Q4", text: "Describe the drainage design for the carpark", pages: [80] })] }] } as AiTaskPart, { task: 0, from: 58, to: 80 }, numPages); applyClassification(sec, null); return sec; })()], { provider: "t", model: "t", scannedPages: 0 });
  const hdDef = definitionFromAi(hdDoc);
  const hq = hdDef.tasks[0].sections[0].questions;
  check("draft: the heading is a section label (instruction <h4>, not answerable, typed section_heading), never a question", hq[1].type === "instruction" && /<h4>4\. Supporting Calculations<\/h4>/.test(String(hq[1].config?.html)) && !isAnswerable(hq[1]) && isSectionHeading(hq[1]) && hq[1].importMeta?.classification?.by === "rules", hq[1]);
  const hdRows = checkRows(hdDef, workbookNumbering(hdDef));
  check("draft: Needs a look lists only the real clash (blocking), not the heading", hdRows.length === 1 && hdRows[0].id === hq[2].id && hdRows[0].blocking === true, hdRows);
  const auto = autoResolvedRows(hdDef, workbookNumbering(hdDef));
  check("draft: the heading is under Auto-resolved with its reason", auto.length === 1 && auto[0].id === hq[1].id && auto[0].heading && /section heading, so its number is not compared with question Q4/.test(auto[0].notes[0]), auto);
  const reopened = updateQuestion(hdDef, hq[1].id, reopenAutoResolved);
  const reRows = checkRows(reopened, workbookNumbering(reopened));
  check("draft: Reopen puts it back on Needs a look with the note as its reason, and takes it off Auto-resolved", reRows.some((r) => r.id === hq[1].id && /^Reopened: /.test(r.reason)) && autoResolvedRows(reopened, workbookNumbering(reopened)).length === 0);
  const notes = autoResolvedNotes(reopened);
  check("audit: one note per resolved difference (rule, text, page), the reopened one marked", notes.length === 1 && notes[0].rule === "heading_number" && notes[0].page === 66 && notes[0].reopened === true, notes);
  check("reader version: 3 or later (item types)", READER_VERSION >= 3);

  // RIICWD525E reader-2 live answers (asm_import_jobs f86772cb, the owner's re-read 13:04): the report-template headings on pages
  // 65-67 (items 1, 2, 4, 5, 6, 7 of "Needs a look") are no longer listed
  const answers2 = [process.env.ASM_AI_ANSWERS_2, workbookPath ? workbookPath.replace(/\.pdf$/i, ".ai-answers-2.json") : null].find((p) => p && existsSync(p));
  if (!workbookPath || !answers2) console.log("SKIP - RIICWD525E reader-2 answers regression (workbook or its .ai-answers-2.json not found)");
  else {
    const { pageTextsFromPdf } = await import("../src/lib/assessment/pageText");
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
    const regions = await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps);
    const texts = await pageTextsFromPdf(doc as unknown as PdfDocLike, regions);
    const rec = JSON.parse(readFileSync(answers2, "utf8")) as { outline: AiOutline; plan: { task: number; from: number; to: number }[]; answers: AiTaskPart[] };
    let sent = 0;
    const results = rec.plan.map((c, k) => {
      const sec = checkChunk(rec.answers[k], c, texts);
      const p = pendingClassification(sec, texts); sent += p.length;
      applyClassification(sec, readClassification(mockClassifyAnswer(classifyRequest(p)))); // the lab's stand-in keeps fields as questions
      return sec;
    });
    const rd = assemble("workbook", rec.outline, rec.plan, results, { provider: "openai", model: "recorded", scannedPages: 0 });
    const items = rd.tasks.flatMap((t) => t.sections.flatMap((s) => s.items));
    const pictures = regions.map((r) => ({ ...r, src: `data:image/jpeg;base64,UElD${r.page}` }));
    const { lines, version } = await linesFromPdf(doc as unknown as PdfDocLike);
    const parsed = buildFromLines(lines, { fileName: "RIICWD525E.pdf", version, images: pictures });
    const draft = mergeParserExtras(definitionFromAi(rd, pictures), parsed.definition, rd.tasks.map((t) => ({ firstPage: t.firstPage, lastPage: t.lastPage })));
    const rows = checkRows(draft, workbookNumbering(draft));
    const autoRows = autoResolvedRows(draft, workbookNumbering(draft));
    console.log(`  RIICWD525E reader-2 answers, reader ${READER_VERSION}: ${JSON.stringify(rd.summary)}; ${sent} lines sent to the AI check`);
    for (const r of rows) console.log(`    needs a look ${r.number || "-"}${r.blocking ? " (blocking)" : ""}: ${r.reason}`);
    for (const r of autoRows) console.log(`    auto-resolved ${r.number || "-"} ${r.label.slice(0, 40)}: ${r.notes.join(" | ").slice(0, 140)}`);
    const titles = ["Introduction", "Project Description", "Supporting Calculations", "Risk Considerations", "Approval Process", "Schedule & Implementation Overview"];
    check("RIICWD525E (the BSBHRM613 case): Needs a look no longer lists items 1, 2, 4, 5, 6 (or 7): the report sections on pages 65-67", !rows.some((r) => titles.some((t) => r.label.includes(t))), rows.map((r) => r.label));
    check("RIICWD525E: those sections are section headings in the draft (section labels), with their page kept", titles.every((t) => flattenQuestions(draft).some((f) => isSectionHeading(f.question) && plainTextOf(f.question).includes(t) && (f.question.importMeta?.page ?? 0) >= 65)), titles);
    check("RIICWD525E: the 'Short answer' label left out of '6. Approval Process' is under Auto-resolved with its reason", autoRows.some((r) => r.notes.some((n) => /"Short answer"/.test(n))), autoRows.map((r) => r.label));
    check("RIICWD525E: no question was turned into a heading by the rules except numbered template sections (fields such as 'Prepared by' stay questions)", flattenQuestions(draft).filter((f) => isSectionHeading(f.question)).every((f) => /^\d{1,2}[.)]?$/.test(String(f.question.importMeta?.number ?? "")) || f.question.importMeta?.classification?.by === "ai" || /<h4>/.test(String(f.question.config?.html))) && items.some((i) => i.text === "Prepared by" && i.itemType === "question"));
    check("RIICWD525E: at most 5 items on Needs a look, and 2 drawings", rows.length <= 5 && rd.summary.drawings === 2, [rows.length, rd.summary.drawings]);
  }
}
// ------------------------------------------------------------------ ASM-BUILDER-COMPACT + ASM-UNIT-CHECK (2026-11-25)
{
  const { classifyByRules, responseAreaKind, classifyPart } = await import("../supabase/functions/_shared/asm-import/classify.ts");
  const { sameHeading, pairedNumber, cleanOutline, checkChunk, assemble, pendingClassification, applyClassification, READER_VERSION } = await import("../supabase/functions/_shared/asm-import/pipeline.ts");
  const { readClassification, mockClassifyAnswer, classifyRequest } = await import("../supabase/functions/_shared/asm-import/classify.ts");
  const { definitionFromAi, mergeParserExtras } = await import("../src/lib/assessment/aiDraft");
  const { rowChips, rowTitle, isOptional, partsSummary, checkRows } = await import("../src/lib/assessment/checkList");
  const { checkUnit, unitDecisionError } = await import("../src/lib/assessment/workbookFiling");
  const { newQuestion, isAnswerable } = await import("../src/lib/assessment/registry");
  type AiOutline = import("../supabase/functions/_shared/asm-import/schema.ts").AiOutline;
  type AiTaskPart = import("../supabase/functions/_shared/asm-import/schema.ts").AiTaskPart;

  // A1 the same header repeated with formatting differences
  check("headers: 'Assessment Task 1 - Written Assessment (Knowledge Application)' and 'Assessment Task - 1 Written Assessment' are one", sameHeading("Assessment Task 1 - Written Assessment (Knowledge Application)", "Assessment Task - 1 Written Assessment") && sameHeading("ASSESSMENT TASK 1: Written assessment", "Assessment Task 1 - Written Assessment") && !sameHeading("Assessment Task 1 - Written Assessment", "Assessment Task 2 - Project") && !sameHeading("Task 1", "Task 1 Project"));
  const dupOutline = cleanOutline({ document_kind: "workbook", title: null, qualification_code: null, qualification_name: null, unit_code: null, unit_name: null, version: null, tasks: [
    { number: "1", title: "Assessment Task 1 - Written Assessment (Knowledge Application)", kind: "written", first_page: 8, last_page: 15 },
    { number: "1", title: "Assessment Task - 1 Written Assessment", kind: "written", first_page: 16, last_page: 22 },
    { number: "2", title: "Assessment Task 2 - Project", kind: "project", first_page: 27, last_page: 88 }] } as AiOutline, [{ page: 8, text: "x", scanned: false }, { page: 88, text: "x", scanned: false }]);
  check("headers: the outline listing the same task twice becomes one task over both page ranges", dupOutline.tasks.length === 2 && dupOutline.tasks[0].first_page === 8 && dupOutline.tasks[0].last_page === 22, dupOutline.tasks);

  // A3 answer areas; A4 table rows; numbers printed in pairs
  check("answer areas: 'Submission of Supporting Evidence…' is an upload box, 'Mathematics Calculation Box…' a calculation box, an evidence item to submit is not", responseAreaKind({ kind: "evidence", text: "Submission of Supporting Evidence Please upload the Graphs into your Assessment Pack" }) === "upload" && responseAreaKind({ kind: "evidence", text: "Mathematics Calculation Box If you're unable to write your mathematical equations" }) === "calc" && responseAreaKind({ kind: "evidence", text: "Completed Risk Assessment Worksheet" }) === null && classifyByRules({ kind: "evidence", number: null, text: "Mathematics Calculation Box" }).type === "response_label");
  check("table rows: 'k. Selection approval' is a table_row; 'k. Describe the approval process' is not", classifyByRules({ kind: "question", number: "k.", text: "Selection approval" }).type === "table_row" && classifyByRules({ kind: "question", number: "k.", text: "Describe the approval process" }).type !== "table_row" && classifyPart("k.", "Work health and safety") === "table_row" && classifyPart("a.", "Explain why the subgrade must be tested before sealing") === "question");
  check("numbers: the model's 'Q3' becomes 1.3 when the page prints 'Q3 | Q1.3 | Satisfactory'; alone it stays", pairedNumber("Q3", ["Q3 | Q1.3 | Satisfactory\nDescribe the types"]) === "Q1.3" && pairedNumber("Q6", ["Provide references"]) === "Q6" && pairedNumber("Q1.3", ["Q3 | Q1.3 | Satisfactory"]) === "Q1.3");

  // B row rules
  const q = (o: Partial<Question>): Question => ({ ...newQuestion(o.type ?? "long_answer"), ...o }) as Question;
  check("rows: the title is the first sentence, cut short", rowTitle(q({ label: "Identify and briefly describe the legislation required to select pavement surfacing. Include at least three acts." })) === "Identify and briefly describe the legislation required to select pavement surfacing." && rowTitle(q({ label: "x".repeat(200) })).length === 90);
  check("rows: chips show how it is answered (table, upload, calc) and never 'required'", JSON.stringify(rowChips(q({ type: "table_grid", required: true }))) === "[\"table\"]" && JSON.stringify(rowChips(q({ required: true, importMeta: { confidence: "high", responseAreas: [{ kind: "upload", text: "Submission…", page: 12 }, { kind: "calc", text: "Calculation box", page: 12 }] } }))) === "[\"upload\",\"calc\"]" && !rowChips(q({ required: true })).includes("required"));
  check("rows: only a question that is not required shows 'optional'; an instruction never does", isOptional(q({ required: false })) && !isOptional(q({ required: true })) && !isOptional(q({ type: "instruction", required: false })));
  check("rows: sub-parts / table rows are summarised for the collapsed row ('6 parts', '16 rows')", partsSummary(q({ type: "case_study", children: Array.from({ length: 6 }, () => newQuestion("short_answer")) })) === "6 parts" && partsSummary(q({ type: "table_grid", config: { rows: Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, label: String(i) })) } })) === "16 rows" && partsSummary(q({})) === null);

  // C unit check
  const sel = { code: "BSBHRM613", name: "Contribute to the development of learning and development strategies" };
  check("unit: a matching unit passes silently (no message)", checkUnit({ code: "RIICWD525E", name: "Select pavement surfacing" }, { code: "riicwd525e", name: "Select Pavement Surfacing" }).status === "match" && checkUnit({ code: "RIICWD525E", name: "Select" }, { code: "RIICWD525E", name: "x" }).message === null);
  const mm = checkUnit({ code: "RIICWD525E", name: "Select Pavement surfacing" }, sel);
  check("unit: a mismatch blocks with 'This workbook looks like RIICWD525E but you selected BSBHRM613'", mm.status === "mismatch" && mm.message === "This workbook looks like RIICWD525E but you selected BSBHRM613", mm);
  check("unit: without a code in the PDF the titles are compared", checkUnit({ code: null, name: "Select pavement surfacing" }, { code: "RIICWD525E", name: "Select Pavement surfacing" }).status === "match" && checkUnit({ code: null, name: "Select pavement surfacing" }, sel).status === "mismatch" && checkUnit({ code: null, name: null }, sel).status === "unknown");
  check("unit: 'Keep' without a reason is rejected; with one, and 'Switch', are accepted", unitDecisionError({ kind: "kept", reason: " " }) !== null && unitDecisionError({ kind: "kept", reason: "Mapped by compliance" }) === null && unitDecisionError({ kind: "switched", reason: "" }) === null);
  check("reader version: 4 (table rows, answer areas, merged headings, printed number pairs)", READER_VERSION === 4);

  // E the recorded extraction of this assessment (32ed667c was published from the owner's reader-2 import, asm_import_jobs f86772cb)
  const answers2 = [process.env.ASM_AI_ANSWERS_2, workbookPath ? workbookPath.replace(/\.pdf$/i, ".ai-answers-2.json") : null].find((p) => p && existsSync(p));
  if (!workbookPath || !answers2) console.log("SKIP - RIICWD525E compact draft (workbook or its .ai-answers-2.json not found)");
  else {
    const { pageTextsFromPdf } = await import("../src/lib/assessment/pageText");
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdf.getDocument({ data: new Uint8Array(readFileSync(workbookPath)), verbosity: 0 }).promise;
    const regions = await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps);
    const texts = await pageTextsFromPdf(doc as unknown as PdfDocLike, regions);
    const rec = JSON.parse(readFileSync(answers2, "utf8")) as { outline: AiOutline; plan: { task: number; from: number; to: number }[]; answers: AiTaskPart[] };
    const outline = cleanOutline(rec.outline, texts);
    const results = rec.plan.map((c, k) => { const sec = checkChunk(rec.answers[k], c, texts); applyClassification(sec, readClassification(mockClassifyAnswer(classifyRequest(pendingClassification(sec, texts))))); return sec; });
    const rd = assemble("workbook", outline, rec.plan, results, { provider: "openai", model: "recorded", scannedPages: 0 });
    const pictures = regions.map((r) => ({ ...r, src: `data:image/jpeg;base64,UElD${r.page}` }));
    const { lines, version } = await linesFromPdf(doc as unknown as PdfDocLike);
    const parsed = buildFromLines(lines, { fileName: "RIICWD525E.pdf", version, images: pictures });
    const draft = mergeParserExtras(definitionFromAi(rd, pictures), parsed.definition, rd.tasks.map((t) => ({ firstPage: t.firstPage, lastPage: t.lastPage })));
    const nums = workbookNumbering(draft);
    const t1 = draft.tasks[0];
    const t1qs = t1.sections.flatMap((s) => s.questions).filter((x) => isAnswerable(x));
    const label = (x: Question) => `${nums.get(x.id)?.number ?? "-"}`;
    console.log(`  RIICWD525E compact draft: task 1 sections [${t1.sections.map((s) => s.title).join(" | ")}], numbers ${t1qs.map(label).join(", ")}; task 2 ${draft.tasks[1]?.sections.length} sections`);
    check("E: Task 1 is a single group of questions (the repeated header merged, the instruction-only parts moved to the task's ⓘ)", t1.sections.length === 1 && /Assessment Task 1/i.test(t1.sections[0].title) && /Provide your response to each question in the box below/.test(t1.instructions), t1.sections.map((s) => s.title));
    // ASM-OVERVIEW: "Q6" (provide references) is the reference list, a requirement of the task, never a numbered question
    check("E: Task 1 numbering is clean and printed: 1.1-1.5, then the reference list and the declaration (requirements)", t1qs.map(label).join(",") === "1.1,1.2,1.3,1.4,1.5,Reference list,Student declaration", t1qs.map(label));
    // an occasion ("Occasion 2") numbers its activities within it: numbers are unique per task, the occasions counted apart
    const dupes = draft.tasks.map((t) => { const seen = new Map<string, number>(); for (const s of t.sections) for (const x of s.questions) { const n = nums.get(x.id)?.number; const k = OCCASION_TITLE.test(s.title) ? `${s.title}|${n}` : n; if (n && k && isAnswerable(x)) seen.set(k, (seen.get(k) ?? 0) + 1); } return [...seen].filter(([, c]) => c > 1).map(([n]) => n); });
    check("E: no duplicate question numbers in any task (or within an occasion)", dupes.every((d) => d.length === 0), dupes);
    check("E: the upload / calculation boxes take no number: they are response types (upload, calc) of Q1.1", !flattenQuestions(draft).some((f) => /^(Submission of Supporting Evidence|Mathematics Calculation Box)/.test(f.question.label)) && JSON.stringify(rowChips(t1qs[0])) === "[\"upload\",\"calc\"]" && t1qs[0].config?.allowAttachment === true, rowChips(t1qs[0]));
    const q12 = t1qs[1];
    const rows = (q12.config?.rows as { label: string }[] | undefined) ?? [];
    check("E: 2k-2p are table rows of Q1.2 (16 categories a-p, answered per row), not questions of their own", q12.type === "table_grid" && rows.length === 16 && rows[10].label === "k. Selection approval" && rows[15].label === "p. Workplace recording and reporting" && !flattenQuestions(draft).some((f) => f.question !== q12 && /^Selection approval$|^Statutory compliance$/.test(f.question.label)), rows.map((r) => r.label));
    check("E: the category table answers in one 'Answer' column (the first column names the rows)", JSON.stringify((q12.config?.columns as { label: string }[]).map((c) => c.label)) === "[\"Answer\"]");
    const occ = draft.tasks[1].sections.filter((s) => OCCASION_TITLE.test(s.title));
    const occNums = occ.map((s) => s.questions.filter((x) => x.role === "activity").map(label).join(","));
    // ASM-OVERVIEW: each occasion numbers its activities within it (Occasion 1: 2.1-2.9, Occasion 2: 2.1-2.10); the response
    // templates no activity names (printed 2.1.10, 2.1.11) stay in Occasion 1, named, not numbered
    check("E: task 2 activities numbered within each occasion (2.1-2.9, then 2.1-2.10); unmatched templates named, in Occasion 1", occ.length === 2 && occNums[0] === "2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9" && occNums[1] === "2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9,2.10" && occ[0].questions.filter((x) => x.role === "template").map(label).join("|") === "Record Log and Clarification Response Summary|Validation Summary Report", [occNums, occ[0].questions.filter((x) => x.role === "template").map(label)]);
    check("E: Needs a look stays empty for this workbook", checkRows(draft, nums).length === 0, checkRows(draft, nums).map((r) => r.reason));
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
      item({ kind: "drawing", text: "Wiring diagram of the test circuit", pages: [5] }),
      item({ kind: "drawing", text: "Site plan", pages: [9] }),
    ] }] }],
  };
  const def = definitionFromAi(doc, [{ page: 5, x: 0, top: 500, bottom: 300, width: 200, height: 200, src: "data:image/jpeg;base64,QQ==" }]);
  const qs = def.tasks[0].sections[0].questions;
  check("ai draft: text to read (an instruction item) goes to the task's instructions, not among the questions", /Answer in your own words, 50-150 words each\./.test(def.tasks[0].instructions) && !qs.some((q) => /Answer in your own words/.test(String(q.config?.html ?? ""))), def.tasks[0].instructions);
  // ASM-OVERVIEW: a drawing with its picture is supporting material of the task; one without a picture stays a flagged block
  check("ai draft: item kinds become question types (long answer, parts, table, upload; a drawing without a picture a block)", qs.map((q) => q.type).join(",") === "long_answer,case_study,table_grid,file_upload,instruction", qs.map((q) => q.type));
  check("ai draft: text kept word for word, printed number kept, original stored for traceability", qs[0].label === doc.tasks[0].sections[0].items[1].text && qs[0].importMeta?.number === "1.1" && qs[0].importMeta?.original === qs[0].label && qs[0].importMeta?.via === "ai");
  check("ai draft: parts are child questions numbered 1.2a / 1.2b; the reworded part is flagged with the PDF wording", qs[1].children?.map((c) => c.importMeta?.number).join(",") === "1.2a,1.2b" && Boolean(qs[1].children?.[1].importMeta?.flags?.length) && qs[1].children?.[1].importMeta?.pdfText === "Parallel circuits");
  check("ai draft: the table keeps its columns and rows", JSON.stringify((qs[2].config?.columns as { label: string }[]).map((c) => c.label)) === "[\"Load\",\"Voltage\"]" && (qs[2].config?.rows as unknown[]).length === 2);
  const drawing = def.tasks[0].materials?.find((m) => m.kind === "drawing");
  check("ai draft: the drawing carries the workbook's picture from its page, as the task's material (with its page)", /<img src="data:image\/jpeg/.test(String(drawing?.html)) && drawing?.pages.join() === "5" && drawing?.title === "Wiring diagram of the test circuit", drawing);
  check("ai draft: a drawing with no picture on its page is flagged with what to do", !/<img/.test(String(qs[4].config?.html)) && qs[4].importMeta?.flags?.[0] === "No picture found on page 9: add the drawing from the PDF", qs[4].importMeta?.flags);
  check("ai draft: no answer or guidance in the definition", forbiddenKey(def) === null && def.source?.unit?.code === "AURETR112" && def.source?.version === "1.0");
  check("ai draft: the PDF export numbers questions as printed", workbookNumbering(def).get(qs[0].id)?.number === "1.1");
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
  check("ai guide: answers attach by number and part by part; the benchmark is What to look for", k(qs[0].id)?.modelAnswer === "I = V / R" && k(qs[1].children?.[0].id)?.modelAnswer === "One path" && k(qs[1].children?.[1].id)?.modelAnswer === "Many paths" && k(qs[3].id)?.assessorGuidance === "The meter is connected in series.");
  check("ai guide: 1.3 has no answer -> listed as missing; counts 3 of 4", ok.outcome.missing.includes(qs[2].id) && ok.outcome.matched === 3 && ok.outcome.total === 4, [ok.outcome.matched, ok.outcome.total]);
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
// ------------------------------------------------------------------ ASM-AI-IMPORT stages 3-4: the student's progress, reference, the unit outcome
{
  const { studentQuestions, referenceItems, isAnswered, taskProgress, unitOutcome, taskOutcomeFromMarks } = await import("../src/lib/assessment/studentFlow");
  const task: Task = { id: "t1", title: "Written", instructions: "Answer in your own words, 50-150 words each.", sections: [{ id: "s1", title: "Questions", questions: [
    { id: "i1", type: "instruction", label: "", config: { html: "<figure><img src=\"data:image/jpeg;base64,QQ==\" /></figure><p><em>Wiring diagram</em></p>" }, importMeta: { page: 44, confidence: "high" } },
    { id: "q1", type: "long_answer", label: "Explain Ohm's law", required: true },
    { id: "q2", type: "case_study", label: "Describe each", children: [{ id: "q2a", type: "short_answer", label: "Series" }, { id: "q2b", type: "short_answer", label: "Parallel" }] },
    { id: "q3", type: "file_upload", label: "Upload a photo" },
    { id: "q4", type: "observation_checklist", label: "Observed by the assessor", assessorOnly: true },
    { id: "q5", type: "declaration", label: "Student declaration" },
  ] }] };
  check("student flow: the student answers questions, parts and uploads; never the assessor checklist or the declaration", studentQuestions(task).map((q) => q.id).join(",") === "q1,q2,q3");
  const refs = referenceItems(task, 1);
  check("student flow: the task instructions and the drawing go to the Reference drawer (title, page)", refs.length === 2 && refs[0].title === "Task 1 instructions" && refs[1].hasPicture && refs[1].title === "Wiring diagram" && refs[1].page === 44, refs.map((r) => [r.title, r.page]));
  const ev = [{ id: "e1", questionId: "q3", groupIndex: null, byAssessor: false, path: "p", fileName: "photo.jpg", mime: "image/jpeg", bytes: 10, createdAt: "" }];
  check("student flow: a question with parts is answered only when every part is", !isAnswered(task.sections[0].questions[2], { q2: { q2a: "one path" } }) && isAnswered(task.sections[0].questions[2], { q2: { q2a: "one path", q2b: "two paths" } }));
  check("student flow: an upload counts once a file is there; blank rich text is not an answer", isAnswered(task.sections[0].questions[3], {}, ev) && !isAnswered(task.sections[0].questions[1], { q1: "<p> </p>" }));
  check("student flow: 2 of 3 answered", JSON.stringify(taskProgress(task, { q1: "Current equals voltage over resistance", q2: { q2a: "x" } }, ev)) === JSON.stringify({ answered: 2, total: 3 }));
  const tasks = [{ id: "t1" }, { id: "t2" }];
  check("unit outcome: every task Satisfactory -> Competent", unitOutcome(tasks, { t1: "S", t2: "S" }) === "C");
  check("unit outcome: any task Not Satisfactory -> Not Yet Competent", unitOutcome(tasks, { t1: "S", t2: "NYS" }) === "NYC" && unitOutcome(tasks, { t1: "NYS", t2: "NYS" }) === "NYC");
  check("unit outcome: a task not decided yet -> no outcome", unitOutcome(tasks, { t1: "S" }) === null && unitOutcome(tasks, { t1: "NYS" }) === null && unitOutcome([], {}) === null);
  check("task outcome from the marks: all S -> S, any NS -> NYS, unmarked -> none", taskOutcomeFromMarks(["a", "b"], { a: "S", b: "S" }) === "S" && taskOutcomeFromMarks(["a", "b"], { a: "S", b: "NYS" }) === "NYS" && taskOutcomeFromMarks(["a", "b"], { a: "S" }) === null);
}
// ------------------------------------------------------------------ ASM-AI-IMPORT stage 5: signatures stamped on the workbook PDF
{
  // a real 600 x 200 PNG, as the signing pad makes it (drawn with @napi-rs/canvas)
  const { createCanvas } = await import("@napi-rs/canvas");
  const pad = (stroke: number) => { const c = createCanvas(600, 200); const g = c.getContext("2d"); g.strokeStyle = "#0d1a4d"; g.lineWidth = 3; g.beginPath(); g.moveTo(40, 150); g.lineTo(200 + stroke, 40); g.lineTo(380, 160); g.stroke(); return c.toBuffer("image/png").toString("base64"); };
  const def: Definition = { instructions: "", tasks: [{ id: "t1", title: "Written", sections: [{ id: "s1", title: "Questions", questions: [
    { id: "q1", type: "long_answer", label: "Explain Ohm's law", required: true, markingMode: "criteria" },
    { id: "d1", type: "declaration", label: "Student declaration", config: { text: "I declare this work is my own." } },
  ] }] }], source: { unit: { code: "AURETR112", name: "Test and repair basic electrical circuits" }, version: "1.1" } };
  const attemptRow = (no: number, outcome: "S" | "NYS") => ({ id: `a${no}`, attemptNo: no, state: (no === 2 ? "final" : "returned") as "final" | "returned", submittedAt: `2026-11-2${no}T01:00:00Z`, returnedAt: `2026-11-2${no}T05:00:00Z`, finalisedAt: no === 2 ? "2026-11-22T05:00:00Z" : null, outcome, overallFeedback: "", assessor: "Wendy Workbook", tasks: [{ taskId: "t1", outcome, feedback: `Feedback ${no}`, signedAt: `2026-11-2${no}T05:00:00Z`, assessor: "Wendy Workbook" }] });
  const sigRows = [
    { kind: "student_declaration" as const, attemptNo: 1, signerName: "Sam Student", signaturePng: pad(0), signedAt: "2026-11-20T23:00:00Z" },
    { kind: "assessor_signoff" as const, attemptNo: 1, signerName: "Wendy Workbook", signaturePng: pad(20), signedAt: "2026-11-21T05:00:00Z" },
    { kind: "student_acknowledgement" as const, attemptNo: 1, signerName: "Sam Student", signaturePng: pad(40), signedAt: "2026-11-21T07:00:00Z" },
    { kind: "student_declaration" as const, attemptNo: 2, signerName: "Sam Student", signaturePng: pad(60), signedAt: "2026-11-21T23:00:00Z" },
    { kind: "assessor_signoff" as const, attemptNo: 2, signerName: "Wendy Workbook", signaturePng: pad(80), signedAt: "2026-11-22T05:00:00Z" },
  ];
  const base = { definition: def, title: "AURETR112", maxAttempts: 3, institution: { name: "Skyline Institute of Technology", lines: [], logo: null },
    history: { student: { id: "s", ref: "SK00000039", name: "Sam Student" }, trainers: ["Wendy Workbook"], assessment: null, attempts: [attemptRow(1, "NYS"), attemptRow(2, "S")], complete: true },
    attempt: { attemptNo: 2, responses: { q1: "Current equals voltage over resistance.", d1: { agreed: true, signature: "Sam Student" } }, assessorResponses: {}, results: [], evidence: [], submittedAt: "2026-11-22T01:00:00Z" } };
  const withSigs = await buildWorkbookPdf({ ...base, signatures: sigRows });
  const without = await buildWorkbookPdf(base);
  const textOf = async (bytes: Uint8Array) => { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const d = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise; const out: string[] = []; for (let p = 1; p <= d.numPages; p++) out.push(((await (await d.getPage(p)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ").replace(/\s+/g, " ")); return out.join("\n"); };
  const t = await textOf(withSigs);
  const images = (Buffer.from(withSigs).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
  check("pdf signatures: the five signature pictures are embedded (declarations, sign-offs, acknowledgement)", images >= 5, images);
  check("pdf signatures: the student declaration page prints the signer and the date it was signed", /Student Signature Sam Student · 22\/11\/2026/.test(t), t.match(/Student Signature[^\n]{0,60}/)?.[0]);
  check("pdf signatures: each results sheet has an assessor signature and a student acknowledgement row per attempt", /Assessor signature Wendy Workbook · 21\/11\/2026 Wendy Workbook · 22\/11\/2026/.test(t) && /Student acknowledgement Sam Student · 21\/11\/2026/.test(t), t.match(/Assessor signature[^\n]{0,120}/)?.[0]);
  check("pdf signatures: the assessment summary carries the assessor's signature and name, and the date signed", /Assessor Signature Wendy Workbook · 22\/11\/2026/.test(t) && /Trainer\/Assessor Wendy Workbook/.test(t));
  check("pdf signatures: the version (1.1 after edits) prints in the footer", /Version Number: 1\.1/.test(t));
  check("pdf signatures: without signatures the PDF is as before (no signature rows)", !/Assessor signature/.test(await textOf(without)));
}
// ------------------------------------------------------------------ ASM-BUILDER: the assessment page in the wizard's design
{
  const { checkRows, editCount, markReviewed, publishedBase, stableRows, withHtmlEdit, withLabelEdit, withNextVersion, asHtml, rowQuestionId } = await import("../src/lib/assessment/checkList");
  const { bumpVersion } = await import("../supabase/functions/_shared/asm-import/match.ts");
  const def: Definition = { tasks: [{ id: "t1", title: "Task", sections: [{ id: "s1", title: "A", questions: [
    { id: "i1", type: "instruction", label: "", config: { html: "<p>Read this</p>" }, importMeta: { confidence: "low", flags: ["Picture not read"] } },
    { id: "q1", type: "short_answer", label: "Name two hazards", importMeta: { confidence: "high", number: "1.1" } },
    { id: "q2", type: "short_answer", label: "Explain PPE", importMeta: { confidence: "low", note: "Text cut off", number: "1.2" } },
  ] }] }], source: { version: "1.0" } };
  const numbers = workbookNumbering(def);
  const rows = checkRows(def, numbers, null);
  check("builder needs a look: only flagged imported items are listed (instruction picture, cut-off text), no answer rows without a guide", rows.map((r) => r.id).join(",") === "i1,q2" && rows.every((r) => r.tag === "Import check"), rows);
  check("builder needs a look: the printed number is shown", rows.find((r) => r.id === "q2")?.number === "1.2");
  const reviewed = updateQuestion(def, "q2", markReviewed);
  const after = checkRows(reviewed, numbers, null);
  check("builder needs a look: a reviewed row leaves the computed list", after.length === 1 && after[0].id === "i1");
  const kept = stableRows(rows, after);
  check("builder needs a look: rows already listed stay listed in their place (struck through, not vanished)", kept.map((r) => r.id).join(",") === "i1,q2");
  check("builder needs a look: nothing flagged -> nothing listed (the list is hidden)", checkRows(updateQuestion(reviewed, "i1", markReviewed), numbers, null).length === 0);
  check("builder needs a look: an answer row id maps back to its question", rowQuestionId("q2#answer") === "q2");
  const who = { id: "u1", name: "Ada Admin" };
  const e1 = updateQuestion(def, "q1", (q) => withLabelEdit(q, "Name three hazards", who));
  const q1 = flattenQuestions(e1).find((f) => f.question.id === "q1")!.question;
  check("builder edit trace: the original wording, who and when are kept", q1.importMeta?.original === "Name two hazards" && q1.importMeta?.editedByName === "Ada Admin" && Boolean(q1.importMeta?.editedAt));
  const back = flattenQuestions(updateQuestion(e1, "q1", (q) => withLabelEdit(q, "Name two hazards", who))).find((f) => f.question.id === "q1")!.question;
  check("builder edit trace: putting the original back clears Edited", !back.importMeta?.editedAt && back.importMeta?.editedBy === null);
  const h1 = flattenQuestions(updateQuestion(def, "i1", (q) => withHtmlEdit(q, "<p>Read this first</p>", who))).find((f) => f.question.id === "i1")!.question;
  check("builder edit trace: an instruction block keeps its original HTML", h1.importMeta?.original === "<p>Read this</p>" && String(h1.config?.html) === "<p>Read this first</p>" && Boolean(h1.importMeta?.editedAt));
  check("builder edit count: questions whose text changed", editCount(e1) === 1 && editCount(def) === 0);
  // editing a published version: a fresh trace and the next printed version, once
  const published = publishedBase(e1);
  const p1 = flattenQuestions(published).find((f) => f.question.id === "q1")!.question;
  check("published edit: the trace starts again from the published wording", !p1.importMeta?.editedAt && p1.importMeta?.original === undefined && p1.label === "Name three hazards" && p1.importMeta?.number === "1.1");
  const v2 = updateQuestion(withNextVersion(published, bumpVersion), "q1", (q) => withLabelEdit(q, "Name four hazards", who));
  const p2 = flattenQuestions(v2).find((f) => f.question.id === "q1")!.question;
  check("published edit: Show original shows the published text", p2.importMeta?.original === "Name three hazards" && Boolean(p2.importMeta?.editedAt));
  check("published edit: the printed version moves on (1.0 -> 1.1)", v2.source?.version === "1.1");
  check("published edit: without a printed version the definition is unchanged (the PDF prints the version number)", withNextVersion({ tasks: [] }, bumpVersion).source === undefined);
  check("published edit: questions without import data are untouched", publishedBase({ tasks: [{ id: "t", title: "", sections: [{ id: "s", title: "", questions: [{ id: "x", type: "short_answer", label: "X" }] }] }] }).tasks[0].sections[0].questions[0].importMeta === undefined);
  check("instructions: plain text becomes paragraphs for the rich-text editor, HTML stays", asHtml("One\n\nTwo & <three>") === "<p>One</p><p>Two &amp; &lt;three&gt;</p>" && asHtml("<p>x</p>") === "<p>x</p>" && asHtml("") === "");
  const blankPdf = (d: Definition) => buildWorkbookPdf({ definition: d, title: "T", institution: { name: "Skyline", lines: [], logo: null }, blank: true, history: { student: null, trainers: [], assessment: null, attempts: [], complete: true }, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const allText = async (bytes: Uint8Array) => { const d = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise; let out = ""; for (let p = 1; p <= d.numPages; p++) out += ((await (await d.getPage(p)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ") + "\n"; return out; };
  const footer = await allText(await blankPdf(v2));
  check("published edit: the PDF footer prints Version Number 1.1", /Version Number: 1\.1/.test(footer), footer.slice(-200));
  // task instructions written in the rich-text editor print as text, not tags
  const html = await allText(await blankPdf({ tasks: [{ id: "t", title: "Practical", instructions: "<p>Bring <strong>boots</strong></p>", sections: [{ id: "s", title: "", questions: [{ id: "x", type: "short_answer", label: "X" }] }] }] }));
  check("task instructions in HTML print as text in the workbook PDF", /Bring\s+boots/.test(html) && !/<strong>/.test(html), html.slice(0, 200));
}
{
  const { tgaMerge, suggestionsByElement } = await import("../src/lib/assessment/unitElements");
  const tga = [
    { kind: "element", code: "1", text: "Prepare for work" },
    { kind: "performance_criterion", code: "1.1", text: "Work instructions are obtained", parent: "1" },
    { kind: "element", code: "2", text: "Do the work" },
    { kind: "performance_criterion", code: "2.1", text: "Tools are used safely", parent: "2" },
    { kind: "knowledge_evidence", code: "", text: "workplace safety requirements" },
  ];
  const first = tgaMerge([], tga);
  check("tga merge: an empty unit gets every row; criteria of new elements wait for a second pass", first.items.length === 3 && first.pending === 2 && first.added === 5, first);
  const saved = first.items.map((x, i) => ({ id: `id${i}`, kind: x.kind, parentId: x.parentId ?? null, code: x.code, text: x.text, sort: x.sort, isActive: true }));
  const second = tgaMerge(saved, tga);
  check("tga merge: the second pass places each criterion under its element", second.pending === 0 && second.items.find((x) => x.code === "2.1")?.parentId === "id1" && second.items.find((x) => x.code === "1.1")?.parentId === "id0", second.items);
  const manual = { id: "m1", kind: "assessment_condition", parentId: null, code: "", text: "Access to a workshop", sort: 9, isActive: true };
  const edited = [...saved.map((x) => (x.code === "2" ? { ...x, text: "Do the job" } : x)), manual];
  const third = tgaMerge(edited, tga);
  check("tga merge: a row with the same kind and code is updated in place, never duplicated", third.items.filter((x) => x.code === "2" && x.kind === "element").length === 1 && third.items.find((x) => x.code === "2")?.id === "id1" && third.items.find((x) => x.code === "2")?.text === "Do the work" && third.updated >= 1, third.items);
  check("tga merge: rows staff added by hand stay, after the training.gov.au rows", third.items.at(-1)?.id === "m1" && (third.items.at(-1)?.sort ?? 0) >= tga.length);
  check("tga merge: rows without a code match on their text (case and spaces ignored)", tgaMerge([{ id: "k", kind: "knowledge_evidence", parentId: null, code: "", text: "Workplace  safety requirements", sort: 0 }], tga).items.filter((x) => x.kind === "knowledge_evidence").length === 1);
  check("tga merge: inactive rows are not brought back by the merge", !tgaMerge([{ id: "gone", kind: "element", parentId: null, code: "9", text: "Old", sort: 0, isActive: false }], tga).items.some((x) => x.id === "gone"));
  const els = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
  const g = suggestionsByElement([
    { id: "s1", questionId: "q1", elementId: "e2", confidence: 0.6, reason: "", model: "m", state: "suggested", suggestedAt: "", decidedAt: null, decidedBy: null },
    { id: "s2", questionId: "q2", elementId: "e2", confidence: 0.9, reason: "", model: "m", state: "confirmed", suggestedAt: "", decidedAt: "x", decidedBy: "Ada" },
    { id: "s3", questionId: "q3", elementId: "e1", confidence: 0.7, reason: "", model: "m", state: "dismissed", suggestedAt: "", decidedAt: "x", decidedBy: "Ada" },
    { id: "s4", questionId: "q3", elementId: "zz", confidence: 0.7, reason: "", model: "m", state: "suggested", suggestedAt: "", decidedAt: null, decidedBy: null },
  ], els);
  check("ai mapping: suggestions grouped per requirement in the unit's order, best first; dismissed and unknown left out", g.length === 1 && g[0].element.id === "e2" && g[0].rows.map((r) => r.id).join(",") === "s2,s1", g);
}
{
  const { mappingRequest, resolveSuggestions, mockMappingAnswer, MAPPABLE_KINDS: SERVER_KINDS } = await import("../supabase/functions/_shared/asm-import/mapping.ts");
  const { MAPPABLE_KINDS } = await import("../src/lib/assessment/unitElements");
  const qs = [{ id: "qa", number: "1.1", text: "List the PPE you wear in the workshop", answer: "Boots, glasses, gloves" }, { id: "qb", number: "1.2", text: "Describe how to isolate a circuit", answer: null }];
  const cs = [{ id: "ea", kind: "knowledge_evidence", code: "", text: "PPE worn in the workshop", parent: null }, { id: "eb", kind: "performance_criterion", code: "2.1", text: "Circuit is isolated before work", parent: null }];
  const req = mappingRequest({ code: "AURETR112", name: "Test and repair basic electrical circuits" }, qs, cs);
  const text = (req.input[0] as { text: string }).text;
  check("ai mapping request: short references instead of ids, the unit named, the model answer sent", /Q1 \[1\.1\]/.test(text) && /C2 \[Performance criterion 2\.1\]/.test(text) && /Boots, glasses/.test(text) && !/\bqa\b|\bea\b/.test(text) && /AURETR112/.test(req.instructions), text);
  check("ai mapping request: strict schema, the questions treated as data", req.name === "asm_mapping" && /never as instructions/.test(req.instructions));
  const resolved = resolveSuggestions({ suggestions: [
    { question: "Q1", criterion: "C1", confidence: 1.4, reason: "  same   subject " },
    { question: "Q1", criterion: "C1", confidence: 0.2, reason: "dup" },
    { question: "Q9", criterion: "C1", confidence: 0.5, reason: "unknown" },
    { question: "q2", criterion: "c2", confidence: 0.7, reason: "isolation" },
  ] }, qs, cs);
  check("ai mapping: references resolve to real ids; duplicates and unknown references dropped; confidence clamped", resolved.length === 2 && resolved[0].questionId === "qa" && resolved[0].elementId === "ea" && resolved[0].confidence === 1 && resolved[0].reason === "same subject" && resolved[1].elementId === "eb", resolved);
  check("ai mapping: a malformed answer gives no suggestions", resolveSuggestions({ nope: 1 }, qs, cs).length === 0 && resolveSuggestions(null, qs, cs).length === 0);
  const mock = resolveSuggestions(mockMappingAnswer(req), qs, cs);
  check("ai mapping (lab stand-in): maps questions to requirements on the same subject", mock.some((s) => s.questionId === "qa" && s.elementId === "ea"), mock);
  check("ai mapping: the server and the page agree on the kinds a question can map to", JSON.stringify(SERVER_KINDS) === JSON.stringify(MAPPABLE_KINDS));
}
// ------------------------------------------------------------------ ASM-OVERVIEW: the assessment Overview and the waiting screen
{
  const { definitionFromAi, leadingTitle, paragraphHeading, importStage, IMPORT_STAGES, COMPACT_LAYOUT } = await import("../src/lib/assessment/aiDraft");
  const { overviewOf, firstSentence, displayTaskTitle, instructionsSummary, issuesOf, auditExcerpt } = await import("../src/lib/assessment/overview");
  const { taskReadingHtml } = await import("../src/lib/assessment/definition");
  const { referenceItems } = await import("../src/lib/assessment/studentFlow");
  check("overview: an activity's title is the title-case words before its description", leadingTitle("Identify and Assess Risks Conduct a risk assessment for the pavement surfacing project.") === "Identify and Assess Risks" && leadingTitle("Review Site and Supporting Documents Access, review and summarise relevant documentation") === "Review Site and Supporting Documents" && leadingTitle("Prepare Surfacing Selection Plan Document the full selection process") === "Prepare Surfacing Selection Plan" && leadingTitle("Determine traffic category based on traffic count") === null);
  check("overview: paragraph headings ('Assessment Instructions (How?)', 'Candidate Role:'), not sentence starts", paragraphHeading("Assessment Instructions (How?) Read the theoretical component")?.heading === "Assessment Instructions (How?)" && paragraphHeading("Candidate Role: Pavement Design Technician")?.heading === "Candidate Role" && paragraphHeading("Candidates must interpret this brief to: Evaluate pavement surfacing options") === null);
  check("overview: first sentence, task title without the workbook's 'Assessment Task - 2 -' prefix", firstSentence("Outline the policies. Then more.") === "Outline the policies." && displayTaskTitle("Task Assessment Task - 2: Assessment Task 2 - Project (Includes a role-play)") === "Project (Includes a role-play)" && displayTaskTitle("Assessment Task - 1 - Written Assessment") === "Written Assessment");
  const st = (state: "queued" | "running" | "done", label: string, done: number, total = 5) => importStage({ state, progress: { label, done, total } });
  check("waiting screen: four stages, from the job's real progress (queued, outline, task chunks, finishing, done)", IMPORT_STAGES.length === 4 && st("queued", "Starting", 0, 1).stage === 0 && st("running", "Reading task 1 of 2", 1).stage === 1 && st("running", "Reading task 2 of 2", 3).stage === 2 && st("running", "Finishing", 4).stage === 3 && st("done", "Done", 5).stage === 4);
  check("waiting screen: the percentage only moves forward with the job", [0, 1, 2, 3, 4].map((d) => st("running", d === 4 ? "Finishing" : "Reading", d).percent).every((p, i, a) => i === 0 || p >= a[i - 1]));
  const fx4 = [process.env.ASM_AI_ANSWERS_4, workbookPath ? workbookPath.replace(/\.pdf$/i, ".ai-answers-4.json") : null, "DNT_RII50520_RIICWD525E_Select Pavement surfacing.ai-answers-4.json"].find((p) => p && existsSync(p));
  if (!fx4) console.log("SKIP - RIICWD525E Overview (the reader-4 result .ai-answers-4.json not found)");
  else {
    const rd = (JSON.parse(readFileSync(fx4, "utf8")) as { result: import("../src/lib/assessment/aiDraft").CheckedDocument }).result;
    const pics = [44, 75].map((page) => ({ page, x: 0, top: 0, bottom: 0, width: 10, height: 10, src: `data:image/jpeg;base64,UElD${page}` }));
    const def = definitionFromAi(rd, pics);
    def.tasks[0].sections[0].questions.push(withSchema({ ...newQuestion("declaration"), label: "Student declaration" }));
    const numbers = workbookNumbering(def);
    const ov = overviewOf(def, numbers);
    const [t1, t2] = ov.tasks;
    type Row = Extract<(typeof t1)["rows"][number], { kind: "item" }>;
    const items = (t: typeof t1) => t.rows.filter((r): r is Row => r.kind === "item");
    console.log(`  RIICWD525E Overview: counts ${JSON.stringify(ov.counts)}; task 1 "${t1.title}" ${t1.count}; task 2 "${t2.title}" ${t2.count}; attached "${t2.attached}"`);
    check("D: the Overview layout is stamped (source.layout 2): compact, no re-import hint", def.source?.layout === COMPACT_LAYOUT && ov.compact && !ov.reimportHint);
    check("D: two task cards: Written Assessment (5 questions · 3 hrs) and Project (activities · 4 hrs)", ov.tasks.length === 2 && t1.title === "Written Assessment" && t1.count === "5 questions · 3 hrs" && t2.title === "Project (Includes a role-play)" && t2.count === "19 activities · 2 templates · 4 hrs", [t1.title, t1.count, t2.title, t2.count]);
    check("D: Task 1 questions are 1.1-1.5, nothing else numbered (no 'Q6', no hard-copy note row)", items(t1).map((r) => r.number).join(",") === "1.1,1.2,1.3,1.4,1.5" && !items(t1).some((r) => /hard copy/i.test(r.full)), items(t1).map((r) => r.number));
    check("D: the hard-copy note belongs to the upload box: Q1.1 shows upload and calc", items(t1)[0].chips.map((c) => c.kind).join(",") === "upload,calc" && /hard copy/i.test(items(t1)[0].question.importMeta?.responseAreas?.[0]?.note ?? ""), items(t1)[0].chips);
    const q12 = items(t1)[1];
    check("D: Q1.2 opens to 16 rows a-p in a grid (k = Selection approval)", q12.detail?.kind === "grid" && q12.detail.items.length === 16 && q12.detail.items[10].marker === "k" && q12.detail.items[10].text === "Selection approval" && q12.detail.items[15].marker === "p", q12.detail);
    check("D: Q1.4 shows '9 parts' and opens to them", items(t1)[3].chips.some((c) => c.label === "9 parts") && items(t1)[3].detail?.kind === "grid" && items(t1)[3].detail?.items.length === 9);
    check("D: Task 1 'Also required: Reference list · Student declaration'", t1.alsoRequired.map((r) => r.text).join(" · ") === "Reference list · Student declaration", t1.alsoRequired);
    check("D: Task 1 learner instructions = one block: '7 sections · method, how, when, specifications, context, resources, evidence'", t1.instructions?.summary.startsWith("7 sections · method, how, when, specifications, context, resources, evidence") === true && (def.tasks[0].instructionPages ?? []).includes(8), t1.instructions?.summary);
    const acts = items(t2).filter((r) => r.question.role === "activity");
    const occ1 = acts.slice(0, 9);
    check("D: Task 2 Occasion 1: 9 activities numbered 2.1-2.9, each with its deliverable as a chip", occ1.map((r) => r.number).join(",") === "2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9" && occ1.every((r) => r.chips.some((c) => c.kind === "deliverable")) && occ1[2].text === "Identify and Assess Risks" && occ1[2].chips[0].label === "Completed Risk Assessment Worksheet", occ1.map((r) => `${r.number} ${r.text}`));
    const plan = occ1[7];
    const planFields = plan.detail?.kind === "template" ? plan.detail.items : [];
    check("D: the Surfacing Selection Plan is ONE row: 'template · 12 fields', opening to its fields", plan.text === "Prepare Surfacing Selection Plan" && plan.chips.some((c) => c.label === "template · 12 fields") && planFields.filter((i) => i.kind === "field").length === 12 && ["Project", "Prepared by", "Approved by", "Date", "1. Introduction", "5. Risk Considerations"].every((f) => planFields.some((i) => i.text === f)), planFields);
    check("D: the empty parts 6. and 7. of the plan (no text read) are flagged, not silently blank", (plan.question.children ?? []).filter((c) => c.importMeta?.flags?.length).length === 2 && issuesOf(def, numbers).total >= 2);
    check("D: the Stakeholder Feedback Record & Approval Log is one template row too (4 fields)", occ1[8].chips.some((c) => c.label === "template · 4 fields"));
    type Label = Extract<(typeof t1)["rows"][number], { kind: "label" }>;
    const groups = t2.rows.filter((r): r is Label => r.kind === "label" && Boolean(r.group));
    const occ2 = acts.slice(9);
    check("D: Task 2 activities grouped 'Activities · Occasion 1' (open) and 'Activities · Occasion 2' (collapsed, 'Second observation of the same project')", groups.map((g) => g.text).join("|") === "Activities · Occasion 1|Activities · Occasion 2" && groups[0].group?.collapsed === false && groups[1].group?.collapsed === true && groups[1].group?.note === "Second observation of the same project", groups.map((g) => [g.text, g.group?.note, g.group?.collapsed]));
    check("D: Occasion 2 keeps its 10 activities, numbered within the group 2.1-2.10 (the 10th: Provide Implementation Clarification)", acts.length === 19 && occ2.map((r) => r.number).join(",") === "2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9,2.10" && occ2[9].text === "Provide Implementation Clarification" && occ2.every((r) => r.group === groups[1].group?.id), occ2.map((r) => `${r.number} ${r.text}`));
    check("D: Occasion 2 lists how it differs: 10 activities, what it adds, what it leaves out", groups[1].group?.differences[0] === "10 activities (the first occasion has 9)" && /Also asks for: .*Clarification Summary Memo/.test(groups[1].group?.differences[1] ?? "") && /Not asked again: Document Review Checklist; Surfacing Selection Plan Document/.test(groups[1].group?.differences[2] ?? ""), groups[1].group?.differences);
    const tplLabel = t2.rows.findIndex((r) => r.kind === "label" && r.text === "Response templates");
    const loose = items(t2).filter((r) => r.question.role === "template");
    check("D: the unmatched templates (printed 2.1.10, 2.1.11) are listed under Occasion 1 as 'Response templates', without numbers", tplLabel > 0 && loose.map((r) => r.text).join("|") === "Record Log and Clarification Response Summary|Validation Summary Report" && loose.every((r) => r.number === null && r.group === groups[0].group?.id) && t2.rows.indexOf(loose[0]) > tplLabel && t2.rows.indexOf(groups[1]) > t2.rows.indexOf(loose[1]), loose.map((r) => [r.number, r.text]));
    check("D: Task 2 general steps (10), and the uploads it accepts: graphs · calculations · additional work", t2.steps?.length === 10 && t2.uploadsAccepted.join(" · ") === "graphs · calculations · additional work" && t2.alsoRequired.map((r) => r.text).join() === "Reference list");
    const kinds = t2.materials.map((m) => `${m.kind}:${m.pages.join("-")}`).join(" ");
    check("D: supporting material with page ranges: case study, the two drawings (44-45, 75), the role-play brief (51-52)", kinds === "case_study:33-34 drawing:44-45 role_play:51-52 drawing:75" && t2.attached.startsWith("Case study, 2 drawings and role-play brief attached"), [kinds, t2.attached]);
    const brief = t2.materials.find((m) => m.kind === "role_play")?.html ?? "";
    check("D: the role-play brief opens to its headings with text (Candidate role, Stakeholder role, Scenario, Timing, Your task, Assessment focus)", ["Candidate Role", "Stakeholder Role", "Scenario", "Timing", "Your Task as Candidate", "Assessment Focus"].every((h) => new RegExp(`<h4>${h}`).test(brief)), brief.slice(0, 300));
    check("D: counts in the strip come from the item roles (2 tasks, 7 questions incl. 2 templates, 19 activities)", ov.counts.tasks === 2 && ov.counts.questions === 7 && ov.counts.activities === 19 && ov.counts.uploads >= 4, ov.counts);
    check("D: the learner still reads everything: steps and materials in the task's reading text and the Reference drawer", /General task steps/.test(taskReadingHtml(def.tasks[1])) && /Role-Play Brief/.test(taskReadingHtml(def.tasks[1])) && referenceItems(def.tasks[1], 2).filter((r) => r.hasPicture).length === 2);
    check("D: no assessor data in the Overview layout; the definition validates", forbiddenKey(def) === null && validateDefinition(def).length === 0, validateDefinition(def));
    // an older import (no layout 2) still renders: the plain list of the task's items, and the hint to re-import
    const old = structuredClone(def); delete old.source!.layout;
    const legacy = overviewOf(old, workbookNumbering(old));
    check("D: an older AI import renders with the fallback list and 'Re-import to get the compact view'", !legacy.compact && legacy.reimportHint && legacy.tasks.length === 2 && legacy.tasks[0].rows.length > 0);
    check("D: a hand-built assessment (no import) has no re-import hint", !overviewOf({ tasks: [{ id: "t", title: "Task 1", sections: [{ id: "s", title: "S", questions: [withSchema({ ...newQuestion("long_answer"), label: "Explain." })] }] }] }, new Map()).reimportHint);
    check("D: instruction summaries count the paragraph headings", instructionsSummary("<h4>Assessment Instructions (How?)</h4><p>x</p><h4>Required resources.</h4><p>y</p>").summary === "2 sections · how, resources");
    // A2 audit: before / after are capped at 4000 characters; an edit at the end of a long block must still be in the row
    const long = "Read the instructions carefully. ".repeat(200);
    const ex = auditExcerpt(long, `${long}Bring a calculator.`);
    check("A2: a long block's audit keeps the changed part (an edit at the end is not cut away), each side at most 4000 characters", ex.after.includes("Bring a calculator.") && !ex.before.includes("Bring a calculator.") && ex.before.startsWith("…") && ex.after.length <= 4000 && ex.before.length <= 4000, [ex.before.length, ex.after.slice(-60)]);
    check("A2: a short block's audit keeps both texts whole", JSON.stringify(auditExcerpt("old text", "new text")) === JSON.stringify({ before: "old text", after: "new text" }));
  }
}
// ASM-PDF-TEMPLATE (2026-11-26): the workbook PDF as an e-sign style template. The detector reads what the PDF draws: question header
// rows, answer boxes (and where they continue), "Short answer" zones, tables, Yes / No circles, tick squares, rating rows, label
// cells, writing lines; page kinds and who sees them. Synthetic pages always; the two real workbooks when they are on this machine.
{
  const { detectTemplate } = await import("../src/lib/assessment/pdfTemplate/detect");
  const { pageModel } = await import("../src/lib/assessment/pdfTemplate/pageModel");
  const { templateProblems } = await import("../src/lib/assessment/pdfTemplate/model");
  const { wizardSteps, questionInputs, tablesOf, missingItems, fitChain } = await import("../src/lib/assessment/pdfTemplate/student");
  // fit: 10 pt down to 8 pt, then the rest on a continued page (stand-in measure: half the font size a character)
  const half = (s: string, size: number) => s.length * size * 0.5;
  const shortFit = fitChain("Gloves protect the hands.", [{ page: 3, wPt: 300, hPt: 40 }], half);
  check("TPL fit: a short answer prints at 10 pt in its box", shortFit.size === 10 && shortFit.overflowLines === 0 && shortFit.boxes[0].lines.length === 1, shortFit);
  const midFit = fitChain("word ".repeat(50).trim(), [{ page: 3, wPt: 300, hPt: 50 }], half);
  check("TPL fit: a longer answer gets smaller (never under 8 pt) before anything moves", midFit.overflowLines === 0 && midFit.size < 10 && midFit.size >= 8, midFit.size);
  const longFit = fitChain("word ".repeat(400).trim(), [{ page: 3, wPt: 300, hPt: 40 }, { page: 4, wPt: 300, hPt: 40 }], half);
  check("TPL fit: what does not fit at 8 pt flows to the next box, then to a continued page", longFit.size === 8 && longFit.boxes[1].lines.length === longFit.boxes[1].capacity && longFit.overflowLines > 0, [longFit.size, longFit.overflowLines]);
  type PM = import("../src/lib/assessment/pdfTemplate/pageModel").PageModel;
  const W = 595, H = 842;
  const t = (s: string, x: number, y: number, h = 10) => ({ s, x, y, w: s.length * h * 0.5, h });
  const r = (x: number, y: number, w: number, h: number, fill: string | null, stroke: string | null = null) => ({ x, y, w, h, fill, stroke });
  const circle = (x: number, y: number) => ({ x, y, w: 10.5, h: 10.5, fill: null, stroke: "#374151" });
  const blank = (page: number): PM => ({ page, W, H, rects: [], lines: [], curves: [], texts: [] });
  // p1: question Q8 / printed 2.1.8 with two "Short answer" zones; its box runs to the foot of the page
  const p1 = blank(1);
  p1.texts.push(t("Assessment Task - 1 – Written Assessment", 55, 170, 12));
  p1.rects.push(r(43.5, 193, 45.6, 48, "#f8f9fa"), r(89, 193, 362, 48, "#f8f9fa"), r(451, 193, 101.7, 48, "#f8f9fa"), r(43.5, 242, 509, 548, "#f5f7ff"),
    r(51.7, 300, 492, 90, "#f5f7ff"), r(51.7, 450, 492, 330, "#f5f7ff"));
  p1.texts.push(t("Q8", 48, 200), t("Q2.1.8", 98, 200), t("Surfacing Selection Plan Document", 98, 214), t("Satisfactory", 476, 200), t("Response", 481, 210), t("Yes", 484, 226), t("No", 524, 226),
    t("1. Introduction", 51, 272), t("Short answer", 51, 286), t("2. Project Description", 51, 422), t("Short answer", 51, 436));
  p1.curves.push(circle(469, 224), circle(509, 224));
  // p2: the box goes on at the top of the next page and stops half way; p3: a box at the top after a box that stopped is not a continuation
  const p2 = blank(2); p2.rects.push(r(43.5, 143, 509, 260, "#f5f7ff"));
  const p3 = blank(3); p3.rects.push(r(43.5, 143, 509, 189, "#f5f7ff")); p3.texts.push(t("Written Evidence Checklist", 43, 350, 14));
  // p4: results sheet: S / NS circles, a Date line and a Feedback box for the first attempt
  const p4 = blank(4);
  p4.texts.push(t("Assessment Task - 1 – Results Sheet", 55, 160, 14), t("First attempt:", 180, 195), t("Satisfactory (S)", 195, 235), t("Not Satisfactory (NS)", 310, 235), t("Date:", 180, 262), t("Feedback:", 180, 285));
  p4.curves.push(circle(180.7, 236), circle(295, 236));
  p4.lines.push({ x: 213, y: 269.6, w: 96, h: 0.7, dir: "h" });
  p4.rects.push(r(180.7, 297.7, 362.7, 59, null, "#333333"));
  const tpl = detectTemplate([p1, p2, p3, p4], { path: "a/b.pdf", sha256: "a".repeat(64) }, "2026-11-26T00:00:00Z");
  const q = tpl.questions[0];
  check("TPL a question is keyed by its printed number (Q8 / Q2.1.8 -> 2.1.8), its running number kept", tpl.questions.length === 1 && q.key === "2.1.8" && q.seq === "Q8" && q.label === "Surfacing Selection Plan Document", tpl.questions);
  check("TPL the answer box that reaches the foot of the page continues at the top of the next page", q.areas.map((a) => a.page).join(",") === "1,2" && tpl.pages[1].kind === "continuation", q.areas);
  check("TPL a box at the top after one that stopped half way is not a continuation (page 90 rule)", tpl.pages[2].kind !== "continuation" && !tpl.fields.some((f) => f.page === 3 && f.questionKey), tpl.pages[2]);
  const ans = tpl.fields.filter((f) => f.questionKey === "2.1.8" && f.role === "student");
  check("TPL each 'Short answer' zone is a text field named by the heading above it", ans.filter((f) => f.page === 1).map((f) => f.label).join(" | ") === "1. Introduction | 2. Project Description", ans.map((f) => f.label));
  check("TPL the continued box is one more answer field on page 2", ans.some((f) => f.page === 2 && f.kind === "text"));
  const yn = tpl.fields.filter((f) => f.questionKey === "2.1.8" && f.kind === "yes_no");
  check("TPL the trainer's Satisfactory Yes / No: two choices of one group", yn.length === 2 && yn.every((f) => f.role === "trainer" && f.group === "q.2.1.8") && yn.map((f) => f.option).join() === "yes,no", yn);
  const res = tpl.fields.filter((f) => f.page === 4);
  check("TPL results sheet: S / NS, Date and Feedback are the trainer's, for the first attempt", res.length === 4 && res.every((f) => f.role === "trainer" && f.attempt === 1) && res.some((f) => f.kind === "date") && res.some((f) => f.kind === "text" && f.label === "Feedback"), res);
  check("TPL a results sheet is trainer-only; the task runs from its title page to its sheet", tpl.pages[3].kind === "results_sheet" && tpl.pages[3].audience === "trainer" && tpl.tasks[0]?.firstPage === 1 && tpl.tasks[0]?.lastPage === 4, tpl.pages);
  check("TPL the detected template satisfies the database's rules", templateProblems(tpl).length === 0, templateProblems(tpl));
  const bad = structuredClone(tpl); bad.fields[0].role = "auto"; bad.fields.push({ ...bad.fields[1] });
  check("TPL an auto field without its record value, and an id used twice, are refused", templateProblems(bad).length === 2, templateProblems(bad));
  const bad2 = structuredClone(tpl);
  bad2.fields[0] = { ...bad2.fields[0], step: "acknowledge" };
  bad2.fields.push({ id: "m1", page: 1, x: 0.1, y: 0.1, w: 0.02, h: 0.02, role: "auto", kind: "auto", questionKey: null, label: "By hand", dataKey: "submission_method" });
  check("TPL an answer cannot wait for the acknowledgement; a submission method box says which method it is", templateProblems(bad2).length === 2, templateProblems(bad2));

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const detectFile = async (file: string) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
    const models: PM[] = [];
    for (let n = 1; n <= doc.numPages; n++) models.push(await pageModel(pdfjs as never, await doc.getPage(n) as never, n));
    return detectTemplate(models, { path: "x/y.pdf", sha256: "b".repeat(64) });
  };
  if (!workbookPath) console.log("SKIP - TPL RIICWD525E template (file not found; set ASM_WORKBOOK)");
  else {
    const rt = await detectFile(workbookPath);
    const keys = rt.questions.map((x) => x.key).join(" ");
    check("TPL RII: 28 questions by printed number (1.1-1.5, 2.1.1-2.1.11, 2.2.1-2.2.10) and the two reference lists as <task>.references", rt.questions.length === 28 && keys.startsWith("1.1 1.2 1.3 1.4 1.5 1.references 2.1.1") && keys.includes("2.1.11 2.2.1") && keys.endsWith("2.2.10 2.references"), keys);
    check("TPL RII: questions are named as their header row prints them (Q2.1.8, References), never an invented number", rt.questions.find((x) => x.key === "2.1.8")?.display === "Q2.1.8" && rt.questions.filter((x) => /references/.test(x.key)).every((x) => x.display === "References" && /^(Provide|A reference list)/.test(x.label)), rt.questions.filter((x) => /references|2\.1\.8/.test(x.key)).map((x) => [x.key, x.display, x.label.slice(0, 30)]));
    {
      const steps = wizardSteps(rt);
      const shape = steps.map((s) => s.kind === "read" ? `read${s.pages[0]}-${s.pages[s.pages.length - 1]}` : s.kind === "question" ? "q" : s.kind === "declaration" ? `decl${s.page}` : s.kind).join(" ");
      check("TPL RII wizard: details, Task 1 pages 8-12, its 6 questions, its declaration (p26), Task 2 pages 27-54, 11 questions, the brief (74-79), 11 questions, declaration (p95), evaluation, review",
        shape === `details read8-12 ${"q ".repeat(6)}decl26 read27-54 ${"q ".repeat(11)}read74-79 ${"q ".repeat(11)}decl95 evaluation review`, shape);
      const q12 = questionInputs(rt, "1.2");
      const q12s = q12.map((x) => x.kind === "text" ? `${x.field.label.slice(0, 2)}${x.boxes.map((b) => b.page).join("+")}` : x.kind).join(" ");
      check("TPL RII wizard: 1.2 is its parts a-p in order, each named by its printed heading (a from the header row, j from the foot of page 15); part e's box goes on at the top of page 15 as the same answer",
        q12s === "a.14 b.14 c.14 d.14 e.14+15 f.15 g.15 h.15 i.15 j.16 k.16 l.16 m.16 n.16 o.17 p.17" && q12.every((x) => x.kind === "text" && x.field.required), q12s);
      const b = tablesOf(rt.fields.filter((f) => f.questionKey === "2.1.9" && f.role === "student"));
      check("TPL RII 2.1.9: the 'Signature / Authority (Assessor Use)' column is the trainer's, never the student's", rt.fields.filter((f) => f.questionKey === "2.1.9" && f.role === "trainer" && f.kind === "table_cell").length >= 3 && b.every((t) => t.columns.every((c) => !/Assessor Use/.test(c.label))), b.map((t) => t.columns.map((c) => c.label)));
      check("TPL RII wizard: the student is shown each question without the trainer's Satisfactory Yes / No column", rt.questions.every((x) => x.prompt && x.prompt.page === x.header.page && x.prompt.x + x.prompt.w < x.header.x + x.header.w - 0.1),
        rt.questions.filter((x) => !(x.prompt && x.prompt.x + x.prompt.w < x.header.x + x.header.w - 0.1)).map((x) => x.key));
      const empty = missingItems(rt, {}, []);
      check("TPL RII wizard: nothing answered = 28 unanswered questions, the two task declarations and the whole-pack declaration to sign", empty.length === 31 && empty.filter((m) => m.code === "unanswered").length === 28
        && empty.slice(-3).map((m) => m.message).join(" | ") === "Sign the Task 1 declaration. | Sign the Task 2 declaration. | Sign the student declaration (page 7).", empty.slice(-3).map((m) => m.message));
      // every answer field filled
      const pdf: Record<string, string> = {};
      for (const x of rt.fields.filter((y) => y.role === "student" && y.questionKey && y.kind !== "signature")) pdf[x.id] = "Answer";
      const all = ["decl:1", "decl:2", "pack"];
      check("TPL RII wizard: everything answered and the three declarations signed = nothing missing; Appendix B stays optional", missingItems(rt, { pdf }, all).length === 0, missingItems(rt, { pdf }, all).slice(0, 3));
      const part = { ...pdf }; delete part[q12[2].kind === "text" ? q12[2].field.id : ""];
      check("TPL RII wizard: a required part left empty is listed by its printed name and part", missingItems(rt, { pdf: part }, all).map((m) => m.message).join() === "Q1.2: \"c. Environmental protection\" is empty.", missingItems(rt, { pdf: part }, all));
      check("TPL RII wizard: each declaration is its own signature, signed at its moment", missingItems(rt, { pdf }, ["decl:1", "pack"]).map((m) => m.message).join() === "Sign the Task 2 declaration.");
      const sigs = rt.fields.filter((x) => x.kind === "signature").map((x) => `${x.page}:${x.role[0]}:${x.slot}${x.attempt ? `@${x.attempt}` : ""}`).join(" ");
      check("TPL RII signatures: p7 the whole-pack declaration, p26 / p95 the task declarations, the summary's student row the acknowledgement per attempt, every trainer line the assessor's sign-off",
        sigs === "7:s:pack 26:s:decl:1 26:t:signoff 95:s:decl:2 95:t:signoff 96:t:signoff@1 96:t:signoff@2 96:t:signoff@3 96:s:ack@1 96:s:ack@2 96:s:ack@3 99:t:signoff", sigs);
      check("TPL RII: every date beside a signature is that signature's date; the acknowledgement row waits for the result", rt.fields.filter((x) => x.dataKey === "signed_date").every((x) => x.slot) && rt.fields.filter((x) => x.slot === "ack").every((x) => x.step === "acknowledge"));
      const perfRii = rt.fields.filter((x) => x.checklist === "performance" && x.option === "yes");
      check("TPL RII checklists: Task 1's five Performance rows are questions 1.1-1.5; Task 2's ten activity rows (not one per question) stay the trainer's", perfRii.filter((x) => x.questionKey).map((x) => x.questionKey).join() === "1.1,1.2,1.3,1.4,1.5" && perfRii.filter((x) => !x.questionKey).length === 10);
      check("TPL RII written evidence: the 2.1 list names questions of section 2.1, the 2.2 list of section 2.2", rt.fields.filter((x) => x.checklist === "written" && x.option === "yes" && x.page === 91).every((x) => x.questionKey?.startsWith("2.2.")) && rt.fields.filter((x) => x.checklist === "written" && x.option === "yes" && x.page === 90 && x.questionKey).every((x) => x.questionKey!.startsWith("2.1.")));
      {
        const { markingMissing } = await import("../src/lib/assessment/pdfTemplate/output");
        const left = markingMissing(rt, rt.questions.map((q) => ({ questionId: q.key, outcome: "S" as const })), {});
        check("TPL release (RII): all questions marked still leaves the 13 Evidence rows and Task 2's 10 activity Performance rows to tick", left.length === 23 && left.every((m) => m.startsWith("Marking checklist, page ")), [left.length, left[0]]);
      }
    }
    check("TPL RII: two tasks with their whole titles", rt.tasks.map((x) => `${x.number}:${x.title}`).join(" | ") === "1:Written Assessment | 2:Project (Includes a role-play)", rt.tasks);
    check("TPL RII: every question has the trainer's Yes / No", rt.questions.every((x) => rt.fields.filter((f) => f.questionKey === x.key && f.kind === "yes_no" && f.role === "trainer" && f.group === `q.${x.key}`).length === 2));
    check("TPL RII: every question has somewhere to answer", rt.questions.every((x) => rt.fields.some((f) => f.questionKey === x.key && f.role === "student")), rt.questions.filter((x) => !rt.fields.some((f) => f.questionKey === x.key && f.role === "student")).map((x) => x.key));
    check("TPL RII: 1.2 continues over pages 14-17; 2.1.8 over 65-67", rt.questions.find((x) => x.key === "1.2")?.areas.map((a) => a.page).join() === "14,15,16,17" && rt.questions.find((x) => x.key === "2.1.8")?.areas.map((a) => a.page).join() === "65,66,67");
    const p90 = rt.pages[89];
    check("TPL RII page 90: the references box continues (the student's) and the evidence checklist below is the trainer's", p90.kind === "continuation" && p90.audience === "student" && rt.fields.some((f) => f.page === 90 && f.questionKey === "2.references" && f.role === "student") && rt.fields.filter((f) => f.page === 90 && f.role === "trainer" && f.kind === "yes_no").length === 20, p90);
    const trainerPages = rt.pages.filter((x) => x.audience === "trainer").map((x) => x.page).join(",");
    check("TPL RII: marking checklists, evidence checklist, results sheets, summary and Appendix A never reach the student", trainerPages === "23,24,25,91,92,93,94,96,97,98,99", trainerPages);
    check("TPL RII: Appendix B is the student's: 90 rating choices (18 rows of five) and the comment boxes", rt.fields.filter((f) => f.kind === "rating" && f.role === "student").length === 90 && rt.pages.filter((x) => x.kind === "appendix_b").every((x) => x.audience === "student"));
    const autos = (page: number) => rt.fields.filter((f) => f.page === page && f.kind === "auto").map((f) => f.dataKey).join(",");
    check("TPL RII: auto fields from the record on the cover, the details page and the summary", autos(1) === "student_name,student_id" && autos(3) === "student_name,student_id,student_email,trainer_name" && ["student_name", "student_id", "start_date", "end_date"].every((k) => autos(96).includes(k)), [autos(1), autos(3), autos(96)]);
    check("TPL RII: signatures: the student's (declarations, summary) and the trainer's apart", rt.fields.filter((f) => f.kind === "signature" && f.role === "student").length === 6 && rt.fields.filter((f) => f.kind === "signature" && f.role === "trainer").length === 6);
    const method = rt.fields.filter((f) => f.page === 4 && f.dataKey === "submission_method");
    check("TPL RII page 4: the four submission method boxes are auto, the LMS one is the online method", method.length === 4 && method.every((f) => f.role === "auto" && f.kind === "auto") && method.map((f) => f.option).sort().join() === "email,hand,lms,other" && /LMS/.test(method.find((f) => f.option === "lms")?.label ?? ""), method.map((f) => [f.option, f.label]));
    const ack = rt.fields.filter((f) => f.page === 96 && f.step === "acknowledge");
    check("TPL RII summary sheet: the student's row (signature + date per attempt) is signed when acknowledging the result", ack.length === 6 && ack.filter((f) => f.kind === "signature" && f.role === "student").map((f) => f.attempt).join() === "1,2,3" && ack.filter((f) => f.dataKey === "signed_date" && f.slot === "ack").length === 3, ack.map((f) => [f.kind, f.dataKey, f.attempt]));
    check("TPL RII: no other field waits for the acknowledgement", rt.fields.filter((f) => f.step === "acknowledge").length === 6);
    check("TPL RII: the detected template satisfies the database's rules", templateProblems(rt).length === 0, templateProblems(rt).slice(0, 3));
  }
  const cpcPath = [process.env.ASM_WORKBOOK_2, "CPC30620_CPCCPD2012_Use painting and decorating tools and equipment.pdf", `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/CPC30620_CPCCPD2012_Use painting and decorating tools and equipment.pdf`].find((p) => p && existsSync(p));
  if (!cpcPath) console.log("SKIP - TPL CPCCPD2012 template (file not found; set ASM_WORKBOOK_2)");
  else {
    const ct = await detectFile(cpcPath);
    check("TPL CPC: unprinted questions take <task>.<running number> (1.1-1.3, 2.1-2.11)", ct.questions.map((x) => x.key).join(" ") === "1.1 1.2 1.3 2.1 2.2 2.3 2.4 2.5 2.6 2.7 2.8 2.9 2.10 2.11", ct.questions.map((x) => x.key));
    check("TPL CPC: the 1.3 table continues on page 16 and its empty cells are table cells with row and column", ct.questions.find((x) => x.key === "1.3")?.areas.map((a) => a.page).join() === "15,16"
      && ct.fields.some((f) => f.questionKey === "1.3" && f.kind === "table_cell" && f.table?.rowLabel === "Buckets" && f.table?.column === "Uses"));
    check("TPL CPC: every question has the trainer's Yes / No and somewhere to answer", ct.questions.every((x) => ct.fields.filter((f) => f.questionKey === x.key && f.kind === "yes_no" && f.group === `q.${x.key}`).length === 2 && ct.fields.some((f) => f.questionKey === x.key && f.role === "student")));
    const method = ct.fields.filter((f) => f.page === 4 && f.dataKey === "submission_method");
    check("TPL CPC page 4: the four submission method boxes are auto, the LMS one is the online method", method.length === 4 && method.every((f) => f.role === "auto" && f.kind === "auto") && method.map((f) => f.option).sort().join() === "email,hand,lms,other" && /LMS/.test(method.find((f) => f.option === "lms")?.label ?? ""), method.map((f) => [f.option, f.label]));
    const ack = ct.fields.filter((f) => f.page === 47 && f.step === "acknowledge");
    check("TPL CPC summary sheet: the student's row (signature + date per attempt) is signed when acknowledging the result", ack.length === 6 && ack.filter((f) => f.kind === "signature" && f.role === "student").map((f) => f.attempt).join() === "1,2,3" && ack.filter((f) => f.dataKey === "signed_date" && f.slot === "ack").length === 3, ack.map((f) => [f.kind, f.dataKey, f.attempt]));
    check("TPL CPC: no other field waits for the acknowledgement", ct.fields.filter((f) => f.step === "acknowledge").length === 6);
    {
      const steps = wizardSteps(ct);
      const shape = steps.map((s) => s.kind === "read" ? `read${s.pages[0]}-${s.pages[s.pages.length - 1]}` : s.kind === "question" ? s.title : s.kind === "declaration" ? `decl${s.page}` : s.kind).join(" ");
      check("TPL CPC wizard: Task 1 pages 8-12, Q1-Q3, declaration p19; Task 2 pages 20-36, Q1-Q11, declaration p46; evaluation; review", shape === "details read8-12 Q1 Q2 Q3 decl19 read20-36 Q1 Q2 Q3 Q4 Q5 Q6 Q7 Q8 Q9 Q10 Q11 decl46 evaluation review", shape);
      const q3 = questionInputs(ct, "1.3");
      check("TPL CPC Q3 (task 1): one table of 22 fixed rows (tool names as row titles) and the columns as printed, over pages 15-16", q3.length === 1 && q3[0].kind === "table" && q3[0].table.fixedRows && q3[0].table.rows.length === 22
        && q3[0].table.rows[0].label === "Brushware and accessories" && q3[0].table.columns.map((c) => c.label).join("|") === "Characteristics|Uses|Limitations", q3[0].kind === "table" ? [q3[0].table.rows.length, q3[0].table.columns.map((c) => c.label)] : q3);
      const q11 = questionInputs(ct, "2.11");
      check("TPL CPC Q11 (task 2): two tables, four open rows each", q11.length === 2 && q11.every((x) => x.kind === "table" && x.table.rows.length === 4 && !x.table.fixedRows)
        && q11[0].kind === "table" && q11[0].table.columns[0].label === "Tool / Equipment" && q11[1].kind === "table" && q11[1].table.columns[0].label === "Waste Type", q11.map((x) => x.kind === "table" ? x.table.columns.map((c) => c.label) : x.kind));
      check("TPL CPC wizard: nothing answered = 14 unanswered, two task declarations, the whole-pack declaration", missingItems(ct, {}, []).length === 17);
      const cpdf: Record<string, string> = {};
      for (const x of ct.fields.filter((y) => y.role === "student" && y.questionKey && y.kind !== "signature")) cpdf[x.id] = "Answer";
      const signedAll = ["decl:1", "decl:2", "pack"];
      check("TPL CPC wizard: everything filled and signed = nothing missing", missingItems(ct, { pdf: cpdf }, signedAll).length === 0, missingItems(ct, { pdf: cpdf }, signedAll).slice(0, 3));
      const q3cells = ct.fields.filter((x) => x.questionKey === "1.3" && x.kind === "table_cell");
      const oneEmpty = { ...cpdf }; delete oneEmpty[q3cells[5].id];
      check("TPL CPC Q3 (printed rows): every cell is required", missingItems(ct, { pdf: oneEmpty }, signedAll).map((m) => m.message).join() === "Task 1 · Q3: 1 empty cell in the table.", missingItems(ct, { pdf: oneEmpty }, signedAll));
      const q11cells = ct.fields.filter((x) => x.questionKey === "2.11" && x.kind === "table_cell");
      const t2 = q11cells.filter((x) => x.table?.group === q11cells[q11cells.length - 1].table?.group);
      const partial = { ...cpdf }; for (const x of t2) delete partial[x.id]; partial[t2[0].id] = "Paint tins";
      check("TPL CPC Q11 (blank rows): a part-filled row is not enough; at least one complete row of each table", missingItems(ct, { pdf: partial }, signedAll).map((m) => m.message).join() === "Q11: fill in at least one complete row of the table (table 2 of 2).", missingItems(ct, { pdf: partial }, signedAll));
      const oneRow = { ...partial }; for (const x of t2.filter((y) => y.table?.rowKey === t2[0].table?.rowKey)) oneRow[x.id] = "Done";
      check("TPL CPC Q11: one complete row is enough", missingItems(ct, { pdf: oneRow }, signedAll).length === 0, missingItems(ct, { pdf: oneRow }, signedAll));
      const perf = ct.fields.filter((x) => x.checklist === "performance" && x.option === "yes").map((x) => x.questionKey).join();
      check("TPL CPC marking checklists: the Performance rows are the task's questions in order (1.1-1.3, 2.1-2.11)", perf === "1.1,1.2,1.3,2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9,2.10,2.11", perf);
      check("TPL CPC: Evidence Outcome rows are the trainer's (13), written evidence rows name the 11 Task 2 questions", ct.fields.filter((x) => x.checklist === "evidence" && x.option === "yes").length === 13
        && ct.fields.filter((x) => x.checklist === "written" && x.option === "yes").map((x) => x.questionKey).join() === "2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,2.9,2.10,2.11");
      const pack = ct.declarations?.find((d) => d.kind === "pack");
      check("TPL CPC: the whole-pack declaration ('19. Student declaration', pages 6-7) is signed on page 7", pack?.page === 7 && pack.rects?.map((r) => r.page).join() === "6,7" && /^• I have read and understood/.test(pack.text) && /plagiarism checking\)\.$/.test(pack.text), pack && [pack.page, pack.text.slice(0, 40), pack.text.slice(-40)]);
      // output: the attempt drawn on the original PDF, a long answer on a continued page right after its page
      const { stampValues } = await import("../src/lib/assessment/pdfTemplate/output");
      const { stampPdf } = await import("../src/lib/assessment/pdfTemplate/stamp");
      const long = "Brushes and rollers are cleaned straight after use with the right solvent and stored hanging. ".repeat(60).trim();
      const answers: Record<string, string> = { ...cpdf, [ct.fields.find((x) => x.questionKey === "1.1" && x.role === "student")!.id]: long };
      const snap = { answers: { pdf: answers, pdfChoice: {} }, signatures: {}, record: { studentName: "Sue Student", studentRef: "S1234567", unitCode: "CPCCPD2012", unitName: "Use painting and decorating tools and equipment", submittedAt: "2026-11-25T00:00:00Z", startedAt: "2026-11-20T00:00:00Z", trainers: ["Tara Trainer"] }, hash: "c".repeat(64) };
      const marks = ct.questions.map((q) => ({ questionId: q.key, outcome: (q.key === "2.3" ? "NYS" : "S") as "S" | "NYS", feedback: "" }));
      const a1 = { id: "a1", attemptNo: 1, state: "returned", outcome: "NYS" as const, overallFeedback: "Redo Q3.", results: marks, taskResults: [{ taskId: "1", outcome: "S" as const, feedback: "Good", signedAt: "2026-11-26T00:00:00Z" }, { taskId: "2", outcome: "NYS" as const, feedback: "Q3", signedAt: "2026-11-26T00:00:00Z" }], assessorResponses: {}, snapshot: snap, signoff: null, acknowledgement: null, output: null };
      const a2 = { ...a1, id: "a2", attemptNo: 2, state: "final", outcome: "S" as const, results: marks.map((m) => ({ ...m, outcome: "S" as const })), taskResults: a1.taskResults.map((x) => ({ ...x, outcome: "S" as const, signedAt: "2026-11-28T00:00:00Z" })) };
      const bundle = { attemptId: "a2", attemptNo: 2, role: "trainer" as const, canAssess: true, template: ct, attempts: [a1, a2] };
      const values = stampValues(bundle);
      const pick = (pred: (x: typeof ct.fields[number]) => boolean) => ct.fields.filter(pred).filter((x) => values.get(x.id)?.kind === "tick").map((x) => `${x.option}@${x.attempt ?? "-"}`).join(" ");
      check("TPL output: the summary sheet shows each attempt in its own column (Task 2: No in attempt 1, Yes in attempt 2; final result Competent in attempt 2)",
        pick((x) => x.page === 47 && x.kind === "yes_no" && /Task - 2/.test(x.label)) === "no@1 yes@2" && pick((x) => x.page === 47 && x.kind === "yes_no" && /Final/.test(x.label)) === "no@1 yes@2", [pick((x) => x.page === 47 && /Task - 2/.test(x.label)), pick((x) => x.page === 47 && /Final/.test(x.label))]);
      check("TPL output: the written evidence rows are ticked Yes for the questions the student answered; the Performance rows follow the marks", pick((x) => x.checklist === "written") === Array(11).fill("yes@-").join(" ") && pick((x) => x.page === 43 && x.checklist === "performance").split(" ").length === 6);
      const stamped = await stampPdf(new Uint8Array(readFileSync(cpcPath)), ct, values, { footer: "snapshot" });
      const sdoc = await pdfjs.getDocument({ data: stamped.bytes.slice() }).promise;
      const textOf = async (n: number) => ((await (await sdoc.getPage(n)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ");
      check("TPL output: the long Q1 answer fills its box on page 13 and goes on a continued page inserted right after it (54 + 1 pages)", sdoc.numPages === 55 && stamped.continued.map((c) => `${c.afterPage}:${c.pages}`).join() === "13:1"
        && (await textOf(13)).includes("Brushes and rollers are cleaned") && /Continued from page 13/.test(await textOf(14)) && /Q1 \(continued\)/.test(await textOf(14)), [sdoc.numPages, stamped.continued]);
      {
        // the marking view: continued pages after the last page, so every original page keeps its number under the trainer's fields
        const atEnd = await stampPdf(new Uint8Array(readFileSync(cpcPath)), ct, values, { continuedAtEnd: true });
        const edoc = await pdfjs.getDocument({ data: atEnd.bytes.slice() }).promise;
        const eText = async (n: number) => ((await (await edoc.getPage(n)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ");
        check("TPL marking view: the continued page goes after page 54, pages 14 and 47 keep their numbers (the summary sheet stays page 47)", edoc.numPages === 55 && /Continued from page 13/.test(await eText(55))
          && !/Continued from page/.test(await eText(14)) && /ASSESSMENT SUMMARY SHEET/.test(await eText(47)), [edoc.numPages]);
      }
      check("TPL output: the summary sheet carries the record (student name, ID, unit) and the original page is otherwise unchanged", /Sue Student/.test(await textOf(48)) && /S1234567/.test(await textOf(48)) && /ASSESSMENT SUMMARY SHEET/.test(await textOf(48)));
      // the three declarations: each its own signature and its own date, printed on its own page (7, 19, 46)
      const { deflateSync, crc32 } = await import("node:zlib");
      const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
      const w = 60, h = 20; const raw = Buffer.alloc((w * 4 + 1) * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const ink = Math.abs(y - 10 - Math.round(6 * Math.sin(x / 5))) < 2; raw[o] = 13; raw[o + 1] = 26; raw[o + 2] = 77; raw[o + 3] = ink ? 255 : 0; }
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
      const sig = (at: string) => ({ signerName: "Sue Student", signaturePng: png, signedAt: at });
      const declSnap = { ...snap, answers: { pdf: cpdf, pdfChoice: {} }, signatures: { pack: sig("2026-11-24T02:00:00Z"), "decl:1": sig("2026-11-20T02:00:00Z"), "decl:2": sig("2026-11-22T02:00:00Z") } };
      const declBundle = { ...bundle, attemptId: "a1", attemptNo: 1, attempts: [{ ...a1, state: "submitted", snapshot: declSnap }] };
      const declPdf = await stampPdf(new Uint8Array(readFileSync(cpcPath)), ct, stampValues(declBundle, { trainer: false }));
      const ddoc = await pdfjs.getDocument({ data: declPdf.bytes.slice() }).promise;
      const datesOn = async (n: number) => ((await (await ddoc.getPage(n)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ").match(/\d{2}\/11\/2026/g) ?? [];
      const imagesOn = async (n: number) => { const ops = await (await ddoc.getPage(n)).getOperatorList(); return ops.fnArray.filter((op: number) => op === pdfjs.OPS.paintImageXObject).length; };
      const plain = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(cpcPath)) }).promise;
      const imagesBefore = async (n: number) => { const ops = await (await plain.getPage(n)).getOperatorList(); return ops.fnArray.filter((op: number) => op === pdfjs.OPS.paintImageXObject).length; };
      const seen = [] as string[];
      for (const [page, date] of [[7, "24/11/2026"], [19, "20/11/2026"], [46, "22/11/2026"]] as const) {
        const dates = await datesOn(page); const added = (await imagesOn(page)) - (await imagesBefore(page));
        seen.push(`p${page}:${dates.join("+")}:${added}`);
      }
      check("TPL output: the three declarations print their own signature and their own date (p7 the pack 24/11, p19 Task 1 20/11, p46 Task 2 22/11), never another's", seen.join(" ") === "p7:24/11/2026:1 p19:20/11/2026:1 p46:22/11/2026:1", seen);
      // the final PDF of attempt 2 shows both attempts' columns: each task-result date under its own attempt column of the summary sheet
      const colsDoc = await pdfjs.getDocument({ data: stamped.bytes.slice() }).promise;
      const summary = await colsDoc.getPage(48);
      const items = (await summary.getTextContent()).items as { str: string; transform: number[] }[];
      const head = (re: RegExp) => items.find((x) => re.test(x.str))!.transform[4];
      const c1 = head(/^1st Attempt/), c2 = head(/^2nd Attempt/), c3 = head(/^3rd Attempt/);
      const colOf = (x: number) => (x < (c1 + c2) / 2 ? 1 : x < (c2 + c3) / 2 ? 2 : 3);
      const placed = items.filter((x) => /^2[68]\/11\/2026$/.test(x.str)).map((x) => `${x.str.slice(0, 2)}@${colOf(x.transform[4])}`).sort().join(" ");
      check("TPL output: the summary sheet carries attempt 1's task dates in the 1st Attempt column and attempt 2's in the 2nd", placed === "26@1 26@1 28@2 28@2", placed);
      // the release waits for every question's mark and every checklist row the trainer ticks, each attempt on its own
      const { markingMissing } = await import("../src/lib/assessment/pdfTemplate/output");
      const none = markingMissing(ct, [], {});
      check("TPL release (CPC): nothing marked = 14 questions and 13 Evidence Outcome rows listed (the Performance rows follow the question marks)", none.length === 27 && none[0] === "Task 1 · Q1 is not marked yet."
        && none.includes('Marking checklist, page 17: "Submitted written answers covering all the questions." has no Yes / No.'), [none.length, none[0], none[14]]);
      const evGroups = [...new Set(ct.fields.filter((x) => x.checklist === "evidence").map((x) => x.group!))];
      const allS = ct.questions.map((q) => ({ questionId: q.key, outcome: "S" as const }));
      check("TPL release (CPC): all marked and every Evidence row answered = nothing missing", markingMissing(ct, allS, Object.fromEntries(evGroups.map((g) => [g, "yes"]))).length === 0);
      const firstEv = ct.fields.filter((x) => x.checklist === "evidence" && x.group === evGroups[0]);
      const hist = { ...bundle, attempts: [{ ...a1, assessorResponses: { pdfChoice: { [evGroups[0]]: "yes" } } }, { ...a2, assessorResponses: { pdfChoice: { [evGroups[0]]: "no" } } }] };
      const tickOf = (b: typeof hist, n: number) => firstEv.filter((x) => stampValues({ ...b, attemptNo: n, attemptId: n === 1 ? "a1" : "a2" }, { attemptNo: n }).get(x.id)?.kind === "tick").map((x) => x.option).join();
      check("TPL history: each attempt's PDF shows its own checklist (attempt 1 Yes, attempt 2 No on the same row), nothing overwritten", tickOf(hist, 1) === "yes" && tickOf(hist, 2) === "no", [tickOf(hist, 1), tickOf(hist, 2)]);

      check("TPL CPC wizard: a number printed in both tasks is named with its task in the review list", missingItems(ct, {}, []).slice(0, 4).map((m) => m.message).join(" | ") === "Task 1 · Q1 is not answered yet. | Task 1 · Q2 is not answered yet. | Task 1 · Q3 is not answered yet. | Task 2 · Q1 is not answered yet.", missingItems(ct, {}, []).slice(0, 4).map((m) => m.message));
    }
    check("TPL CPC: the detected template satisfies the database's rules", templateProblems(ct).length === 0, templateProblems(ct).slice(0, 3));
  }
}

// autosave with retry: a failed save never shows "Saved", is retried with the newest value, and submit knows it is not saved
{
  const { AutosaveQueue, saveLabel, retryDelay, classifySaveError } = await import("../src/lib/assessment/autosave");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sent: string[] = []; const states: string[] = []; let fail = 2;
  const kept: (string | null)[] = []; const store = { save: (v: string) => kept.push(v), clear: () => kept.push(null) };
  const q = new AutosaveQueue<string>(async (v) => { sent.push(v); if (fail > 0) { fail--; throw new Error("canceling statement due to statement timeout"); } }, (st) => states.push(st.state), { debounceMs: 1, retryMs: () => 15, store });
  q.queue("a");
  await wait(5);
  check("AUTOSAVE a failed save shows Not saved, retrying (never Saved) with the reason", q.status.state === "retrying" && saveLabel(q.status, "") === "Not saved, retrying…" && /statement timeout/.test(q.status.reason), q.status);
  check("AUTOSAVE submit waits: flush says not saved while the save fails", (await q.flush()) === false && q.pending);
  q.queue("b"); // typed on while it fails: the newest value is what gets saved
  await wait(60);
  check("AUTOSAVE retried until it went through, with the newest value, then Saved", sent.join() === "a,a,b" && q.status.state === "saved" && !q.pending && saveLabel(q.status, "") === "✓ Saved just now", [sent, states]);
  check("AUTOSAVE every unsaved value is kept in the browser and dropped once the server has it", kept.join("|") === "a|b|" && kept[kept.length - 1] === null, kept);
  check("AUTOSAVE flush with nothing waiting = saved", (await q.flush()) === true);
  check("AUTOSAVE retry waits 2 s, 4 s, 8 s … at most 30 s", [1, 2, 3, 5, 9].map(retryDelay).join() === "2000,4000,8000,30000,30000");
  check("AUTOSAVE failures told apart: no network / expired sign-in / other",
    classifySaveError(new TypeError("Failed to fetch"), true) === "offline" && classifySaveError(new Error("anything"), false) === "offline"
    && classifySaveError(Object.assign(new Error("JWT expired"), { status: 401, code: "PGRST301" }), true) === "auth"
    && classifySaveError(Object.assign(new Error("permission denied for function asm_student"), { status: 401, code: "42501" }), true) === "auth"
    && classifySaveError(Object.assign(new Error("This attempt was changed elsewhere"), { status: 400 }), true) === "error");
  // offline: shown as such, kept, saved at once when the connection comes back
  let online = false; const off: string[] = [];
  const qo = new AutosaveQueue<string>(async (v) => { if (!online) throw new TypeError("Failed to fetch"); off.push(v); }, () => undefined, { debounceMs: 1, retryMs: () => 60_000 });
  qo.queue("x"); await wait(5); qo.queue("y"); await wait(5);
  check("AUTOSAVE offline: Offline, will save when reconnected; typing on waits (no save attempt per keystroke)", qo.status.state === "offline" && saveLabel(qo.status, "") === "Offline, will save when reconnected" && qo.pending);
  online = true; qo.resume(); await wait(5);
  check("AUTOSAVE back online: the newest answers are saved at once", off.join() === "y" && qo.status.state === "saved", off);
  qo.stop();
  // expired sign-in: shown, never retried on a timer, saved again after signing in
  let signedIn = false; const exp: string[] = [];
  const qe = new AutosaveQueue<string>(async (v) => { if (!signedIn) throw Object.assign(new Error("JWT expired"), { status: 401, code: "PGRST301" }); exp.push(v); }, () => undefined, { debounceMs: 1, retryMs: () => 1 });
  qe.queue("m"); await wait(20);
  check("AUTOSAVE expired sign-in: Session expired, sign in again; the answers wait (no retry loop)", qe.status.state === "expired" && saveLabel(qe.status, "") === "Session expired, sign in again" && qe.status.failures === 1 && qe.pending);
  signedIn = true; qe.resume(); await wait(5);
  check("AUTOSAVE signed in again: saved", exp.join() === "m" && qe.status.state === "saved");
  qe.stop();
  const order: string[] = []; let release!: () => void;
  const q2 = new AutosaveQueue<string>((v) => { order.push(v); return v === "1" ? new Promise<void>((r) => { release = r; }) : Promise.resolve(); }, () => undefined, { debounceMs: 1 });
  q2.queue("1"); await wait(5); q2.queue("2"); await wait(5);
  check("AUTOSAVE a change made while a save runs waits for it (saves in order)", order.join() === "1", order);
  release(); await wait(10);
  check("AUTOSAVE … then is saved", order.join() === "1,2" && q2.status.state === "saved", order);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
