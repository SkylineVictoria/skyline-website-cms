begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- Assessment Management (ASM-01): tenant isolation, student ownership, trainer scope, publication permission, evidence policy,
-- assessor-key leakage, locked attempts, history preservation, sign-off authority, audit, concurrency, tampered ids, versioning,
-- validation, auto-check suggestions, calendar and batch reassignment. Fixtures only; rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(538);

-- ---------------------------------------------------------------- fixtures
create temp table t(k text primary key, v text);
grant all on t to public;
create function pg_temp.v(text) returns uuid language sql stable as $$ select v::uuid from t where k = $1 $$;
create function pg_temp.s(text) returns text language sql stable as $$ select v from t where k = $1 $$;
create function pg_temp.put(text, text) returns void language sql as $$ insert into t values ($1, $2) on conflict (k) do update set v = excluded.v $$;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a5000000-0000-0000-0000-000000000001', 'asm.admin@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000002', 'asm.editor@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000003', 'asm.trainer.a@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000004', 'asm.trainer.b@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000011', 'asm.student1@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000012', 'asm.student2@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a5000000-0000-0000-0000-000000000013', 'asm.student3@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password, rto_manager) values
 ('asm-admin', 'Asm Admin', 'asm.admin@example.test', 'Admin', 'Active', 'a5000000-0000-0000-0000-000000000001', false, true),
 ('asm-editor', 'Asm Editor', 'asm.editor@example.test', 'Editor', 'Active', 'a5000000-0000-0000-0000-000000000002', false, false);
alter table hr.staff_profiles disable trigger staff_status_guard;
insert into hr.staff_profiles(id, auth_user_id, first_name, last_name, email, phone_e164, status) values
 ('b5000000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-000000000003', 'Tara', 'Trainer', 'asm.trainer.a@example.test', '+61400005003', 'active'),
 ('b5000000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-000000000004', 'Tom', 'Trainer', 'asm.trainer.b@example.test', '+61400005004', 'active');
alter table hr.staff_profiles enable trigger staff_status_guard;
insert into hr.staff_roles(profile_id, role, granted_by) values ('b5000000-0000-0000-0000-000000000003', 'trainer', 'a5000000-0000-0000-0000-000000000001');
insert into public.agencies(id, name, code) values ('c5000000-0000-0000-0000-000000000001', 'ASM Agency', 'ASM-AG');
-- fixture (migration 20261117220000): an uploaded signed agreement makes the Active fixture businesses operational
insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture-agreement.pdf', 'fixtures/' || a.id::text || '/agreement.pdf' from public.agencies a where a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none' and not exists (select 1 from public.business_documents d where d.business_id = a.id);
insert into public.portal_profiles(id, auth_user_id, full_name, email) values
 ('d5000000-0000-0000-0000-000000000011', 'a5000000-0000-0000-0000-000000000011', 'Sam Student', 'asm.student1@example.test'),
 ('d5000000-0000-0000-0000-000000000012', 'a5000000-0000-0000-0000-000000000012', 'Sue Student', 'asm.student2@example.test'),
 ('d5000000-0000-0000-0000-000000000013', 'a5000000-0000-0000-0000-000000000013', 'Sid Student', 'asm.student3@example.test');
insert into public.enrollment_students(id, agency_id, full_name, email) values
 ('e5000000-0000-0000-0000-000000000011', 'c5000000-0000-0000-0000-000000000001', 'Sam Student', 'asm.student1@example.test'),
 ('e5000000-0000-0000-0000-000000000012', 'c5000000-0000-0000-0000-000000000001', 'Sue Student', 'asm.student2@example.test'),
 ('e5000000-0000-0000-0000-000000000013', 'c5000000-0000-0000-0000-000000000001', 'Sid Student', 'asm.student3@example.test');
insert into public.agency_memberships(user_id, agency_id, role, student_id) values
 ('d5000000-0000-0000-0000-000000000011', 'c5000000-0000-0000-0000-000000000001', 'student', 'e5000000-0000-0000-0000-000000000011'),
 ('d5000000-0000-0000-0000-000000000012', 'c5000000-0000-0000-0000-000000000001', 'student', 'e5000000-0000-0000-0000-000000000012'),
 ('d5000000-0000-0000-0000-000000000013', 'c5000000-0000-0000-0000-000000000001', 'student', 'e5000000-0000-0000-0000-000000000013');
-- A course is published only when reportable (20261126124153: code, field of education, ANZSCO code, qualification level, delivery mode)
-- with an active unit and an open intake (cms_courses_needs_intake): inserted as Draft and published once its unit and intakes exist.
insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level) values ('course-asm-test', 'asm-test-course', 'ASM101', 'ASM Test Course', 'Draft', 'Face to Face', '0403', '331212', 'Certificate III');
insert into public.cms_course_units(id, course_id, code, name) values ('unit-asm-1', 'course-asm-test', 'ASMU1', 'Work safely'), ('unit-asm-2', 'course-asm-test', 'ASMU2', 'Use tools');
insert into public.course_intakes(id, course_id, start_date, end_date, label) values ('f5000000-0000-0000-0000-000000000001', 'course-asm-test', date '2026-01-05', date '2026-12-18', 'Jan 2026');
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('f5000000-0000-0000-0000-000000000001', 'unit-asm-1', date '2026-01-05', date '2026-12-18');
-- INTAKE-REPLACES-BATCH (2026-11-19): an intake is the class group; G1 and G2 are two intakes of the course (the ids the batches had)
insert into public.course_intakes(id, course_id, start_date, end_date, label) values
 ('f5000000-0000-0000-0000-000000000011', 'course-asm-test', date '2026-01-05', date '2026-12-18', 'G1'),
 ('f5000000-0000-0000-0000-000000000012', 'course-asm-test', date '2026-01-05', date '2026-12-18', 'G2');
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values
 ('f5000000-0000-0000-0000-000000000011', 'unit-asm-1', date '2026-01-05', date '2026-12-18'), ('f5000000-0000-0000-0000-000000000012', 'unit-asm-1', date '2026-01-05', date '2026-12-18');
insert into public.intake_trainers(intake_id, staff_id) values ('f5000000-0000-0000-0000-000000000011', 'b5000000-0000-0000-0000-000000000003'), ('f5000000-0000-0000-0000-000000000012', 'b5000000-0000-0000-0000-000000000004');
-- placements are made by the system only (guard intake_enrolments_auto_only, 20261118180000): the fixture places its students as the
-- system's planner does, for this insert only
update public.cms_courses set status = 'Published' where id = 'course-asm-test';
select set_config('rto.carry_over_planning', 'on', true);
-- AVETMISS (hosted 20261125025533, 20261126124153) refuses an enrolment without the student's AVETMISS details: the fixture students have them.
update public.enrollment_students set sex_code = 'M', birth_country_code = '1101', home_language_code = '1201', indigenous_status_code = '4',
  school_level_code = '12', school_level_year = '2017', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N',
  details = coalesce(details, '{}'::jsonb) || jsonb_build_object('first_name', split_part(full_name, ' ', 1), 'last_name', split_part(full_name, ' ', 2))
    || '{"dob": "2000-01-01", "usi_number": "ABCDE12345", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC"}'::jsonb
 where id in ('e5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000012', 'e5000000-0000-0000-0000-000000000013');
insert into public.intake_enrolments(intake_id, student_id, study_reason_code) values
 ('f5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000011', '01'), ('f5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000013', '01'),
 ('f5000000-0000-0000-0000-000000000012', 'e5000000-0000-0000-0000-000000000012', '01');
select set_config('rto.carry_over_planning', '', true);
-- a second institution with its own course (tenant isolation)
insert into public.tenants(id, slug, name) values ('15000000-0000-0000-0000-000000000002', 'asm-other', 'Other Institute');
insert into public.cms_courses(id, slug, code, name, status, tenant_id, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level) values ('course-asm-other', 'asm-other-course', 'ASM202', 'Other Course', 'Draft', '15000000-0000-0000-0000-000000000002', 'Face to Face', '0403', '331212', 'Certificate III');

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claim.sub', p::text, true); end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
-- ASM-PDF-TEMPLATE phase 4 (2026-11-26): an assessment is its workbook PDF template. The fixture's workbook: task 1 with Q1 and Q2,
-- task 2 with Q1 (keys 1.1, 1.2, 2.1, as printed), one answer box each (all required), the trainer's Yes / No per question.
create function pg_temp.tplmain(p_path text) returns jsonb language sql immutable as $$
 select jsonb_build_object('version', 1, 'pdf', jsonb_build_object('path', p_path, 'sha256', repeat('c', 64), 'pages', 3, 'fileName', 'work-safely.pdf'),
  'pages', '[{"page":1,"kind":"cover","audience":"student","task":null},{"page":2,"kind":"question","audience":"student","task":1},{"page":3,"kind":"question","audience":"student","task":2}]'::jsonb,
  'tasks', '[{"number":"1","title":"Knowledge questions","firstPage":2,"lastPage":2},{"number":"2","title":"Practical","firstPage":3,"lastPage":3}]'::jsonb,
  'declarations', '[]'::jsonb,
  'questions', '[{"key":"1.1","seq":"Q1","label":"Describe the PPE you wear","task":1,"header":{"page":2,"x":0.07,"y":0.1,"w":0.86,"h":0.05},"areas":[{"page":2,"x":0.07,"y":0.15,"w":0.86,"h":0.3}]},
   {"key":"1.2","seq":"Q2","label":"Is it safe to work on a live circuit?","task":1,"header":{"page":2,"x":0.07,"y":0.5,"w":0.86,"h":0.05},"areas":[{"page":2,"x":0.07,"y":0.55,"w":0.86,"h":0.3}]},
   {"key":"2.1","seq":"Q1","label":"Isolate the power and report","task":2,"header":{"page":3,"x":0.07,"y":0.1,"w":0.86,"h":0.05},"areas":[{"page":3,"x":0.07,"y":0.15,"w":0.86,"h":0.3}]}]'::jsonb,
  'fields', '[{"id":"s11","page":2,"x":0.08,"y":0.16,"w":0.84,"h":0.28,"role":"student","kind":"text","questionKey":"1.1","label":"Answer"},
   {"id":"s12","page":2,"x":0.08,"y":0.56,"w":0.84,"h":0.28,"role":"student","kind":"text","questionKey":"1.2","label":"Answer"},
   {"id":"s21","page":3,"x":0.08,"y":0.16,"w":0.84,"h":0.28,"role":"student","kind":"text","questionKey":"2.1","label":"Answer"},
   {"id":"t11y","page":2,"x":0.8,"y":0.11,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":"1.1","label":"Satisfactory","option":"yes","group":"q.1.1"},
   {"id":"t11n","page":2,"x":0.85,"y":0.11,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":"1.1","label":"Satisfactory","option":"no","group":"q.1.1"},
   {"id":"a1","page":1,"x":0.3,"y":0.88,"w":0.6,"h":0.03,"role":"auto","kind":"auto","questionKey":null,"label":"Student Name","dataKey":"student_name"}]'::jsonb,
  'detected', '{"by":"asm-pdf-detect/1","at":"2026-11-26T00:00:00Z"}'::jsonb);
$$;
-- every question marked (Q2 of task 1 as given, the rest S): a task's result is worked out from its questions (asm_task_results_auto)
create function pg_temp.all_marks(p_q12 text) returns jsonb language sql immutable as $$
 select jsonb_build_array(jsonb_build_object('questionId', '1.1', 'outcome', 'S'), jsonb_build_object('questionId', '1.2', 'outcome', p_q12), jsonb_build_object('questionId', '2.1', 'outcome', 'S')) $$;
create function pg_temp.responses() returns jsonb language sql immutable as $$
 select '{"pdf":{"s11":"Gloves and safety glasses protect hands and eyes","s12":"No: isolate it first","s21":"Isolated the power and reported it"},"pdfChoice":{}}'::jsonb $$;

-- ---------------------------------------------------------------- unit elements and the assessment (admin)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_admin('me')->>'assessmentAdmin')::boolean, true, 'an Admin with the RTO Manager flag manages assessments');
select pg_temp.put('elements', (public.asm_admin('unit_elements_save', jsonb_build_object('unitId', 'unit-asm-1', 'items', '[{"kind":"element","code":"1","text":"Prepare for work"},{"kind":"performance_criterion","code":"1.1","text":"Select PPE"},{"kind":"knowledge_evidence","code":"KE1","text":"Types of PPE"}]'::jsonb)))::text);
select is(jsonb_array_length(pg_temp.s('elements')::jsonb), 3, 'unit elements, criteria and knowledge evidence are rows on the unit');
select pg_temp.put('el_pc', (select v->>'id' from jsonb_array_elements(pg_temp.s('elements')::jsonb) v where v->>'code' = '1.1'));
select pg_temp.put('el_ke', (select v->>'id' from jsonb_array_elements(pg_temp.s('elements')::jsonb) v where v->>'code' = 'KE1'));
select pg_temp.put('el_e', (select v->>'id' from jsonb_array_elements(pg_temp.s('elements')::jsonb) v where v->>'code' = '1'));

select pg_temp.put('assessment', (public.asm_admin('assessment_create', jsonb_build_object('courseId', 'course-asm-test', 'unitId', 'unit-asm-1', 'code', 'ASMU1-A1', 'title', 'Work safely: knowledge and practical')))::jsonb->>'id');
select ok(pg_temp.v('assessment') is not null, 'an assessment is created on course > unit');
select is((select count(*)::int from public.asm_versions where assessment_id = pg_temp.v('assessment') and status = 'draft'), 1, 'it starts with one draft version');
select is((select tenant_id from public.asm_assessments where id = pg_temp.v('assessment')), null, 'the legacy course binds the legacy (null) tenant');

-- the workbook PDF template: the file under the assessment, then the template on the draft (no PDF, no publishing)
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment'))))->'errors'->0->>'message', 'Upload the workbook PDF before publishing.', 'P4 nothing publishes without the workbook PDF');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-templates', '%s/%s.pdf')$$, pg_temp.v('assessment'), repeat('c', 64)), 'the admin uploads the workbook PDF');
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, pg_temp.tplmain(pg_temp.s('assessment') || '/' || repeat('c', 64) || '.pdf')))->>'ok', 'true', 'the workbook PDF template saves on the draft');
select pg_temp.put('draft', (public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'),
  'mappings', jsonb_build_array(jsonb_build_object('questionId', '1.1', 'elementId', pg_temp.v('el_pc')), jsonb_build_object('questionId', '1.2', 'elementId', pg_temp.v('el_ke'))))))::text);
select throws_ok(format($$select public.asm_admin('draft_save', '{"assessmentId": "%s", "mappings": [{"questionId": "q_short", "elementId": "%s"}]}')$$, pg_temp.v('assessment'), pg_temp.v('el_pc')), '22023', 'Question q_short is not in the workbook PDF', 'P4 the mapping is keyed by the workbook''s printed question numbers');
select is((pg_temp.s('draft')::jsonb->>'ok')::boolean, true, 'the unit mapping saves, keyed by the printed question numbers');
select pg_temp.put('v1', pg_temp.s('draft')::jsonb->>'versionId');
select is((select count(*)::int from public.asm_unit_mappings where version_id = pg_temp.v('v1')), 2, 'the mapping rows are on the draft');
select is(jsonb_array_length(public.asm_admin('coverage', jsonb_build_object('versionId', pg_temp.v('v1')))->'gaps'), 1, 'coverage shows the unmapped element as a gap');
select is(public.asm_admin('coverage', jsonb_build_object('versionId', pg_temp.v('v1')))->'unmappedQuestions', '["2.1"]'::jsonb, 'P4 coverage lists the workbook questions not mapped yet');

-- ASM-ANY-LAYOUT (20261127170517): a field set by AI waits for the admin's Accept / Reject before Publish; layout profiles; AI usage
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, jsonb_set(pg_temp.tplmain(pg_temp.s('assessment') || '/' || repeat('c', 64) || '.pdf'), '{fields,0,review}', '"pending"')))->>'ok', 'true', 'ANY a template with a pending AI field saves (the admin reviews it later)');
select is((public.asm_admin('assessment_get', jsonb_build_object('id', pg_temp.v('assessment')))->'editing'->>'aiPending')::int, 1, 'ANY the editing summary counts the AI fields waiting for review');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment'))))->'errors'->0->>'code', 'ai_pending', 'ANY Publish waits until every AI field is accepted or rejected');
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, pg_temp.tplmain(pg_temp.s('assessment') || '/' || repeat('c', 64) || '.pdf')))->>'ok', 'true', 'ANY reviewed: the template saves again without pending fields');
select is(jsonb_array_length(public.asm_layout_profile_save(repeat('a', 64), '["unit code: #"]', '[{"key":"cell|student name|||#1","set":{"role":"auto","kind":"auto","dataKey":"student_name"}},{"key":"tick|by hand||||#1","set":null}]', pg_temp.v('assessment')::uuid)->'corrections'), 2, 'ANY an admin saves a layout profile (two decisions)');
select pg_temp.put('profile2', public.asm_layout_profile_save(repeat('a', 64), '[]', '[{"key":"tick|by hand||||#1","set":{"role":"trainer","kind":"checkbox"}},{"key":"cell|notes|||#1","set":null}]', pg_temp.v('assessment')::uuid)::text);
select is((select string_agg(c->>'key', ',' order by c->>'key') from jsonb_array_elements(pg_temp.s('profile2')::jsonb->'corrections') c)
  || '/' || (select c->'set'->>'kind' from jsonb_array_elements(public.asm_layout_profile_get(repeat('a', 64))->'corrections') c where c->>'key' = 'tick|by hand||||#1'),
  'cell|notes|||#1,cell|student name|||#1,tick|by hand||||#1/checkbox', 'ANY a later save merges: a new decision for the same area replaces the old one, the others stay');
select is(public.asm_ai_usage_summary(pg_temp.v('assessment')::uuid)->>'limitUsd', '2', 'ANY the AI usage of a workbook is reported with its US$2 limit');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select throws_ok($$select public.asm_layout_profile_get(repeat('a', 64))$$, '42501', null, 'ANY layout profiles are for Admins and RTO Managers only');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');

-- publishing freezes the version
select throws_ok(format($$select public.asm_admin('version_publish', '{"assessmentId": "%s"}')$$, '00000000-0000-0000-0000-000000000000'), 'P0002', null, 'publishing an unknown assessment fails');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment')))->>'ok')::boolean, true, 'the draft publishes');
select is((select status from public.asm_versions where id = pg_temp.v('v1')), 'published', 'version 1 is published');
select is((select checksum from public.asm_versions where id = pg_temp.v('v1')), (select encode(sha256(convert_to(template::text, 'UTF8')), 'hex') from public.asm_versions where id = pg_temp.v('v1')), 'the checksum is the sha-256 of the workbook PDF template');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_versions set template = jsonb_set(template, '{tasks,0,title}', '"changed"') where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published workbook template cannot be changed, even by the database owner');
select throws_ok(format($$update public.asm_versions set status = 'draft' where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published version cannot go back to draft');
select throws_ok(format($$delete from public.asm_versions where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published version cannot be deleted');

-- editing after publish creates version 2 as a draft, version 1 stays published
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.put('draft2', (public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'))))::text);
select is((pg_temp.s('draft2')::jsonb->>'versionNo')::int, 2, 'an edit after publishing opens version 2 as a draft');
select pg_temp.put('v2', pg_temp.s('draft2')::jsonb->>'versionId');
select is((select (template is not null)::text || ':' || (select count(*) from public.asm_unit_mappings m where m.version_id = v.id) from public.asm_versions v where id = pg_temp.v('v2')), 'true:2', 'the new draft inherits the workbook PDF template and the mapping');
select is((select status from public.asm_versions where id = pg_temp.v('v1')), 'published', 'version 1 is still published');
select throws_ok(format($$select public.asm_admin('draft_save', '{"assessmentId": "%s", "expectedUpdatedAt": "2000-01-01T00:00:00Z"}')$$, pg_temp.v('assessment')), '40001', null, 'a stale draft save is refused (concurrency)');

-- ---------------------------------------------------------------- permissions on the admin surface
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.asm_admin('assessment_list')$$, '42501', null, 'an Editor cannot use the assessment admin');
select is((select count(*)::int from public.asm_assessments), 0, 'an Editor reads no assessment rows');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok($$select public.asm_admin('assessment_list')$$, '42501', null, 'a student cannot use the assessment admin');
select throws_ok($$select public.asm_trainer('my_assignments')$$, '42501', null, 'a student is not a trainer');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select throws_ok($$select public.asm_admin('assessment_list')$$, '42501', null, 'a trainer cannot use the assessment admin');
select throws_ok($$select public.asm_student('my_assessments')$$, '42501', null, 'a trainer is not a student');
select is((select count(*)::int from public.asm_assessments), 0, 'before any assignment a trainer reads no assessment');

-- ---------------------------------------------------------------- assignment to a batch (brief section 7)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select throws_ok(format($$select public.asm_admin('assignment_create', '{"assessmentId": "%s", "batchIds": ["f5000000-0000-0000-0000-00000000ffff"], "dueAt": "2026-12-01T06:00:00Z"}')$$, pg_temp.v('assessment')), '23503', null, 'a batch that is not on the course is refused');
select pg_temp.put('assign', (public.asm_admin('assignment_create', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'batchIds', '["f5000000-0000-0000-0000-000000000011"]'::jsonb, 'dueAt', (now() + interval '10 days')::text,
  'events', jsonb_build_array(jsonb_build_object('kind', 'practical', 'title', 'Workshop observation', 'startsAt', (now() + interval '5 days')::text, 'endsAt', (now() + interval '5 days 2 hours')::text)))))::text);
select is((pg_temp.s('assign')::jsonb->>'created')::int, 1, 'the published version is assigned to batch G1');
select pg_temp.put('assignment', (select id::text from public.asm_assignments where version_id = pg_temp.v('v1') and intake_id = 'f5000000-0000-0000-0000-000000000011'));
select pg_temp.as_postgres();
select is((select array_agg(x order by x) from public.asm_assignment_eligible(pg_temp.v('assignment')) x), array['e5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000013']::uuid[], 'eligible students are the active enrolments of the batch');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_notifications where event = 'published' and recipient_role = 'student' and assignment_id = pg_temp.v('assignment')), 2, 'both students are told the assessment is published');
select is((select count(*)::int from public.asm_notifications where event = 'published' and recipient_role = 'trainer' and assignment_id = pg_temp.v('assignment')), 1, 'the batch trainer is told too');
select is((select count(*)::int from public.notification_deliveries d join public.asm_notifications n on n.id = d.assessment_event_id where n.assignment_id = pg_temp.v('assignment')), 3, 'each notification queued an email through the existing outbox');
select is((select count(*)::int from public.asm_schedule_events where assignment_id = pg_temp.v('assignment')), 2, 'the due date and the practical session are calendar events');

-- ---------------------------------------------------------------- the student completes it
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select is(jsonb_array_length(public.asm_student('my_assessments')), 0, 'a student of another batch sees nothing');
select throws_ok(format($$select public.asm_student('assessment_open', '{"assignmentId": "%s"}')$$, pg_temp.v('assignment')), '42501', null, 'a student of another batch cannot open it');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is(jsonb_array_length(public.asm_student('my_assessments')), 1, 'the enrolled student sees the assessment');
select pg_temp.put('open', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment'))))::text);
select pg_temp.put('attempt', pg_temp.s('open')::jsonb->'attempt'->>'id');
select is(pg_temp.s('open')::jsonb->'attempt'->>'state', 'draft', 'opening creates attempt 1 as a draft');
-- ASM-OPEN-RACE (20261123235517): a start returns the open attempt; one open attempt per student per assignment (the two-session
-- race itself runs in the lab e2e "ASM-OPEN-RACE", pgTAP has one session)
select is((public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment'))))->'attempt'->>'id', pg_temp.s('attempt'), 'open race: opening again returns the same open attempt');
select pg_temp.as_postgres();
select is(public.asm_start_attempt(pg_temp.v('assignment'), (select student_id from public.asm_attempts where id = pg_temp.v('attempt')), null)::text, pg_temp.s('attempt'), 'open race: a start while an attempt is open returns that attempt');
select throws_ok(format($$select public.asm_next_attempt('%s', '%s', now(), null, false)$$, pg_temp.v('assignment'), (select student_id from public.asm_attempts where id = pg_temp.v('attempt'))), '23505', 'The student already has an open attempt', 'open race: a staff reassessment still refuses a second open attempt');
select throws_ok(format($$insert into public.asm_attempts(assignment_id, version_id, student_id, attempt_no, due_at) select assignment_id, version_id, student_id, attempt_no + 1, due_at from public.asm_attempts where id = '%s'$$, pg_temp.v('attempt')), '23505', null, 'open race: the database refuses a second open attempt (asm_attempts_one_open)');
-- ASM-AI-IMPORT stage 3: signatures on an attempt (asm_sign / asm_signatures, migration 20261125120517)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is(public.asm_sign(pg_temp.v('attempt'), 'student_declaration', 'typed', null, 'I declare this work is my own.')->>'kind', 'student_declaration', 'SIG the student signs the declaration on a draft attempt');
select is((public.asm_sign(pg_temp.v('attempt'), 'student_declaration', 'typed', null, 'again')->>'statement'), 'I declare this work is my own.', 'SIG signing again returns the first signature (never replaced)');
select throws_ok(format($$select public.asm_sign('%s', 'student_acknowledgement', 'typed', null, '')$$, pg_temp.v('attempt')), '22023', null, 'SIG no acknowledgement before there are results');
select is(jsonb_array_length(public.asm_signatures(pg_temp.v('attempt'))), 1, 'SIG the student reads their own signatures');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select throws_ok(format($$select public.asm_sign('%s', 'student_declaration', 'typed', null, '')$$, pg_temp.v('attempt')), '42501', null, 'SIG a classmate cannot sign someone else''s attempt');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select throws_ok(format($$select public.asm_sign('%s', 'assessor_signoff', 'typed', null, '')$$, pg_temp.v('attempt')), '22023', null, 'SIG the assessor signs off only a marked attempt');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_attempt_signatures set signer_name = 'x' where attempt_id = '%s'$$, pg_temp.v('attempt')), '42501', null, 'SIG a signature is never changed');
select ok(not has_function_privilege('authenticated', 'public.asm_start_attempt(uuid,uuid,uuid)', 'execute') and not has_function_privilege('anon', 'public.asm_start_attempt(uuid,uuid,uuid)', 'execute'), 'open race: asm_start_attempt is called by asm_student only, not by users');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is(public.asm_jsonb_forbidden_key(pg_temp.s('open')::jsonb), null, 'the student payload carries no key, model answer or assessor guidance');
select ok(not (pg_temp.s('open')::jsonb ? 'keys'), 'the student payload has no keys collection');
select is((select count(*)::int from public.asm_results), 0, 'the student reads no result rows before the attempt is returned');
select is((select count(*)::int from public.asm_assessments), 1, 'the student reads the assigned assessment only');
select is((select count(*)::int from public.asm_versions), 1, 'the student reads the assigned published version and not the draft');

-- storage: the student writes under the draft attempt only
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/q_file/evidence.pdf')$$, pg_temp.v('attempt')), 'the student can upload under their draft attempt');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/assessor/notes.pdf')$$, pg_temp.v('attempt')), '42501', null, 'the student cannot write to the assessor folder');
select throws_ok($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '00000000-0000-0000-0000-000000000000/q_file/x.pdf')$$, '42501', null, 'the student cannot write under a foreign attempt id');
select pg_temp.put('ev', (public.asm_student('evidence_register', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'questionId', 'q_file', 'path', pg_temp.v('attempt') || '/q_file/evidence.pdf', 'fileName', 'evidence.pdf', 'mime', 'application/pdf', 'bytes', 1234)))->>'id');
select ok(pg_temp.v('ev') is not null, 'the uploaded file is registered as evidence');
-- ASM-IMPORT: an attachment under a text question (config.allowAttachment) is evidence of that question; the answer stays the text
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/1.1/photo.png')$$, pg_temp.v('attempt')), 'ASM-IMPORT the student can attach a file under a text question');
select pg_temp.put('ev_att', (public.asm_student('evidence_register', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'questionId', '1.1', 'path', pg_temp.v('attempt') || '/1.1/photo.png', 'fileName', 'photo.png', 'mime', 'image/png', 'bytes', 2048)))->>'id');
select is((select question_id from public.asm_evidence_files where id = pg_temp.v('ev_att')::uuid), '1.1', 'ASM-IMPORT the attachment is registered as evidence of that question');
select is((public.asm_student('evidence_remove', jsonb_build_object('id', pg_temp.v('ev_att'))))->>'ok', 'true', 'ASM-IMPORT the student can remove the attachment while the attempt is a draft');
select throws_ok(format($$select public.asm_student('evidence_register', '{"attemptId": "%s", "questionId": "q_file", "path": "%s/q_file/missing.pdf"}')$$, pg_temp.v('attempt'), pg_temp.v('attempt')), 'P0002', null, 'a path with no uploaded object cannot be registered');

-- drafts, validation, submission
select pg_temp.put('save1', (public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', '{"pdf": {"s11": "Gloves"}}'::jsonb)))::text);
select is((pg_temp.s('save1')::jsonb->>'ok')::boolean, true, 'a draft saves');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId": "%s", "responses": {}, "rowVersion": 1}')$$, pg_temp.v('attempt')), '40001', null, 'a save with a stale row version is refused');
select pg_temp.put('sub_bad', (public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', pg_temp.responses() #- '{pdf,s11}' #- '{pdf,s21}', 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))::text);
select is((pg_temp.s('sub_bad')::jsonb->>'ok')::boolean, false, 'a submission with missing required answers is refused');
select is((select count(*)::int from jsonb_array_elements(pg_temp.s('sub_bad')::jsonb->'errors') e where e->>'questionKey' in ('1.1', '2.1')), 2, 'both missing answers are named');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "", "agreed": true}'::jsonb)))->'errors'->0->>'code', 'declaration', 'the declaration needs a typed name');
select pg_temp.put('sub', (public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))::text);
select is((pg_temp.s('sub')::jsonb->>'ok')::boolean, true, 'a complete submission with the declaration succeeds');
select matches(pg_temp.s('sub')::jsonb->>'receiptNo', '^ASM-[0-9]{4}-[0-9]{6}$', 'a receipt number is issued');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt')), 'submitted', 'the attempt is submitted');
select is((select responses_hash from public.asm_attempts where id = pg_temp.v('attempt')), (select encode(sha256(convert_to(responses::text, 'UTF8')), 'hex') from public.asm_attempts where id = pg_temp.v('attempt')), 'the submission hash is the sha-256 of the responses');
select is((select declaration->>'signature' from public.asm_attempts where id = pg_temp.v('attempt')), 'Sam Student', 'the typed signature is kept with the declaration text hash');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId": "%s", "responses": {}}')$$, pg_temp.v('attempt')), '42501', null, 'a submitted attempt no longer accepts draft saves');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/q_file/late.pdf')$$, pg_temp.v('attempt')), '42501', null, 'no more uploads after submission');
select is((select count(*)::int from public.asm_results where attempt_id = pg_temp.v('attempt')), 0, 'the student still reads no results while marking is pending');
select is((select count(*)::int from public.asm_notifications where recipient_auth_user = 'a5000000-0000-0000-0000-000000000011' and event = 'submitted'), 1, 'the student gets a receipt notification');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_attempts set responses = '{}' where id = '%s'$$, pg_temp.v('attempt')), '42501', null, 'submitted responses are locked at the database');
select throws_ok(format($$update public.asm_attempts set version_id = '%s' where id = '%s'$$, pg_temp.v('v2'), pg_temp.v('attempt')), '42501', null, 'an attempt can never move to another version');
select throws_ok(format($$delete from public.asm_attempts where id = '%s'$$, pg_temp.v('attempt')), '42501', null, 'attempts are never deleted');
select is((select count(*)::int from public.asm_unit_outcomes where assessment_id = pg_temp.v('assessment')), 0, 'nothing is marked Competent automatically');

-- ownership: the classmate and the other trainer see nothing of this attempt
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((select count(*)::int from public.asm_attempts where id = pg_temp.v('attempt')), 0, 'a classmate cannot read the attempt');
select is((select count(*)::int from public.asm_evidence_files where attempt_id = pg_temp.v('attempt')), 0, 'a classmate cannot list its evidence');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-evidence' and name like pg_temp.v('attempt') || '/%'), 0, 'a classmate cannot read its storage objects');
select throws_ok(format($$select public.asm_student('submit', '{"attemptId": "%s", "responses": {}, "declaration": {"signature": "X", "agreed": true}}')$$, pg_temp.v('attempt')), 'P0002', null, 'a classmate cannot submit it (tampered id)');
select throws_ok(format($$select public.asm_student('results', '{"attemptId": "%s"}')$$, pg_temp.v('attempt')), 'P0002', null, 'a classmate cannot read its results');
select is((select count(*)::int from public.asm_notifications where recipient_auth_user <> 'a5000000-0000-0000-0000-000000000013'), 0, 'notifications are private to their recipient');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(jsonb_array_length(public.asm_trainer('pending_marking')), 0, 'the trainer of another batch has nothing to mark');
select is((select count(*)::int from public.asm_attempts), 0, 'the trainer of another batch reads no attempt');
select throws_ok(format($$select public.asm_trainer('attempt_get', '{"id": "%s"}')$$, pg_temp.v('attempt')), '42501', null, 'the trainer of another batch cannot open the attempt');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id": "%s", "outcome": "S"}')$$, pg_temp.v('attempt')), '42501', null, 'the trainer of another batch cannot decide it');

-- ---------------------------------------------------------------- the assessor marks
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is(jsonb_array_length(public.asm_trainer('pending_marking')), 1, 'the batch trainer sees the submission to mark');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-evidence' and name like pg_temp.v('attempt') || '/%'), 2, 'the batch trainer reads the evidence objects (the q_file evidence and the ASM-IMPORT attachment object)');
select pg_temp.put('tget', (public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attempt'))))::text);
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt'), 'outcome', 'S')))->'errors'->0->>'message', 'Task 1 · Q1 is not marked yet.', 'the decision waits for every question''s mark');
select pg_temp.put('mark', (public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt'),
  'results', pg_temp.all_marks('NYS') || '[{"questionId":"1.2","outcome":"NYS","feedback":"Never: isolate first"}]'::jsonb,
  'taskResults', '[{"taskId":"1","feedback":"Redo Q2"},{"taskId":"2"}]'::jsonb, 'overallFeedback', 'Nearly there')))::text);
select is(pg_temp.s('mark')::jsonb->>'state', 'marking', 'marking moves the attempt to marking');
select is((select string_agg(task_id || '=' || outcome, ',' order by task_id) from public.asm_task_results where attempt_id = pg_temp.v('attempt')), '1=NYS,2=S', 'ASM-IMPORT-SIMPLE: each task''s result is automatic: task 1 Not Satisfactory (its Q2 is No), task 2 Satisfactory (every question Yes)');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id": "%s", "outcome": "NYS", "rowVersion": 1}')$$, pg_temp.v('attempt')), '40001', null, 'a decision with a stale row version is refused');
select pg_temp.put('ret', (public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt'), 'outcome', 'NYS', 'overallFeedback', 'Fix Q2 and resubmit')))::text);
select is((pg_temp.s('ret')::jsonb->>'ok')::boolean, true, 'the assessor returns the attempt as Not Yet Satisfactory');
select pg_temp.put('attempt2', pg_temp.s('ret')::jsonb->>'nextAttemptId');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt')), 'returned', 'attempt 1 is returned');
select is((select state || '/' || attempt_no from public.asm_attempts where id = pg_temp.v('attempt2')), 'draft/2', 'attempt 2 opens as a draft (reassessment)');
select is((select responses->'pdf'->>'s11' from public.asm_attempts where id = pg_temp.v('attempt2')), 'Gloves and safety glasses protect hands and eyes', 'attempt 2 carries the previous answers');
select is((select count(*)::int from public.asm_evidence_files where attempt_id = pg_temp.v('attempt2')), 1, 'attempt 2 carries the previous evidence');
select is((select state from public.asm_reassessments where attempt_id = pg_temp.v('attempt')), 'opened', 'the reassessment is recorded');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_results set outcome = 'S' where attempt_id = '%s' and question_id = '1.2'$$, pg_temp.v('attempt')), '42501', null, 'results of a returned attempt are frozen');
-- ASM-DATES (owner 2026-11-27): students never enter dates; the database keeps every date to the rules
select is((select marked_on from public.asm_attempts where id = pg_temp.v('attempt')), (now() at time zone public.institution_tz())::date, 'DATES attempt 1 released without a chosen marking date is marked on the release day');
select throws_like(format($$update public.asm_attempts set marked_on = marked_on - 1 where id = '%s'$$, pg_temp.v('attempt')), '%keeps its marking date%', 'DATES a released result keeps its marking date');
select throws_like(format($$update public.asm_attempts set state = 'submitted', submitted_at = timestamptz '2025-12-01 10:00+11' where id = '%s'$$, pg_temp.v('attempt2')), '%opens on%', 'DATES 1 a submission before the assignment opens is refused');
select throws_like(format($$update public.asm_attempts set state = 'submitted', submitted_at = now() + interval '30 days' where id = '%s'$$, pg_temp.v('attempt2')), '%submission window closed%', 'DATES 1 a submission after the end of the window is refused');
select throws_like(format($$update public.asm_attempts set state = 'submitted', submitted_at = now() - interval '1 day' where id = '%s'$$, pg_temp.v('attempt2')), '%on or after the day the previous attempt was marked%', 'DATES 4 a resubmission before the day attempt 1 was marked is refused');
select throws_like(format($$update public.asm_attempts set acknowledged_at = now() - interval '1 day' where id = '%s'$$, pg_temp.v('attempt')), '%acknowledgement cannot be dated before the marking date%', 'DATES 5 an acknowledgement dated before the marking date is refused');
select throws_like(format($$insert into public.asm_attempt_signatures(attempt_id, kind, signer_user, signer_role, signer_name, method, signed_at) values ('%s', 'student_acknowledgement', 'a5000000-0000-0000-0000-000000000011', 'student', 'Sam Student', 'typed', now() - interval '1 day')$$, pg_temp.v('attempt')), '%acknowledgement cannot be dated before the marking date%', 'DATES 5 a signed acknowledgement dated before the marking date is refused');
select is(jsonb_array_length(public.asm_template_missing(jsonb_set(pg_temp.tplmain('x'), '{fields}', pg_temp.tplmain('x')->'fields' || '[{"id":"sd","page":1,"x":0.1,"y":0.9,"w":0.2,"h":0.03,"role":"student","kind":"date","label":"Date","required":true}]'::jsonb), pg_temp.responses(), '{}'::text[])), 0, 'DATES 2 a student date field is never asked for (the PDF prints the submission date)');

-- the student sees the feedback and completes attempt 2
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.asm_results where attempt_id = pg_temp.v('attempt')), 3, 'once returned, the student reads the results');
select is((public.asm_student('results', jsonb_build_object('attemptId', pg_temp.v('attempt'))))->>'overallFeedback', 'Fix Q2 and resubmit', 'the student reads the overall feedback');
select is((select count(*)::int from public.asm_notifications where recipient_auth_user = 'a5000000-0000-0000-0000-000000000011' and event = 'reassessment'), 1, 'the student is told about the reassessment');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt2'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'attempt 2 submits');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt2'), 'results', '[{"questionId":"1.2","outcome":"S"}]'::jsonb, 'taskResults', '[{"taskId":"1","outcome":"S"},{"taskId":"2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'attempt 2: Q2 of task 1 marked');
-- ASM-IMPORT-SIMPLE: the task results the caller sends are not taken: with only one question marked both tasks stay undecided, and the decision waits
select is((select count(*)::int from public.asm_task_results where attempt_id = pg_temp.v('attempt2') and outcome is not null), 0, 'ASM-IMPORT-SIMPLE: a task stays undecided while any of its questions is unmarked, whatever the caller sends');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt2'), 'outcome', 'S')))->'errors'->0->>'code', 'unmarked', 'ASM-IMPORT-SIMPLE: the sign-off waits until every question is marked (automatic task results)');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt2'), 'results', pg_temp.all_marks('S'), 'taskResults', '[{"taskId":"1","outcome":"NYS"}]'::jsonb)))->>'state', 'marking', 'attempt 2: every question marked Yes');
select is((select string_agg(task_id || '=' || outcome, ',' order by task_id) from public.asm_task_results where attempt_id = pg_temp.v('attempt2')), '1=S,2=S', 'ASM-IMPORT-SIMPLE: every question Yes: both tasks Satisfactory (the NYS the caller sent for task 1 is not taken)');
select throws_like(format($$select public.asm_trainer('mark_save', '{"id": "%s", "markedOn": "%s"}')$$, pg_temp.v('attempt2'), (now() at time zone public.institution_tz())::date - 1), '%cannot be before the student''s attempt date%', 'DATES 3 a marking date before the student''s attempt date is refused');
select throws_like(format($$select public.asm_trainer('mark_save', '{"id": "%s", "markedOn": "%s"}')$$, pg_temp.v('attempt2'), (now() at time zone public.institution_tz())::date + 1), '%cannot be after today%', 'DATES 3 a marking date after today is refused');
select throws_like(format($$select public.asm_trainer('mark_return', '{"id": "%s", "outcome": "S", "markedOn": "%s"}')$$, pg_temp.v('attempt2'), (now() at time zone public.institution_tz())::date - 1), '%cannot be before the student''s attempt date%', 'DATES 3 the decision refuses it too');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt2'), 'markedOn', (now() at time zone public.institution_tz())::date)))->>'state', 'marking', 'DATES 3 the attempt date itself (today) is accepted');
select is((select marked_on from public.asm_attempts where id = pg_temp.v('attempt2')), (now() at time zone public.institution_tz())::date, 'DATES 3 and stored as the marking date');
select pg_temp.as_postgres();
update public.asm_task_results set outcome = 'NYS' where attempt_id = pg_temp.v('attempt2') and task_id = '2';
select is((select outcome from public.asm_task_results where attempt_id = pg_temp.v('attempt2') and task_id = '2'), 'S', 'ASM-IMPORT-SIMPLE: a task result written directly is put back to the rule');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt2'), 'outcome', 'S')))->>'outcome', 'S', 'attempt 2 is Satisfactory');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt2')), 'final', 'a Satisfactory attempt is final');
select is((select count(*)::int from public.asm_attempts where student_id = 'e5000000-0000-0000-0000-000000000011'), 2, 'the history keeps both attempts');

-- ASM-WORKBOOK: the results sheet / workbook PDF cover (asm_attempt_history): every attempt with task outcomes and assessor names, never keys
select pg_temp.put('hist', public.asm_attempt_history(pg_temp.v('attempt')::uuid)::text);
select is((select jsonb_agg(a->>'outcome' order by (a->>'attemptNo')::int) from jsonb_array_elements(pg_temp.s('hist')::jsonb->'attempts') a), '["NYS", "S"]'::jsonb, 'history: both attempts of the assignment with their outcomes, in order (asked from attempt 1)');
select is(pg_temp.s('hist')::jsonb->'attempts'->1->>'assessor', 'Tara Trainer', 'history: the assessor who decided attempt 2 is named');
select is((select r->>'outcome' || '/' || (r->>'assessor') from jsonb_array_elements(pg_temp.s('hist')::jsonb->'attempts'->1->'tasks') r where r->>'taskId' = '2'), 'S/Tara Trainer', 'history: each task''s outcome and who signed it, per attempt');
-- AVETMISS (hosted 20261124173444): every student has a permanent student number, which is the Student ID
select ok((pg_temp.s('hist')::jsonb->'student'->>'name') || '/' || (pg_temp.s('hist')::jsonb->'student'->>'ref') ~ '^Sam Student/(SK[0-9]+|E5000000)$', 'history: cover details (student name, the student number or the short id)');
select ok(pg_temp.s('hist') !~ '(modelAnswer|answerKey|assessorGuidance)', 'history: no assessor keys');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select throws_ok(format($$select public.asm_attempt_history('%s')$$, pg_temp.v('attempt2')), '42501', null, 'history: a trainer of another batch is refused');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is(jsonb_array_length(public.asm_attempt_history(pg_temp.v('attempt2')::uuid)->'attempts'), 2, 'history: the student reads their own results sheet');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select throws_ok(format($$select public.asm_attempt_history('%s')$$, pg_temp.v('attempt2')), '42501', null, 'history: a classmate is refused');
-- the stored student number is the Student ID
select pg_temp.as_postgres();
select set_config('asm.test_number', coalesce((select student_number from public.enrollment_students where id = 'e5000000-0000-0000-0000-000000000011'), 'E5000000'), true);
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is(public.asm_attempt_history(pg_temp.v('attempt'))->'student'->>'ref', current_setting('asm.test_number'), 'history: the student number, when stored, is the Student ID');

-- unit outcome: explicit sign-off by an authorised assessor only
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000011", "unitId": "unit-asm-1", "outcome": "C"}')$$, '22023', null, 'no sign-off tick, no outcome');
select pg_temp.put('uo', (public.asm_trainer('unit_outcome_record', jsonb_build_object('studentId', 'e5000000-0000-0000-0000-000000000011', 'unitId', 'unit-asm-1', 'assessmentId', pg_temp.v('assessment'), 'outcome', 'C', 'signOff', true, 'attemptIds', jsonb_build_array(pg_temp.v('attempt2')))))->>'id');
select is((select outcome || '/' || signed_role || '/' || signed_name from public.asm_unit_outcomes where id = pg_temp.v('uo')), 'C/trainer/Tara Trainer', 'the batch trainer signs the student off as Competent');
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-1", "outcome": "C", "signOff": true}')$$, '42501', null, 'a trainer cannot sign off a student of another batch');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000011", "unitId": "unit-asm-1", "outcome": "NYC", "signOff": true}')$$, '42501', null, 'the other trainer cannot sign off this student');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_unit_outcomes set outcome = 'NYC' where id = '%s'$$, pg_temp.v('uo')), '42501', null, 'a recorded outcome is immutable (a new row supersedes it)');
select throws_ok(format($$delete from public.asm_unit_outcomes where id = '%s'$$, pg_temp.v('uo')), '42501', null, 'a recorded outcome cannot be deleted');
select throws_ok($$update public.asm_audit_log set action = 'x' where id = (select min(id) from public.asm_audit_log)$$, '42501', null, 'the audit log is append-only');
select ok((select array_agg(distinct action) from public.asm_audit_log) @> array['assessment_create', 'draft_save', 'version_publish', 'assignment_create', 'attempt_open', 'submit', 'mark_save', 'mark_return', 'unit_outcome_record'], 'every step of the journey is audited');
select is((select count(*)::int from public.asm_audit_log where actor is null and actor_role <> 'system'), 0, 'every audited action names its actor');

-- the student sees competency progress
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is((select u->>'outcome' from jsonb_array_elements(public.asm_student('progress')->'units') u where u->>'unitId' = 'unit-asm-1'), 'C', 'the student sees the unit as Competent');
select is((select count(*)::int from public.asm_unit_outcomes), 1, 'the student reads their own outcome only');

-- ---------------------------------------------------------------- versioning across the attempt: v2 publishes, attempts stay on v1
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment'))))->>'versionNo', '2', 'version 2 publishes');
select is((select count(*)::int from public.asm_attempts where version_id = pg_temp.v('v1')), 2, 'the student attempts stay bound to version 1');
select is((select current_version_id from public.asm_assessments where id = pg_temp.v('assessment')), pg_temp.v('v2'), 'new assignments default to version 2');
select is((select (public.asm_admin('report', jsonb_build_object('kind', 'cohort', 'batchId', 'f5000000-0000-0000-0000-000000000011'))->0->>'unitOutcome')), 'C', 'the cohort report shows the unit outcome');
select is((select count(*)::int from jsonb_array_elements(public.asm_admin('overview')->'pendingMarking') p where p->>'assignmentId' = pg_temp.s('assignment')), 0, 'nothing is pending after the decisions');
-- P4: copying an assessment copies its workbook PDF template (pointed at the new assessment's folder) and its mapping
select pg_temp.put('copy', public.asm_admin('assessment_create', jsonb_build_object('courseId', 'course-asm-test', 'unitId', 'unit-asm-1', 'title', 'A copy', 'fromAssessmentId', pg_temp.v('assessment')))::text);
select is(pg_temp.s('copy')::jsonb->'copyPdf'->>'to', (pg_temp.s('copy')::jsonb->>'id') || '/' || repeat('c', 64) || '.pdf', 'P4 the copy''s template points at its own folder (the browser copies the file there)');
select is((select (v.template->'pdf'->>'path') || ':' || (select count(*) from public.asm_unit_mappings m where m.version_id = v.id) from public.asm_versions v where v.assessment_id = (pg_temp.s('copy')::jsonb->>'id')::uuid), (pg_temp.s('copy')::jsonb->'copyPdf'->>'to') || ':2', 'P4 the copy has the template and the mapping');

-- ---------------------------------------------------------------- calendar (D-10)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is((select count(*)::int from jsonb_array_elements(public.asm_calendar(current_date, current_date + 30)) e where e->>'kind' in ('assessment_due', 'assessment_practical')), 2, 'the student calendar shows the due date and the practical session');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select is((select count(*)::int from jsonb_array_elements(public.asm_calendar(current_date, current_date + 30)) e where e->>'kind' like 'assessment_%'), 0, 'a student of another batch sees no assessment events');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((select count(*)::int from jsonb_array_elements(public.asm_calendar(current_date, current_date + 30)) e where e->>'kind' = 'assessment_due'), 1, 'the batch trainer calendar shows the due date');
select throws_ok($$select public.asm_calendar(current_date, current_date + 400)$$, '22023', null, 'the calendar range is capped');

-- ---------------------------------------------------------------- batch membership changes (brief 7.9)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select pg_temp.put('attempt3', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment'))))->'attempt'->>'id');
select pg_temp.as_postgres();
update public.intake_enrolments set status = 'withdrawn', withdrawn_on = current_date where intake_id = 'f5000000-0000-0000-0000-000000000011' and student_id = 'e5000000-0000-0000-0000-000000000013';
select is((select state || '/' || void_reason from public.asm_attempts where id = pg_temp.v('attempt3')), 'void/left the intake', 'a student who leaves the batch loses the open draft (kept as history)');
select is((select count(*)::int from public.asm_assignment_eligible(pg_temp.v('assignment'))), 1, 'and is no longer eligible');
update public.intake_enrolments set status = 'active' where intake_id = 'f5000000-0000-0000-0000-000000000011' and student_id = 'e5000000-0000-0000-0000-000000000013';
select is((select count(*)::int from public.asm_notifications where recipient_auth_user = 'a5000000-0000-0000-0000-000000000013' and event = 'reassigned'), 1, 'a student who joins is told about the open assessment');

-- ---------------------------------------------------------------- tenant isolation (D-03)
insert into public.asm_assessments(course_id, title) values ('course-asm-other', 'Other institute assessment');
select is((select tenant_id from public.asm_assessments where course_id = 'course-asm-other'), '15000000-0000-0000-0000-000000000002', 'rows take the tenant of their course');
select throws_ok($$insert into public.asm_assessments(course_id, title, tenant_id) values ('course-asm-other', 'Wrong tenant', '00000000-0000-0000-0000-000000000009')$$, '23503', null, 'a client-supplied tenant that differs from the course is refused');
select throws_ok(format($$update public.asm_assessments set tenant_id = null where course_id = 'course-asm-other'$$), '42501', null, 'tenant ownership is immutable');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.asm_assessments where course_id = 'course-asm-other'), 0, 'the legacy institution admin does not see the other tenant''s assessment');
select is((select count(*)::int from public.asm_assessments where course_id = 'course-asm-test'), 2, 'but sees their own');

-- ---------------------------------------------------------------- no client writes anywhere
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select throws_ok($$insert into public.asm_assessments(course_id, title) values ('course-asm-test', 'direct')$$, '42501', null, 'even an admin cannot insert assessment rows directly');
select throws_ok(format($$update public.asm_attempts set state = 'final' where id = '%s'$$, pg_temp.v('attempt')), '42501', null, 'nor change attempts directly');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select throws_ok(format($$insert into public.asm_unit_outcomes(student_id, unit_id, outcome, signed_by, signed_role, signed_name) values ('e5000000-0000-0000-0000-000000000011', 'unit-asm-1', 'C', '%s', 'trainer', 'x')$$, 'a5000000-0000-0000-0000-000000000003'), '42501', null, 'a trainer cannot insert an outcome directly');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$insert into public.asm_results(attempt_id, question_id, outcome) values ('%s', '1.2', 'S')$$, pg_temp.v('attempt')), '42501', null, 'a student cannot write results');
select throws_ok(format($$update public.asm_notifications set read_at = now() where recipient_auth_user = '%s'$$, 'a5000000-0000-0000-0000-000000000011'), '42501', null, 'notifications are read through the RPC, not written directly');
select is((public.asm_student('notification_read'))->>'ok', 'true', 'the student marks their notifications read');
select is((select count(*)::int from public.asm_notifications where recipient_auth_user = 'a5000000-0000-0000-0000-000000000011' and read_at is null), 0, 'and they are read');

-- ---------------------------------------------------------------- hardening T2 (20261113450000): anon, student A vs B, trainer of G2 vs G1, tenant 1 vs 2
select pg_temp.as_postgres();
set local role anon;
select throws_ok($$select public.asm_admin('me')$$, '42501', null, 'T2 anon: asm_admin is not executable');
select throws_ok($$select public.asm_trainer('me')$$, '42501', null, 'T2 anon: asm_trainer is not executable');
select throws_ok($$select public.asm_student('me')$$, '42501', null, 'T2 anon: asm_student is not executable');
select throws_ok($$select public.asm_calendar(current_date, current_date)$$, '42501', null, 'T2 anon: asm_calendar is not executable');
select throws_ok($$select public.asm_evidence_path_readable('x')$$, '42501', null, 'T2 anon: the storage path helpers are not executable');
select throws_ok($$select count(*) from public.asm_attempts$$, '42501', null, 'T2 anon: attempts are not readable');
select pg_temp.as_postgres();
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'asm\_%' and p.proconfig is null), 0, 'T2 every asm_* function pins its search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'asm\_%' and has_function_privilege('anon', p.oid, 'execute')), 0, 'T2 no asm_* function is executable by anon');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'asm\_%' and p.prorettype = 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')), 0, 'T2 no asm_* trigger function is executable by signed-in users');
-- a fresh draft of student A (student1) through the admin override, for the ownership checks below
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.put('draftA', (public.asm_admin('attempt_reopen', jsonb_build_object('id', pg_temp.v('attempt2'), 'reason', 'T2 fixture')))->>'attemptId');
-- student B (student2, batch G2) against student A's work
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId":"%s","responses":{"pdf":{"s11":"mine"}}}')$$, pg_temp.v('draftA')), 'P0002', null, 'T2 student B cannot save student A''s draft');
select throws_ok(format($$select public.asm_student('submit', '{"attemptId":"%s","responses":{},"declaration":{"signature":"Sue","agreed":true}}')$$, pg_temp.v('draftA')), 'P0002', null, 'T2 student B cannot submit student A''s draft');
select throws_ok(format($$select public.asm_student('results', '{"attemptId":"%s"}')$$, pg_temp.v('attempt2')), 'P0002', null, 'T2 student B cannot read student A''s results');
select throws_ok(format($$select public.asm_student('evidence_register', '{"attemptId":"%s","path":"%s/q_file/x.pdf"}')$$, pg_temp.v('draftA'), pg_temp.v('draftA')), 'P0002', null, 'T2 student B cannot register evidence on student A''s attempt');
select throws_ok(format($$select public.asm_student('feedback_post', '{"attemptId":"%s","body":"hi"}')$$, pg_temp.v('attempt2')), 'P0002', null, 'T2 student B cannot post on student A''s thread');
select throws_ok(format($$select public.asm_student('reassessment_request', '{"attemptId":"%s"}')$$, pg_temp.v('attempt')), '42501', null, 'T2 student B cannot request a reassessment of student A''s attempt');
select throws_ok(format($$select public.asm_student('assessment_open', '{"assignmentId":"%s"}')$$, pg_temp.v('assignment')), '42501', null, 'T2 student B is not assigned the G1 assessment');
select is(public.asm_evidence_path_readable(pg_temp.s('attempt2') || '/q_file/x.pdf'), false, 'T2 student B cannot read student A''s evidence path (no signed URL)');
select is(public.asm_evidence_path_writable(pg_temp.s('draftA') || '/q_file/x.pdf'), false, 'T2 student B cannot upload under student A''s draft');
select throws_ok(format($$insert into storage.objects(bucket_id, name, owner) values ('assessment-evidence', '%s/q_file/x.pdf', auth.uid())$$, pg_temp.v('draftA')), '42501', null, 'T2 storage refuses student B''s upload under student A''s attempt');
select is((select count(*)::int from public.asm_attempts where student_id = 'e5000000-0000-0000-0000-000000000011'), 0, 'T2 RLS hides student A''s attempts from student B');
select throws_ok(format($$select public.asm_trainer('attempt_get', '{"id":"%s"}')$$, pg_temp.v('attempt2')), '42501', null, 'T2 a student cannot use the trainer RPC');
select throws_ok($$select public.asm_admin('assessment_list')$$, '42501', null, 'T2 a student cannot use the admin RPC');
-- trainer of G2 (Tom) against G1 work
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select throws_ok(format($$select public.asm_trainer('attempt_get', '{"id":"%s"}')$$, pg_temp.v('attempt2')), '42501', null, 'T2 the G2 trainer cannot open a G1 attempt');
select throws_ok(format($$select public.asm_trainer('mark_save', '{"id":"%s","results":[]}')$$, pg_temp.v('attempt')), '42501', null, 'T2 the G2 trainer cannot mark a G1 attempt');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id":"%s","outcome":"S"}')$$, pg_temp.v('attempt')), '42501', null, 'T2 the G2 trainer cannot decide a G1 attempt');
select throws_ok(format($$select public.asm_trainer('assignment_students', '{"id":"%s"}')$$, pg_temp.v('assignment')), '42501', null, 'T2 the G2 trainer cannot list the G1 assignment');
select throws_ok(format($$select public.asm_trainer('evidence_register', '{"attemptId":"%s","path":"%s/assessor/x.pdf"}')$$, pg_temp.v('attempt'), pg_temp.v('attempt')), '42501', null, 'T2 the G2 trainer cannot attach assessor files to a G1 attempt');
select throws_ok($$select public.asm_trainer('student_progress', '{"studentId":"e5000000-0000-0000-0000-000000000011"}')$$, '42501', null, 'T2 the G2 trainer cannot read a G1 student''s progress');
select is(public.asm_trainer_on_assignment(pg_temp.v('assignment'), 'b5000000-0000-0000-0000-000000000003'), false, 'T2 the scope helper does not answer for another trainer''s profile');
select is(public.asm_trainer_on_assignment(pg_temp.v('assignment')), false, 'T2 the G2 trainer is not on the G1 assignment');
select is((select count(*)::int from public.asm_attempts where assignment_id = pg_temp.v('assignment')), 0, 'T2 RLS hides G1 attempts from the G2 trainer');
select is(public.asm_evidence_path_readable(pg_temp.s('attempt2') || '/q_file/x.pdf'), false, 'T2 the G2 trainer cannot read G1 evidence');
select is(public.asm_evidence_path_writable(pg_temp.s('attempt') || '/assessor/x.pdf'), false, 'T2 the G2 trainer cannot upload assessor files on G1');
-- tenant 2 (Other Institute, its own domain) with the same CMS admin login
select pg_temp.as_postgres();
insert into public.tenant_domains(hostname, tenant_id, verified_at, verification_evidence) values ('other.asm.example.test', '15000000-0000-0000-0000-000000000002', now(), 'test');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select set_config('request.headers', '{"x-tenant-domain":"other.asm.example.test"}', true);
select is(public.tenant_scope('15000000-0000-0000-0000-000000000002'), true, 'T2 the admin acts inside tenant 2 under its domain');
select throws_ok(format($$select public.asm_admin('assessment_get', '{"id":"%s"}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot read a tenant 1 assessment by id');
select throws_ok(format($$select public.asm_admin('assessment_update', '{"id":"%s","title":"Taken over"}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot edit a tenant 1 assessment');
select throws_ok(format($$select public.asm_admin('draft_save', '{"assessmentId":"%s","definition":{"tasks":[]}}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot write a tenant 1 draft');
select throws_ok(format($$select public.asm_admin('version_get', '{"versionId":"%s"}')$$, pg_temp.v('v1')), 'P0002', null, 'T2 tenant 2 admin cannot read a tenant 1 version (and its keys)');
select throws_ok(format($$select public.asm_admin('assessment_export', '{"id":"%s"}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot export a tenant 1 assessment');
select throws_ok(format($$select public.asm_admin('assignment_get', '{"id":"%s"}')$$, pg_temp.v('assignment')), 'P0002', null, 'T2 tenant 2 admin cannot read a tenant 1 assignment');
select throws_ok(format($$select public.asm_admin('assignment_update', '{"id":"%s","status":"closed"}')$$, pg_temp.v('assignment')), 'P0002', null, 'T2 tenant 2 admin cannot change a tenant 1 assignment');
select throws_ok(format($$select public.asm_admin('attempt_get', '{"id":"%s"}')$$, pg_temp.v('attempt2')), 'P0002', null, 'T2 tenant 2 admin cannot read a tenant 1 attempt');
select throws_ok(format($$select public.asm_admin('attempt_void', '{"id":"%s"}')$$, pg_temp.v('draftA')), 'P0002', null, 'T2 tenant 2 admin cannot void a tenant 1 attempt');
select throws_ok(format($$select public.asm_admin('attempt_reopen', '{"id":"%s"}')$$, pg_temp.v('attempt2')), 'P0002', null, 'T2 tenant 2 admin cannot reopen a tenant 1 attempt');
select throws_ok(format($$select public.asm_admin('assignment_create', '{"assessmentId":"%s","dueAt":"2030-01-01T00:00:00Z","batchIds":["f5000000-0000-0000-0000-000000000012"]}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot assign a tenant 1 assessment');
select throws_ok($$select public.asm_admin('assessment_create', '{"courseId":"course-asm-test","title":"Cross"}')$$, 'P0002', null, 'T2 tenant 2 admin cannot create on a tenant 1 course');
select throws_ok(format($$select public.asm_admin('assessment_create', '{"courseId":"course-asm-other","title":"Clone","fromAssessmentId":"%s"}')$$, pg_temp.v('assessment')), 'P0002', null, 'T2 tenant 2 admin cannot clone a tenant 1 assessment');
select throws_ok($$select public.asm_admin('unit_elements_list', '{"unitId":"unit-asm-1"}')$$, 'P0002', null, 'T2 tenant 2 admin cannot read tenant 1 unit elements');
select throws_ok($$select public.asm_admin('unit_outcome_record', '{"studentId":"e5000000-0000-0000-0000-000000000011","unitId":"unit-asm-1","outcome":"C","signOff":true}')$$, 'P0002', null, 'T2 tenant 2 admin cannot sign off a tenant 1 unit');
select is(jsonb_array_length(public.asm_admin('assessment_list')), 1, 'T2 the assessment list shows only tenant 2''s own row (inserted above), nothing of tenant 1');
select is(jsonb_array_length(public.asm_admin('assignment_list')), 0, 'T2 the assignment list shows nothing of tenant 1');
select is(jsonb_array_length(public.asm_admin('outcomes_list')), 0, 'T2 the outcomes list shows nothing of tenant 1');
select is(jsonb_array_length(public.asm_admin('audit_list')), 0, 'T2 the audit list shows nothing of tenant 1');
select is(jsonb_array_length(public.asm_admin('batch_list')), 0, 'T2 the batch list shows nothing of tenant 1');
select is((public.asm_admin('overview'))->>'assignments', '0', 'T2 the overview counts nothing of tenant 1');
select is(jsonb_array_length(public.asm_calendar(date '2026-01-01', date '2026-12-31')), 0, 'T2 the calendar shows nothing of tenant 1');
select pg_temp.put('other_as', (public.asm_admin('assessment_create', '{"courseId":"course-asm-other","title":"Other tenant assessment"}'))->>'id');
select is((select tenant_id from public.asm_assessments where id = pg_temp.v('other_as')), '15000000-0000-0000-0000-000000000002', 'T2 tenant 2 admin creates inside tenant 2');
select is(jsonb_array_length(public.asm_admin('assessment_list')), 2, 'T2 and sees only tenant 2 assessments');
select set_config('request.headers', '', true);
select throws_ok(format($$select public.asm_admin('assessment_get', '{"id":"%s"}')$$, pg_temp.v('other_as')), 'P0002', null, 'T2 the tenant 1 admin cannot read tenant 2''s assessment by id');
select throws_ok(format($$select public.asm_admin('draft_save', '{"assessmentId":"%s","definition":{"tasks":[]}}')$$, pg_temp.v('other_as')), 'P0002', null, 'T2 nor edit it');
select throws_ok($$select public.asm_admin('assessment_create', '{"courseId":"course-asm-other","title":"Cross"}')$$, 'P0002', null, 'T2 nor create on tenant 2''s course');
select is((select count(*)::int from jsonb_array_elements(public.asm_admin('assessment_list')) x where x->>'id' = pg_temp.s('other_as')), 0, 'T2 the tenant 1 list omits tenant 2');
-- a tenant 1 student and trainer under tenant 2's domain see nothing
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select set_config('request.headers', '{"x-tenant-domain":"other.asm.example.test"}', true);
select is(jsonb_array_length(public.asm_student('my_assessments')), 0, 'T2 a tenant 1 student under tenant 2''s domain has no assessments');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId":"%s","responses":{}}')$$, pg_temp.v('draftA')), 'P0002', null, 'T2 and cannot reach their own draft from there');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is(jsonb_array_length(public.asm_trainer('my_assignments')), 0, 'T2 a tenant 1 trainer under tenant 2''s domain has no assignments');
select throws_ok(format($$select public.asm_trainer('attempt_get', '{"id":"%s"}')$$, pg_temp.v('attempt2')), '42501', null, 'T2 and cannot open their own batch''s attempt from there');
select set_config('request.headers', '', true);
select pg_temp.as_postgres();

-- ---------------------------------------------------------------- hardening T3 (20261113460000, D-22): who may mark and sign off
-- Tom (trainer B) is on batch G2 but holds no trainer role; Tara (trainer A) holds it. require_trainer_role defaults to true.
select pg_temp.as_postgres();
select is((select require_trainer_role from public.asm_settings where tenant_id is null), true, 'T3 require_trainer_role defaults to true');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_admin('assignment_create', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'versionId', pg_temp.v('v1'), 'batchIds', jsonb_build_array('f5000000-0000-0000-0000-000000000012'), 'dueAt', now() + interval '14 days')))->>'created', '1', 'T3 version 1 is assigned to batch G2');
select pg_temp.put('assignment2', (select id::text from public.asm_assignments where version_id = pg_temp.v('v1') and intake_id = 'f5000000-0000-0000-0000-000000000012'));
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select pg_temp.put('attemptB', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment2'))))->'attempt'->>'id');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attemptB'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sue Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'T3 student 2 submits on G2');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('me'))->>'isTrainer', 'false', 'T3 Tom has no trainer role');
select is((public.asm_trainer('me'))->>'requireTrainerRole', 'true', 'T3 and the workspace knows the role is required');
select is((select x->>'canAssess' from jsonb_array_elements(public.asm_trainer('my_assignments')) x where x->>'id' = pg_temp.s('assignment2')), 'false', 'T3 the G2 assignment is listed for Tom as not assessable');
select is((public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attemptB'))))->>'state', 'submitted', 'T3 a batch trainer without the role still reads the submission');
select is((public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attemptB'))))->>'canAssess', 'false', 'T3 and is told they cannot mark it');
select throws_ok(format($$select public.asm_trainer('mark_save', '{"id":"%s","results":[{"questionId":"1.2","outcome":"S"}]}')$$, pg_temp.v('attemptB')), '42501', null, 'T3 a batch trainer without the trainer role cannot mark');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id":"%s","outcome":"S"}')$$, pg_temp.v('attemptB')), '42501', null, 'T3 nor decide');
select throws_ok(format($$select public.asm_trainer('evidence_register', '{"attemptId":"%s","path":"%s/assessor/notes.pdf"}')$$, pg_temp.v('attemptB'), pg_temp.v('attemptB')), '42501', null, 'T3 nor attach assessor files');
select is(public.asm_evidence_path_writable(pg_temp.s('attemptB') || '/assessor/notes.pdf'), false, 'T3 nor upload them (storage policy)');
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-1", "outcome": "C", "signOff": true}')$$, '42501', null, 'T3 nor sign the unit off');
select is(public.asm_can_assess(pg_temp.v('assignment2')), false, 'T3 asm_can_assess says no for Tom');
select is(public.asm_can_assess(pg_temp.v('assignment2'), 'b5000000-0000-0000-0000-000000000003'), false, 'T3 and does not answer for another profile');
-- (b) named assessor: role not required
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id":"%s","trainerStaffIds":["b5000000-0000-0000-0000-000000000004"]}')$$, pg_temp.v('assignment2')), 'T3 the admin names Tom as assessor on the G2 assignment');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(public.asm_can_assess(pg_temp.v('assignment2')), true, 'T3 a named assessor may assess without the role');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attemptB'), 'results', '[{"questionId":"1.2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T3 and marks');
select is(public.asm_evidence_path_writable(pg_temp.s('attemptB') || '/assessor/notes.pdf'), true, 'T3 and may upload assessor files');
select pg_temp.put('uoB', (public.asm_trainer('unit_outcome_record', jsonb_build_object('studentId', 'e5000000-0000-0000-0000-000000000012', 'unitId', 'unit-asm-1', 'outcome', 'NYC', 'signOff', true, 'batchId', 'f5000000-0000-0000-0000-000000000012', 'assessmentId', pg_temp.v('assessment'))))->>'id');
select is((select signed_staff_id::text || '|' || outcome from public.asm_unit_outcomes where id = pg_temp.v('uoB')), 'b5000000-0000-0000-0000-000000000004|NYC', 'T3 a named assessor signs the unit off');
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-1", "outcome": "C", "signOff": true, "batchId": "f5000000-0000-0000-0000-000000000011"}')$$, '22023', null, 'T3 a batch the student is not in is refused');
select throws_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-2", "outcome": "C", "signOff": true}')$$, '42501', null, 'T3 a unit of the course with no assignment and no role is refused');
select throws_ok(format($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-2", "outcome": "C", "signOff": true, "assessmentId": "%s"}')$$, pg_temp.v('assessment')), '22023', null, 'T3 an assessment of another unit is refused');
-- back to a plain batch trainer: the role requirement can be switched off per institution
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id":"%s","trainerStaffIds":[]}')$$, pg_temp.v('assignment2')), 'T3 the admin removes the named assessor');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(public.asm_can_assess(pg_temp.v('assignment2')), false, 'T3 Tom is a plain batch trainer again and may not assess');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.as_postgres();
update public.asm_settings set require_trainer_role = false;
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((select bool_and(require_trainer_role)::text from public.asm_settings), 'false', 'T3 the admin switches the role requirement off');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(public.asm_can_assess(pg_temp.v('assignment2')), true, 'T3 with the requirement off every active batch trainer may assess');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attemptB'), 'results', pg_temp.all_marks('S'), 'taskResults', '[{"taskId":"1","outcome":"S"},{"taskId":"2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T3 Tom marks as a plain batch trainer');
select lives_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-2", "outcome": "NYC", "signOff": true}')$$, 'T3 and signs off a unit of the course without an assignment');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.as_postgres();
update public.asm_settings set require_trainer_role = true;
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((select bool_and(require_trainer_role)::text from public.asm_settings), 'true', 'T3 the requirement is switched back on');
-- (a) the role itself
select pg_temp.as_postgres();
insert into hr.staff_roles(profile_id, role, granted_by) values ('b5000000-0000-0000-0000-000000000004', 'trainer', 'a5000000-0000-0000-0000-000000000001');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('me'))->>'isTrainer', 'true', 'T3 Tom now holds the trainer role');
select is(public.asm_can_assess(pg_temp.v('assignment2')), true, 'T3 a batch trainer with the role may assess');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attemptB'), 'outcome', 'S')))->>'outcome', 'S', 'T3 and decides the attempt');
select is(public.asm_can_assess(pg_temp.v('assignment')), false, 'T3 the role does not reach a batch the trainer is not on');
select pg_temp.as_postgres();
update hr.staff_roles set revoked_at = now() where profile_id = 'b5000000-0000-0000-0000-000000000004' and role = 'trainer';
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(public.asm_can_assess(pg_temp.v('assignment2')), false, 'T3 a revoked role counts as no role');
-- (c) Admin / RTO Manager, and nobody else
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is(public.asm_can_assess(pg_temp.v('assignment2')), true, 'T3 an Admin / RTO Manager may assess');
select lives_ok($$select public.asm_admin('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-1", "outcome": "C", "signOff": true}')$$, 'T3 the administrator signs the unit off');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.asm_admin('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-1", "outcome": "C", "signOff": true}')$$, '42501', null, 'T3 an Editor cannot sign off');
select is(public.asm_can_assess(pg_temp.v('assignment2')), false, 'T3 nor assess');
select pg_temp.as_postgres();

-- ---------------------------------------------------------------- hardening T4 (20261113470000): the attempt pattern
-- Student 3 (Sid, batch G1) had attempt 1 on the G1 assignment voided when they left the batch; they are back in G1.
select pg_temp.as_postgres();
select is((select count(*)::int from pg_indexes where indexname = 'asm_attempts_one_open'), 1, 'T4 one open attempt per student per assignment is a unique index');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt3')), 'void', 'T4 fixture: student 3''s first attempt is void');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select pg_temp.put('s3a', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment'))))->'attempt'->>'id');
select is((select attempt_no || '|' || state from public.asm_attempts where id = pg_temp.v('s3a')), '2|draft', 'T4 after a voided draft the student opens attempt 2 (the void does not block or count)');
select pg_temp.as_postgres();
select is(public.asm_attempt_count(pg_temp.v('assignment'), 'e5000000-0000-0000-0000-000000000013'), 1, 'T4 the void attempt is not counted');
select is((select version_id from public.asm_attempts where id = pg_temp.v('s3a')), pg_temp.v('v1'), 'T4 the new attempt is bound to the assignment''s version');
select throws_ok(format($$insert into public.asm_attempts(assignment_id, version_id, student_id, attempt_no) values ('%s', '%s', 'e5000000-0000-0000-0000-000000000013', 9)$$, pg_temp.v('assignment'), pg_temp.v('v1')), '23505', null, 'T4 a second open attempt is refused by the index');
-- autosave conflicts and immutability
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('s3a'), 'responses', '{"pdf": {"s11": "a"}}'::jsonb, 'rowVersion', 1)))->>'rowVersion', '2', 'T4 a save with the current row version moves it');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId": "%s", "responses": {"pdf": {"s11": "b"}}, "rowVersion": 1}')$$, pg_temp.v('s3a')), '40001', null, 'T4 a save from a stale window is refused');
select throws_ok(format($$select public.asm_student('submit', '{"attemptId": "%s", "responses": {}, "rowVersion": 1, "declaration": {"signature": "Sid Student", "agreed": true}}')$$, pg_temp.v('s3a')), '40001', null, 'T4 a submit from a stale window is refused');
select is((select responses->'pdf'->>'s11' from public.asm_attempts where id = pg_temp.v('s3a')), 'a', 'T4 the stale writes changed nothing');
-- late rules: allow + late_until in the past refuses; block refuses after due without late_until; block + late_until ahead accepts and flags
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id": "%s", "availableFrom": "%s", "dueAt": "%s", "lateUntil": "%s"}')$$, pg_temp.v('assignment'), (now() - interval '5 days')::text, (now() - interval '3 days')::text, (now() - interval '1 day')::text), 'T4 fixture: due three days ago, late submissions closed yesterday');
select lives_ok(format($$select public.asm_admin('assignment_student_set', '{"id": "%s", "studentId": "e5000000-0000-0000-0000-000000000013", "dueAt": "%s"}')$$, pg_temp.v('assignment'), (now() - interval '2 days')::text), 'T4 fixture: student 3''s own due date is two days ago (a due-date change reaches every draft of the student)');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3a'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))->'errors'->0->>'code', 'late', 'T4 after late_until nothing is accepted, even in allow mode');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id": "%s", "lateUntil": null}')$$, pg_temp.v('assignment')), 'T4 fixture: no late_until');
select is((public.asm_admin('settings_save', '{"lateSubmission": "block"}'))->>'late_submission', 'block', 'T4 fixture: late submissions blocked');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3a'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))->'errors'->0->>'code', 'late', 'T4 block mode refuses after the due date');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id": "%s", "lateUntil": "%s"}')$$, pg_temp.v('assignment'), (now() + interval '1 day')::text), 'T4 fixture: late_until extended to tomorrow');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3a'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'T4 block mode accepts inside late_until');
select is((select declaration->>'late' from public.asm_attempts where id = pg_temp.v('s3a')), 'true', 'T4 and the submission is flagged late');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId": "%s", "responses": {"pdf": {"s11": "later"}}, "rowVersion": 99}')$$, pg_temp.v('s3a')), '42501', null, 'T4 a submitted attempt is locked for the student');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_attempts set responses = '{}' where id = '%s'$$, pg_temp.v('s3a')), '42501', null, 'T4 a submitted attempt is immutable even for the owner role');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok($$select public.asm_admin('settings_save', '{"lateSubmission": "allow"}')$$, 'T4 fixture: back to allow');
-- max_attempts: NYS decisions open attempts only under the limit (institution 3, voids not counted); the assessor cannot reopen beyond it, the admin only with overrideLimit
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('s3a'), 'results', pg_temp.all_marks('NYS'), 'taskResults', '[{"taskId":"1","outcome":"NYS"},{"taskId":"2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T4 the trainer marks attempt 2');
select pg_temp.put('s3b', (public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('s3a'), 'outcome', 'NYS')))->>'nextAttemptId');
select is((select attempt_no || '|' || state from public.asm_attempts where id = pg_temp.v('s3b')), '3|draft', 'T4 NYS opens attempt 3 (one counted so far)');
select ok((select due_at between now() + interval '4 days 23 hours' and now() + interval '5 days 1 hour' from public.asm_attempts where id = pg_temp.v('s3b')), 'T4 the reassessment window is reassessment_days (5)');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3b'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'T4 attempt 3 submits');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('s3b'), 'results', pg_temp.all_marks('NYS'), 'taskResults', '[{"taskId":"1","outcome":"NYS"},{"taskId":"2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T4 the trainer marks attempt 3');
select pg_temp.put('s3c', (public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('s3b'), 'outcome', 'NYS')))->>'nextAttemptId');
select is((select attempt_no || '|' || state from public.asm_attempts where id = pg_temp.v('s3c')), '4|draft', 'T4 the second counted NYS opens attempt 4 (the third counted attempt)');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3c'), 'responses', pg_temp.responses(), 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'T4 attempt 4 submits');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('s3c'), 'results', pg_temp.all_marks('NYS'), 'taskResults', '[{"taskId":"1","outcome":"NYS"},{"taskId":"2","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T4 the trainer marks attempt 4');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('s3c'), 'outcome', 'NYS')))->>'nextAttemptId', null, 'T4 the third counted NYS finalises: no attempt 5');
select is((select state || '|' || outcome from public.asm_attempts where id = pg_temp.v('s3c')), 'final|NYS', 'T4 attempt 4 is final NYS');
select throws_ok(format($$select public.asm_trainer('attempt_reopen', '{"id": "%s"}')$$, pg_temp.v('s3c')), '42501', null, 'T4 the assessor cannot reopen beyond the limit');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select lives_ok(format($$select public.asm_student('reassessment_request', '{"attemptId": "%s", "reason": "please"}')$$, pg_temp.v('s3c')), 'T4 the student asks for a reassessment');
select pg_temp.put('rr', (select id::text from public.asm_reassessments where attempt_id = pg_temp.v('s3c') and state = 'requested'));
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select throws_ok(format($$select public.asm_admin('reassessment_decide', '{"id": "%s", "approve": true}')$$, pg_temp.v('rr')), '42501', null, 'T4 approving beyond the limit needs the override');
select throws_ok(format($$select public.asm_admin('attempt_reopen', '{"id": "%s"}')$$, pg_temp.v('s3c')), '42501', null, 'T4 the admin reopen beyond the limit needs the override');
select pg_temp.put('s3d', (public.asm_admin('reassessment_decide', jsonb_build_object('id', pg_temp.v('rr'), 'approve', true, 'overrideLimit', true)))->>'attemptId');
select is((select attempt_no || '|' || state from public.asm_attempts where id = pg_temp.v('s3d')), '5|draft', 'T4 with overrideLimit the admin approves: attempt 5');
select is((select state from public.asm_reassessments where id = pg_temp.v('rr')), 'opened', 'T4 the request is recorded as opened');
select is((select count(*)::int from public.asm_audit_log where action = 'attempt_limit_override' and target_id = pg_temp.s('s3d')), 1, 'T4 the override is audited');
select throws_ok(format($$select public.asm_admin('attempt_reopen', '{"id": "%s", "overrideLimit": true}')$$, pg_temp.v('s3c')), '23505', null, 'T4 only one open attempt: a reopen beside the draft is refused');
-- per-assessment override of max_attempts
select lives_ok(format($$select public.asm_admin('assessment_update', '{"id": "%s", "settingsOverride": {"max_attempts": 6}}')$$, pg_temp.v('assessment')), 'T4 the assessment allows six attempts');
select pg_temp.as_postgres();
select is(public.asm_max_attempts(pg_temp.v('assignment')), 6, 'T4 the override is effective for its assignments');
-- void and reopen by the assessor, audited
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('attempt_void', jsonb_build_object('id', pg_temp.v('s3d'), 'reason', 'opened in error')))->>'ok', 'true', 'T4 the assessor voids the draft');
select is((select state || '|' || void_reason from public.asm_attempts where id = pg_temp.v('s3d')), 'void|opened in error', 'T4 the void keeps its reason');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_audit_log where action = 'attempt_void' and target_id = pg_temp.s('s3d') and actor_role = 'trainer'), 1, 'T4 the void is audited');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select pg_temp.put('s3e', (public.asm_trainer('attempt_reopen', jsonb_build_object('id', pg_temp.v('s3c'), 'reason', 'resubmission agreed')))->>'attemptId');
select is((select attempt_no || '|' || state from public.asm_attempts where id = pg_temp.v('s3e')), '6|draft', 'T4 under the raised limit the assessor reopens: attempt 6');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_audit_log where action = 'attempt_reopen' and target_id = pg_temp.s('s3c') and actor_role = 'trainer'), 1, 'T4 the reopen is audited');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((select count(*)::int from public.asm_reassessments where next_attempt_id = pg_temp.v('s3e') and requested_role = 'trainer' and state = 'opened'), 1, 'T4 and recorded as a reassessment');
select throws_ok(format($$select public.asm_trainer('attempt_void', '{"id": "%s"}')$$, pg_temp.v('attempt2')), '42501', null, 'T4 an assessor cannot void an attempt on a batch they are not on');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select throws_ok(format($$select public.asm_trainer('attempt_void', '{"id": "%s"}')$$, pg_temp.v('s3e')), '42501', null, 'T4 a trainer without the marking right cannot void');
select throws_ok(format($$select public.asm_trainer('attempt_reopen', '{"id": "%s"}')$$, pg_temp.v('s3c')), '42501', null, 'T4 nor reopen');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select throws_ok(format($$select public.asm_trainer('attempt_void', '{"id": "%s"}')$$, pg_temp.v('s3e')), '42501', null, 'T4 a student cannot void');
-- a closed assignment opens nothing
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id": "%s", "status": "closed"}')$$, pg_temp.v('assignment')), 'T4 fixture: the assignment is closed');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('attempt_void', jsonb_build_object('id', pg_temp.v('s3e'))))->>'ok', 'true', 'T4 fixture: the draft is voided');
select throws_ok(format($$select public.asm_trainer('attempt_reopen', '{"id": "%s"}')$$, pg_temp.v('s3c')), '42501', null, 'T4 a closed assignment opens no attempt');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.asm_admin('assignment_update', '{"id": "%s", "status": "open"}')$$, pg_temp.v('assignment')), 'T4 fixture: reopened');
select pg_temp.as_postgres();

-- ---------------------------------------------------------------- hardening T5 (20261113480000): acknowledgment and idempotent submit
-- Student 3's attempts 2..4 are returned / final; attempt 6 was voided and the assignment is open again.
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((select count(*)::int from jsonb_array_elements(public.asm_student('my_assessments')) a, jsonb_array_elements(a->'attempts') t where t->>'state' in ('returned', 'final') and t->>'acknowledgedAt' is null), 3, 'T5 three results wait for the student''s acknowledgment');
select is((public.asm_student('result_acknowledge', jsonb_build_object('attemptId', pg_temp.v('s3a'))))->>'ok', 'true', 'T5 the student acknowledges attempt 2');
select is((select acknowledged_at is not null from public.asm_attempts where id = pg_temp.v('s3a')), true, 'T5 the acknowledgment is stored on the attempt');
select is((public.asm_student('results', jsonb_build_object('attemptId', pg_temp.v('s3a'))))->>'acknowledgedAt' is not null, true, 'T5 and shown with the result');
select pg_temp.put('ack1', (select acknowledged_at::text from public.asm_attempts where id = pg_temp.v('s3a')));
select is(((public.asm_student('result_acknowledge', jsonb_build_object('attemptId', pg_temp.v('s3a'))))->>'acknowledgedAt')::timestamptz, pg_temp.s('ack1')::timestamptz, 'T5 acknowledging again keeps the first time');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select pg_temp.put('s3f', (public.asm_trainer('attempt_reopen', jsonb_build_object('id', pg_temp.v('s3c'), 'reason', 'T5 fixture')))->>'attemptId');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select is((public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment'))))->'attempt'->>'id', pg_temp.s('s3f'), 'T5 the reopened attempt 7 is the student''s current attempt');
select throws_ok(format($$select public.asm_student('result_acknowledge', '{"attemptId": "%s"}')$$, pg_temp.v('s3f')), 'P0002', null, 'T5 a draft has no result to acknowledge');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select throws_ok(format($$select public.asm_student('result_acknowledge', '{"attemptId": "%s"}')$$, pg_temp.v('s3b')), 'P0002', null, 'T5 another student cannot acknowledge it');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_audit_log where action = 'result_acknowledge' and target_id = pg_temp.s('s3a') and actor_role = 'student'), 1, 'T5 the acknowledgment is audited');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('s3a'))))->>'acknowledgedAt' is not null, true, 'T5 the assessor sees when the student acknowledged');
-- idempotent submit: attempt 7 (s3f) submitted with a request id; the same request again returns the same receipt and sends nothing twice
select pg_temp.as_user('a5000000-0000-0000-0000-000000000013');
select pg_temp.put('sub7', (public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3f'), 'responses', pg_temp.responses(), 'requestId', 'req-7-abc', 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))::text);
select is(pg_temp.s('sub7')::jsonb->>'ok', 'true', 'T5 attempt 7 submits with a request id');
select pg_temp.put('sub7b', (public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('s3f'), 'responses', pg_temp.responses(), 'requestId', 'req-7-abc', 'declaration', '{"signature": "Sid Student", "agreed": true}'::jsonb)))::text);
select is(pg_temp.s('sub7b')::jsonb->>'receiptNo', pg_temp.s('sub7')::jsonb->>'receiptNo', 'T5 the same request again returns the same receipt');
select is(pg_temp.s('sub7b')::jsonb->>'idempotent', 'true', 'T5 and says so');
select throws_ok(format($$select public.asm_student('submit', '{"attemptId": "%s", "responses": {}, "requestId": "req-7-other", "declaration": {"signature": "Sid Student", "agreed": true}}')$$, pg_temp.v('s3f')), '42501', null, 'T5 a different request after submission is refused');
select throws_ok(format($$select public.asm_student('submit', '{"attemptId": "%s", "responses": {}, "declaration": {"signature": "Sid Student", "agreed": true}}')$$, pg_temp.v('s3f')), '42501', null, 'T5 and so is one without a request id');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_audit_log where action = 'submit' and target_id = pg_temp.s('s3f')), 1, 'T5 one submission is audited');
select is((select count(*)::int from public.asm_notifications where attempt_id = pg_temp.v('s3f') and event = 'submitted'), 2, 'T5 one receipt to the student and one notice to the batch trainer');
select is((select submit_request_id from public.asm_attempts where id = pg_temp.v('s3f')), 'req-7-abc', 'T5 the request id is kept with the submission');

-- ---------------------------------------------------------------- SLIT unit hours (theory, practical, assessment)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_unit_hours_save('unit-asm-1', 60, 24, 24, 12)$$, '42501', null, 'HRS an editor who is not an RTO Manager cannot set unit hours');
select is(jsonb_array_length(public.rto_unit_hours_list('course-asm-test')), 2, 'HRS staff can read the course unit hours');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select throws_ok($$select public.rto_unit_hours_save('unit-asm-1', 60, 24, 24, 10)$$, '22023', null, 'HRS parts that do not add up to the SLIT hours are refused');
select throws_ok($$select public.rto_unit_hours_save('unit-asm-1', 60, -1, 49, 12)$$, '22023', null, 'HRS negative hours are refused');
select throws_ok($$select public.rto_unit_hours_save('unit-missing', 60, 24, 24, 12)$$, 'P0002', null, 'HRS an unknown unit is refused');
select is((public.rto_unit_hours_save('unit-asm-1', 60, 30, 20, 10))->>'theoryHours', '30', 'HRS an RTO Manager saves changed hours');
select pg_temp.as_postgres();
select ok((select hours_confirmed_at is not null and slit_hours = 60 from public.cms_course_units where id = 'unit-asm-1'), 'HRS the saved unit is marked reviewed');
select is((select count(*)::int from public.cms_course_units where id = 'unit-asm-2' and slit_hours is null and hours_confirmed_at is null), 1, 'HRS other units stay unreviewed');

-- ---------------------------------------------------------------- dated class sessions generated from the weekly pattern
-- unit-asm-1 now has 60 SLIT hours: 30 theory, 20 practical, 10 assessment. G1 meets Monday theory, Friday workshop, Sunday assessment, 4 hours each.
insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type) values
 ('f5000000-0000-0000-0000-000000000011', 1, 'morning', '09:00', '13:00', 'theory'),
 ('f5000000-0000-0000-0000-000000000011', 5, 'morning', '09:00', '13:00', 'practical'),
 ('f5000000-0000-0000-0000-000000000011', 7, 'morning', '09:00', '13:00', 'assessment');
insert into hr.public_holidays(holiday_date, name, status)
 select date '2026-01-26', 'Australia Day', 'confirmed' where not exists(select 1 from hr.public_holidays where holiday_date = date '2026-01-26' and status = 'confirmed' and not is_optional)
 on conflict (state, holiday_date, name) do update set status = 'confirmed', is_optional = false; -- a synced row still under review counts as confirmed here
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_class_sessions_generate('f5000000-0000-0000-0000-000000000011')$$, '42501', null, 'CLS an editor who is not an RTO Manager cannot generate classes');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select throws_ok($$select public.rto_class_sessions_generate('f5000000-0000-0000-0000-000000000012')$$, '22023', null, 'CLS a batch without weekly class times is refused');
select is((public.rto_class_sessions_generate('f5000000-0000-0000-0000-000000000011'))->>'created', '16', 'CLS 8 theory, 5 workshop and 3 assessment sessions cover the hours');
select is(jsonb_array_length(public.rto_class_sessions_list('f5000000-0000-0000-0000-000000000011', date '2026-01-01', date '2026-06-30')), 16, 'CLS staff can list the dated classes');
select pg_temp.as_postgres();
select is((select count(*)::int from public.class_sessions where session_date = date '2026-01-26'), 0, 'CLS a confirmed public holiday is skipped');
select is((select max(session_date) from public.class_sessions where intake_id = 'f5000000-0000-0000-0000-000000000011'), date '2026-03-02', 'CLS the holiday pushes the last theory class a week later');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_class_sessions_reset('f5000000-0000-0000-0000-000000000011', true)$$, '42501', null, 'CLS an editor who is not an RTO Manager cannot reset a calendar');
-- the class id is looked up as postgres (staff read classes through the RPCs, not the table)
select pg_temp.as_postgres();
select pg_temp.put('cls_first', (select id::text from public.class_sessions where intake_id = 'f5000000-0000-0000-0000-000000000011' order by session_date limit 1));
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
-- classes are never cancelled (CLASS-RESCHEDULE 20261120211741): a class moved by hand is the hand change
select public.rto_class_session_update(pg_temp.v('cls_first'), '{"startTime": "10:00", "endTime": "14:00"}'::jsonb);
select is((public.rto_class_sessions_reset('f5000000-0000-0000-0000-000000000011', true))->>'created', '16', 'CLS recreate builds the whole calendar again from the intake start');
select pg_temp.as_postgres();
select is((select count(*)::int from public.class_sessions where intake_id = 'f5000000-0000-0000-0000-000000000011' and (is_manual or status = 'cancelled')), 0, 'CLS recreate drops hand-changed and cancelled classes');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.rto_class_sessions_reset('f5000000-0000-0000-0000-000000000011', false))->>'removed', '16', 'CLS remove deletes every dated class of the batch');
select pg_temp.as_postgres();
-- INTAKE-STUDY-LOAD: CoE 20 hours a week, VoE 40 hours a week (half the weeks per unit)
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is(public.rto_intake_loads('course-asm-test')->>'f5000000-0000-0000-0000-000000000001', 'coe', 'LOAD an intake is CoE unless set');
select throws_ok($$select public.rto_intake_load_set('f5000000-0000-0000-0000-000000000001', 'part-time')$$, '22023', null, 'LOAD only CoE or VoE');
select pg_temp.put('coe_end', public.rto_intake_load_set('f5000000-0000-0000-0000-000000000001', 'coe')->>'endDate');
select is(public.rto_intake_load_set('f5000000-0000-0000-0000-000000000001', 'voe')->>'studyLoad', 'voe', 'LOAD an RTO Manager sets VoE');
select ok((select end_date from public.course_intakes where id = 'f5000000-0000-0000-0000-000000000001') < (select v from t where k = 'coe_end')::date, 'LOAD a VoE timeline ends sooner than CoE');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_intake_load_set('f5000000-0000-0000-0000-000000000001', 'coe')$$, '42501', null, 'LOAD an editor who is not an RTO Manager cannot change it');
select pg_temp.as_postgres();
-- COURSE-BREAKS: a break can belong to one course; other courses keep teaching
insert into public.academic_breaks(label, start_date, end_date, course_id) values ('ASM test course break', date '2026-01-12', date '2026-01-18', 'course-asm-test');
select set_config('rto.course', 'some-other-course', true);
select ok(not public.rto_break_on(date '2026-01-13'), 'BRK a break of another course does not stop this course');
select set_config('rto.course', 'course-asm-test', true);
select ok(public.rto_break_on(date '2026-01-13'), 'BRK the course''s own break applies');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select public.rto_class_sessions_reset('f5000000-0000-0000-0000-000000000011', true);
select pg_temp.as_postgres();
select is((select count(*)::int from public.class_sessions where intake_id = 'f5000000-0000-0000-0000-000000000011' and session_date between date '2026-01-12' and date '2026-01-18'), 0, 'BRK no classes are generated in the course''s break');
-- UNIT-PREREQUISITES: prerequisites come from the Training.gov.au text; prerequisite units are laid out first
update public.cms_course_units set tga_prerequisites = 'ASMU2 Use tools' where id = 'unit-asm-1';
select is((select array_agg(x) from public.rto_unit_requires('unit-asm-1') x), array['unit-asm-2'], 'PRE a unit''s prerequisites are read from its Training.gov.au text');
select is((select count(*)::int from public.rto_unit_requires('unit-asm-2')), 0, 'PRE a unit without prerequisite text needs nothing');
select public.intake_generate_schedule('f5000000-0000-0000-0000-000000000001', date '2026-01-05', null, null);
select is((select unit_id from public.intake_units where intake_id = 'f5000000-0000-0000-0000-000000000001' order by sort limit 1), 'unit-asm-2', 'PRE the prerequisite unit is laid out first');

-- ASM-BUILDER: AI mapping suggestions are ticks to confirm (who and when kept); training.gov.au content is the Edge Function's only
select pg_temp.as_postgres();
insert into public.asm_mapping_suggestions(assessment_id, question_id, element_id, confidence, reason, model)
 values (pg_temp.v('assessment')::uuid, '1.1', pg_temp.v('el_pc')::uuid, 0.8, 'Asks which PPE to select', 'mock'),
        (pg_temp.v('assessment')::uuid, '1.2', pg_temp.v('el_ke')::uuid, 0.4, 'Shares a word', 'mock');
select pg_temp.put('sug1', (select id::text from public.asm_mapping_suggestions where assessment_id = pg_temp.v('assessment')::uuid and question_id = '1.1'));
select pg_temp.put('sug2', (select id::text from public.asm_mapping_suggestions where assessment_id = pg_temp.v('assessment')::uuid and question_id = '1.2'));
select throws_ok($$insert into public.tga_unit_content(code, details) values ('not a code', '{}')$$, '23514', null, 'MAP the training.gov.au cache is kept per unit code');
select ok(pg_get_functiondef('public.asm_admin(text,jsonb)'::regprocedure) !~ 'delete from asm_tmp_(keep|scope);', 'MAP asm_admin empties its temp tables with a WHERE (the API refuses a bare DELETE)');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is(jsonb_array_length(public.asm_mapping_suggestions_list(pg_temp.v('assessment')::uuid)), 2, 'MAP an admin lists the suggestions of an assessment');
select is(public.asm_mapping_suggestions_list(pg_temp.v('assessment')::uuid)->0->>'state', 'suggested', 'MAP a suggestion starts as a suggestion, never a mapping');
select ok((select v->>'state' = 'confirmed' and v->>'decidedBy' is not null and v->>'decidedAt' is not null from jsonb_array_elements(public.asm_mapping_decide(array[pg_temp.v('sug1')::uuid], 'confirmed')) v where v->>'id' = pg_temp.s('sug1')), 'MAP confirming records who confirmed and when');
select is(public.asm_mapping_decide(array[pg_temp.v('sug2')::uuid], 'dismissed')->1->>'state', 'dismissed', 'MAP a suggestion can be dismissed');
select throws_ok($$select public.asm_mapping_decide(array[]::uuid[], 'maybe')$$, '22023', null, 'MAP an unknown decision is refused');
select throws_ok($$select count(*) from public.tga_unit_content$$, '42501', null, 'MAP the training.gov.au cache is not read by users (the Edge Function serves it)');
select pg_temp.as_postgres();
select is((select decided_by::text from public.asm_mapping_suggestions where id = pg_temp.v('sug1')::uuid), 'a5000000-0000-0000-0000-000000000001', 'MAP the confirming admin is stored');
select ok(not has_function_privilege('anon', 'public.asm_mapping_decide(uuid[],text)', 'execute') and not has_function_privilege('anon', 'public.asm_mapping_suggestions_list(uuid)', 'execute'), 'MAP anonymous callers cannot list or decide');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$select public.asm_mapping_suggestions_list('%s')$$, pg_temp.v('assessment')), '42501', null, 'MAP a student cannot list suggestions');
select throws_ok(format($$select public.asm_mapping_decide(array['%s']::uuid[], 'confirmed')$$, pg_temp.v('sug2')), '42501', null, 'MAP a student cannot confirm a suggestion');
select throws_ok($$select count(*) from public.asm_mapping_suggestions$$, '42501', null, 'MAP a student reads no suggestion rows');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select throws_ok(format($$select public.asm_mapping_suggestions_list('%s')$$, pg_temp.v('assessment')), '42501', null, 'MAP a trainer cannot list suggestions');
select pg_temp.as_postgres();

-- ASM-UNIT-CHECK (2026-11-25): the unit decision of Add assessment goes to the audit log; kept without a reason is refused
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is(public.asm_import_unit_check(pg_temp.v('assessment')::uuid, '{"kind":"switched","reason":"","foundCode":"RIICWD525E","foundTitle":"Select pavement surfacing","selectedCode":"BSBHRM613","selectedTitle":"Contribute to the development of learning and development strategies"}'::jsonb)->>'decision', 'switched', 'UNIT switching to the workbook''s unit is recorded');
select is(public.asm_import_unit_check(pg_temp.v('assessment')::uuid, '{"kind":"kept","reason":"Mapped to BSBHRM613 by the compliance team","foundCode":"RIICWD525E","selectedCode":"BSBHRM613"}'::jsonb)->>'decision', 'kept', 'UNIT keeping the selected unit with a reason is recorded');
select throws_ok(format($$select public.asm_import_unit_check('%s', '{"kind":"kept","reason":"  ","foundCode":"RIICWD525E","selectedCode":"BSBHRM613"}')$$, pg_temp.v('assessment')), '22023', 'A reason is needed to keep the selected unit', 'UNIT keep without a reason is refused');
select throws_ok(format($$select public.asm_import_unit_check('%s', '{"kind":"ignore"}')$$, pg_temp.v('assessment')), '22023', null, 'UNIT an unknown decision is refused');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_audit_log where target_id = pg_temp.s('assessment') and action = 'import_unit_mismatch' and detail->>'foundCode' = 'RIICWD525E' and detail->>'selectedCode' = 'BSBHRM613' and actor is not null), 2, 'UNIT both decisions are in the audit log with both codes and the admin');
select is((select detail->>'reason' from public.asm_audit_log where target_id = pg_temp.s('assessment') and action = 'import_unit_mismatch' and detail->>'decision' = 'kept'), 'Mapped to BSBHRM613 by the compliance team', 'UNIT the reason is kept');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$select public.asm_import_unit_check('%s', '{"kind":"switched"}')$$, pg_temp.v('assessment')), '42501', null, 'UNIT a student cannot record a unit decision');
select pg_temp.as_postgres();
-- ASM-PDF-TEMPLATE phase 4 (2026-11-26): the old pipeline is gone (import jobs, questions JSON helpers, model answers, question bank)
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname in ('asm_import_start', 'asm_import_claim', 'asm_import_dispatch', 'asm_import_status', 'asm_import_recent',
  'asm_import_key_trace', 'asm_import_auto_resolved', 'asm_definition_questions', 'asm_question_tree', 'asm_validate_definition', 'asm_validate_responses', 'asm_validate_questions', 'asm_autocheck',
  'asm_autocheck_one', 'asm_rollup', 'asm_overview_save', 'asm_condition_met', 'asm_value_present')), 0, 'P4 the import and questions JSON functions are removed');
select is((select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relname in ('asm_import_jobs', 'asm_question_keys', 'asm_question_bank', 'asm_question_bank_versions', 'asm_version_questions')), 0, 'P4 the import jobs, model answers, question bank and question view are removed');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and policyname like 'asm_import_%'), 0, 'P4 the asm-imports bucket has no policies left');
select ok(not exists (select 1 from pg_namespace where nspname = 'cron') or not exists (select 1 from cron.job where jobname = 'asm-import-worker'), 'P4 the import worker cron job is unscheduled');
select ok(to_regprocedure('public.asm_import_unit_check(uuid,jsonb)') is not null, 'P4 the unit-mismatch audit stays');

-- ASM-PDF-TEMPLATE (2026-11-26): the workbook PDF as an e-sign style template: validated like the browser, saved on the draft,
-- the PDF in a private bucket under the assessment, a published version's template frozen and carried to the next draft
create function pg_temp.tpl(p_path text, p_fields jsonb default null) returns jsonb language sql as $$
 select jsonb_build_object('version', 1, 'pdf', jsonb_build_object('path', p_path, 'sha256', repeat('a', 64), 'pages', 3, 'fileName', 'wb.pdf'),
  'pages', '[{"page":1,"kind":"cover","audience":"student","task":null},{"page":2,"kind":"question","audience":"student","task":1},{"page":3,"kind":"declaration","audience":"student","task":1}]'::jsonb, 'tasks', '[]'::jsonb,
  'declarations', '[{"task":1,"page":3,"text":"I declare that the answers I have provided are my own work.","rect":{"page":3,"x":0.3,"y":0.2,"w":0.6,"h":0.3}}]'::jsonb,
  'questions', '[{"key":"1.1","seq":"Q1","label":"Name the legislation","task":1,"header":{"page":2,"x":0.07,"y":0.2,"w":0.86,"h":0.06},"areas":[{"page":2,"x":0.07,"y":0.26,"w":0.86,"h":0.5}]}]'::jsonb,
  'fields', coalesce(p_fields, '[{"id":"p2-1","page":2,"x":0.08,"y":0.27,"w":0.84,"h":0.48,"role":"student","kind":"text","questionKey":"1.1","label":"Answer"},
   {"id":"p2-2","page":2,"x":0.8,"y":0.22,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":"1.1","label":"Satisfactory","option":"yes","group":"q.1.1"},
   {"id":"p1-3","page":1,"x":0.3,"y":0.88,"w":0.6,"h":0.03,"role":"auto","kind":"auto","questionKey":null,"label":"Student Name","dataKey":"student_name"}]'::jsonb),
  'detected', '{"by":"asm-pdf-detect/1","at":"2026-11-26T00:00:00Z"}'::jsonb);
$$;
grant execute on function pg_temp.tpl(text, jsonb) to authenticated;
create temp table tp as select pg_temp.s('assessment') || '/' || repeat('a', 64) || '.pdf' as path;
grant select on tp to authenticated;
select is(jsonb_array_length(public.asm_template_validate(pg_temp.tpl((select path from tp)))), 0, 'TPL a complete template has no problems');
select is(jsonb_array_length(public.asm_template_validate(pg_temp.tpl((select path from tp), '[{"id":"a","page":1,"x":0.1,"y":0.1,"w":0.1,"h":0.1,"role":"auto","kind":"auto","label":"x"},
  {"id":"a","page":9,"x":0.1,"y":0.1,"w":0.1,"h":0.1,"role":"student","kind":"text","label":"x"},
  {"id":"b","page":1,"x":0.95,"y":0.1,"w":0.1,"h":0.1,"role":"student","kind":"text","questionKey":"9.9","label":"x"},
  {"id":"c","page":1,"x":0.1,"y":0.1,"w":0.1,"h":0.1,"role":"trainer","kind":"yes_no","label":"x"}]'::jsonb))), 6, 'TPL every problem is reported (record value, id twice, page, outside, question, choice)');
select is(public.asm_template_validate('{"version":2,"fields":[]}'::jsonb)->>0, 'The template version is not supported.', 'TPL an unknown template version is refused');
select is(jsonb_array_length(public.asm_template_validate(pg_temp.tpl((select path from tp), '[{"id":"m","page":1,"x":0.1,"y":0.1,"w":0.02,"h":0.02,"role":"auto","kind":"auto","label":"Online submission via LMS","dataKey":"submission_method","option":"lms"},
  {"id":"s","page":3,"x":0.3,"y":0.6,"w":0.2,"h":0.05,"role":"student","kind":"signature","label":"Student: Signature","attempt":1,"step":"acknowledge"},
  {"id":"d","page":3,"x":0.3,"y":0.66,"w":0.1,"h":0.02,"role":"auto","kind":"auto","label":"Date","dataKey":"acknowledged_date","attempt":1,"step":"acknowledge"}]'::jsonb))), 0, 'TPL the submission method box and the acknowledgement row are valid');
select is(jsonb_array_length(public.asm_template_validate(pg_temp.tpl((select path from tp), '[{"id":"m","page":1,"x":0.1,"y":0.1,"w":0.02,"h":0.02,"role":"auto","kind":"auto","label":"x","dataKey":"submission_method"},
  {"id":"t","page":3,"x":0.3,"y":0.6,"w":0.2,"h":0.05,"role":"trainer","kind":"signature","label":"x","step":"acknowledge"},
  {"id":"u","page":3,"x":0.3,"y":0.7,"w":0.2,"h":0.05,"role":"student","kind":"text","label":"x","step":"later"}]'::jsonb))), 3, 'TPL a method box needs its method; only the student''s signature and date wait for the acknowledgement; unknown steps refused');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-templates', '%s')$$, (select path from tp)), '42501', null, 'TPL a student cannot upload a workbook');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, pg_temp.tpl((select path from tp))))->'errors'->>0, 'Upload the PDF before saving its template.', 'TPL the PDF is uploaded first');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-templates', '%s/workbook.pdf')$$, pg_temp.v('assessment')), '42501', null, 'TPL the file is named by its hash');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-templates', '%s')$$, (select path from tp)), 'TPL an admin uploads the workbook under the assessment');
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, pg_temp.tpl('00000000-0000-0000-0000-000000000000/' || repeat('a', 64) || '.pdf')))->'errors'->>0, 'The template''s PDF belongs to another assessment.', 'TPL a PDF of another assessment is refused');
select is((public.asm_template_save(pg_temp.v('assessment')::uuid, pg_temp.tpl((select path from tp))))->>'ok', 'true', 'TPL an admin saves the template');
select is((public.asm_template_get(pg_temp.v('assessment')::uuid))->>'status', 'draft', 'TPL the template is read from the draft');
select is(jsonb_array_length((public.asm_template_get(pg_temp.v('assessment')::uuid))->'template'->'fields'), 3, 'TPL its fields come back');
select throws_ok(format($$select public.asm_template_save('%s', pg_temp.tpl((select path from tp)), '2000-01-01T00:00:00Z')$$, pg_temp.v('assessment')), '40001', null, 'TPL a stale save is refused');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_versions where assessment_id = pg_temp.v('assessment')::uuid and status = 'published' and template->'pdf'->>'sha256' <> repeat('c', 64)), 0, 'TPL the published versions are not changed (they keep their own workbook)');
select is((select count(*)::int from public.asm_audit_log where action = 'template_save' and detail->>'assessmentId' = pg_temp.s('assessment') and (detail->>'fields')::int = 3), 1, 'TPL the save is logged once (refused saves are not)');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$select public.asm_template_save('%s', '{}')$$, pg_temp.v('assessment')), '42501', null, 'TPL a student cannot save a template');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-templates' and name = (select path from tp)), 0, 'TPL a student cannot read the draft''s workbook file');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment'))))->>'ok', 'true', 'TPL the draft with its template publishes');
select is((public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'definition',
  (select v.definition from public.asm_versions v join public.asm_assessments a on a.current_version_id = v.id where a.id = pg_temp.v('assessment')::uuid))))->>'ok', 'true', 'TPL the Builder starts the next draft');
select pg_temp.as_postgres();
select is((select jsonb_array_length(template->'fields') from public.asm_versions where assessment_id = pg_temp.v('assessment')::uuid and status = 'draft'), 3, 'TPL the next draft carries the published template');
select throws_ok(format($$update public.asm_versions set template = null where assessment_id = '%s' and status = 'published'$$, pg_temp.v('assessment')), '42501', null, 'TPL a published template never changes');
select ok(not has_function_privilege('anon', 'public.asm_template_save(uuid,jsonb,timestamptz)', 'execute'), 'TPL anonymous callers cannot save templates');

-- ASM-PDF-TEMPLATE phase 2: the student answers on the workbook: the published template version assigned to G2, opened by its student
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is(((public.asm_admin('assignment_create', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'batchIds', '["f5000000-0000-0000-0000-000000000012"]'::jsonb, 'dueAt', (now() + interval '10 days')::text)))->>'created')::int, 1, 'PDF the workbook version is assigned to G2');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select pg_temp.put('pdf_attempt', (select (public.asm_student('assessment_open', jsonb_build_object('assignmentId', a.id)))->'attempt'->>'id' from public.asm_assignments a where a.assessment_id = pg_temp.v('assessment')::uuid and a.intake_id = 'f5000000-0000-0000-0000-000000000012' and a.version_id = (select current_version_id from public.asm_assessments where id = pg_temp.v('assessment')::uuid) limit 1));
select is((select string_agg(f->>'role' || ':' || (f->>'kind'), ',' order by f->>'id') from jsonb_array_elements(public.asm_student_template(pg_temp.v('pdf_attempt'))->'fields') f), 'auto:auto,student:text', 'PDF the student sees their own and the record''s fields, never the trainer''s');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-templates' and name = (select path from tp)), 1, 'PDF the student reads the workbook file of their version');
select is((select string_agg(e->>'code', ',' order by e->>'code') from jsonb_array_elements((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('pdf_attempt'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->'errors') e),
  'declaration,unanswered', 'PDF submit is refused while a question is unanswered and the task declaration is not signed');
-- signatures keep the login details; an earlier tenant check left the request headers empty
select set_config('request.headers', '{}', true);
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('pdf_attempt'), 'responses', '{"pdf":{"p2-1":"Gloves protect the hands."}}'::jsonb)))->>'ok', 'true', 'PDF the answer autosaves');
select throws_ok(format($$select public.asm_pdf_sign('%s', 'ack', 'typed')$$, pg_temp.v('pdf_attempt')), '22023', null, 'PDF only declarations are signed this way (the acknowledgement waits for the result)');
select pg_temp.put('decl1', public.asm_pdf_sign(pg_temp.v('pdf_attempt')::uuid, 'decl:1', 'typed', null, 'I declare that the answers I have provided are my own work.')::text);
select is(pg_temp.s('decl1')::jsonb->>'slot', 'decl:1', 'PDF the student signs the Task 1 declaration');
select is((public.asm_pdf_sign(pg_temp.v('pdf_attempt')::uuid, 'decl:1', 'typed'))->>'signedAt', pg_temp.s('decl1')::jsonb->>'signedAt', 'PDF signing it again keeps the first signature and its date');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('pdf_attempt'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->>'ok', 'true', 'PDF answered and the declaration signed: submitted');
select throws_ok(format($$select public.asm_pdf_sign('%s', 'decl:2', 'typed')$$, pg_temp.v('pdf_attempt')), '22023', null, 'PDF nothing is signed after the submission');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select throws_ok(format($$select public.asm_student_template('%s')$$, pg_temp.v('pdf_attempt')), '42501', null, 'PDF another student cannot read the attempt''s template');
select throws_ok(format($$select public.asm_pdf_attempt('%s')$$, pg_temp.v('pdf_attempt')), '42501', null, 'PDF another student cannot read the attempt');
select pg_temp.as_postgres();
select is((select declaration->>'text' from public.asm_attempts where id = pg_temp.v('pdf_attempt')::uuid), 'I declare that the answers I have provided are my own work.', 'PDF the workbook''s own declaration wording is kept with the submission');
-- the locked snapshot of the submission
select is((select s.answers->'pdf'->>'p2-1' || ' | ' || (s.signatures ? 'decl:1')::text || ' | ' || (s.record->>'studentName') from public.asm_attempt_snapshots s where s.attempt_id = pg_temp.v('pdf_attempt')::uuid),
  'Gloves protect the hands. | true | Sue Student', 'PDF the submission keeps a snapshot of the answers, the signatures and the record');
select is((select s.hash = public.asm_snapshot_hash(s.answers, s.signatures, s.record, s.template_sha256) from public.asm_attempt_snapshots s where s.attempt_id = pg_temp.v('pdf_attempt')::uuid), true, 'PDF the snapshot''s hash is the SHA-256 of what it holds');
select throws_ok(format($$update public.asm_attempt_snapshots set answers = '{}' where attempt_id = '%s'$$, pg_temp.v('pdf_attempt')), '42501', null, 'PDF a snapshot is never changed');
select throws_ok(format($$delete from public.asm_pdf_signatures where attempt_id = '%s'$$, pg_temp.v('pdf_attempt')), '42501', null, 'PDF a declaration signature is never removed');
select pg_temp.put('snap_hash', (select hash from public.asm_attempt_snapshots where attempt_id = pg_temp.v('pdf_attempt')::uuid));
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select is((public.asm_pdf_attempt(pg_temp.v('pdf_attempt')::uuid))->'attempts'->0->'snapshot'->>'hash', pg_temp.s('snap_hash'), 'PDF the student reads their submitted attempt (drawn from its snapshot)');
select is(jsonb_array_length((public.asm_pdf_attempt(pg_temp.v('pdf_attempt')::uuid))->'attempts'->0->'results'), 0, 'PDF no marks reach the student before the result is released');
-- ASM-PDF-TEMPLATE phase 3: marking on the template: task results from the question marks, the release, the final PDF (G2's trainer, given the trainer role)
select pg_temp.as_postgres();
insert into hr.staff_roles(profile_id, role, granted_by) values ('b5000000-0000-0000-0000-000000000004', 'trainer', 'a5000000-0000-0000-0000-000000000001') on conflict do nothing;
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('pdf_attempt'), 'results', '[{"questionId":"1.1","outcome":"S","feedback":"Clear."}]'::jsonb, 'taskResults', '[{"taskId":"1","feedback":"Well done."}]'::jsonb,
  'assessorResponses', '{"pdf":{},"pdfChoice":{}}'::jsonb)))->>'state', 'marking', 'MARK the trainer marks the question on the workbook');
select is((select outcome from public.asm_task_results where attempt_id = pg_temp.v('pdf_attempt')::uuid and task_id = '1'), 'S', 'MARK the task result follows its questions'' marks (all Yes = Satisfactory)');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('pdf_attempt'), 'outcome', 'S', 'overallFeedback', 'Competent.')))->>'ok', 'true', 'MARK every task of the template has a result: the result is released');
select throws_ok(format($$select public.asm_pdf_output_record('%s', '%s/final-%s.pdf', '%s')$$, pg_temp.v('pdf_attempt'), pg_temp.v('pdf_attempt'), repeat('d', 64), repeat('d', 64)), 'P0002', 'Upload the PDF first', 'MARK the final PDF is uploaded before it is recorded');
select throws_ok(format($$select public.asm_pdf_output_record('%s', '%s/final-x.pdf', 'x')$$, pg_temp.v('pdf_attempt'), pg_temp.v('pdf_attempt')), '22023', null, 'MARK the file is named by its SHA-256');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/final-%s.pdf')$$, pg_temp.v('pdf_attempt'), repeat('d', 64)), 'MARK an assessor uploads the final PDF of a final attempt');
select is((public.asm_pdf_output_record(pg_temp.v('pdf_attempt')::uuid, pg_temp.v('pdf_attempt') || '/final-' || repeat('d', 64) || '.pdf', repeat('d', 64)))->>'snapshot_hash',
  pg_temp.s('snap_hash'), 'MARK the stored final PDF records the snapshot hash it was drawn from');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-output'), 1, 'MARK the student reads their final PDF');
select is((public.asm_pdf_attempt(pg_temp.v('pdf_attempt')::uuid))->'attempts'->0->'results'->0->>'feedback', 'Clear.', 'MARK once released the student reads the marks and comments');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/final-%s.pdf')$$, pg_temp.v('pdf_attempt'), repeat('e', 64)), '42501', null, 'MARK a student cannot store a final PDF');
select pg_temp.as_postgres();
select throws_ok(format($$delete from public.asm_attempt_outputs where attempt_id = '%s'$$, pg_temp.v('pdf_attempt')), '42501', null, 'MARK a stored final PDF record is never removed');
select is(public.asm_template_missing(pg_temp.tpl('a/b.pdf', '[{"id":"s","page":3,"x":0.3,"y":0.6,"w":0.2,"h":0.05,"role":"student","kind":"signature","label":"Student Signature","slot":"pack"},
  {"id":"t","page":2,"x":0.1,"y":0.3,"w":0.8,"h":0.3,"role":"student","kind":"text","questionKey":"1.1","label":"b. Part two","required":true},
  {"id":"u","page":2,"x":0.1,"y":0.7,"w":0.8,"h":0.1,"role":"student","kind":"text","questionKey":"1.1","label":"Answer"}]'::jsonb), '{"pdf":{"u":"x"}}'::jsonb, '{decl:1,pack}')->>0,
  '{"code": "required", "fieldId": "t", "message": "Q1: \"b. Part two\" is empty.", "questionKey": "1.1"}', 'PDF a required part left empty is named like the browser names it');
select is((select string_agg(m->>'message', ' | ') from jsonb_array_elements(public.asm_template_missing(pg_temp.tpl('a/b.pdf', '[{"id":"s","page":3,"x":0.3,"y":0.6,"w":0.2,"h":0.05,"role":"student","kind":"signature","label":"Student Signature","slot":"pack"}]'::jsonb), '{}'::jsonb, '{}')) m),
  'Sign the Task 1 declaration. | Sign the student declaration (page 3).', 'PDF each declaration is signed on its own: the task''s and the whole pack''s');
select is((select string_agg(m->>'message', ' | ') from jsonb_array_elements(public.asm_template_missing(jsonb_build_object('pages', '[]'::jsonb, 'questions', '[{"key":"1.3","seq":"Q3","display":"Q3","task":1},{"key":"2.11","seq":"Q11","display":"Q11","task":2}]'::jsonb,
  'fields', '[{"id":"a","page":1,"role":"student","kind":"table_cell","questionKey":"1.3","label":"x","table":{"row":0,"col":0,"group":"1.3#1","rowKey":"a","fixed":true}},
   {"id":"b","page":1,"role":"student","kind":"table_cell","questionKey":"1.3","label":"x","table":{"row":1,"col":0,"group":"1.3#1","rowKey":"b","fixed":true}},
   {"id":"c","page":1,"role":"student","kind":"table_cell","questionKey":"2.11","label":"x","table":{"row":0,"col":0,"group":"2.11#1","rowKey":"c"}},
   {"id":"d","page":1,"role":"student","kind":"table_cell","questionKey":"2.11","label":"x","table":{"row":0,"col":1,"group":"2.11#1","rowKey":"c"}}]'::jsonb), '{"pdf":{"a":"Brushes","c":"Roller"}}'::jsonb, '{}')) m),
  'Q3: 1 empty cell in the table. | Q11: fill in at least one complete row of the table.', 'PDF tables: every cell of printed rows, at least one complete blank row (as in the browser)');
select is((select string_agg(m->>'message', ' | ') from jsonb_array_elements(public.asm_template_missing(jsonb_build_object('pages', '[]'::jsonb, 'questions', '[{"key":"1.2","seq":"Q2","display":"Q2","task":1},{"key":"2.2","seq":"Q2","display":"Q2","task":2}]'::jsonb, 'fields', '[{"id":"a","page":1,"role":"student","kind":"text","questionKey":"1.2","label":"x"},{"id":"b","page":1,"role":"student","kind":"text","questionKey":"2.2","label":"x"}]'::jsonb), '{}', '{}')) m), 'Task 1 · Q2 is not answered yet. | Task 2 · Q2 is not answered yet.', 'PDF a number printed in two tasks is named with its task, as in the browser');
-- ASM-PDF-TEMPLATE review (owner 2026-11-26): the real submit refuses incomplete tables with the browser's words; each attempt keeps
-- its own snapshot (attempt 1's never changes after a return); the trainer's side locks once released; the final PDF records the marks.
-- A workbook shaped like CPCCPD2012: Task 1 Q3 (a table of printed rows), Task 2 Q3 (a text answer), Task 2 Q11 (two blank-row tables).
create function pg_temp.tpl2(p_path text) returns jsonb language sql as $$
 select jsonb_build_object('version', 1, 'pdf', jsonb_build_object('path', p_path, 'sha256', repeat('b', 64), 'pages', 4, 'fileName', 'cpc.pdf'),
  'pages', '[{"page":1,"kind":"question","audience":"student","task":1},{"page":2,"kind":"question","audience":"student","task":2},{"page":3,"kind":"question","audience":"student","task":2},{"page":4,"kind":"marking_checklist","audience":"trainer","task":2}]'::jsonb,
  'tasks', '[{"number":"1","title":"Questioning","firstPage":1,"lastPage":1},{"number":"2","title":"Workshop","firstPage":2,"lastPage":4}]'::jsonb,
  'questions', '[{"key":"1.3","seq":"Q3","display":"Q3","label":"Tools","task":1,"header":{"page":1,"x":0.07,"y":0.1,"w":0.86,"h":0.05},"areas":[]},
    {"key":"2.3","seq":"Q3","display":"Q3","label":"Selection log","task":2,"header":{"page":2,"x":0.07,"y":0.1,"w":0.86,"h":0.05},"areas":[]},
    {"key":"2.11","seq":"Q11","display":"Q11","label":"Cleaning","task":2,"header":{"page":3,"x":0.07,"y":0.1,"w":0.86,"h":0.05},"areas":[]}]'::jsonb,
  'fields', '[
   {"id":"a1","page":1,"x":0.4,"y":0.2,"w":0.2,"h":0.05,"role":"student","kind":"table_cell","questionKey":"1.3","label":"Buckets · Uses","table":{"row":1,"col":1,"rowLabel":"Buckets","column":"Uses","group":"1.3#1","rowKey":"a1","fixed":true}},
   {"id":"a2","page":1,"x":0.4,"y":0.3,"w":0.2,"h":0.05,"role":"student","kind":"table_cell","questionKey":"1.3","label":"Hammers · Uses","table":{"row":2,"col":1,"rowLabel":"Hammers","column":"Uses","group":"1.3#1","rowKey":"a2","fixed":true}},
   {"id":"t23","page":2,"x":0.1,"y":0.2,"w":0.8,"h":0.3,"role":"student","kind":"text","questionKey":"2.3","label":"Answer","required":true},
   {"id":"b1","page":3,"x":0.1,"y":0.2,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Tool","table":{"row":1,"col":0,"column":"Tool","group":"2.11#1","rowKey":"b1"}},
   {"id":"b2","page":3,"x":0.5,"y":0.2,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Cleaned","table":{"row":1,"col":1,"column":"Cleaned","group":"2.11#1","rowKey":"b1"}},
   {"id":"c1","page":3,"x":0.1,"y":0.5,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Waste","table":{"row":3,"col":0,"column":"Waste","group":"2.11#2","rowKey":"c1"}},
   {"id":"c2","page":3,"x":0.5,"y":0.5,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Method","table":{"row":3,"col":1,"column":"Method","group":"2.11#2","rowKey":"c1"}},
   {"id":"c3","page":3,"x":0.1,"y":0.6,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Waste","table":{"row":4,"col":0,"column":"Waste","group":"2.11#2","rowKey":"c3"}},
   {"id":"c4","page":3,"x":0.5,"y":0.6,"w":0.3,"h":0.05,"role":"student","kind":"table_cell","questionKey":"2.11","label":"Method","table":{"row":4,"col":1,"column":"Method","group":"2.11#2","rowKey":"c3"}},
   {"id":"e1y","page":4,"x":0.75,"y":0.2,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":null,"label":"Submitted written answers","option":"yes","group":"p4.ev1","checklist":"evidence"},
   {"id":"e1n","page":4,"x":0.85,"y":0.2,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":null,"label":"Submitted written answers","option":"no","group":"p4.ev1","checklist":"evidence"},
   {"id":"p1y","page":4,"x":0.75,"y":0.4,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":null,"label":"Plan work","option":"yes","group":"p4.pf1","checklist":"performance"},
   {"id":"p1n","page":4,"x":0.85,"y":0.4,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":null,"label":"Plan work","option":"no","group":"p4.pf1","checklist":"performance"},
   {"id":"p2y","page":4,"x":0.75,"y":0.5,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":"2.3","label":"Selection log","option":"yes","group":"p4.pf2","checklist":"performance"},
   {"id":"p2n","page":4,"x":0.85,"y":0.5,"w":0.02,"h":0.015,"role":"trainer","kind":"yes_no","questionKey":"2.3","label":"Selection log","option":"no","group":"p4.pf2","checklist":"performance"}]'::jsonb);
$$;
grant execute on function pg_temp.tpl2(text) to authenticated;
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.put('cpc', (public.asm_admin('assessment_create', jsonb_build_object('courseId', 'course-asm-test', 'unitId', 'unit-asm-1', 'code', 'ASMU1-PDF', 'title', 'Workbook-shaped')))->>'id');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-templates', '%s/%s.pdf')$$, pg_temp.v('cpc'), repeat('b', 64)), 'REAL the workbook PDF is uploaded');
select is((public.asm_template_save(pg_temp.v('cpc')::uuid, pg_temp.tpl2(pg_temp.s('cpc') || '/' || repeat('b', 64) || '.pdf')))->>'ok', 'true', 'REAL its template is saved');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('cpc'))))->>'ok', 'true', 'REAL a workbook version publishes on its template');
select is(((public.asm_admin('assignment_create', jsonb_build_object('assessmentId', pg_temp.v('cpc'), 'batchIds', '["f5000000-0000-0000-0000-000000000012"]'::jsonb, 'dueAt', (now() + interval '10 days')::text)))->>'created')::int, 1, 'REAL assigned to G2');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select pg_temp.put('r1', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', (select id from public.asm_assignments where assessment_id = pg_temp.v('cpc')::uuid))))->'attempt'->>'id');
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('r1'), 'responses', '{"pdf":{"a1":"Holds paint","t23":"Rollers for walls","b1":"Roller","b2":"Yes","c1":"Rags","c2":"Bin","c3":"","c4":""}}'::jsonb)))->>'ok', 'true', 'REAL the answers are saved');
select is((select string_agg(e->>'message', ' | ') from jsonb_array_elements((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('r1'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->'errors') e),
  'Task 1 · Q3: 1 empty cell in the table.', 'REAL submit refuses a table of printed rows with one empty cell, in the browser''s words');
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('r1'), 'responses', '{"pdf":{"a1":"Holds paint","a2":"Sets nails","t23":"Rollers for walls","b1":"Roller","b2":"Yes","c1":"Rags","c2":"","c3":"","c4":""}}'::jsonb)))->>'ok', 'true', 'REAL the answers change');
select is((select string_agg(e->>'message', ' | ') from jsonb_array_elements((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('r1'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->'errors') e),
  'Q11: fill in at least one complete row of the table (table 2 of 2).', 'REAL submit refuses a blank-row table whose only row is part-filled, in the browser''s words');
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('r1'), 'responses', '{"pdf":{"a1":"Holds paint","a2":"Sets nails","t23":"Rollers for walls","b1":"Roller","b2":"Yes","c1":"Rags","c2":"Bin","c3":"","c4":""}}'::jsonb)))->>'ok', 'true', 'REAL one complete row');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('r1'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->>'ok', 'true', 'REAL complete: submitted');
select pg_temp.as_postgres();
select pg_temp.put('h1', (select hash from public.asm_attempt_snapshots where attempt_id = pg_temp.v('r1')::uuid));
select pg_temp.put('h1rec', (select s.answers::text || s.signatures::text || s.record::text from public.asm_attempt_snapshots s where s.attempt_id = pg_temp.v('r1')::uuid));
-- the trainer marks attempt 1 Not Yet Satisfactory, signs off and returns it
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('r1'), 'results', '[{"questionId":"1.3","outcome":"S"},{"questionId":"2.3","outcome":"NYS","feedback":"Name the rollers."},{"questionId":"2.11","outcome":"S"}]'::jsonb,
  'taskResults', '[{"taskId":"1","feedback":"Good."},{"taskId":"2","feedback":"Q3 again."}]'::jsonb, 'assessorResponses', '{"pdf":{"office":"x"},"pdfChoice":{}}'::jsonb, 'overallFeedback', 'Nearly there.')))->>'state', 'marking', 'REAL attempt 1 marked');
select is((select string_agg(task_id || ':' || outcome, ',' order by task_id) from public.asm_task_results where attempt_id = pg_temp.v('r1')::uuid), '1:S,2:NYS', 'REAL task results follow the marks');
select is((public.asm_sign(pg_temp.v('r1')::uuid, 'assessor_signoff', 'typed'))->>'kind', 'assessor_signoff', 'REAL the assessor signs off attempt 1');
select is((select string_agg(e->>'message', ' | ') from jsonb_array_elements((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('r1'), 'outcome', 'NYS', 'overallFeedback', 'Nearly there.')))->'errors') e),
  'Marking checklist, page 4: "Submitted written answers" has no Yes / No. | Marking checklist, page 4: "Plan work" has no Yes / No.', 'RELEASE waits for the Evidence row and the activity Performance row, listed (the Performance row of a question follows its mark)');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('r1'), 'assessorResponses', '{"pdf":{"office":"x"},"pdfChoice":{"p4.ev1":"yes","p4.pf1":"no"}}'::jsonb)))->>'state', 'marking', 'RELEASE the trainer ticks the checklist rows');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('r1'), 'outcome', 'NYS', 'overallFeedback', 'Nearly there.')))->>'ok', 'true', 'REAL attempt 1 returned for resubmission');
-- once released the trainer's side of attempt 1 never changes
select throws_ok(format($$select public.asm_trainer('mark_save', jsonb_build_object('id', '%s', 'results', '[{"questionId":"2.3","outcome":"S"}]'::jsonb))$$, pg_temp.v('r1')), '42501', null, 'LOCK a returned attempt is no longer open for marking');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_results set outcome = 'S' where attempt_id = '%s' and question_id = '2.3'$$, pg_temp.v('r1')), '42501', null, 'LOCK a released question mark cannot change');
select throws_ok(format($$update public.asm_task_results set feedback = 'changed' where attempt_id = '%s'$$, pg_temp.v('r1')), '42501', null, 'LOCK a released task result and its feedback cannot change');
select throws_ok(format($$update public.asm_attempts set overall_feedback = 'changed' where id = '%s'$$, pg_temp.v('r1')), '42501', null, 'LOCK the released overall feedback cannot change');
select throws_ok(format($$update public.asm_attempts set outcome = 'S' where id = '%s'$$, pg_temp.v('r1')), '42501', null, 'LOCK the released outcome cannot change');
select throws_ok(format($$update public.asm_attempts set assessor_responses = '{}' where id = '%s'$$, pg_temp.v('r1')), '42501', null, 'LOCK the trainer''s released fields cannot change');
select throws_ok(format($$update public.asm_attempt_signatures set signer_name = 'Someone else' where attempt_id = '%s' and kind = 'assessor_signoff'$$, pg_temp.v('r1')), '42501', null, 'LOCK the assessor''s sign-off cannot change');
-- attempt 2 starts from attempt 1's answers; its own snapshot; attempt 1's never changes
select pg_temp.put('r2', (select id::text from public.asm_attempts where assignment_id = (select assignment_id from public.asm_attempts where id = pg_temp.v('r1')::uuid) and attempt_no = 2));
select is((select responses->'pdf'->>'t23' from public.asm_attempts where id = pg_temp.v('r2')::uuid), 'Rollers for walls', 'SNAP attempt 2 starts from attempt 1''s answers');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select is((public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('r2'), 'responses', '{"pdf":{"a1":"Holds paint","a2":"Sets nails","t23":"Lambswool rollers for walls, mohair for gloss","b1":"Roller","b2":"Yes","c1":"Rags","c2":"Bin"}}'::jsonb)))->>'ok', 'true', 'SNAP attempt 2 is changed');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('r2'), 'declaration', '{"signature":"Sue Student","agreed":true}'::jsonb)))->>'ok', 'true', 'SNAP attempt 2 submitted');
select pg_temp.as_postgres();
select is((select count(*)::int from public.asm_attempt_snapshots where attempt_id in (pg_temp.v('r1')::uuid, pg_temp.v('r2')::uuid)), 2, 'SNAP each attempt has its own snapshot');
select is((select hash from public.asm_attempt_snapshots where attempt_id = pg_temp.v('r1')::uuid), pg_temp.s('h1'), 'SNAP attempt 1''s snapshot hash is unchanged after the return and the resubmission');
select is((select s.answers::text || s.signatures::text || s.record::text from public.asm_attempt_snapshots s where s.attempt_id = pg_temp.v('r1')::uuid), pg_temp.s('h1rec'), 'SNAP attempt 1''s snapshot content is unchanged');
select isnt((select hash from public.asm_attempt_snapshots where attempt_id = pg_temp.v('r2')::uuid), pg_temp.s('h1'), 'SNAP attempt 2 has its own hash');
select is((select answers->'pdf'->>'t23' || ' / ' || (record->>'attemptNo') from public.asm_attempt_snapshots where attempt_id = pg_temp.v('r2')::uuid), 'Lambswool rollers for walls, mohair for gloss / 2', 'SNAP attempt 2''s snapshot holds its own answers');
-- attempt 2: Competent, final; the final PDF records the snapshot and the marks; then nothing of attempt 2 changes
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('r2'), 'results', '[{"questionId":"1.3","outcome":"S"},{"questionId":"2.3","outcome":"S","feedback":"Good."}]'::jsonb,
  'taskResults', '[{"taskId":"1","feedback":"Good."},{"taskId":"2","feedback":"Done."}]'::jsonb, 'overallFeedback', 'Competent.')))->>'state', 'marking', 'REAL attempt 2 partly marked');
select is((public.asm_sign(pg_temp.v('r2')::uuid, 'assessor_signoff', 'typed'))->>'kind', 'assessor_signoff', 'REAL attempt 2 signed off');
select is((select string_agg(e->>'message', ' | ') from jsonb_array_elements((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('r2'), 'outcome', 'S', 'overallFeedback', 'Competent.')))->'errors') e),
  'Q11 is not marked yet. | Marking checklist, page 4: "Submitted written answers" has no Yes / No. | Marking checklist, page 4: "Plan work" has no Yes / No.', 'RELEASE each attempt answers its own checklist: attempt 2 starts with none, and an unmarked question is listed');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('r2'), 'results', '[{"questionId":"2.11","outcome":"S"}]'::jsonb, 'assessorResponses', '{"pdf":{},"pdfChoice":{"p4.ev1":"no","p4.pf1":"yes"}}'::jsonb)))->>'state', 'marking', 'REAL attempt 2 fully marked, its checklist answered');
select is((select outcome from public.asm_task_results where attempt_id = pg_temp.v('r2')::uuid and task_id = '2'), 'S', 'RELEASE a question marked in a later save updates its task result (the save names no task)');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('r2'), 'outcome', 'S', 'overallFeedback', 'Competent.')))->>'ok', 'true', 'REAL attempt 2 released Competent (final)');
select is((public.asm_pdf_attempt(pg_temp.v('r1')::uuid))->'attempts'->0->'assessorResponses'->'pdfChoice'->>'p4.ev1', 'yes', 'HISTORY attempt 1 keeps its own checklist answers after attempt 2 is marked (its PDF is drawn from them)');
select is(jsonb_array_length((public.asm_pdf_attempt(pg_temp.v('r1')::uuid))->'attempts'), 1, 'HISTORY attempt 1''s PDF holds attempt 1 only (its own snapshot and marks)');
select is((public.asm_pdf_attempt(pg_temp.v('r2')::uuid))->'attempts'->1->'assessorResponses'->'pdfChoice'->>'p4.ev1', 'no', 'HISTORY attempt 2 has its own checklist answers');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/final-%s.pdf')$$, pg_temp.v('r2'), repeat('f', 64)), 'REAL the final PDF is uploaded');
select pg_temp.put('out2', public.asm_pdf_output_record(pg_temp.v('r2')::uuid, pg_temp.s('r2') || '/final-' || repeat('f', 64) || '.pdf', repeat('f', 64))::text);
select pg_temp.as_postgres();
select is((pg_temp.s('out2')::jsonb->>'snapshot_hash') = (select hash from public.asm_attempt_snapshots where attempt_id = pg_temp.v('r2')::uuid), true, 'REAL the final PDF records attempt 2''s snapshot hash');
select is((select (o.marking->>'outcome') || ':' || jsonb_array_length(o.marking->'results') || ':' || (o.marking->'taskResults'->1->>'feedback') || ':' || (o.marking->'signoff'->>'signerName' is not null)::text
  || ':' || (o.marking_hash = encode(sha256(convert_to(o.marking::text, 'UTF8')), 'hex'))::text from public.asm_attempt_outputs o where o.attempt_id = pg_temp.v('r2')::uuid), 'S:3:Done.:true:true', 'REAL the final PDF records the marks, task results, feedback and sign-off, with their hash');
select throws_ok(format($$update public.asm_attempts set overall_feedback = 'changed' where id = '%s'$$, pg_temp.v('r2')), '42501', null, 'LOCK a final result cannot change');
select throws_ok(format($$update public.asm_results set feedback = 'changed' where attempt_id = '%s'$$, pg_temp.v('r2')), '42501', null, 'LOCK a final question comment cannot change');
select throws_ok(format($$update public.asm_attempt_outputs set marking = '{}' where attempt_id = '%s'$$, pg_temp.v('r2')), '42501', null, 'LOCK the stored final PDF record cannot change');
-- the acknowledged copy (owner 2026-11-26): stored once the student has acknowledged, beside the sign-off copy, the official record from then on
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/acknowledged-%s.pdf')$$, pg_temp.v('r2'), repeat('a', 64)), '42501', null, 'ACK the student cannot store the acknowledged copy before acknowledging');
select throws_ok(format($$select public.asm_pdf_output_record('%s', '%s/acknowledged-%s.pdf', '%s', 'acknowledged')$$, pg_temp.v('r2'), pg_temp.v('r2'), repeat('a', 64), repeat('a', 64)), '22023', 'The student has not acknowledged the result yet', 'ACK no acknowledged copy before the acknowledgement');
select is((public.asm_sign(pg_temp.v('r2')::uuid, 'student_acknowledgement', 'typed', null, 'I declare that I have been assessed in this unit, and I have been advised of my result. I also am aware of my appeal rights.'))->>'kind', 'student_acknowledgement', 'ACK the student acknowledges the result');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/final-%s.pdf')$$, pg_temp.v('r2'), repeat('b', 64)), '42501', null, 'ACK the student still cannot store a sign-off copy');
select throws_ok(format($$select public.asm_pdf_output_record('%s', '%s/final-%s.pdf', '%s', 'final')$$, pg_temp.v('r2'), pg_temp.v('r2'), repeat('b', 64), repeat('b', 64)), '42501', null, 'ACK the student cannot record a sign-off copy');
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-output', '%s/acknowledged-%s.pdf')$$, pg_temp.v('r2'), repeat('a', 64)), 'ACK the student''s browser uploads the acknowledged copy');
select is((public.asm_pdf_output_record(pg_temp.v('r2')::uuid, pg_temp.s('r2') || '/acknowledged-' || repeat('a', 64) || '.pdf', repeat('a', 64), 'acknowledged'))->>'kind', 'acknowledged', 'ACK the acknowledged copy is recorded');
select is((public.asm_pdf_output_record(pg_temp.v('r2')::uuid, pg_temp.s('r2') || '/acknowledged-' || repeat('a', 64) || '.pdf', repeat('a', 64), 'acknowledged'))->>'pdf_sha256', repeat('a', 64), 'ACK recording it again returns the first copy (it stands)');
select is((public.asm_pdf_attempt(pg_temp.v('r2')::uuid))->'attempts'->1->'output'->>'kind', 'acknowledged', 'ACK the official record is the acknowledged copy');
select is((select string_agg(o->>'kind', ',' order by o->>'kind') from jsonb_array_elements((public.asm_pdf_attempt(pg_temp.v('r2')::uuid))->'attempts'->1->'outputs') o), 'acknowledged,final', 'ACK both copies are kept and listed');
select pg_temp.as_postgres();
select is((select string_agg(o.kind || ':' || (o.snapshot_hash = s.hash)::text || ':' || (o.marking_hash = encode(sha256(convert_to(o.marking::text, 'UTF8')), 'hex'))::text
  || ':' || (o.acknowledgement_hash <> '')::text || ':' || (o.acknowledgement_hash = '' or o.acknowledgement_hash = encode(sha256(convert_to(o.acknowledgement::text, 'UTF8')), 'hex'))::text, ',' order by o.kind)
  from public.asm_attempt_outputs o join public.asm_attempt_snapshots s on s.attempt_id = o.attempt_id where o.attempt_id = pg_temp.v('r2')::uuid),
  'acknowledged:true:true:true:true,final:true:true:false:true', 'ACK each copy keeps the snapshot, marking and acknowledgement hashes it was drawn from');
select is((select (a.marking_hash = f.marking_hash)::text || ':' || (a.acknowledgement->>'signerName' is not null)::text || ':' || (a.acknowledgement->>'statement')
  from public.asm_attempt_outputs a join public.asm_attempt_outputs f on f.attempt_id = a.attempt_id and f.kind = 'final' where a.attempt_id = pg_temp.v('r2')::uuid and a.kind = 'acknowledged'),
  'true:true:I declare that I have been assessed in this unit, and I have been advised of my result. I also am aware of my appeal rights.', 'ACK the marking is the same in both copies; the acknowledged copy names who acknowledged and the statement');
select throws_ok(format($$delete from public.asm_attempt_outputs where attempt_id = '%s' and kind = 'acknowledged'$$, pg_temp.v('r2')), '42501', null, 'ACK the acknowledged copy is never removed');
select * from finish();
rollback;
