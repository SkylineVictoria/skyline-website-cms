import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E_API_URL, E2E_ANON_KEY, E2E_MAIL_URL, E2E_PORT } from "./env";
import { PASSWORD, PDF, createAdmin, createAuthUser, createStudentLogin, domSnapshot, latestLink, markStudentDocumentRead, pdfFor, person, resetRateLimits, shot, signInThroughTheForm, signedInClient, sql } from "./support";
import { courses } from "../src/data/courses";

// Existing flows must behave exactly as before: student registration, agent registration, and the admin staff invitation.
test.describe.configure({ mode: "serial" });
test.beforeAll(() => { resetRateLimits(); });

test("student registration still works and asks 'Do you want to apply at SLIT?'", async ({ page }) => {
  const student = person("reg-student");
  await page.goto("/login?mode=enroll&as=student");
  await expect(page.getByRole("radio", { name: /Student/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(student.email);
  await page.locator("#enrol-mobile").fill(student.local);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create student account" }).click();
  await expect(page.getByRole("heading", { name: "Do you want to apply at SLIT?" })).toBeVisible();
  // Same records as before: a student on record, a login, and no staff data.
  expect(sql(`select count(*) from public.enrollment_students where lower(email) = '${student.email}'`)).toBe("1");
  expect(sql(`select count(*) from auth.users where lower(email) = '${student.email}'`)).toBe("1");
  expect(sql(`select count(*) from hr.staff_profiles where email = '${student.email}'`)).toBe("0");
});

test("the Enroll now choices: Student and Agent unchanged, Staff now needs approval", async ({ page }) => {
  await page.goto("/login?mode=enroll");
  await expect(page.getByRole("heading", { name: "Who are you enrolling as?" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Agent/ })).toContainText("Needs approval");
  await expect(page.getByRole("radio", { name: /Staff/ })).toContainText("Needs approval");
  await expect(page.getByRole("radio", { name: /Student/ })).not.toContainText("Needs approval");
  await expect(page.getByRole("radio", { name: /Staff/ })).not.toContainText("Invite only");
  // Agent step 2 is still the business (ABN) step.
  await page.getByRole("radio", { name: /Agent/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/ABN/i).first()).toBeVisible();
});

/** A checksum-valid ABN nobody has registered yet (the ATO weighting: subtract 1 from the first digit, weights 10,1,3,5,7,9,11,13,15,17,19, sum divisible by 89). */
function freshAbn(): string {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  for (;;) {
    const digits = Array.from({ length: 11 }, () => Math.floor(Math.random() * 10));
    digits[0] = 1 + Math.floor(Math.random() * 9);
    const sum = digits.reduce((total, d, i) => total + (i === 0 ? d - 1 : d) * weights[i], 0);
    if (sum % 89 === 0) return digits.join("");
  }
}

test("agent registration still creates an inactive business awaiting review, with its invitation", async () => {
  const agent = person("reg-agent");
  const abn = freshAbn();
  const response = await fetch(`${E2E_API_URL}/functions/v1/portal-self-register`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: E2E_ANON_KEY },
    body: JSON.stringify({ action: "register", kind: "agent", email: agent.email, contactName: "Agent Contact", abn, businessName: `E2E Agency ${agent.email.slice(10, 16)}`, phone: agent.local, agreed: true, redirectTo: `http://127.0.0.1:${E2E_PORT}/reset-password` }),
  });
  const body = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  expect(sql(`select status || '/' || (registration_requested_at is not null)::text from public.agencies where registration_number = '${abn}' order by created_at desc limit 1`)).toBe("Inactive/true");
  expect(sql(`select role from public.agency_invitations where email = '${agent.email}'`)).toBe("agency_admin");
  expect(sql(`select count(*) from hr.staff_profiles where email = '${agent.email}'`)).toBe("0");
});

test("the admin staff invitation still works: invite, mail, sign in", async ({ page }) => {
  const admin = await createAdmin("inviter");
  const client = await signedInClient(admin.email);
  const invitee = person("invited");
  const { data, error } = await client.functions.invoke("cms-admin-users", { body: { action: "invite", email: invitee.email, name: "Invited Person", role: "Editor", redirectTo: `http://127.0.0.1:${E2E_PORT}/reset-password` } });
  expect(error).toBeNull();
  expect(data.ok).toBe(true);
  expect(sql(`select role || '/' || status from public.cms_users where lower(email) = '${invitee.email}'`)).toBe("Editor/Active");
  const mail = await (await fetch(`${E2E_MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:${invitee.email}`)}`)).json() as { total: number };
  expect(mail.total).toBeGreaterThan(0);
  // The invitee opens the emailed link, sets a password on the existing reset page, then signs in to the CMS.
  await page.goto(await latestLink(invitee.email));
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
  sql(`update public.cms_users set must_change_password = false where lower(email) = '${invitee.email}'`);
  await signInThroughTheForm(page, invitee.email);
  await expect(page).toHaveURL(/\/admin/);
  // Invited staff never appear in, or get, a staff (hr) record.
  expect(sql(`select count(*) from hr.staff_profiles where email = '${invitee.email}'`)).toBe("0");
});

// The student "Add New Form" document wizard shares its shell, stepper, upload step, phone field and emergency contact with the
// staff onboarding wizard (src/components/shared/wizard). With E2E_SHOTS_DIR set, this walk saves screenshots and the dialog's
// markup at fixed points, so a run before a change and a run after it can be compared. No reader is called: the browser's request
// to portal-document-extract is answered here and each reading is recorded in the lab database.
test("the student document wizard: upload, reading, emergency contact and the phone rules look and behave as before", async ({ page }) => {
  test.setTimeout(240_000);
  const student = person("wizard-student");
  await page.route("**/functions/v1/portal-document-extract", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.goto("/login?mode=enroll&as=student");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(student.email);
  await page.locator("#enrol-mobile").fill(student.local);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create student account" }).click();
  await page.getByRole("button", { name: "Yes, start my application" }).click();
  const alone = page.getByRole("button", { name: /I am applying by myself/ });
  await expect(alone.or(page.locator("#wizard-title"))).toBeVisible();
  if (await alone.isVisible()) await alone.click();
  await expect(page.locator("#wizard-title")).toBeVisible();
  const wizard = page.getByRole("dialog");
  const next = wizard.getByRole("button", { name: "Next" });
  await expect(wizard.getByText("Upload file")).toBeVisible();
  await shot(page, "student-wizard-upload");
  await domSnapshot(page, '[role="dialog"]', "student-wizard-upload");

  let applicationId = "";
  const upload = async (category: string, file: string, read: Record<string, string>) => {
    await wizard.locator('input[type="file"]').first().setInputFiles({ name: file, mimeType: "application/pdf", buffer: pdfFor(category === "English Test" ? "English" : category) });
    await expect.poll(() => sql(`select count(*) from public.enrollment_application_documents where filename = '${file}' and category = '${category}' and is_current`)).not.toBe("0");
    applicationId ||= sql(`select application_id from public.enrollment_application_documents where filename = '${file}' order by created_at desc limit 1`);
    // While it is read: the shared reading panel (the same one as the application form).
    await expect(wizard.getByTestId("document-reading")).toBeVisible();
    await expect(wizard.getByTestId("document-reading")).toContainText("Reading your document");
    markStudentDocumentRead(applicationId, category, read);
    await expect(wizard.getByText("Ready for review")).toBeVisible();
    await expect(wizard.getByTestId("document-reading")).toHaveCount(0);
  };
  await upload("Passport", `passport-${student.local}.pdf`, { first_name: "WIZARD", last_name: "STUDENT", dob: "1999-04-05", passport_number: "PA1234567", passport_expiry: "2034-01-01", nationality: "India" });
  await expect(page.getByText(/We filled 6 fields from your passport\. Please review\./)).toBeVisible();
  await expect(next).toBeEnabled();
  await shot(page, "student-wizard-uploaded");
  await next.click();
  await upload("Visa", `visa-${student.local}.pdf`, { visa_subclass: "500", visa_grant_number: "0012345678901", visa_stay_until: "2034-01-01" });
  await next.click();
  await upload("English Test", `english-${student.local}.pdf`, { english_type: "IELTS Academic", english_score: "7.0" });
  await next.click();
  await upload("Academic", `academic-${student.local}.pdf`, { academic_institution: "Example University", academic_qualification: "Bachelor of Science" });
  await next.click();
  await wizard.getByRole("button", { name: "Continue without licence" }).click();
  await wizard.locator("#wizard-language_other").fill("Hindi");
  await next.click();
  await wizard.locator("#wizard-usi_number").fill("ABC234DEF5");
  await next.click();

  // Emergency contact: the same fields, messages and phone rules as the staff wizard.
  await expect(wizard.locator("#wizard-ec_name")).toBeVisible();
  await shot(page, "student-wizard-emergency");
  await domSnapshot(page, '[role="dialog"]', "student-wizard-emergency");
  await next.click();
  await expect(wizard.getByText("Enter the emergency contact's name.")).toBeVisible();
  await expect(wizard.getByText("Enter the emergency contact's phone number.")).toBeVisible();
  await expect(wizard.getByText("Enter how they are related to the student.")).toBeVisible();
  await shot(page, "student-wizard-emergency-required");
  await domSnapshot(page, '[role="dialog"]', "student-wizard-emergency-required");
  await wizard.locator("#wizard-ec_name").fill("Em Contact");
  await wizard.locator("#wizard-ec_relationship").fill("Sibling");
  await wizard.locator("#wizard-ec_phone").fill("0412");
  await wizard.locator("#wizard-ec_phone").blur();
  await next.click();
  await expect(wizard.getByText("Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.").first()).toBeVisible();
  await shot(page, "student-wizard-emergency-phone");
  await domSnapshot(page, '[role="dialog"]', "student-wizard-emergency-phone");
  await wizard.locator("#wizard-ec_phone").fill("0422333444");
  await next.click();
  await expect(wizard.locator("#wizard-course")).toBeVisible();
  // A valid number passes: the wizard moved on to the course screen.

  // Finish into the full form, then a document on it: Replace uploads the new file, the shared reading panel shows while it is
  // read, then the compact row, the filled fields and a toast; the old file goes only once the new one is in.
  await wizard.locator("#wizard-course").selectOption({ index: 1 });
  const intake = wizard.locator("#wizard-preferred_intake");
  await expect(intake).toBeEnabled();
  await expect.poll(async () => (await intake.locator("option").count())).toBeGreaterThan(1);
  await intake.selectOption({ index: 1 });
  await wizard.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByTestId("form-step-nav")).toBeVisible({ timeout: 30_000 });
  // The drawer lists each stage with its steps nested underneath; a step is one click away.
  await page.getByRole("button", { name: "All steps" }).click();
  await page.getByRole("dialog", { name: "All steps" }).getByRole("button", { name: /^English Test/ }).click();
  await expect(page).toHaveURL(/[?&]stage=3/);
  const step = page.locator('[data-section="english-test"]');
  await expect(step).toHaveAttribute("data-expanded", "true");
  await expect(step.getByText(`english-${student.local}.pdf`)).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await step.getByRole("button", { name: /^Replace / }).click();
  // Different bytes: an identical file is the same document (uploads are matched by checksum), and Replace then keeps it.
  await (await chooser).setFiles({ name: `english-new-${student.local}.pdf`, mimeType: "application/pdf", buffer: Buffer.concat([pdfFor("English"), Buffer.from("%newer result\n")]) });
  await expect(step.getByTestId("document-reading")).toBeVisible();
  await expect.poll(() => sql(`select count(*) from public.enrollment_application_documents where filename = 'english-new-${student.local}.pdf' and is_current`)).toBe("1");
  await shot(page, "student-form-document-reading");
  markStudentDocumentRead(applicationId, "English Test", { english_type: "IELTS Academic", english_score: "7.5", english_date: "2025-03-01" });
  await expect(page.getByText(/We filled \d+ fields? from your English test result\. Please review\./)).toBeVisible({ timeout: 30_000 });
  await expect(step.getByTestId("document-reading")).toHaveCount(0);
  await expect.poll(() => sql(`select string_agg(filename, ',') from public.enrollment_application_documents where application_id = '${applicationId}' and category = 'English Test' and is_current`)).toBe(`english-new-${student.local}.pdf`);
  // The read completed the step: it closes to one line with its answers, and Edit opens it again (one compact row is left).
  await expect(step).toHaveAttribute("data-expanded", "false");
  await expect(step).toContainText("IELTS Academic, 7.5");
  await shot(page, "student-form-document-read");
  await step.getByRole("button", { name: /Edit English Test/ }).click();
  await expect(step).toHaveAttribute("data-expanded", "true");
  await expect(step.getByText(`english-new-${student.local}.pdf`, { exact: true })).toBeVisible();
  await expect(step.getByText("Ready for review")).toHaveCount(1);
});

test("the enrolment wizard's intake follows the course: only open intakes from the database, cleared on a course change, a tampered pair refused (INT-01)", async ({ page }) => {
  test.setTimeout(180_000);
  const student = person("intake-student");
  await page.goto("/login?mode=enroll&as=student");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(student.email);
  await page.locator("#enrol-mobile").fill(student.local);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create student account" }).click();
  await page.getByRole("button", { name: "Yes, start my application" }).click();
  const alone = page.getByRole("button", { name: /I am applying by myself/ });
  await expect(alone.or(page.locator("#wizard-title"))).toBeVisible();
  if (await alone.isVisible()) await alone.click();
  await expect(page.locator("#wizard-title")).toBeVisible();
  const applicationId = sql(`select a.id from public.enrollment_applications a join public.enrollment_students s on s.id = a.student_id where lower(s.email) = lower('${student.email}') order by a.created_at desc limit 1`);
  // The four documents as the upload function records them (Storage object, the checked-category receipt naming the passport, the row, what was read).
  const docs: Array<[string, Record<string, string>]> = [["Passport", { first_name: "INTAKE", last_name: "STUDENT", dob: "1999-04-05", passport_number: "PI1234567", passport_expiry: "2034-01-01", nationality: "India" }],
    ["Visa", { visa_subclass: "500", visa_grant_number: "0012345678902", visa_stay_until: "2034-01-01" }], ["English Test", { english_type: "IELTS Academic", english_score: "7.0" }],
    ["Academic", { academic_institution: "Example University", academic_qualification: "Bachelor of Science" }]];
  for (const [category, read] of docs) {
    const path = `${applicationId}/${category.replace(/\s/g, "-").toLowerCase()}.pdf`;
    sql(`insert into storage.objects(bucket_id, name) values ('enrollment-documents', '${path}') on conflict do nothing;
      select public.record_passport_matched_document('enrollment-documents', '${path}', '${category}', (public.current_upload_passport('enrollment-documents', '${applicationId}'::uuid)->>'id')::uuid);
      insert into public.enrollment_application_documents(application_id, category, storage_path, filename) values ('${applicationId}', '${category}', '${path}', '${category}.pdf');`);
    markStudentDocumentRead(applicationId, category, read);
  }
  await page.reload();
  const resume = page.getByRole("button", { name: /Continue my application|Resume|Open the wizard|Continue/ }).first();
  if (!(await page.locator("#wizard-title").isVisible()) && await resume.isVisible()) await resume.click();
  await expect(page.locator("#wizard-title")).toBeVisible();
  const wizard = page.getByRole("dialog");
  const next = wizard.getByRole("button", { name: "Next" });
  for (let i = 0; i < 12 && !(await wizard.locator("#wizard-course").isVisible()); i++) {
    if (await wizard.getByRole("button", { name: "Continue without licence" }).isVisible()) await wizard.getByRole("button", { name: "Continue without licence" }).click();
    else if (await wizard.locator("#wizard-language_other").isVisible()) { await wizard.locator("#wizard-language_other").fill("Hindi"); await next.click(); }
    else if (await wizard.locator("#wizard-usi_number").isVisible()) { await wizard.locator("#wizard-usi_number").fill("ABC234DEF5"); await next.click(); }
    else if (await wizard.locator("#wizard-ec_name").isVisible()) { await wizard.locator("#wizard-ec_name").fill("Em Contact"); await wizard.locator("#wizard-ec_relationship").fill("Sibling"); await wizard.locator("#wizard-ec_phone").fill("0422333444"); await next.click(); }
    else await next.click();
    await page.waitForTimeout(300);
  }
  await expect(wizard.locator("#wizard-course")).toBeVisible();

  // INT-01: the intake dropdown follows the course and lists only the course's open intakes, from the database.
  const intake = wizard.locator("#wizard-preferred_intake");
  const finish = wizard.getByRole("button", { name: "Finish" });
  await expect(intake).toBeDisabled();
  await expect(intake.locator("option").first()).toHaveText("Choose the course first");
  const labels = (await wizard.locator("#wizard-course option").allTextContents()).filter((l) => l && l !== "Select a course");
  const slugOf = (label: string) => courses.find((c) => `${c.code} - ${c.name}` === label)!.slug;
  const [withIntakes, withoutIntakes] = [labels[0], labels[1]];
  // Re-runnable: the course behind each label is upserted by its slug and its intakes reset to this run's.
  const courseFor = (slug: string, id: string, code: string) => sql(`with ins as (insert into public.cms_courses(id, slug, code, name, status) select '${id}', '${slug}', '${code}', '${code} intake course', 'Published'
    where not exists (select 1 from public.cms_courses where slug = '${slug}') returning id) select coalesce((select id from ins), (select id from public.cms_courses where slug = '${slug}' order by id limit 1))`).split("\n").pop()!;
  const courseA = courseFor(slugOf(withIntakes), "e2e-int-a", "E2EA"), courseB = courseFor(slugOf(withoutIntakes), "e2e-int-b", "E2EB");
  sql(`update public.cms_courses set status = 'Published' where id in ('${courseA}', '${courseB}')`);
  sql(`update public.course_intakes set is_active = false where course_id in ('${courseA}', '${courseB}');
    insert into public.course_intakes(course_id, start_date, label, is_active) values ('${courseA}', current_date + 45, null, true), ('${courseA}', current_date + 12, 'Early start', true), ('${courseA}', current_date - 5, null, true), ('${courseB}', current_date + 30, null, false)
    on conflict (course_id, start_date) do update set label = excluded.label, is_active = excluded.is_active`);
  const expected = sql(`select string_agg(public.course_intake_display(i), '|' order by i.start_date) from public.course_intakes i where i.course_id = '${courseA}' and i.is_active and i.start_date >= current_date`).split("|");
  await wizard.locator("#wizard-course").selectOption(withIntakes);
  await expect(intake).toBeEnabled();
  await expect.poll(async () => (await intake.locator("option").allTextContents()).slice(1)).toEqual(expected);
  expect(expected[0]).toMatch(/^Early start \(starts /);
  await intake.selectOption({ label: expected[1] });
  await shot(page, "student-wizard-intake-chosen");
  // A course with no open intake (course B's only one is inactive): the previous automatic start months, from the database.
  const months = sql(`select string_agg(x->>'display', '|' order by n) from jsonb_array_elements(public.course_intakes_open('${courseB}')) with ordinality e(x, n)`).split("|");
  expect(months).toHaveLength(12);
  await wizard.locator("#wizard-course").selectOption(withoutIntakes);
  await expect(intake).toHaveValue("");
  await expect.poll(async () => (await intake.locator("option").allTextContents()).slice(1)).toEqual(months);
  await expect(wizard.getByTestId("intake-help")).toContainText("No intake dates are published for this course yet");
  await shot(page, "student-wizard-intake-fallback");
  await finish.click();
  await expect(wizard.getByText("Choose the intake.").first()).toBeVisible();
  await intake.selectOption({ label: months[1] });
  await finish.click();
  await expect.poll(() => sql(`select coalesce(c.intake_id::text, '-') || '|' || a.intake from public.enrollment_application_courses c join public.enrollment_applications a on a.id = c.application_id where a.id = '${applicationId}'`))
    .toBe(`-|${months[1]}`);
  // The server never trusts the pair: course B with an intake of course A is refused, whatever the page sends.
  const client = await signedInClient(student.email);
  const version = Number(sql(`select draft_version from public.enrollment_applications where id = '${applicationId}'`));
  const tampered = await client.rpc("portal_save_draft_v2", { p_application_id: applicationId, p_expected_version: version,
    p_patch: { courses: [{ courseId: courseB, code: "E2EB", title: "E2E intake B", intakeId: sql(`select id from public.course_intakes where course_id = '${courseA}' and label = 'Early start'`) }] } });
  expect(tampered.error?.message).toBe("This intake is not open for the chosen course. Choose the course again and pick one of its intakes.");

  // The full form the wizard opens on its Finish stage (the declaration): four stages from the config, as segments in the top bar.
  const stagesBar = page.getByRole("navigation", { name: "Stages" });
  for (const title of ["About you", "Visa & identity", "Education & course", "Finish", "Review & submit"]) await expect(stagesBar.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  await expect(stagesBar.getByRole("button", { name: /Finish/ })).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-section="student-declaration"]')).toHaveAttribute("data-expanded", "true");
  // Any stage, any time: a segment opens it and the URL follows.
  await stagesBar.getByRole("button", { name: /Visa & identity/ }).click();
  await expect(page).toHaveURL(/[?&]stage=2/);
  await expect(page.locator('[data-section="australian-visa"]')).toBeVisible();
  await expect(page.locator('[data-section="student-declaration"]')).toBeHidden();
  // The drawer: stages with their steps nested; Escape closes it; a step opens its stage.
  await page.getByRole("button", { name: "All steps" }).click();
  const drawer = page.getByRole("dialog", { name: "All steps" });
  await expect(drawer.getByRole("button", { name: /^1\. About you/ })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Address/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("button", { name: "All steps" }).click();
  await drawer.getByRole("button", { name: /^Address/ }).click();
  await expect(page).toHaveURL(/[?&]stage=1/);
  const address = page.locator('[data-section="address"]');
  await expect(address).toHaveAttribute("data-expanded", "true");
  // Address search: the suggestions open above the sticky footer (what is under their last row is the list), Enter picks the first.
  // The lab does not serve the signed-in address-search function, so its answer is given here (the page's request is unchanged).
  await page.route("**/functions/v1/address-search", (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: "" })
    : route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, suggestions: [{ line: "12 Smith St", line2: "", suburb: "Melbourne", state: "VIC", postcode: "3000" }, { line: "12 Smith St", line2: "", suburb: "Collingwood", state: "VIC", postcode: "3066" }] }) }));
  await page.locator("#address-search").fill("12 Smith St Mel");
  await expect(page.locator("#address-search-results").getByRole("option").first()).toContainText("12 Smith St, Melbourne VIC 3000");
  expect(await page.evaluate(() => { const list = document.getElementById("address-search-results")!.getBoundingClientRect(); return Boolean(document.elementFromPoint(list.left + 24, list.bottom - 6)?.closest("#address-search-results")); })).toBe(true);
  await shot(page, "student-form-address-search");
  await page.locator("#address-search").press("Enter");
  await expect(page.locator('[name="au_street"]')).not.toHaveValue("");
  await expect(page.locator("#address-search-results")).toHaveCount(0);
  // The pick completed the step: it closes to one line with the address.
  await expect(address).toHaveAttribute("data-expanded", "false");
  await expect(address).toContainText("12 Smith St");
  // Replace keeps the old file when the new one is refused. (This test's documents were recorded without their files, so the
  // server's passport check refuses any new upload here; the wizard test covers a replacement that is accepted.)
  await page.getByRole("button", { name: "All steps" }).click();
  await drawer.getByRole("button", { name: /^English Test/ }).click();
  const step = page.locator('[data-section="english-test"]');
  await expect(step).toHaveAttribute("data-expanded", "true");
  await expect(step.getByText("Ready for review")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await step.getByRole("button", { name: /^Replace / }).click();
  await (await chooser).setFiles({ name: `english-refused-${student.local}.pdf`, mimeType: "application/pdf", buffer: pdfFor("English") });
  await expect(step.getByText("We couldn't read the current passport", { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(sql(`select string_agg(filename, ',') from public.enrollment_application_documents where application_id = '${applicationId}' and category = 'English Test' and is_current`)).toBe("English Test.pdf");
  await expect(step.getByText("English Test.pdf")).toBeVisible();

  // Next never blocks: from Finish (the declaration is not signed yet) it moves on to Review with a soft notice.
  await stagesBar.getByRole("button", { name: /Finish/ }).click();
  await expect(page).toHaveURL(/[?&]stage=4/);
  await expect(page.getByTestId("form-footer")).toContainText(/still needs? details/);
  await page.getByTestId("stage-next").click();
  await expect(page).toHaveURL(/[?&]stage=review/);
  await expect(page.getByTestId("review-complete")).toBeVisible();
  await expect(page.getByTestId("stage-notice")).toContainText("Finish:");
  // Only Submit is blocked: every missing item is listed, and its link opens the stage with the cursor in that exact field.
  await expect(page.getByTestId("submit-application")).toBeDisabled();
  const issues = page.getByTestId("review-issues");
  await expect(issues).toContainText("Student Declaration:");
  await shot(page, "student-form-review-issues");
  const declarationIssue = issues.getByRole("button", { name: /^Student Declaration:/ }).first();
  const label = ((await declarationIssue.innerText()).split(":")[1] ?? "").trim();
  await declarationIssue.click();
  await expect(page).toHaveURL(/[?&]stage=4.*#student-declaration/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-section]")?.getAttribute("data-section"))).toBe("student-declaration");
  const focusedLabel = await page.evaluate(() => { const wrapper = document.activeElement?.closest("[data-field]"); return wrapper?.querySelector("label")?.textContent ?? ""; });
  expect(focusedLabel.replace("*", "").trim()).toBe(label);
  // The URL keeps the place: a refresh returns to the same stage, and Back to the review.
  await page.reload();
  await expect(stagesBar.getByRole("button", { name: /Finish/ })).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-section="student-declaration"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/[?&]stage=review/);
  await expect(page.getByTestId("review-complete")).toBeVisible();
});

// ------------------------------------------------------------------ Email unique within a role (2026-11-12)
const IN_USE = "This email is already in use. Please use a different email address.";
const PUBLIC_IN_USE = "An account with this email already exists. Sign in or reset your password.";

test("identity email: Admin > Users flags another CMS user's email live, a free one is available", async ({ page }) => {
  const admin = await createAdmin("idx-users");
  const other = await createAdmin("idx-users-other");
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.locator("div.fixed.inset-0").filter({ has: page.getByRole("button", { name: /^(Send invite|Send invitation)$/ }) }).last();
  await dialog.getByLabel("Full name").fill("Second Admin");
  const email = dialog.getByLabel("Email");
  await email.fill(`  ${other.email.toUpperCase()} `);
  await expect(dialog.getByTestId("email-in-use")).toContainText(IN_USE);
  // The live check (email_available) says taken / free only; the role detail comes with a submit error (admins only).
  await expect(dialog.getByTestId("email-in-use-details")).toHaveCount(0);
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("button", { name: "Send invite" })).toBeDisabled();
  await shot(page, "identity-users-taken");
  await email.fill(person("idx-users-free").email);
  await expect(dialog.getByTestId("email-available")).toContainText("Email available");
  await expect(dialog.getByRole("button", { name: "Send invite" })).toBeEnabled();
  await shot(page, "identity-users-free");
});

// (Another business's student is "taken" for an agent: phase4_authorization_positive.sql, find_student_by_email.)
test("identity email: New application offers the existing student for reuse and makes no second student; an agent's email is free", async ({ page }) => {
  const admin = await createAdmin("idx-app");
  const mine = person("idx-app-student");
  const agency = sql(`insert into public.agencies(name, code, status) values ('E2E identity business', 'E2E-' || substr(md5(random()::text), 1, 8), 'Active') returning id`).split("\n")[0];
  const student = sql(`insert into public.enrollment_students(agency_id, full_name, email, phone) values ('${agency}', 'Reuse Me', '${mine.email}', '${mine.local}') returning id`).split("\n")[0];
  const agentEmail = person("idx-app-agent").email;
  sql(`insert into public.agents(business_id, full_name, email) values ('${agency}', 'E2E Agent', '${agentEmail}')`);
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/applications/new");
  const email = page.locator("#student-email");
  await email.fill(agentEmail);
  await expect(page.getByTestId("email-available")).toContainText("Email available");
  await email.fill(mine.email.toUpperCase());
  await expect(page.getByTestId("student-email-reuse")).toContainText("A student with this email already exists: Reuse Me");
  await shot(page, "identity-application-reuse");
  await page.getByRole("button", { name: "Add application to this student" }).click();
  await expect(page.getByText("Add New Form — document wizard")).toBeVisible({ timeout: 30_000 });
  await shot(page, "identity-application-reuse-wizard");
  expect(sql(`select count(*) from public.enrollment_students where lower(email) = '${mine.email}'`)).toBe("1");
  expect(sql(`select count(*) from public.enrollment_applications where student_id = '${student}'`)).toBe("1");
});

test("identity email: portal Add user flags another agency's agent live, and a student login on submit (one portal role per login)", async ({ page }) => {
  const admin = person("idx-portal-admin");
  const adminId = await createAuthUser(admin.email);
  const agency = sql(`insert into public.agencies(name, code, status) values ('E2E identity portal', 'E2E-' || substr(md5(random()::text), 1, 8), 'Active') returning id`).split("\n")[0];
  const profile = sql(`insert into public.portal_profiles(auth_user_id, full_name, email, phone, status) values ('${adminId}', 'E2E Agency Admin', '${admin.email}', '${admin.local}', 'Active') returning id`).split("\n")[0];
  sql(`insert into public.agency_memberships(user_id, agency_id, role) values ('${profile}', '${agency}', 'agency_admin')`);
  const elsewhere = sql(`insert into public.agencies(name, code, status) values ('E2E identity other', 'E2E-' || substr(md5(random()::text), 1, 8), 'Active') returning id`).split("\n")[0];
  const otherAgent = person("idx-portal-agent").email;
  sql(`insert into public.agents(business_id, full_name, email) values ('${elsewhere}', 'Other Agent', '${otherAgent}')`);
  const student = await createStudentLogin("idx-portal-student");
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/agency/);
  await page.goto("/agency/users");
  await page.getByRole("button", { name: "Add user" }).first().click();
  const dialog = page.locator("div.fixed.inset-0").filter({ has: page.getByRole("button", { name: /^(Send invite|Send invitation)$/ }) }).last();
  await dialog.getByLabel("Full name").fill("Invited Person");
  const email = dialog.getByLabel("Email address");
  await email.fill(otherAgent);
  await expect(dialog.getByTestId("email-in-use")).toContainText(IN_USE);
  await expect(dialog.getByTestId("email-in-use-details")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  await shot(page, "identity-portal-taken");
  await email.fill(student.email);
  await expect(dialog.getByTestId("email-available")).toBeVisible();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByTestId("email-in-use")).toContainText(IN_USE);
  await expect(email).toHaveAttribute("aria-invalid", "true");
  expect(sql(`select count(*) from public.agency_invitations where email = '${student.email}' and role <> 'student'`)).toBe("0");
  await shot(page, "identity-portal-role-conflict");
});

test("identity email: public student sign-up with an email that already has an account says so, with Sign in and Forgot password", async ({ page }) => {
  resetRateLimits();
  // A student who already signs in. (An email on a record with no sign-in takes the existing claim flow instead.)
  const existing = await createStudentLogin("idx-public");
  await page.goto("/login?mode=enroll&as=student");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(existing.email);
  await page.locator("#enrol-mobile").fill(existing.local);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create student account" }).click();
  const message = page.getByTestId("email-in-use");
  await expect(message).toContainText(PUBLIC_IN_USE);
  await expect(message.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  await expect(message.getByRole("link", { name: "Forgot password" })).toHaveAttribute("href", "/forgot-password");
  await expect(message).not.toContainText(/student|agent|staff/i);
  await shot(page, "identity-public-signup");
});

// ------------------------------------------------------------------ Application status workflow (20261113260000)
// Statuses, labels and moves come from the database; Take action shows only the allowed moves; the offer letter (template or
// upload) goes to the agent or the student; accepting it moves the application on; the backend refuses everything else.
const wfAgency = (label: string) => sql(`insert into public.agencies(name, code, status) values ('E2E ${label}', 'E2E-' || substr(md5(random()::text), 1, 8), 'Active') returning id`).split("\n")[0];
const wfApplication = (agency: string, status: string, name: string, extra: Record<string, string | null> = {}) => {
  const columns = ["agency_id", "status", "student_name", "student_email", "data", ...Object.keys(extra)];
  const values = [`'${agency}'`, `'${status}'`, `'${name.replace(/'/g, "''")}'`, `'${(extra.student_email ?? `${name.toLowerCase().replace(/\W+/g, ".")}@example.test`)}'`,
    `'${(extra.data ?? "{}").replace(/'/g, "''")}'::jsonb`, ...Object.values(extra).map((v) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`))];
  const cols = columns.filter((c, i) => columns.indexOf(c) === i);
  const vals = cols.map((c) => values[columns.indexOf(c)]);
  return sql(`insert into public.enrollment_applications(${cols.join(", ")}) values (${vals.join(", ")}) returning id`).split("\n")[0];
};
/** What the list offers for a status, from the transitions table (primary icon button; the "⋯" menu: the rest, Reject / Withdraw last). */
const wfMenu = (status: string) => {
  const rows = sql(`select label || chr(9) || is_primary::text from public.application_status_transitions where from_status = '${status}' and is_active and not is_automatic order by (tone = 'danger'), sort, action_key`)
    .split("\n").filter(Boolean).map((line) => line.split("\t"));
  return { primary: rows.find((r) => r[1] === "true")?.[0] ?? null, menu: rows.filter((r) => r[1] !== "true").map((r) => r[0]) };
};
const wfLabel = (status: string, action: string) => sql(`select label from public.application_status_transitions where from_status = '${status}' and action_key = '${action}'`);
const wfStatusHint = (status: string) => sql(`select hint from public.application_statuses where value = '${status}'`);
const wfStatusLabel = (status: string) => sql(`select label from public.application_statuses where value = '${status}'`);
const wfPortalUser = async (label: string, agency: string, role: "agent" | "student", studentId?: string) => {
  const who = person(label);
  const authId = await createAuthUser(who.email);
  const profile = sql(`insert into public.portal_profiles(auth_user_id, full_name, email, phone, status) values ('${authId}', 'E2E ${label}', '${who.email}', '${who.local}', 'Active') returning id`).split("\n")[0];
  sql(`insert into public.agency_memberships(user_id, agency_id, role${studentId ? ", student_id" : ""}) values ('${profile}', '${agency}', '${role}'${studentId ? `, '${studentId}'` : ""})`);
  return { ...who, profile };
};

test("status workflow: the list opens an application from its name; Take action lists only the backend's moves; the backend refuses the rest", async ({ page }) => {
  const admin = await createAdmin("wf-list");
  const agency = wfAgency("workflow list");
  const tag = person("wf-tag").local.slice(-6);
  const names = { submitted: `WF${tag} Submitted`, action_required: `WF${tag} Action`, offer_issued: `WF${tag} Offer`, enrolled: `WF${tag} Enrolled` };
  const ids = Object.fromEntries(Object.entries(names).map(([status, name]) => [status, wfApplication(agency, status, name)])) as Record<keyof typeof names, string>;
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/applications");
  await page.getByPlaceholder("Search name, email or reference").fill(`WF${tag}`);
  const row = (name: string) => page.locator("tr", { hasText: name });
  await expect(row(names.submitted)).toBeVisible();
  // Labels from the database, as read-only badges; no View button.
  await expect(row(names.offer_issued).getByTestId("status-badge")).toHaveText("Offer letter issued");
  await expect(row(names.submitted).getByRole("link", { name: "View" })).toHaveCount(0);
  // The student name opens the application.
  await row(names.submitted).getByTestId("application-open").click();
  await expect(page).toHaveURL(new RegExp(`/admin/applications/${ids.submitted}`));
  await page.goBack();
  await page.getByPlaceholder("Search name, email or reference").fill(`WF${tag}`);
  // Actions: exactly the staff moves of each status from the backend (expected values read from the database, not written here):
  // the primary one as an icon button, the rest in the "⋯" menu with Reject / Withdraw last.
  const menuOf = async (name: string) => {
    await row(name).getByTestId("take-action").click();
    const items = await page.getByTestId("take-action-menu").getByRole("menuitem").allInnerTexts();
    await page.keyboard.press("Escape");
    return items.map((item) => item.trim());
  };
  for (const status of ["submitted", "action_required", "offer_issued", "enrolled"] as const) {
    const expected = wfMenu(sql(`select status from public.enrollment_applications where id = '${ids[status]}'`));
    if (expected.primary) await expect(row(names[status]).getByTestId("primary-action")).toHaveAttribute("aria-label", expected.primary);
    else await expect(row(names[status]).getByTestId("primary-action")).toHaveCount(0);
    expect(await menuOf(names[status]), status).toEqual(expected.menu);
  }
  expect(wfMenu("offer_issued").menu, "no manual Mark offer accepted").not.toContain("Mark offer accepted");
  await shot(page, "workflow-list");
  // A reason from the backend's list is required to reject; the badge changes at once, the toast offers Undo, then Final.
  await row(names.action_required).getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: wfLabel("action_required", "reject") }).click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog.getByTestId("dialog-application")).toContainText(names.action_required);
  await expect(dialog.getByTestId("reason-confirm")).toBeDisabled();
  const reasons = (await dialog.getByTestId("reason-select").locator("option").allInnerTexts()).slice(1);
  expect(reasons).toEqual(sql(`select string_agg(label, '|' order by is_other, sort, lower(label)) from public.status_reasons where status = 'rejected' and is_active`).split("|"));
  await dialog.getByTestId("reason-select").selectOption({ label: "Other" });
  await expect(dialog.getByTestId("reason-confirm")).toBeDisabled();
  await dialog.getByTestId("reason-other").fill("Course is full");
  await dialog.getByTestId("reason-confirm").click();
  await expect(row(names.action_required).getByTestId("status-badge")).toHaveText(wfStatusLabel("rejected"));
  await expect(page.getByText(`${names.action_required} is now ${wfStatusLabel("rejected")}.`)).toBeVisible();
  await expect(page.getByTestId("toast-action")).toHaveText("Undo");
  await expect(row(names.action_required).getByTestId("final-badge")).toBeVisible();
  expect(sql(`select status || '|' || h.reason from public.enrollment_applications a join public.enrollment_application_status_history h on h.application_id = a.id where a.id = '${ids.action_required}' order by h.created_at desc limit 1`)).toBe("rejected|Course is full");
  // The backend refuses moves the workflow does not allow, whoever asks.
  const client = await signedInClient(admin.email);
  const jump = await client.rpc("portal_set_application_status", { p_application_id: ids.submitted, p_status: "offer_accepted", p_note: "skip the letter" });
  expect(jump.error?.message).toMatch(/Invalid admissions transition/);
  const direct = await client.rpc("portal_set_application_status", { p_application_id: ids.submitted, p_status: "offer_issued", p_note: "" });
  expect(direct.error?.message).toMatch(/Issue offer letter/);
  const back = await client.rpc("portal_set_application_status", { p_application_id: ids.enrolled, p_status: "submitted", p_note: "" });
  expect(back.error?.message).toMatch(/Invalid admissions transition/);
  const staffAccept = await client.rpc("portal_offer_accept", { p_application: ids.offer_issued });
  expect(staffAccept.error?.message).toMatch(/Only the student or agent/);
  const automatic = await client.rpc("change_application_status", { p_application: ids.offer_issued, p_action: "accept_offer", p_payload: {} });
  expect(automatic.error?.message).toMatch(/automatically/);
});

test("status flow: Submitted → Issue offer letter → accepted → Issue CoE / VoE → Enrol → Enrolled; Withdraw needs a reason", async ({ page, browser }) => {
  const admin = await createAdmin("flow-main");
  const agency = wfAgency("main flow");
  const agent = await wfPortalUser("flow-agent", agency, "agent");
  const tag = agent.local.slice(-6);
  const name = `Flow${tag} Student`;
  const id = wfApplication(agency, "submitted", name, { created_by: agent.profile, assigned_agent_id: agent.profile, data: '{"values":{"first_name":"Flow","last_name":"Student"}}' });
  const other = wfApplication(agency, "submitted", `Flow${tag} Other`);
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/applications");
  await page.getByPlaceholder("Search name, email or reference").fill(`Flow${tag}`);
  const row = (text: string) => page.locator("tr", { hasText: text });
  const statusOf = () => sql(`select status from public.enrollment_applications where id = '${id}'`);
  const primaryOf = (status: string) => wfMenu(status).primary!;

  // 1. Submitted: the primary icon button issues the offer letter (uploaded here; templates are covered by their own tests).
  await expect(row(name).getByTestId("primary-action")).toHaveAttribute("aria-label", primaryOf("submitted"));
  await row(name).getByTestId("primary-action").click();
  const offer = page.getByTestId("offer-letter-drawer");
  await expect(offer.getByTestId("offer-recipient")).toContainText(agent.email);
  await offer.getByTestId("offer-mode").getByRole("radio", { name: "Upload letter" }).click();
  await offer.locator("#offer-upload").setInputFiles({ name: "LOO.pdf", mimeType: "application/pdf", buffer: PDF });
  await offer.getByTestId("send-offer-letter").click();
  await expect.poll(statusOf).toBe("offer_issued");
  await expect(row(name).getByTestId("status-badge")).toHaveText(wfStatusLabel("offer_issued"));

  // 2. The agent accepts in the portal (the system path; no staff "Mark offer accepted"); who and when are recorded.
  const agentContext = await browser.newContext({ baseURL: `http://127.0.0.1:${E2E_PORT}` });
  const agentPage = await agentContext.newPage();
  await signInThroughTheForm(agentPage, agent.email);
  await expect(agentPage).toHaveURL(/\/agency/, { timeout: 30_000 });
  await agentPage.goto(`/agency/applications/${id}`);
  await agentPage.getByTestId("accept-offer").click();
  await agentPage.getByRole("alertdialog").getByRole("button", { name: "Accept offer" }).click();
  await expect.poll(statusOf).toBe("offer_accepted");
  await agentContext.close();
  expect(sql(`select action_key || '|' || (actor is not null)::text from public.enrollment_application_status_history where application_id = '${id}' and new_status = 'offer_accepted'`)).toBe("accept_offer|true");

  // 3. Offer accepted: Issue CoE / VoE is the primary action (it showed "No action" before). The registration is verified in PRISMS first.
  const adminAuth = sql(`select auth_user_id from public.cms_users where email = '${admin.email}'`);
  sql(`insert into public.enrollment_registrations(application_id, state, coe_number, created_by, lodged_at, lodged_by, verified_at, verified_by) values ('${id}', 'verified', 'COE${tag}', '${adminAuth}', now(), '${adminAuth}', now(), '${adminAuth}')`);
  await page.reload();
  await page.getByPlaceholder("Search name, email or reference").fill(`Flow${tag}`);
  await expect(row(name).getByTestId("primary-action")).toHaveAttribute("aria-label", primaryOf("offer_accepted"));
  await row(name).getByTestId("primary-action").click();
  const coe = page.getByTestId("coe-drawer");
  await expect(coe.getByTestId("coe-confirm")).toBeDisabled();
  await coe.getByTestId("coe-number").fill(`COE${tag}`);
  await coe.locator("#coe-upload").setInputFiles({ name: "CoE.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(coe.getByTestId("coe-recipient")).toContainText(agent.email);
  await coe.getByTestId("coe-confirm").click();
  await expect.poll(statusOf).toBe("coe_issued");
  await expect(row(name).getByTestId("status-badge")).toHaveText(wfStatusLabel("coe_issued"));
  expect(sql(`select kind || '|' || document_number || '|' || (issued_at is not null)::text from public.enrollment_coe_documents where application_id = '${id}'`)).toBe(`coe|COE${tag}|true`);

  // 4. CoE / VoE issued: Enrol (the date defaults to the intake's start or today) → Enrolled, then only Withdraw is left.
  await expect(row(name).getByTestId("primary-action")).toHaveAttribute("aria-label", primaryOf("coe_issued"));
  await row(name).getByTestId("primary-action").click();
  const enrol = page.getByTestId("enrol-dialog");
  await expect(enrol.getByTestId("enrol-date")).not.toHaveValue("");
  await enrol.getByTestId("enrol-date").fill("2027-02-03");
  await enrol.getByTestId("enrol-confirm").click();
  await expect.poll(statusOf).toBe("enrolled");
  await expect(row(name).getByTestId("status-badge")).toHaveText(wfStatusLabel("enrolled"));
  expect(sql(`select payload->>'enrolment_date' from public.enrollment_application_status_history where application_id = '${id}' and new_status = 'enrolled'`)).toBe("2027-02-03");
  await expect(row(name).getByTestId("primary-action")).toHaveCount(0);
  await row(name).getByTestId("take-action").click();
  expect((await page.getByTestId("take-action-menu").getByRole("menuitem").allInnerTexts()).map((t) => t.trim())).toEqual(wfMenu("enrolled").menu);
  await page.keyboard.press("Escape");
  await shot(page, "status-flow-enrolled");

  // 5. Withdraw another application with a reason, without notifying: Final, no email queued.
  await row(`Flow${tag} Other`).getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: wfLabel("submitted", "withdraw") }).click();
  const reason = page.getByTestId("reason-dialog");
  await expect(reason.getByTestId("reason-confirm")).toBeDisabled();
  await reason.getByTestId("reason-select").selectOption({ label: "Student request" });
  await reason.getByTestId("dialog-notify").uncheck();
  await reason.getByTestId("reason-confirm").click();
  await expect(row(`Flow${tag} Other`).getByTestId("status-badge")).toHaveText(wfStatusLabel("withdrawn"));
  await expect(row(`Flow${tag} Other`).getByTestId("final-badge")).toBeVisible();
  expect(sql(`select h.reason || '|' || (select count(*) from public.admission_event_outbox o where o.application_id = h.application_id) from public.enrollment_application_status_history h where h.application_id = '${other}' and h.new_status = 'withdrawn'`)).toBe("Student request|0");
});

test("Settings › Application statuses: an admin renames a status (live everywhere, audited), the automatic moves are locked, reasons per status", async ({ page }) => {
  const admin = await createAdmin("status-settings");
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/settings/application-statuses");
  await expect(page.getByTestId("status-row")).toHaveCount(Number(sql("select count(*) from public.application_statuses")));
  const label = page.locator('[data-testid=status-row][data-key="withdrawn"]').getByTestId("status-label");
  const original = wfStatusLabel("withdrawn");
  await label.fill("Withdrawn by request");
  await label.blur();
  await expect.poll(() => wfStatusLabel("withdrawn")).toBe("Withdrawn by request");
  await expect(page.locator('[data-testid=status-row][data-key="submitted"]').getByTestId("status-active")).toBeDisabled();
  await page.getByTestId("status-settings-tabs").getByRole("radio", { name: "Transitions" }).click();
  await expect(page.locator('[data-testid=transition-row][data-action="accept_offer"]').getByTestId("transition-active")).toBeDisabled();
  await page.getByTestId("status-settings-tabs").getByRole("radio", { name: "Reasons" }).click();
  await expect(page.locator('[data-testid=reason-group][data-status="rejected"]').getByTestId("reason-row").last()).toContainText("");
  await page.getByTestId("status-settings-tabs").getByRole("radio", { name: "Statuses" }).click();
  await page.getByTestId("status-history-link").click();
  await expect(page.getByTestId("status-history")).toContainText("Withdrawn by request");
  await shot(page, "status-settings");
  sql(`update public.application_statuses set label = '${original.replace(/'/g, "''")}' where value = 'withdrawn'`);
});

test("status workflow: an offer letter is uploaded and sent to the agent who started the application; the agent accepts it", async ({ page, browser }) => {
  const admin = await createAdmin("wf-loo-upload");
  const agency = wfAgency("workflow upload");
  const agent = await wfPortalUser("wf-agent", agency, "agent");
  const name = `WFU${agent.local.slice(-6)} Student`;
  const id = wfApplication(agency, "submitted", name, { created_by: agent.profile, assigned_agent_id: agent.profile });
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  // Review: the staff action bar with the status, what comes next and Take action.
  await page.goto(`/admin/applications/${id}?stage=review`);
  const bar = page.getByTestId("staff-review-bar");
  await expect(bar.getByTestId("status-hint")).toHaveText(wfStatusHint("submitted"));
  await bar.getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
  const drawer = page.getByTestId("offer-letter-drawer");
  await expect(drawer.getByTestId("offer-recipient")).toContainText("Agent");
  await expect(drawer.getByTestId("offer-recipient")).toContainText(agent.email);
  await drawer.getByTestId("offer-mode").getByRole("radio", { name: "Upload letter" }).click();
  await drawer.locator("#offer-upload").setInputFiles({ name: "Signed LOO.pdf", mimeType: "application/pdf", buffer: PDF });
  await drawer.getByLabel(/Message/).fill("Welcome to Skyline");
  // Review has open items (the fixture has no answers): Send needs an admin override note.
  await expect(drawer.getByTestId("offer-review-issues")).toBeVisible();
  await expect(drawer.getByTestId("send-offer-letter")).toBeDisabled();
  await drawer.getByLabel(/Note to issue anyway/).fill("Documents checked by phone");
  await shot(page, "workflow-offer-upload");
  await drawer.getByTestId("send-offer-letter").click();
  await expect(page.getByText("Offer letter sent.")).toBeVisible();
  await expect.poll(() => sql(`select status from public.enrollment_applications where id = '${id}'`)).toBe("offer_issued");
  expect(sql(`select source || '|' || recipient_kind || '|' || recipient_email from public.enrollment_offer_letters where application_id = '${id}'`)).toBe(`upload|agent|${agent.email}`);
  expect(sql(`select string_agg(recipient_email, ',') from public.notification_deliveries where application_id = '${id}' and event = 'offer_letter_issued'`)).toBe(agent.email);
  expect(sql(`select count(*) from public.enrollment_application_status_history where application_id = '${id}' and new_status = 'offer_issued' and note like 'Offer letter sent to agent%'`)).toBe("1");
  // The agent sees the letter in the portal and accepts it: a confirmation, no signature.
  const agentContext = await browser.newContext({ baseURL: `http://127.0.0.1:${E2E_PORT}` });
  const agentPage = await agentContext.newPage();
  await signInThroughTheForm(agentPage, agent.email);
  await expect(agentPage).toHaveURL(/\/agency/, { timeout: 30_000 });
  await agentPage.goto(`/agency/applications/${id}`);
  await expect(agentPage.getByTestId("offer-banner")).toContainText("Your offer letter is ready");
  await agentPage.getByTestId("accept-offer").click();
  await agentPage.getByRole("alertdialog").getByRole("button", { name: "Accept offer" }).click();
  await expect.poll(() => sql(`select status from public.enrollment_applications where id = '${id}'`)).toBe("offer_accepted");
  expect(sql(`select accepted_via || '|' || (accepted_at is not null)::text from public.enrollment_offer_letters where application_id = '${id}'`)).toBe("portal|true");
  await agentContext.close();
});

test("status workflow: a template letter goes to the student when staff created the application or the student applied; a declaration mismatch shows ⚠ and needs a note", async ({ page }) => {
  const admin = await createAdmin("wf-loo-template");
  const adminAuth = sql(`select auth_user_id from public.cms_users where email = '${admin.email}'`);
  const agency = wfAgency("workflow template");
  const tag = person("wf-tpl").local.slice(-6);
  sql(`insert into hr.sign_templates(name, title, body_html, created_by, kind, audience, category)
    values ('E2E LOO ${tag}', 'Letter of offer', '<p>Dear {{student.full_name}}, we are pleased to offer you a place.</p>', '${adminAuth}', 'text', 'student', 'student_offer_letter')`);
  // Staff created it for the student (no creator): the letter goes to the student.
  const student = sql(`insert into public.enrollment_students(agency_id, full_name, email) values ('${agency}', 'Tem Plate ${tag}', 'tem.plate.${tag}@example.test') returning id`).split("\n")[0];
  const staffMade = wfApplication(agency, "submitted", `Tem Plate ${tag}`, { student_id: student, student_email: `tem.plate.${tag}@example.test`, data: `{"values":{"first_name":"Tem","last_name":"Plate ${tag}"}}` });
  // The student applied directly: also the student.
  const directStudent = sql(`insert into public.enrollment_students(agency_id, full_name, email) values ('${agency}', 'Di Rect ${tag}', 'di.rect.${tag}@example.test') returning id`).split("\n")[0];
  const studentUser = await wfPortalUser("wf-direct", agency, "student", directStudent);
  const direct = wfApplication(agency, "submitted", `Di Rect ${tag}`, { student_id: directStudent, created_by: studentUser.profile, student_email: `di.rect.${tag}@example.test` });
  const client = await signedInClient(admin.email);
  const routed = await client.rpc("portal_offer_letter_recipient", { p_application: direct });
  expect(routed.data?.kind).toBe("student");
  expect(routed.data?.reason).toMatch(/applied directly/);
  // A declaration whose name and signature differ.
  const mismatch = wfApplication(agency, "submitted", `Mis Match ${tag}`, { data: '{"values":{"declaration_name":"Asha Patel","digital_signature":"Someone Else"}}' });

  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto(`/admin/applications/${staffMade}?stage=review`);
  await page.getByTestId("staff-review-bar").getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
  const drawer = page.getByTestId("offer-letter-drawer");
  await expect(drawer.getByTestId("offer-recipient")).toContainText("Student");
  await expect(drawer.getByTestId("offer-recipient")).toContainText(`tem.plate.${tag}@example.test`);
  await expect(drawer.getByTestId("offer-recipient")).toContainText("Staff created this application for the student");
  await drawer.getByLabel("Template").selectOption({ label: `E2E LOO ${tag} · v1` });
  await expect(drawer.getByTestId("offer-letter-preview")).toHaveAttribute("data-pages", "1", { timeout: 30_000 });
  await expect(drawer.getByTestId("needs-input")).toContainText("Every detail is filled from the application");
  // The fixture has no answers, so Review has open items: an admin issues the letter anyway with a note.
  await expect(drawer.getByTestId("offer-review-issues")).toBeVisible();
  await drawer.getByLabel(/Note to issue anyway/).fill("Checked with the student");
  await shot(page, "workflow-offer-template");
  await drawer.getByTestId("send-offer-letter").click();
  await expect.poll(() => sql(`select status from public.enrollment_applications where id = '${staffMade}'`)).toBe("offer_issued");
  expect(sql(`select source || '|' || recipient_kind || '|' || recipient_email from public.enrollment_offer_letters where application_id = '${staffMade}'`)).toBe(`template|student|tem.plate.${tag}@example.test`);

  // The mismatch: Student Declaration is ⚠ on Review, counted as incomplete, listed with a link; the offer letter needs a note.
  await page.goto(`/admin/applications/${mismatch}?stage=review`);
  const declarationRow = page.locator("[aria-label=Steps] li", { hasText: "Student Declaration" });
  await expect(declarationRow.getByLabel("Needs attention")).toBeVisible();
  await expect(page.getByTestId("review-issues")).toContainText("The declarant name and digital signature do not match");
  const [done, total] = (await page.getByTestId("review-complete").innerText()).match(/\d+/g)!.map(Number);
  expect(done).toBeLessThan(total);
  await shot(page, "workflow-declaration-mismatch");
  await page.getByTestId("staff-review-bar").getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
  await expect(drawer.getByTestId("offer-mismatch")).toBeVisible();
  await drawer.getByTestId("offer-mode").getByRole("radio", { name: "Upload letter" }).click();
  await drawer.locator("#offer-upload").setInputFiles({ name: "LOO.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(drawer.getByTestId("send-offer-letter")).toBeDisabled();
  await drawer.getByLabel(/Note to issue anyway/).fill("Confirmed with the student by phone");
  await expect(drawer.getByTestId("send-offer-letter")).toBeEnabled();
});

/* ------------------------------------------------------------------ offer letter (LOO) templates and the issue drawer */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ASSET_SRC = /\/storage\/v1\/object\/public\/template-assets\/default\/[0-9a-f-]{36}\.png$/;
/** The text of each page of a PDF (pdf.js in Node; the browser in the lab cannot draw pdf.js pages). */
async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(((await (await doc.getPage(n)).getTextContent()).items as Array<{ str: string }>).map((t) => t.str).join(" "));
  return pages;
}

test("offer letter: the Standard Letter of Offer on an application like SLIT-2026-0080 (course by slug, no CRICOS, fees or intake): auto-selected, Needs your input, preview, sent", async ({ page }) => {
  const admin = await createAdmin("loo-standard");
  // The seed (20261113300000) needs an admin; run it again here (idempotent) and make the standard letter the default.
  sql(readFileSync("supabase/migrations/20261113300000_standard_letter_of_offer.sql", "utf8"));
  sql(`update hr.sign_templates set is_default = (name = 'Standard Letter of Offer') where category = 'student_offer_letter' and deleted_at is null`);
  const standard = sql(`select id from hr.sign_templates where category = 'student_offer_letter' and name = 'Standard Letter of Offer' and deleted_at is null`);
  expect(sql(`select status || '|' || cardinality(public.letter_template_unmapped(concat_ws(' ', title, header_html, body_html, footer_html))) from hr.sign_templates where id = '${standard}'`)).toBe("active|0");
  const agency = wfAgency("loo standard");
  const tag = person("loo-std").local.slice(-6);
  const course = `c-${tag}`, slug = `msf${tag}-certificate-iii-in-glass-and-glazing`;
  sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${course}', '${slug}', 'MSF${tag}', 'MSF${tag} Certificate III in Glass and Glazing', 'Published')`);
  const values = { title: "Miss", first_name: "Hima", middle_name: "G", last_name: "Patel", dob: "1995-03-13", nationality: "India", passport_number: "P0000000",
    au_street: "10 Example Gra", au_suburb: "Tarneit", au_state: "VIC", au_zip: "3029", preferred_intake: "December 2026" };
  const id = wfApplication(agency, "submitted", `Hima ${tag}`, { student_email: `hima.${tag}@example.test`, intake: "December 2026", data: JSON.stringify({ values }) });
  // As on hosted: the application's course row holds the course page's slug, not the course id, and no intake.
  sql(`begin; select set_config('portal.draft_command', '${id}', true); insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title) values ('${id}', '${slug}', 'MSF${tag}', 'MSF${tag} Certificate III in Glass and Glazing'); commit;`);
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto(`/admin/applications/${id}?stage=review`);
  await page.getByTestId("staff-review-bar").getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
  const drawer = page.getByTestId("offer-letter-drawer");
  // The default (standard) letter is selected by itself; the preview is made.
  const picked = drawer.getByTestId("offer-template-single").or(drawer.getByLabel("Template"));
  await expect(picked.first()).toBeVisible();
  if (await drawer.getByLabel("Template").count()) await expect(drawer.getByLabel("Template")).toHaveValue(standard);
  await expect(drawer.getByTestId("offer-letter-preview")).toHaveAttribute("data-pages", /^[1-9]$/, { timeout: 30_000 });
  // Needs your input: the start date, CRICOS and fees the course setup does not have (the course is found by its slug).
  const keys = await drawer.getByTestId("needs-input-item").evaluateAll((items) => items.map((el) => el.getAttribute("data-key") ?? ""));
  for (const key of ["course.start_date", "course.cricos", "fees.tuition"]) expect(keys, key).toContain(key);
  expect(keys, "the course name comes from the course setup").not.toContain("course.name");
  await shot(page, "loo-standard-needs-input");
  // Fill every required detail for this letter, tick the optional ones blank.
  const registry = Object.fromEntries(sql(`select key || chr(9) || required::text || chr(9) || input_type from public.letter_variables`).split("\n").map((l) => l.split("\t")).map(([k, r, t]) => [k, { required: r === "true", input: t }]));
  for (const key of keys) {
    const spec = registry[key];
    if (spec.required) await drawer.getByTestId(`letter-input-${key}`).fill(spec.input === "date" ? "2027-02-03" : spec.input === "money" ? "1000" : "0101234");
    else await drawer.getByTestId(`leave-blank-${key}`).check();
  }
  await expect(drawer.getByTestId("offer-letter-preview")).toHaveAttribute("data-missing", "", { timeout: 30_000 });
  // The review still has open items for this fixture: the override note (unchanged).
  await drawer.getByLabel(/Note to issue anyway/).fill("Checked with the student");
  await expect(drawer.getByTestId("send-offer-letter")).toHaveText(/Send offer letter/);
  await drawer.getByTestId("send-offer-letter").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Send offer letter" }).click();
  await expect.poll(() => sql(`select status from public.enrollment_applications where id = '${id}'`)).toBe("offer_issued");
  expect(sql(`select template_name || '|' || (jsonb_array_length(manual_values) > 0)::text from public.enrollment_offer_letters where application_id = '${id}'`)).toBe("Standard Letter of Offer|true");
  const pages = await pdfPages(Uint8Array.from(Buffer.from(sql(`select encode(content, 'base64') from public.enrollment_offer_letters where application_id = '${id}'`).replace(/\s+/g, ""), "base64")));
  pages.forEach((text, i) => expect(text, `page ${i + 1}`).toContain(`Page ${i + 1} of ${pages.length}`));
  expect(pages.join(" ")).toContain(`Dear Miss Hima G Patel`);
});

test("offer letter: no active student template: the drawer offers Create template and Upload letter instead", async ({ page }) => {
  const admin = await createAdmin("loo-none");
  const agency = wfAgency("loo none");
  const id = wfApplication(agency, "submitted", `NoTpl ${person("loo-none").local.slice(-6)}`);
  const active = sql(`select coalesce(string_agg(id::text, ','), '') from hr.sign_templates where category = 'student_offer_letter' and status = 'active' and deleted_at is null`);
  if (active) sql(`set session_replication_role = replica; update hr.sign_templates set status = 'archived' where id in ('${active.split(",").join("','")}');`);
  try {
    await signInThroughTheForm(page, admin.email);
    await expect(page).toHaveURL(/\/admin/);
    await page.goto(`/admin/applications/${id}?stage=review`);
    await page.getByTestId("staff-review-bar").getByTestId("take-action").click();
    await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
    const drawer = page.getByTestId("offer-letter-drawer");
    await expect(drawer.getByTestId("offer-no-template")).toContainText("No offer letter template yet");
    await expect(drawer.getByTestId("offer-no-template")).toContainText("Sign › Templates");
    await expect(drawer.getByTestId("offer-preview-placeholder")).toBeVisible();
    const [tab] = await Promise.all([page.context().waitForEvent("page"), drawer.getByTestId("offer-create-template").click()]);
    await expect(tab).toHaveURL(/\/admin\/signing\/templates\?new=student_offer_letter/);
    await expect(tab.getByTestId("template-category")).toHaveValue("student_offer_letter");
    await tab.close();
    await drawer.getByTestId("offer-upload-instead").click();
    await expect(drawer.locator("#offer-upload")).toBeAttached();
  } finally {
    if (active) sql(`set session_replication_role = replica; update hr.sign_templates set status = 'active' where id in ('${active.split(",").join("','")}');`);
  }
});

test("offer letter templates: a logo inserted and pictures pasted go to template-assets, a pasted Word table keeps its borders and alignment, variables are chips, unmapped tokens keep it inactive", async ({ page }) => {
  const admin = await createAdmin("loo-tpl");
  const tag = person("loo-tag").local.slice(-6);
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  // Sign › Templates: New template asks who it is for; Students / Applications opens the Letter of Offer (student) editor.
  await page.goto("/admin/signing/templates");
  await page.getByTestId("new-template").click();
  await page.getByTestId("template-audience-student").click();
  await expect(page.getByTestId("template-category")).toHaveValue("student_offer_letter");
  const dialog = page.getByTestId("template-dialog");
  await dialog.getByTestId("template-name").fill(`E2E LOO tpl ${tag}`);
  await dialog.getByTestId("template-subject").fill("Letter of offer");
  // Header: the logo through Insert image is uploaded to template-assets (not embedded).
  await dialog.getByTestId("section-tab-header").click();
  const header = dialog.getByTestId("section-editor-header");
  await header.click();
  await page.getByRole("button", { name: "Insert image" }).click();
  await page.getByTestId("section-editor-header-image-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") });
  await expect(header.locator("img")).toHaveAttribute("src", ASSET_SRC, { timeout: 30_000 });
  // Body: pasted from Word: an embedded picture is re-hosted, one from another site is reported, the table keeps its borders and alignment,
  // {{variables}} become chips; an old $[placeholder] stays marked.
  await dialog.getByTestId("section-tab-body").click();
  const body = dialog.getByTestId("section-editor-body");
  await body.click();
  const pasted = `<p>Dear {{student.full_name}},</p><p><img src="data:image/png;base64,${PNG_B64}" width="80" height="40"></p><p><img src="https://evil.example/logo.png"></p>`
    + `<table class=MsoTableGrid border=1 style='border-collapse:collapse;border:none'><tr><td style='border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'><p class=MsoNormal>Tuition</p></td>`
    + `<td style='border:solid windowtext 1.0pt;border-left:none;padding:0cm 5.4pt 0cm 5.4pt'><p class=MsoNormal align=right style='text-align:right'>{{fees.tuition}}</p></td></tr></table><p>Ref $[dogField]</p>`;
  await body.evaluate((el, html) => {
    const data = new DataTransfer(); data.setData("text/html", html);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(body.locator("img")).toHaveCount(1, { timeout: 30_000 });
  await expect(body.locator("img")).toHaveAttribute("src", ASSET_SRC);
  await expect(page.getByTestId("section-editor-body-notice")).toContainText("1 picture could not be copied");
  await expect(body.locator('.var-chip[data-var="student.full_name"]')).toHaveText("Student · Full name");
  await expect(body.locator('.var-chip[data-var="fees.tuition"]')).toBeVisible();
  // Insert variable: a chip at the cursor, saved as {{course.name}}.
  await body.locator("p", { hasText: "Ref" }).click();
  await page.keyboard.press("End");
  await page.getByTestId("letter-var-course.name").click();
  await expect(body.locator('.var-chip[data-var="course.name"]')).toBeVisible();
  await shot(page, "loo-template-editor");
  // Save: the unmapped token is listed; the template is saved inactive.
  await page.getByTestId("template-save").click();
  const check = page.getByTestId("letter-variable-check");
  await expect(check.getByTestId("unmapped-token")).toHaveCount(1);
  await expect(check.getByTestId("unmapped-token")).toHaveAttribute("data-token", "$[dogField]");
  await page.getByRole("button", { name: "Save as inactive" }).click();
  await page.getByTestId("template-for-filter").selectOption("student");
  const row = page.getByTestId("sign-template-row").filter({ hasText: `E2E LOO tpl ${tag}` });
  await expect(row).toContainText("inactive");
  await expect(row).toContainText("Letter of Offer (student)");
  await row.getByTestId("letter-template-toggle").click();
  await expect(page.getByRole("alert")).toContainText("Map every variable");
  const saved = sql(`select status || '|' || version || '|' || header_html || '|' || body_html from hr.sign_templates where name = 'E2E LOO tpl ${tag}'`);
  expect(saved.startsWith("archived|1|")).toBe(true);
  for (const kept of ["template-assets/default/", "{{student.full_name}}", "{{fees.tuition}}", "{{course.name}}", "border-top:1pt solid #000000", "border-left:none", "padding:0pt 5.4pt", "text-align:right"])
    expect(saved, kept).toContain(kept);
  for (const gone of ["data:image", "evil.example", "MsoTableGrid", "var-chip"]) expect(saved, gone).not.toContain(gone);
  const client = await signedInClient(admin.email);
  const id = sql(`select id from hr.sign_templates where name = 'E2E LOO tpl ${tag}'`);
  expect((await client.rpc("letter_template_set_active", { p_id: id, p_active: true })).error?.message).toMatch(/Map every variable/);
  // Map to variable converts it everywhere; saved again (version 2) it can be made active.
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("unmapped-tokens").getByTestId("unmapped-map-select").selectOption("application.reference");
  await page.getByTestId("unmapped-tokens").getByTestId("unmapped-convert").click();
  await expect(page.getByTestId("unmapped-tokens")).toHaveCount(0);
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("unmapped-none")).toBeVisible();
  await page.getByTestId("template-save-confirm").click();
  await row.getByTestId("letter-template-toggle").click();
  await expect(row).toContainText("· active");
  expect(sql(`select status || '|' || version || '|' || (body_html like '%Ref {{application.reference}}%')::text from hr.sign_templates where id = '${id}'`)).toBe("active|2|true");
  // Preview with the sample application: the letter is made in the browser, with the uploaded logo.
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("letter-preview-sample").click();
  await expect(page.getByTestId("letter-preview")).toHaveAttribute("data-pages", "1", { timeout: 30_000 });
  await expect(page.getByTestId("letter-preview")).toHaveAttribute("data-missing", "");
});

test("offer letter: values from the application, course, intake and fees; missing details block Send; fill for this letter vs save to source; an optional one needs the blank tick; header and footer on every page", async ({ page }) => {
  const admin = await createAdmin("loo-issue");
  const adminAuth = sql(`select auth_user_id from public.cms_users where email = '${admin.email}'`);
  const agency = wfAgency("loo issue");
  const tag = person("loo-iss").local.slice(-6);
  const course = `loo-course-${tag}`;
  sql(`insert into public.cms_courses(id, slug, code, name, status) values ('${course}', '${course}', 'BSB${tag}', 'Diploma of Business ${tag}', 'Published')`);
  const intake = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${course}', '2027-02-03', '2028-02-02', 'February 2027') returning id`).split("\n")[0];
  sql(`insert into public.course_fee_setups(course_id, intake_id, tuition_fee, enrolment_fee) values ('${course}', null, 14000, 250), ('${course}', '${intake}', 14500, null)`);
  const values = { title: "ms", first_name: "ASHA", middle_name: "rani", last_name: "o'neil", dob: "2001-04-12", nationality: "India", au_street: "1 Example St", au_suburb: "Melbourne", au_state: "VIC", au_zip: "3000" };
  const id = wfApplication(agency, "submitted", `Asha ${tag}`, { student_email: `asha.${tag}@example.test`, data: JSON.stringify({ values }) });
  sql(`begin; select set_config('portal.draft_command', '${id}', true); insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('${id}', '${course}', 'BSB${tag}', 'Diploma of Business ${tag}', '${intake}'); commit;`);
  const clauses = Array.from({ length: 45 }, (_, i) => `<p>Clause ${i + 1}: the student agrees to the terms of enrolment, refunds, attendance and course progress.</p>`).join("");
  sql(`insert into hr.sign_templates(name, title, header_html, body_html, footer_html, created_by, kind, audience, category) values ('E2E LOO issue ${tag}', 'Letter of offer',
    '<table style="border:none;width:100%"><tr><td style="width:50%"><strong>Skyline Institute of Technology</strong></td><td style="text-align:right;width:50%">Level 8, 310 King Street, Melbourne VIC 3000</td></tr></table>',
    '<p>Dear {{student.full_name}}, born {{student.dob}}, passport {{student.passport_number}}.</p><p>{{course.name}} (CRICOS {{course.cricos}}) starts {{course.start_date}} ({{course.intake}}). Tuition {{fees.tuition}}, total {{fees.total}}, material {{fees.material}}.</p>${clauses}',
    '<p>Page {{page.number}} of {{page.total}} · {{student.initial_line}}</p>', '${adminAuth}', 'text', 'student', 'student_offer_letter')`);
  await signInThroughTheForm(page, admin.email);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto(`/admin/applications/${id}?stage=review`);
  await page.getByTestId("staff-review-bar").getByTestId("take-action").click();
  await page.getByTestId("take-action-menu").getByRole("menuitem", { name: "Issue offer letter" }).click();
  const drawer = page.getByTestId("offer-letter-drawer");
  await drawer.getByLabel("Template").selectOption({ label: `E2E LOO issue ${tag} · v1` });
  const preview = drawer.getByTestId("offer-letter-preview");
  await expect(preview).toHaveAttribute("data-pages", /^[2-9]$/, { timeout: 30_000 });
  // Needs your input: the passport and CRICOS (required) and the material fee (optional); Send says how many.
  await expect(drawer.getByTestId("needs-input-count")).toHaveText("3");
  await expect(drawer.getByTestId("needs-input-item")).toHaveCount(3);
  await expect(drawer.getByTestId("send-offer-letter")).toHaveText(/Send \(3 details missing\)/);
  await expect(drawer.getByTestId("send-offer-letter")).toBeDisabled();
  // The values resolved from the application, the course, the intake and the fee setup.
  await drawer.getByTestId("toggle-variable-check").click();
  const valueOf = (key: string) => drawer.locator(`[data-testid=variable-check-row][data-key="${key}"]`).getByTestId("variable-check-value");
  await expect(valueOf("student.full_name")).toHaveText("Ms Asha Rani O'Neil");
  await expect(valueOf("student.dob")).toHaveText("12/04/2001");
  await expect(valueOf("course.start_date")).toHaveText("03/02/2027");
  await expect(valueOf("fees.tuition")).toHaveText("AUD$14,500.00");
  await expect(valueOf("fees.total")).toHaveText("AUD$14,750.00");
  // A yellow mark in the preview focuses its input.
  await expect(preview.getByTestId("letter-mark").first()).toBeVisible();
  await preview.locator('[data-testid=letter-mark][data-key="course.cricos"]').first().click();
  await expect(drawer.getByTestId("letter-input-course.cricos")).toBeFocused();
  await shot(page, "loo-issue-needs-input");
  // CRICOS for this letter only; the passport saved to the application (confirmed).
  await drawer.getByTestId("letter-input-course.cricos").fill("0101234");
  await drawer.getByTestId("letter-input-student.passport_number").fill("P7654321");
  await drawer.getByTestId("save-source-student.passport_number").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Save to source" }).click();
  await expect(drawer.getByTestId("saved-to-source")).toContainText("Passport number");
  expect(sql(`select public.application_values('${id}')->>'passport_number'`)).toBe("P7654321");
  // The optional material fee: Send stays disabled until it is filled or ticked blank.
  await expect(drawer.getByTestId("send-offer-letter")).toHaveText(/Send \(1 detail missing\)/);
  await drawer.getByTestId("leave-blank-fees.material").check();
  await expect(drawer.getByTestId("send-offer-letter")).toHaveText(/Send offer letter/);
  await expect(preview).toHaveAttribute("data-missing", "", { timeout: 30_000 });
  // Review still has open items for this short fixture: the admin override note.
  await drawer.getByLabel(/Note to issue anyway/).fill("Checked with the student");
  // The final check lists what was filled by hand.
  await drawer.getByTestId("send-offer-letter").click();
  const finalCheck = page.getByTestId("final-check");
  await expect(finalCheck).toContainText("CRICOS course code: 0101234");
  await expect(finalCheck).toContainText("Passport number: P7654321");
  await expect(finalCheck).toContainText("Material fee: left blank");
  await page.getByRole("alertdialog").getByRole("button", { name: "Send offer letter" }).click();
  await expect.poll(() => sql(`select status from public.enrollment_applications where id = '${id}'`)).toBe("offer_issued");
  expect(sql(`select template_name || '|' || template_version || '|' || jsonb_array_length(manual_values) from public.enrollment_offer_letters where application_id = '${id}'`)).toBe(`E2E LOO issue ${tag}|1|3`);
  expect(sql(`select cricos from public.cms_courses where id = '${course}'`), "a value for this letter does not change the course").toBe("");
  const note = sql(`select note from public.enrollment_application_status_history where application_id = '${id}' and new_status = 'offer_issued'`);
  for (const part of ["Filled by hand:", "CRICOS course code (this letter only)", "Material fee (left blank)", "Passport number (saved to Application form › Passport number)"]) expect(note).toContain(part);
  // The PDF that was sent: the header and the footer with its page number on every page; the values in the text.
  const pages = await pdfPages(Uint8Array.from(Buffer.from(sql(`select encode(content, 'base64') from public.enrollment_offer_letters where application_id = '${id}'`).replace(/\s+/g, ""), "base64")));
  expect(pages.length).toBeGreaterThanOrEqual(2);
  pages.forEach((text, i) => {
    expect(text, `page ${i + 1} header`).toContain("Skyline Institute");
    expect(text, `page ${i + 1} footer`).toContain(`Page ${i + 1} of ${pages.length}`);
    expect(text, `page ${i + 1} initials`).toContain("Student initials:");
  });
  const all = pages.join(" ");
  for (const expected of ["Dear Ms Asha Rani O'Neil, born 12/04/2001, passport P7654321.", "(CRICOS 0101234) starts 03/02/2027 (February 2027)", "Tuition AUD$14,500.00, total AUD$14,750.00, material ."]) expect(all).toContain(expected);
});
