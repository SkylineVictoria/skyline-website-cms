import { expect, test } from "@playwright/test";
import {
  PDF, candidateAction, createAdmin, employeeAction, expectStatus, hrMails, journeyFromDocumentLink, onboard, person, resetRateLimits, signInAsAdmin, sql, waitForHrMail,
} from "./support";

// Staff enrolment v2 end to end, against the LOCAL lab stack only (scripts/lab/staff-lab.mjs e2e): the public form without a login,
// onboarding by emailed link, the admin review, the offer signed on the page, activation by the Auth invite, and My HR.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });

test("Enroll now > Staff: one full journey from the public form to My HR (document link from Employees)", async ({ browser, baseURL }) => {
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
  await employeeAction(office, "send_documents_link");
  await expectStatus(office, "Invited");
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

  // The admin: no document link from Employees while the job application is open; the pipeline on Candidates.
  const admin = await createAdmin("careers-admin");
  const office = await (await browser.newContext()).newPage();
  await signInAsAdmin(office, admin.email);
  await office.goto(`/admin/staff/employees/${profileId}`);
  await expect(office.getByTestId("staff-hire-hint")).toContainText(job[1]);
  await expect(office.getByTestId("staff-action-send_documents_link")).toHaveCount(0);
  await office.goto(`/admin/staff/candidates?job=${job[0]}`);
  await expect(office.getByTestId("candidates-table")).toContainText(who.email);
  await office.getByRole("link", { name: "Cam Careers" }).click();
  await expect(office).toHaveURL(/\/admin\/staff\/candidates\/[0-9a-f-]{36}$/);
  await expect(office.getByTestId("candidate-view-resume")).toContainText("cv.pdf");
  await expect(office.getByTestId("candidate-view-cover_letter")).toContainText("letter.pdf");
  await expect(office.getByTestId("candidate-action-hired")).toHaveCount(0);
  await candidateAction(office, "shortlisted");
  await expect(office.getByTestId("candidate-status")).toHaveText("Shortlisted");
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
