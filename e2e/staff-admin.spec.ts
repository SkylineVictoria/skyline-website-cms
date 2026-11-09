import { expect, test } from "@playwright/test";
import {
  createAdmin, employeeAction, expectStatus, onboard, protectedPdf, resetRateLimits, setHrMailMode, signInAsAdmin, signedInClient, sql, staffAt, waitForHrMail,
} from "./support";

// Staff > Employees (HR-02g) in the browser, against the LOCAL lab stack only: the sidebar, tabs, every lifecycle action with its
// confirmation dialog (withdraw, deactivate, reactivate, reject, reopen, links), failed emails with Retry, and the status history.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });
test.afterEach(async () => { await setHrMailMode("ok"); });

test("Staff is its own sidebar group with Employees; the old addresses redirect", async ({ page }) => {
  const admin = await createAdmin("menu-admin");
  const someone = await staffAt(await signedInClient(admin.email), "menu", "documents_submitted");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff");
  await expect(page).toHaveURL(/\/admin\/staff\/employees$/);
  await page.goto(`/admin/staff/${someone.id}`);
  await expect(page).toHaveURL(new RegExp(`/admin/staff/employees/${someone.id}$`));
  await expect(page.getByText(someone.email).first()).toBeVisible();
  const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "Staff" }) }).first();
  await expect(sidebar.locator('a[href="/admin/staff/employees"]')).toHaveText("Employees");
  expect(sql(`select parent_id || '/' || label || '/' || route from public.admin_menu_items where id = 'agency_staff'`)).toBe("staff/Employees//admin/staff/employees");
});

test("withdraw an offer: the dialog needs a note, the status goes back and the offer link stops working", async ({ page }) => {
  const admin = await createAdmin("withdraw-admin");
  const p = await staffAt(await signedInClient(admin.email), "withdraw", "offer_sent");
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/staff/employees/${p.id}`);
  await expectStatus(page, "Offer sent");
  await page.getByTestId("staff-action-withdraw_offer").click();
  await expect(page.getByTestId("staff-action-status")).toContainText("Offer sent");
  await expect(page.getByTestId("staff-action-status")).toContainText("Documents submitted");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-action-error")).toContainText("Add a note");
  await page.getByTestId("staff-decision-note").fill("Role filled internally");
  await page.getByTestId("staff-decision-confirm").click();
  await expectStatus(page, "Documents submitted");
  expect((await onboard({ action: "offer_open", t: p.offerToken! })).status).toBe(403);
  await expect(page.getByTestId("staff-history")).toContainText("Role filled internally");
  // A new offer can be uploaded again.
  await expect(page.getByTestId("staff-action-upload_offer")).toBeVisible();
});

test("deactivate and reactivate an Admin: console access goes off and back on, My HR follows", async ({ page }) => {
  const admin = await createAdmin("deact-admin");
  const p = await staffAt(await signedInClient(admin.email), "deact", "active", "admin");
  expect(sql(`select c.status from public.cms_users c join hr.staff_profiles s on s.auth_user_id = c.auth_user_id where s.id = '${p.id}'`)).toBe("Active");
  await waitForHrMail(p.email, /staff access is ready/);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/staff/employees/${p.id}`);
  await expectStatus(page, "Active");
  await employeeAction(page, "deactivate", async () => page.getByTestId("staff-decision-note").fill("Left the company"));
  await expectStatus(page, "Inactive");
  expect(sql(`select c.status from public.cms_users c join hr.staff_profiles s on s.auth_user_id = c.auth_user_id where s.id = '${p.id}'`)).toBe("Inactive");
  const meWhileInactive = await (await signedInClient(p.email)).rpc("hr_staff_me");
  expect((meWhileInactive.data as { status: string; documents: unknown[] }).status).toBe("inactive");
  expect((meWhileInactive.data as { documents: unknown[] }).documents).toHaveLength(0);
  await employeeAction(page, "reactivate");
  await expectStatus(page, "Active");
  expect(sql(`select c.status from public.cms_users c join hr.staff_profiles s on s.auth_user_id = c.auth_user_id where s.id = '${p.id}'`)).toBe("Active");
  const history = await page.getByTestId("staff-history").innerText();
  expect(history).toContain("Active → Inactive");
  expect(history).toContain("Inactive → Active");
});

test("tabs, a failed rejection email with Retry, reopen and revoke, and a protected offer refused", async ({ page }) => {
  const admin = await createAdmin("tabs-admin");
  const adminClient = await signedInClient(admin.email);
  const p = await staffAt(adminClient, "tabs", "documents_submitted");
  await signInAsAdmin(page, admin.email);

  await page.goto(`/admin/staff/employees?tab=documents`);
  await page.getByLabel("Search staff").fill(p.email);
  await expect(page.getByTestId("staff-table")).toContainText(p.email);
  await page.getByRole("row", { name: p.email }).getByRole("link").click();
  await expectStatus(page, "Documents submitted");

  await page.getByTestId("staff-action-upload_offer").click();
  await page.getByTestId("staff-offer-file").setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: await protectedPdf() });
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-action-error")).toContainText("password-protected or encrypted");
  await page.getByRole("button", { name: "Cancel" }).click();

  await setHrMailMode("fail");
  await employeeAction(page, "reject", async () => page.getByTestId("staff-decision-note").fill("Not this time"));
  await expectStatus(page, "Rejected");
  await expect(page.getByTestId("staff-email-failed")).toBeVisible();
  await page.goto("/admin/staff/employees?tab=closed");
  await page.getByLabel("Search staff").fill(p.email);
  await expect(page.getByTestId("staff-email-failed-badge")).toBeVisible();
  await page.getByRole("row", { name: p.email }).getByRole("link").click();
  await setHrMailMode("ok");
  await page.locator("[data-testid^='staff-email-retry-']").first().click();
  await expect(page.getByTestId("staff-email-failed")).toHaveCount(0);
  await waitForHrMail(p.email, /Your staff application/);

  await employeeAction(page, "reopen", async () => page.getByTestId("staff-decision-note").fill("Second look"));
  await expectStatus(page, "Applied");
  await employeeAction(page, "send_documents_link");
  await expectStatus(page, "Invited");
  await page.getByTestId("staff-action-revoke_link").click();
  await expect(page.getByTestId("staff-action-status")).toContainText("does not change");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-action-revoke_link")).toHaveCount(0);
  await expectStatus(page, "Invited");
});
