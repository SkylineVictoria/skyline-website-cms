import { expect, test } from "@playwright/test";
import { createAdmin, inDays, signInAsAdmin, sql } from "./support";

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
