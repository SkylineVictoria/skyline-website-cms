import { expect, test, type Page } from "@playwright/test";
import {
  NEUTRAL_EMAIL, NEUTRAL_PHONE, PASSWORD, PDF, anonClient, clearMail, createAdmin, createStudentLogin, inDays, latestConfirmation, person, resetRateLimits,
  signInThroughTheForm, sql, staffRegister,
} from "./support";

// Staff self-registration, end to end, against the LOCAL Supabase stack only: email + password sign-up, Supabase email
// confirmation (link read from the local mail inbox), then the Personal details -> Documents -> Review & submit wizard.
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { await clearMail(); });
test.beforeEach(() => { resetRateLimits(); });
test.afterAll(() => { resetRateLimits(); });

const registered = person("staff-ui");

async function openStaffSignUp(page: Page) {
  await page.goto("/login?mode=enroll&as=staff");
  await expect(page.getByText("Needs approval").first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function fillSignUp(page: Page, email: string, mobile: string, password = PASSWORD, again = PASSWORD) {
  await page.getByTestId("staff-signup-email").fill(email);
  await page.locator("#staff-mobile").fill(mobile);
  await page.getByTestId("staff-signup-password").fill(password);
  await page.getByTestId("staff-signup-password-confirm").fill(again);
  const box = page.getByRole("checkbox");
  if (!(await box.isChecked())) await box.check();
}

test("signs up with email and password, confirms by email, completes the wizard and submits with every required document", async ({ page }) => {
  await openStaffSignUp(page);
  // The confirmation must match before anything is sent.
  await fillSignUp(page, registered.email, registered.local, PASSWORD, `${PASSWORD}x`);
  await page.getByTestId("staff-signup-submit").click();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();
  expect(sql(`select count(*) from auth.users where lower(email) = '${registered.email}'`)).toBe("0");

  await fillSignUp(page, registered.email, registered.local);
  await page.getByTestId("staff-signup-submit").click();
  await expect(page.getByTestId("staff-confirm-sent")).toBeVisible();
  expect(sql(`select coalesce(email_confirmed_at::text, 'unconfirmed') || '/' || (raw_user_meta_data->>'account_type') from auth.users where lower(email) = '${registered.email}'`)).toBe("unconfirmed/staff");

  // Email confirmation stays on: no sign-in before the link is opened.
  const early = await anonClient().auth.signInWithPassword({ email: registered.email, password: PASSWORD });
  expect(early.error?.message ?? "").toMatch(/not confirmed/i);

  // The staff branch of the Confirm signup template: the staff wording, the link, and no code.
  const mail = await latestConfirmation(registered.email);
  expect(mail.html).toContain("Skyline staff application");
  expect(mail.code).toBeNull();
  await page.goto(mail.link);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Pending");
  expect(sql(`select status || '/' || phone_e164 from hr.staff_profiles where email = '${registered.email}'`)).toBe(`draft/${registered.phone}`);

  // 1. Personal details (saved as a draft), citizenship and requested role.
  await page.getByTestId("staff-first_name").fill("Sam");
  await page.getByTestId("staff-last_name").fill("Staffer");
  await page.getByTestId("staff-date_of_birth").fill("1991-02-03");
  await page.getByTestId("staff-address_street").fill("2 Example Road");
  await page.getByTestId("staff-address_country").fill("Australia");
  await page.getByTestId("staff-emergency_name").fill("Em Contact");
  await page.getByTestId("staff-emergency_relationship").fill("Friend");
  await page.getByTestId("staff-emergency_phone").fill("0422 333 444");
  await expect(page.getByText("Draft saved")).toBeVisible();
  await page.getByTestId("staff-citizen-no").click();
  await expect(page.getByTestId("staff-citizen-no")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("staff-role-trainer").click();
  await expect(page.getByTestId("staff-role-trainer")).toHaveAttribute("aria-checked", "true");
  expect(sql(`select first_name || '/' || emergency_phone_e164 || '/' || is_australian_citizen from hr.staff_profiles where email = '${registered.email}'`)).toBe("Sam/+61422333444/false");

  // 3. Review lists every missing document, and the server refuses too.
  await page.getByTestId("staff-tab-review").click();
  for (const text of ["Upload your passport.", "Upload your visa.", "Upload your English test result.", "Upload your academic results.", "Upload your health insurance."]) await expect(page.getByTestId("staff-problems")).toContainText(text);
  await expect(page.getByTestId("staff-problems")).not.toContainText("licence");
  await page.getByTestId("staff-submit").click();
  await expect(page.getByRole("alert")).toContainText("A passport is required before you can submit.");
  await expect(page.getByTestId("staff-status")).toHaveText("Pending");

  // 2. Documents: an expiry date is required before upload; academic results take several files.
  await page.getByTestId("staff-tab-documents").click();
  const pick = (slug: string) => page.locator(`[data-testid="staff-doc-${slug}"] input[type="file"]`).first();
  await pick("passport").setInputFiles({ name: "passport.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-passport").getByText("Enter the expiry date first.")).toBeVisible();
  await page.getByTestId("staff-expiry-passport").fill(inDays(900));
  await pick("passport").setInputFiles({ name: "passport.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-passport").getByText("passport.pdf")).toBeVisible();
  await page.getByTestId("staff-expiry-visa").fill(inDays(400));
  await pick("visa").setInputFiles({ name: "visa.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-visa").getByText("visa.pdf")).toBeVisible();
  // English: the expiry date is optional, so it uploads without one.
  await pick("english").setInputFiles({ name: "ielts.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-english").getByText("ielts.pdf")).toBeVisible();
  await pick("academic").setInputFiles([{ name: "transcript.pdf", mimeType: "application/pdf", buffer: PDF }, { name: "diploma.pdf", mimeType: "application/pdf", buffer: PDF }]);
  await expect(page.getByTestId("staff-doc-academic").getByText("diploma.pdf")).toBeVisible();
  await expect(page.getByTestId("staff-doc-academic").getByText("transcript.pdf")).toBeVisible();
  // Driving licence: optional, but when uploaded its expiry date is required first.
  await expect(page.getByTestId("staff-doc-driving-licence")).toContainText("Optional");
  await pick("driving-licence").setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-driving-licence").getByText("Enter the expiry date first.")).toBeVisible();
  await page.getByTestId("staff-expiry-driving-licence").fill(inDays(600));
  await pick("driving-licence").setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-driving-licence").getByText("licence.pdf")).toBeVisible();
  await page.getByTestId("staff-expiry-health-insurance").fill(inDays(20));
  await pick("health-insurance").setInputFiles({ name: "health.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-health-insurance").getByText("health.pdf")).toBeVisible();
  expect(sql(`select string_agg(d.category || ':' || coalesce((d.expiry_date - current_date)::text, '-') || ':' || d.status, ',' order by d.category, d.filename) from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.email = '${registered.email}' and d.is_current`))
    .toBe("Academic:-:pending,Academic:-:pending,Driving Licence:600:pending,English:-:pending,Health Insurance:20:pending,Passport:900:pending,Visa:400:pending");
  expect(sql(`select string_agg(split_part(storage_path, '/', 2), ',' order by storage_path) from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.email = '${registered.email}'`))
    .toBe("academic,academic,driving-licence,english,health-insurance,passport,visa");

  // Review: nothing missing; the checklist flags the health insurance as expiring soon. Submit.
  await page.getByTestId("staff-tab-review").click();
  await expect(page.getByTestId("staff-problems")).toHaveCount(0);
  await expect(page.getByTestId("staff-check-health-insurance").locator('[data-expiry="soon"]')).toBeVisible();
  await page.getByTestId("staff-submit").click();
  await expect(page.getByTestId("staff-status")).toHaveText("Pending review");
  await expect(page.getByTestId("staff-checklist")).toBeVisible();
  expect(sql(`select string_agg(to_status, '>' order by e.id) from hr.staff_status_events e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${registered.email}'`)).toBe("draft>submitted");
  // Nothing was granted by registering or by choosing a role.
  expect(sql(`select count(*) from public.cms_users where lower(email) = '${registered.email}'`)).toBe("0");
  expect(sql(`select count(*) from hr.staff_roles r join hr.staff_profiles p on p.id = r.profile_id where p.email = '${registered.email}'`)).toBe("0");

  // Signing in later with the password returns to the workspace.
  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await signInThroughTheForm(page, registered.email);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Pending review");
});

test("password rules, a single-use confirmation link, and the shared Confirm signup template", async () => {
  // Password and confirmation are checked by the function before anything is created.
  const weak = person("pw-weak");
  const short = await staffRegister({ action: "sign_up", email: weak.email, phone: weak.phone, password: "short", passwordConfirm: "short" });
  expect(short.status).toBe(400);
  expect(short.body.field).toBe("password");
  const mismatch = await staffRegister({ action: "sign_up", email: weak.email, phone: weak.phone, password: PASSWORD, passwordConfirm: `${PASSWORD}!` });
  expect(mismatch.body.error).toBe("The two passwords do not match.");
  expect(sql(`select count(*) from auth.users where lower(email) = '${weak.email}'`)).toBe("0");
  // The old email-code action is gone.
  expect((await staffRegister({ action: "send_code", email: weak.email, phone: weak.phone })).status).toBe(400);

  // The confirmation link works once.
  const link = person("link-reuse");
  expect((await staffRegister({ action: "sign_up", email: link.email, phone: link.phone, password: PASSWORD, passwordConfirm: PASSWORD })).status).toBe(200);
  const mail = await latestConfirmation(link.email);
  expect((await fetch(mail.link, { redirect: "manual" })).status).toBeLessThan(400);
  expect(sql(`select (email_confirmed_at is not null)::text from auth.users where lower(email) = '${link.email}'`)).toBe("true");
  const second = await fetch(mail.link, { redirect: "manual" });
  const location = second.headers.get("location") ?? "";
  expect(second.status >= 400 || /error|expired|invalid/i.test(location)).toBe(true);
  expect((await anonClient().auth.signInWithPassword({ email: link.email, password: PASSWORD })).error).toBeNull();

  // A sign-up WITHOUT account_type (any non-staff confirmation) gets the else branch: the code ({{ .Token }}) still works.
  const other = person("not-staff");
  const { error } = await anonClient().auth.signUp({ email: other.email, password: PASSWORD, options: { data: { name: "Not Staff" } } });
  expect(error).toBeNull();
  const plain = await latestConfirmation(other.email);
  expect(plain.html).not.toContain("Skyline staff application");
  expect(plain.code).toMatch(/^\d{6}$/);
  const verified = await anonClient().auth.verifyOtp({ email: other.email, token: plain.code!, type: "signup" });
  expect(verified.error).toBeNull();
});

test("a number in any format, or the same email, is refused with the same neutral text", async ({ page }) => {
  // The staff member registered in the first test holds registered.phone / registered.email.
  const formats = [registered.local, registered.phone, `${registered.phone.slice(0, 3)} ${registered.phone.slice(3, 4)} ${registered.phone.slice(4)}`, `+61 (0)${registered.phone.slice(3)}`, `0061${registered.phone.slice(3)}`];
  for (const format of formats) {
    const other = person("dup-phone");
    const result = await staffRegister({ action: "check", email: other.email, phone: format });
    expect(result.status, format).toBe(409);
    expect(result.body.error, format).toBe(NEUTRAL_PHONE);
  }
  const sameEmail = await staffRegister({ action: "check", email: registered.email.toUpperCase(), phone: person("dup-email").phone });
  expect(sameEmail.status).toBe(409);
  expect(sameEmail.body.error).toBe(NEUTRAL_EMAIL);

  // Other kinds of account give the identical text, so nothing tells a visitor what exists.
  const student = await createStudentLogin("dup-student");
  const admin = await createAdmin("dup-admin");
  sql(`insert into public.agents(business_id, full_name, email, phone) values ('${student.agency}', 'Dup Agent', 'dup.agent.${student.id.slice(0, 6)}@example.test', '+61488777666')`);
  for (const [email, phone, expected] of [
    [student.email, person("x").phone, NEUTRAL_EMAIL], [person("x").email, student.local, NEUTRAL_PHONE],
    [admin.email, person("x").phone, NEUTRAL_EMAIL], [`dup.agent.${student.id.slice(0, 6)}@example.test`, person("x").phone, NEUTRAL_EMAIL], [person("x").email, "0488 777 666", NEUTRAL_PHONE],
  ] as const) {
    const result = await staffRegister({ action: "check", email, phone });
    expect(result.status, `${email} ${phone}`).toBe(409);
    expect(result.body.error).toBe(expected);
  }

  // The page shows the same text under the field, and no account is created.
  const fresh = person("dup-ui");
  await openStaffSignUp(page);
  await fillSignUp(page, fresh.email, registered.local);
  await page.getByTestId("staff-signup-submit").click();
  await expect(page.getByText(NEUTRAL_PHONE)).toBeVisible();
  await expect(page.getByTestId("staff-confirm-sent")).toHaveCount(0);
  expect(sql(`select count(*) from auth.users where lower(email) = '${fresh.email}'`)).toBe("0");
});

test("an existing student applies as staff on the same login: no second account", async ({ page }) => {
  const student = await createStudentLogin("attach");
  // Typing the student's email into the staff form is refused neutrally.
  expect((await staffRegister({ action: "sign_up", email: student.email, phone: person("x").phone, password: PASSWORD, passwordConfirm: PASSWORD })).body.error).toBe(NEUTRAL_EMAIL);

  // They sign in as usual, then attach the staff application to that account.
  await signInThroughTheForm(page, student.email);
  await expect(page).toHaveURL(/\/agency/);
  await page.goto("/staff/apply");
  await expect(page.getByRole("heading", { name: "Apply as staff" })).toBeVisible();
  await expect(page.getByText(student.email)).toBeVisible();
  const newNumber = person("attach-phone");
  await page.locator("#attach-phone").fill(newNumber.local);
  await page.getByRole("button", { name: "Start staff application" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Pending");

  expect(sql(`select count(*) from auth.users where lower(email) = '${student.email}'`)).toBe("1");
  expect(sql(`select auth_user_id from hr.staff_profiles where email = '${student.email}'`)).toBe(student.id);
  expect(sql(`select count(*) from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id where p.auth_user_id = '${student.id}'`)).toBe("1");

  // The student number cannot be reused for staff by someone else, and signing in again offers both workspaces.
  expect((await staffRegister({ action: "check", email: person("x").email, phone: newNumber.phone })).body.error).toBe(NEUTRAL_PHONE);
  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await signInThroughTheForm(page, student.email);
  await expect(page.getByRole("button", { name: /My staff application/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Agency portal/ })).toBeVisible();
});

test("sign-ups are rate limited per email and per IP", async () => {
  // Per email: three requests an hour, the fourth is refused.
  const same = person("limit-email");
  // (Auth itself spaces emails to one address by a second, so the requests are spaced out.)
  for (let i = 0; i < 3; i += 1) { expect((await staffRegister({ action: "sign_up", email: same.email, phone: same.phone, password: PASSWORD, passwordConfirm: PASSWORD })).status).toBe(200); await new Promise((r) => setTimeout(r, 1300)); }
  const fourth = await staffRegister({ action: "sign_up", email: same.email, phone: same.phone, password: PASSWORD, passwordConfirm: PASSWORD });
  expect(fourth.status).toBe(429);
  expect(sql(`select count(*) from auth.users where lower(email) = '${same.email}'`)).toBe("1");

  // Per IP: eight requests in ten minutes from one caller, then the next is refused, whatever the address.
  resetRateLimits();
  for (let i = 0; i < 8; i += 1) { const p = person("limit-ip"); expect((await staffRegister({ action: "sign_up", email: p.email, phone: p.phone, password: PASSWORD, passwordConfirm: PASSWORD })).status).toBe(200); }
  const p = person("limit-ip");
  expect((await staffRegister({ action: "sign_up", email: p.email, phone: p.phone, password: PASSWORD, passwordConfirm: PASSWORD })).status).toBe(429);
});
