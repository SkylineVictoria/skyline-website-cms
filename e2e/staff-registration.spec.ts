import { expect, test } from "@playwright/test";
import {
  PASSWORD, PDF, authLanding, createAdmin, employeeAction, expectStatus, hrMails, inDays, latestLink, linkToken, offerPdf, onboard, person, resetRateLimits,
  signInAsAdmin, signInThroughTheForm, signOutEverywhere, sql, waitForHrMail,
} from "./support";

// Staff enrolment v2 end to end, against the LOCAL lab stack only (scripts/lab/staff-lab.mjs e2e): the public form without a login,
// onboarding by emailed link, the admin review, the offer signed on the page, activation by the Auth invite, and My HR.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });

test("one full journey: apply, documents by link, review, offer signed, activation, sign in to My HR", async ({ browser, baseURL }) => {
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
  const token = linkToken((await waitForHrMail(applicant.email, /details and documents/i)).text);

  // 3. The applicant fills in details and uploads documents on /staff/onboard (no login), then submits.
  await visitor.goto(`/staff/onboard#t=${token}`);
  await expect(visitor.getByTestId("staff-tab-details")).toBeVisible();
  expect(visitor.url()).not.toContain(token);
  await visitor.getByTestId("staff-date_of_birth").fill("1991-02-03");
  await visitor.getByTestId("staff-address_street").fill("1 Journey St");
  await visitor.getByTestId("staff-address_country").fill("Australia");
  await visitor.getByTestId("staff-emergency_name").fill("Em Contact");
  await visitor.getByTestId("staff-emergency_relationship").fill("Sibling");
  await visitor.getByTestId("staff-emergency_phone").fill("+61 422 333 444");
  await visitor.getByTestId("staff-citizen-yes").click();
  await visitor.getByTestId("staff-next").click();
  for (const [slug, expiry] of [["passport", inDays(1500)], ["academic", ""], ["health-insurance", inDays(300)]]) {
    const step = visitor.getByTestId(`staff-doc-${slug}`);
    if (expiry) await visitor.getByTestId(`staff-expiry-${slug}`).fill(expiry);
    await step.locator('input[type="file"]').first().setInputFiles({ name: `${slug}.pdf`, mimeType: "application/pdf", buffer: PDF });
    await expect.poll(() => sql(`select count(*) from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.id = '${profileId}' and d.is_current and lower(replace(d.category, ' ', '-')) = '${slug}'`)).toBe("1");
  }
  await visitor.getByTestId("staff-next").click();
  await visitor.getByTestId("staff-submit").click();
  await expect(visitor.getByTestId("staff-onboard-submitted")).toBeVisible();
  await waitForHrMail("hr.one@lab.example.test", /has uploaded documents/);

  // 4. Review, offer upload and send in the admin UI.
  await office.reload();
  await expectStatus(office, "Documents submitted");
  for (const id of sql(`select id from hr.staff_documents where profile_id = '${profileId}' and is_current`).split("\n")) {
    await office.getByTestId(`staff-doc-approve-${id}`).click();
    await expect(office.getByTestId(`staff-doc-approve-${id}`)).toHaveCount(0);
  }
  await employeeAction(office, "upload_offer", async () => office.getByTestId("staff-offer-file").setInputFiles({ name: "offer.pdf", mimeType: "application/pdf", buffer: await offerPdf(2) }));
  await expect(office.getByTestId("staff-action-send_offer")).toBeVisible();
  await employeeAction(office, "send_offer");
  await expectStatus(office, "Offer sent");
  const offerToken = linkToken((await waitForHrMail(applicant.email, /offer letter from Skyline/i)).text);

  // 5. The applicant signs on the page.
  await visitor.goto(`/staff/offer#t=${offerToken}`);
  await expect(visitor.getByRole("heading", { name: "Your offer letter" })).toBeVisible();
  await expect(visitor.getByTestId("offer-open-pdf")).toHaveAttribute("target", "_blank");
  await visitor.getByLabel(/Your full name/).fill("Jo Journey");
  await visitor.getByRole("checkbox").check();
  await visitor.getByRole("button", { name: "Sign the offer" }).click();
  await expect(visitor.getByRole("heading", { name: "Your signed offer" })).toBeVisible();
  const signedMail = await waitForHrMail(applicant.email, /Your signed offer letter/);
  expect(signedMail.attachments[0]?.ContentType).toBe("application/pdf");

  // 6. Activation: the Auth invite, the password on /staff/welcome, then My HR.
  await office.reload();
  await expectStatus(office, "Offer signed");
  await employeeAction(office, "activate", async () => office.getByTestId("staff-joining-date").fill(inDays(21)));
  await expect(office.getByTestId("staff-action-resend_activation")).toBeVisible();
  await visitor.goto(await authLanding(await latestLink(applicant.email), baseURL!));
  await expect(visitor.getByRole("heading", { name: "Welcome to Skyline" })).toBeVisible();
  await visitor.getByLabel(/^Password/).fill(PASSWORD);
  await visitor.getByLabel(/^Confirm password/).fill(PASSWORD);
  await visitor.getByRole("button", { name: "Set password and continue" }).click();
  await expect(visitor.getByRole("heading", { name: "My HR" })).toBeVisible();
  expect(sql(`select status from hr.staff_profiles where id = '${profileId}'`)).toBe("active");

  // 7. A fresh sign-in through the normal form lands on My HR with the role, documents and the signed offer.
  await signOutEverywhere(visitor);
  await signInThroughTheForm(visitor, applicant.email);
  await expect(visitor).toHaveURL(/\/staff$/);
  await expect(visitor.getByRole("heading", { name: "My HR" })).toBeVisible();
  await expect(visitor.getByTestId("my-hr-role")).toContainText("Trainer");
  await expect(visitor.getByTestId("my-hr-document")).toHaveCount(3);
  await expect(visitor.getByRole("button", { name: "Open the signed offer" })).toBeVisible();
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

test("Careers: apply for a job with the same no-login form, then Jobs > Applicants sends the document link", async ({ browser }) => {
  const job = sql(`insert into hr.jobs(title, description, employment_type, location) values ('E2E Trainer ${Date.now()}', 'Teach our students.', 'full_time', 'Melbourne') returning id || '|' || title`).split("\n")[0].split("|");
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
  expect(sql(`select p.status || '/' || j.status || '/' || (j.cover_letter_path is not null) || '/' || (select count(*) from auth.users where lower(email) = '${who.email}') from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id where p.id = '${profileId}'`)).toBe("applied/applied/true/0");
  await waitForHrMail(who.email, new RegExp(`We received your application: ${job[1]}`));

  const admin = await createAdmin("careers-admin");
  const office = await (await browser.newContext()).newPage();
  await signInAsAdmin(office, admin.email);
  await office.goto(`/admin/jobs?tab=applicants&job=${job[0]}`);
  await expect(office.getByTestId("applicants-table")).toContainText(who.email);
  const appId = sql(`select id from hr.job_applications where profile_id = '${profileId}'`);
  await office.getByTestId(`applicant-send-${appId}`).click();
  await expect(office.getByTestId("applicant-dialog")).toContainText("Hired");
  await office.getByTestId("applicant-confirm").click();
  await expect(office.getByTestId("applicants-notice")).toContainText("document link was emailed");
  expect(sql(`select p.status || '/' || j.status from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id where p.id = '${profileId}'`)).toBe("invited/hired");
  await waitForHrMail(who.email, /details and documents/i);
  await office.goto(`/admin/staff/employees/${profileId}`);
  await expect(office.getByTestId("staff-job-applications")).toContainText(job[1]);
  await expect(office.getByTestId("staff-job-cover-letter")).toHaveText("I would love to teach here.");
});
