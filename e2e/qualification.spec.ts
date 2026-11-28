import { expect, test } from "@playwright/test";
import { createAdmin, createStudentLogin, createAuthUser, inDays, person, signInAsAdmin, signInThroughTheForm, signOutEverywhere, sql } from "./support";

// QUALIFICATION (20261128003517): an application marked Enrolled gets its Qualification (Tentative, CoE copied); staff see it in
// Admissions › Qualifications, on the student's Qualification tab and on the application; they defer it (reason + resume date) and
// the CoE student's "Report in PRISMS within 14 days" task appears.
test.describe.configure({ mode: "serial" });

const tag = Date.now().toString(36).toUpperCase();
const ids = { course: `course-zzq-${tag}`, unit: `unit-zzq-${tag}` };

test("an Enrolled application's Qualification: list, detail, defer with a PRISMS task, student tab and application card", async ({ page }) => {
  const admin = await createAdmin("qual-admin");
  // Fixture: a published course with one unit and an intake starting later, a student with an application (CoE issued).
  const out = sql(`
    insert into public.agencies(name, code) values ('ZZ Qualification Agency ${tag}', 'ZZQ-${tag}') returning id;
  `);
  const agency = out.split("\n")[0];
  sql(`insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture.pdf', 'fixtures/' || a.id || '/agreement.pdf' from public.agencies a where a.id = '${agency}' and a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none';`);
  const student = sql(`
    insert into public.enrollment_students(agency_id, full_name, email) values ('${agency}', 'Zz Quentin', 'zz.quentin.${tag}@blackhole.postmarkapp.com') returning id;
  `).split("\n")[0];
  sql(`
    update public.enrollment_students set sex_code = 'M', birth_country_code = '1101', home_language_code = '1201', indigenous_status_code = '4',
      school_level_code = '12', school_level_year = '2017', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N',
      details = coalesce(details, '{}'::jsonb) || '{"first_name": "Zz", "last_name": "Quentin", "dob": "2000-01-01", "usi_number": "ABCDE12345", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC"}'::jsonb
     where id = '${student}';
    insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level)
      values ('${ids.course}', 'zzq-${tag.toLowerCase()}', 'ZZQ${tag.slice(-4)}', 'ZZ Qualification Course', 'Draft', 'Face to Face', '0403', '331212', 'Certificate III');
    insert into public.cms_course_units(id, course_id, code, name) values ('${ids.unit}', '${ids.course}', 'ZZQU${tag.slice(-4)}', 'Work safely');
  `);
  const intake = sql(`insert into public.course_intakes(course_id, start_date, end_date, label) values ('${ids.course}', '${inDays(40)}', '${inDays(300)}', 'ZZ later') returning id;`).split("\n")[0];
  sql(`
    insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('${intake}', '${ids.unit}', '${inDays(40)}', '${inDays(300)}');
    update public.cms_courses set status = 'Published' where id = '${ids.course}';
  `);
  const app = sql(`
    insert into public.enrollment_applications(agency_id, student_id, student_name, student_email, status, data, reference)
      values ('${agency}', '${student}', 'Zz Quentin', 'zz.quentin.${tag}@blackhole.postmarkapp.com', 'draft', '{"values": {"study_reason": "12"}}', 'ZZ-Q-${tag}') returning id;
  `).split("\n")[0];
  sql(`
    begin;
    insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('${app}', '${ids.course}', 'ZZQ', 'ZZ Qualification Course', '${intake}');
    set local session_replication_role = replica;
    update public.enrollment_applications set status = 'coe_issued' where id = '${app}';
    insert into public.enrollment_coe_documents(registration_id, application_id, kind, file_name, size_bytes, sha256, content, document_number, issue_date)
      values (gen_random_uuid(), '${app}', 'coe', 'coe.pdf', 8, encode(sha256('%PDF-coe'::bytea), 'hex'), '%PDF-coe'::bytea, 'E${tag.slice(-7)}', current_date);
    set local session_replication_role = origin;
    update public.enrollment_applications set status = 'enrolled' where id = '${app}';
    commit;
  `);
  const qid = sql(`select id from public.intake_enrolments where application_id = '${app}'`);
  expect(qid).toMatch(/^[0-9a-f-]{36}$/);
  expect(sql(`select status from public.intake_enrolments where id = '${qid}'`)).toBe("tentative");

  await signInAsAdmin(page, admin.email);
  // Admissions › Qualifications, filtered to Tentative.
  await page.goto("/admin/qualifications?status=tentative");
  const row = page.getByTestId("qualifications-table").getByRole("row").filter({ hasText: `ZZQ${tag.slice(-4)}` });
  await expect(row).toContainText("Tentative");
  await row.getByRole("link", { name: "Zz Quentin" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/qualifications/${qid}$`));
  await expect(page.getByTestId("qualification-status")).toHaveText("Tentative");
  await expect(page.getByText(`COE E${tag.slice(-7)}`)).toBeVisible();
  await expect(page.getByTestId("qualification-history")).toContainText("Enrolled from application");

  // Defer: reason and resume date; the CoE student gets the PRISMS task.
  await page.getByTestId("qualification-change").click();
  await page.getByTestId("qualification-change-to").selectOption("deferred");
  await page.getByTestId("qualification-change-reason").selectOption({ label: "Visa delay" });
  await expect(page.getByTestId("qualification-change-save")).toBeDisabled();
  await page.getByTestId("qualification-change-resume").fill(inDays(120));
  await page.getByTestId("qualification-change-save").click();
  await expect(page.getByTestId("qualification-status")).toHaveText("Deferred");
  await expect(page.getByTestId("qualification-tasks")).toContainText("Report in PRISMS within 14 days");
  expect(sql(`select status || '/' || status_reason from public.intake_enrolments where id = '${qid}'`)).toBe("deferred/Visa delay");

  // QUALIFICATION-FILTERS: "PRISMS to report" lists it; "Needs placement" lists an Enrolled application whose placement did not go through
  await page.goto("/admin/qualifications?task=prisms");
  await expect(page.getByTestId("filter-prisms")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("qualifications-table").getByRole("row").filter({ hasText: `ZZQ${tag.slice(-4)}` })).toContainText("Deferred");
  sql(`insert into public.qualification_tasks(kind, application_id, student_id, title, detail) values ('place_manually', '${app}', '${student}', 'Place student manually', 'ZZ placement check ${tag}')`);
  await page.goto("/admin/qualifications?task=place");
  await expect(page.getByTestId("waiting-placement-item").filter({ hasText: `ZZ placement check ${tag}` })).toContainText("Zz Quentin");
  await expect(page.getByTestId("qualifications-table").getByRole("row").filter({ hasText: `ZZQ${tag.slice(-4)}` })).toHaveCount(0);
  // QUALIFICATION-BRIEF: an Admin edits commencement and expected completion; the change is in the history
  await page.goto(`/admin/qualifications/${qid}`);
  await page.getByTestId("qualification-edit-dates").click();
  await page.getByTestId("qualification-dates-start").fill(inDays(45));
  await page.getByTestId("qualification-dates-end").fill(inDays(320));
  await page.getByTestId("qualification-dates-save").click();
  await expect(page.getByTestId("qualification-history")).toContainText("Dates changed");
  expect(sql(`select course_start_date::text || '/' || course_end_date::text from public.intake_enrolments where id = '${qid}'`)).toBe(`${inDays(45)}/${inDays(320)}`);

  // The student's Qualification tab and the application's card.
  await page.goto(`/admin/students/${student}`);
  await page.getByRole("button", { name: "Qualification" }).click();
  await expect(page.getByTestId("student-qualifications")).toContainText("Deferred");
  await page.goto(`/admin/applications/${app}`);
  await expect(page.getByTestId("qualification-card")).toContainText("Deferred");
});

// MENU-PHONE (owner 2026-11-27): "Take action" opens as a bottom sheet on phones (title, every option in full, Cancel) and as a
// dropdown kept inside the viewport on desktop.
test.describe("Take action menu", () => {
  test.use({ deviceScaleFactor: 2 });
test("Take action: bottom sheet at 390px, dropdown inside the viewport at 1280px", async ({ page }) => {
  const admin = await createAdmin("menu-admin");
  const agency = sql(`insert into public.agencies(name, code, status) values ('ZZ Menu ${tag}', 'ZZM-${tag}', 'Active') returning id`).split("\n")[0];
  const app = sql(`insert into public.enrollment_applications(agency_id, status, student_name, student_email, data) values ('${agency}', 'draft', 'Zz Menu', 'zz.menu.${tag.toLowerCase()}@blackhole.postmarkapp.com', '{}'::jsonb) returning id`).split("\n")[0];
  // a submitted application (fixture: set directly, the signing flow is tested elsewhere)
  sql(`begin; set local session_replication_role = replica; update public.enrollment_applications set status = 'submitted', submitted_at = now() where id = '${app}'; commit;`);
  await signInAsAdmin(page, admin.email);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/applications/${app}`);
  await page.getByTestId("take-action").first().click();
  const sheet = page.getByTestId("take-action-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Take action" })).toBeVisible();
  await expect(sheet.getByTestId("take-action-cancel")).toBeVisible();
  const menu = page.getByTestId("take-action-menu");
  const box = await menu.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390 + 0.5).toBe(true);
  // every option is in full width inside the sheet (scrolling to each one)
  const items = menu.getByRole("menuitem");
  const count = await items.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    await items.nth(i).scrollIntoViewIfNeeded();
    const b = await items.nth(i).boundingBox();
    expect(b && b.x >= 0 && b.x + b.width <= 390 + 0.5).toBe(true);
  }
  await items.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/take-action-phone-390.png" });
  await sheet.getByTestId("take-action-cancel").click();
  await expect(sheet).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/admin/applications/${app}`);
  await page.getByTestId("take-action").first().click();
  await expect(page.getByTestId("take-action-sheet")).toHaveCount(0);
  const drop = page.getByTestId("take-action-menu");
  await expect(drop).toBeVisible();
  const d = await drop.boundingBox();
  expect(d && d.x >= 0 && d.y >= 0 && d.x + d.width <= 1280 && d.y + d.height <= 800).toBe(true);
  await page.screenshot({ path: "test-results/take-action-desktop-1280.png" });
});
});

// SIGNED-APPLICATION (owner 2026-11-27): after signing, the Review & signature tab shows the read-only Signed card (who and when, the drawn
// signature, the declarations in the wording agreed to, ticked) and the signed PDF; no IP or other signing certificate detail; the
// application is read-only for everyone (the database refuses changes).
test.describe("Signed application", () => {
  test.use({ deviceScaleFactor: 2 });
  test("student, agent and admin see the Signed card; nobody can change the answers", async ({ page }) => {
    test.setTimeout(180_000);
    const student = await createStudentLogin("signed-student");
    const agentWho = person("signed-agent");
    const agentAuth = await createAuthUser(agentWho.email);
    const agentProfile = sql(`insert into public.portal_profiles(auth_user_id, full_name, email, phone, status) values ('${agentAuth}', 'Zz Signed Agent', '${agentWho.email}', '${agentWho.local}', 'Active') returning id`).split("\n")[0];
    sql(`insert into public.agency_memberships(user_id, agency_id, role) values ('${agentProfile}', '${student.agency}', 'agent')`);
    // A drawn signature (a stroke on a canvas, as the signature box makes it).
    await page.goto("about:blank");
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 480; c.height = 140; const g = c.getContext("2d")!;
      g.lineWidth = 3; g.strokeStyle = "#1f2937"; g.beginPath(); g.moveTo(20, 100);
      for (let x = 20; x < 460; x += 6) g.lineTo(x, 70 + Math.sin(x / 18) * 30 + Math.cos(x / 7) * 8);
      g.stroke(); return c.toDataURL("image/png");
    });
    const app = sql(`insert into public.enrollment_applications(agency_id, student_id, student_name, student_email, status, data, reference, assigned_agent_id, created_by)
      values ('${student.agency}', '${student.student}', 'Zz Signer', '${student.email}', 'draft', '{"values": {"first_name": "Zz", "last_name": "Signer", "mobile": "0411111111"}}', 'ZZ-SIGN-${tag}', '${agentProfile}', '${agentProfile}') returning id`).split("\n")[0];
    const consents = sql(`insert into public.enrollment_application_consents(application_id, method, declaration_version, recorded_by_name, signer_role, declaration_key, text_version, text_hash, ip, user_agent)
      select '${app}', 'portal_signature', t.version, 'Zz Signer', 'student', t.key, t.version, t.hash, '203.0.113.77', 'ZZ-Agent/9.9' from public.application_declaration_texts t where t.active order by t.sort returning id`).split("\n").filter(Boolean);
    sql(`begin; set local session_replication_role = replica;
      update public.enrollment_applications set status = 'submitted', submitted_at = now(), version = 1 where id = '${app}';
      insert into public.application_signatures(application_id, signer_role, signer_name, png, ip, user_agent) values ('${app}', 'student', 'Zz Signer', '${png}', '203.0.113.77', 'ZZ-Agent/9.9');
      set local session_replication_role = origin;
      insert into public.enrollment_application_versions(application_id, version, snapshot)
        select '${app}', 1, a.data || jsonb_build_object('submission', jsonb_build_object('consentIds', '${JSON.stringify(consents)}'::jsonb, 'declarationVersion', '2026-11-25', 'actor', '${agentProfile}'))
        from public.enrollment_applications a where a.id = '${app}';
      commit;`);
    const firstDeclaration = sql(`select title from public.application_declaration_texts where active order by sort limit 1`);

    const check = async (who: string) => {
      await page.getByRole("button", { name: /Review & signature/ }).click();
      const card = page.getByTestId("signed-application");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("signed-by")).toContainText("Signed by Zz Signer on");
      await expect(card.getByTestId("signed-student").getByRole("img")).toBeVisible();
      await expect(card.getByTestId("signed-declarations")).toContainText(firstDeclaration);
      await expect(card.getByTestId("signed-declaration-text").first()).not.toBeEmpty();
      for (const box of await card.getByRole("checkbox").all()) { await expect(box).toBeChecked(); await expect(box).toBeDisabled(); }
      await expect(card).not.toContainText("203.0.113.77");
      await expect(card).not.toContainText("ZZ-Agent");
      const download = page.waitForEvent("download");
      await card.getByTestId("signed-download").click();
      expect((await download).suggestedFilename()).toBe(`signed-application-ZZ-SIGN-${tag}.pdf`);
      await page.setViewportSize({ width: 1280, height: 1400 });
      await page.getByRole("button", { name: /Review & signature/ }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `test-results/signed-${who}.png` });
    };

    await signInThroughTheForm(page, student.email);
    await expect(page).toHaveURL(/\/agency/, { timeout: 30_000 });
    await page.goto(`/agency/applications/${app}`);
    await check("student");
    await signOutEverywhere(page);

    await signInThroughTheForm(page, agentWho.email);
    await expect(page).toHaveURL(/\/agency/, { timeout: 30_000 });
    await page.goto(`/agency/applications/${app}`);
    await check("agent");
    await signOutEverywhere(page);

    const admin = await createAdmin("signed-admin");
    await signInAsAdmin(page, admin.email);
    await page.goto(`/admin/applications/${app}`);
    await expect(page.getByRole("button", { name: /Document upload wizard/ })).toHaveCount(0);
    await check("admin");
    // APPLICATION-FORM-TEMPLATES: the signed copy says which form printed it (recorded when the version was saved).
    await expect(page.getByTestId("signed-form-template")).toContainText("Application for Enrolment (standard)");
    // HOUSE-STYLE: the staff PDF button prints the same designed form.
    const pdf = page.waitForEvent("download");
    await page.getByRole("button", { name: "PDF", exact: true }).click();
    const file = await pdf;
    expect(file.suggestedFilename()).toMatch(/^application-ZZ-SIGN-/);
    const bytes = await (await import("node:fs")).promises.readFile(await file.path());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(20_000); // the designed form (letterhead, sections, signature), not the plain layout
    // Nobody changes a signed application's answers (the database refuses it, whoever writes).
    expect(() => sql(`update public.enrollment_applications set data = jsonb_set(data, '{values,preferred_intake}', '"Jan 2030"') where id = '${app}'`)).toThrow(/signed, so it cannot be changed/);
  });
});

// APPLICATION-FORM-TEMPLATES (owner 2026-11-27): Documents & Signatures › Templates holds the Application form (the standard one is the
// default); the editor previews it with a sample application as a PDF; staff make another one the default.
test.describe("Application form templates", () => {
  test.use({ deviceScaleFactor: 2 });
  test("the standard form is the default; preview with a sample application; make another default", async ({ page }) => {
    test.setTimeout(180_000);
    // re-runnable: copies made by an earlier run of this test are removed (lab data only)
    sql(`delete from hr.sign_template_versions where template_id in (select id from hr.sign_templates where category = 'application_form' and name like '%(standard) (copy)%');
      delete from hr.sign_templates where category = 'application_form' and name like '%(standard) (copy)%';
      update hr.sign_templates set is_default = (id = 'a9f0e000-0000-4000-8000-000000000001') where category = 'application_form';`);
    const admin = await createAdmin("afm-admin");
    await signInAsAdmin(page, admin.email);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin/signing/templates");
    const row = page.getByTestId("sign-template-row").filter({ hasText: "Application for Enrolment (standard)" }).filter({ hasNotText: "(copy)" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("application-form-default")).toHaveText("Default");
    await page.screenshot({ path: "test-results/afm-templates.png" });
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByTestId("application-form-help")).toBeVisible();
    await page.screenshot({ path: "test-results/afm-editor.png" });
    await page.getByTestId("application-form-preview-sample").click();
    await expect(page.getByText("Template preview (PDF)")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/afm-preview.png" });
    await page.keyboard.press("Escape");
    // A copy, made the default: newly signed applications print with it; the standard one is no longer the default.
    await page.goto("/admin/signing/templates");
    await row.getByRole("button", { name: "Duplicate" }).click();
    const copy = page.getByTestId("sign-template-row").filter({ hasText: "(standard) (copy)" });
    await copy.getByTestId("application-form-make-default").click();
    await expect(copy.getByTestId("application-form-default")).toHaveText("Default");
    expect(sql(`select count(*) from hr.sign_templates where category = 'application_form' and is_default and deleted_at is null`)).toBe("1");
    // back to the standard one for the other tests
    await row.getByTestId("application-form-make-default").click();
    await expect(row.getByTestId("application-form-default")).toBeVisible();
  });
});
