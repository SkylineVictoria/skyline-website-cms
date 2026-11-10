import { expect, test } from "@playwright/test";
import {
  PDF, candidateAction, createAdmin, createEditor, employeeAction, expectStatus, hrMails, onboard, person, protectedPdf, resetRateLimits, setHrMailMode, shot, signInAsAdmin, signedInClient, sql, staffAdmin, staffAt, waitForHrMail,
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
  // Jobs lives under Website (20261110200000).
  expect(sql(`select parent_id || '/' || label from public.admin_menu_items where route = '/admin/jobs'`)).toBe("website/Jobs");
  expect(sql(`select string_agg(route, ',' order by sort_order) from public.admin_menu_items where parent_id = 'website' and route in ('/admin/jobs', '/admin/staff/candidates')`)).toBe("/admin/jobs,/admin/staff/candidates");
  expect(sql(`select parent_id || '/' || label || '/' || route from public.admin_menu_items where id = 'agency_staff'`)).toBe("staff/Employees//admin/staff/employees");
  expect(sql(`select string_agg(id, ',' order by sort_order) from public.admin_menu_items where parent_id = 'staff' and is_enabled`)).toBe("agency_staff,staff_timesheets,staff_leave,staff_pay_schedules,staff_holidays,staff_xero,staff_templates");
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
  await expect(page.getByTestId("staff-action-error")).toContainText("Add the reason");
  await page.getByTestId("staff-decision-note").fill("Role filled internally");
  await page.getByTestId("staff-decision-confirm").click();
  await expectStatus(page, "Documents submitted");
  expect((await onboard({ action: "offer_open", t: p.offerToken! })).status).toBe(403);
  await expect(page.getByTestId("staff-history")).toContainText("Role filled internally");
  // The offer letter can be sent again (the pay details are still in).
  await expect(page.getByTestId("staff-action-send_offer")).toBeVisible();
});

test("deactivate and reactivate an Admin: console access goes off and back on, My HR follows", async ({ page }) => {
  const admin = await createAdmin("deact-admin");
  const p = await staffAt(await signedInClient(admin.email), "deact", "active", "admin");
  expect(sql(`select c.status from public.cms_users c join hr.staff_profiles s on s.auth_user_id = c.auth_user_id where s.id = '${p.id}'`)).toBe("Active");
  await waitForHrMail(p.email, /staff access is ready/);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/staff/employees/${p.id}`);
  await page.getByTestId("employee-onboarding").click();
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

  await page.goto("/admin/staff/employees");
  await page.getByRole("tab", { name: "Onboarding" }).click();
  await page.getByLabel("Search employees").fill(p.email);
  await expect(page.getByTestId("onboarding-table")).toContainText(p.email);
  await page.getByTestId(`onboarding-row-${p.id}`).getByRole("link").click();
  await expectStatus(page, "Documents submitted");

  // An uploaded PDF instead of a template: a protected one is refused before anything is sent.
  await page.getByTestId("staff-action-send_offer").click();
  await page.getByTestId("offer-letter-template").selectOption("__upload");
  await page.getByTestId("offer-upload-file").setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: await protectedPdf() });
  await page.getByTestId("offer-send-next").click();
  await page.getByTestId("offer-send-confirm").click();
  await expect(page.getByTestId("offer-send-error")).toContainText("password-protected or encrypted");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectStatus(page, "Documents submitted");

  await setHrMailMode("fail");
  await employeeAction(page, "reject", async () => page.getByTestId("staff-decision-note").fill("Not this time"));
  await expectStatus(page, "Rejected");
  await expect(page.getByTestId("staff-email-failed")).toBeVisible();
  // (A rejected person is in no list tab of the current Employees page; the test stays on their page.)
  await setHrMailMode("ok");
  await page.locator("[data-testid^='staff-email-retry-']").first().click();
  await expect(page.getByTestId("staff-email-failed")).toHaveCount(0);
  await waitForHrMail(p.email, /Your staff application/);

  await employeeAction(page, "reopen", async () => page.getByTestId("staff-decision-note").fill("Second look"));
  await expectStatus(page, "Applied");
  await employeeAction(page, "send_documents_link");
  await expectStatus(page, "Invited");
  await expect(page.getByTestId("staff-action-resend_documents_link")).toHaveText("Resend link");
  await page.getByTestId("staff-action-revoke_link").click();
  await expect(page.getByTestId("staff-action-status")).toContainText("does not change");
  await page.getByTestId("staff-decision-confirm").click();
  await expect(page.getByTestId("staff-action-revoke_link")).toHaveCount(0);
  await expectStatus(page, "Invited");
});

test("Add employee: Start onboarding emails the document link, the same email cannot be added twice, Add as Active now needs no email; Rejected / Withdrawn lists a withdrawn application", async ({ page }) => {
  const admin = await createAdmin("add-admin");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/employees");
  const who = person("added");
  const fill = async (mode: "onboard" | "active", email: string, local: string) => {
    await page.getByTestId("employee-add").click();
    await page.getByTestId(`employee-mode-${mode}`).check();
    await page.getByTestId("employee-firstName").fill("Ada");
    await page.getByTestId("employee-lastName").fill("Added");
    await page.getByTestId("employee-email").fill(email);
    await page.locator("#employee-phone-input").fill(local);
    await page.getByTestId("employee-save").click();
  };

  // Start onboarding: the record is created as an application and the document link is emailed.
  await fill("onboard", who.email, who.local);
  await expect(page).toHaveURL(/\/admin\/staff\/employees\/[0-9a-f-]{36}$/);
  await expectStatus(page, "Invited");
  await expect(page.getByTestId("staff-notice")).toContainText("document link was emailed");
  await expect(page.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_requested");
  await waitForHrMail(who.email, /details and documents/i);
  await expect(page.getByTestId("staff-history")).toContainText("Added by an administrator");
  const profileId = sql(`select id from hr.staff_profiles where email = '${who.email}'`);
  expect(sql(`select status || '/' || (select count(*) from auth.users where lower(email) = '${who.email}') from hr.staff_profiles where id = '${profileId}'`)).toBe("invited/0");

  // The same email (or mobile) cannot be added twice, in either mode.
  await page.goto("/admin/staff/employees");
  await fill("onboard", who.email, who.local);
  await expect(page.locator("#employee-form [role='alert']").last()).toContainText("already has a staff record");
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(sql(`select count(*) from hr.staff_profiles where email = '${who.email}'`)).toBe("1");

  // Add as Active now: no email, Active at once, on the simple employee page.
  const direct = person("direct");
  const before = (await hrMails(direct.email)).length;
  await fill("active", direct.email, direct.local);
  await expect(page).toHaveURL(/\/admin\/staff\/employees\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("employee-status")).toHaveText("Make inactive");
  expect(sql(`select status from hr.staff_profiles where email = '${direct.email}'`)).toBe("active");
  expect((await hrMails(direct.email)).length).toBe(before);

  // Withdraw the first one: it leaves Onboarding and is found under Rejected / Withdrawn, from where it can be opened again.
  await page.goto(`/admin/staff/employees/${profileId}`);
  await employeeAction(page, "reject", async () => {
    await page.getByTestId("staff-decision-note").fill("Withdrew before starting");
    await page.getByTestId("staff-reject-notify").uncheck();
  });
  await expectStatus(page, "Rejected");
  await page.goto("/admin/staff/employees");
  await page.getByRole("tab", { name: "Onboarding" }).click();
  await page.getByLabel("Search employees").fill(who.email);
  await expect(page.getByTestId(`onboarding-row-${profileId}`)).toHaveCount(0);
  await page.getByRole("tab", { name: "Rejected / Withdrawn" }).click();
  await expect(page.getByTestId("closed-table")).toContainText(who.email);
  await shot(page, "employees-rejected-withdrawn-tab");
  await page.getByTestId(`onboarding-row-${profileId}`).getByRole("link").click();
  await expectStatus(page, "Rejected");
  await expect(page.getByTestId("staff-stage-hint")).toContainText("withdrawn or rejected");
  await expect(page.getByTestId("staff-history")).toContainText("Withdrew before starting");
  await expect(page.getByTestId("staff-action-reopen")).toBeVisible();
});

test("Employees > Onboarding: every person shows the stepper and the buttons of their stage (manual candidate, Careers applicant, added by an Admin, documents in, offer signed)", async ({ page }) => {
  test.setTimeout(240_000);
  const admin = await createAdmin("stages-admin");
  const adminClient = await signedInClient(admin.email);
  const job = sql(`insert into hr.jobs(title, description, employment_type, location, department, status) values ('E2E Stages ${Date.now()}', 'Teach.', 'full_time', 'Melbourne', 'Training', 'open') returning id`).split("\n")[0];

  // The three kinds of record that were on file before the flow was released.
  // 1. A manual candidate (entered by an Admin, no resume), shortlisted.
  const manual = person("manual");
  const { data: manualApp, error: manualError } = await adminClient.rpc("hr_admin_candidate_save", { p_id: null, p_job: job, p_person: { firstName: "Mi", lastName: "Manual", email: manual.email, phone: manual.phone }, p_cover_letter: "", p_recruiter_notes: "" });
  expect(manualError).toBeNull();
  expect((await adminClient.rpc("hr_admin_candidate_progress", { p_id: manualApp, p_action: "shortlisted", p_interview_at: null, p_interview_notes: null, p_reason: null, p_notify: false })).error).toBeNull();
  const manualId = sql(`select id from hr.staff_profiles where email = '${manual.email}'`);
  // 2. A Careers applicant with a resume, shortlisted.
  const careers = person("careers");
  const careersId = sql(`select public.hr_svc_apply('Pat', 'Careers', '${careers.email}', '${careers.phone}', '${job}', null)->>'profileId'`);
  sql(`update hr.staff_applications set resume_path = '${careersId}/resume/cv.pdf', resume_filename = 'cv.pdf', resume_mime = 'application/pdf', resume_size = 10, resume_uploaded_at = now() where profile_id = '${careersId}'`);
  const careersApp = sql(`select id from hr.job_applications where profile_id = '${careersId}'`);
  expect((await adminClient.rpc("hr_admin_candidate_progress", { p_id: careersApp, p_action: "shortlisted", p_interview_at: null, p_interview_notes: null, p_reason: null, p_notify: false })).error).toBeNull();
  // 3. Someone added by an Admin with "Start onboarding" (the document link is already out).
  const added = person("added2");
  const addedId = String((await staffAdmin(adminClient, { action: "add", firstName: "Hari", lastName: "Added", email: added.email, phone: added.phone })).profileId);
  // And two later stages.
  const docsIn = await staffAt(adminClient, "stagedocs", "documents_submitted");
  const signed = await staffAt(adminClient, "stagesigned", "offer_signed");

  await signInAsAdmin(page, admin.email);
  const open = async (email: string, id: string) => {
    await page.goto("/admin/staff/employees");
    await page.getByRole("tab", { name: "Onboarding" }).click();
    await page.getByLabel("Search employees").fill(email);
    await page.getByTestId(`onboarding-row-${id}`).getByRole("link").click();
    await expect(page.getByTestId("onboarding-stepper")).toBeVisible();
    await expect(page.locator("[data-testid^='onboarding-step-']")).toHaveCount(9);
  };
  const buttons = async () => (await page.locator("[data-testid^='staff-action-']").allInnerTexts()).filter((t) => !/^Now:/.test(t));
  const stage = () => page.getByTestId("staff-onboarding-progress");

  await open(manual.email, manualId);
  await expect(stage()).toHaveAttribute("data-stage", "shortlisted");
  await expect(page.getByTestId("onboarding-step-shortlisted")).toHaveAttribute("data-state", "current");
  expect(await buttons()).toEqual(["Send document link", "Withdraw / reject"]);
  await shot(page, "onboarding-manual-candidate-shortlisted");

  await open(careers.email, careersId);
  await expect(stage()).toHaveAttribute("data-stage", "shortlisted");
  expect(await buttons()).toEqual(["Send document link", "Withdraw / reject"]);

  await open(added.email, addedId);
  await expect(stage()).toHaveAttribute("data-stage", "documents_requested");
  expect(await buttons()).toEqual(["Resend link", "Revoke link", "Withdraw / reject"]);
  await expect(page.getByTestId("staff-stage-hint")).toContainText("Link last sent");

  await open(docsIn.email, docsIn.id);
  await expect(stage()).toHaveAttribute("data-stage", "pay_details");
  expect(await buttons()).toEqual(["Send offer letter", "Edit pay details", "Withdraw / reject"]);

  await open(signed.email, signed.id);
  await expect(stage()).toHaveAttribute("data-stage", "offer_signed");
  expect(await buttons()).toEqual(["Activate employee", "Withdraw / reject"]);

  // The buttons work for the older kinds of record: the manual candidate gets the document link (which hires them for the job)...
  await open(manual.email, manualId);
  await page.getByTestId("staff-action-send_documents_link").click();
  await expect(page.getByTestId("staff-action-hire-note")).toContainText("E2E Stages");
  await page.getByTestId("staff-decision-confirm").click();
  await expectStatus(page, "Invited");
  await expect(stage()).toHaveAttribute("data-stage", "documents_requested");
  expect(await buttons()).toEqual(["Resend link", "Revoke link", "Withdraw / reject"]);
  await waitForHrMail(manual.email, /details and documents/i);
  expect(sql(`select status || '/' || stage from hr.job_applications where id = '${manualApp}'`)).toBe("hired/selected");
  // ...the Careers applicant can be withdrawn with a reason...
  await open(careers.email, careersId);
  await employeeAction(page, "reject", async () => { await page.getByTestId("staff-decision-note").fill("Withdrew"); await page.getByTestId("staff-reject-notify").uncheck(); });
  await expectStatus(page, "Rejected");
  // ...and Resend link sends a fresh link to the person added by an Admin.
  await open(added.email, addedId);
  const before = (await hrMails(added.email)).length;
  await employeeAction(page, "resend_documents_link");
  await expect(page.getByTestId("staff-notice")).toContainText("document link was emailed");
  await expect.poll(async () => (await hrMails(added.email)).length).toBe(before + 1);
});

test("HRMS > Templates: create with placeholders, preview with a real employee, duplicate, default, archive; closed to an Editor", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const admin = await createAdmin("tpl-admin");
  const adminClient = await signedInClient(admin.email);
  const p = await staffAt(adminClient, "tpl", "documents_submitted");
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/templates");
  await expect(page.getByTestId("templates-offer_letter")).toContainText("Standard offer letter");
  for (const kind of ["offer_email", "document_request", "document_reupload", "welcome_login", "rejection"]) await expect(page.getByTestId(`templates-${kind}`).getByTestId("template-row")).toHaveCount(1);
  await shot(page, "templates-list");

  // A new offer letter: placeholders are inserted from the list; an unknown one is refused.
  const name = `E2E letter ${Date.now()}`;
  await page.getByTestId("template-new-offer_letter").click();
  await page.getByTestId("template-name").fill(name);
  await page.getByTestId("template-subject").fill("Offer for {{full_name}}");
  await page.getByTestId("template-editor").click();
  await page.keyboard.type("Dear ");
  await page.getByTestId("template-placeholder-first_name").click();
  await page.keyboard.type(", you start as ");
  await page.getByTestId("template-placeholder-position").click();
  await page.keyboard.type(" on ");
  await page.getByTestId("template-placeholder-start_date").click();
  await page.keyboard.type(" at ");
  await page.getByTestId("template-placeholder-pay_rate").click();
  await page.keyboard.type(". {{bogus}}");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("template-error")).toContainText("{{bogus}}");
  await page.getByTestId("template-editor").click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 10; i++) await page.keyboard.press("Backspace");
  await shot(page, "template-editor");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("templates-notice")).toContainText("added");
  expect(sql(`select body_html ~ 'Dear \\{\\{first_name\\}\\}, you start as \\{\\{position\\}\\} on \\{\\{start_date\\}\\} at \\{\\{pay_rate\\}\\}' from hr.templates where name = '${name}'`)).toBe("t");

  // Preview with the employee's real details.
  const row = page.getByTestId("template-row").filter({ hasText: name }).first();
  await row.getByTestId("template-preview").click();
  await expect(page.getByTestId("template-preview-body")).toContainText("Dear Asha, you start as Trainer (Commercial Cookery)");
  await page.getByTestId("template-preview-search").fill(p.email);
  await expect(page.getByTestId("template-preview-person").locator(`option[value="${p.id}"]`)).toHaveCount(1);
  await page.getByTestId("template-preview-person").selectOption(p.id);
  await expect(page.getByTestId("template-preview-body")).toContainText("Dear E2E, you start as Trainer on");
  await expect(page.getByTestId("template-preview-body")).toContainText("at $42.50");
  await expect(page.getByTestId("template-preview-subject")).toHaveText("Offer for E2E tpl");
  await expect(page.getByTestId("template-preview-missing")).toHaveCount(0);
  await shot(page, "template-preview-real-employee");
  await page.getByRole("button", { name: "Close" }).last().click();

  // Duplicate, make default (one default per kind), archive and restore.
  await row.getByTestId("template-duplicate").click();
  await expect(page.getByTestId("templates-notice")).toContainText("copy");
  const copy = page.getByTestId("template-row").filter({ hasText: `${name} (copy)` });
  await expect(copy).toHaveCount(1);
  await page.getByTestId("template-row").filter({ hasText: name }).filter({ hasNotText: "(copy)" }).getByTestId("template-make-default").click();
  await expect(page.getByTestId("templates-notice")).toContainText("is now the default");
  expect(sql("select count(*) from hr.templates where type = 'offer_letter' and is_default")).toBe("1");
  page.once("dialog", (d) => { void d.accept(); });
  await copy.getByTestId("template-archive").click();
  await expect(copy).toHaveCount(0);
  await page.getByTestId("templates-show-archived").check();
  await expect(copy).toContainText("Archived");
  await copy.getByTestId("template-restore").click();
  await expect(copy).not.toContainText("Archived");
  // The chosen default is what Send offer letter proposes for this person.
  await page.goto(`/admin/staff/employees/${p.id}`);
  await page.getByTestId("staff-action-send_offer").click();
  await expect(page.getByTestId("offer-letter-preview")).toContainText("Dear E2E, you start as Trainer on");
  await page.getByRole("button", { name: "Cancel" }).click();
  // Put the seeded letter back as the default for the other tests, and remove what this test added.
  sql(`update hr.templates set is_default = false where type = 'offer_letter'; update hr.templates set is_default = true where name = 'Standard offer letter'; delete from hr.templates where name like 'E2E letter %'`);

  // An Editor: no HRMS in the menu, the page is closed, and the database refuses.
  const editor = await createEditor("tpl-editor");
  const other = await (await browser.newContext()).newPage();
  await signInAsAdmin(other, editor.email);
  await other.goto("/admin/staff/templates");
  await expect(other).not.toHaveURL(/staff\/templates/);
  await expect(other.getByTestId("templates-offer_letter")).toHaveCount(0);
  await other.goto(`/admin/staff/employees/${p.id}`);
  await expect(other.getByTestId("staff-onboarding-progress")).toHaveCount(0);
  const editorClient = await signedInClient(editor.email);
  for (const [fn, args] of [["hr_admin_templates", {}], ["hr_admin_onboarding", { p_id: p.id }], ["hr_admin_onboarding_pay_save", { p_id: p.id, p_details: {} }]] as const) {
    const { error } = await editorClient.rpc(fn, args);
    expect(error?.message ?? "").toContain("Only an administrator can do this.");
  }
});
