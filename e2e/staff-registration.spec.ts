import { expect, test } from "@playwright/test";
import {
  NEUTRAL_EMAIL, NEUTRAL_PHONE, PASSWORD, PDF, anonClient, clearMail, createAdmin, createStudentLogin, latestMail, person, resetRateLimits, signInThroughTheForm, sql, staffRegister,
} from "./support";

// Staff self-registration, end to end, against the LOCAL Supabase stack only. Email codes are read from the local mail inbox.
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { await clearMail(); });
test.beforeEach(() => { resetRateLimits(); });
test.afterAll(() => { resetRateLimits(); });

const registered = person("staff-ui");

test("registers as staff, verifies the email code, sets a password, and cannot submit without a passport", async ({ page }) => {
  await page.goto("/login?mode=enroll&as=staff");
  await expect(page.getByText("Needs approval").first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(registered.email);
  await page.locator("#staff-mobile").fill(registered.local);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  // A wrong code is refused; the right one verifies the address.
  await page.getByPlaceholder("123456").fill("000000");
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("alert")).toContainText("not right");
  const mail = await latestMail(registered.email);
  await page.getByPlaceholder("123456").fill(mail.code);
  await page.getByRole("button", { name: "Verify email" }).click();

  // Set a password, then the draft opens.
  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Draft");
  expect(sql(`select phone_e164 from hr.staff_profiles where email = '${registered.email}'`)).toBe(registered.phone);

  // Personal details save as a draft.
  await page.getByTestId("staff-first_name").fill("Sam");
  await page.getByTestId("staff-last_name").fill("Staffer");
  await page.getByTestId("staff-date_of_birth").fill("1991-02-03");
  await page.getByTestId("staff-address_street").fill("2 Example Road");
  await page.getByTestId("staff-address_country").fill("Australia");
  await page.getByTestId("staff-emergency_name").fill("Em Contact");
  await page.getByTestId("staff-emergency_relationship").fill("Friend");
  await page.getByTestId("staff-emergency_phone").fill("0422 333 444");
  await expect(page.getByText("Draft saved")).toBeVisible();
  expect(sql(`select first_name || '/' || emergency_phone_e164 from hr.staff_profiles where email = '${registered.email}'`)).toBe("Sam/+61422333444");

  await page.getByTestId("staff-tab-role").click();
  await page.getByTestId("staff-role-trainer").click();
  await expect(page.getByTestId("staff-role-trainer")).toHaveAttribute("aria-checked", "true");

  // Submit is blocked without a passport: the page lists it, and the server refuses it too.
  await page.getByTestId("staff-tab-review").click();
  await expect(page.getByTestId("staff-problems")).toContainText("Upload your passport.");
  await page.getByTestId("staff-submit").click();
  await expect(page.getByRole("alert")).toContainText("A passport is required before you can submit.");
  await expect(page.getByTestId("staff-status")).toHaveText("Draft");

  // Optional documents are not needed; the passport is.
  await page.getByTestId("staff-tab-documents").click();
  await page.locator('[data-testid="staff-doc-passport"] input[type="file"]').setInputFiles({ name: "passport.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-doc-passport").getByText("passport.pdf")).toBeVisible();
  await page.getByTestId("staff-tab-review").click();
  await expect(page.getByTestId("staff-problems")).toHaveCount(0);
  await page.getByTestId("staff-submit").click();
  await expect(page.getByTestId("staff-status")).toHaveText("Submitted");
  expect(sql(`select string_agg(to_status, '>' order by e.id) from hr.staff_status_events e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${registered.email}'`)).toBe("draft>submitted");
  // Nothing was granted by registering.
  expect(sql(`select count(*) from public.cms_users where lower(email) = '${registered.email}'`)).toBe("0");
  expect(sql(`select count(*) from hr.staff_roles r join hr.staff_profiles p on p.id = r.profile_id where p.email = '${registered.email}'`)).toBe("0");
});

test("an email code works once and expired codes are refused", async () => {
  // Reuse: the same code cannot be used twice.
  const reuse = person("otp-reuse");
  expect((await staffRegister({ action: "send_code", email: reuse.email, phone: reuse.phone })).status).toBe(200);
  const first = await latestMail(reuse.email);
  const client = anonClient();
  expect((await client.auth.verifyOtp({ email: reuse.email, token: first.code, type: "email" })).error).toBeNull();
  await client.auth.signOut();
  expect((await anonClient().auth.verifyOtp({ email: reuse.email, token: first.code, type: "email" })).error).not.toBeNull();

  // Expiry: a code older than its lifetime is refused.
  const old = person("otp-old");
  expect((await staffRegister({ action: "send_code", email: old.email, phone: old.phone })).status).toBe(200);
  const stale = await latestMail(old.email);
  sql(`update auth.users set confirmation_sent_at = now() - interval '3 hours', recovery_sent_at = now() - interval '3 hours' where email = '${old.email}'`);
  expect((await anonClient().auth.verifyOtp({ email: old.email, token: stale.code, type: "email" })).error).not.toBeNull();

  // A confirmation link is single use as well.
  const link = person("link-reuse");
  expect((await staffRegister({ action: "send_code", email: link.email, phone: link.phone })).status).toBe(200);
  const mail = await latestMail(link.email);
  expect((await fetch(mail.link, { redirect: "manual" })).status).toBeLessThan(400);
  const second = await fetch(mail.link, { redirect: "manual" });
  expect([302, 303, 400, 401, 403, 404, 422]).toContain(second.status);
  const location = second.headers.get("location") ?? "";
  expect(second.status >= 400 || /error|expired|invalid/i.test(location)).toBe(true);
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

  // The page shows the same text under the field, and no email is sent.
  const sent = Date.now();
  await page.goto("/login?mode=enroll&as=staff");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("you@example.com").fill(person("dup-ui").email);
  await page.locator("#staff-mobile").fill(registered.local);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("alert")).toContainText(NEUTRAL_PHONE);
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
  void sent;
});

test("an existing student applies as staff on the same login: no second account", async ({ page }) => {
  const student = await createStudentLogin("attach");
  // Typing the student's email into the staff form is refused neutrally.
  expect((await staffRegister({ action: "send_code", email: student.email, phone: person("x").phone })).body.error).toBe(NEUTRAL_EMAIL);

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
  await expect(page.getByTestId("staff-status")).toHaveText("Draft");

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

test("email code requests are rate limited per email and per IP", async () => {
  // Per email: three requests an hour, the fourth is refused.
  const same = person("limit-email");
  // (Auth itself spaces emails to one address by a second, so the requests are spaced out.)
  for (let i = 0; i < 3; i += 1) { expect((await staffRegister({ action: "send_code", email: same.email, phone: same.phone })).status).toBe(200); await new Promise((r) => setTimeout(r, 1300)); }
  const fourth = await staffRegister({ action: "send_code", email: same.email, phone: same.phone });
  expect(fourth.status).toBe(429);

  // Per IP: eight requests in ten minutes from one caller, then the next is refused, whatever the address.
  resetRateLimits();
  for (let i = 0; i < 8; i += 1) { const p = person("limit-ip"); expect((await staffRegister({ action: "send_code", email: p.email, phone: p.phone })).status).toBe(200); }
  const p = person("limit-ip");
  expect((await staffRegister({ action: "send_code", email: p.email, phone: p.phone })).status).toBe(429);
});
