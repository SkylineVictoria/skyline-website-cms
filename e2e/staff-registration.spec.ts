import { expect, test } from "@playwright/test";
import { PDF, applyAsStaff, candidateAction, createAdmin, createEditor, expectStatus, hrMails, inDays, journeyFromDocumentLink, linkToken, onboard, person, resetRateLimits, shot, sideBySide, signInAsAdmin, signedInClient, sql, staffAdmin, waitForHrMail } from "./support";

// Staff enrolment v2 end to end, against the LOCAL lab stack only (scripts/lab/staff-lab.mjs e2e): the public form without a login,
// onboarding by emailed link, the admin review, the offer signed on the page, activation by the Auth invite, and My HR.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });

test("Enroll now > Staff: one full journey from the public form to My HR (document link from Employees)", async ({ browser, baseURL }) => {
  test.setTimeout(300_000); // the whole journey, screenshotted at each step
  const applicant = person("journey");
  const admin = await createAdmin("journey-admin");
  const visitor = await (await browser.newContext()).newPage();
  const office = await (await browser.newContext()).newPage();

  // 1. Enroll now > Staff: the public form, no password.
  await visitor.goto("/login?mode=enroll&as=staff");
  await expect(visitor.getByRole("radio", { name: /Staff/ })).toHaveAttribute("aria-checked", "true");
  await visitor.getByRole("button", { name: "Continue" }).click();
  await visitor.getByTestId("staff-apply-first-name").fill("Jo");
  await visitor.getByTestId("staff-apply-last-name").fill("Journey");
  await visitor.getByTestId("staff-apply-email").fill(applicant.email);
  await visitor.locator("#staff-mobile").fill(applicant.local);
  await visitor.getByTestId("staff-apply-resume").setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: PDF });
  await visitor.getByRole("checkbox", { name: /I agree/ }).check();
  await visitor.getByTestId("staff-captcha-mock").check();
  await visitor.getByTestId("staff-apply-submit").click();
  await expect(visitor.getByTestId("staff-apply-thanks")).toBeVisible();
  const profileId = sql(`select id from hr.staff_profiles where email = '${applicant.email}'`);
  expect(sql(`select status || '/' || (select count(*) from auth.users where lower(email) = '${applicant.email}') from hr.staff_profiles where id = '${profileId}'`)).toBe("applied/0");
  await waitForHrMail(applicant.email, /received/i);

  // 2. The admin sends the document link.
  await signInAsAdmin(office, admin.email);
  await office.goto(`/admin/staff/employees/${profileId}`);
  await expectStatus(office, "Applied");
  await expect(office.getByTestId("onboarding-step-applied")).toHaveAttribute("data-state", "current");
  await shot(office, "admin-applied");
  await office.getByTestId("staff-action-send_documents_link").click();
  await expect(office.getByTestId("staff-action-email-note")).toContainText(applicant.email);
  await shot(office, "admin-send-document-link-confirm");
  await office.getByTestId("staff-decision-confirm").click();
  await expectStatus(office, "Invited");
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_requested");
  await expect(office.getByTestId("staff-stage-hint")).toContainText("Link last sent");
  await expect(office.getByTestId("staff-action-resend_documents_link")).toBeVisible();
  await shot(office, "admin-documents-requested");
  // 3-7. Details and documents by link, review, offer, signing, activation, sign in to My HR (shared with the Careers journey).
  await journeyFromDocumentLink(visitor, office, baseURL!, { email: applicant.email, profileId, fullName: "Jo Journey", street: "1 Journey St" });
  expect(sql(`select (joining_date is not null)::text from hr.employment where profile_id = '${profileId}'`)).toBe("true");
});

test("the public form: the same thank-you for an address that already applied, and a fake resume is refused", async ({ page }) => {
  const who = person("dupe");
  const fill = async (resume: { name: string; buffer: Buffer; mimeType: string }) => {
    await page.goto("/login?mode=enroll&as=staff");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("staff-apply-first-name").fill("Dee");
    await page.getByTestId("staff-apply-last-name").fill("Dupe");
    await page.getByTestId("staff-apply-email").fill(who.email);
    await page.locator("#staff-mobile").fill(who.local);
    await page.getByTestId("staff-apply-resume").setInputFiles(resume);
    await page.getByRole("checkbox", { name: /I agree/ }).check();
    await page.getByTestId("staff-captcha-mock").check();
    await page.getByTestId("staff-apply-submit").click();
  };
  await fill({ name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ not a pdf") });
  await expect(page.getByTestId("staff-apply-thanks")).toHaveCount(0);
  expect(sql(`select count(*) from hr.staff_profiles where email = '${who.email}'`)).toBe("0");
  await fill({ name: "cv.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-apply-thanks")).toBeVisible();
  await fill({ name: "cv.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-apply-thanks")).toBeVisible();
  expect(sql(`select count(*) from hr.staff_profiles where email = '${who.email}'`)).toBe("1");
  await waitForHrMail(who.email, /already have your staff application/);
  expect((await hrMails(who.email)).filter((m) => /already have/.test(m.subject))).toHaveLength(1);
});

test("an unknown or used onboarding link shows 'This link cannot be used'", async ({ page }) => {
  await page.goto(`/staff/onboard#t=${"x".repeat(43)}`);
  await expect(page.getByTestId("staff-link-invalid")).toBeVisible();
  expect((await onboard({ action: "open", t: "y".repeat(43) })).status).toBe(403);
});

test("Careers: the same no-login form with the job, then Candidates (shortlist, interview, selected, hire and send document link) and the full journey to My HR", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const job = sql(`insert into hr.jobs(title, description, employment_type, location, department) values ('E2E Trainer ${Date.now()}', 'Teach our students.', 'full_time', 'Melbourne', 'Training') returning id || '|' || title`).split("\n")[0].split("|");
  const who = person("careers");
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto("/careers");
  await visitor.getByRole("link", { name: job[1] }).click();
  await visitor.getByRole("link", { name: /Apply/ }).first().click();
  await expect(visitor).toHaveURL(new RegExp(`/careers/${job[0]}/apply$`));
  await visitor.getByTestId("job-apply-first-name").fill("Cam");
  await visitor.getByTestId("job-apply-last-name").fill("Careers");
  await visitor.getByTestId("job-apply-email").fill(who.email);
  await visitor.locator("#job-mobile").fill(who.local);
  await visitor.getByTestId("job-apply-resume").setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: PDF });
  await visitor.getByTestId("job-apply-cover-letter").fill("I would love to teach here.");
  await visitor.getByTestId("job-apply-cover-file").setInputFiles({ name: "letter.pdf", mimeType: "application/pdf", buffer: PDF });
  await visitor.getByTestId("job-apply-agree").check();
  await visitor.getByTestId("staff-captcha-mock").check();
  await visitor.getByTestId("job-apply-submit").click();
  await expect(visitor.getByTestId("job-apply-thanks")).toBeVisible();
  const profileId = sql(`select id from hr.staff_profiles where email = '${who.email}'`);
  expect(sql(`select p.status || '/' || j.status || '/' || j.stage || '/' || (j.cover_letter_path is not null) || '/' || (select count(*) from auth.users where lower(email) = '${who.email}') from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id where p.id = '${profileId}'`)).toBe("applied/applied/screening/true/0");
  await waitForHrMail(who.email, new RegExp(`We received your application: ${job[1]}`));

  // The admin: the employee page offers the document link too (it hires the job application); this journey uses the Candidates pipeline.
  const admin = await createAdmin("careers-admin");
  const office = await (await browser.newContext()).newPage();
  await signInAsAdmin(office, admin.email);
  await office.goto(`/admin/staff/employees/${profileId}`);
  await expect(office.getByTestId("staff-hire-hint")).toContainText(job[1]);
  await expect(office.getByTestId("staff-action-send_documents_link")).toBeVisible();
  await office.goto(`/admin/staff/candidates?job=${job[0]}`);
  await expect(office.getByTestId("candidates-table")).toContainText(who.email);
  await office.getByRole("link", { name: "Cam Careers" }).click();
  await expect(office).toHaveURL(/\/admin\/staff\/candidates\/[0-9a-f-]{36}$/);
  await expect(office.getByTestId("candidate-view-resume")).toContainText("cv.pdf");
  await expect(office.getByTestId("candidate-view-cover_letter")).toContainText("letter.pdf");
  await expect(office.getByTestId("candidate-action-hired")).toHaveCount(0);
  await candidateAction(office, "shortlisted");
  await expect(office.getByTestId("candidate-status")).toHaveText("Shortlisted");
  expect(sql(`select hr.onboarding_stage('${profileId}')->>'stage'`)).toBe("shortlisted");
  await candidateAction(office, "interview", async () => {
    await office.getByTestId("candidate-interview-at").fill("2026-12-01T10:00");
    await office.getByTestId("candidate-interview-notes").fill("Bring the portfolio.");
  });
  await expect(office.getByTestId("candidate-status")).toHaveText("Interview");
  await candidateAction(office, "selected");
  await expect(office.getByTestId("candidate-status")).toHaveText("Selected");
  await candidateAction(office, "hired");
  await expect(office).toHaveURL(new RegExp(`/admin/staff/employees/${profileId}$`));
  await expectStatus(office, "Invited");
  await expect(office.getByTestId("staff-employment")).toContainText(job[1]);
  await expect(office.getByTestId("staff-job-applications")).toContainText("Hired");
  await expect(office.getByTestId("staff-job-cover-letter")).toHaveText("I would love to teach here.");
  expect(sql(`select p.status || '/' || j.status || '/' || e.job_title || '/' || e.department || '/' || coalesce(e.joining_date::text, 'none') from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id join hr.employment e on e.profile_id = p.id where p.id = '${profileId}'`)).toBe(`invited/hired/${job[1]}/Training/none`);

  // The rest is the same as Enroll now: documents by link, review, offer, signing, activation, My HR (with the job).
  await journeyFromDocumentLink(visitor, office, baseURL!, { email: who.email, profileId, fullName: "Cam Careers", street: "2 Careers Rd", jobTitle: job[1] });
  expect(sql(`select (joining_date is not null)::text from hr.employment where profile_id = '${profileId}'`)).toBe("true");
});

// The onboarding wizard on a phone, as someone who is not an Australian citizen: which documents are required, checks on the
// field (the same rules and messages as the student wizard), the address search and its fallback to typing, bank details, the
// review with Edit per section, then the administrator's view: what was read beside each document, the "verified by admin"
// ticks, and bank details masked until Reveal (which is recorded). With E2E_SHOTS_DIR set, every step is saved at desktop and
// phone width, and the steps the student wizard shares are placed side by side with it.
test("onboarding wizard on a phone: required documents, checks on the field, address search with typing as the fallback, bank details masked, review; then the Admin's view", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await createAdmin("wizard-admin");
  const adminClient = await signedInClient(admin.email);
  const applicant = await applyAsStaff("wizard");
  await staffAdmin(adminClient, { action: "send_invite", profileId: applicant.id, purpose: "documents" });
  const token = linkToken((await waitForHrMail(applicant.email, /details and documents/i)).text);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  // 1. Documents: nothing can be skipped, and the list of required documents follows the citizenship answer.
  await page.goto(`/staff/onboard#t=${token}`);
  await expect(page.getByTestId("staff-step-documents")).toBeVisible();
  await expect(page.getByTestId("wizard-camera").first()).toBeAttached();
  await page.getByTestId("staff-next").click();
  await expect(page.getByText("Tell us whether you are an Australian citizen.")).toBeVisible();
  await page.getByTestId("staff-citizen-no").click();
  await expect(page.getByTestId("staff-required-summary")).toContainText("Passport, Visa, English test result, Academic results, Health insurance (0 of 5 uploaded)");
  await expect(page.getByTestId("staff-required-summary")).toContainText("Optional: Driving licence");
  await page.getByTestId("staff-next").click();
  await expect(page.getByTestId("staff-step-notice")).toContainText("A passport is required before you can submit.");
  await shot(page, "staff-wizard-documents-required");
  // A file that is not a PDF, JPG or PNG is refused before it is sent, with the student wizard's message.
  await page.getByTestId("staff-doc-passport").locator('input[type="file"]').first().setInputFiles({ name: "passport.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a....") });
  await expect(page.getByTestId("staff-doc-passport")).toContainText("Only PDF, JPG, and PNG documents are supported.");
  for (const slug of ["passport", "visa", "english", "academic", "health-insurance"]) {
    await page.getByTestId(`staff-doc-${slug}`).locator('input[type="file"]').first().setInputFiles({ name: `${slug}.pdf`, mimeType: "application/pdf", buffer: PDF });
    await expect.poll(() => sql(`select count(*) from hr.staff_documents d where d.profile_id = '${applicant.id}' and d.is_current and lower(replace(d.category, ' ', '-')) = '${slug}'`)).toBe("1");
  }
  await expect(page.getByTestId("staff-doc-visa")).toContainText("Done ✓");
  await page.getByTestId("staff-next").click();

  // 2. Check details: read from the passport and the visa; what cannot be read is marked; a mismatch can take the document's value.
  await expect(page.getByTestId("staff-step-prefill")).toBeVisible();
  await expect(page.getByTestId("staff-visa_subclass")).toHaveValue("485");
  await expect(page.getByTestId("staff-source-visa_subclass")).toContainText("From your visa");
  await expect(page.getByTestId("staff-expiry-visa")).toHaveValue("2031-03-04");
  await expect(page.getByTestId("staff-step-prefill").locator('[data-source="unread"]').first()).toBeVisible();
  await expect(page.getByTestId("staff-source-last_name")).toContainText('which shows "READER"');
  await page.getByTestId("staff-use-last_name").click();
  await expect(page.getByTestId("staff-last_name")).toHaveValue("READER");
  await expect(page.getByTestId("staff-source-last_name")).toContainText("From your passport");
  await page.getByTestId("staff-date_of_birth").fill("2020-01-01");
  await expect(page.getByText("You must be between 10 and 100 years old.")).toBeVisible();
  await page.getByTestId("staff-date_of_birth").fill("1985-02-03");
  await page.getByTestId("staff-passport_number").fill("12");
  await expect(page.getByText("Enter the passport number: 6 to 12 letters and numbers.")).toBeVisible();
  await page.getByTestId("staff-passport_number").fill("pa1234567");
  await page.getByTestId("staff-visa_conditions").fill("8105 work limitation");
  await page.getByTestId("staff-expiry-health-insurance").fill(inDays(300));
  await shot(page, "staff-wizard-check-details-phone");
  await page.getByTestId("staff-next").click();

  // 3. Personal details: the same messages as the student wizard's emergency contact; the address search, then its fallback.
  await expect(page.getByTestId("staff-step-personal")).toBeVisible();
  await page.getByTestId("staff-next").click();
  await expect(page.getByText("Enter the emergency contact's name.")).toBeVisible();
  await expect(page.getByText("Enter the emergency contact's phone number.")).toBeVisible();
  await expect(page.getByText("Enter how they are related to you.")).toBeVisible();
  await expect(page.getByText("Enter the street address.")).toBeVisible();
  await shot(page, "staff-wizard-personal-required");
  await page.getByTestId("staff-emergency_name").fill("Em Contact");
  await page.getByTestId("staff-emergency_relationship").fill("Sibling");
  await page.locator("#staff-emergency_phone").fill("0412");
  await page.locator("#staff-emergency_phone").blur();
  await page.getByTestId("staff-next").click();
  await expect(page.getByText("Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.").first()).toBeVisible();
  await shot(page, "staff-wizard-personal-phone");
  await page.locator("#staff-emergency_phone").fill("0422333444");
  // The mobile has the country picker, +61 first; a number without enough digits is refused on the field.
  await expect(page.getByTestId("staff-step-personal").getByLabel("Country code").first()).toHaveValue("61");
  // The lookup fails: the box says so, and the address is typed by hand.
  await page.locator("#address-search").fill("1 Outage St");
  await expect(page.getByTestId("staff-address-search")).toContainText("Address search is unavailable right now.");
  await shot(page, "staff-wizard-address-unavailable");
  await page.getByTestId("staff-address_street").fill("5 Typed Ave");
  await page.getByTestId("staff-address_suburb").fill("Carlton");
  await page.getByTestId("staff-address_state").selectOption("VIC");
  await page.getByTestId("staff-address_postcode").fill("30");
  await expect(page.getByText("Enter the 4-digit postcode.")).toBeVisible();
  await page.getByTestId("staff-address_postcode").fill("3053");
  // The lookup works again: a result replaces what was typed.
  await page.locator("#address-search").fill("12 Smith St Carlton");
  await page.locator("#address-search-results").getByRole("option").nth(1).click();
  await expect(page.getByTestId("staff-address_street")).toHaveValue("12 Smith St");
  await expect(page.getByTestId("staff-address_line2")).toHaveValue("Unit 3");
  await expect(page.getByTestId("staff-address_suburb")).toHaveValue("Carlton");
  await expect(page.getByTestId("staff-address_postcode")).toHaveValue("3053");
  await shot(page, "staff-wizard-address-picked");
  await page.getByTestId("staff-next").click();

  // 4. Bank details: checked on the field; saved on Continue; masked from then on.
  await expect(page.getByTestId("staff-step-bank")).toBeVisible();
  await page.getByTestId("staff-next").click();
  await expect(page.getByText("Enter the account name.")).toBeVisible();
  await page.getByTestId("staff-bank-accountName").fill("Lab Wizard");
  await page.getByTestId("staff-bank-bsb").fill("0620");
  await page.getByTestId("staff-bank-bsb").blur();
  await expect(page.getByText("The BSB must be 6 digits, for example 062-000.")).toBeVisible();
  await page.getByTestId("staff-bank-bsb").fill("733000");
  await page.getByTestId("staff-bank-bsb").blur();
  await expect(page.getByTestId("staff-bank-bsb")).toHaveValue("733-000");
  await expect(page.getByTestId("staff-bank-name")).toContainText("Westpac");
  await page.getByTestId("staff-bank-accountNumber").fill("7711223344");
  await shot(page, "staff-wizard-bank-phone");
  await page.getByTestId("staff-next").click();

  // 5. Review: everything grouped, Edit goes to the section, the bank numbers are masked, Submit only when complete.
  await expect(page.getByTestId("staff-step-review")).toBeVisible();
  await expect(page.getByTestId("staff-review-bank")).toContainText("73••••");
  await expect(page.getByTestId("staff-review-bank")).toContainText("•••• 3344");
  await expect(page.locator("body")).not.toContainText("7711223344");
  await expect(page.getByTestId("staff-submit")).toBeEnabled();
  await page.getByRole("button", { name: "Edit Bank details" }).click();
  await expect(page.getByTestId("staff-bank-saved")).toContainText("•••• 3344");
  await shot(page, "staff-wizard-bank-saved");
  await page.getByTestId("staff-stepper").getByRole("button", { name: /Review and submit/ }).click();
  await expect(page.getByTestId("staff-stepper").locator("i.ri-check-line")).toHaveCount(5);
  await shot(page, "staff-wizard-review-phone");
  // A refresh keeps the place and everything typed (saved as they went); the link is not in the address.
  await page.reload();
  await expect(page.getByTestId("staff-step-review")).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect(requests.some((url) => /7711223344|733000|bsb=|account/i.test(url)), "no bank value ever travels in an address").toBe(false);
  await page.getByTestId("staff-submit").click();
  await expect(page.getByTestId("staff-onboard-submitted")).toBeVisible();
  expect(sql(`select status || '/' || visa_conditions || '/' || last_name from hr.staff_profiles where id = '${applicant.id}'`)).toBe("documents_submitted/8105 work limitation/READER");
  await phone.close();

  // The administrator: what was read beside each document, a tick per section, bank details masked until Reveal.
  const office = await (await browser.newContext()).newPage();
  await signInAsAdmin(office, admin.email);
  await office.goto(`/admin/staff/employees/${applicant.id}`);
  const passport = sql(`select id from hr.staff_documents where profile_id = '${applicant.id}' and category = 'Passport' and is_current`);
  await expect(office.getByTestId(`staff-doc-extracted-${passport}`)).toContainText("Passport number");
  await expect(office.getByTestId(`staff-doc-extracted-${passport}`)).toContainText("PA1234567");
  await expect(office.getByTestId("staff-documents")).toContainText("This document type is not read automatically");
  await office.getByTestId("staff-check-passport").getByRole("checkbox").click();
  await expect(office.getByTestId("staff-check-passport")).toHaveAttribute("data-verified", "yes");
  await expect(office.getByTestId("staff-check-passport")).toContainText("E2E Admin");
  await office.getByTestId("staff-check-personal").getByRole("checkbox").click();
  await expect(office.getByTestId("staff-check-personal")).toHaveAttribute("data-verified", "yes");
  await expect(office.getByTestId("bank-bsb")).toHaveText("73••••");
  await expect(office.getByTestId("bank-account-number")).toHaveText("•••• 3344");
  await expect(office.locator("body")).not.toContainText("7711223344");
  await office.getByTestId("staff-check-bank").getByRole("checkbox").click();
  await expect(office.getByTestId("staff-check-bank")).toHaveAttribute("data-verified", "yes");
  await shot(office, "admin-wizard-extracted-ticks-bank-masked");
  await office.getByTestId("bank-reveal").click();
  await expect(office.getByTestId("bank-account-number")).toHaveText("7711223344");
  await expect(office.getByTestId("bank-bsb")).toHaveText("733-000");
  await expect(office.getByTestId("staff-timeline")).toContainText("Bank details revealed (viewed in full)");
  await expect(office.getByTestId("staff-timeline")).toContainText("Verified: Passport");
  await shot(office, "admin-wizard-bank-revealed-history");
  await office.getByTestId("bank-hide").click();
  await expect(office.getByTestId("bank-account-number")).toHaveText("•••• 3344");
  expect(sql(`select count(*) from hr.staff_audit where profile_id = '${applicant.id}' and action = 'bank_revealed'`)).toBe("1");
  // The count and the stepper work as before: approve everything and the stage moves on.
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_submitted");
  for (const id of sql(`select id from hr.staff_documents where profile_id = '${applicant.id}' and is_current`).split("\n")) {
    await office.getByTestId(`staff-doc-approve-${id}`).click();
    await expect(office.getByTestId(`staff-doc-approve-${id}`)).toHaveCount(0);
  }
  await office.reload();
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_approved");
  await expect(office.getByRole("heading", { level: 1 }).locator("xpath=ancestor::*[1]/..")).toContainText("Documents approved 5/5");

  // An Editor: no bank details, masked or not.
  const editor = await createEditor("wizard-editor");
  const editorClient = await signedInClient(editor.email);
  for (const name of ["hr_admin_emp_bank_get", "hr_admin_emp_bank_reveal", "hr_admin_onboarding_extras"]) {
    const { data, error } = await editorClient.rpc(name, { p_id: applicant.id });
    expect([name, data, error?.code]).toEqual([name, null, "42501"]);
  }

  // The steps the student wizard shares, side by side (only when screenshots are being kept).
  for (const size of ["desktop", "mobile"] as const) {
    await sideBySide(office, `upload-${size}`, "Upload step", `student-wizard-upload-${size}`, `staff-wizard-documents-${size}`);
    await sideBySide(office, `uploaded-${size}`, "A document uploaded and read", `student-wizard-uploaded-${size}`, `staff-wizard-documents-uploaded-${size}`);
    await sideBySide(office, `emergency-required-${size}`, "Emergency contact: nothing entered", `student-wizard-emergency-required-${size}`, `staff-wizard-personal-required-${size}`);
    await sideBySide(office, `emergency-phone-${size}`, "Emergency contact: a phone number that is too short", `student-wizard-emergency-phone-${size}`, `staff-wizard-personal-phone-${size}`);
  }
});
