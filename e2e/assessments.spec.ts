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
  // AVETMISS (hosted 20261125025533): an enrolment needs the student's AVETMISS details; the fixture student has them
  sql(`update public.enrollment_students set sex_code = 'M', birth_country_code = '1101', home_language_code = '1201', indigenous_status_code = '4', school_level_code = '12', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N', details = coalesce(details, '{}'::jsonb) || '{"dob": "2000-01-01", "usi_number": "ABCDE12345", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC"}'::jsonb where id = '${studentId}'`);
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
  sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${courseId}', 'e2e-asm-${RUN}', 'E2E${RUN.slice(-4).toUpperCase()}', 'E2E Assessment Course ${RUN}', 'Published')`);
  unitId = `unit-e2e-asm-${RUN}`;
  sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${unitId}', '${courseId}', 'E2EU1', 'Work safely in the lab')`);
  const intakeId = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${courseId}', date '2026-01-05', date '2026-12-18', 'Jan 2026') returning id`).split("\n")[0];
  sql(`insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${intakeId}', '${unitId}', date '2026-01-05', date '2026-12-18')`);
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

test("the admin builds, publishes and assigns an assessment in the browser", async ({ page }) => {
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/assessments");
  await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
  await page.getByRole("button", { name: "New assessment" }).first().click();
  // ASM-AI-IMPORT: Add assessment = Upload -> Check -> Publish; without a workbook an empty draft opens in the builder
  const dialog = page.getByRole("dialog", { name: "Add assessment" });
  await dialog.getByTestId("start-empty").click();
  await choose(dialog.getByLabel("Qualification"), courseId);
  await choose(dialog.getByLabel("Unit"), unitId);
  await dialog.getByRole("button", { name: "Create and open the builder" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  assessmentUrl = page.url().replace(/\?.*$/, "");

  // Builder: the wizard made Task 1; two written questions go into it
  await addQuestion(page, "short_answer", "Name two items of PPE and say what each protects.");
  await addQuestion(page, "long_answer", "Which comes first, and why?");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("publish-version").click();
  await page.getByRole("button", { name: "Publish", exact: true }).last().click(); // the confirm box (rendered last)
  await expect(page.getByTestId("status-badge")).toHaveText("Published", { timeout: 10_000 });

  await page.getByRole("button", { name: "Assignments" }).click();
  await page.getByRole("button", { name: "Assign to intakes" }).click();
  await page.getByRole("dialog", { name: "Assign to intakes" }).locator("label").filter({ hasText: /^G1/ }).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect.poll(() => sql(`select count(*) from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id where s.course_id = '${courseId}'`), { timeout: 15_000 }).toBe("1");
  expect(sql(`select count(*) from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id where s.course_id = '${courseId}'`)).toBe("1");
});

test("the student completes and submits it with the declaration and gets a receipt", async ({ page }) => {
  await signInStaff(page, student.email, "/agency/assessments");
  await expect(page.getByRole("heading", { name: "My assessments" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
  // ASM-IMPORT-SIMPLE: Before you start, one step a section, then the declaration step (my own work, name, date) and submit
  await startAttempt(page);
  await page.locator("[data-question] textarea, [data-question] input:not([type]), [data-question] input[type=text]").first().fill("Gloves protect the hands and glasses protect the eyes.");
  await answerAllAndSubmit(page, "E2E");
  // the declaration is saved with the submission (no signature before starting any more)
  expect(sql(`select (declaration->>'agreed') || ':' || (char_length(declaration->>'signature') >= 2)::text || ':' || (declaration ? 'signedAt')::text from public.asm_attempts where student_id = '${student.student}'`)).toBe("true:true:true");
  expect(sql(`select count(*) from public.asm_attempt_signatures s join public.asm_attempts a on a.id = s.attempt_id where a.student_id = '${student.student}' and s.kind = 'student_declaration'`)).toBe("0");
  expect(sql(`select state from public.asm_attempts where student_id = '${student.student}'`)).toBe("submitted");
  expect(sql(`select count(*) from public.asm_notifications n join auth.users u on u.id = n.recipient_auth_user where u.email = '${student.email}' and n.event = 'submitted'`)).toBe("1");
});

test("the trainer marks it Satisfactory and records the unit outcome", async ({ page }) => {
  await signInStaff(page, trainer.email, "/staff/assessments");
  await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
  await page.getByRole("button", { name: "Mark", exact: true }).first().click();
  await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
  // the marking desk (Yes / No per question), then Sign off: task results automatic, overall outcome suggested, then released
  await markOnDesk(page);
  await expect(page.getByTestId("task-outcome").first()).toHaveText("Satisfactory");
  await expect(page.getByTestId("overall-S")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("reasonable-adjustment").fill("Extra 10 minutes agreed for reading.");
  await signOffAndRelease(page, "Clear and complete.");
  expect(sql(`select state || '/' || outcome || '/' || overall_feedback || '/' || (assessor_responses->>'reasonableAdjustment') from public.asm_attempts where student_id = '${student.student}'`)).toBe("final/S/Clear and complete./Extra 10 minutes agreed for reading.");
  expect(sql(`select string_agg(r.outcome, ',') from public.asm_task_results r join public.asm_attempts a on a.id = r.attempt_id where a.student_id = '${student.student}'`)).toBe("S");
  expect(sql(`select string_agg(kind || ':' || signer_role, ',' order by kind) from public.asm_attempt_signatures s join public.asm_attempts a on a.id = s.attempt_id where a.student_id = '${student.student}'`)).toBe("assessor_signoff:assessor");

  await page.getByRole("button", { name: "Record unit outcome" }).click();
  await page.getByLabel(/I declare that I have conducted/).check();
  await page.getByRole("button", { name: "Record and sign" }).click();
  await expect(page.getByText("Unit outcome recorded: Competent.")).toBeVisible({ timeout: 15_000 });
  expect(sql(`select outcome || '/' || signed_role from public.asm_unit_outcomes where student_id = '${student.student}' and unit_id = '${unitId}'`)).toBe("C/trainer");
  expect(sql(`select count(*) from public.asm_audit_log where action in ('submit', 'mark_return', 'unit_outcome_record') and target_id in (select id::text from public.asm_attempts where student_id = '${student.student}') or action = 'unit_outcome_record'`)).not.toBe("0");
});

test("the student sees the result and the admin sees the outcome", async ({ page }) => {
  await signInStaff(page, student.email, "/agency/assessments");
  await expect(page.getByText("Satisfactory").first()).toBeVisible();
  await page.getByRole("button", { name: "Results & progress" }).click();
  await expect(page.getByText(/Competent/)).toBeVisible({ timeout: 10_000 });

  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await page.goto(`${assessmentUrl}?tab=versions`);
  await expect(page.getByText("Version 1")).toBeVisible();
  await page.goto("/admin/assessments?tab=outcomes");
  await expect(page.getByText("Work safely in the lab").first()).toBeVisible({ timeout: 10_000 });
});

test("the admin publishes version 2 while the student's attempt stays on version 1", async ({ page }) => {
  await signInAsAdmin(page, admin.email);
  await page.goto(`${assessmentUrl}?tab=builder`); // ASM-OVERVIEW: the page opens on the Overview; questions are added in the Builder
  await expect(page.getByText(/Version 1 is published/)).toBeVisible();
  // the first change to a published version starts draft v2 (D-06)
  await addQuestion(page, "long_answer", "Version 2 only: describe one hazard you removed.");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Publish v2/ }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Version 2 published.")).toBeVisible({ timeout: 10_000 });
  const versions = sql(`select string_agg(version_no || ':' || status, ',' order by version_no) from public.asm_versions v join public.asm_assessments s on s.id = v.assessment_id where s.course_id = '${courseId}'`);
  expect(versions).toBe("1:published,2:published");
  expect(sql(`select v.version_no from public.asm_attempts t join public.asm_versions v on v.id = t.version_id where t.student_id = '${student.student}' order by t.attempt_no desc limit 1`)).toBe("1");
  expect(sql(`select v.version_no from public.asm_assignments a join public.asm_versions v on v.id = a.version_id join public.asm_assessments s on s.id = a.assessment_id where s.course_id = '${courseId}'`)).toBe("1");
});

test("a trainer of another batch is refused", async ({ page }) => {
  const attemptId = sql(`select id from public.asm_attempts where student_id = '${student.student}' order by attempt_no desc limit 1`);
  await signInStaff(page, otherTrainer.email, "/staff/assessments");
  await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark", exact: true })).toHaveCount(0);
  await page.goto(`/staff/assessments/attempts/${attemptId}`);
  await expect(page.getByRole("alert")).toContainText(/Not your student/, { timeout: 15_000 });
  await expect(page.getByText("Model answer")).toHaveCount(0);
  expect(sql(`select count(*) from public.asm_audit_log where actor = (select id from auth.users where email = '${otherTrainer.email}')`)).toBe("0");
});

test("reassessment: the admin reopens, the student resubmits, the trainer returns it Not Yet Satisfactory, a further attempt opens and the student acknowledges", async ({ page }) => {
  await signInAsAdmin(page, admin.email);
  await page.goto(`${assessmentUrl}?tab=assignments`);
  await page.getByRole("button", { name: "Assignments", exact: true }).click();
  await page.getByRole("button", { name: /v1 · due/ }).first().click();
  await page.getByRole("button", { name: /^Attempt 1: / }).click();
  await page.getByPlaceholder("Reason (recorded in the audit log)").fill("Resubmission agreed with the student");
  await page.getByRole("button", { name: "Reopen for the student" }).click();
  await expect(page.getByText("A further attempt was opened.")).toBeVisible({ timeout: 15_000 });
  expect(sql(`select string_agg(attempt_no || ':' || state, ',' order by attempt_no) from public.asm_attempts where student_id = '${student.student}'`)).toBe("1:final,2:draft");
  expect(sql(`select v.version_no from public.asm_attempts t join public.asm_versions v on v.id = t.version_id where t.student_id = '${student.student}' and t.attempt_no = 2`)).toBe("1");

  // the student answers version 1 (two questions, not the three of version 2) and submits again
  await signInStaff(page, student.email, "/agency/assessments");
  await expect(page.getByText(/Attempt 2 in progress/)).toBeVisible();
  await page.getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
  await startAttempt(page); // a further attempt opens on its work (it carries the earlier answers)
  await expect(page.locator("[data-testid=task-page] [data-question]")).toHaveCount(2);
  await page.locator("[data-question] textarea, [data-question] input:not([type]), [data-question] input[type=text]").first().fill("Gloves and glasses; resubmitted.");
  await answerAllAndSubmit(page, "Resubmitted");

  // the trainer returns attempt 2 Not Yet Satisfactory: attempt 3 opens inside the reassessment window
  await signInStaff(page, trainer.email, "/staff/assessments");
  await page.getByRole("button", { name: "Mark", exact: true }).first().click();
  await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
  await markOnDesk(page, () => true);
  await expect(page.getByTestId("task-outcome").first()).toHaveText("Not satisfactory");
  await expect(page.getByTestId("overall-NYS")).toHaveAttribute("aria-checked", "true");
  await signOffAndRelease(page, "Not yet: name the PPE.");
  await expect(page.getByText(/A reassessment attempt is open for the student/)).toBeVisible();
  expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where student_id = '${student.student}'`)).toBe("1:final:S,2:returned:NYS,3:draft:-");
  expect(sql(`select (due_at > now() + interval '4 days')::text from public.asm_attempts where student_id = '${student.student}' and attempt_no = 3`)).toBe("true");

  // the student sees the result, acknowledges it and has attempt 3 open
  await signInStaff(page, student.email, "/agency/assessments");
  // attempt 1 (Satisfactory) and attempt 2 (Not Yet Satisfactory) both wait for the student
  await expect(page.getByText(/Results to acknowledge \(2\)/)).toBeVisible();
  // each result is read and signed on its results page (ASM-AI-IMPORT stage 3)
  for (const left of [1, 0]) {
    await page.getByRole("button", { name: "Read and sign" }).last().click();
    await expect(page.getByTestId("student-results")).toBeVisible({ timeout: 20_000 });
    await drawSignature(page, page.getByTestId("acknowledge"));
    await page.getByRole("button", { name: "Sign to acknowledge" }).click();
    await expect(page.getByText(/You acknowledged the feedback on/)).toBeVisible({ timeout: 15_000 });
    await page.goto("/agency/assessments");
    if (left) await expect(page.getByText(new RegExp(`Results to acknowledge \\(${left}\\)`))).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText(/Results to acknowledge/)).toHaveCount(0, { timeout: 15_000 });
  expect(sql(`select count(*) from public.asm_attempt_signatures s join public.asm_attempts a on a.id = s.attempt_id where a.student_id = '${student.student}' and s.kind = 'student_acknowledgement'`)).toBe("2");
  await expect(page.getByText(/Attempt 3 in progress/)).toBeVisible();
  expect(sql(`select (acknowledged_at is not null)::text from public.asm_attempts where student_id = '${student.student}' and attempt_no = 2`)).toBe("true");
});

/**
 * ASM-WORKBOOK walkthrough (owner, 2026-11-23): the RIICWD525E student workbook (PDF, not in the repo: ASM_WORKBOOK=<path> or the
 * Downloads folder) goes through the Add assessment wizard, is published and assigned; the student reads the information pages,
 * sees the details filled in, answers and submits with an evidence file; the trainer marks with S / NS per question, records a
 * reasonable adjustment and returns it Not Satisfactory; the second attempt is marked Satisfactory; the trainer and the student
 * export the workbook PDF. Screenshots go to E2E_SHOTS_DIR when it is set.
 */
test.describe("ASM-WORKBOOK walkthrough", () => {
  const workbook = [process.env.ASM_WORKBOOK, `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf`].find((p) => p && existsSync(p)) ?? "";
  let wbStudent: { email: string; student: string };
  let wbTrainer: { email: string };
  let wbIntake = ""; let wbAssessment = ""; let aiAssessment = "";
  const PDFS = process.env.E2E_SHOTS_DIR ?? os.tmpdir();

  test.beforeAll(async () => {
    test.skip(!workbook, "the RIICWD525E workbook PDF is not on this machine (set ASM_WORKBOOK)");
    sql(`update public.asm_settings set workbook_header_url = null`);
    const course = sql(`select id from public.cms_courses where code = 'RII50520'`) || `course-e2e-rii-${RUN}`;
    sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${course}', 'e2e-rii-${RUN}', 'RII50520', 'Diploma of Civil Construction Design', 'Published') on conflict (id) do nothing`);
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

  /** Clicks Export as workbook PDF and returns the text of the downloaded file (pdf.js), saved next to the screenshots. */
  async function exportPdf(page: Page, button: ReturnType<Page["getByRole"]>, name: string): Promise<{ text: string; pages: number; file: string }> {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), button.click()]);
    const file = path.join(PDFS, name);
    await download.saveAs(file);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
    const texts: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) texts.push(((await (await doc.getPage(p)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ").replace(/\s+/g, " "));
    return { text: texts.join("\n"), pages: doc.numPages, file };
  }

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

  test("ASM-REVIEW bug 5: the RIICWD525E workbook uploaded on the CPCCPD2012 page is flagged on the Upload step", async ({ page }) => {
    test.setTimeout(240_000);
    const cpc = sql(`select id from public.cms_courses where code = 'CPC30620'`) || `course-e2e-cpc30620-${RUN}`;
    sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${cpc}', 'e2e-cpc30620-${RUN}', 'CPC30620', 'Certificate III in Painting and Decorating', 'Published') on conflict (id) do nothing`);
    const pd = sql(`select id from public.cms_course_units where course_id = '${cpc}' and code = 'CPCCPD2012'`) || `unit-e2e-cpccpd2012-${RUN}`;
    sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${pd}', '${cpc}', 'CPCCPD2012', 'Use painting and decorating tools') on conflict (id) do nothing`);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /CPC30620/ }).first().click();
    await page.getByRole("button", { name: /CPCCPD2012/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await expect(wizard).toContainText("CPC30620 › CPCCPD2012");
    await wizard.getByLabel(/Read without AI/).check();
    await wizard.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await expect(wizard.getByTestId("file-workbook")).toContainText("Read", { timeout: 120_000 });
    // the found card says the workbook is for another unit; the header is asked once and holds the next step
    await expect(wizard.getByTestId("found-card")).toContainText("The workbook is for RIICWD525E, not CPCCPD2012");
    const ask = wizard.getByTestId("workbook-header-picker");
    await expect(ask).toBeVisible();
    await expect(wizard.getByTestId("go-check")).toBeDisabled();
    await reviewShot(page, "ai-0-upload-mismatch-header");
    await ask.getByRole("button", { name: "Use current Skyline logo" }).click();
    await expect(wizard.getByTestId("go-check")).toBeEnabled({ timeout: 20_000 });
    await wizard.getByTestId("go-check").click();
    // the unit step appears only because the units differ
    await expect(wizard.getByRole("alert").filter({ hasText: "CPCCPD2012" })).toBeVisible();
    await expect(wizard.getByLabel("Qualification")).toBeVisible();
    await reviewShot(page, "ai-0b-unit-step-on-mismatch");
    await wizard.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(wizard).toHaveCount(0);
  });
  test("ASM-HEADER: Assessments › Settings uploads the workbook header picture, with the recommended size and a live preview", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/assessments?tab=settings");
    const picker = page.getByTestId("workbook-header-picker");
    await expect(picker.getByTestId("workbook-header-hint")).toContainText("Recommended: PNG, at least 1200 × 300 px, transparent or white background");
    await expect(picker.getByText("Using the Skyline logo that ships with the site.")).toBeVisible();
    await picker.getByTestId("workbook-header-file").setInputFiles("public/templates/image.png");
    await expect(picker.getByText("Using the uploaded header.")).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByTestId("workbook-header").locator("img")).toHaveAttribute("src", /\/storage\/v1\/object\/public\/template-assets\/.+\.png$/);
    expect(sql(`select string_agg(coalesce(workbook_header_url, '-'), ',') from public.asm_settings`)).toMatch(/template-assets\/.+\.png/);
    await reviewShot(page, "rv-hdr-settings-upload", picker);
  });

  test("ASM-ONE-FLOW: Master Data › Assessments › New assessment opens the same wizard, with the Qualification & unit step", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/assessments");
    await page.getByRole("button", { name: "New assessment" }).first().click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await expect(wizard.getByRole("heading", { name: "Add assessment" })).toBeVisible({ timeout: 20_000 });
    await expect(wizard.getByTestId("drop-workbook")).toBeVisible();
    await expect(wizard.getByTestId("drop-guide")).toBeVisible();
    // the dialog sits in the middle of the screen at a working height (owner 2026-11-25: it was short and at the top)
    for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(200);
      const box = (await wizard.getByTestId("wizard-panel").boundingBox())!;
      expect(Math.abs(box.y - (size.height - (box.y + box.height)))).toBeLessThanOrEqual(2);
      expect(box.height).toBeGreaterThanOrEqual(Math.min(640, size.height - 48) - 1);
      if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, `wizard-centred-${size.width}x${size.height}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = (await wizard.getByTestId("wizard-panel").boundingBox())!;
    expect(phone.width).toBeGreaterThanOrEqual(389); // full screen on a phone
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, "wizard-phone.png") });
    await page.setViewportSize({ width: 1280, height: 720 });
    await wizard.getByTestId("start-empty").click();
    await choose(wizard.getByLabel("Qualification"), { label: "RII50520 — Diploma of Civil Construction Design" });
    await choose(wizard.getByLabel("Unit"), { label: "RIICWD525E — Select Pavement surfacing" });
    await reviewShot(page, "ai-mdata-unit-step");
    await wizard.getByRole("button", { name: "Create and open the builder" }).click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const id = page.url().match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(sql(`select u.code from public.asm_assessments a join public.cms_course_units u on u.id = a.unit_id where a.id = '${id}'`)).toBe("RIICWD525E");
  });
  test("UI-SELECT: the searchable dropdown in the assessment area and on other pages (search, groups, dialog, keyboard, clear)", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page, admin.email);
    const list = page.getByRole("listbox");

    // Library course filter: search box (more than 7 courses), filtering, Enter picks, the optional filter clears
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

    // inside the wizard dialog: the list opens in a portal over the dialog; Escape closes the list, not the dialog
    await page.goto("/admin/assessments");
    await page.getByRole("button", { name: "New assessment" }).first().click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await wizard.getByTestId("start-empty").click();
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
    await wizard.getByRole("button", { name: "Close" }).click(); // nothing uploaded: closes without asking
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
    await page.getByRole("searchbox", { name: "Search the options" }).fill("RII");
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

  /** A synthetic answer guide for RIICWD525E (no real guide yet): every question's number from the workbook, two left out. */
  async function syntheticGuide(skip: string[]): Promise<string> {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const numbers = ["1.1", "1.2", "1.3", "1.4", "1.5", ...Array.from({ length: 11 }, (_, i) => `2.1.${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `2.2.${i + 1}`)].filter((n) => !skip.includes(n));
    const lines = ["ASSESSOR GUIDE", "RIICWD525E Select Pavement surfacing", "Version Number: 1.0", "Assessment Task 1", ...numbers.flatMap((n) => [`Q${n} Benchmark for question ${n} of the workbook`, `Model answer: the sample answer for question ${n}.`])];
    let page = doc.addPage([595, 842]); let y = 800;
    for (const line of lines) { if (y < 60) { page = doc.addPage([595, 842]); y = 800; } page.drawText(line, { x: 50, y, size: 10, font }); y -= 16; }
    const file = path.join(PDFS, "RIICWD525E_synthetic_answer_guide.pdf");
    const bytes = await doc.save();
    writeFileSync(file, Buffer.from(bytes));
    return file;
  }

  test("ASM-AI-IMPORT: workbook + answer guide read by the AI reader (lab stand-in), check the flagged items, edit, publish 1.1", async ({ page }) => {
    test.setTimeout(300_000);
    const guide = await syntheticGuide(["2.1.4", "2.1.9"]);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /RII50520/ }).first().click();
    await page.getByRole("button", { name: /RIICWD525E/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await expect(wizard).toContainText("RII50520 › RIICWD525E");
    await reviewShot(page, "ai-1a-upload-empty");
    await wizard.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await wizard.getByTestId("drop-guide").locator("input[type=file]").setInputFiles(guide);
    // ASM-OVERVIEW C: the waiting screen while the job runs, then straight to the Check step (once the header is chosen)
    await expect(wizard.getByTestId("import-waiting")).toBeVisible();
    await expect(wizard.getByTestId("import-waiting")).toContainText("This usually takes 2–5 minutes");
    const atCheck = wizard.locator('[aria-current="step"]').filter({ hasText: "Check" });
    const askFirst = wizard.getByTestId("workbook-header-picker");
    await expect(atCheck.or(askFirst)).toBeVisible({ timeout: 240_000 });
    if (await askFirst.count()) await askFirst.getByRole("button", { name: "Use current Skyline logo" }).click();
    await expect(atCheck).toBeVisible({ timeout: 60_000 });
    await expect(wizard.getByTestId("check-list")).toBeVisible();
    // back on Upload: what was found
    await wizard.getByRole("button", { name: "← Back" }).click();
    await expect(wizard.getByTestId("file-workbook")).toContainText("Read", { timeout: 180_000 });
    await expect(wizard.getByTestId("file-guide")).toContainText("Matched", { timeout: 180_000 });
    const found = wizard.getByTestId("found-card");
    await expect(found).toContainText("answers matched");
    await expect(found).toContainText("Workbook and answer guide are both for RIICWD525E");
    await expect(found).toContainText("Same version (1.0) on both documents");
    await expect(found).toContainText(/\d+ items? need/);
    await expect(wizard.getByTestId("path-Workbook")).toContainText("read by the AI reader");
    await expect(wizard.getByTestId("path-Answer guide")).toContainText("read by the AI reader");
    const askHeader = wizard.getByTestId("workbook-header-picker");
    if (await askHeader.count()) await askHeader.getByRole("button", { name: "Use current Skyline logo" }).click();
    await expect(wizard.getByTestId("go-check")).toBeEnabled({ timeout: 20_000 });
    await reviewShot(page, "ai-1-upload-found");
    // Check: only the flagged items, one line each
    await wizard.getByTestId("go-check").click();
    const list = wizard.getByTestId("check-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("No answer found in the guide");
    await expect(list.getByText("Answer missing").first()).toBeVisible();
    // the first open row: edit the question text, Save & next (struck through, "Edited")
    const editor = wizard.getByTestId("row-editor");
    await expect(editor).toBeVisible();
    const missing = list.locator("li").filter({ hasText: "No answer found in the guide" }).first();
    await missing.getByRole("button").first().click();
    await editor.getByLabel("Model answer").fill("Readings recorded for every load, within 5 % of the calculated drop.");
    await reviewShot(page, "ai-2-check-open-row");
    await editor.getByRole("button", { name: "Save & next" }).click();
    await expect(missing).toContainText("Edited");
    const second = list.locator("li").filter({ hasText: "No answer found in the guide" }).nth(1);
    await second.getByRole("button").first().click();
    await editor.getByRole("button", { name: "Leave without answer" }).click();
    await expect(second).toContainText("No answer");
    // ASM-IMPORT-CLASSIFY: two questions with the same number are a blocking row: Publish waits until each is looked at
    const blocking = list.locator("li").filter({ has: page.getByTestId("blocking-tag") });
    if (await blocking.count()) {
      await expect(wizard.getByTestId("blocking-note")).toBeVisible();
      for (let guard = 0; guard < 10 && await blocking.count(); guard++) {
        // the editor may already be open on it (Save & next / Leave without answer move to the next open row): a click would close it
        const looksGood = editor.getByRole("button", { name: "Looks good" });
        if (!(await looksGood.isVisible())) await blocking.first().getByRole("button").first().click();
        await looksGood.click();
      }
      await expect(wizard.getByTestId("blocking-note")).toHaveCount(0);
    }
    // Browse all questions: compact rows, edited inline, Edited badge and Show original
    await wizard.getByRole("button", { name: /Browse all \d+ questions/ }).click();
    const browse = wizard.getByTestId("browse-list");
    await browse.locator("li").first().getByRole("button").first().click();
    // the Needs a look editor may still be open on its last row: the browse list has its own row editor
    const bEditor = browse.getByTestId("row-editor");
    const box = bEditor.getByLabel("Question text");
    const before = await box.inputValue();
    await box.fill(`${before} (edited in the lab)`);
    await bEditor.getByRole("button", { name: "Done" }).click();
    await expect(browse.getByText("Edited").first()).toBeVisible();
    await browse.getByRole("button", { name: "Show original" }).first().click();
    await expect(browse.locator("li").first()).toContainText(before.slice(0, 30));
    await reviewShot(page, "ai-3-browse-all-edited", browse);
    // Preview PDF opens the workbook layout
    await wizard.getByTestId("preview-pdf").click();
    await expect(page.getByRole("dialog", { name: "Preview PDF" })).toContainText("version 1.1");
    await page.getByRole("button", { name: "Close the preview" }).click();
    // Publish: edits bump 1.0 -> 1.1
    await wizard.getByTestId("publish").click();
    await expect(page.getByText(/published as version 1\.1/)).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).last().click();
    await expect(wizard.getByTestId("published")).toContainText("Published · version 1.1", { timeout: 30_000 });
    await reviewShot(page, "ai-4-published");
    await wizard.getByRole("button", { name: /Open the assessment/ }).click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const id = page.url().match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    aiAssessment = id;
    expect(sql(`select definition->'source'->>'version' from public.asm_versions where assessment_id = '${id}' and status = 'published'`)).toBe("1.1");
    expect(sql(`select (definition::text ~ 'edited in the lab') and (definition::text ~ '"original"') and (definition::text !~ 'sample answer for question') from public.asm_versions where assessment_id = '${id}'`)).toBe("t");
    expect(sql(`select count(*) > 15 from public.asm_question_keys k join public.asm_versions v on v.id = k.version_id where v.assessment_id = '${id}' and k.source = 'ai'`)).toBe("t");
    expect(sql(`select count(*) from public.asm_question_keys k join public.asm_versions v on v.id = k.version_id where v.assessment_id = '${id}' and k.edited_by is not null and k.model_answer ~ 'within 5 %'`)).toBe("1");
  });

  test("ASM-BUILDER: the assessment page in the wizard's design: fix a flagged item, edit the published version, load the unit from training.gov.au, confirm AI mappings, publish v2, export the PDF", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!aiAssessment, "needs the AI-imported assessment of the test before");
    const shot = async (name: string, target?: ReturnType<Page["locator"]>) => {
      const dir = process.env.E2E_SHOTS_DIR; if (!dir) return;
      if (target) await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
    };
    const unit = sql(`select unit_id from public.asm_assessments where id = '${aiAssessment}'`);
    // the unit's requirements come from training.gov.au: the lab seeds the cache (no call to training.gov.au), with a requirement
    // worded like one of the questions so the lab's stand-in reader has something to suggest
    const label = sql(`select q->>'label' from public.asm_versions v, jsonb_path_query(v.definition, '$.tasks[*].sections[*].questions[*] ? (@.type == "long_answer" || @.type == "short_answer")') q where v.assessment_id = '${aiAssessment}' and v.status = 'published' and length(q->>'label') > 30 limit 1`);
    expect(label.length).toBeGreaterThan(30);
    const details = JSON.stringify({ elements: [
      { kind: "element", code: "1", text: "Prepare for pavement surfacing" },
      { kind: "performance_criterion", code: "1.1", text: "Work instructions and specifications are obtained and confirmed", parent: "1" },
      { kind: "element", code: "2", text: "Select the surfacing" },
      { kind: "performance_criterion", code: "2.1", text: "Surfacing options are assessed against the design requirements", parent: "2" },
      { kind: "knowledge_evidence", code: "", text: label },
      { kind: "assessment_condition", code: "", text: "Skills are demonstrated in a workplace or simulated environment" },
    ] }).replace(/'/g, "''");
    sql(`insert into public.tga_unit_content(code, details, fetched_at) values ('RIICWD525E', '${details}'::jsonb, now()) on conflict (code) do update set details = excluded.details, fetched_at = now()`);
    sql(`update public.asm_unit_elements set is_active = false where unit_id = '${unit}'`);
    sql(`delete from public.asm_mapping_suggestions where assessment_id = '${aiAssessment}'`);

    await signInAsAdmin(page, admin.email);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`/admin/assessments/${aiAssessment}?tab=builder`); // ASM-OVERVIEW: the page opens on the Overview; the Builder is "Edit"
    const builder = page.getByTestId("builder");
    await expect(builder).toBeVisible();
    await expect(page.getByTestId("published-note")).toContainText("Version 1 is published");
    // compact one-line rows grouped by task and section; no raw HTML box anywhere; no empty side panel
    await expect(builder.getByTestId("builder-task").first()).toBeVisible();
    await expect(builder.getByTestId("builder-rows").first().locator("[data-question-line]").first()).toBeVisible();
    await expect(page.getByText("Select a task, section or question")).toHaveCount(0);
    await shot("bd-1-builder");

    // edit the published version: the first change starts draft v2 (1.1 -> 1.2), with "Edited" and Show original
    const row = builder.locator("[data-question-line]").filter({ hasText: label.slice(0, 25) }).first();
    await row.getByRole("button").first().click();
    const editor = builder.getByTestId("row-editor");
    await editor.getByLabel("Question text").fill(`${label} (version 2)`);
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => sql(`select definition->'source'->>'version' from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'draft'`), { timeout: 15_000 }).toBe("1.2");
    await page.reload();
    await expect(page.getByText(/v2 draft/)).toBeVisible({ timeout: 30_000 });
    const editedId = await builder.locator("[data-question-line]").filter({ has: page.locator("span[title*=\"(version 2)\"]") }).first().getAttribute("data-question-line");
    const edited = builder.locator(`[data-question-line="${editedId}"]`);
    await expect(edited).toContainText("Edited");
    await edited.getByRole("button", { name: "Show original" }).click();
    await expect(edited.locator("span[title*=\"(version 2)\"]")).toHaveCount(1); // compact row: the first sentence; the full text in its title
    await expect(edited).not.toContainText("(version 2)");
    await shot("bd-2-edited-show-original", edited);
    await edited.getByRole("button", { name: "Show edited" }).click();

    // "Needs a look": an item still flagged (made so in the draft for the walkthrough), Save & next strikes it through
    type Q = { id: string; type: string; importMeta?: Record<string, unknown> };
    const draft = JSON.parse(sql(`select definition::text from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'draft'`)) as { tasks: { sections: { questions: Q[] }[] }[] };
    const all = draft.tasks.flatMap((t) => t.sections.flatMap((s) => s.questions));
    for (const q of all) if (q.importMeta) q.importMeta.reviewedAt = new Date().toISOString(); // the import's own flags were looked at
    const target = all.find((q) => q.type === "long_answer" || q.type === "short_answer") as Q;
    target.importMeta = { ...(target.importMeta ?? { confidence: "high" }), confidence: "low", flags: ["Text cut off in the lab"] };
    delete target.importMeta.reviewedAt;
    sql(`update public.asm_versions set definition = '${JSON.stringify(draft).replace(/'/g, "''")}'::jsonb where assessment_id = '${aiAssessment}' and status = 'draft'`);
    await page.reload();
    const look = page.getByTestId("needs-a-look");
    await expect(look).toContainText("Text cut off in the lab", { timeout: 30_000 });
    await expect(look).toContainText("1 of 1 left");
    await look.getByTestId("check-list").locator("li").first().getByRole("button").first().click();
    await shot("bd-3-needs-a-look-open", look);
    await look.getByRole("button", { name: "Save & next" }).click();
    await expect(look).toContainText("0 of 1 left");
    await expect(look.locator(".line-through").first()).toBeVisible();
    await expect.poll(() => sql(`select count(*) from public.asm_versions v, jsonb_path_query(v.definition, '$.tasks[*].sections[*].questions[*]') q where v.assessment_id = '${aiAssessment}' and v.status = 'draft' and q->>'id' = '${target.id}' and q#>>'{importMeta,reviewedAt}' is not null`), { timeout: 15_000 }).toBe("1");

    // instructions in the rich-text editor (no HTML), the "+ Add" menu, More options
    await builder.getByRole("button", { name: /Instructions shown before task 1/ }).click();
    await expect(builder.locator("[contenteditable=true]").first()).toBeVisible();
    await expect(page.locator("textarea").filter({ hasText: /<p>|<\/?strong>/ })).toHaveCount(0);
    await builder.getByRole("button", { name: /Instructions shown before task 1/ }).click();
    await builder.getByTestId("section-add").first().click();
    await expect(page.getByRole("menu")).toContainText("From bank");
    await shot("bd-4-add-menu");
    await page.keyboard.press("Escape");
    await edited.getByRole("button").first().click();
    await builder.getByRole("button", { name: /More options/ }).click();
    await expect(builder.getByLabel("Question type")).toBeVisible();
    await shot("bd-5-more-options", builder.getByTestId("row-editor"));
    await builder.getByRole("button", { name: "Done" }).first().click();

    // Unit mapping: the requirements load from training.gov.au by themselves; gaps first; AI suggestions to confirm
    await page.getByRole("button", { name: "Unit mapping" }).click();
    await expect(page.getByTestId("tga-note")).toContainText("Loaded from training.gov.au: 6 added", { timeout: 30_000 });
    await expect(page.getByTestId("coverage")).toContainText("0 of 4 requirements covered");
    await expect(page.getByTestId("coverage-gaps").locator("li")).toHaveCount(4);
    expect(sql(`select count(*) from public.asm_unit_elements e join public.asm_unit_elements p on p.id = e.parent_id where e.unit_id = '${unit}' and e.is_active and e.kind = 'performance_criterion'`)).toBe("2");
    await shot("bd-6-mapping-loaded");
    await page.getByTestId("ai-suggest").click();
    const suggestion = page.getByTestId("suggestion-row").first();
    await expect(suggestion).toBeVisible({ timeout: 60_000 });
    expect(sql(`select count(*) from public.asm_unit_mappings m join public.asm_versions v on v.id = m.version_id where v.assessment_id = '${aiAssessment}' and v.status = 'draft'`)).toBe("0");
    await shot("bd-7-ai-suggestions", page.getByTestId("ai-mapping"));
    await suggestion.getByRole("button", { name: /^Confirm/ }).click();
    await expect(suggestion).toContainText("Confirmed by");
    await expect(page.getByTestId("coverage")).toContainText("1 of 4 requirements covered");
    await expect.poll(() => sql(`select count(*) from public.asm_mapping_suggestions where assessment_id = '${aiAssessment}' and state = 'confirmed' and decided_by is not null`)).toBe("1");
    await expect.poll(() => sql(`select count(*) from public.asm_unit_mappings m join public.asm_versions v on v.id = m.version_id where v.assessment_id = '${aiAssessment}' and v.status = 'draft'`), { timeout: 15_000 }).toBe("1");
    await shot("bd-8-confirmed", page.getByTestId("coverage"));
    // "Refresh from training.gov.au" asks training.gov.au itself (not clicked in the lab: no live calls); merging twice adds
    // nothing (test:assessment-registry "tga merge")
    await expect(page.getByTestId("tga-refresh")).toBeEnabled();
    expect(sql(`select count(*) from public.asm_unit_elements where unit_id = '${unit}' and is_active`)).toBe("6");

    // publish v2: students already in an attempt stay on v1
    await page.getByRole("button", { name: /^Publish v2/ }).click();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Version 2 published.")).toBeVisible({ timeout: 15_000 });
    expect(sql(`select string_agg(version_no || ':' || status || ':' || coalesce(definition->'source'->>'version', ''), ',' order by version_no) from public.asm_versions where assessment_id = '${aiAssessment}'`)).toBe("1:published:1.1,2:published:1.2");

    // Preview PDF (the page header's "More actions"), downloaded: the footer prints version 1.2 and the edited text
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Preview PDF" }).click();
    const dialog = page.getByRole("dialog", { name: "Preview PDF" });
    await expect(dialog.getByTestId("download-pdf")).toBeVisible({ timeout: 60_000 });
    await shot("bd-9-preview-pdf");
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("download-pdf").click()]);
    const file = path.join(PDFS, "asm-builder-v2.pdf");
    await download.saveAs(file);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
    let text = ""; for (let p = 1; p <= doc.numPages; p += 1) text += ((await (await doc.getPage(p)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(" ") + "\n";
    expect(text).toMatch(/Version Number: 1\.2/);
    expect(text.replace(/\s+/g, " ")).toContain("(version 2)");
  });

  test("ASM-BUILDER-COMPACT: one line per question, ⓘ task instructions, collapsed parts, hover-only actions, 'optional' only", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!aiAssessment, "needs the AI-imported assessment of the test before");
    await signInAsAdmin(page, admin.email);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`/admin/assessments/${aiAssessment}?tab=builder`); // ASM-OVERVIEW: the page opens on the Overview; the Builder is "Edit"
    const builder = page.getByTestId("builder");
    await expect(builder.getByTestId("builder-task").first()).toBeVisible({ timeout: 30_000 });
    // the task header: title, question count; the instructions behind ⓘ, collapsed until clicked
    const task = builder.getByTestId("builder-task").first();
    await expect(task.getByTestId("task-count")).toContainText(/\d+ questions?/);
    await expect(task.getByTestId("task-info-text")).toHaveCount(0);
    if (await task.getByTestId("task-info").count()) {
      await task.getByTestId("task-info").click();
      await expect(task.getByTestId("task-info-text")).toBeVisible();
      await task.getByTestId("task-info").click();
      await expect(task.getByTestId("task-info-text")).toHaveCount(0);
    }
    await expect(task.getByTestId("task-add")).toBeVisible();
    // no "required" badge anywhere; "optional" only where a question is not required
    await expect(builder.getByTestId("row-chip").filter({ hasText: /^required$/ })).toHaveCount(0);
    const optionalRows = await builder.getByTestId("row-optional").count();
    const notRequired = Number(sql(`select count(*) from public.asm_versions v, jsonb_path_query(v.definition, '$.tasks[*].sections[*].questions[*] ? (@.required == false && @.type != "instruction" && @.type != "content" && @.type != "declaration")') q where v.assessment_id = '${aiAssessment}' and v.version_no = (select max(version_no) from public.asm_versions where assessment_id = '${aiAssessment}')`));
    expect(optionalRows).toBe(notRequired);
    // a question with parts: "n parts ▸", collapsed until clicked
    const partsToggle = builder.getByTestId("row-parts").first();
    if (await partsToggle.count()) {
      const line = builder.locator("li").filter({ has: partsToggle }).first();
      await expect(partsToggle).toContainText(/\d+ (parts?|rows?)/);
      await expect(line.getByTestId("row-children").or(line.getByTestId("row-table-rows"))).toHaveCount(0);
      await partsToggle.click();
      await expect(line.getByTestId("row-children").or(line.getByTestId("row-table-rows")).first()).toBeVisible();
    }
    // the page and the actions show on hover and on keyboard focus only
    const row = builder.getByTestId("builder-rows").first().locator("[data-question-line]").first();
    const hover = row.getByTestId("row-hover");
    await page.mouse.move(0, 0);
    await expect.poll(() => hover.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await row.hover();
    await expect.poll(() => hover.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.mouse.move(0, 0);
    await hover.locator("button:not([disabled])").first().focus(); // the first row's "Move up" is disabled
    await expect.poll(() => hover.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    // one line per question: the full text only when the row is opened
    const height = await row.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().height);
    expect(height).toBeLessThan(44);
  });

  test("ASM-UNIT-CHECK: a workbook for another unit blocks Publish until switched or kept with a reason; the decision is audited", async ({ page }) => {
    test.setTimeout(300_000);
    const cpc = sql(`select id from public.cms_courses where code = 'CPC30620'`) || `course-e2e-cpc30620-${RUN}`;
    sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${cpc}', 'e2e-cpc30620-${RUN}', 'CPC30620', 'Certificate III in Painting and Decorating', 'Published') on conflict (id) do nothing`);
    const pd = sql(`select id from public.cms_course_units where course_id = '${cpc}' and code = 'CPCCPD2012'`) || `unit-e2e-cpccpd2012-${RUN}`;
    sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${pd}', '${cpc}', 'CPCCPD2012', 'Use painting and decorating tools') on conflict (id) do nothing`);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /CPC30620/ }).first().click();
    await page.getByRole("button", { name: /CPCCPD2012/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await wizard.getByLabel(/Read without AI/).check();
    await wizard.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await expect(wizard.getByTestId("file-workbook")).toContainText("Read", { timeout: 120_000 });
    const askHeader = wizard.getByTestId("workbook-header-picker");
    if (await askHeader.count()) await askHeader.getByRole("button", { name: "Use current Skyline logo" }).click();
    await expect(wizard.getByTestId("go-check")).toBeEnabled({ timeout: 20_000 });
    await wizard.getByTestId("go-check").click();
    // on the unit step the admin files it under CPCCPD2012 anyway: the mismatch is shown and blocks
    await choose(wizard.getByLabel("Qualification"), { value: cpc });
    await choose(wizard.getByLabel("Unit"), { value: pd });
    const card = wizard.getByTestId("unit-mismatch");
    await expect(card).toContainText("This workbook looks like RIICWD525E but you selected CPCCPD2012");
    await expect(card.getByTestId("unit-switch")).toContainText("Switch to RIICWD525E");
    await reviewShot(page, "unit-1-mismatch", card);
    await wizard.getByRole("button", { name: "Continue →" }).click();
    await expect(wizard.getByTestId("publish")).toBeDisabled();
    // "Keep" needs a reason
    await card.getByTestId("unit-keep").click();
    await card.getByTestId("unit-keep-confirm").click();
    await expect(card.getByTestId("unit-keep-error")).toContainText("Say why");
    await expect(wizard.getByTestId("publish")).toBeDisabled();
    await card.getByTestId("unit-keep-reason").fill("Delivered as part of the painting course this term (lab check)");
    await card.getByTestId("unit-keep-confirm").click();
    await expect(wizard.getByTestId("unit-decided")).toContainText("Kept CPCCPD2012");
    await expect(wizard.getByTestId("publish")).toBeEnabled();
    await reviewShot(page, "unit-2-kept");
    await wizard.getByTestId("publish").click();
    await page.getByRole("button", { name: "Publish", exact: true }).last().click();
    await expect(wizard.getByTestId("published")).toBeVisible({ timeout: 30_000 });
    await wizard.getByRole("button", { name: /Open the assessment/ }).click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const id = page.url().match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(sql(`select detail->>'decision' || '|' || (detail->>'foundCode') || '|' || (detail->>'selectedCode') || '|' || (actor is not null)::text from public.asm_audit_log where target_id = '${id}' and action = 'import_unit_mismatch'`))
      .toBe("kept|RIICWD525E|CPCCPD2012|true");
    expect(sql(`select detail->>'reason' from public.asm_audit_log where target_id = '${id}' and action = 'import_unit_mismatch'`)).toContain("painting course");
  });

  test("ASM-OVERVIEW: the RIICWD525E Overview (strip, task cards, rows, grids, template), keyboard, phone width, drawer edit audited, older-import fallback", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!aiAssessment, "needs the AI-imported assessment of the tests before");
    // the owner's reader-4 read of RIICWD525E (asm_import_jobs 5f8ac5a6), kept next to the workbook like the other recorded answers
    const fx = [process.env.ASM_AI_ANSWERS_4, workbook ? workbook.replace(/\.pdf$/i, ".ai-answers-4.json") : "", path.resolve("DNT_RII50520_RIICWD525E_Select Pavement surfacing.ai-answers-4.json")].find((p) => p && existsSync(p));
    test.skip(!fx, "the reader-4 result (.ai-answers-4.json) is not here");
    const { createJiti } = await import("jiti");
    const jiti = createJiti(path.resolve("e2e") + path.sep);
    const { definitionFromAi } = await jiti.import(path.resolve("src/lib/assessment/aiDraft.ts")) as typeof import("../src/lib/assessment/aiDraft");
    const def = definitionFromAi((JSON.parse(readFileSync(fx as string, "utf8")) as { result: Parameters<typeof definitionFromAi>[0] }).result, [44, 75].map((page) => ({ page, x: 0, top: 0, bottom: 0, width: 10, height: 10, src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=" })));
    // the Overview reads the editing version: the next draft of the AI-imported assessment carries the RIICWD525E definition
    sql(`delete from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'draft'`);
    sql(`insert into public.asm_versions(tenant_id, assessment_id, version_no, definition) select tenant_id, id, (select max(version_no) + 1 from public.asm_versions where assessment_id = '${aiAssessment}'), '${JSON.stringify(def).replace(/'/g, "''")}'::jsonb from public.asm_assessments where id = '${aiAssessment}'`);
    await signInAsAdmin(page, admin.email);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`/admin/assessments/${aiAssessment}`);
    const ov = page.getByTestId("assessment-overview");
    await expect(ov).toBeVisible({ timeout: 30_000 });
    // header: breadcrumb, Draft badge, "unit code · Workbook v… · imported …", Preview as learner / Edit / Publish
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("RIICWD525E");
    await expect(page.getByTestId("status-badge")).toHaveText("Draft");
    await expect(page.getByTestId("header-line")).toContainText(/RIICWD525E · Workbook v1\.0 · imported/);
    const liveV = Number(sql(`select max(version_no) from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'published'`));
    await expect(page.getByTestId("version-line")).toHaveText(`Editing v${liveV + 1} draft · v${liveV} is live`);
    // the plan's empty parts 6. / 7. are real issues: Publish waits only for blocking ones; the Check cell links to them
    await expect(page.getByTestId("check-cell")).toContainText(/\d+ issues? to fix/);
    // summary strip from the item roles
    await expect(ov.getByTestId("count-tasks")).toHaveText("2");
    await expect(ov.getByTestId("count-questions")).toHaveText("7");
    await expect(ov.getByTestId("count-activities")).toHaveText("19");
    // two task cards, the first open
    const cards = ov.getByTestId("task-card");
    await expect(cards).toHaveCount(2);
    const [t1, t2] = [cards.nth(0), cards.nth(1)];
    await expect(t1.getByTestId("task-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(t2.getByTestId("task-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(t1.getByTestId("task-count")).toHaveText("5 questions · 3 hrs");
    await expect(t2.getByTestId("task-attached")).toContainText("Case study, 2 drawings and role-play brief attached");
    // Task 1: 1.1-1.5 only, upload / calc on 1.1, no "required", no page numbers, the reference list and declaration as requirements
    const rows1 = t1.getByTestId("overview-row");
    await expect(rows1).toHaveCount(5);
    for (const [i, n] of ["1.1", "1.2", "1.3", "1.4", "1.5"].entries()) await expect(rows1.nth(i)).toContainText(n);
    await expect(rows1.nth(0).locator("[data-chip]")).toHaveText(["upload", "calc"]);
    await expect(ov.locator("[data-chip]").filter({ hasText: /^required$/ })).toHaveCount(0);
    await expect(t1.getByTestId("overview-rows")).not.toContainText(/\bp\. ?\d/);
    await expect(t1.getByTestId("also-required")).toContainText("Reference list");
    // keyboard: Q1.2 opens with Enter to its 16 rows a-p and closes with Space; every expandable row is a button with aria-expanded
    const q12 = rows1.nth(1).getByRole("button", { name: /Outline the policies/ });
    await expect(q12).toHaveAttribute("aria-expanded", "false");
    await q12.focus(); await page.keyboard.press("Enter");
    await expect(q12).toHaveAttribute("aria-expanded", "true");
    await expect(rows1.nth(1).getByTestId("row-grid").locator("li")).toHaveCount(16);
    await expect(rows1.nth(1).getByTestId("row-grid")).toContainText("Selection approval");
    await page.keyboard.press("Space");
    await expect(q12).toHaveAttribute("aria-expanded", "false");
    expect(await ov.locator("button[aria-expanded]").evaluateAll((els) => els.every((e) => (e as HTMLElement).getBoundingClientRect().height >= 44 || (e as HTMLElement).getAttribute("aria-haspopup")))).toBe(true);
    // learner instructions: one row, opening to readable paragraphs
    const ins = t1.locator('[data-block^="ins-"]');
    await expect(ins).toContainText("7 sections · method, how, when");
    await ins.getByRole("button", { name: /Learner instructions/ }).click();
    await expect(t1.getByTestId("instructions-text").locator("h4").first()).toBeVisible();
    // Task 2 opened from the keyboard: steps, materials with pages, activities with deliverables, the plan template as one row
    await t2.getByTestId("task-toggle").focus(); await page.keyboard.press("Space");
    await expect(t2.getByTestId("task-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(t2.locator('[data-block^="steps-"]')).toContainText("General task steps · 10");
    await expect(t2.getByTestId("material-card")).toHaveCount(4);
    await t2.getByTestId("material-card").filter({ hasText: "Role-play brief" }).getByRole("button").first().click();
    await expect(t2.getByTestId("material-body").locator("h4")).toContainText(["Candidate Role", "Stakeholder Role", "Scenario", "Timing"]);
    await expect(t2.getByTestId("material-card").filter({ hasText: "Role-play brief" })).toContainText("pp. 51–52");
    const acts = t2.getByTestId("overview-row").filter({ has: page.locator('[data-chip="deliverable"]') });
    // activities grouped by occasion: Occasion 1 open (2.1-2.9 and its two response templates, no numbers), Occasion 2 collapsed
    const groups = t2.getByTestId("occasion-group");
    await expect(groups.getByTestId("rows-label")).toHaveText(["Activities · Occasion 1", "Activities · Occasion 2"]);
    const occ2 = groups.nth(1).getByTestId("occasion-toggle");
    await expect(occ2).toHaveAttribute("aria-expanded", "false");
    await expect(groups.nth(1).getByTestId("occasion-note")).toHaveText("Second observation of the same project");
    await expect(acts).toHaveCount(9);
    const loose = t2.getByTestId("overview-row").filter({ hasText: /Record Log and Clarification Response Summary|Validation Summary Report/ });
    await expect(loose).toHaveCount(2);
    await expect(loose.first()).not.toContainText("2.1.10");
    await expect(t2.getByTestId("rows-label").filter({ hasText: "Response templates" })).toHaveCount(1);
    expect((await occ2.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await occ2.focus(); await page.keyboard.press("Enter");
    await expect(occ2).toHaveAttribute("aria-expanded", "true");
    await expect(groups.nth(1).getByTestId("occasion-differences")).toContainText("10 activities (the first occasion has 9)");
    await expect(acts).toHaveCount(19);
    await expect(acts.nth(18)).toContainText("2.10");
    await expect(acts.nth(18)).toContainText("Provide Implementation Clarification");
    await expect(acts.nth(2)).toContainText("2.3");
    await expect(acts.nth(2)).toContainText("Identify and Assess Risks");
    await expect(acts.nth(2).locator('[data-chip="deliverable"]')).toHaveText("Completed Risk Assessment Worksheet");
    const plan = t2.getByTestId("overview-row").filter({ hasText: "Prepare Surfacing Selection Plan" });
    await expect(plan).toHaveCount(1);
    await expect(plan.locator('[data-chip="template"]')).toHaveText("template · 12 fields");
    await plan.getByRole("button").first().click();
    await expect(plan.locator('[data-template-item="field"]')).toHaveCount(12);
    await expect(t2.getByTestId("uploads-accepted")).toContainText("graphs · calculations · additional work");
    await reviewShot(page, "ov-1-task2-open");
    // drawer: the pencil shows on keyboard focus; Escape closes without saving; Save writes the block and the audit row
    const pencil = ins.getByTestId("block-edit");
    await page.mouse.move(0, 0);
    await pencil.focus();
    await expect.poll(() => pencil.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: /Learner instructions · Task 1/ });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    const audits = () => sql(`select count(*) from public.asm_audit_log where action = 'overview_edit' and detail->>'assessmentId' = '${aiAssessment}'`);
    expect(audits()).toBe("0");
    const scroll = await page.evaluate(() => window.scrollY);
    await pencil.click();
    const editable = drawer.locator("[contenteditable=true]").first();
    await editable.click(); await page.keyboard.press("Control+End");
    await page.keyboard.type(" Bring a calculator to the assessment (lab).");
    await drawer.getByTestId("drawer-save").click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(t1.getByTestId("instructions-text")).toContainText("Bring a calculator to the assessment (lab).");
    await expect(plan.locator('[data-template-item="field"]')).toHaveCount(12); // open rows stay open
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scroll)).toBeLessThan(200);
    await expect.poll(audits, { timeout: 15_000 }).toBe("1");
    expect(sql(`select detail->>'block' || '|' || (detail->>'after' ~ 'Bring a calculator') || '|' || (detail->>'before' !~ 'Bring a calculator') || '|' || (actor is not null) from public.asm_audit_log where action = 'overview_edit' and detail->>'assessmentId' = '${aiAssessment}'`)).toBe("instructions|true|true|true");
    expect(sql(`select (definition->'tasks'->0->>'instructions') ~ 'Bring a calculator' from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'draft'`)).toBe("t");
    // collapsed: only the header, the strip and the task cards
    await t1.getByTestId("task-toggle").click(); await t2.getByTestId("task-toggle").click();
    await expect(ov.getByTestId("overview-row")).toHaveCount(0);
    await reviewShot(page, "ov-2-collapsed");
    // phone width: the header and chips wrap, no sideways scrolling
    await page.setViewportSize({ width: 390, height: 844 });
    await t1.getByTestId("task-toggle").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await reviewShot(page, "ov-3-phone");
    // an older import (no layout 2) still renders: the plain list inside the task cards, and the hint to re-import
    sql(`update public.asm_versions set definition = definition #- '{source,layout}' where assessment_id = '${aiAssessment}' and status = 'draft'`);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.reload();
    await expect(page.getByTestId("reimport-hint")).toContainText("Re-import to get the compact view");
    await expect(ov.getByTestId("task-card")).toHaveCount(2);
    await expect(ov.getByTestId("overview-row").first()).toBeVisible();
    sql(`delete from public.asm_versions where assessment_id = '${aiAssessment}' and status = 'draft'`);
  });

  test("ASM-OVERVIEW: editing a published assessment from the Overview starts a new draft; the live version and the student's attempt keep the old text; audited", async ({ page }) => {
    test.setTimeout(120_000);
    const id = assessmentUrl.match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    test.skip(!id, "needs the assessment of the first walkthrough");
    sql(`delete from public.asm_versions where assessment_id = '${id}' and status = 'draft'`);
    const live = sql(`select max(version_no) from public.asm_versions where assessment_id = '${id}' and status = 'published'`);
    await signInAsAdmin(page, admin.email);
    await page.goto(assessmentUrl);
    const ov = page.getByTestId("assessment-overview");
    await expect(ov).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("status-badge")).toHaveText("Published");
    await expect(page.getByTestId("publish-version")).toBeDisabled();
    const row = ov.getByTestId("overview-row").filter({ hasText: "Name two items of PPE" });
    await row.hover();
    await row.getByTestId("block-edit").click();
    const drawer = page.getByRole("dialog", { name: /^Question/ });
    await drawer.getByTestId("question-text").fill("Name two items of PPE and say what each protects (overview edit).");
    await drawer.getByTestId("model-answer").fill("Gloves protect the hands; glasses protect the eyes.");
    await drawer.getByTestId("drawer-save").click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("version-line")).toHaveText(`Editing v${Number(live) + 1} draft · v${live} is live`, { timeout: 15_000 });
    await expect(page.getByTestId("publish-version")).toHaveText(`Publish v${Number(live) + 1}`);
    await expect(page.getByTestId("discard-draft")).toBeVisible();
    await expect(row).toContainText("(overview edit)");
    // the new draft has the text; the live version and every attempt's version do not
    expect(sql(`select string_agg(version_no || ':' || status || ':' || (definition::text ~ 'overview edit'), ',' order by version_no) from public.asm_versions where assessment_id = '${id}' and version_no >= ${live}`)).toBe(`${live}:published:false,${Number(live) + 1}:draft:true`);
    expect(sql(`select count(*) from public.asm_attempts t join public.asm_versions v on v.id = t.version_id where v.assessment_id = '${id}' and v.definition::text ~ 'overview edit'`)).toBe("0");
    expect(Number(sql(`select count(*) from public.asm_attempts t join public.asm_versions v on v.id = t.version_id where v.assessment_id = '${id}'`))).toBeGreaterThan(0);
    expect(sql(`select k.model_answer from public.asm_question_keys k join public.asm_versions v on v.id = k.version_id where v.assessment_id = '${id}' and v.status = 'draft' and k.model_answer ~ 'Gloves'`)).toContain("Gloves");
    expect(sql(`select detail->>'block' || '|' || (detail->>'versionNo') || '|' || (detail->>'before' ~ 'what each protects\\.') || '|' || (detail->>'after' ~ 'overview edit') from public.asm_audit_log where action = 'overview_edit' and detail->>'assessmentId' = '${id}'`)).toBe(`question|${Number(live) + 1}|true|true`);
    // discard the draft: the live version stays
    await page.getByTestId("discard-draft").click();
    await page.getByRole("button", { name: "Discard draft", exact: true }).last().click();
    await expect(page.getByTestId("status-badge")).toHaveText("Published", { timeout: 15_000 });
    expect(sql(`select count(*) from public.asm_versions where assessment_id = '${id}' and status = 'draft'`)).toBe("0");
  });

  test("ASM-OVERVIEW: the Add assessment waiting screen follows the job's progress; a failure says so with Retry; Retry lands on Check; Resume from the Library", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!aiAssessment, "needs the AI import of the tests before (the workbook's finished job)");
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /RII50520/ }).first().click();
    await page.getByRole("button", { name: /RIICWD525E/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    // a job that reads for a while and then fails (the lab's reader never fails by itself: the two RPCs answer for it here)
    const job = { id: "00000000-0000-4000-8000-0000000000aa", kind: "workbook", fileName: path.basename(workbook), pages: 89, summary: {}, usage: {}, provider: "mock", model: null, cached: false, result: null, error: null };
    const steps = [
      { state: "running", progress: { label: "Reading task 1 of 4", done: 1, total: 6 } }, { state: "running", progress: { label: "Reading task 1 of 4", done: 1, total: 6 } },
      { state: "running", progress: { label: "Reading task 4 of 4", done: 4, total: 6 } }, { state: "running", progress: { label: "Reading task 4 of 4", done: 4, total: 6 } },
      { state: "running", progress: { label: "Finishing", done: 5, total: 6 } }, { state: "running", progress: { label: "Finishing", done: 5, total: 6 } },
      { state: "failed", progress: { label: "Failed", done: 5, total: 6 }, error: "The AI reader answered 503." },
    ];
    let polls = 0;
    await page.route("**/rest/v1/rpc/asm_import_start", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...job, state: "queued", progress: { label: "Starting", done: 0, total: 1 } }) }));
    await page.route("**/rest/v1/rpc/asm_import_status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...job, ...steps[Math.min(polls++, steps.length - 1)] }) }));
    await page.evaluate(() => {
      const w = window as unknown as { __stages: string[] }; w.__stages = [];
      window.setInterval(() => { const s = document.querySelector('[data-testid="import-waiting"]')?.getAttribute("data-stage"); if (s != null && w.__stages[w.__stages.length - 1] !== s) w.__stages.push(s); }, 100);
    });
    await wizard.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await expect(wizard.getByTestId("import-waiting")).toContainText("Reading the document");
    await expect(wizard.getByTestId("import-waiting")).toContainText("You can close this window");
    await expect(wizard.getByTestId("import-waiting")).toHaveAttribute("data-stage", "2", { timeout: 60_000 });
    await reviewShot(page, "ov-4-waiting", wizard);
    const failed = wizard.getByTestId("import-failed");
    await expect(failed).toContainText("The AI reader answered 503.", { timeout: 60_000 });
    expect(await page.evaluate(() => (window as unknown as { __stages: string[] }).__stages)).toEqual(["0", "1", "2", "3"]);
    // Retry: the real job of this file (read by the test before) -> straight to the Check step
    await page.unroute("**/rest/v1/rpc/asm_import_start"); await page.unroute("**/rest/v1/rpc/asm_import_status");
    await failed.getByTestId("import-retry").click();
    await expect(wizard.locator('[aria-current="step"]').filter({ hasText: "Check" })).toBeVisible({ timeout: 120_000 });
    await wizard.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    // Resume from Assessments › Library: the finished job of this file, picked up again without reading it twice. The lab's read of
    // this file is cached from an earlier run's admin (Retry reused it), so it becomes this admin's own import, as a fresh read would be
    sql(`update public.asm_import_jobs set created_by = (select id from auth.users where email = '${admin.email}'), created_at = now() where id = (select id from public.asm_import_jobs where kind = 'workbook' and file_name = '${path.basename(workbook).replace(/'/g, "''")}' and state = 'done' order by finished_at desc limit 1)`);
    await page.goto("/admin/assessments");
    const recent = page.getByTestId("recent-imports");
    await expect(recent).toContainText(path.basename(workbook), { timeout: 30_000 });
    await expect(recent).toContainText("Read · ready to check");
    await recent.getByTestId("import-resume").first().click();
    const resumed = page.getByRole("dialog", { name: "Add assessment" });
    await expect(resumed.getByTestId("resume-note")).toContainText(`Choose ${path.basename(workbook)} below to check it`, { timeout: 30_000 });
    const jobs = sql(`select count(*) from public.asm_import_jobs where file_name = '${path.basename(workbook).replace(/'/g, "''")}' and kind = 'workbook'`);
    await resumed.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await expect(resumed.locator('[aria-current="step"]').filter({ hasText: /Unit|Check/ })).toBeVisible({ timeout: 120_000 }); // from the Library: the unit step first
    expect(sql(`select count(*) from public.asm_import_jobs where file_name = '${path.basename(workbook).replace(/'/g, "''")}' and kind = 'workbook'`)).toBe(jobs);
  });

  test("ASM-AI-IMPORT: forced fallback (Read without AI) uses the standard reader, says so, and is published and assigned", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /RII50520/ }).first().click();
    await page.getByRole("button", { name: /RIICWD525E/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog", { name: "Add assessment" });
    await wizard.getByTestId("skip-ai").check();
    await wizard.getByTestId("drop-workbook").locator("input[type=file]").setInputFiles(workbook);
    await expect(wizard.getByTestId("file-workbook")).toContainText("Read", { timeout: 120_000 });
    await expect(wizard.getByTestId("path-Workbook")).toContainText("read with the standard reader: Read without AI (as you asked).");
    await expect(wizard.getByTestId("found-card")).toContainText("RIICWD525E");
    const askHeader = wizard.getByTestId("workbook-header-picker");
    if (await askHeader.count()) await askHeader.getByRole("button", { name: "Use current Skyline logo" }).click();
    await reviewShot(page, "ai-5-fallback-found");
    await wizard.getByTestId("go-check").click();
    await reviewShot(page, "ai-6-fallback-check");
    await wizard.getByTestId("publish").click();
    await page.getByRole("button", { name: "Publish", exact: true }).last().click();
    await expect(wizard.getByTestId("published")).toContainText("Published", { timeout: 30_000 });
    await wizard.getByRole("button", { name: /Open the assessment/ }).click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    wbAssessment = page.url().match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(sql(`select string_agg(v.status, ',') from public.asm_versions v where v.assessment_id = '${wbAssessment}'`)).toBe("published");
    expect(sql(`select (definition->>'instructions') ~ 'Plagiarism' and (definition::text ~ 'adjustment_record') from public.asm_versions where assessment_id = '${wbAssessment}'`)).toBe("t");
    await page.getByRole("button", { name: "Assignments" }).click();
    await page.getByRole("button", { name: "Assign to intakes" }).click();
    await page.getByLabel(new RegExp(`WB ${RUN}`)).check();
    if (await page.getByLabel(/^Due/).count()) await page.getByLabel(/^Due/).fill("2026-12-20T17:00"); // the Master unit dates are the default (20261125041517)
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    await expect.poll(() => sql(`select count(*) from public.asm_assignments where assessment_id = '${wbAssessment}'`), { timeout: 15_000 }).toBe("1");
  });
  test("the student reads the information first, sees the details filled in, and submits with an evidence file", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page, wbStudent.email, "/agency/assessments");
    await page.getByRole("button", { name: "Start" }).first().click();
    await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("assessment-details")).toContainText("RIICWD525E");
    await expect(page.getByTestId("assessment-details")).toContainText("Select Pavement surfacing");
    await expect(page.getByTestId("assessment-details")).toContainText("RII50520");
    await expect(page.getByTestId("assessment-details")).toContainText("Filled in for you");
    await expect(page.getByText(/already has an open attempt/)).toHaveCount(0); // ASM-OPEN-RACE: a double load opens the same attempt
    await expect(page.getByTestId("assessment-details")).toContainText("Wendy Workbook");
    await page.getByRole("button", { name: /Read the full instructions and rules/ }).click();
    await expect(page.getByRole("dialog", { name: "Instructions and rules" })).toContainText("Plagiarism");
    await reviewShot(page, "st-0-instructions-drawer");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("declare").check();
    await drawSignature(page);
    await reviewShot(page, "st-1-before-you-start");
    await page.getByTestId("start-task").click();
    await expect(page.getByTestId("task-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-rail-item").first()).toContainText(/\d+ of \d+ answered/);
    await page.getByTestId("task-rail-item").nth(1).click();
    await page.locator("[data-testid=task-page] [data-question] input[type=file]").first().setInputFiles({ name: "risk-worksheet.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF") });
    await expect(page.getByText("risk-worksheet.pdf").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("reference-item").first()).toBeVisible();
    await reviewShot(page, "st-2-task-page-with-reference");
    await page.getByTestId("task-rail-item").first().click();
    await answerTaskPage(page, "Attempt one");
    await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 15_000 });
    await reviewShot(page, "st-3-task-1-answered");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOTS_DIR, "st-3b-task-phone.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await answerAllAndSubmit(page, "Attempt one");
    await reviewShot(page, "st-5-submitted");
    await shot(page, "wb-07-student-submitted");
    expect(sql(`select state from public.asm_attempts where student_id = '${wbStudent.student}'`)).toBe("submitted");
    expect(sql(`select count(*) from public.asm_evidence_files f join public.asm_attempts a on a.id = f.attempt_id where a.student_id = '${wbStudent.student}'`)).toBe("1");
  });

  test("the trainer marks S / NS per question, records a reasonable adjustment, returns it Not Satisfactory and exports the PDF", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page, wbTrainer.email, "/staff/assessments");
    await page.getByRole("button", { name: "Mark", exact: true }).first().click();
    await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
    await markOnDesk(page, (eyebrow) => /Task 2 · Question 2\.1\.1$/.test(eyebrow.trim()), "tr-1-marking-desk");
    await page.getByRole("button", { name: "Record a reasonable adjustment" }).click();
    const ra = page.locator("[data-adjustment]");
    await ra.locator("input[type=radio]").first().check();
    await ra.getByLabel("Verbal assessment").check();
    await ra.locator("input[type=text], input:not([type])").first().fill("Task 1 written questions");
    await ra.locator("textarea").first().fill("The student answered two questions orally.");
    await ra.locator("input[type=text], input:not([type])").last().fill("Wendy Workbook");
    await ra.locator("input[type=date]").fill("2026-11-21");
    await ra.locator("input[type=checkbox]").last().check();
    await expect(page.getByTestId("assessment-summary")).toContainText("Not Yet Competent (NYC)");
    await signOffAndRelease(page, "Task feedback from the sign-off.", "tr-2-sign-off");
    await expect(page.getByTestId("results-sheet-task").nth(1)).toContainText("Not satisfactory");
    await reviewShot(page, "tr-3-released");
    const pdf = await exportPdf(page, page.getByRole("button", { name: "Export as workbook PDF" }), "wb-attempt1-trainer.pdf");
    expect(pdf.text).toContain("Unit Code: RIICWD525E");
    // ASM-COVER: the export starts with the STUDENT WORKBOOK cover, filled in for this student; numbering starts after it
    expect(pdf.text.split("\n")[0]).toMatch(/S\s?T\s?U\s?D\s?E\s?N\s?T\s*W\s?O\s?R\s?K\s?B\s?O\s?O\s?K/);
    expect(pdf.text.split("\n")[0]).toContain("Student Name:");
    expect(pdf.text).toContain(`Page 1 of ${pdf.pages - 1}`);
    expect(pdf.text).toContain("Appendix A – Reasonable Adjustments");
    expect(pdf.text).toContain("The student answered two questions orally.");
    // items 1 / 3 / 7 in the export: compliance pages, the filled-in details, Appendix A ticked as recorded
    expect(pdf.text).toContain("Assessment information");
    expect(pdf.text).toMatch(/Plagiarism/);
    expect(pdf.text).toMatch(/Trainer Full Name Wendy Workbook/);
    expect(pdf.text).toMatch(/Trainer\/Assessor Name Wendy Workbook/);
    expect(pdf.text).toContain("Assessment Task - 2 - Results Sheet");
    expect(pdf.text).toContain(`Page ${pdf.pages - 1} of ${pdf.pages - 1}`); // the cover is not numbered
    expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where student_id = '${wbStudent.student}'`)).toBe("1:returned:NYS,2:draft:-");
  });

  test("the second attempt is marked Satisfactory; the trainer's and the student's exports show both attempts", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page, wbStudent.email, "/agency/assessments");
    await page.getByRole("button", { name: /^(Open|Start|Continue)/ }).first().click();
    await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
    await startWithDeclaration(page);
    await answerAllAndSubmit(page, "Attempt two");

    await signInStaff(page, wbTrainer.email, "/staff/assessments");
    await page.getByRole("button", { name: "Mark", exact: true }).first().click();
    await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
    await markOnDesk(page);
    await page.getByRole("button", { name: "Record a reasonable adjustment" }).click();
    const ra = page.locator("[data-adjustment]");
    await ra.locator("input[type=radio]").last().check(); // No adjustment this time
    await ra.locator("input[type=text], input:not([type])").last().fill("Wendy Workbook");
    await expect(page.getByTestId("assessment-summary")).toContainText("Competent (C)");
    await signOffAndRelease(page, "Well done on the second attempt.");
    const pdf = await exportPdf(page, page.getByRole("button", { name: "Export as workbook PDF" }), "wb-attempt2-trainer.pdf");
    // ASM-AI-IMPORT stage 5: the signatures are stamped (declaration, the assessor per attempt on each results sheet, the summary)
    expect(pdf.text).toMatch(/Assessor signature Wendy Workbook · \d{2}\/\d{2}\/\d{4} Wendy Workbook · \d{2}\/\d{2}\/\d{4}/);
    expect(pdf.text).toMatch(/Student Signature E2E Student · /);
    expect(pdf.text).toMatch(/First attempt Second attempt Third attempt/);
    expect(pdf.text).toContain("Wendy Workbook");
    expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where student_id = '${wbStudent.student}'`)).toBe("1:returned:NYS,2:final:S");

    // the student: results sheet, and Export only for the final attempt
    await signInStaff(page, wbStudent.email, "/agency/assessments");
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("student-results")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-result")).toHaveCount(2);
    await drawSignature(page, page.getByTestId("acknowledge"));
    await reviewShot(page, "st-6-results-acknowledge");
    await page.getByRole("button", { name: "Sign to acknowledge" }).click();
    await expect(page.getByText(/You acknowledged the feedback on/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Export as workbook PDF" })).toHaveCount(1);
    await shot(page, "wb-11-student-results");
    const own = await exportPdf(page, page.getByRole("button", { name: "Export as workbook PDF" }), "wb-attempt2-student.pdf");
    expect(own.text).toMatch(/Student Acknowledgement E2E Student · \d{2}\/\d{2}\/\d{4}/);
    expect(own.text).toMatch(/Assessor Signature Wendy Workbook · /);
    expect(own.text).toContain("Student Full Name");
    expect(own.text).toContain("Assessment Task - 1 - Results Sheet");
  });

  /**
   * ASM-OPEN-RACE (owner, 2026-11-23): two simultaneous starts of the same assessment by the same student. A fresh assignment each
   * time (one per intake), the student enrolled in its intake.
   */
  function freshAssignment(tag: string): string {
    const course = sql(`select id from public.cms_courses where code = 'RII50520' limit 1`);
    const unit = sql(`select id from public.cms_course_units where course_id = '${course}' and code = 'RIICWD525E' limit 1`);
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


// ASM-PDF-TEMPLATE (2026-11-26): the workbook PDF used as it is, like an e-sign template: the admin uploads it on the PDF template tab,
// its answer boxes, the trainer's marks and the record values are found on its pages, shown on the PDF and saved on the draft.
test("the admin uploads the workbook PDF and its fields are found and saved on the draft", async ({ page }) => {
  const file = [process.env.ASM_WORKBOOK, "DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf", path.join(os.homedir(), "Downloads", "DNT_RII50520_RIICWD525E_Select Pavement surfacing.pdf")].find((p) => p && existsSync(p));
  test.skip(!file, "the RIICWD525E workbook is not on this machine (set ASM_WORKBOOK)");
  test.setTimeout(180_000);
  await signInAsAdmin(page, admin.email);
  await page.goto(`${assessmentUrl}?tab=pdf`);
  await expect(page.getByTestId("pdf-template-upload")).toBeVisible();
  await page.getByTestId("pdf-template-file").setInputFiles(file!);
  await expect(page.getByTestId("pdf-template-summary")).toContainText("103 pages · 28 questions · 2 tasks", { timeout: 90_000 });
  await expect(page.getByTestId("pdf-template-questions")).toContainText("2.1.8");
  await expect(page.getByTestId("placed-field").first()).toBeAttached();
  await shot(page, "asm-pdf-template");
  await page.getByTestId("pdf-template-save").click();
  await expect(page.getByTestId("pdf-template-summary")).toContainText("Draft v", { timeout: 30_000 });
  await expect(page.getByTestId("pdf-template-summary")).not.toContainText("Not saved");
  const id = assessmentUrl.split("/").pop();
  expect(Number(sql(`select jsonb_array_length(template->'fields') from public.asm_versions where assessment_id = '${id}' and status = 'draft'`))).toBeGreaterThan(900);
  expect(sql(`select count(*) from storage.objects where bucket_id = 'assessment-templates' and name like '${id}/%.pdf'`)).toBe("1");
  expect(sql(`select count(*) from public.asm_audit_log where action = 'template_save' and detail->>'assessmentId' = '${id}'`)).toBe("1");
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
  await dialog.getByTestId("start-empty").click();
  await choose(dialog.getByLabel("Qualification"), courseId);
  await choose(dialog.getByLabel("Unit"), unitId);
  await dialog.getByRole("button", { name: "Create and open the builder" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  const url = page.url().replace(/\?.*$/, "");
  const id = url.split("/").pop()!;
  await page.goto(`${url}?tab=pdf`);
  await page.getByTestId("pdf-template-file").setInputFiles(file);
  await expect(page.getByTestId("pdf-template-summary")).toContainText(`${questions} questions`, { timeout: 90_000 });
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

test("PDF-WORKBOOK CPCCPD2012 on its workbook: questions cropped from the PDF, tables as grids or cards, autosave, review, each declaration signed and submit", async ({ page }) => {
  test.skip(!CPC_PDF, "the CPCCPD2012 workbook is not on this machine (set ASM_WORKBOOK_2)");
  test.setTimeout(600_000);
  cpcAssignment = await publishWorkbook(page, CPC_PDF!, 14);
  const base = `/agency/assessments/${cpcAssignment}`;
  await signInStaff(page, student.email, base);
  await expect(page.getByTestId("pdf-wizard")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wizard-step-count")).toHaveText("Step 1 of 21");
  await expect(page.getByTestId("record-fields")).toContainText(student.email);
  // a text question: the question as printed, the answer, how it fits its box
  await page.goto(`${base}?step=q-1.1`);
  await expect(page.getByTestId("question-crop").locator("canvas")).toBeVisible();
  await page.getByTestId("answer-text").first().fill("Brushes, rollers and spray equipment are cleaned straight after use with the right solvent, dried and stored hanging so the bristles keep their shape. ".repeat(4).trim());
  await expect(page.getByTestId("autosave")).toContainText(/Saved/, { timeout: 10_000 });
  await expect(page.getByTestId("fit-preview")).toBeVisible();
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
  await expect(page.locator("[data-pdf-page='13'] canvas")).toBeVisible({ timeout: 30_000 });
  for (const key of CPC_KEYS) await page.locator(`[data-testid=marking-question][data-key='${key}']`).getByTestId(key === "2.3" ? "mark-NYS" : "mark-S").click();
  await page.locator("[data-testid=marking-question][data-key='2.3'] input").fill("Add the safe method of use for each tool.");
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
  for (const key of CPC_KEYS) await page.locator(`[data-testid=marking-question][data-key='${key}']`).getByTestId("mark-S").click();
  await expect(page.getByTestId("marking-missing")).toContainText("page 43");
  await tickEvidence(page, "yes");
  await expect(page.getByTestId("marking-missing")).toHaveCount(0);
  await page.getByTestId("overall-S").click();
  await page.getByTestId("overall-feedback").fill("Competent: all tasks satisfactory.");
  await page.getByTestId("signoff-sign").click();
  await expect(page.getByTestId("signoff-done")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("decide").click();
  await expect(page.getByTestId("stored-final")).toContainText("Sign-off copy", { timeout: 60_000 });
  // attempt 1 keeps its own answers, marks and checklists: opened from attempt 2's history, read-only
  await page.getByTestId("earlier-attempts").getByRole("link", { name: "Attempt 1" }).click();
  await expect(page.getByTestId("decided")).toContainText("Returned for resubmission", { timeout: 30_000 });
  await expect(page.locator("[data-testid=marking-question][data-key='2.3']").getByTestId("mark-NYS")).toHaveAttribute("aria-pressed", "true");
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
