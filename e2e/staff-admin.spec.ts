import { expect, test, type Page } from "@playwright/test";
import { createAdmin, signInThroughTheForm, signOutEverywhere, sql, submittedApplicant } from "./support";

// Admin decisions on staff applications, against the LOCAL Supabase stack only.
test.describe.configure({ mode: "serial" });

async function signInAsAdmin(page: Page, email: string) {
  await signInThroughTheForm(page, email);
  await expect(page).toHaveURL(/\/admin/);
}
async function openApplication(page: Page, email: string) {
  await page.goto("/admin/staff");
  await page.getByLabel("Search staff").fill(email);
  await expect(page.getByTestId("staff-table")).toContainText(email);
  await page.getByRole("row", { name: email }).getByRole("link").click();
  await expect(page.getByText(email).first()).toBeVisible();
}

test("the Staff item is in the admin sidebar next to Businesses, Agents and Students", async ({ page }) => {
  const admin = await createAdmin("menu-admin");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff");
  await expect(page.getByRole("heading", { name: "Staff", exact: true })).toBeVisible();
  const nav = page.locator("aside, nav").filter({ has: page.locator('a[href="/admin/students"]') }).first();
  for (const href of ["/admin/businesses", "/admin/agents", "/admin/students", "/admin/staff"]) await expect(nav.locator(`a[href="${href}"]`)).toBeVisible();
});

test("an admin approves with a role (Admin needs an explicit confirm), activates, and the person signs in with that role only", async ({ page }) => {
  const admin = await createAdmin("approver");
  const wantsAdmin = await submittedApplicant("Ada", "admin");
  const wantsTrainer = await submittedApplicant("Tara", "trainer");
  await signInAsAdmin(page, admin.email);

  // Filter by status and search.
  await page.goto("/admin/staff");
  await page.getByLabel("Filter by status").selectOption("submitted");
  await page.getByLabel("Search staff").fill(wantsAdmin.email);
  await expect(page.getByTestId("staff-table")).toContainText(wantsAdmin.email);
  await expect(page.getByTestId("staff-table")).not.toContainText(wantsTrainer.email);

  // Admin role: the confirm box is required in the UI (and the server refuses without it).
  await openApplication(page, wantsAdmin.email);
  await expect(page.getByTestId("staff-documents")).toContainText("Passport");
  await page.getByTestId("staff-action-approve").click();
  await page.getByTestId("staff-grant-admin").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert")).toContainText("confirm");
  expect(sql(`select status from hr.staff_profiles where id = '${wantsAdmin.profileId}'`)).toBe("submitted");
  await page.getByTestId("staff-confirm-admin").check();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Preboarding");
  // The role is on record, but there is no console access yet.
  expect(sql(`select role from hr.staff_roles where profile_id = '${wantsAdmin.profileId}' and revoked_at is null`)).toBe("admin");
  expect(sql(`select count(*) from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("0");
  await page.getByTestId("staff-action-activate").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Active");
  expect(sql(`select role || '/' || status from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("Admin/Active");

  // Trainer: recorded and activated, never a cms_users row.
  await openApplication(page, wantsTrainer.email);
  await page.getByTestId("staff-action-approve").click();
  await expect(page.getByTestId("staff-grant-trainer")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Preboarding");
  await page.getByTestId("staff-action-activate").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Active");
  expect(sql(`select count(*) from public.cms_users where auth_user_id = '${wantsTrainer.id}'`)).toBe("0");
  expect(sql(`select string_agg(to_status, '>' order by id) from hr.staff_status_events where profile_id = '${wantsTrainer.profileId}'`)).toBe("draft>submitted>preboarding>active");

  // Sign in as each person: the new admin reaches the CMS; the trainer reaches only the staff page.
  await signOutEverywhere(page);
  await signInThroughTheForm(page, wantsAdmin.email);
  await expect(page).toHaveURL(/\/admin/);
  await signOutEverywhere(page);
  await signInThroughTheForm(page, wantsTrainer.email);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Active");
  await page.goto("/admin/staff");
  await expect(page).not.toHaveURL(/\/admin\/staff/);

  // Deactivating switches the console off.
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await openApplication(page, wantsAdmin.email);
  await page.getByTestId("staff-action-deactivate").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Inactive");
  expect(sql(`select status from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("Inactive");
});

test("an admin rejects with a note, the applicant sees it, and a reopen needs a note too", async ({ page }) => {
  const admin = await createAdmin("rejecter");
  const applicant = await submittedApplicant("Rae", "trainer");
  await signInAsAdmin(page, admin.email);
  await openApplication(page, applicant.email);
  await page.getByTestId("staff-action-reject").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert")).toContainText("note");
  expect(sql(`select status from hr.staff_profiles where id = '${applicant.profileId}'`)).toBe("submitted");
  await page.getByTestId("staff-decision-note").fill("Passport photo is unreadable.");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Rejected");
  expect(sql(`select review_note from hr.staff_applications where profile_id = '${applicant.profileId}'`)).toBe("Passport photo is unreadable.");
  expect(sql(`select note from hr.staff_status_events where profile_id = '${applicant.profileId}' and to_status = 'rejected'`)).toBe("Passport photo is unreadable.");

  // The applicant signs in and reads the note; nothing was granted.
  await signOutEverywhere(page);
  await signInThroughTheForm(page, applicant.email);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-status")).toHaveText("Rejected");
  await expect(page.getByText("Passport photo is unreadable.").first()).toBeVisible();
  expect(sql(`select count(*) from hr.staff_roles where profile_id = '${applicant.profileId}'`)).toBe("0");

  // A rejected application stays blocked until an admin reopens it, with a note.
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await openApplication(page, applicant.email);
  await page.getByTestId("staff-action-reopen").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert")).toContainText("note");
  await page.getByTestId("staff-decision-note").fill("Please upload a clearer passport.");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Draft");
  expect(sql(`select string_agg(to_status, '>' order by id) from hr.staff_status_events where profile_id = '${applicant.profileId}'`)).toBe("draft>submitted>rejected>draft");
});
