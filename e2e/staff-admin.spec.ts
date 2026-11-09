import { expect, test, type Page } from "@playwright/test";
import { PDF, approveAllDocuments, createAdmin, inDays, signInThroughTheForm, signOutEverywhere, signedInClient, sql, submittedApplicant } from "./support";

// Admin review of staff applications, against the LOCAL Supabase stack only: per-document approve/reject with a note,
// the applicant's re-upload, and one-step Activate (role) or Reject account.
test.describe.configure({ mode: "serial" });

async function signInAsAdmin(page: Page, email: string) {
  await signInThroughTheForm(page, email);
  await expect(page).toHaveURL(/\/admin/);
}
async function openApplication(page: Page, email: string, tab: "applications" | "active" | "closed" = "applications") {
  await page.goto(`/admin/staff/employees?tab=${tab}`);
  await page.getByLabel("Search staff").fill(email);
  await expect(page.getByTestId("staff-table")).toContainText(email);
  await page.getByRole("row", { name: email }).getByRole("link").click();
  await expect(page.getByText(email).first()).toBeVisible();
}

test("Staff is its own sidebar group after Agencies, with Employees; the old addresses redirect", async ({ page }) => {
  const admin = await createAdmin("menu-admin");
  const applicant = await submittedApplicant("Mo", "trainer");
  await signInAsAdmin(page, admin.email);

  // The old Agencies > Staff address and the old detail address land on Staff > Employees.
  await page.goto("/admin/staff");
  await expect(page).toHaveURL(/\/admin\/staff\/employees$/);
  await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
  await page.goto(`/admin/staff/${applicant.profileId}`);
  await expect(page).toHaveURL(new RegExp(`/admin/staff/employees/${applicant.profileId}$`));
  await expect(page.getByText(applicant.email).first()).toBeVisible();

  // Sidebar: a top-level Staff group (open on a Staff page) holding Employees; Agencies no longer lists Staff.
  await page.goto("/admin/staff/employees");
  const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "Staff" }) }).first();
  await expect(sidebar.locator('a[href="/admin/staff/employees"]')).toBeVisible();
  const groups = (await sidebar.getByRole("button").allTextContents()).map((t) => t.trim());
  const agenciesAt = groups.findIndex((t) => t.includes("Agencies"));
  expect(agenciesAt).toBeGreaterThanOrEqual(0);
  expect(groups[agenciesAt + 1]?.trim()).toBe("Staff");
  const employees = sidebar.locator('a[href="/admin/staff/employees"]');
  await expect(employees).toHaveText("Employees");
  await expect(employees).toHaveClass(/bg-primary-500/);
  await sidebar.getByRole("button", { name: /Agencies/ }).click();
  for (const href of ["/admin/businesses", "/admin/agents", "/admin/students"]) await expect(sidebar.locator(`a[href="${href}"]`)).toBeVisible();
  await expect(sidebar.locator('a[href="/admin/staff"]')).toHaveCount(0);
  expect(sql(`select parent_id || '/' || label || '/' || route from public.admin_menu_items where id = 'agency_staff'`)).toBe("staff/Employees//admin/staff/employees");
});

test("Employees tabs: Applications (with a count), Active, Inactive/Rejected", async ({ page }) => {
  const admin = await createAdmin("tabs-admin");
  const waiting = await submittedApplicant("Wren", "trainer");
  const active = await submittedApplicant("Ash", "trainer");
  const refused = await submittedApplicant("Rue", "trainer");
  const adminClient = await signedInClient(admin.email);
  await approveAllDocuments(adminClient, active.profileId);
  expect((await adminClient.rpc("hr_admin_staff_activate_account", { p_id: active.profileId, p_role: "trainer", p_note: null, p_confirm_admin: false })).error).toBeNull();
  expect((await adminClient.rpc("hr_admin_staff_reject", { p_id: refused.profileId, p_note: "Not this time." })).error).toBeNull();
  await signInAsAdmin(page, admin.email);

  await page.goto("/admin/staff/employees");
  await expect(page.getByTestId("employees-tab-applications")).toHaveAttribute("aria-selected", "true");
  const waitingCount = sql(`select count(*) from hr.staff_profiles where status in ('submitted','preboarding')`);
  await expect(page.getByTestId("employees-tab-applications-count")).toHaveText(waitingCount);
  const shows = async (tab: "applications" | "active" | "closed", present: string[], absent: string[]) => {
    await page.getByTestId(`employees-tab-${tab}`).click();
    await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
    for (const email of [...present, ...absent]) {
      await page.getByLabel("Search staff").fill(email);
      if (present.includes(email)) await expect(page.getByTestId("staff-table")).toContainText(email);
      else { await expect(page.getByTestId("staff-table")).toHaveCount(0); }
    }
    await page.getByLabel("Search staff").fill("");
  };
  await shows("applications", [waiting.email], [active.email, refused.email]);
  await shows("active", [active.email], [waiting.email, refused.email]);
  await shows("closed", [refused.email], [waiting.email, active.email]);
  // The badge counts applications whatever tab is open.
  await expect(page.getByTestId("employees-tab-applications-count")).toHaveText(waitingCount);
  // A tab survives a reload.
  await page.reload();
  await expect(page.getByTestId("employees-tab-closed")).toHaveAttribute("aria-selected", "true");
});

test("the list shows role, status, documents approved and the expiring-soon flag", async ({ page }) => {
  const admin = await createAdmin("lister");
  const soon = await submittedApplicant("Sunny", "trainer", { passportExpiry: inDays(10) });
  const later = await submittedApplicant("Lark", "admin");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/employees");
  await page.getByLabel("Search staff").fill(soon.email);
  const row = page.getByRole("row", { name: soon.email });
  await expect(row).toContainText("trainer");
  await expect(row).toContainText("Pending review");
  await expect(row.getByTestId("staff-docs-count")).toHaveText("0/5");
  await expect(row.getByTestId("staff-expiring")).toContainText("Expiring soon");
  await page.getByLabel("Search staff").fill(later.email);
  await expect(page.getByRole("row", { name: later.email }).getByTestId("staff-expiring")).toHaveCount(0);
  await approveAllDocuments(await signedInClient(admin.email), later.profileId);
  await page.reload();
  await page.getByLabel("Search staff").fill(later.email);
  await expect(page.getByRole("row", { name: later.email }).getByTestId("staff-docs-count")).toHaveText("5/5");
});

test("per-document review with preview and a rejection note; the applicant re-uploads; Activate needs every document and the Admin confirm", async ({ page }) => {
  const admin = await createAdmin("approver");
  const wantsAdmin = await submittedApplicant("Ada", "admin");
  const wantsTrainer = await submittedApplicant("Tara", "trainer");
  await signInAsAdmin(page, admin.email);

  // Search within the Applications tab.
  await page.goto("/admin/staff/employees");
  await page.getByLabel("Search staff").fill(wantsAdmin.email);
  await expect(page.getByTestId("staff-table")).toContainText(wantsAdmin.email);
  await expect(page.getByTestId("staff-table")).not.toContainText(wantsTrainer.email);

  await openApplication(page, wantsAdmin.email);
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Pending review");
  for (const label of ["Passport", "Visa", "English test result", "Academic results", "Health insurance"]) await expect(page.getByTestId("staff-documents")).toContainText(label);
  await expect(page.getByTestId("staff-documents")).toContainText("Driving licence (optional)");

  // Preview through a short-lived signed link, inside the page.
  await page.getByTestId(`staff-doc-view-${wantsAdmin.docs.passport.id}`).click();
  await expect(page.getByTestId("staff-doc-preview").locator("iframe")).toHaveAttribute("src", /\/storage\/v1\/object\/sign\/staff-documents\//);
  await page.getByRole("button", { name: "Close" }).last().click();
  await expect(page.getByTestId("staff-doc-preview")).toHaveCount(0);

  // Activate is refused while documents are pending.
  await page.getByTestId("staff-action-activate").click();
  await page.getByTestId("staff-grant-trainer").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert").last()).toContainText("Approve every required document first");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Reject the visa: a note is required.
  await page.getByTestId(`staff-doc-reject-${wantsAdmin.docs.visa.id}`).click();
  await page.getByTestId("staff-doc-reject-confirm").click();
  await expect(page.getByRole("alert").last()).toContainText("note");
  await page.getByTestId("staff-doc-reject-note").fill("The visa scan is cut off.");
  await page.getByTestId("staff-doc-reject-confirm").click();
  await expect(page.getByTestId(`staff-doc-row-${wantsAdmin.docs.visa.id}`)).toContainText("The visa scan is cut off.");
  for (const doc of [wantsAdmin.docs.passport, wantsAdmin.docs.english, wantsAdmin.docs.academic, wantsAdmin.docs.health]) {
    await page.getByTestId(`staff-doc-approve-${doc.id}`).click();
    await expect(page.getByTestId(`staff-doc-row-${doc.id}`)).toContainText("Approved");
  }
  expect(sql(`select string_agg(category || ':' || status, ',' order by category) from hr.staff_documents where profile_id = '${wantsAdmin.profileId}' and is_current`))
    .toBe("Academic:approved,English:approved,Health Insurance:approved,Passport:approved,Visa:rejected");
  expect(sql(`select (reviewed_by = '${admin.id}')::text from hr.staff_documents where id = '${wantsAdmin.docs.visa.id}'`)).toBe("true");

  // The applicant sees the note and uploads a new visa; it goes back to pending and the rejected file is kept.
  await signOutEverywhere(page);
  await signInThroughTheForm(page, wantsAdmin.email);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("staff-check-visa")).toContainText("Rejected");
  await expect(page.getByTestId("staff-check-visa")).toContainText("The visa scan is cut off.");
  await page.getByTestId(`staff-reupload-${wantsAdmin.docs.visa.id}`).setInputFiles({ name: "visa-new.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-check-visa").getByRole("alert")).toContainText("expiry date");
  await page.getByTestId(`staff-reupload-expiry-${wantsAdmin.docs.visa.id}`).fill(inDays(500));
  await page.getByTestId(`staff-reupload-${wantsAdmin.docs.visa.id}`).setInputFiles({ name: "visa-new.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("staff-check-visa").locator('[data-state="pending"]')).toBeVisible();
  expect(sql(`select string_agg(filename || ':' || status || ':' || is_current, ',' order by is_current) from hr.staff_documents where profile_id = '${wantsAdmin.profileId}' and category = 'Visa'`))
    .toBe("visa.pdf:rejected:false,visa-new.pdf:pending:true");

  // Back to the admin: approve the new visa, then Activate as Admin (confirm required).
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await openApplication(page, wantsAdmin.email);
  const newVisa = sql(`select id from hr.staff_documents where profile_id = '${wantsAdmin.profileId}' and category = 'Visa' and is_current`);
  await page.getByTestId(`staff-doc-approve-${newVisa}`).click();
  await expect(page.getByTestId(`staff-doc-row-${newVisa}`)).toContainText("Approved");
  await page.getByTestId("staff-action-activate").click();
  await page.getByTestId("staff-grant-admin").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert").last()).toContainText("confirm");
  expect(sql(`select status from hr.staff_profiles where id = '${wantsAdmin.profileId}'`)).toBe("submitted");
  expect(sql(`select count(*) from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("0");
  await page.getByTestId("staff-confirm-admin").check();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Active");
  expect(sql(`select role || '/' || status from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("Admin/Active");

  // Trainer: all documents approved, activated as trainer, never a cms_users row.
  await approveAllDocuments(await signedInClient(admin.email), wantsTrainer.profileId);
  await openApplication(page, wantsTrainer.email);
  await page.getByTestId("staff-action-activate").click();
  await expect(page.getByTestId("staff-grant-trainer")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Active");
  expect(sql(`select count(*) from public.cms_users where auth_user_id = '${wantsTrainer.id}'`)).toBe("0");
  expect(sql(`select string_agg(to_status, '>' order by id) from hr.staff_status_events where profile_id = '${wantsTrainer.profileId}'`)).toBe("draft>submitted>preboarding>active");

  // Sign in as each person: the new admin reaches the CMS; the trainer reaches only the staff workspace.
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
  await openApplication(page, wantsAdmin.email, "active");
  await page.getByTestId("staff-action-deactivate").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Inactive");
  expect(sql(`select status from public.cms_users where auth_user_id = '${wantsAdmin.id}'`)).toBe("Inactive");
});

test("an admin rejects the account with a note, the applicant sees it, and a reopen needs a note too", async ({ page }) => {
  const admin = await createAdmin("rejecter");
  const applicant = await submittedApplicant("Rae", "trainer");
  await signInAsAdmin(page, admin.email);
  await openApplication(page, applicant.email);
  await page.getByTestId("staff-action-reject").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert").last()).toContainText("note");
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
  await openApplication(page, applicant.email, "closed");
  await page.getByTestId("staff-action-reopen").click();
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByRole("alert").last()).toContainText("note");
  await page.getByTestId("staff-decision-note").fill("Please upload a clearer passport.");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-detail-status")).toHaveText("Pending");
  expect(sql(`select string_agg(to_status, '>' order by id) from hr.staff_status_events where profile_id = '${applicant.profileId}'`)).toBe("draft>submitted>rejected>draft");
});
