import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { anonClient, createAdmin, createAuthUser, createStudentLogin, person, shot, signInAsAdmin, signInThroughTheForm, PASSWORD, signOutEverywhere, sql } from "./support";

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
  sql(`begin; select set_config('rto.carry_over_planning', 'on', true); insert into public.intake_enrolments(intake_id, student_id) values ('${intakeId}', '${studentId}'); commit;`);
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
  const dialog = page.getByRole("dialog").or(page.locator(".modal-in"));
  await dialog.getByLabel("Course").selectOption(courseId);
  await dialog.getByLabel("Unit of competency").selectOption(unitId);
  await dialog.getByLabel("Title").fill(`E2E Work safely ${RUN}`);
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/);
  assessmentUrl = page.url().replace(/\?.*$/, "");

  // Builder: one task with a short answer and a single choice.
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("button", { name: "Add question" }).first().click();
  await page.getByRole("button", { name: /Short answer/ }).click();
  await page.getByLabel("Question *").fill("Name two items of PPE and say what each protects.");
  await page.getByRole("button", { name: "Add question" }).first().click();
  await page.getByRole("button", { name: /^Single choice/ }).click();
  await page.getByLabel("Question *").fill("Which comes first?");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /^Publish v1/ }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/published v1/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Assignments" }).click();
  await page.getByRole("button", { name: "Assign to batches" }).click();
  await page.getByLabel(/G1 · /).check();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText(/G1 · .*due/)).toBeVisible({ timeout: 10_000 });
  expect(sql(`select count(*) from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id where s.course_id = '${courseId}'`)).toBe("1");
});

test("the student completes and submits it with the declaration and gets a receipt", async ({ page }) => {
  await signInStaff(page, student.email, "/agency/assessments");
  await expect(page.getByRole("heading", { name: "My assessments" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
  await page.locator("[data-question] textarea").first().fill("Gloves protect the hands and glasses protect the eyes.");
  await page.locator("[data-question] input[type=radio]").first().check();
  await expect(page.getByText("Everything required is answered")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Submit assessment" }).click();
  await page.getByLabel(/I have read and agree/).check();
  await page.getByLabel(/Type your full name/).fill("E2E Student");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText(/Receipt ASM-\d{4}-\d{6}/)).toBeVisible({ timeout: 15_000 });
  expect(sql(`select state from public.asm_attempts where student_id = '${student.student}'`)).toBe("submitted");
  expect(sql(`select count(*) from public.asm_notifications n join auth.users u on u.id = n.recipient_auth_user where u.email = '${student.email}' and n.event = 'submitted'`)).toBe("1");
});

test("the trainer marks it Satisfactory and records the unit outcome", async ({ page }) => {
  await signInStaff(page, trainer.email, "/staff/assessments");
  await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
  await page.getByRole("button", { name: "Mark", exact: true }).first().click();
  await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
  await expect(page.getByText("Model answer").or(page.getByText("Auto-check suggests"))).toBeVisible();
  // Every "Satisfactory" pick in order: the criterion, the two questions, the task, then the decision.
  const picks = page.getByRole("button", { name: "Satisfactory", exact: true });
  const n = await picks.count();
  for (let i = 0; i < n; i += 1) await picks.nth(i).click();
  await page.getByRole("button", { name: "Return as Satisfactory" }).click();
  await expect(page.getByText("Returned as Satisfactory.")).toBeVisible({ timeout: 15_000 });
  expect(sql(`select state || '/' || outcome from public.asm_attempts where student_id = '${student.student}'`)).toBe("final/S");

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
  await page.goto(assessmentUrl);
  await expect(page.getByText(/Version 1 is published/)).toBeVisible();
  // the first change to a published version starts draft v2 (D-06)
  await page.getByRole("button", { name: "Add question" }).first().click();
  await page.getByRole("button", { name: /Short answer/ }).click();
  await page.getByLabel("Question *").fill("Version 2 only: describe one hazard you removed.");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Publish v2/ }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/published v2/)).toBeVisible({ timeout: 10_000 });
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
  await page.getByRole("button", { name: /G1 · / }).first().click();
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
  await expect(page.locator("[data-question]")).toHaveCount(2);
  await page.locator("[data-question] textarea").first().fill("Gloves and glasses; resubmitted.");
  await page.locator("[data-question] input[type=radio]").first().check();
  await expect(page.getByText("Everything required is answered")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Submit assessment" }).click();
  await page.getByLabel(/I have read and agree/).check();
  await page.getByLabel(/Type your full name/).fill("E2E Student");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText(/Receipt ASM-\d{4}-\d{6}/)).toBeVisible({ timeout: 15_000 });

  // the trainer returns attempt 2 Not Yet Satisfactory: attempt 3 opens inside the reassessment window
  await signInStaff(page, trainer.email, "/staff/assessments");
  await page.getByRole("button", { name: "Mark", exact: true }).first().click();
  await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
  await expect(page.getByText("Model answer").or(page.getByText("Auto-check suggests"))).toBeVisible();
  const picks = page.getByRole("button", { name: "Not yet satisfactory", exact: true });
  const n = await picks.count();
  for (let i = 0; i < n; i += 1) await picks.nth(i).click();
  await page.getByRole("button", { name: "Return for reassessment" }).click();
  await expect(page.getByText(/a reassessment attempt is open for the student/)).toBeVisible({ timeout: 15_000 });
  expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where student_id = '${student.student}'`)).toBe("1:final:S,2:returned:NYS,3:draft:-");
  expect(sql(`select (due_at > now() + interval '4 days')::text from public.asm_attempts where student_id = '${student.student}' and attempt_no = 3`)).toBe("true");

  // the student sees the result, acknowledges it and has attempt 3 open
  await signInStaff(page, student.email, "/agency/assessments");
  // attempt 1 (Satisfactory) and attempt 2 (Not Yet Satisfactory) both wait for the student
  await expect(page.getByText(/Results to acknowledge \(2\)/)).toBeVisible();
  await page.getByRole("button", { name: "I have read this result" }).last().click();
  await expect(page.getByText(/Results to acknowledge \(1\)/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "I have read this result" }).click();
  await expect(page.getByText(/Results to acknowledge/)).toHaveCount(0, { timeout: 15_000 });
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
  let wbIntake = ""; let wbAssessment = "";
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

  /** Answers every visible field of the current task (text, dates, numbers, first radio of each group, the declaration). */
  async function answerVisible(page: Page, tag: string): Promise<void> {
    const form = page.locator("[data-question]");
    for (const box of await form.locator("textarea:visible").all()) if (!(await box.inputValue())) await box.fill(`${tag} answer`);
    for (const box of await form.locator("input[type=text]:visible, input:not([type]):visible").all()) if (!(await box.inputValue())) await box.fill(`${tag}`);
    for (const box of await form.locator("input[type=date]:visible").all()) await box.fill("2026-11-20");
    for (const box of await form.locator("input[type=number]:visible").all()) if (!(await box.inputValue())) await box.fill("1");
    const seen = new Set<string>();
    for (const radio of await form.locator("input[type=radio]:visible").all()) { const name = (await radio.getAttribute("name")) ?? ""; if (!seen.has(name)) { seen.add(name); await radio.check(); } }
    for (const box of await form.locator("input[type=checkbox]:visible").all()) await box.check();
  }

  /** Every task of the open attempt answered, then submitted with the declaration. */
  async function answerAndSubmit(page: Page, tag: string): Promise<void> {
    const tabs = page.getByRole("button", { name: /^Task \d/ });
    const count = Math.max(1, await tabs.count());
    for (let i = 0; i < count; i += 1) { if (await tabs.count()) await tabs.nth(i).click(); await answerVisible(page, tag); }
    await expect(page.getByText("Everything required is answered")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Submit assessment" }).click();
    await page.getByLabel(/I have read and agree/).last().check();
    await page.getByLabel(/Type your full name/).last().fill("Wanda Student");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(/Receipt ASM-\d{4}-\d{6}/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Done" }).click();
  }

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
    test.setTimeout(180_000);
    const cpc = sql(`select id from public.cms_courses where code = 'CPC30620'`) || `course-e2e-cpc30620-${RUN}`;
    sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${cpc}', 'e2e-cpc30620-${RUN}', 'CPC30620', 'Certificate III in Painting and Decorating', 'Published') on conflict (id) do nothing`);
    const pd = sql(`select id from public.cms_course_units where course_id = '${cpc}' and code = 'CPCCPD2012'`) || `unit-e2e-cpccpd2012-${RUN}`;
    sql(`insert into public.cms_course_units(id, course_id, code, name) values ('${pd}', '${cpc}', 'CPCCPD2012', 'Use painting and decorating tools and equipment') on conflict (id) do nothing`);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /CPC30620/ }).first().click();
    await page.getByRole("button", { name: /CPCCPD2012/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog");
    await expect(wizard.getByTestId("wizard-filing")).toContainText("CPC30620 › CPCCPD2012");
    await wizard.getByRole("button", { name: /Upload workbook \(Word or PDF\)/ }).click();
    await wizard.locator("input[type=file]").first().setInputFiles(workbook);
    await expect(wizard.getByText(/2 tasks · \d+ questions/)).toBeVisible({ timeout: 90_000 });
    // the warning is on the Upload step itself, before Review, and names both units
    const warning = wizard.getByTestId("filing-mismatch");
    await expect(warning).toContainText("This workbook is for RIICWD525E Select Pavement surfacing, not CPCCPD2012");
    await expect(warning).toContainText("RII50520 › RIICWD525E");
    await expect(wizard.getByTestId("filing-check")).toContainText("Selected on the page");
    // ASM-HEADER: no header set yet: the Upload step asks for it (upload or the current Skyline logo); Next waits for it
    const ask = wizard.getByTestId("workbook-header-picker");
    await expect(ask).toContainText("Choose the workbook header (asked once)");
    await expect(ask.getByTestId("workbook-header-hint")).toContainText("PNG, at least 1200 × 300 px");
    await expect(wizard.getByRole("button", { name: "Next" })).toBeDisabled();
    await reviewShot(page, "rv-0-upload-mismatch-and-header-not-set");
    await ask.getByRole("button", { name: "Use current Skyline logo" }).click();
    await expect(ask).toHaveCount(0);
    expect(sql(`select string_agg(coalesce(workbook_header_url, '-'), ',') from public.asm_settings`)).toContain("/templates/image.png");
    // and the next step is Qualification & unit, pre-set to the workbook's unit
    await wizard.getByRole("button", { name: "Next" }).click();
    await expect(wizard.getByText("Found in the workbook")).toBeVisible();
    await expect(wizard.getByRole("alert").filter({ hasText: "CPCCPD2012" })).toBeVisible();
    await reviewShot(page, "rv-0b-unit-step-after-mismatch");
    await wizard.getByRole("button", { name: "Close the wizard" }).click();
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
    const wizard = page.getByRole("dialog");
    await expect(wizard.getByRole("heading", { name: "Add assessment" })).toBeVisible({ timeout: 20_000 });
    await expect(wizard.getByText("Start from", { exact: true })).toHaveCount(0); // the old dialog is gone
    await wizard.getByRole("button", { name: /Create manually/ }).click();
    await expect(wizard.getByText("Step 2 of 4 · Qualification & unit")).toBeVisible();
    await wizard.getByLabel("Qualification").selectOption({ label: "RII50520 — Diploma of Civil Construction Design" });
    await wizard.getByLabel("Unit").selectOption({ label: "RIICWD525E — Select Pavement surfacing" });
    await reviewShot(page, "rv-md-unit-step");
    await wizard.getByRole("button", { name: "Next" }).click();
    await expect(wizard.getByTestId("review-document")).toBeVisible();
    await expect(wizard.getByTestId("workbook-header").first().locator("img")).toHaveAttribute("src", /template-assets/);
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByLabel("Title").fill(`E2E Master Data ${RUN}`);
    await wizard.getByRole("button", { name: "Save as draft" }).click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    expect(sql(`select count(*) from public.asm_assessments a join public.cms_course_units u on u.id = a.unit_id where a.title = 'E2E Master Data ${RUN}' and u.code = 'RIICWD525E'`)).toBe("1");
  });

  test("the admin creates it from the workbook in the wizard, publishes and assigns it", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page, admin.email);
    await page.goto("/admin/lms/assessments");
    await page.getByRole("button", { name: /RII50520/ }).first().click();
    await page.getByRole("button", { name: /RIICWD525E/ }).first().click();
    await page.getByRole("button", { name: "+ Add assessment" }).click();
    const wizard = page.getByRole("dialog");
    await expect(wizard.getByTestId("wizard-filing")).toContainText("RII50520 › RIICWD525E");
    await shot(page, "wb-01-start");
    await wizard.getByRole("button", { name: /Upload workbook \(Word or PDF\)/ }).click();
    await wizard.locator("input[type=file]").first().setInputFiles(workbook);
    await expect(wizard.getByText(/2 tasks · \d+ questions/)).toBeVisible({ timeout: 90_000 });
    await shot(page, "wb-02-uploaded");
    // the workbook's unit is the page's unit: said on the Upload step, and no Qualification & unit step
    await expect(wizard.getByTestId("filing-match")).toContainText("Matches the unit selected on the page");
    await expect(wizard.getByTestId("workbook-header-picker")).toHaveCount(0); // set once: never asked again
    await expect(wizard.getByTestId("filing-mismatch")).toHaveCount(0);
    await expect(wizard.getByText("Qualification & unit")).toHaveCount(0);
    await wizard.getByRole("button", { name: "Next" }).click();
    // ASM-REVIEW: one Review step with Edit | Student view | Workbook (PDF) view; Edit looks like the workbook
    await expect(wizard.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    const doc = wizard.getByTestId("review-document");
    await expect(doc.getByTestId("review-cover")).toContainText("Student Assessment Pack");
    await expect(doc.getByTestId("review-details")).toContainText("Student ID");
    await expect(doc.getByTestId("review-details-qualification")).toContainText("RII50520");
    // item 3 in the review: the details rows say they are filled in for each student
    await expect(doc.getByTestId("review-details-people")).toContainText("Filled in for each student");
    await expect(doc.getByTestId("review-info")).toContainText("Plagiarism");
    await expect(doc.getByText(/Version Number: 1\.0/).first()).toBeVisible();
    await expect(doc.getByText(/^Q1$/).first()).toBeVisible();
    await expect(wizard.getByText(/\d+ marked “Check this”/)).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Raw HTML" })).toHaveCount(0);
    // ASM-COVER + ASM-HEADER in the page view: the STUDENT WORKBOOK cover first, then the header picture + address block
    await expect(doc.getByTestId("review-cover-page").getByTestId("workbook-cover")).toHaveAttribute("aria-label", /Student workbook, RIICWD525E Select Pavement surfacing/);
    await expect(doc.getByTestId("workbook-header").first().locator("img")).toHaveAttribute("src", /template-assets/);
    await expect(doc.getByTestId("review-cover")).not.toContainText("INDOPACIFIC");
    await reviewShot(page, "rv-cover-review-edit", doc.getByTestId("review-cover-page"));
    await reviewShot(page, "rv-1-review-edit", doc.getByTestId("review-cover"));
    await reviewShot(page, "rv-1b-review-edit-task-page", doc.getByTestId("review-task").first());
    // a text block: rich text in place, never HTML tags
    const brief = doc.getByTestId("review-task").nth(1).locator("[data-block]").filter({ has: page.locator(".asm-content") }).first();
    await brief.click();
    const editor = wizard.getByTestId("rich-block-editor");
    await expect(editor.getByRole("button", { name: "Bold" })).toBeVisible();
    for (const tool of ["Italic", "Bulleted list", "Numbered list", "Link", "Table"]) await expect(editor.getByRole("button", { name: tool })).toBeVisible();
    await expect(editor.getByText("Picture")).toHaveCount(1);
    await editor.getByRole("textbox").press("Control+End");
    await editor.getByRole("textbox").pressSequentially(" Checked in the lab review.");
    await expect(wizard.getByText(/<\/?(p|strong|h4|table)>/)).toHaveCount(0);
    await reviewShot(page, "rv-2-review-edit-text-block", brief);
    await brief.getByRole("button", { name: "Done" }).click();
    // a table question: its columns and rows typed in place; the advanced settings under a closed More options
    const table = doc.locator("[data-type=table_grid]").filter({ hasText: "Site Condition Evaluation" }).first();
    await table.click();
    await expect(table.getByTestId("table-in-place")).toBeVisible();
    const more = table.getByTestId("more-options");
    await expect(more).not.toHaveAttribute("open", "");
    await more.locator("summary").click();
    await expect(more.getByText("Show this when").first()).toBeVisible();
    await expect(more.getByText("Model / benchmark answer")).toBeVisible();
    await reviewShot(page, "rv-3-review-edit-table-more-options", table);
    await table.getByRole("button", { name: "Done" }).click();
    // item 7 in the review: Appendix A laid out as the workbook / PDF prints it, for the trainer to fill in when marking
    const appendix = doc.getByTestId("adjustment-sheet");
    await expect(appendix).toContainText("Reasonable adjustments applied");
    await expect(appendix).toContainText("Reasonable adjustment strategy");
    await expect(appendix).toContainText("Trainer/Assessor Declaration");
    await expect(appendix).toContainText("Completed by the trainer / assessor when marking");
    await reviewShot(page, "rv-3b-review-edit-appendix-a", appendix);
    await wizard.getByRole("button", { name: "Mark all as reviewed" }).click();
    await expect(wizard.getByTestId("review-all-reviewed")).toBeVisible();
    await expect(doc.getByTestId("check-this")).toHaveCount(0);
    // Student view
    await wizard.getByRole("tab", { name: "Student view" }).click();
    await expect(wizard.getByTestId("review-student-view")).toContainText(/Exactly what the student sees/);
    // items 1 and 3 as the student's page shows them: the details card, then Before you start with the compliance pages
    await expect(wizard.getByTestId("assessment-details")).toContainText("Filled in for each student");
    await expect(wizard.getByTestId("assessment-details")).toContainText("RIICWD525E");
    await expect(wizard.getByTestId("before-you-start")).toContainText("Plagiarism");
    await reviewShot(page, "rv-4a-review-student-view-before-you-start", wizard.getByTestId("assessment-details"));
    await wizard.getByRole("button", { name: /Task 2:/ }).click();
    await expect(wizard.locator("[data-testid=review-student-view] [data-question] table").first()).toBeVisible();
    await expect(wizard.locator("[data-testid=review-student-view] figure img").first()).toBeVisible();
    await expect(wizard.getByTestId("review-student-view")).toContainText("Checked in the lab review.");
    await reviewShot(page, "rv-4-review-student-view");
    // Workbook (PDF) view: the blank workbook from the export layout
    await wizard.getByRole("tab", { name: "Workbook (PDF) view" }).click();
    await expect(wizard.locator("[data-pdf-page]").nth(5)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await reviewShot(page, "rv-5-review-pdf-view", wizard.locator("[data-pdf-page]").first());
    await wizard.getByRole("button", { name: "Next" }).click();
    await expect(wizard.getByLabel("Title")).toHaveValue(/Select Pavement surfacing/);
    await shot(page, "wb-05-save");
    await expect(wizard.getByText(/still marked “Check this”/)).toHaveCount(0);
    await wizard.getByRole("button", { name: "Publish" }).click();
    await page.getByRole("button", { name: "Publish", exact: true }).last().click();
    await page.waitForURL(/\/admin\/assessments\/[0-9a-f-]{36}/, { timeout: 30_000 });
    wbAssessment = page.url().match(/assessments\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(sql(`select string_agg(v.status, ',') from public.asm_versions v where v.assessment_id = '${wbAssessment}'`)).toBe("published");
    expect(sql(`select (definition->>'instructions') ~ 'Plagiarism' and (definition::text ~ 'adjustment_record') from public.asm_versions where assessment_id = '${wbAssessment}'`)).toBe("t");
    // the in-place edit is stored as HTML, and Mark all as reviewed left no 'check this'
    expect(sql(`select definition::text ~ 'Checked in the lab review' and definition::text !~ '"confidence": "low"' from public.asm_versions where assessment_id = '${wbAssessment}'`)).toBe("t");
    await page.getByRole("button", { name: "Assignments" }).click();
    await page.getByRole("button", { name: "Assign to intakes" }).click();
    await page.getByLabel(new RegExp(`WB ${RUN}`)).check();
    await page.getByLabel(/^Due/).fill("2026-12-20T17:00");
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    await expect.poll(() => sql(`select count(*) from public.asm_assignments where assessment_id = '${wbAssessment}'`), { timeout: 15_000 }).toBe("1");
  });

  test("the student reads the information first, sees the details filled in, and submits with an evidence file", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page, wbStudent.email, "/agency/assessments");
    await page.getByRole("button", { name: "Start" }).first().click();
    await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("before-you-start")).toContainText("Plagiarism");
    await expect(page.getByTestId("before-you-start")).toContainText("Assessment appeals process");
    await expect(page.getByTestId("assessment-details")).toContainText("RIICWD525E");
    await expect(page.getByTestId("assessment-details")).toContainText("Select Pavement surfacing");
    await expect(page.getByTestId("assessment-details")).toContainText("RII50520");
    await expect(page.getByTestId("assessment-details")).not.toContainText("Filled in for each student");
    await expect(page.getByText(/already has an open attempt/)).toHaveCount(0); // ASM-OPEN-RACE: a double load opens the same attempt
    await expect(page.getByTestId("assessment-details")).toContainText("Wendy Workbook");
    await shot(page, "wb-06-student-before-you-start");
    await page.getByRole("button", { name: /I have read this – start the assessment/ }).click();
    await page.getByRole("button", { name: /^Task 2/ }).click();
    await page.locator("[data-attachments] input[type=file]").first().setInputFiles({ name: "risk-worksheet.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF") });
    await expect(page.getByText("risk-worksheet.pdf").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^Task 1/ }).click();
    await answerAndSubmit(page, "Attempt one");
    await shot(page, "wb-07-student-submitted");
    expect(sql(`select state from public.asm_attempts where student_id = '${wbStudent.student}'`)).toBe("submitted");
    expect(sql(`select count(*) from public.asm_evidence_files f join public.asm_attempts a on a.id = f.attempt_id where a.student_id = '${wbStudent.student}'`)).toBe("1");
  });

  test("the trainer marks S / NS per question, records a reasonable adjustment, returns it Not Satisfactory and exports the PDF", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page, wbTrainer.email, "/staff/assessments");
    await page.getByRole("button", { name: "Mark", exact: true }).first().click();
    await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
    await page.getByLabel("Observed", { exact: true }).first().waitFor({ timeout: 30_000 }); // the marking view has loaded
    for (const r of await page.getByLabel("Observed", { exact: true }).all()) await r.check();
    const ra = page.locator("[data-adjustment]");
    await ra.locator("input[type=radio]").first().check();
    await ra.getByLabel("Verbal assessment").check();
    await ra.locator("input[type=text], input:not([type])").first().fill("Task 1 written questions");
    await ra.locator("textarea").first().fill("The student answered two questions orally.");
    await ra.locator("input[type=text], input:not([type])").last().fill("Wendy Workbook");
    await ra.locator("input[type=date]").fill("2026-11-21");
    await ra.locator("input[type=checkbox]").last().check();
    const picks = page.getByRole("button", { name: "Satisfactory", exact: true });
    const n = await picks.count();
    for (let i = 0; i < n; i += 1) if (await picks.nth(i).isEnabled()) await picks.nth(i).click();
    // task 2 and the decision: Not Satisfactory
    const taskPicks = page.locator("button[name^='task-']").filter({ hasText: "Not yet satisfactory" });
    await taskPicks.last().click();
    await page.locator("button[name='decision']").filter({ hasText: "Not yet satisfactory" }).click();
    await shot(page, "wb-08-trainer-marking");
    await page.getByRole("button", { name: "Return for reassessment" }).click();
    await expect(page.getByText(/a reassessment attempt is open for the student/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("results-sheet")).toContainText("Not Satisfactory");
    await shot(page, "wb-09-trainer-results-sheet");
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
    const start = page.getByRole("button", { name: /I have read this – start the assessment/ });
    if (await start.isVisible()) await start.click();
    await answerAndSubmit(page, "Attempt two");

    await signInStaff(page, wbTrainer.email, "/staff/assessments");
    await page.getByRole("button", { name: "Mark", exact: true }).first().click();
    await page.waitForURL(/\/staff\/assessments\/attempts\/[0-9a-f-]{36}/);
    await page.getByLabel("Observed", { exact: true }).first().waitFor({ timeout: 30_000 }); // the marking view has loaded
    for (const r of await page.getByLabel("Observed", { exact: true }).all()) await r.check();
    const ra = page.locator("[data-adjustment]");
    await ra.locator("input[type=radio]").last().check(); // No adjustment this time
    await ra.locator("input[type=text], input:not([type])").last().fill("Wendy Workbook");
    const picks = page.getByRole("button", { name: "Satisfactory", exact: true });
    const n = await picks.count();
    for (let i = 0; i < n; i += 1) if (await picks.nth(i).isEnabled()) await picks.nth(i).click();
    await page.getByRole("button", { name: "Return as Satisfactory" }).click();
    await expect(page.getByText("Returned as Satisfactory.")).toBeVisible({ timeout: 20_000 });
    await shot(page, "wb-10-trainer-second-attempt");
    const pdf = await exportPdf(page, page.getByRole("button", { name: "Export as workbook PDF" }), "wb-attempt2-trainer.pdf");
    expect(pdf.text).toMatch(/First attempt Second attempt Third attempt/);
    expect(pdf.text).toContain("Wendy Workbook");
    expect(sql(`select string_agg(attempt_no || ':' || state || ':' || coalesce(outcome, '-'), ',' order by attempt_no) from public.asm_attempts where student_id = '${wbStudent.student}'`)).toBe("1:returned:NYS,2:final:S");

    // the student: results sheet, and Export only for the final attempt
    await signInStaff(page, wbStudent.email, "/agency/assessments");
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await page.waitForURL(/\/agency\/assessments\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("results-sheet")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Export as workbook PDF" })).toHaveCount(1);
    await shot(page, "wb-11-student-results");
    const own = await exportPdf(page, page.getByRole("button", { name: "Export as workbook PDF" }), "wb-attempt2-student.pdf");
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

