import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_ANON_KEY, E2E_MAIL_URL, E2E_PORT } from "./env";
import { PASSWORD, createAdmin, latestLink, person, resetRateLimits, signInThroughTheForm, signedInClient, sql } from "./support";

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
