begin;
-- Assessment Management (ASM-01): tenant isolation, student ownership, trainer scope, publication permission, evidence policy,
-- assessor-key leakage, locked attempts, history preservation, sign-off authority, audit, concurrency, tampered ids, versioning,
-- validation, auto-check suggestions, calendar and batch reassignment. Fixtures only; rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(263);

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
insert into public.cms_courses(id, slug, code, name, status) values ('course-asm-test', 'asm-test-course', 'ASM101', 'ASM Test Course', 'Published');
insert into public.cms_course_units(id, course_id, code, name) values ('unit-asm-1', 'course-asm-test', 'ASMU1', 'Work safely'), ('unit-asm-2', 'course-asm-test', 'ASMU2', 'Use tools');
insert into public.course_intakes(id, course_id, start_date, end_date, label) values ('f5000000-0000-0000-0000-000000000001', 'course-asm-test', date '2026-01-05', date '2026-12-18', 'Jan 2026');
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values ('f5000000-0000-0000-0000-000000000001', 'unit-asm-1', date '2026-01-05', date '2026-12-18');
insert into public.batches(id, intake_id, name) values ('f5000000-0000-0000-0000-000000000011', 'f5000000-0000-0000-0000-000000000001', 'G1'), ('f5000000-0000-0000-0000-000000000012', 'f5000000-0000-0000-0000-000000000001', 'G2');
insert into public.batch_trainers(batch_id, staff_id) values ('f5000000-0000-0000-0000-000000000011', 'b5000000-0000-0000-0000-000000000003'), ('f5000000-0000-0000-0000-000000000012', 'b5000000-0000-0000-0000-000000000004');
insert into public.batch_enrolments(batch_id, student_id) values
 ('f5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000011'), ('f5000000-0000-0000-0000-000000000011', 'e5000000-0000-0000-0000-000000000013'),
 ('f5000000-0000-0000-0000-000000000012', 'e5000000-0000-0000-0000-000000000012');
-- a second institution with its own course (tenant isolation)
insert into public.tenants(id, slug, name) values ('15000000-0000-0000-0000-000000000002', 'asm-other', 'Other Institute');
insert into public.cms_courses(id, slug, code, name, status, tenant_id) values ('course-asm-other', 'asm-other-course', 'ASM202', 'Other Course', 'Published', '15000000-0000-0000-0000-000000000002');

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claim.sub', p::text, true); end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create function pg_temp.definition() returns jsonb language sql immutable as $j$ select $d${"instructions":"Read everything first.","tasks":[
 {"id":"t1","title":"Knowledge questions","sections":[{"id":"s1","title":"Part A","questions":[
  {"id":"q_intro","type":"instruction","label":"Welcome","markingMode":"none"},
  {"id":"q_short","type":"short_answer","label":"Describe PPE","required":true,"markingMode":"criteria","responseSchema":{"type":"string","minWords":2,"maxWords":50},"criteria":[{"id":"c1","text":"Names two items"},{"id":"c2","text":"Explains use"}]},
  {"id":"q_long","type":"long_answer","label":"Explain the process","required":false,"markingMode":"rubric","responseSchema":{"type":"string","maxWords":400},"rubric":{"levels":[{"id":"r1","label":"Developing","score":1},{"id":"r2","label":"Competent","score":2}]}},
  {"id":"q_single","type":"single_choice","label":"Pick one","required":true,"markingMode":"auto","config":{"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},"responseSchema":{"type":"string","enum":["a","b"]}},
  {"id":"q_cond","type":"short_answer","label":"Why A?","required":true,"markingMode":"criteria","showIf":{"questionId":"q_single","op":"eq","value":"a"},"responseSchema":{"type":"string"}},
  {"id":"q_multi","type":"multi_choice","label":"Pick many","required":true,"markingMode":"auto","responseSchema":{"type":"array","items":{"type":"string","enum":["x","y","z"]},"minItems":1}},
  {"id":"q_tf","type":"true_false","label":"The sky is blue","required":true,"markingMode":"auto","responseSchema":{"type":"boolean"}},
  {"id":"q_match","type":"matching","label":"Match","required":true,"markingMode":"auto","responseSchema":{"type":"object","requiredKeys":["l1","l2"]}},
  {"id":"q_order","type":"ordering","label":"Order","required":true,"markingMode":"auto","responseSchema":{"type":"array","minItems":3,"maxItems":3,"uniqueItems":true}},
  {"id":"q_blank","type":"fill_blanks","label":"Fill","required":true,"markingMode":"auto","responseSchema":{"type":"array","minItems":2,"maxItems":2}},
  {"id":"q_grid","type":"table_grid","label":"Grid","required":true,"markingMode":"criteria","responseSchema":{"type":"object"}},
  {"id":"q_likert","type":"likert","label":"Rate","required":false,"markingMode":"none","responseSchema":{"type":"integer","minimum":1,"maximum":5}},
  {"id":"q_num","type":"number","label":"How many","required":true,"markingMode":"auto","responseSchema":{"type":"number","minimum":0,"maximum":100}},
  {"id":"q_date","type":"date","label":"When","required":true,"markingMode":"criteria","responseSchema":{"type":"string","format":"date"}},
  {"id":"q_file","type":"file_upload","label":"Upload evidence","required":true,"markingMode":"criteria","config":{"maxFiles":3,"maxMb":10},"responseSchema":{"type":"array","minFiles":1,"maxFiles":3}},
  {"id":"q_url","type":"url","label":"Link","required":false,"markingMode":"criteria","responseSchema":{"type":"string","format":"url"}}
 ]}]},
 {"id":"t2","title":"Practical","sections":[{"id":"s2","title":"Scenario","questions":[
  {"id":"q_case","type":"case_study","label":"Case","markingMode":"criteria","children":[{"id":"q_case_a","type":"short_answer","label":"What first?","required":true,"markingMode":"criteria","responseSchema":{"type":"string"}}]},
  {"id":"q_rep","type":"repeating_group","label":"Hazards","required":true,"markingMode":"criteria","responseSchema":{"type":"array","minItems":1,"maxItems":5},"children":[{"id":"q_rep_h","type":"short_answer","label":"Hazard","required":true,"markingMode":"none","responseSchema":{"type":"string"}},{"id":"q_rep_r","type":"number","label":"Risk","required":true,"markingMode":"none","responseSchema":{"type":"integer","minimum":1,"maximum":5}}]},
  {"id":"q_obs","type":"observation_checklist","label":"Observed","required":true,"markingMode":"observation","responseSchema":{"type":"object","requiredKeys":["o1","o2"]},"config":{"items":[{"id":"o1","text":"Wears PPE"},{"id":"o2","text":"Isolates power"}]}},
  {"id":"q_tp","type":"third_party_report","label":"Supervisor report","required":false,"markingMode":"observation","responseSchema":{"type":"object"}}
 ]}]}]}$d$::jsonb $j$;
create function pg_temp.keys() returns jsonb language sql immutable as $j$ select $d$[
 {"questionId":"q_short","modelAnswer":"Gloves and safety glasses protect hands and eyes","assessorGuidance":"Accept any two items of PPE"},
 {"questionId":"q_single","answerKey":"a"},{"questionId":"q_multi","answerKey":["x","y"]},{"questionId":"q_tf","answerKey":true},
 {"questionId":"q_match","answerKey":{"l1":"r1","l2":"r2"}},{"questionId":"q_order","answerKey":["1","2","3"]},
 {"questionId":"q_blank","answerKey":["hammer",["saw","handsaw"]]},{"questionId":"q_num","answerKey":{"min":5,"max":10}}]$d$::jsonb $j$;
create function pg_temp.responses() returns jsonb language sql immutable as $j$ select $d${"q_short":"Gloves and safety glasses protect hands and eyes","q_long":"First isolate, then inspect.",
 "q_single":"a","q_cond":"Because A is safest","q_multi":["x","y"],"q_tf":false,"q_match":{"l1":"r1","l2":"r2"},"q_order":["1","2","3"],"q_blank":["Hammer","saw"],
 "q_grid":{"r1":{"c1":"v"}},"q_likert":4,"q_num":7,"q_date":"2026-11-20","q_file":["f1"],"q_url":"https://example.test/x",
 "q_case":{"q_case_a":"Call for help"},"q_rep":[{"q_rep_h":"Dust","q_rep_r":3}]}$d$::jsonb $j$;

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

-- the definition may never carry assessor data
select is((public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'definition', '{"tasks":[{"id":"t","title":"x","sections":[{"id":"s","questions":[{"id":"q","type":"short_answer","modelAnswer":"leak"}]}]}]}'::jsonb)))->'errors'->0->>'code', 'assessor_data', 'a definition carrying a model answer is refused');
select is((public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'definition', '{"tasks":[{"id":"t","title":"x","sections":[{"id":"s","questions":[{"id":"q","type":"short_answer"},{"id":"q","type":"number"}]}]}]}'::jsonb)))->'errors'->0->>'code', 'duplicate_id', 'duplicate question ids are refused');
select pg_temp.put('draft', (public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'definition', pg_temp.definition(), 'keys', pg_temp.keys(),
  'mappings', jsonb_build_array(jsonb_build_object('questionId', 'q_short', 'criterionId', 'c1', 'elementId', pg_temp.v('el_pc')), jsonb_build_object('questionId', 'q_single', 'elementId', pg_temp.v('el_ke'))))))::text);
select is((pg_temp.s('draft')::jsonb->>'ok')::boolean, true, 'the full definition (every question type, conditional logic, repeating group, case study, observation) saves');
select pg_temp.put('v1', pg_temp.s('draft')::jsonb->>'versionId');
select is((select count(*)::int from public.asm_version_questions where version_id = pg_temp.v('v1')), 23, 'the flattened question view sees every question including children');
select is((select count(*)::int from public.asm_question_keys where version_id = pg_temp.v('v1')), 8, 'keys live in their own table');
select is(jsonb_array_length(public.asm_admin('coverage', jsonb_build_object('versionId', pg_temp.v('v1')))->'gaps'), 1, 'coverage shows the unmapped element as a gap');

-- publishing freezes the version
select throws_ok(format($$select public.asm_admin('version_publish', '{"assessmentId": "%s"}')$$, '00000000-0000-0000-0000-000000000000'), 'P0002', null, 'publishing an unknown assessment fails');
select is((public.asm_admin('version_publish', jsonb_build_object('assessmentId', pg_temp.v('assessment')))->>'ok')::boolean, true, 'the draft publishes');
select is((select status from public.asm_versions where id = pg_temp.v('v1')), 'published', 'version 1 is published');
select is((select checksum from public.asm_versions where id = pg_temp.v('v1')), (select encode(sha256(convert_to(definition::text, 'UTF8')), 'hex') from public.asm_versions where id = pg_temp.v('v1')), 'the checksum is the sha-256 of the definition');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_versions set definition = '{"tasks": []}' where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published definition cannot be changed, even by the database owner');
select throws_ok(format($$update public.asm_versions set status = 'draft' where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published version cannot go back to draft');
select throws_ok(format($$delete from public.asm_versions where id = '%s'$$, pg_temp.v('v1')), '42501', null, 'a published version cannot be deleted');

-- editing after publish creates version 2 as a draft, version 1 stays published
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select pg_temp.put('draft2', (public.asm_admin('draft_save', jsonb_build_object('assessmentId', pg_temp.v('assessment'), 'definition', jsonb_set(pg_temp.definition(), '{tasks,0,title}', '"Knowledge questions (v2)"'))))::text);
select is((pg_temp.s('draft2')::jsonb->>'versionNo')::int, 2, 'an edit after publishing opens version 2 as a draft');
select pg_temp.put('v2', pg_temp.s('draft2')::jsonb->>'versionId');
select is((select count(*)::int from public.asm_question_keys where version_id = pg_temp.v('v2')), 8, 'the new draft inherits the keys');
select is((select status from public.asm_versions where id = pg_temp.v('v1')), 'published', 'version 1 is still published');
select throws_ok(format($$select public.asm_admin('draft_save', '{"assessmentId": "%s", "definition": {"tasks": []}, "expectedUpdatedAt": "2000-01-01T00:00:00Z"}')$$, pg_temp.v('assessment')), '40001', null, 'a stale draft save is refused (concurrency)');

-- ---------------------------------------------------------------- permissions on the admin surface
select pg_temp.as_user('a5000000-0000-0000-0000-000000000002');
select throws_ok($$select public.asm_admin('assessment_list')$$, '42501', null, 'an Editor cannot use the assessment admin');
select is((select count(*)::int from public.asm_assessments), 0, 'an Editor reads no assessment rows');
select is((select count(*)::int from public.asm_question_keys), 0, 'an Editor reads no keys');
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
select pg_temp.put('assignment', (select id::text from public.asm_assignments where version_id = pg_temp.v('v1') and batch_id = 'f5000000-0000-0000-0000-000000000011'));
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
select is(public.asm_jsonb_forbidden_key(pg_temp.s('open')::jsonb), null, 'the student payload carries no key, model answer or assessor guidance');
select ok(not (pg_temp.s('open')::jsonb ? 'keys'), 'the student payload has no keys collection');
select is((select count(*)::int from public.asm_question_keys), 0, 'the student reads no key rows directly');
select is((select count(*)::int from public.asm_results), 0, 'the student reads no result rows before the attempt is returned');
select is((select count(*)::int from public.asm_assessments), 1, 'the student reads the assigned assessment only');
select is((select count(*)::int from public.asm_versions), 1, 'the student reads the assigned published version and not the draft');

-- storage: the student writes under the draft attempt only
select lives_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/q_file/evidence.pdf')$$, pg_temp.v('attempt')), 'the student can upload under their draft attempt');
select throws_ok(format($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '%s/assessor/notes.pdf')$$, pg_temp.v('attempt')), '42501', null, 'the student cannot write to the assessor folder');
select throws_ok($$insert into storage.objects(bucket_id, name) values ('assessment-evidence', '00000000-0000-0000-0000-000000000000/q_file/x.pdf')$$, '42501', null, 'the student cannot write under a foreign attempt id');
select pg_temp.put('ev', (public.asm_student('evidence_register', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'questionId', 'q_file', 'path', pg_temp.v('attempt') || '/q_file/evidence.pdf', 'fileName', 'evidence.pdf', 'mime', 'application/pdf', 'bytes', 1234)))->>'id');
select ok(pg_temp.v('ev') is not null, 'the uploaded file is registered as evidence');
select throws_ok(format($$select public.asm_student('evidence_register', '{"attemptId": "%s", "questionId": "q_file", "path": "%s/q_file/missing.pdf"}')$$, pg_temp.v('attempt'), pg_temp.v('attempt')), 'P0002', null, 'a path with no uploaded object cannot be registered');

-- drafts, validation, submission
select pg_temp.put('save1', (public.asm_student('draft_save', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', '{"q_short": "Gloves"}'::jsonb)))::text);
select is((pg_temp.s('save1')::jsonb->>'ok')::boolean, true, 'a draft saves');
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId": "%s", "responses": {}, "rowVersion": 1}')$$, pg_temp.v('attempt')), '40001', null, 'a save with a stale row version is refused');
select pg_temp.put('sub_bad', (public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', pg_temp.responses() - 'q_short' || '{"q_num": 500}'::jsonb, 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))::text);
select is((pg_temp.s('sub_bad')::jsonb->>'ok')::boolean, false, 'a submission with a missing required answer and an out-of-range number is refused');
select is((select count(*)::int from jsonb_array_elements(pg_temp.s('sub_bad')::jsonb->'errors') e where e->>'questionId' in ('q_short', 'q_num')), 2, 'both problems are named');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt'), 'responses', pg_temp.responses() - 'q_cond', 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))->'errors'->0->>'questionId', 'q_cond', 'conditional logic: the follow-up is required when A was chosen');
select is(jsonb_array_length(public.asm_validate_responses(pg_temp.definition(), (pg_temp.responses() - 'q_cond') || '{"q_single": "b"}'::jsonb, 'student')), 0, 'conditional logic: choosing B hides the follow-up and nothing is required');
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
select is((select suggested_outcome from public.asm_results where attempt_id = pg_temp.v('attempt') and question_id = 'q_single'), 'S', 'auto-check suggests Satisfactory for a right single choice');
select is((select suggested_outcome from public.asm_results where attempt_id = pg_temp.v('attempt') and question_id = 'q_tf'), 'NYS', 'auto-check suggests Not Yet Satisfactory for a wrong true/false');
select is((select suggested_outcome from public.asm_results where attempt_id = pg_temp.v('attempt') and question_id = 'q_blank'), 'S', 'fill-in-the-blanks accepts alternatives, ignoring case');
select is((select suggested_outcome from public.asm_results where attempt_id = pg_temp.v('attempt') and question_id = 'q_num'), 'S', 'a number inside the key range is suggested Satisfactory');
select is((select count(*)::int from public.asm_results where attempt_id = pg_temp.v('attempt') and outcome is not null), 0, 'auto-check never writes a confirmed outcome');
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
select is((select count(*)::int from public.asm_question_keys), 0, 'the trainer of another batch reads no keys');
select throws_ok(format($$select public.asm_trainer('attempt_get', '{"id": "%s"}')$$, pg_temp.v('attempt')), '42501', null, 'the trainer of another batch cannot open the attempt');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id": "%s", "outcome": "S"}')$$, pg_temp.v('attempt')), '42501', null, 'the trainer of another batch cannot decide it');

-- ---------------------------------------------------------------- the assessor marks
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is(jsonb_array_length(public.asm_trainer('pending_marking')), 1, 'the batch trainer sees the submission to mark');
select is((select count(*)::int from public.asm_question_keys where version_id = pg_temp.v('v1')), 8, 'the batch trainer reads the keys of the assigned version');
select is((select count(*)::int from storage.objects where bucket_id = 'assessment-evidence' and name like pg_temp.v('attempt') || '/%'), 1, 'the batch trainer reads the evidence objects');
select pg_temp.put('tget', (public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attempt'))))::text);
select is(pg_temp.s('tget')::jsonb->'keys'->0->>'questionId', 'q_short', 'the marking view carries the model answers and guidance');
select is((select count(*)::int from jsonb_array_elements(pg_temp.s('tget')::jsonb->'results') r where r->>'suggestedOutcome' is not null), 7, 'the marking view shows the auto-check suggestions');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt'), 'outcome', 'S')))->'errors'->0->>'questionId', 'q_obs', 'the decision waits for the observation checklist');
select pg_temp.put('mark', (public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt'),
  'results', '[{"questionId":"q_short","criterionId":"c1","outcome":"S","feedback":"Good"},{"questionId":"q_short","criterionId":"c2","outcome":"S"},{"questionId":"q_short","outcome":"S"},{"questionId":"q_long","outcome":"S","rubricLevelId":"r2","score":2},{"questionId":"q_single","outcome":"S"},{"questionId":"q_cond","outcome":"S"},{"questionId":"q_multi","outcome":"S"},{"questionId":"q_tf","outcome":"NYS","feedback":"Check again"},{"questionId":"q_match","outcome":"S"},{"questionId":"q_order","outcome":"S"},{"questionId":"q_blank","outcome":"S"},{"questionId":"q_grid","outcome":"S"},{"questionId":"q_num","outcome":"S"},{"questionId":"q_date","outcome":"S"},{"questionId":"q_file","outcome":"S"},{"questionId":"q_url","outcome":"S"},{"questionId":"q_case","outcome":"S"},{"questionId":"q_case_a","outcome":"S"},{"questionId":"q_rep","outcome":"S"},{"questionId":"q_obs","outcome":"S"},{"questionId":"q_tp","outcome":"S"}]'::jsonb,
  'taskResults', '[{"taskId":"t1","outcome":"NYS","feedback":"Redo the true/false"},{"taskId":"t2","outcome":"S"}]'::jsonb,
  'assessorResponses', '{"q_obs": {"o1": true, "o2": true}}'::jsonb, 'overallFeedback', 'Nearly there')))::text);
select is(pg_temp.s('mark')::jsonb->>'state', 'marking', 'marking moves the attempt to marking');
select is((select rollup_suggested from public.asm_task_results where attempt_id = pg_temp.v('attempt') and task_id = 't1'), 'NYS', 'the task rollup suggests Not Yet Satisfactory when a question is');
select is((select rollup_suggested from public.asm_task_results where attempt_id = pg_temp.v('attempt') and task_id = 't2'), 'S', 'and Satisfactory when every question is');
select throws_ok(format($$select public.asm_trainer('mark_return', '{"id": "%s", "outcome": "NYS", "rowVersion": 1}')$$, pg_temp.v('attempt')), '40001', null, 'a decision with a stale row version is refused');
select pg_temp.put('ret', (public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt'), 'outcome', 'NYS', 'overallFeedback', 'Fix the true/false and resubmit')))::text);
select is((pg_temp.s('ret')::jsonb->>'ok')::boolean, true, 'the assessor returns the attempt as Not Yet Satisfactory');
select pg_temp.put('attempt2', pg_temp.s('ret')::jsonb->>'nextAttemptId');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt')), 'returned', 'attempt 1 is returned');
select is((select state || '/' || attempt_no from public.asm_attempts where id = pg_temp.v('attempt2')), 'draft/2', 'attempt 2 opens as a draft (reassessment)');
select is((select responses->>'q_short' from public.asm_attempts where id = pg_temp.v('attempt2')), 'Gloves and safety glasses protect hands and eyes', 'attempt 2 carries the previous answers');
select is((select count(*)::int from public.asm_evidence_files where attempt_id = pg_temp.v('attempt2')), 1, 'attempt 2 carries the previous evidence');
select is((select state from public.asm_reassessments where attempt_id = pg_temp.v('attempt')), 'opened', 'the reassessment is recorded');
select pg_temp.as_postgres();
select throws_ok(format($$update public.asm_results set outcome = 'S' where attempt_id = '%s' and question_id = 'q_tf'$$, pg_temp.v('attempt')), '42501', null, 'results of a returned attempt are frozen');

-- the student sees the feedback and completes attempt 2
select pg_temp.as_user('a5000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.asm_results where attempt_id = pg_temp.v('attempt')), 21, 'once returned, the student reads the results');
select is((public.asm_student('results', jsonb_build_object('attemptId', pg_temp.v('attempt'))))->>'overallFeedback', 'Fix the true/false and resubmit', 'the student reads the overall feedback');
select is((select count(*)::int from jsonb_array_elements((public.asm_student('results', jsonb_build_object('attemptId', pg_temp.v('attempt'))))->'results') r where r ? 'suggestedOutcome' and r->>'suggestedOutcome' is not null), 0, 'the student never sees the auto-check suggestion');
select is((select count(*)::int from public.asm_notifications where recipient_auth_user = 'a5000000-0000-0000-0000-000000000011' and event = 'reassessment'), 1, 'the student is told about the reassessment');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attempt2'), 'responses', pg_temp.responses() || '{"q_tf": true}'::jsonb, 'declaration', '{"signature": "Sam Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'attempt 2 submits');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000003');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attempt2'), 'results', '[{"questionId":"q_tf","outcome":"S"}]'::jsonb, 'taskResults', '[{"taskId":"t1","outcome":"S"},{"taskId":"t2","outcome":"S"}]'::jsonb, 'assessorResponses', '{"q_obs": {"o1": true, "o2": true}}'::jsonb)))->>'state', 'marking', 'attempt 2 is marked');
select is((public.asm_trainer('mark_return', jsonb_build_object('id', pg_temp.v('attempt2'), 'outcome', 'S')))->>'outcome', 'S', 'attempt 2 is Satisfactory');
select is((select state from public.asm_attempts where id = pg_temp.v('attempt2')), 'final', 'a Satisfactory attempt is final');
select is((select count(*)::int from public.asm_attempts where student_id = 'e5000000-0000-0000-0000-000000000011'), 2, 'the history keeps both attempts');

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
select is((public.asm_admin('assessment_export', jsonb_build_object('id', pg_temp.v('assessment'), 'versionId', pg_temp.v('v1'))))->'mappings'->0->>'elementCode', '1.1', 'export carries the mapping by element code');
select pg_temp.put('imported', (public.asm_admin('assessment_create', jsonb_build_object('courseId', 'course-asm-test', 'unitId', 'unit-asm-2', 'title', 'Imported copy', 'import', public.asm_admin('assessment_export', jsonb_build_object('id', pg_temp.v('assessment'), 'versionId', pg_temp.v('v1'))))))::jsonb->>'id');
select is((select count(*)::int from public.asm_question_keys k join public.asm_versions v on v.id = k.version_id where v.assessment_id = pg_temp.v('imported')), 8, 'import re-creates the keys on the new draft');
select is((select count(*)::int from public.asm_unit_elements where unit_id = 'unit-asm-2'), 2, 'import creates the mapped elements on the other unit');

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
update public.batch_enrolments set status = 'withdrawn' where batch_id = 'f5000000-0000-0000-0000-000000000011' and student_id = 'e5000000-0000-0000-0000-000000000013';
select is((select state || '/' || void_reason from public.asm_attempts where id = pg_temp.v('attempt3')), 'void/left the batch', 'a student who leaves the batch loses the open draft (kept as history)');
select is((select count(*)::int from public.asm_assignment_eligible(pg_temp.v('assignment'))), 1, 'and is no longer eligible');
update public.batch_enrolments set status = 'active' where batch_id = 'f5000000-0000-0000-0000-000000000011' and student_id = 'e5000000-0000-0000-0000-000000000013';
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
select throws_ok(format($$insert into public.asm_results(attempt_id, question_id, outcome) values ('%s', 'q_tf', 'S')$$, pg_temp.v('attempt')), '42501', null, 'a student cannot write results');
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
select throws_ok($$select public.asm_validate_responses('{}', '{}')$$, '42501', null, 'T2 anon: the validators are not executable');
select throws_ok($$select public.asm_evidence_path_readable('x')$$, '42501', null, 'T2 anon: the storage path helpers are not executable');
select throws_ok($$select count(*) from public.asm_version_questions$$, '42501', null, 'T2 anon: the question view is not readable');
select throws_ok($$select count(*) from public.asm_question_keys$$, '42501', null, 'T2 anon: assessor keys are not readable');
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
select throws_ok(format($$select public.asm_student('draft_save', '{"attemptId":"%s","responses":{"q_short":"mine"}}')$$, pg_temp.v('draftA')), 'P0002', null, 'T2 student B cannot save student A''s draft');
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
select is((select count(*)::int from public.asm_question_keys), 0, 'T2 a student never reads assessor keys');
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
select is((select count(*)::int from public.asm_question_keys where version_id = pg_temp.v('v1')), 0, 'T2 keys of a version not assigned to the trainer are hidden');
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
select is(jsonb_array_length(public.asm_admin('bank_list')), 0, 'T2 the question bank shows nothing of tenant 1');
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
select pg_temp.put('assignment2', (select id::text from public.asm_assignments where version_id = pg_temp.v('v1') and batch_id = 'f5000000-0000-0000-0000-000000000012'));
select pg_temp.as_user('a5000000-0000-0000-0000-000000000012');
select pg_temp.put('attemptB', (public.asm_student('assessment_open', jsonb_build_object('assignmentId', pg_temp.v('assignment2'))))->'attempt'->>'id');
select is((public.asm_student('submit', jsonb_build_object('attemptId', pg_temp.v('attemptB'), 'responses', pg_temp.responses() || '{"q_tf": true}'::jsonb, 'declaration', '{"signature": "Sue Student", "agreed": true}'::jsonb)))->>'ok', 'true', 'T3 student 2 submits on G2');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is((public.asm_trainer('me'))->>'isTrainer', 'false', 'T3 Tom has no trainer role');
select is((public.asm_trainer('me'))->>'requireTrainerRole', 'true', 'T3 and the workspace knows the role is required');
select is((select x->>'canAssess' from jsonb_array_elements(public.asm_trainer('my_assignments')) x where x->>'id' = pg_temp.s('assignment2')), 'false', 'T3 the G2 assignment is listed for Tom as not assessable');
select is((public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attemptB'))))->>'state', 'submitted', 'T3 a batch trainer without the role still reads the submission');
select is((public.asm_trainer('attempt_get', jsonb_build_object('id', pg_temp.v('attemptB'))))->>'canAssess', 'false', 'T3 and is told they cannot mark it');
select throws_ok(format($$select public.asm_trainer('mark_save', '{"id":"%s","results":[{"questionId":"q_tf","outcome":"S"}]}')$$, pg_temp.v('attemptB')), '42501', null, 'T3 a batch trainer without the trainer role cannot mark');
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
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attemptB'), 'results', '[{"questionId":"q_tf","outcome":"S"}]'::jsonb)))->>'state', 'marking', 'T3 and marks');
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
select is((public.asm_admin('settings_save', '{"requireTrainerRole": false}'))->>'require_trainer_role', 'false', 'T3 the admin switches the role requirement off');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000004');
select is(public.asm_can_assess(pg_temp.v('assignment2')), true, 'T3 with the requirement off every active batch trainer may assess');
select is((public.asm_trainer('mark_save', jsonb_build_object('id', pg_temp.v('attemptB'), 'results', '[{"questionId":"q_tf","outcome":"S"}]'::jsonb, 'taskResults', '[{"taskId":"t1","outcome":"S"},{"taskId":"t2","outcome":"S"}]'::jsonb, 'assessorResponses', '{"q_obs": {"o1": true, "o2": true}}'::jsonb)))->>'state', 'marking', 'T3 Tom marks as a plain batch trainer');
select lives_ok($$select public.asm_trainer('unit_outcome_record', '{"studentId": "e5000000-0000-0000-0000-000000000012", "unitId": "unit-asm-2", "outcome": "NYC", "signOff": true}')$$, 'T3 and signs off a unit of the course without an assignment');
select pg_temp.as_user('a5000000-0000-0000-0000-000000000001');
select is((public.asm_admin('settings_save', '{"requireTrainerRole": true}'))->>'require_trainer_role', 'true', 'T3 the requirement is switched back on');
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

select * from finish();
rollback;
