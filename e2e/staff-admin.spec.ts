import { expect, test } from "@playwright/test";
import {
  PDF, candidateAction, createAdmin, employeeAction, expectStatus, onboard, person, protectedPdf, resetRateLimits, setHrMailMode, signInAsAdmin, signedInClient, sql, staffAt, waitForHrMail,
} from "./support";

// Staff > Employees (HR-02g) in the browser, against the LOCAL lab stack only: the sidebar, tabs, every lifecycle action with its
// confirmation dialog (withdraw, deactivate, reactivate, reject, reopen, links), failed emails with Retry, and the status history.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });
test.afterEach(async () => { await setHrMailMode("ok"); });

test("Staff is its own sidebar group with Candidates, Employees and Jobs; the old and the Master Data addresses redirect", async ({ page }) => {
  const admin = await createAdmin("menu-admin");
  const someone = await staffAt(await signedInClient(admin.email), "menu", "documents_submitted");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff");
  await expect(page).toHaveURL(/\/admin\/staff\/employees$/);
  await page.goto(`/admin/staff/${someone.id}`);
  await expect(page).toHaveURL(new RegExp(`/admin/staff/employees/${someone.id}$`));
  await expect(page.getByText(someone.email).first()).toBeVisible();
  const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "HRMS" }) }).first();
  await expect(sidebar.locator('a[href="/admin/staff/employees"]')).toHaveText("Employees");
  await expect(sidebar.locator('a[href="/admin/staff/candidates"]')).toHaveText("Candidates");
  // Jobs lives under Website (20261110200000).
  expect(sql(`select parent_id || '/' || label from public.admin_menu_items where route = '/admin/jobs'`)).toBe("website/Jobs");
  expect(sql(`select parent_id || '/' || label || '/' || route from public.admin_menu_items where id = 'agency_staff'`)).toBe("staff/Employees//admin/staff/employees");
  expect(sql(`select string_agg(id, ',' order by sort_order) from public.admin_menu_items where parent_id = 'staff' and is_enabled`)).toBe("staff_candidates,agency_staff,staff_timesheets,staff_leave,staff_pay_schedules,staff_holidays,staff_xero");
  await page.goto("/admin/candidates");
  await expect(page).toHaveURL(/\/admin\/staff\/candidates$/);
  await page.goto(`/admin/employees/${someone.id}`);
  await expect(page).toHaveURL(new RegExp(`/admin/staff/employees/${someone.id}$`));
  await page.goto("/admin/jobs?tab=applicants");
  await expect(page).toHaveURL(/\/admin\/staff\/candidates$/);
});

test("Candidates: a manual candidate (no login) gets a resume through staff-admin; a decline without the email closes the application and the person", async ({ page }) => {
  const admin = await createAdmin("manual-admin");
  const job = sql(`insert into hr.jobs(title, description, employment_type, location) values ('E2E Manual ${Date.now()}', 'Teach.', 'part_time', 'Sydney') returning id || '|' || title`).split("\n")[0].split("|");
  const who = person("manual");
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/staff/candidates?job=${job[0]}`);
  await page.getByTestId("candidate-add").click();
  await page.getByTestId("hr-person-first").fill("Mia");
  await page.getByTestId("hr-person-last").fill("Manual");
  await page.getByTestId("hr-person-email").fill(who.email);
  await page.getByTestId("hr-person-phone").fill(who.local);
  await page.getByTestId("candidate-job").selectOption(job[0]);
  await page.getByTestId("candidate-recruiter-notes").fill("Referred by a trainer.");
  await page.getByTestId("candidate-save").click();
  await expect(page).toHaveURL(/\/admin\/staff\/candidates\/[0-9a-f-]{36}$/);
  const profileId = sql(`select id from hr.staff_profiles where email = '${who.email}'`);
  expect(sql(`select status || '/' || (select count(*) from auth.users where lower(email) = '${who.email}') from hr.staff_profiles where id = '${profileId}'`)).toBe("applied/0");
  await page.getByTestId("candidate-upload-resume").setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ not a pdf") });
  await expect(page.getByText(/Attach a PDF or Word/)).toBeVisible();
  expect(sql(`select resume_path is null from hr.staff_applications where profile_id = '${profileId}'`)).toBe("t");
  await page.getByTestId("candidate-upload-resume").setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("candidate-view-resume")).toContainText("cv.pdf");
  expect(sql(`select (resume_path like '${profileId}/resume/%')::text from hr.staff_applications where profile_id = '${profileId}'`)).toBe("true");
  await candidateAction(page, "declined", async () => {
    await page.getByTestId("candidate-reason").fill("Role filled");
    await page.getByTestId("candidate-notify").uncheck();
  });
  await expect(page.getByTestId("candidate-status")).toHaveText("Declined");
  await expect(page.getByTestId("candidate-actions")).toHaveCount(0);
  expect(sql(`select p.status || '/' || (select count(*) from hr.staff_emails e where e.profile_id = p.id and e.kind = 'rejected') from hr.staff_profiles p where p.id = '${profileId}'`)).toBe("rejected/0");
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
  await expect(page.getByTestId("staff-email-failed-badge").first()).toBeVisible();
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

test("Add staff member: the record is created and the document link emailed; the same email cannot be added twice", async ({ page }) => {
  const admin = await createAdmin("add-admin");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/employees");
  const email = `added.${Date.now()}@example.test`;
  const fill = async () => {
    await page.getByTestId("staff-add").click();
    await page.getByTestId("staff-add-first").fill("Ada");
    await page.getByTestId("staff-add-last").fill("Added");
    await page.getByTestId("staff-add-email").fill(email);
    await page.getByTestId("staff-add-phone").fill(`04${String(Date.now()).slice(-8)}`);
    await page.getByTestId("staff-add-confirm").click();
  };
  await fill();
  await expect(page).toHaveURL(/\/admin\/staff\/employees\/[0-9a-f-]{36}$/);
  await expectStatus(page, "Invited");
  await waitForHrMail(email, /details and documents/i);
  await expect(page.getByTestId("staff-history")).toContainText("Added by an administrator");
  await page.goto("/admin/staff/employees");
  await fill();
  await expect(page.getByTestId("staff-add-error")).toContainText("already has a staff record");
});
