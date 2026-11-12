import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_ANON_KEY, E2E_MAIL_URL, E2E_PORT } from "./env";
import { PASSWORD, createAdmin, createAuthUser, createStudentLogin, domSnapshot, latestLink, markStudentDocumentRead, pdfFor, person, resetRateLimits, shot, signInThroughTheForm, signedInClient, sql } from "./support";
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
  await page.getByRole("button", { name: "All steps" }).click();
  await page.getByRole("dialog", { name: "All steps" }).getByRole("button", { name: /^4\. English Test/ }).click();
  const step = page.locator('[data-current-step="true"]');
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
  await expect(step.getByText(`english-new-${student.local}.pdf`)).toBeVisible();
  await expect.poll(() => sql(`select string_agg(filename, ',') from public.enrollment_application_documents where application_id = '${applicationId}' and category = 'English Test' and is_current`)).toBe(`english-new-${student.local}.pdf`);
  // Once the old file is gone, one compact row is left.
  await expect(step.getByText("Ready for review")).toHaveCount(1);
  await shot(page, "student-form-document-read");
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

  // The full form the wizard opens (on its declaration step): the slim top bar and the All steps drawer, from the step config.
  const nav = page.getByTestId("form-step-nav");
  await expect(nav).toContainText(/Step \d+ of \d+/);
  await page.getByRole("button", { name: "All steps" }).click();
  const drawer = page.getByRole("dialog", { name: "All steps" });
  await expect(drawer.getByRole("button", { name: /^2\. Address/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("button", { name: "All steps" }).click();
  await drawer.getByRole("button", { name: /^2\. Address/ }).click();
  await expect(nav).toContainText("Address");
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
  // Replace keeps the old file when the new one is refused. (This test's documents were recorded without their files, so the
  // server's passport check refuses any new upload here; the wizard test covers a replacement that is accepted.)
  await page.getByRole("button", { name: "All steps" }).click();
  await drawer.getByRole("button", { name: /^4\. English Test/ }).click();
  const step = page.locator('[data-current-step="true"]');
  await expect(step.getByText("Ready for review")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await step.getByRole("button", { name: /^Replace / }).click();
  await (await chooser).setFiles({ name: `english-refused-${student.local}.pdf`, mimeType: "application/pdf", buffer: pdfFor("English") });
  await expect(step.getByText("We couldn't read the current passport", { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(sql(`select string_agg(filename, ',') from public.enrollment_application_documents where application_id = '${applicationId}' and category = 'English Test' and is_current`)).toBe("English Test.pdf");
  await expect(step.getByText("English Test.pdf")).toBeVisible();
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
