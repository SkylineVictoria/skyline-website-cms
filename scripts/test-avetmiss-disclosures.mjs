import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const modulePath = process.env.SLIT_RULES_TEST_PGLITE;
const { PGlite } = await import(modulePath ? pathToFileURL(modulePath).href : "@electric-sql/pglite");
const db = new PGlite();

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema skyline_private;
    create table public.avetmiss_codes(code_set text, code text, is_active boolean);
    insert into public.avetmiss_codes values
      ('disability_type', '11', true), ('disability_type', '12', true), ('disability_type', '99', true),
      ('disability_type', '98', false), ('prior_education', '008', true), ('prior_education', '410', true),
      ('prior_education_recognition', 'A', true), ('prior_education_recognition', 'I', true),
      ('english_proficiency', '2', true), ('language', '5203', true), ('language', '1201', true), ('language', '0001', false),
      ('country', '1101', true), ('study_reason', '12', true);
    create table public.enrollment_students(
      id uuid primary key, details jsonb not null default '{}', qualifications jsonb not null default '[]',
      disability_flag text, prior_education_flag text, english_proficiency_code text,
      sex_code text, birth_country_code text, home_language_code text, indigenous_status_code text,
      school_level_code text, at_school_flag text, labour_force_code text
    );
    create table public.enrollment_applications(
      id uuid primary key, student_id uuid references public.enrollment_students,
      data jsonb not null default '{"values":{}}', status text not null default 'draft', tenant_id uuid
    );
    create table public.student_disabilities(
      student_id uuid references public.enrollment_students, disability_type_code text,
      primary key(student_id, disability_type_code)
    );
    create table public.student_prior_education(
      student_id uuid references public.enrollment_students, prior_education_code text,
      recognition_code text, qualification_name text, primary key(student_id, prior_education_code, recognition_code)
    );
    create function public.student_values(jsonb) returns jsonb language sql as $$
      select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each($1)
      where key in ('disability', 'prior_ed', 'english_proficiency_code', 'first_name')
    $$;
    create function public.application_only_values(jsonb) returns jsonb language sql as $$
      select $1 - array['disability', 'prior_ed', 'english_proficiency_code', 'first_name']
    $$;
    create function public.student_apply_details(uuid, jsonb, jsonb) returns void language sql as $$
      update public.enrollment_students set details = details || $2, qualifications = coalesce($3, qualifications) where id = $1
    $$;
    create function public.avetmiss_code(text, text) returns text language sql stable as $$
      select case lower($2) when 'australia' then '1101' when 'for personal interest or self-development' then '12'
        else (select code from public.avetmiss_codes where code_set = $1 and code = $2) end
    $$;
    create function public.portal_required_schema() returns jsonb language sql as $$
      select '[{"fields":[{"name":"birth_country","type":"select","options":["Old Country"]},
        {"name":"study_reason","type":"select","options":["Old Reason"]}]}]'::jsonb
    $$;
    create function public.portal_condition_met(jsonb, jsonb) returns boolean language sql as $$ select true $$;
    create function public.admissions_field_optional(text) returns boolean language sql as $$ select false $$;
    create function public.application_intake_problem(uuid) returns text language sql as $$ select null::text $$;
    create function public.rule_bool(text, boolean) returns boolean language sql as $$ select $2 $$;
    create table public.enrollment_application_courses(application_id uuid, course_id text);
    create table public.cms_courses(id text, tenant_id uuid, status text);
    create table public.application_usi(application_id uuid);

  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261125054517_avetmiss_application_disclosures.sql", import.meta.url), "utf8"));
  await db.exec(`
    create trigger b_route_student_fields before update of data on public.enrollment_applications
    for each row execute function public.application_route_student_fields();
  `);
  const id = (id) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
  const save = (application, values) =>
    db.query("update public.enrollment_applications set data = jsonb_build_object('values', $2::jsonb) where id = $1",
      [id(application), JSON.stringify(values)]);
  const submit = (application) =>
    db.query("update public.enrollment_applications set status = 'submitted' where id = $1", [id(application)]);
  const student = async (number) => (await db.query(`
    select disability_flag, prior_education_flag, english_proficiency_code,
      array(select disability_type_code from public.student_disabilities where student_id = s.id order by 1) as types,
      array(select prior_education_code || recognition_code from public.student_prior_education where student_id = s.id order by 1) as prior
    from public.enrollment_students s where id = $1`, [id(number)])).rows[0];
  const permissions = (await db.query(`
    select has_function_privilege('authenticated', 'skyline_private.avetmiss_apply_application_disclosures()', 'EXECUTE') as can_execute
  `)).rows[0];
  assert.equal(permissions.can_execute, false);
  console.log("PASS authenticated users cannot execute the privileged trigger function directly");
  for (const number of [1, 2, 3, 4, 5, 6, 7]) {
    if (number < 7) await db.query("insert into public.enrollment_students(id) values ($1)", [id(number)]);
    await db.query("insert into public.enrollment_applications(id, student_id) values ($1, $2)", [id(number), id(number === 7 ? 1 : number)]);
  }

  const validate = (application) => db.query("select public.portal_validate_submission($1)", [id(application)]);
  const reported = { birth_country: "Australia", study_reason: "For personal interest or self-development",
    language_home: "Yes, language other than English", language_other: "5203" };
  await save(1, reported);
  await validate(1);
  for (const language_other of ["0001", "1201", "invented", ""]) {
    await save(1, { ...reported, language_other });
    await assert.rejects(validate(1), { code: "22023", message: /valid language/ });
  }
  await save(1, { ...reported, birth_country: "invented" });
  await assert.rejects(validate(1), { code: "22023", message: /birth_country/ });
  console.log("PASS submission accepts active references and rejects wrong, retired and missing languages");

  const qualifications = JSON.stringify([{ code: "008", recognition: "I", name: "Degree" }, { code: "410", recognition: "A", name: "" }]);
  await save(1, { first_name: "Synthetic", disability: "Yes", disability_types: "12,11,11", prior_ed: "Yes",
    prior_education: qualifications, english_proficiency_code: "2" });
  assert.deepEqual(await student(1), { disability_flag: null, prior_education_flag: null, english_proficiency_code: null, types: [], prior: [] });
  const draft = (await db.query("select public.application_values($1) as answers", [id(1)])).rows[0].answers;
  assert.equal(draft.first_name, "Synthetic");
  assert.equal(draft.disability_types, "12,11,11");
  assert.equal(draft.disability, "Yes");
  await submit(1);
  assert.deepEqual(await student(1), { disability_flag: "Y", prior_education_flag: "Y", english_proficiency_code: "2",
    types: ["11", "12"], prior: ["008I", "410A"] });
  console.log("PASS draft save and resume, deduplication, multiple qualifications, international recognition and submission");

  await save(7, { disability: "No", disability_types: "12,11", prior_ed: "No", prior_education: qualifications, english_proficiency_code: "" });
  await submit(7);
  assert.deepEqual(await student(1), { disability_flag: "N", prior_education_flag: "N", english_proficiency_code: null, types: [], prior: [] });
  assert.equal((await db.query("select public.application_values($1) as answers", [id(1)])).rows[0].answers.disability, "Yes");
  console.log("PASS Yes to No clears reporting records and keeps the older application answer");

  await save(2, { disability: "Yes", disability_types: "" });
  await submit(2);
  assert.deepEqual((await student(2)).types, ["99"]);
  await db.query("update public.enrollment_applications set status = 'action_required' where id = $1", [id(2)]);
  await save(2, { disability: "Yes", disability_types: "11" });
  await submit(2);
  assert.deepEqual((await student(2)).types, ["11"]);
  console.log("PASS undisclosed type maps to 99 and resubmission replaces it");

  await save(3, { disability: "Yes", disability_types: "98" });
  await assert.rejects(submit(3), { code: "22023" });
  await save(4, { disability: "Yes", disability_types: "99,11" });
  await assert.rejects(submit(4), { code: "22023" });
  await save(5, { disability: "Yes", disability_types: "12", prior_ed: "Yes", prior_education: "{}" });
  await assert.rejects(submit(5), { code: "22023" });
  assert.deepEqual((await student(5)).types, []);
  console.log("PASS retired and inconsistent classifications are rejected and a later error rolls back earlier writes");

  await db.exec(`alter table public.student_disabilities add check (student_id <> '${id(6)}')`);
  await save(6, { disability: "Yes", disability_types: "11" });
  await assert.rejects(submit(6), { code: "23514" });
  assert.equal((await student(6)).disability_flag, null);
  const app = (await db.query("select status from public.enrollment_applications where id = $1", [id(6)])).rows[0];
  assert.equal(app.status, "draft");
  console.log("PASS failed database write leaves the reporting record and application status unchanged");

  const readiness = (await db.query("select public.avetmiss_student_missing($1) as missing", [id(6)])).rows[0].missing;
  assert(readiness.includes("language spoken at home"));
  assert(!readiness.some((label) => /English/.test(label)));
  const canInspect = (await db.query(`
    select has_function_privilege('authenticated', 'public.avetmiss_student_missing(uuid)', 'EXECUTE') as allowed
  `)).rows[0].allowed;
  assert.equal(canInspect, false);
  console.log("PASS reporting readiness omits English proficiency and is unavailable as a public RPC");

} finally {
  await db.close();
}
