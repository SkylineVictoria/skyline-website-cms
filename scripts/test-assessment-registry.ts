/**
 * Assessment Management, pure logic (no network). Run: npm run test:assessment-registry
 * Since ASM-PDF-TEMPLATE phase 4 (2026-11-26) an assessment is its workbook PDF template: the detector, the student wizard's rules,
 * the marking / release rules, the stamped output, autosave, the unit check and the unit mapping helpers are tested here; the database
 * side of the same rules is supabase/tests/assessment_management.sql.
 */
import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-assessment-registry"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let passed = 0; let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`ok - ${name}`); } else { failed += 1; console.log(`NOT OK - ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}
// the RIICWD525E workbook (PDF) is not in the repo: ASM_WORKBOOK=<path>, else the repo root or Downloads
const workbookPath = [process.env.ASM_WORKBOOK, "DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf", `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf`].find((p) => p && existsSync(p));
void writeFileSync;

// ASM-UNIT-CHECK: the unit a workbook names against the assessment's unit (the PDF template tab; decisions audited)
{
  const { checkUnit, unitDecisionError } = await import("../src/lib/assessment/workbookFiling");
  const sel = { code: "BSBHRM613", name: "Contribute to the development of learning and development strategies" };
  check("unit: a matching unit passes silently (no message)", checkUnit({ code: "RIICWD525E", name: "Select pavement surfacing" }, { code: "riicwd525e", name: "Select Pavement Surfacing" }).status === "match" && checkUnit({ code: "RIICWD525E", name: "Select" }, { code: "RIICWD525E", name: "x" }).message === null);
  const mm = checkUnit({ code: "RIICWD525E", name: "Select Pavement surfacing" }, sel);
  check("unit: a mismatch blocks with 'This workbook looks like RIICWD525E but you selected BSBHRM613'", mm.status === "mismatch" && mm.message === "This workbook looks like RIICWD525E but you selected BSBHRM613", mm);
  check("unit: without a code in the PDF the titles are compared", checkUnit({ code: null, name: "Select pavement surfacing" }, { code: "RIICWD525E", name: "Select Pavement surfacing" }).status === "match" && checkUnit({ code: null, name: "Select pavement surfacing" }, sel).status === "mismatch" && checkUnit({ code: null, name: null }, sel).status === "unknown");
  check("unit: 'Keep' without a reason is rejected; with one, and 'Switch', are accepted", unitDecisionError({ kind: "kept", reason: " " }) !== null && unitDecisionError({ kind: "kept", reason: "Mapped by compliance" }) === null && unitDecisionError({ kind: "switched", reason: "" }) === null);
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

// ASM-ANY-LAYOUT (owner 2026-11-27): workbooks of any layout: candidates and rules (no AI), the classifier's answers checked against
// the real candidates, layout profiles, answer pages for small expanding boxes; the SLIT design keeps its detector unchanged.
{
  const { detectAny, applyClassification, questionLabel } = await import("../src/lib/assessment/pdfTemplate/generic");
  const { validateClassification, classifyRequest, estimateInputTokens } = await import("../supabase/functions/_shared/asm-import/classify.ts");
  const { correctionsFrom, applyProfile, areaKey } = await import("../src/lib/assessment/pdfTemplate/profile");
  const { detectTemplate } = await import("../src/lib/assessment/pdfTemplate/detect");
  const { pageModel } = await import("../src/lib/assessment/pdfTemplate/pageModel");
  const { templateProblems } = await import("../src/lib/assessment/pdfTemplate/model");
  const { stampPdf } = await import("../src/lib/assessment/pdfTemplate/stamp");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const modelsOf = async (file: string) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) out.push(await pageModel(pdfjs as never, await doc.getPage(n) as never, n));
    return out;
  };
  const AT = "2026-11-27T00:00:00Z";
  check("ANY labels: Question 1 / Q1 / 1. / 1.1 / Task 1 Question 2 / a) are question labels; plain text is not",
    ["Question 1", "Q1 Describe", "1. Describe", "1.1 Explain", "Task 1 Question 2", "a) Name it"].map((s) => questionLabel(s)?.num).join() === "1,1,1,1.1,1.2,a" && questionLabel("Describe the process") === null);
  // the SLIT design: the fast path returns exactly what its detector finds (no AI, nothing else)
  for (const file of [workbookPath, [process.env.ASM_WORKBOOK_2, "CPC30620_CPCCPD2012_Use painting and decorating tools and equipment.pdf"].find((p) => p && existsSync(p))]) {
    if (!file) { console.log("SKIP - ANY fast path (SLIT workbook not found)"); continue; }
    const ms = await modelsOf(file);
    const any = detectAny(ms, { path: "x/y.pdf", sha256: "b".repeat(64) }, AT);
    check(`ANY fast path: ${file.split(/[\\/]/).pop()!.slice(0, 24)} is read by the SLIT detector, unchanged`, any.path === "slit" && JSON.stringify(any.template) === JSON.stringify(detectTemplate(ms, { path: "x/y.pdf", sha256: "b".repeat(64) }, AT)) && any.unresolved.length === 0);
  }
  const p3035 = [process.env.ASM_WORKBOOK_3, "CPCCPD3035_Student Assessment Pack.pdf", `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/CPCCPD3035_Student Assessment Pack.pdf`].find((p) => p && existsSync(p));
  if (!p3035) console.log("SKIP - ANY CPCCPD3035 (file not found; set ASM_WORKBOOK_3)");
  else {
    const ms = await modelsOf(p3035);
    const run = detectAny(ms, { path: "x/y.pdf", sha256: "c".repeat(64) }, AT);
    const t = run.template;
    check("ANY CPCCPD3035: not the SLIT design, read by the generic rules; the template satisfies the database's rules", run.path === "generic" && templateProblems(t).length === 0, templateProblems(t).slice(0, 3));
    const p5 = t.questions.filter((q) => q.header.page === 5);
    const box = (k: string) => t.fields.filter((f) => f.questionKey === k && f.page === 5);
    check("ANY CPCCPD3035 page 5: Questions 1-3 by rules alone, each with its drawn box (exact position, found from four lines)",
      p5.map((q) => `${q.key}:${q.display}`).join() === "1.1:Question 1,1.2:Question 2,1.3:Question 3"
      && ["1.1", "1.2", "1.3"].every((k, i) => box(k).length === 1 && box(k)[0].origin === "rules" && Math.abs(box(k)[0].y * ms[4].H - [554, 637, 741][i]) < 1.5 && Math.abs(box(k)[0].x * ms[4].W - 68.5) < 1.5),
      p5.map((q) => [q.key, box(q.key).map((f) => Math.round(f.y * ms[4].H))]));
    check("ANY CPCCPD3035: the numbered instructions (1.-3. on page 5) are not questions", !t.questions.some((q) => q.header.page === 5 && /^\d\.$/.test(q.display ?? "")));
    check("ANY CPCCPD3035: Task 1 Questions 1-10 and Task 2's numbered templates 1-9", t.questions.filter((q) => q.task === 1).length === 10 && t.questions.filter((q) => q.task === 2).length >= 9, t.questions.map((q) => q.key));
    const rec = t.fields.filter((f) => f.page === 1 && f.kind === "auto").map((f) => f.dataKey).join();
    check("ANY CPCCPD3035 page 1: Student Name / Student Number / Date of Submission / Assessor Name are record fields", rec === "student_name,student_id,submission_date,trainer_name", rec);
    const perf = t.fields.filter((f) => f.checklist === "performance" && f.option === "yes").map((f) => f.questionKey).join();
    check("ANY CPCCPD3035 marking checklist: the Performance rows on page 34 follow Questions 1-4 (no Satisfactory column on the questions)", perf.startsWith("1.1,1.2,1.3,1.4"), perf);
    check("ANY CPCCPD3035 evaluation form: rating rows of five (1-5) by rules", t.fields.filter((f) => f.kind === "rating" && f.page === 30).length === 35 && t.fields.filter((f) => f.kind === "rating" && f.page === 31).length === 75);
    check("ANY CPCCPD3035: Office Use Only pages 33-37 are the trainer's", t.pages.filter((p) => p.page >= 33).every((p) => p.audience === "trainer") && t.pages.filter((p) => p.page < 33).every((p) => p.audience === "student"));
    const asked = [...new Set(run.unresolved.map((c) => c.page))];
    check("ANY CPCCPD3035: covers, instructions and text pages are never sent to the AI (only pages with open areas)", asked.every((p) => run.candidates.some((c) => c.page === p)) && ![2, 3, 9, 10, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 33].some((p) => asked.includes(p)), asked);
    // the classifier's answer: only real candidate numbers, each once
    const page = asked[0]; const open = run.unresolved.filter((c) => c.page === page);
    const v = validateClassification({ fields: [{ n: open[0].n, class: "trainer_field", question: null, kind: "text", record: null }, { n: open[0].n, class: "student_answer", question: null, kind: "text", record: null }, { n: 999, class: "student_answer", question: null, kind: "text", record: null }, { n: open[0].n + 0.5, class: "x", question: null, kind: "text", record: null }] }, open.map((c) => c.n));
    check("ANY classifier: an invented number, a repeat and a wrong class are refused; only real candidates are kept", v.fields.length === 1 && v.refused === 3);
    const req = classifyRequest({ page, imageDataUrl: "data:image/jpeg;base64,AAAA", imageWidth: 1100, imageHeight: 1556, candidates: open.map((c) => ({ n: c.n, shape: c.shape, left: c.left })) });
    check("ANY classifier: one page image + its numbered list; the schema allows the four classes only", req.input.length === 2 && JSON.stringify(req.schema).includes("not_a_field") && estimateInputTokens({ page, imageDataUrl: "", imageWidth: 1100, imageHeight: 1556, candidates: [] }) < 4000);
    // the answers: AI fields wait for Accept / Reject; not-a-field adds nothing
    const answers: Record<number, { n: number; class: "student_answer" | "trainer_field" | "record_field" | "not_a_field"; question: string | null; kind: "text" | "table_cell" | "yes_no" | "tick" | "signature" | "date"; record: string | null }[]> = {};
    for (const c of run.unresolved) (answers[c.page] ??= []).push({ n: c.n, class: c.page >= 33 ? "trainer_field" : c.page === 4 ? "not_a_field" : "student_answer", question: null, kind: c.shape === "tick" ? "tick" : "text", record: null });
    const merged = applyClassification(structuredClone(run), answers);
    const ai = merged.template.fields.filter((f) => f.origin === "ai");
    check("ANY classifier answers: added as AI fields waiting for review; 'not a field' adds nothing; the template stays valid",
      ai.length === merged.added && ai.every((f) => f.review === "pending") && merged.notFields === run.unresolved.filter((c) => c.page === 4).length && templateProblems(merged.template).length === 0, templateProblems(merged.template).slice(0, 2));
    // a layout profile: the admin's decisions (AI accepted, one rejected) are applied by themselves to the next workbook of this layout
    const final = structuredClone(merged.template);
    for (const f of final.fields) if (f.origin === "ai") f.review = "accepted";
    const rejected = final.fields.find((f) => f.origin === "ai" && f.page >= 33)!;
    final.fields = final.fields.filter((f) => f !== rejected);
    const runForProfile = { ...run, template: merged.template, settledBy: { ...run.settledBy } };
    const corrections = correctionsFrom(runForProfile, final);
    const next = detectAny(ms, { path: "x/y.pdf", sha256: "c".repeat(64) }, AT);
    const settled = applyProfile(next as never, { signature: "x", chrome: [], corrections });
    check("ANY layout profile: the saved decisions settle the same areas next time with no AI (a rejected one stays rejected)",
      settled > 0 && next.unresolved.length === 0 && !next.template.fields.some((f) => f.page === rejected.page && Math.abs(f.y - rejected.y) < 0.002 && Math.abs(f.x - rejected.x) < 0.002) && next.template.fields.some((f) => f.origin === "profile"),
      { settled, left: next.unresolved.length, keys: corrections.slice(0, 2).map((c) => c.key) });
    void areaKey;
    // small expanding boxes: an answer that does not fit at 8 pt points to an answer page added after its task
    const long = "Wear a P2 respirator and safety glasses when sanding. ".repeat(40);
    const field = t.fields.find((f) => f.questionKey === "1.1")!;
    const stamped = await stampPdf(new Uint8Array(readFileSync(p3035)), t, new Map([[field.id, { kind: "text", text: long, by: "student" } as const]]));
    const sdoc = await pdfjs.getDocument({ data: stamped.bytes.slice() }).promise;
    const text = async (n: number) => ((await (await sdoc.getPage(n)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ");
    const p5t = await text(5); const added = await text(9);
    check("ANY answer pages: the box says 'See answer page 9'; page 9 (after Task 1's last page, 8) starts with the question and holds the whole answer",
      sdoc.numPages === ms.length + 1 && /See answer page 9/.test(p5t) && /Answers \(continued from page 8\)/.test(added) && /Question 1/.test(added) && /safety requirements/.test(added) && (added.match(/P2 respirator/g) ?? []).length >= 30,
      { pages: sdoc.numPages, p5: p5t.slice(-60), p9: added.slice(0, 120) });
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
  // leftover drafts are kept 7 days at most from their last change (any person), then deleted when the app opens
  const { expireDrafts, DRAFT_MAX_AGE_MS } = await import("../src/lib/assessment/autosave");
  const now = Date.UTC(2026, 10, 26);
  const mem = new Map<string, string>([
    ["asm-draft:u1:a1", JSON.stringify({ v: {}, at: now - DRAFT_MAX_AGE_MS - 1 })],
    ["asm-draft:u2:a2", JSON.stringify({ v: {}, at: now - DRAFT_MAX_AGE_MS + 60_000 })],
    ["asm-draft:u3:a3", "not json"],
    ["other-setting", JSON.stringify({ at: 0 })],
  ]);
  const removed = expireDrafts(now, { getItem: (k) => mem.get(k) ?? null, removeItem: (k) => { mem.delete(k); }, keys: () => [...mem.keys()] });
  check("AUTOSAVE drafts older than 7 days (or unreadable) are deleted; younger ones and other settings stay", removed === 2 && [...mem.keys()].join() === "asm-draft:u2:a2,other-setting", [...mem.keys()]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
