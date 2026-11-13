/**
 * Assessment Management: the question-type registry and the client-side mirrors of the database's validation and conditions.
 * Pure logic, no network. Run: npm run test:assessment-registry
 *
 * The fixture is the same definition the pgTAP suite (supabase/tests/assessment_management.sql) submits, so a rule that passes
 * here and there is the same rule on both sides of the wire.
 */
import { conditionMet } from "../src/lib/assessment/conditions";
import { cloneQuestion, countQuestions, earlierQuestionIds, flattenQuestions, moveItem, removeQuestion, updateQuestion } from "../src/lib/assessment/definition";
import { newQuestion, QUESTION_TYPES, questionType, withSchema } from "../src/lib/assessment/registry";
import type { Definition, Question } from "../src/lib/assessment/types";
import { forbiddenKey, schemaCheck, validateDefinition, validateResponses } from "../src/lib/assessment/validate";

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
check("assessor-only types never default to student marking", QUESTION_TYPES.filter((t) => t.assessorOnly).every((t) => t.defaultMarkingMode === "observation"));
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
