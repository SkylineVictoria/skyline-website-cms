import { expect, test, type Page } from "@playwright/test";
import { createAdmin, createAuthUser, createStudentLogin, person, signInAsAdmin, signInThroughTheForm, signOutEverywhere, sql } from "./support";

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
  batchId = sql(`insert into public.batches(intake_id, name) values ('${intakeId}', 'G1') returning id`).split("\n")[0];
  student = await createStudentLogin("asm-student");
  sql(`insert into public.batch_enrolments(batch_id, student_id) values ('${batchId}', '${student.student}')`);
  const t = person("asm-trainer");
  const trainerAuth = await createAuthUser(t.email);
  const profileId = sql(`alter table hr.staff_profiles disable trigger staff_status_guard;
    insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values ('${trainerAuth}', 'Tara', 'Trainer', '${t.email}', '${t.phone}', 'active') returning id;
    alter table hr.staff_profiles enable trigger staff_status_guard;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
  trainer = { email: t.email, profileId };
  sql(`insert into public.batch_trainers(batch_id, staff_id) values ('${batchId}', '${profileId}')`);
  // D-22: marking needs the trainer role on the staff record (require_trainer_role defaults to true)
  sql(`insert into hr.staff_roles(profile_id, role, granted_by) values ('${profileId}', 'trainer', '${trainerAuth}')`);
  // a second batch on the same intake with its own trainer, who must never reach G1's work
  otherBatchId = sql(`insert into public.batches(intake_id, name) values ('${intakeId}', 'G2') returning id`).split("\n")[0];
  const o = person("asm-trainer-other");
  const otherAuth = await createAuthUser(o.email);
  const otherProfile = sql(`alter table hr.staff_profiles disable trigger staff_status_guard;
    insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values ('${otherAuth}', 'Tom', 'Trainer', '${o.email}', '${o.phone}', 'active') returning id;
    alter table hr.staff_profiles enable trigger staff_status_guard;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
  otherTrainer = { email: o.email, profileId: otherProfile };
  sql(`insert into public.batch_trainers(batch_id, staff_id) values ('${otherBatchId}', '${otherProfile}')`);
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
