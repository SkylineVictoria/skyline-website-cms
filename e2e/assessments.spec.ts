import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { anonClient, createAdmin, createAuthUser, createStudentLogin, person, serviceClient, shot, signInAsAdmin, signInThroughTheForm, PASSWORD, signOutEverywhere, sql, choose, selectOf } from "./support";

/**
 * Assessment Management (ASM-01) in the browser, against the LOCAL lab only: an Admin builds and publishes an assessment with two
 * question types, assigns it to a batch; the student completes and submits it with the declaration and gets a receipt; the trainer
 * marks it Satisfactory and records the unit outcome; the student sees the result. Rows are created through SQL fixtures (course,
 * unit, intake, batch, enrolment, trainer profile); everything else goes through the UI and the RPCs it calls.
 */
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
let admin: { email: string };
let student: { email: string; student: string };
let trainer: { email: string; profileId: string };
let otherTrainer: { email: string; profileId: string };
let otherBatchId = "";
let courseId = ""; let unitId = ""; let batchId = "";
let assessmentUrl = "";

/** Places a student in an intake as the system's planner does (manual placements are refused by intake_enrolments_auto_only). */
function enrol(intakeId: string, studentId: string): void {
  // AVETMISS (hosted 20261125025533, 20261126124153): an enrolment needs the student's AVETMISS details; the fixture student has them
  sql(`update public.enrollment_students set sex_code = 'M', birth_country_code = '1101', home_language_code = '1201', indigenous_status_code = '4', school_level_code = '12', school_level_year = '2017', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N', details = coalesce(details, '{}'::jsonb) || jsonb_build_object('first_name', coalesce(nullif(split_part(full_name, ' ', 1), ''), 'Test'), 'last_name', coalesce(nullif(split_part(full_name, ' ', 2), ''), 'Student')) || '{"dob": "2000-01-01", "usi_number": "ABCDE12345", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC"}'::jsonb where id = '${studentId}'`);
  sql(`begin; select set_config('rto.carry_over_planning', 'on', true); insert into public.intake_enrolments(intake_id, student_id, study_reason_code) values ('${intakeId}', '${studentId}', '01'); commit;`);
}

/** Draws a short signature on the signing pad (ASM-AI-IMPORT stage 3). */
async function drawSignature(page: Page, scope: ReturnType<Page["locator"]> | Page = page): Promise<void> {
  const pad = scope.getByTestId("signature-pad").first();
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (!box) throw new Error("no signature pad");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  for (const [x, y] of [[0.3, 0.3], [0.4, 0.7], [0.5, 0.35], [0.65, 0.65], [0.8, 0.4]]) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 4 });
  await page.mouse.up();
}
/** The walkthrough below (rewritten in phase 2) still uses the old name. */
const startWithDeclaration = (page: Page) => startAttempt(page);
/** Before you start: Start (ASM-IMPORT-SIMPLE: the declaration is the wizard's last step; skipped when the attempt is under way). */
async function startAttempt(page: Page): Promise<void> {
  const before = page.getByTestId("before-you-start");
  await Promise.race([before.waitFor({ timeout: 20_000 }), page.getByTestId("task-page").waitFor({ timeout: 20_000 })]).catch(() => undefined);
  if (!(await before.isVisible())) return;
  await page.getByTestId("start-task").click();
  await expect(page.getByTestId("task-page")).toBeVisible({ timeout: 20_000 });
}
/** Answers every visible field of the open task page (text, dates, numbers, first radio of each group, check boxes). */
async function answerTaskPage(page: Page, tag: string): Promise<void> {
  const form = page.locator("[data-testid=task-page] [data-question]");
  // an upload item gets one small PDF (once); first, because an upload reloads the attempt (typed text waits for its autosave)
  for (const q of await form.filter({ has: page.locator("input[type=file]") }).all()) {
    if ((await q.textContent())?.includes("evidence.pdf")) continue;
    await q.locator("input[type=file]").first().setInputFiles({ name: "evidence.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF") });
    await expect(q).toContainText("evidence.pdf", { timeout: 20_000 });
  }
  // ASM-IMPORT-SIMPLE: a form question's box starts with its printed fields (the prefill): the answer is written after them
  for (const box of await form.locator("textarea:visible").all()) { const v = await box.inputValue(); if (!v.includes(tag)) await box.fill(v ? `${v}\n${tag} answer` : `${tag} answer`); }
  for (const box of await form.locator("input[type=text]:visible, input:not([type]):visible").all()) if (!(await box.inputValue())) await box.fill(tag);
  for (const box of await form.locator("input[type=date]:visible").all()) await box.fill("2026-11-20");
  for (const box of await form.locator("input[type=number]:visible").all()) if (!(await box.inputValue())) await box.fill("1");
  const seen = new Set<string>();
  for (const radio of await form.locator("input[type=radio]:visible").all()) { const name = (await radio.getAttribute("name")) ?? ""; if (!seen.has(name)) { seen.add(name); await radio.check(); } }
  for (const box of await form.locator("input[type=checkbox]:visible").all()) await box.check();
  const more = page.getByRole("button", { name: /^\+ \d+ more parts/ });
  for (let k = 0; k < 50 && (await more.count()); k += 1) await more.first().click();
  for (const box of await form.locator("input:not([type]):visible, input[type=text]:visible").all()) if (!(await box.inputValue())) await box.fill(tag);
}
/** Every step answered page by page, then the declaration step: tick "my own work", the name, Submit; returns the receipt number. */
async function answerAllAndSubmit(page: Page, tag: string): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    await answerTaskPage(page, tag);
    await page.waitForTimeout(1200); // autosave
    const next = page.getByTestId("next");
    const label = (await next.textContent()) ?? "";
    await next.click();
    if (/Declaration/.test(label)) break;
  }
  await expect(page.getByTestId("declare-submit")).toBeVisible();
  await expect(page.getByTestId("submit")).toBeDisabled(); // nothing is submitted before the declaration is ticked
  await page.getByTestId("declare").check();
  const name = page.getByTestId("declare-name");
  if (!(await name.inputValue())) await name.fill("E2E Student");
  await expect(page.getByTestId("declare-date")).toHaveText(/\d/);
  await page.getByTestId("submit").click();
  const receipt = page.getByText(/receipt ASM-\d{4}-\d{6}/i).first();
  await expect(receipt).toBeVisible({ timeout: 20_000 });
  return ((await receipt.textContent()) ?? "").match(/ASM-\d{4}-\d{6}/)?.[0] ?? "";
}

/**
 * The marking desk: marks every question Satisfactory Yes / No, the first by keyboard (S / N), the rest with the large buttons;
 * `notSatisfactory(eyebrow)` says which questions get N (eyebrow "Assessment Task - 2 · Q2.1.1"). Assessor checklists are ticked.
 */
async function markOnDesk(page: Page, notSatisfactory: (eyebrow: string) => boolean = () => false, shotName?: string): Promise<void> {
  await expect(page.getByTestId("marking-desk")).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 300; i += 1) {
    const counter = (await page.getByTestId("marked-count").textContent()) ?? "";
    const m = /(\d+) of (\d+) marked/.exec(counter);
    if (m && m[1] === m[2]) break;
    for (const r of await page.getByLabel("Observed", { exact: true }).all()) if (!(await r.isChecked())) await r.check();
    const eyebrow = (await page.locator("[data-testid=marking-desk] [data-question] p").first().textContent()) ?? "";
    const no = notSatisfactory(eyebrow);
    if (i === 0) {
      if (shotName && process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, `${shotName}.png`) });
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press(no ? "n" : "s");
    } else await page.getByTestId(no ? "mark-n" : "mark-s").click();
    await expect(page.getByTestId("marked-count")).not.toHaveText(counter, { timeout: 10_000 });
  }
  await expect(page.getByTestId("finish-sign-off")).toBeEnabled();
  await page.getByTestId("finish-sign-off").click();
  await expect(page.getByTestId("sign-off")).toBeVisible();
}
/**
 * The sign-off: the task results are automatic (no click per task), the overall outcome is the suggestion unless `outcome` picks
 * one, the overall comment, the assessor declaration and signature, Sign & release results.
 */
async function signOffAndRelease(page: Page, feedback: string, shotName?: string, outcome?: "S" | "NYS"): Promise<void> {
  await expect(page.getByTestId("results-sheet-task").locator("textarea")).toHaveCount(0);
  if (outcome) await page.getByTestId(`overall-${outcome}`).click();
  await page.getByTestId("overall-comment").fill(feedback);
  await page.getByTestId("assessor-declare").check();
  const saved = page.getByTestId("assessor-declaration").getByText("Your saved signature");
  if (!(await saved.isVisible().catch(() => false))) await drawSignature(page, page.getByTestId("assessor-declaration"));
  if (shotName && process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, `${shotName}.png`), fullPage: true });
  await page.getByTestId("sign-release").click();
  await expect(page.getByText(/Results released/)).toBeVisible({ timeout: 30_000 });
}

/** ASM-BUILDER: a section's "+ Add" menu > Add question, a type from the palette, then the question text in the row editor. */
async function addQuestion(page: Page, type: string, text: string): Promise<void> {
  await page.getByTestId("section-add").first().click();
  await page.getByRole("menuitem", { name: "Add question" }).click();
  await page.getByTestId(`palette-${type}`).click();
  await page.getByTestId("row-editor").getByLabel("Question text").fill(text);
}

async function signInStaff(page: Page, email: string, path: string): Promise<void> {
  await signOutEverywhere(page);
  await signInThroughTheForm(page, email);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(path);
}

test.beforeAll(async () => {
  admin = await createAdmin("asm-admin");
  sql(`update public.cms_users set rto_manager = true where email = '${admin.email}'`);
  courseId = `course-e2e-asm-${RUN}`;
  // a course is published only when reportable (AVETMISS fields) with a unit and an intake: inserted as Draft, published below
  sql(`insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level) values ('${courseId}', 'e2e-asm-${RUN}', 'E2E${RUN.slice(-4).toUpperCase()}', 'E2E Assessment Course ${RUN}', 'Draft', 'Face to Face', '0403', '331212', 'Certificate III')`);
  unitId = `unit-e2e-asm-${RUN}`;
  sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${unitId}', '${courseId}', 'E2EU1', 'Work safely in the lab')`);
  const intakeId = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${courseId}', date '2026-01-05', date '2026-12-18', 'Jan 2026') returning id`).split("\n")[0];
  sql(`insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${intakeId}', '${unitId}', date '2026-01-05', date '2026-12-18')`);
  sql(`update public.cms_courses set status = 'Published' where id = '${courseId}'`);
  // INTAKE-REPLACES-BATCH (2026-11-19): the intake is the class group (G1); a second intake of the course is G2
  batchId = intakeId;
  sql(`update public.course_intakes set label = 'G1' where id = '${intakeId}'`);
  student = await createStudentLogin("asm-student");
  enrol(batchId, student.student);
  const t = person("asm-trainer");
  const trainerAuth = await createAuthUser(t.email);
  const profileId = sql(`alter table hr.staff_profiles disable trigger staff_status_guard;
    insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values ('${trainerAuth}', 'Tara', 'Trainer', '${t.email}', '${t.phone}', 'active') returning id;
    alter table hr.staff_profiles enable trigger staff_status_guard;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
  trainer = { email: t.email, profileId };
  sql(`insert into public.intake_trainers(intake_id, staff_id) values ('${batchId}', '${profileId}')`);
  // D-22: marking needs the trainer role on the staff record (require_trainer_role defaults to true)
  sql(`insert into hr.staff_roles(profile_id, role, granted_by) values ('${profileId}', 'trainer', '${trainerAuth}')`);
  // a second batch on the same intake with its own trainer, who must never reach G1's work
  otherBatchId = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${courseId}', date '2026-01-05', date '2026-12-18', 'G2') returning id`).split("\n")[0];
  sql(`insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${otherBatchId}', '${unitId}', date '2026-01-05', date '2026-12-18')`);
  const o = person("asm-trainer-other");
  const otherAuth = await createAuthUser(o.email);
  const otherProfile = sql(`alter table hr.staff_profiles disable trigger staff_status_guard;
    insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values ('${otherAuth}', 'Tom', 'Trainer', '${o.email}', '${o.phone}', 'active') returning id;
    alter table hr.staff_profiles enable trigger staff_status_guard;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
  otherTrainer = { email: o.email, profileId: otherProfile };
  sql(`insert into public.intake_trainers(intake_id, staff_id) values ('${otherBatchId}', '${otherProfile}')`);
  sql(`insert into hr.staff_roles(profile_id, role, granted_by) values ('${otherProfile}', 'trainer', '${otherAuth}')`);
});

// ASM-PDF-TEMPLATE phase 2 (2026-11-26): the student answers on the workbook PDF itself (both workbooks when they are on this machine)
const workbook = (name: string, env?: string) => [env ? process.env[env] : undefined, name, path.join(os.homedir(), "Downloads", name)].find((p) => p && existsSync(p));
const RII_PDF = workbook("DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf", "ASM_WORKBOOK");
const CPC_PDF = workbook("CPC30620_CPCCPD2012_Use painting and decorating tools and equipment.pdf", "ASM_WORKBOOK_2");
const GRID = "[data-testid=answer-table] [data-testid=table-grid]";

/** The admin adds an assessment, uploads the workbook on the PDF template tab, publishes it and assigns it to G1; returns the assignment. */
async function publishWorkbook(page: Page, file: string, questions: number): Promise<string> {
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/assessments");
  await page.getByRole("button", { name: "New assessment" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add assessment" });
  await dialog.getByTestId("new-assessment-skip").click(); // the unit first, the workbook on the PDF template tab
  await choose(dialog.getByLabel("Qualification"), courseId);
  await choose(dialog.getByLabel("Unit"), unitId);
  await dialog.getByRole("button", { name: "Create and upload the workbook" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  const url = page.url().replace(/\?.*$/, "");
  const id = url.split("/").pop()!;
  await page.goto(`${url}?tab=pdf`);
  await page.getByTestId("pdf-template-file").setInputFiles(file);
  await expect(page.getByTestId("pdf-template-summary")).toContainText(`${questions} questions`, { timeout: 90_000 });
  // ASM-UNIT-CHECK on the PDF template tab: a workbook that names another unit waits for Switch or Keep (with a reason), audited
  await expect.poll(async () => (await page.getByTestId("unit-mismatch").count()) > 0 || await page.getByTestId("pdf-template-save").isEnabled(), { timeout: 60_000 }).toBe(true);
  if (await page.getByTestId("unit-mismatch").count()) {
    await expect(page.getByTestId("unit-mismatch")).toContainText("but you selected E2EU1");
    await expect(page.getByTestId("pdf-template-save")).toBeDisabled();
    await page.getByTestId("unit-keep-reason").fill("E2E: filed under the test unit on purpose");
    await page.getByTestId("unit-keep").click();
    await expect(page.getByTestId("unit-mismatch")).toHaveCount(0);
    expect(sql(`select count(*) from public.asm_audit_log where action = 'import_unit_mismatch' and target_id = '${id}' and detail->>'decision' = 'kept' and detail->>'selectedCode' = 'E2EU1'`)).toBe("1");
  }
  await page.getByTestId("pdf-template-save").click();
  await expect(page.getByTestId("pdf-template-summary")).not.toContainText("Not saved", { timeout: 30_000 });
  await page.getByTestId("publish-version").click();
  await page.getByRole("button", { name: "Publish", exact: true }).last().click();
  await expect(page.getByTestId("status-badge")).toHaveText("Published", { timeout: 15_000 });
  await page.getByRole("button", { name: "Assignments" }).click();
  await page.getByRole("button", { name: "Assign to intakes" }).click();
  await page.getByRole("dialog", { name: "Assign to intakes" }).locator("label").filter({ hasText: /^G1/ }).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect.poll(() => sql(`select count(*) from public.asm_assignments where assessment_id = '${id}'`), { timeout: 15_000 }).toBe("1");
  return sql(`select id from public.asm_assignments where assessment_id = '${id}'`);
}

/** Fills the step on screen as the rules ask: every text answer; every cell of a table with printed rows; the first row of a blank-row table. */
async function answerStep(page: Page, text: string): Promise<void> {
  const q = page.getByTestId("step-question");
  for (const input of await q.locator("[data-testid=answer-text], [data-testid=answer-line]").all()) await input.fill(text);
  for (const grid of await q.locator(GRID).all()) {
    const fixed = (await grid.locator("tbody th").count()) > 0;
    const cells = fixed ? grid.getByTestId("table-cell") : grid.locator("tbody tr").first().getByTestId("table-cell");
    for (const cell of await cells.all()) await cell.fill(text);
  }
}
const CPC_KEYS = ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11"];
let cpcAssignment = "";
let riiAssignment = "";
const STUDENT_RPC = "**/rest/v1/rpc/asm_student";
/** Makes the student's draft_save answer as the server would when it fails (every other student call goes through). */
async function failDraftSave(page: Page, status: number, body: { code: string; message: string }): Promise<void> {
  await page.route(STUDENT_RPC, async (route) => {
    const data = route.request().postDataJSON() as { p_action?: string } | null;
    if (data?.p_action === "draft_save") await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ...body, details: null, hint: null }) });
    else await route.continue();
  });
}

/** Marks a question in the marking view: picked in the side panel, then the large Yes / No (and the comment) of the Questions view. */
async function markQuestion(page: Page, key: string, outcome: "S" | "NYS", comment?: string): Promise<void> {
  await page.locator(`[data-testid=marking-question][data-key='${key}'] button`).first().click();
  await expect(page.getByTestId("question-marker")).toHaveAttribute("data-key", key);
  await page.getByTestId(`q-mark-${outcome}`).click();
  if (comment) await page.getByTestId("q-comment").fill(comment);
  await expect(page.locator(`[data-testid=marking-question][data-key='${key}']`).getByTestId("mark-status")).toHaveAttribute("data-outcome", outcome);
}

/** Ticks every Evidence Outcome row of the marking checklists (Yes or No) on the page. */
async function tickEvidence(page: Page, option: "yes" | "no"): Promise<void> {
  const rows = page.locator(`[data-testid=trainer-field][data-checklist=evidence][data-option=${option}]`);
  await expect(rows).toHaveCount(13);
  for (const row of await rows.all()) { await row.scrollIntoViewIfNeeded(); await row.click(); }
}

/** Signs the declaration on screen: the first time drawn (kept as the saved signature), then one tap. */
async function signHere(page: Page, scope: ReturnType<Page["locator"]>): Promise<void> {
  // the saved signature is looked up first: wait for the Sign button before deciding whether to draw
  await expect(scope.getByTestId("sign-button")).toBeVisible({ timeout: 15_000 });
  if (await scope.getByTestId("signature-pad").count()) await drawSignature(page, scope);
  await scope.getByTestId("sign-button").click();
}

// ASM-PREVIEW-AFTER-SAVE (owner 2026-11-26): Preview as learner and Publish stayed disabled after Save draft until the page was reloaded
test("PDF-WORKBOOK Save draft enables Preview as learner and Publish without a reload", async ({ page }) => {
  test.skip(!CPC_PDF, "the CPCCPD2012 workbook is not on this machine (set ASM_WORKBOOK_2)");
  test.setTimeout(180_000);
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/assessments");
  await page.getByRole("button", { name: "New assessment" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add assessment" });
  await dialog.getByTestId("new-assessment-skip").click(); // the unit first, the workbook on the PDF template tab
  await choose(dialog.getByLabel("Qualification"), courseId);
  await choose(dialog.getByLabel("Unit"), unitId);
  await dialog.getByRole("button", { name: "Create and upload the workbook" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  const id = page.url().replace(/[?#].*$/, "").split("/").pop()!;
  await expect(page.getByTestId("preview-learner")).toBeDisabled();
  await page.getByTestId("pdf-template-file").setInputFiles(CPC_PDF!);
  await expect(page.getByTestId("pdf-template-summary")).toContainText("14 questions", { timeout: 90_000 });
  await expect.poll(async () => (await page.getByTestId("unit-mismatch").count()) > 0 || await page.getByTestId("pdf-template-save").isEnabled(), { timeout: 60_000 }).toBe(true);
  if (await page.getByTestId("unit-mismatch").count()) {
    await page.getByTestId("unit-keep-reason").fill("E2E: filed under the test unit on purpose");
    await page.getByTestId("unit-keep").click();
    await expect(page.getByTestId("unit-mismatch")).toHaveCount(0);
  }
  await expect(page.getByTestId("preview-learner")).toBeDisabled(); // nothing saved yet
  // a slow workbook download (hosted: 6 MB) must not hold the header back: the refresh after saving never waits for the PDF
  let downloads = 0;
  await page.route("**/storage/v1/object/**/assessment-templates/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    downloads++; await new Promise((r) => setTimeout(r, 20_000)); return route.continue().catch(() => undefined);
  });
  await page.getByTestId("pdf-template-save").click();
  await expect.poll(() => sql(`select count(*) from public.asm_versions where assessment_id = '${id}' and template is not null`), { timeout: 30_000 }).toBe("1");
  // the same page, no reload: the header follows the saved draft
  await expect(page.getByTestId("preview-learner")).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId("publish-version")).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId("header-line")).toContainText("14 questions on the workbook");
  expect(downloads).toBe(0); // the saved workbook is the one in memory: not downloaded again
  await page.unroute("**/storage/v1/object/**/assessment-templates/**");
  await page.getByTestId("preview-learner").click();
  await expect(page.getByTestId("learner-preview").getByTestId("wizard-step-count")).toHaveText(/^Step 1 of \d+$/, { timeout: 60_000 });
  await page.getByTestId("preview-close").click();
  await expect(page.getByTestId("learner-preview")).toHaveCount(0);
  sql(`delete from public.asm_assessments where id = '${id}'`);
});

// UPLOAD-FIRST Add assessment (owner 2026-11-26): the workbook first, its qualification and unit read from its first pages and prefilled
test("PDF-WORKBOOK upload-first Add assessment: CPCCPD2012 prefills CPC30620 and the unit, opens with the workbook attached; from a unit a mismatch asks Switch or Keep", async ({ page }) => {
  test.skip(!CPC_PDF, "the CPCCPD2012 workbook is not on this machine (set ASM_WORKBOOK_2)");
  test.setTimeout(240_000);
  // the qualification and unit the workbook names, in the lab once (course code and unit code per course are unique)
  let cpcCourse = sql(`select id from public.cms_courses where code = 'CPC30620'`);
  if (!cpcCourse) { cpcCourse = `course-e2e-cpc30620`; sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${cpcCourse}', 'e2e-cpc30620', 'CPC30620', 'Certificate III in Painting and Decorating', 'Draft')`); }
  let cpcUnit = sql(`select id from public.cms_course_units where course_id = '${cpcCourse}' and code = 'CPCCPD2012'`);
  if (!cpcUnit) { cpcUnit = `unit-e2e-cpccpd2012`; sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${cpcUnit}', '${cpcCourse}', 'CPCCPD2012', 'Use painting and decorating tools and equipment')`); }
  sql(`update public.cms_course_units set is_active = true where id = '${cpcUnit}'`);
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/assessments");
  await page.getByRole("button", { name: "New assessment" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add assessment" });
  await expect(dialog.getByTestId("new-assessment-upload")).toContainText("Upload workbook PDF"); // the first step
  await expect(dialog.getByRole("combobox", { name: "Qualification" })).toHaveCount(0);
  await dialog.getByTestId("new-assessment-file").setInputFiles(CPC_PDF!);
  await expect(dialog.getByRole("combobox", { name: "Qualification" })).toContainText("CPC30620", { timeout: 30_000 });
  await expect(dialog.getByRole("combobox", { name: "Unit" })).toContainText("CPCCPD2012", { timeout: 15_000 });
  await expect(selectOf(dialog.getByRole("combobox", { name: "Qualification" }))).toHaveValue(cpcCourse);
  await expect(selectOf(dialog.getByRole("combobox", { name: "Unit" }))).toHaveValue(cpcUnit);
  await expect(dialog.getByTestId("new-assessment-found")).toContainText("CPC30620 · CPCCPD2012");
  await expect(dialog.getByTestId("new-assessment-note")).toHaveCount(0);
  await expect(dialog.getByTestId("new-assessment-workbook")).toContainText("CPCCPD2012");
  await dialog.getByTestId("create-assessment").click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}\?tab=pdf/);
  const first = page.url().replace(/[?#].*$/, "").split("/").pop()!;
  // the workbook is already attached: read on the PDF template tab without choosing it again, no unit question
  await expect(page.getByTestId("pdf-template-summary")).toContainText("14 questions", { timeout: 90_000 });
  await expect(page.getByTestId("pdf-template-save")).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("unit-mismatch")).toHaveCount(0);
  await page.getByTestId("pdf-template-save").click();
  await expect(page.getByTestId("preview-learner")).toBeEnabled({ timeout: 15_000 });
  expect(sql(`select a.course_id || ':' || a.unit_id || ':' || jsonb_array_length(v.template->'questions') from public.asm_assessments a join public.asm_versions v on v.assessment_id = a.id where a.id = '${first}'`)).toBe(`${cpcCourse}:${cpcUnit}:14`);

  // a workbook whose codes are not in Skyline: the boxes stay empty with a note (the lab's other course has neither code)
  sql(`update public.cms_course_units set is_active = false where id = '${cpcUnit}'`);
  await page.goto("/admin/assessments");
  await page.getByRole("button", { name: "New assessment" }).first().click();
  await dialog.getByTestId("new-assessment-file").setInputFiles(CPC_PDF!);
  await expect(dialog.getByTestId("new-assessment-note")).toContainText("CPCCPD2012 (read from the workbook) is not a unit of CPC30620 in Skyline: choose the unit.", { timeout: 30_000 });
  await expect(selectOf(dialog.getByRole("combobox", { name: "Unit" }))).toHaveValue("");
  await expect(dialog.getByTestId("create-assessment")).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  sql(`update public.cms_course_units set is_active = true where id = '${cpcUnit}'`);

  // opened from a unit (LMS > Assessments, E2EU1 selected): still upload-first; the workbook names CPCCPD2012, so Switch or Keep
  const e2eCode = sql(`select code from public.cms_courses where id = '${courseId}'`);
  await page.goto("/admin/lms/assessments");
  await page.getByRole("button", { name: new RegExp(e2eCode) }).first().click();
  await expect(page.getByRole("heading", { name: /E2EU1/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "+ Add assessment" }).click();
  await expect(dialog.getByTestId("new-assessment-upload")).toBeVisible();
  await dialog.getByTestId("new-assessment-file").setInputFiles(CPC_PDF!);
  await expect(dialog.getByTestId("new-assessment-note")).toContainText("This workbook names CPCCPD2012, not the selected E2EU1.", { timeout: 30_000 });
  await expect(selectOf(dialog.getByRole("combobox", { name: "Unit" }))).toHaveValue(unitId); // the unit it was opened from
  await dialog.getByTestId("create-assessment").click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  const second = page.url().replace(/[?#].*$/, "").split("/").pop()!;
  await expect(page.getByTestId("unit-mismatch")).toContainText("but you selected E2EU1", { timeout: 90_000 });
  await expect(page.getByTestId("pdf-template-save")).toBeDisabled();
  await page.getByTestId("unit-keep-reason").fill("E2E: upload-first from a unit, kept on purpose");
  await page.getByTestId("unit-keep").click();
  await expect(page.getByTestId("unit-mismatch")).toHaveCount(0);
  expect(sql(`select count(*) from public.asm_audit_log where action = 'import_unit_mismatch' and target_id = '${second}' and detail->>'decision' = 'kept'`)).toBe("1");
  for (const id of [first, second]) sql(`delete from public.asm_assessments where id = '${id}'`);
});

test("PDF-WORKBOOK CPCCPD2012 on its workbook: questions cropped from the PDF, tables as grids or cards, autosave, review, each declaration signed and submit", async ({ page }) => {
  test.skip(!CPC_PDF, "the CPCCPD2012 workbook is not on this machine (set ASM_WORKBOOK_2)");
  test.setTimeout(600_000);
  cpcAssignment = await publishWorkbook(page, CPC_PDF!, 14);
  // the CPCCPD2012 workbook names its own unit: the PDF template tab flagged it and the decision was audited
  expect(sql(`select count(*) from public.asm_audit_log where action = 'import_unit_mismatch' and detail->>'foundCode' = 'CPCCPD2012' and detail->>'decision' = 'kept' and detail->>'foundTitle' = ''`)).not.toBe("0");
  const base = `/agency/assessments/${cpcAssignment}`;
  await signInStaff(page, student.email, base);
  await expect(page.getByTestId("pdf-wizard")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wizard-step-count")).toHaveText("Step 1 of 21");
  await expect(page.getByTestId("record-fields")).toContainText(student.email);
  // a question (ASM-QUESTION-TEXT-ONLY): always its words read from the PDF (no Workbook / Text switch), the label once as the
  // heading, Open full page as the only way to the printed page; the answer, its word count
  await page.goto(`${base}?step=q-1.1`);
  await expect(page.getByTestId("question-text")).toHaveText("Outline the safety requirements relevant to using painting and decorating tools and equipment.", { timeout: 30_000 });
  await expect(page.getByTestId("question-heading")).toHaveText("Q1");
  await expect(page.getByTestId("question-mode")).toHaveCount(0);
  await expect(page.getByTestId("question-crop")).toHaveCount(0);
  await page.getByTestId("see-on-page").click();
  await expect(page.getByTestId("see-on-page-dialog").getByTestId("marked-page-13")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("see-on-page-dialog")).toHaveCount(0);
  await page.getByTestId("answer-text").first().fill("Brushes, rollers and spray equipment are cleaned straight after use with the right solvent, dried and stored hanging so the bristles keep their shape. ".repeat(4).trim());
  await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  await expect(page.getByTestId("word-count")).toHaveText(/^\d+ words$/);
  await shot(page, "pdf-wizard-text-question");
  // Q3: the fixed rows (tool names) as row titles on a grid; cards on a phone; every cell is required
  await page.goto(`${base}?step=q-1.3`);
  await expect(page.getByTestId("answer-table")).toHaveAttribute("data-rows", "22");
  const grid = page.locator(GRID);
  await expect(grid.locator("tbody tr").first().locator("th")).toHaveText("Brushware and accessories");
  await grid.getByTestId("table-cell").nth(0).fill("Natural or synthetic bristles; flat, sash and fitch shapes.");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("table-card").first()).toContainText("Brushware and accessories");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  await page.goto(`${base}?step=review`);
  await expect(page.getByTestId("review-missing")).toContainText("Task 1 · Q3: 65 empty cells in the table.");
  await expect(page.getByTestId("review-missing")).toContainText("Sign the Task 1 declaration.");
  await expect(page.getByTestId("submit")).toBeDisabled();
  await page.getByTestId("missing-item").filter({ hasText: "Task 1 · Q2 is not answered yet." }).first().click();
  await expect(page).toHaveURL(/step=q-1\.2/);
  // answer everything as the rules ask
  for (const key of CPC_KEYS) {
    await page.goto(`${base}?step=q-${key}`);
    await expect(page.getByTestId("step-question")).toHaveAttribute("data-question-key", key);
    await answerStep(page, `Answer to ${key}`);
    await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  }
  // each declaration signed at its moment: Task 1's at the end of Task 1 (drawn once), Task 2's with one tap
  await page.goto(`${base}?step=decl-1-19`);
  await signHere(page, page.getByTestId("sign-declaration"));
  await expect(page.getByTestId("signed")).toContainText("Signed by", { timeout: 10_000 });
  await shot(page, "pdf-wizard-declaration");
  await page.goto(`${base}?step=decl-2-46`);
  await expect(page.getByTestId("sign-declaration").getByTestId("signature-pad")).toHaveCount(0);
  await page.getByTestId("sign-button").click();
  await expect(page.getByTestId("signed")).toBeVisible({ timeout: 10_000 });
  // the whole-pack declaration on the submit step
  await page.goto(`${base}?step=review`);
  await expect(page.getByTestId("review-missing")).toContainText("Sign the student declaration (page 7).");
  await page.getByTestId("pack-declaration").getByTestId("sign-button").click();
  await expect(page.getByTestId("review-ready")).toBeVisible({ timeout: 10_000 });
  await shot(page, "pdf-wizard-review-ready");
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("pdf-results")).toContainText(/receipt/i, { timeout: 20_000 });
  expect(sql(`select a.state || ':' || (a.declaration->>'text' like '%I have read and understood%' and a.declaration->>'text' like '%I declare that the answers I have provided are my own work.%')::text || ':' || (select string_agg(slot, ',' order by slot) from public.asm_pdf_signatures s where s.attempt_id = a.id)
    || ':' || (select count(*) from public.asm_attempt_snapshots s where s.attempt_id = a.id and s.signatures ?& array['decl:1', 'decl:2', 'pack']) from public.asm_attempts a where a.assignment_id = '${cpcAssignment}'`)).toBe("submitted:true:decl:1,decl:2,pack:1");
  expect(sql(`select count(distinct date_trunc('second', signed_at)) from public.asm_pdf_signatures s join public.asm_attempts a on a.id = s.attempt_id where a.assignment_id = '${cpcAssignment}'`)).toBe("3");
});

test("PDF-WORKBOOK CPCCPD2012 marking on the workbook: the trainer marks, returns attempt 1; attempt 2 starts from the answers; Competent; the final PDF is stored with the snapshot hash; the student acknowledges", async ({ page }) => {
  test.skip(!CPC_PDF || !cpcAssignment, "needs the CPCCPD2012 submission above");
  test.setTimeout(600_000);
  const attempt1 = sql(`select id from public.asm_attempts where assignment_id = '${cpcAssignment}' and attempt_no = 1`);
  await signInStaff(page, trainer.email, `/staff/assessments/attempts/${attempt1}`);
  await expect(page.getByTestId("pdf-marking")).toBeVisible({ timeout: 30_000 });
  // the Questions view (ASM-QUESTION-TEXT): the question as the student saw it, their answer, large Yes / No, Next unmarked
  await expect(page.getByTestId("question-marker")).toHaveAttribute("data-key", "1.1", { timeout: 30_000 });
  await expect(page.getByTestId("question-marker").getByTestId("question-text")).toContainText("Outline the safety requirements", { timeout: 30_000 });
  await expect(page.getByTestId("question-marker").getByTestId("question-mode")).toHaveCount(0);
  await expect(page.getByTestId("student-answer")).toContainText("Answer to 1.1");
  await page.getByTestId("q-mark-S").click();
  await expect(page.getByTestId("q-mark-S")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("q-next-unmarked").click();
  await expect(page.getByTestId("question-marker")).toHaveAttribute("data-key", "1.2");
  await shot(page, "pdf-marking-questions");
  for (const key of CPC_KEYS) await markQuestion(page, key, key === "2.3" ? "NYS" : "S", key === "2.3" ? "Add the safe method of use for each tool." : undefined);
  await expect(page.locator("[data-testid=marking-question][data-key='2.3']").getByTestId("mark-comment")).toHaveText("Add the safe method of use for each tool.");
  await page.getByTestId("marking-view-pages").click();
  await expect(page.locator("[data-pdf-page='13'] canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("task-auto").nth(0)).toHaveText("Satisfactory");
  await expect(page.getByTestId("task-auto").nth(1)).toHaveText("Not satisfactory");
  await page.getByTestId("task-feedback").nth(1).fill("Q3 needs the safe methods of use.");
  await page.getByTestId("overall-NYS").click();
  await page.getByTestId("overall-feedback").fill("Nearly there: complete the safe methods in Task 2 Q3.");
  await drawSignature(page, page.getByTestId("signoff"));
  await page.getByTestId("signoff-sign").click();
  await expect(page.getByTestId("signoff-done")).toBeVisible({ timeout: 10_000 });
  // the release waits for the Evidence Outcome rows (clicked on the marking checklists, pages 17 and 43)
  await expect(page.getByTestId("marking-missing")).toContainText('Marking checklist, page 17: "Submitted written answers covering all the questions." has no Yes / No.');
  await expect(page.getByTestId("decide")).toBeDisabled();
  await tickEvidence(page, "yes");
  await expect(page.getByTestId("marking-missing")).toHaveCount(0);
  await expect(page.getByTestId("marking-saved")).toContainText("Saved", { timeout: 10_000 });
  await page.locator("[data-testid=marking-question][data-key='2.3'] button").first().click();
  await expect(page.locator("[data-pdf-page='38'] canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot(page, "pdf-marking");
  await page.getByTestId("decide").click();
  await expect(page.getByTestId("decided")).toContainText("Returned for resubmission", { timeout: 20_000 });
  expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where assignment_id = '${cpcAssignment}'`)).toBe("1:returned:NYS,2:draft:-");
  expect(sql(`select string_agg(r.task_id || ':' || r.outcome, ',' order by r.task_id) from public.asm_task_results r join public.asm_attempts a on a.id = r.attempt_id where a.assignment_id = '${cpcAssignment}' and a.attempt_no = 1`)).toBe("1:S,2:NYS");

  // attempt 2: the answers of attempt 1 filled in, the trainer's marks beside the questions
  const base = `/agency/assessments/${cpcAssignment}`;
  await signInStaff(page, student.email, base);
  await expect(page.getByTestId("resubmission")).toContainText("Attempt 2", { timeout: 30_000 });
  await page.goto(`${base}?step=q-2.3`);
  await expect(page.getByTestId("previous-mark")).toContainText("Not yet satisfactory in attempt 1: Add the safe method of use for each tool.");
  await expect(page.locator(GRID).getByTestId("table-cell").first()).toHaveValue("Answer to 2.3");
  await page.locator(GRID).getByTestId("table-cell").nth(4).fill("Hold the scraper flat and push away from the body.");
  await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  await shot(page, "pdf-attempt-2");
  for (const step of ["decl-1-19", "decl-2-46"]) { await page.goto(`${base}?step=${step}`); await page.getByTestId("sign-button").click(); await expect(page.getByTestId("signed")).toBeVisible({ timeout: 10_000 }); }
  await page.goto(`${base}?step=review`);
  await page.getByTestId("pack-declaration").getByTestId("sign-button").click();
  await expect(page.getByTestId("review-ready")).toBeVisible({ timeout: 10_000 });
  // AUTOSAVE: submit waits for the save; while it fails nothing is submitted and the student is told why
  await failDraftSave(page, 500, { code: "57014", message: "canceling statement due to statement timeout" });
  await page.getByTestId("wizard-back").click();
  await page.getByTestId("rating-row").first().locator("label").first().click();
  await expect(page.getByTestId("autosave")).toHaveText("Not saved, retrying…", { timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("submit").click();
  await expect(page.getByRole("alert").filter({ hasText: "Your latest answers are not saved yet (retrying). Submit once they show as saved." })).toBeVisible({ timeout: 10_000 });
  expect(sql(`select state from public.asm_attempts where assignment_id = '${cpcAssignment}' and attempt_no = 2`)).toBe("draft");
  await page.unroute(STUDENT_RPC);
  await expect(page.getByTestId("autosave")).toContainText("Saved", { timeout: 40_000 });
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("pdf-results")).toContainText(/receipt/i, { timeout: 20_000 });

  // the trainer marks attempt 2 Competent and releases it: the final PDF is stored with the snapshot hash
  const attempt2 = sql(`select id from public.asm_attempts where assignment_id = '${cpcAssignment}' and attempt_no = 2`);
  await signInStaff(page, trainer.email, `/staff/assessments/attempts/${attempt2}`);
  await expect(page.getByTestId("pdf-marking")).toBeVisible({ timeout: 30_000 });
  for (const key of CPC_KEYS) await markQuestion(page, key, "S");
  await expect(page.getByTestId("marking-missing")).toContainText("page 43");
  await page.getByTestId("marking-view-pages").click();
  await tickEvidence(page, "yes");
  await expect(page.getByTestId("marking-missing")).toHaveCount(0);
  await page.getByTestId("overall-S").click();
  await page.getByTestId("overall-feedback").fill("Competent: all tasks satisfactory.");
  await page.getByTestId("signoff-sign").click();
  await expect(page.getByTestId("signoff-done")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("decide").click();
  await expect(page.getByTestId("stored-final")).toContainText("Sign-off copy", { timeout: 60_000 });
  // the summary sheet's final result for this unit, attempt 2's column, shows Competent (the release decision)
  const finalYes = sql(`select f->>'id' from public.asm_attempts a join public.asm_versions v on v.id = a.version_id cross join lateral jsonb_array_elements(v.template->'fields') f
    where a.id = '${attempt2}' and f->>'kind' = 'yes_no' and f->>'label' ilike '%final%' and f->>'option' = 'yes' and (f->>'attempt')::int = 2`);
  const finalNo = sql(`select f->>'id' from public.asm_attempts a join public.asm_versions v on v.id = a.version_id cross join lateral jsonb_array_elements(v.template->'fields') f
    where a.id = '${attempt2}' and f->>'kind' = 'yes_no' and f->>'label' ilike '%final%' and f->>'option' = 'no' and (f->>'attempt')::int = 2`);
  expect(finalYes).toMatch(/\S/);
  await expect(page.locator(`[data-testid=trainer-field][data-field="${finalYes}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-testid=trainer-field][data-field="${finalNo}"]`)).toHaveAttribute("aria-pressed", "false");
  // the unit outcome: recorded and signed by the assessor (Not Yet Competent, then Competent supersedes it), never automatic
  const unitPanel = page.getByTestId("unit-outcome");
  const studentOf2 = sql(`select student_id from public.asm_attempts where id = '${attempt2}'`);
  for (const [label, code] of [["Not Yet Competent", "NYC"], ["Competent", "C"]] as const) {
    await unitPanel.getByTestId("unit-outcome-open").click();
    await unitPanel.getByRole("button", { name: label, exact: true }).click();
    await expect(unitPanel.getByTestId("unit-outcome-record")).toBeDisabled();
    await unitPanel.getByRole("checkbox").check();
    await unitPanel.getByTestId("unit-outcome-record").click();
    await expect(unitPanel.getByTestId("unit-outcome-msg")).toHaveText(`Unit outcome recorded: ${label}.`, { timeout: 15_000 });
    expect(sql(`select outcome || '/' || signed_role from public.asm_unit_outcomes where student_id = '${studentOf2}' order by signed_at desc, id desc limit 1`)).toBe(`${code}/trainer`);
  }
  expect(sql(`select count(*) from public.asm_unit_outcomes where student_id = '${studentOf2}'`)).toBe("2");
  // attempt 1 keeps its own answers, marks and checklists: opened from attempt 2's history, read-only
  await page.getByTestId("earlier-attempts").getByRole("link", { name: "Attempt 1" }).click();
  await expect(page.getByTestId("decided")).toContainText("Returned for resubmission", { timeout: 30_000 });
  await expect(page.locator("[data-testid=marking-question][data-key='2.3']").getByTestId("mark-status")).toHaveAttribute("data-outcome", "NYS");
  expect(sql(`select (select count(*) from jsonb_object_keys(assessor_responses->'pdfChoice')) from public.asm_attempts where id = '${attempt1}'`)).toBe("13");
  expect(sql(`select (o.snapshot_hash = s.hash)::text || ':' || (o.path = a.id || '/final-' || o.pdf_sha256 || '.pdf')::text from public.asm_attempt_outputs o join public.asm_attempt_snapshots s on s.attempt_id = o.attempt_id join public.asm_attempts a on a.id = o.attempt_id where o.attempt_id = '${attempt2}' and o.kind = 'final'`)).toBe("true:true");
  const outPath = sql(`select path from public.asm_attempt_outputs where attempt_id = '${attempt2}' and kind = 'final'`);
  const { data } = await serviceClient().storage.from("assessment-output").download(outPath);
  const bytes = Buffer.from(await data!.arrayBuffer());
  const { createHash } = await import("node:crypto");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sql(`select pdf_sha256 from public.asm_attempt_outputs where attempt_id = '${attempt2}' and kind = 'final'`));
  if (process.env.E2E_SHOTS_DIR) writeFileSync(`${process.env.E2E_SHOTS_DIR}/cpc-final.pdf`, bytes);

  // the student reads the result and signs the acknowledgement (the summary sheet's wording)
  await signInStaff(page, student.email, base);
  await expect(page.getByTestId("overall-outcome")).toHaveText("Competent", { timeout: 30_000 });
  await page.getByTestId("acknowledge-sign").click();
  await expect(page.getByTestId("acknowledged")).toBeVisible({ timeout: 10_000 });
  expect(sql(`select statement from public.asm_attempt_signatures where attempt_id = '${attempt2}' and kind = 'student_acknowledgement'`)).toBe("I declare that I have been assessed in this unit, and I have been advised of my result. I also am aware of my appeal rights.");
  // the acknowledged copy is stored beside the sign-off copy and becomes the official record; each keeps the hashes it was drawn from
  await expect(page.getByTestId("official-pdf")).toContainText("the copy stored after your acknowledgement", { timeout: 60_000 });
  expect(sql(`select string_agg(o.kind || ':' || (o.snapshot_hash = s.hash)::text || ':' || (o.marking_hash ~ '^[a-f0-9]{64}$')::text || ':' || (o.acknowledgement_hash <> '')::text
    || ':' || (o.path = o.attempt_id || '/' || o.kind || '-' || o.pdf_sha256 || '.pdf')::text, ',' order by o.kind) from public.asm_attempt_outputs o join public.asm_attempt_snapshots s on s.attempt_id = o.attempt_id where o.attempt_id = '${attempt2}'`))
    .toBe("acknowledged:true:true:true:true,final:true:true:false:true");
  expect(sql(`select (a.pdf_sha256 <> f.pdf_sha256 and a.acknowledgement->>'statement' like 'I declare that I have been assessed%')::text from public.asm_attempt_outputs a join public.asm_attempt_outputs f on f.attempt_id = a.attempt_id and f.kind = 'final' where a.attempt_id = '${attempt2}' and a.kind = 'acknowledged'`)).toBe("true");
  {
    const ackPath = sql(`select path from public.asm_attempt_outputs where attempt_id = '${attempt2}' and kind = 'acknowledged'`);
    const { data: ack } = await serviceClient().storage.from("assessment-output").download(ackPath);
    const ackBytes = Buffer.from(await ack!.arrayBuffer());
    expect(createHash("sha256").update(ackBytes).digest("hex")).toBe(sql(`select pdf_sha256 from public.asm_attempt_outputs where attempt_id = '${attempt2}' and kind = 'acknowledged'`));
    if (process.env.E2E_SHOTS_DIR) writeFileSync(`${process.env.E2E_SHOTS_DIR}/cpc-final-acknowledged.pdf`, ackBytes);
  }
  await page.getByTestId("show-workbook").click();
  await expect(page.getByTestId("stamped-workbook").locator("[data-pdf-page='48']")).toBeAttached({ timeout: 60_000 });
  await shot(page, "pdf-results");
  // the student opens attempt 1's own result and workbook from the attempt list
  await page.getByRole("link", { name: "Attempt 1" }).click();
  await expect(page.getByTestId("overall-outcome")).toHaveText("Not Yet Competent", { timeout: 30_000 });
  await page.getByTestId("show-workbook").click();
  await expect(page.getByTestId("stamped-workbook").locator("[data-pdf-page='17']")).toBeAttached({ timeout: 60_000 });
});

test("PDF-WORKBOOK RIICWD525E on its workbook: 36 steps, 1.2 asks for its parts a-p, Appendix B optional, nothing of the trainer's", async ({ page }) => {
  test.skip(!RII_PDF, "the RIICWD525E workbook is not on this machine (set ASM_WORKBOOK)");
  test.setTimeout(300_000);
  const assignment = await publishWorkbook(page, RII_PDF!, 28);
  riiAssignment = assignment;
  // the RIICWD525E workbook names its own unit: the PDF template tab flagged it and the decision was audited
  expect(sql(`select count(*) from public.asm_audit_log where action = 'import_unit_mismatch' and detail->>'foundCode' = 'RIICWD525E' and detail->>'decision' = 'kept'`)).not.toBe("0");
  const base = `/agency/assessments/${assignment}`;
  await signInStaff(page, student.email, base);
  await expect(page.getByTestId("wizard-step-count")).toHaveText("Step 1 of 36", { timeout: 30_000 });
  await page.goto(`${base}?step=q-1.2`);
  await expect(page.getByTestId("answer-text")).toHaveCount(16);
  await expect(page.locator("label", { hasText: "e. Geotechnical management" })).toBeVisible();
  await page.getByTestId("answer-text").first().fill("AS 2150 Hot mix asphalt; AS 1289 soil testing; Austroads guides.");
  await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  await page.goto(`${base}?step=q-2.1.9`);
  await expect(page.getByTestId("answer-table")).toHaveCount(2);
  await expect(page.getByTestId("step-question").getByRole("columnheader")).not.toContainText(["Signature / Authority (Assessor Use)"]);
  await page.goto(`${base}?step=evaluation`);
  await expect(page.getByTestId("rating-row")).toHaveCount(18);
  await page.goto(`${base}?step=review`);
  await expect(page.getByTestId("review-missing")).toContainText("Q1.2:");
  await expect(page.getByTestId("review-missing")).toContainText("Sign the student declaration (page 7).");
  await expect(page.getByTestId("review-missing")).not.toContainText("valuation");
});

test("PDF-WORKBOOK autosave: a failed save, offline / online and an expired sign-in never show Saved, keep the answers and save them; leaving and signing out ask first; drafts belong to their student", async ({ page }) => {
  test.skip(!riiAssignment, "needs the RIICWD525E draft above");
  test.setTimeout(300_000);
  const base = `/agency/assessments/${riiAssignment}`;
  const attemptId = sql(`select id from public.asm_attempts where assignment_id = '${riiAssignment}' and attempt_no = 1`);
  const onServer = (text: string) => sql(`select (position('${text}' in responses::text) > 0)::text from public.asm_attempts where id = '${attemptId}'`);
  // unsaved answers are kept under asm-draft:<signed-in user>:<attempt>
  const userId = sql(`select id from auth.users where email = '${student.email}'`);
  const myKey = `asm-draft:${userId}:${attemptId}`;
  const inBrowser = () => page.evaluate((k) => window.localStorage.getItem(k), myKey);
  await signInStaff(page, student.email, `${base}?step=q-1.2`);
  const box = page.getByTestId("answer-text").first();
  const status = page.getByTestId("autosave");
  await expect(box).toBeVisible({ timeout: 30_000 });

  // 1. the server refuses the save: "Not saved, retrying…", never "Saved"; leaving asks first; retried until it goes through
  await failDraftSave(page, 500, { code: "57014", message: "canceling statement due to statement timeout" });
  await box.fill("FAILED-SAVE-ONE");
  await expect(status).toHaveText("Not saved, retrying…", { timeout: 10_000 });
  expect(await inBrowser()).toContain("FAILED-SAVE-ONE");
  await page.getByRole("link", { name: "My learning" }).first().click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-stay").click();
  await expect(page).toHaveURL(new RegExp(riiAssignment));
  await expect(status).not.toContainText("Saved");
  expect(onServer("FAILED-SAVE-ONE")).toBe("false");
  await page.unroute(STUDENT_RPC);
  await expect(status).toContainText("Saved", { timeout: 40_000 });
  expect(onServer("FAILED-SAVE-ONE")).toBe("true");
  expect(await inBrowser()).toBeNull();

  // 2. offline: "Offline, will save when reconnected", the answers kept in the browser, saved by themselves when back online
  await page.context().setOffline(true);
  await box.fill("OFFLINE-TWO");
  await expect(status).toHaveText("Offline, will save when reconnected", { timeout: 10_000 });
  expect(await inBrowser()).toContain("OFFLINE-TWO");
  expect(onServer("OFFLINE-TWO")).toBe("false");
  await page.context().setOffline(false);
  await expect(status).toContainText("Saved", { timeout: 40_000 });
  expect(onServer("OFFLINE-TWO")).toBe("true");
  expect(await inBrowser()).toBeNull();

  // 3. the sign-in expired: "Session expired, sign in again", nothing typed is lost, saved after signing in again
  await failDraftSave(page, 401, { code: "PGRST301", message: "JWT expired" });
  await box.fill("EXPIRED-THREE");
  await expect(status).toHaveText("Session expired, sign in again", { timeout: 10_000 });
  expect(await inBrowser()).toContain("EXPIRED-THREE");
  await page.unroute(STUDENT_RPC);
  // the sign-in is really gone now (the stored session removed), as when it expires
  await page.evaluate(() => { for (const k of Object.keys(window.localStorage)) if (/^sb-.*-auth-token$/.test(k)) window.localStorage.removeItem(k); });
  await page.getByTestId("sign-in-again").click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await page.getByRole("tab", { name: "Sign in" }).click();
  await page.locator('input[name="email"]').fill(student.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).last().click();
  await page.waitForURL(new RegExp(`/agency/assessments/${riiAssignment}`), { timeout: 30_000 });
  await expect(page.getByTestId("answer-text").first()).toHaveValue("EXPIRED-THREE", { timeout: 30_000 });
  await expect(page.getByTestId("autosave")).toContainText("Saved", { timeout: 40_000 });
  expect(onServer("EXPIRED-THREE")).toBe("true");
  expect(await inBrowser()).toBeNull();

  // 4. answers kept for another person on this browser are never shown to this student (and are not theirs to delete)
  const otherKey = `asm-draft:00000000-0000-4000-8000-0000000000ff:${attemptId}`;
  const otherCopy = sql(`select responses::text from public.asm_attempts where id = '${attemptId}'`).replace("EXPIRED-THREE", "OTHER-STUDENT");
  await page.evaluate(([k, v]) => window.localStorage.setItem(k, JSON.stringify({ v: JSON.parse(v), at: Date.now() })), [otherKey, otherCopy]);
  await page.reload();
  await expect(page.getByTestId("answer-text").first()).toHaveValue("EXPIRED-THREE", { timeout: 30_000 });
  expect(onServer("OTHER-STUDENT")).toBe("false");
  expect(await page.evaluate((k) => window.localStorage.getItem(k) !== null, otherKey)).toBe(true);
  await page.evaluate((k) => window.localStorage.removeItem(k), otherKey);

  // 4b. leftovers are kept 7 days at most: an 8-day-old copy is deleted when the app opens, a 6-day-old one stays
  const day = 24 * 60 * 60 * 1000;
  await page.evaluate(([oldK, newK, d]) => {
    window.localStorage.setItem(oldK, JSON.stringify({ v: {}, at: Date.now() - 8 * Number(d) }));
    window.localStorage.setItem(newK, JSON.stringify({ v: {}, at: Date.now() - 6 * Number(d) }));
  }, [`asm-draft:00000000-0000-4000-8000-0000000000aa:${attemptId}`, `asm-draft:00000000-0000-4000-8000-0000000000bb:${attemptId}`, String(day)]);
  await page.reload();
  await expect(page.getByTestId("answer-text").first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith("asm-draft:")).sort())).toEqual([`asm-draft:00000000-0000-4000-8000-0000000000bb:${attemptId}`]);
  await page.evaluate(() => { for (const k of Object.keys(window.localStorage)) if (k.startsWith("asm-draft:")) window.localStorage.removeItem(k); });

  // 5. signing out with unsaved answers asks first: Cancel keeps them (saved once the server answers again, then deleted);
  //    "Discard them and sign out" deletes them; a saved draft never needs asking
  const signOut = async () => { await page.locator("button[aria-haspopup=menu]").first().click(); await page.getByRole("button", { name: "Sign out" }).click(); };
  await failDraftSave(page, 500, { code: "57014", message: "canceling statement due to statement timeout" });
  await box.fill("UNSAVED-FOUR");
  await expect(status).toHaveText("Not saved, retrying…", { timeout: 10_000 });
  await signOut();
  await expect(page.getByTestId("signout-unsaved")).toContainText("You have unsaved answers. Reconnect to save them, or they'll be lost when you sign out.");
  await page.getByTestId("signout-cancel").click();
  await expect(page.getByTestId("signout-unsaved")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(riiAssignment));
  expect(await inBrowser()).toContain("UNSAVED-FOUR");
  await page.unroute(STUDENT_RPC);
  await expect(status).toContainText("Saved", { timeout: 40_000 });
  expect(onServer("UNSAVED-FOUR")).toBe("true");
  expect(await inBrowser()).toBeNull();
  await failDraftSave(page, 500, { code: "57014", message: "canceling statement due to statement timeout" });
  await box.fill("DISCARDED-FIVE");
  await expect(status).toHaveText("Not saved, retrying…", { timeout: 10_000 });
  await signOut();
  await page.getByTestId("signout-discard").click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  expect(await page.evaluate((id) => Object.keys(window.localStorage).filter((k) => k.startsWith(`asm-draft:${id}:`)).length, userId)).toBe(0);
  await page.unroute(STUDENT_RPC);
  expect(onServer("DISCARDED-FIVE")).toBe("false");
});

test("PDF-WORKBOOK a trainer of another intake is refused the marking view", async ({ page }) => {
  test.skip(!cpcAssignment, "needs the CPCCPD2012 submission above");
  const attemptId = sql(`select id from public.asm_attempts where assignment_id = '${cpcAssignment}' order by attempt_no desc limit 1`);
  await signInStaff(page, otherTrainer.email, `/staff/assessments/attempts/${attemptId}`);
  await expect(page.getByRole("alert")).toContainText(/Not your attempt/, { timeout: 15_000 });
  await expect(page.getByTestId("pdf-marking")).toHaveCount(0);
  expect(sql(`select count(*) from public.asm_audit_log where actor = (select id from auth.users where email = '${otherTrainer.email}')`)).toBe("0");
});

test("PDF-WORKBOOK unit mapping: AI suggestions (lab stand-in) are ticks to confirm, keyed by the printed question numbers; version 2 publishes", async ({ page }) => {
  test.skip(!cpcAssignment, "needs the CPCCPD2012 assessment above");
  test.setTimeout(240_000);
  const assessment = sql(`select assessment_id from public.asm_assignments where id = '${cpcAssignment}'`);
  const q11 = sql(`select q->>'label' from public.asm_assessments a join public.asm_versions v on v.id = a.current_version_id cross join lateral jsonb_array_elements(v.template->'questions') q where a.id = '${assessment}' and q->>'key' = '1.1'`);
  // the unit's requirements (as training.gov.au would give them): one says what Q1 of task 1 asks, one is unrelated
  sql(`insert into public.asm_unit_elements(unit_id, kind, code, text) values ('${unitId}', 'performance_criterion', 'P4.1', $q$${q11}$q$), ('${unitId}', 'knowledge_evidence', 'P4.KE', 'Orbital mechanics of distant moons')`);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/assessments/${assessment}?tab=mapping`);
  await expect(page.getByTestId("mapping-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("ai-suggest").click();
  const row = page.getByTestId("suggestion-row").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Task 1 · Q1");
  expect(sql(`select string_agg(question_id || ':' || state, ',') from public.asm_mapping_suggestions where assessment_id = '${assessment}'`)).toMatch(/1\.1:suggested/);
  expect(sql(`select count(*) from public.asm_unit_mappings m join public.asm_versions v on v.id = m.version_id where v.assessment_id = '${assessment}'`)).toBe("0"); // a suggestion is never a mapping
  await row.getByRole("button", { name: /^Confirm:/ }).click();
  await expect.poll(() => sql(`select count(*) from public.asm_unit_mappings m join public.asm_versions v on v.id = m.version_id where v.assessment_id = '${assessment}' and v.status = 'draft' and m.question_id = '1.1'`), { timeout: 20_000 }).toBe("1");
  await expect.poll(() => sql(`select state from public.asm_mapping_suggestions where assessment_id = '${assessment}' and question_id = '1.1' limit 1`)).toBe("confirmed");
  // the mapping change started version 2 (the workbook carried over); it publishes
  await page.reload();
  await expect(page.getByTestId("version-line")).toContainText("Editing v2 draft", { timeout: 30_000 });
  await page.getByTestId("publish-version").click();
  await page.getByRole("button", { name: "Publish", exact: true }).last().click();
  await expect(page.getByTestId("status-badge")).toHaveText("Published", { timeout: 15_000 });
  expect(sql(`select v.version_no || ':' || (v.template is not null)::text from public.asm_assessments a join public.asm_versions v on v.id = a.current_version_id where a.id = '${assessment}'`)).toBe("2:true");
});

test("PDF-WORKBOOK copy assessment: the copy has its own workbook file, the fields and the mapping", async ({ page }) => {
  test.skip(!cpcAssignment, "needs the CPCCPD2012 assessment above");
  test.setTimeout(180_000);
  const assessment = sql(`select assessment_id from public.asm_assignments where id = '${cpcAssignment}'`);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/assessments/${assessment}`);
  await expect(page.getByTestId("status-badge")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy assessment" }).click();
  await page.waitForURL((u) => /\/admin\/assessments\/[0-9a-f-]{36}/.test(u.pathname) && !u.pathname.includes(assessment), { timeout: 30_000 });
  const copy = page.url().replace(/[?#].*$/, "").split("/").pop()!;
  await expect(page.getByTestId("pdf-template-summary")).toContainText("54 pages · 14 questions", { timeout: 60_000 }); // drawn from the copied file
  expect(sql(`select title from public.asm_assessments where id = '${copy}'`)).toMatch(/^Copy of /);
  expect(sql(`select (v.template->'pdf'->>'path' like '${copy}/%')::text || ':' || jsonb_array_length(v.template->'fields') || ':' || (select count(*) from public.asm_unit_mappings m where m.version_id = v.id)
    from public.asm_versions v where v.assessment_id = '${copy}'`)).toBe(`true:${sql(`select jsonb_array_length(v.template->'fields') from public.asm_assessments a join public.asm_versions v on v.id = a.current_version_id where a.id = '${assessment}'`)}:1`);
  expect(sql(`select count(*) from storage.objects where bucket_id = 'assessment-templates' and name like '${copy}/%.pdf'`)).toBe("1");
  await expect(page.getByTestId("status-badge")).toHaveText("Draft");
});

test("PDF-WORKBOOK preview as learner: the admin walks the student wizard of the version; nothing is saved", async ({ page }) => {
  test.skip(!riiAssignment, "needs the RIICWD525E assessment above");
  test.setTimeout(180_000);
  const assessment = sql(`select assessment_id from public.asm_assignments where id = '${riiAssignment}'`);
  const counts = () => sql(`select (select count(*) from public.asm_attempts) || ':' || (select count(*) from public.asm_pdf_signatures) || ':' || (select count(*) from public.asm_audit_log) || ':' || (select count(*) from public.asm_attempt_snapshots)`);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/assessments/${assessment}`);
  const before = counts();
  await page.getByTestId("preview-learner").click();
  const dlg = page.getByTestId("learner-preview");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("wizard-step-count")).toHaveText("Step 1 of 36", { timeout: 60_000 });
  await expect(dlg.getByTestId("autosave")).toHaveText("Preview: nothing is saved");
  await dlg.getByTestId("wizard-next").click();
  await expect(dlg.getByTestId("wizard-step-count")).toHaveText("Step 2 of 36");
  await dlg.getByTestId("wizard-next").click();
  await expect(dlg.getByTestId("wizard-step-count")).toHaveText("Step 3 of 36");
  await expect(dlg.getByTestId("step-question")).toBeVisible({ timeout: 30_000 });
  await dlg.getByTestId("answer-text").first().fill("Preview answer, never saved");
  await dlg.getByTestId("wizard-back").click();
  await dlg.getByTestId("wizard-next").click();
  await expect(dlg.getByTestId("answer-text").first()).toHaveValue("Preview answer, never saved"); // kept while the preview is open
  await dlg.getByTestId("wizard-steps").getByRole("button").last().click();
  await expect(dlg.getByTestId("review-missing")).toContainText("Sign the student declaration (page 7).");
  await expect(dlg.getByTestId("submit")).toBeDisabled();
  await shot(page, "pdf-preview-as-learner");
  await dlg.getByTestId("preview-close").click();
  await expect(dlg).toHaveCount(0);
  await expect(page).not.toHaveURL(/step=/);
  expect(counts()).toBe(before); // no attempt, signature, snapshot or audit row
  await page.getByTestId("preview-learner").click();
  await dlg.getByTestId("wizard-next").click();
  await expect(dlg.getByTestId("wizard-step-count")).toHaveText("Step 2 of 36");
  await dlg.getByTestId("wizard-next").click();
  await expect(dlg.getByTestId("wizard-step-count")).toHaveText("Step 3 of 36");
  await expect(dlg.getByTestId("answer-text").first()).toHaveValue(""); // closing forgot the answers
});

// The shared dropdown in the assessment area, and two simultaneous starts of the same assessment (moved here from the old
// walkthrough in phase 4; the race uses the published RIICWD525E workbook above)
test.describe("ASM-WORKBOOK", () => {
  const workbook = RII_PDF ?? "";
  let wbStudent: { email: string; student: string };
  let wbTrainer: { email: string };
  let wbIntake = ""; let wbAssessment = "";
  const PDFS = process.env.E2E_SHOTS_DIR ?? os.tmpdir();

  test.beforeAll(async () => {
    test.skip(!workbook, "the RIICWD525E workbook PDF is not on this machine (set ASM_WORKBOOK)");
    const course = sql(`select id from public.cms_courses where code = 'RII50520'`) || `course-e2e-rii-${RUN}`;
    sql(`insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level) values ('${course}', 'e2e-rii-${RUN}', 'RII50520', 'Diploma of Civil Construction Design', 'Draft', 'Face to Face', '0403', '331212', 'Diploma') on conflict (id) do nothing`);
    // an earlier run leaves the course and unit in the lab: reuse them
    const unit = sql(`select id from public.cms_course_units where course_id = '${course}' and code = 'RIICWD525E'`) || `unit-e2e-riicwd525e-${RUN}`;
    sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${unit}', '${course}', 'RIICWD525E', 'Select Pavement surfacing') on conflict (id) do nothing`);
    wbIntake = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${course}', date '2026-01-05', date '2026-12-18', 'WB ${RUN}') returning id`).split("\n")[0];
    sql(`insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${wbIntake}', '${unit}', date '2026-01-05', date '2026-12-18')`);
    wbStudent = await createStudentLogin("wb-student");
    enrol(wbIntake, wbStudent.student);
    const t = person("wb-trainer");
    const auth = await createAuthUser(t.email);
    const profile = sql(`alter table hr.staff_profiles disable trigger staff_status_guard;
      insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values ('${auth}', 'Wendy', 'Workbook', '${t.email}', '${t.phone}', 'active') returning id;
      alter table hr.staff_profiles enable trigger staff_status_guard;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
    sql(`insert into public.intake_trainers(intake_id, staff_id) values ('${wbIntake}', '${profile}')`);
    sql(`insert into hr.staff_roles(profile_id, role, granted_by) values ('${profile}', 'trainer', '${auth}')`);
    wbTrainer = { email: t.email };
  });

  /** One screenshot of the wizard at 1440 x 1400 (the dialog scrolls inside the page, so a full-page shot would miss it). */
  async function reviewShot(page: Page, name: string, target?: ReturnType<Page["locator"]>): Promise<void> {
    const dir = process.env.E2E_SHOTS_DIR;
    if (!dir) return;
    const original = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.waitForTimeout(300);
    if (target) await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    if (original) await page.setViewportSize(original);
  }

  test("UI-SELECT: the searchable dropdown in the assessment area and on other pages (search, groups, dialog, keyboard, clear)", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page, admin.email);
    const list = page.getByRole("listbox");

    // Library course filter: search box (more than 7 courses), filtering, Enter picks, the optional filter clears
    // a freshly built lab has only a few courses: add draft filler courses so the list is long enough for its search box
    for (let n = Number(sql(`select count(*) from public.cms_courses`)); n < 9; n++) {
      sql(`insert into public.cms_courses(id, slug, code, name, status) values ('course-e2e-fill-${RUN}-${n}', 'e2e-fill-${RUN}-${n}', 'ZZF${n}${RUN.slice(-4).toUpperCase()}', 'E2E filler course ${n}', 'Draft')`);
    }
    await page.goto("/admin/assessments");
    const course = page.getByRole("combobox", { name: "Course" });
    await course.click();
    await expect(list).toBeVisible();
    await expect(page.locator("select[data-testid=library-course-filter]")).toBeAttached(); // the real <select> is still in the page
    const search = page.getByRole("searchbox", { name: "Search the options" });
    await expect(search).toBeFocused();
    await search.fill("rii50");
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option").first()).toContainText("RII50520");
    await reviewShot(page, "dd-1-library-filter-search", course);
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(course).toContainText("RII50520");
    await expect(selectOf(course)).not.toHaveValue("");
    await course.locator('[aria-label="Clear"]').click();
    await expect(course).toContainText("All courses");
    await expect(selectOf(course)).toHaveValue("");

    // inside the Add assessment dialog: the list opens in a portal over the dialog; Escape closes the list, not the dialog
    await page.goto("/admin/assessments");
    await page.getByRole("button", { name: "New assessment" }).first().click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await wizard.getByTestId("new-assessment-skip").click();
    const qual = wizard.getByRole("combobox", { name: "Qualification" });
    await expect(async () => { if (!(await list.isVisible())) await qual.click(); await expect(list).toBeVisible({ timeout: 2_000 }); }).toPass({ timeout: 20_000 });
    await page.getByRole("searchbox", { name: "Search the options" }).fill("RII50520");
    await page.keyboard.press("Enter");
    await qual.click();
    await expect(list).toBeVisible();
    await reviewShot(page, "dd-2-wizard-qualification-in-dialog", qual);
    await page.getByRole("searchbox", { name: "Search the options" }).fill("zzzz");
    await expect(page.getByText("No qualifications match")).toBeVisible();
    await reviewShot(page, "dd-3-no-match", qual);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(wizard).toBeVisible();
    await expect(qual).toBeFocused();
    // keyboard: arrows open the unit list, Enter keeps the unit
    const unit = wizard.getByRole("combobox", { name: "Unit" });
    await unit.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option").first()).toBeVisible();
    await list.getByRole("option", { name: /RIICWD525E/ }).first().click();
    await expect(unit).toContainText("RIICWD525E");
    await wizard.getByRole("button", { name: "Cancel" }).click();
    await expect(wizard).toHaveCount(0);

    // other pages that had native selects (Assessments › Settings follows the Business Rules since batch 3: read-only there)

    await page.goto("/admin/integrations/logs");
    const severity = page.getByRole("combobox", { name: /Severity/ });
    await severity.click();
    await expect(list).toBeVisible();
    await reviewShot(page, "dd-7-integration-logs", severity);
    await list.getByRole("option").nth(1).click();
    await expect(list).toHaveCount(0);
    await expect(selectOf(severity)).not.toHaveValue("");

    await page.goto("/admin/lms/completion");
    const lmsCourse = page.getByRole("combobox", { name: /^Course/ }).first();
    await lmsCourse.click();
    await expect(list).toBeVisible();
    // the search box appears only with more than 7 options (depends on how many courses the lab holds)
    const lmsSearch = page.getByRole("searchbox", { name: "Search the options" });
    if (await lmsSearch.count()) await lmsSearch.fill("RII");
    await reviewShot(page, "dd-8-lms-completion-course", lmsCourse);
    await page.keyboard.press("Escape");

    // a phone: the list fits the screen
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/assessments");
    await page.getByRole("combobox", { name: "Course" }).click();
    const box = await list.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, "dd-9-phone.png") });
  });

  /**
   * ASM-OPEN-RACE (owner, 2026-11-23): two simultaneous starts of the same assessment by the same student. A fresh assignment each
   * time (one per intake), the student enrolled in its intake.
   */
  function freshAssignment(tag: string): string {
    const course = sql(`select course_id from public.asm_assessments where id = '${wbAssessment}'`);
    const unit = sql(`select unit_id from public.asm_assessments where id = '${wbAssessment}'`);
    const intake = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${course}', date '2026-01-05', date '2026-12-18', 'Race ${tag} ${RUN}') returning id`).split("\n")[0];
    sql(`insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${intake}', '${unit}', date '2026-01-05', date '2026-12-18')`);
    enrol(intake, wbStudent.student);
    return sql(`insert into public.asm_assignments(assessment_id, version_id, intake_id, due_at)
      select a.id, v.id, '${intake}', now() + interval '30 days' from public.asm_assessments a join public.asm_versions v on v.assessment_id = a.id and v.status = 'published'
      where a.id = '${wbAssessment}' returning id`).split("\n")[0];
  }
  /** One database session as the student (psql in the lab's database container), run in the background. */
  function studentSession(uid: string, body: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn("docker", ["exec", "-i", process.env.E2E_DB_CONTAINER ?? "supabase_db_skyline-staff-lab", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { out += String(d); });
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
      child.stdin.end(`begin;
        select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
        set local role authenticated;
        ${body}
        commit;`);
    });
  }
  const attemptOf = (out: string) => out.match(/"attempt":\s*\{[^{}]*?"id":\s*"([0-9a-f-]{36})"/)?.[1] ?? out.match(/"id":\s*"([0-9a-f-]{36})"[^{}]*"attemptNo"/)?.[1] ?? "";

  test("ASM-OPEN-RACE: two simultaneous starts give the student one open attempt, and neither start fails", async () => {
    test.setTimeout(120_000);
    test.skip(!riiAssignment, "needs the published RIICWD525E workbook above");
    wbAssessment = sql(`select assessment_id from public.asm_assignments where id = '${riiAssignment}'`);
    const uid = sql(`select id from auth.users where lower(email) = lower('${wbStudent.email}')`);
    // 1. deterministic: session A creates attempt 1 and keeps its transaction open for 2 s; session B starts meanwhile, waits for
    //    A's lock, and must get A's attempt instead of "The student already has an open attempt"
    const one = freshAssignment("A");
    const open = `select (public.asm_student('assessment_open', jsonb_build_object('assignmentId', '${one}')))::text;`;
    const a = studentSession(uid, `${open} select pg_sleep(2);`);
    await new Promise((r) => setTimeout(r, 600));
    const b = studentSession(uid, open);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.out).not.toMatch(/ERROR/);
    expect(rb.out).not.toMatch(/already has an open attempt|ERROR/);
    expect(attemptOf(rb.out)).toBe(attemptOf(ra.out));
    expect(sql(`select count(*) || ':' || count(*) filter (where state = 'draft') from public.asm_attempts where assignment_id = '${one}'`)).toBe("1:1");
    // 2. the app's own call twice at the same moment (REST, as the page does on a double load), on another fresh assignment
    const two = freshAssignment("B");
    const client = anonClient();
    const { error: signInError } = await client.auth.signInWithPassword({ email: wbStudent.email, password: PASSWORD });
    expect(signInError).toBeNull();
    const call = () => client.rpc("asm_student", { p_action: "assessment_open", p_data: { assignmentId: two } });
    const results = await Promise.all([call(), call(), call()]);
    expect(results.map((r) => r.error?.message ?? "ok")).toEqual(["ok", "ok", "ok"]);
    const ids = new Set(results.map((r) => (r.data as { attempt: { id: string } }).attempt.id));
    expect(ids.size).toBe(1);
    expect(sql(`select count(*) from public.asm_attempts where assignment_id = '${two}' and state = 'draft'`)).toBe("1");
    // 3. the database still refuses a second open attempt written directly (asm_attempts_one_open)
    expect(() => sql(`insert into public.asm_attempts(assignment_id, version_id, student_id, attempt_no, due_at)
      select assignment_id, version_id, student_id, attempt_no + 1, due_at from public.asm_attempts where assignment_id = '${two}'`)).toThrow(/asm_attempts_one_open/);
  });
});

// ASM-ANY-LAYOUT (owner 2026-11-27): a workbook of another layout (CPCCPD3035): fields by rules, the rest classified by the AI (the
// lab's stand-in), each AI field marked and accepted or rejected (Publish waits), an empty area added with one click, the decisions
// kept as the layout's profile.
test("PDF-WORKBOOK any layout: CPCCPD3035 by rules, AI fields to accept, click an empty area, Publish waits, the layout profile is kept", async ({ page }) => {
  const anyPdf = workbook("CPCCPD3035_Student Assessment Pack.pdf", "ASM_WORKBOOK_3");
  test.skip(!anyPdf, "the CPCCPD3035 workbook is not on this machine (set ASM_WORKBOOK_3)");
  test.setTimeout(300_000);
  sql("delete from public.asm_layout_profiles"); // a layout seen for the first time
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/assessments");
  await page.getByRole("button", { name: "New assessment" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add assessment" });
  await dialog.getByTestId("new-assessment-skip").click();
  await choose(dialog.getByLabel("Qualification"), courseId);
  await choose(dialog.getByLabel("Unit"), unitId);
  await dialog.getByRole("button", { name: "Create and upload the workbook" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  const url = page.url().replace(/\?.*$/, ""); const id = url.split("/").pop()!;
  await page.goto(`${url}?tab=pdf`);
  await page.getByTestId("pdf-template-file").setInputFiles(anyPdf!);
  await expect(page.getByTestId("pdf-template-summary")).toContainText("19 questions", { timeout: 120_000 });
  // rules first; the AI only for the 35 areas left, on 7 pages; every call logged against the workbook
  await expect(page.getByTestId("pdf-template-ai")).toContainText("asked about 35 areas on 7 pages");
  expect(sql(`select count(*) || ':' || count(distinct page) from public.asm_ai_usage where assessment_id = '${id}'`)).toBe("7:7");
  await expect(page.getByTestId("pdf-template-ai-pending")).toBeVisible();
  await expect(page.getByTestId("field-badge").first()).toHaveText("AI", { timeout: 30_000 });
  // the unit named by the workbook (CPCCPD3035) is not the test unit: keep it, with a reason
  if (await page.getByTestId("unit-mismatch").count()) { await page.getByTestId("unit-keep-reason").fill("E2E: filed under the test unit on purpose"); await page.getByTestId("unit-keep").click(); }
  // an empty area no field covers: one click adds a field of exactly its size
  const before = await page.getByTestId("placed-field").count();
  const slot = page.getByTestId("empty-slot").first();
  await slot.scrollIntoViewIfNeeded(); await slot.click();
  await expect(page.getByTestId("placed-field")).toHaveCount(before + 1);
  // saved with AI fields still pending: Publish is refused until each is accepted or rejected
  await page.getByTestId("pdf-template-save").click();
  await expect(page.getByTestId("pdf-template-summary")).not.toContainText("Not saved", { timeout: 30_000 });
  // the server refuses Publish as the signed-in admin (checked in a rolled-back call)
  const adminUser = sql(`select auth_user_id from public.cms_users where email = '${admin.email}'`);
  expect(sql(`begin; select set_config('request.jwt.claim.sub', '${adminUser}', true), set_config('role', 'authenticated', true);
    select (public.asm_admin('version_publish', jsonb_build_object('assessmentId', '${id}'::uuid)))->'errors'->0->>'code'; rollback;`).split("\n")).toContain("ai_pending");
  await page.getByTestId("ai-accept-all").click();
  await expect(page.getByTestId("pdf-template-ai-pending")).toHaveCount(0);
  await page.getByTestId("pdf-template-save").click();
  await expect(page.getByTestId("pdf-template-summary")).not.toContainText("Not saved", { timeout: 30_000 });
  expect(sql(`select count(*) from jsonb_array_elements((select template->'fields' from public.asm_versions where assessment_id = '${id}' and status = 'draft')) f where f->>'review' = 'pending'`)).toBe("0");
  // what was decided is kept for later workbooks of this layout
  expect(Number(sql(`select coalesce(max(jsonb_array_length(corrections)), 0) from public.asm_layout_profiles`))).toBeGreaterThan(0);
  // the next reading of this layout uses the profile: no AI call
  await page.getByRole("button", { name: "Find fields again" }).click();
  await expect(page.getByTestId("pdf-template-ai")).toContainText("by this layout's saved profile; no AI needed", { timeout: 120_000 });
  expect(sql(`select count(*) from public.asm_ai_usage where assessment_id = '${id}'`)).toBe("7");
  sql(`delete from public.asm_assessments where id = '${id}'`);
});
