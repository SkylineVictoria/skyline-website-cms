begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- QUALIFICATION (20261128003517): the course enrolment record (intake_enrolments) as the Qualification: statuses and allowed moves,
-- resume date, completion needs every unit result, append-only history, PRISMS / refund / manual placement tasks, creation from an
-- Enrolled application through the placement path (tentative, CoE copied), In Progress sets the application Active, no Active by hand,
-- Admin undo, paused attendance, the portal view without notes, the daily start and no-show. Fixtures only; rolled back.
-- Run: node scripts/lab/staff-lab.mjs sql
select plan(61);

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claim.sub', p::text, true); end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claim.sub', '', true); end $$;
create function pg_temp.try(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'refused: ' || sqlerrm; end $$;
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a6000000-0000-0000-0000-000000000001', 'q.admin@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a6000000-0000-0000-0000-000000000002', 'q.editor@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a6000000-0000-0000-0000-000000000011', 'q.student1@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password, rto_manager) values
 ('q-admin', 'Q Admin', 'q.admin@example.test', 'Admin', 'Active', 'a6000000-0000-0000-0000-000000000001', false, true),
 ('q-editor', 'Q Editor', 'q.editor@example.test', 'Editor', 'Active', 'a6000000-0000-0000-0000-000000000002', false, false);
insert into public.agencies(id, name, code) values ('c6000000-0000-0000-0000-000000000001', 'Q Agency', 'Q-AG');
insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture-agreement.pdf', 'fixtures/' || a.id::text || '/agreement.pdf' from public.agencies a where a.id = 'c6000000-0000-0000-0000-000000000001' and a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none';
insert into public.enrollment_students(id, agency_id, full_name, email) values
 ('e6000000-0000-0000-0000-000000000011', 'c6000000-0000-0000-0000-000000000001', 'Zz Quinn', 'q.student1@example.test'),
 ('e6000000-0000-0000-0000-000000000012', 'c6000000-0000-0000-0000-000000000001', 'Zz Quill', 'q.student2@example.test');
update public.enrollment_students set sex_code = 'M', birth_country_code = '1101', home_language_code = '1201', indigenous_status_code = '4',
  school_level_code = '12', school_level_year = '2017', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N',
  details = coalesce(details, '{}'::jsonb) || jsonb_build_object('first_name', split_part(full_name, ' ', 1), 'last_name', split_part(full_name, ' ', 2))
    || '{"dob": "2000-01-01", "usi_number": "ABCDE12345", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC"}'::jsonb
 where id in ('e6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000012');
insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level) values ('course-q-test', 'q-test-course', 'Q101', 'Q Test Course', 'Draft', 'Face to Face', '0403', '331212', 'Certificate III');
insert into public.cms_course_units(id, course_id, code, name) values ('unit-q-1', 'course-q-test', 'QU1', 'Work safely'), ('unit-q-2', 'course-q-test', 'QU2', 'Use tools');
insert into public.course_intakes(id, course_id, start_date, end_date, label) values
 ('f6000000-0000-0000-0000-000000000001', 'course-q-test', current_date - 30, current_date + 300, 'Q now'),
 ('f6000000-0000-0000-0000-000000000002', 'course-q-test', current_date + 60, current_date + 400, 'Q later');
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values
 ('f6000000-0000-0000-0000-000000000001', 'unit-q-1', current_date - 30, current_date + 100), ('f6000000-0000-0000-0000-000000000001', 'unit-q-2', current_date + 101, current_date + 300),
 ('f6000000-0000-0000-0000-000000000002', 'unit-q-1', current_date + 60, current_date + 200), ('f6000000-0000-0000-0000-000000000002', 'unit-q-2', current_date + 201, current_date + 400);
-- an intake is a class group once it has a classroom or class times (intake_has_group): use any existing classroom when there is one
update public.course_intakes set classroom_id = (select x.classroom_id from public.course_intakes x where x.classroom_id is not null limit 1)
 where id in ('f6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000002') and exists (select 1 from public.course_intakes x where x.classroom_id is not null);
update public.cms_courses set status = 'Published' where id = 'course-q-test';
insert into public.enrollment_applications(id, agency_id, student_id, student_name, student_email, status, data, reference)
values ('a7000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000011', 'Zz Quinn', 'q.student1@example.test', 'draft',
  '{"values": {"study_reason": "12", "intake_join_date": ""}}', 'ZZ-Q-1');
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id)
values ('a7000000-0000-0000-0000-000000000001', 'course-q-test', 'Q101', 'Q Test Course', 'f6000000-0000-0000-0000-000000000002');
set local session_replication_role = replica;
update public.enrollment_applications set status = 'coe_issued' where id = 'a7000000-0000-0000-0000-000000000001';
insert into public.enrollment_coe_documents(registration_id, application_id, kind, file_name, size_bytes, sha256, content, document_number, issue_date)
values (gen_random_uuid(), 'a7000000-0000-0000-0000-000000000001', 'coe', 'coe.pdf', 9, encode(sha256('%PDF-coe'::bytea), 'hex'), '%PDF-coe'::bytea, 'E1234567', current_date);
set local session_replication_role = origin;
select set_config('qualification.enrolment_date', '', true);
update public.enrollment_applications set status = 'enrolled' where id = 'a7000000-0000-0000-0000-000000000001';
create temp table q as select id from public.intake_enrolments where student_id = 'e6000000-0000-0000-0000-000000000011';
grant all on q to public;
create function pg_temp.qid() returns uuid language sql stable as $$ select id from q limit 1 $$;

-- ---------------------------------------------------------------- statuses and moves
select is(public.qualification_label('withdrawn'), 'Cancelled', 'withdrawn is shown as Cancelled');
select is(public.qualification_label('active'), 'In Progress', 'active is shown as In Progress');
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'intake_enrolments_status_check')) like '%tentative%suspended%', 'tentative and suspended are statuses');
select is(public.qualification_moves('tentative'), array['active', 'deferred', 'withdrawn'], 'tentative moves');
select is(public.qualification_moves('active'), array['deferred', 'suspended', 'withdrawn', 'completed'], 'In Progress moves');
select is(public.qualification_moves('suspended'), array['active', 'withdrawn'], 'suspended moves');
select is(public.qualification_moves('completed'), array[]::text[], 'completed is final');

-- ---------------------------------------------------------------- created from the Enrolled application
select is((select status from public.intake_enrolments where id = pg_temp.qid()), 'tentative', 'Enrolled creates a Tentative Qualification');
select is((select application_id from public.intake_enrolments where id = pg_temp.qid()), 'a7000000-0000-0000-0000-000000000001'::uuid, 'linked to its application');
select is((select coe_number from public.intake_enrolments where id = pg_temp.qid()), 'E1234567', 'the CoE number is copied');
select is((select study_reason_code from public.intake_enrolments where id = pg_temp.qid()), '12', 'the study reason comes from the application answers');
select is((select content from public.intake_enrolment_documents where enrolment_id = pg_temp.qid() and kind = 'coe'), '%PDF-coe'::bytea, 'the CoE file is copied onto the Qualification');
select is((select count(*)::int from public.intake_enrolment_status_history where enrolment_id = pg_temp.qid() and from_status is null and to_status = 'tentative'), 1, 'creation is in the history');
select is((select status from public.enrollment_applications where id = 'a7000000-0000-0000-0000-000000000001'), 'enrolled', 'the application stays Enrolled before the course starts');
select is(public.qualification_start_due(pg_temp.qid()), 0, 'nothing starts before the course start date');
select ok(pg_temp.try($$update public.intake_enrolments set status = 'suspended', resume_date = current_date + 30 where id = pg_temp.qid()$$) like 'refused:%cannot move from Tentative to Suspended%', 'Tentative cannot be suspended');

-- the course starts: In Progress, and the application becomes Active
update public.intake_enrolments set course_start_date = current_date where id = pg_temp.qid();
select is(public.qualification_start_due(pg_temp.qid()), 1, 'the start date moves it on');
select is((select status from public.intake_enrolments where id = pg_temp.qid()), 'active', 'Tentative -> In Progress on the course start date');
select is((select status from public.enrollment_applications where id = 'a7000000-0000-0000-0000-000000000001'), 'active', 'In Progress sets the application to Active');
select is((select reason from public.intake_enrolment_status_history where enrolment_id = pg_temp.qid() and to_status = 'active'), 'Course started', 'the automatic start is in the history');

-- ---------------------------------------------------------------- Active by hand is refused
insert into public.enrollment_applications(id, agency_id, student_id, student_name, student_email, status, data, reference)
values ('a7000000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000012', 'Zz Quill', 'q.student2@example.test', 'draft', '{"values": {}}', 'ZZ-Q-2');
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id)
values ('a7000000-0000-0000-0000-000000000002', 'course-q-test', 'Q101', 'Q Test Course', null);
set local session_replication_role = replica;
update public.enrollment_applications set status = 'coe_issued' where id = 'a7000000-0000-0000-0000-000000000002';
set local session_replication_role = origin;
select ok(pg_temp.try($$update public.enrollment_applications set status = 'active' where id = 'a7000000-0000-0000-0000-000000000002'$$) like 'refused:%becomes Active by itself%', 'staff cannot set an application Active by hand');

-- ---------------------------------------------------------------- placement fails: a task, the status still moves
update public.enrollment_applications set status = 'enrolled' where id = 'a7000000-0000-0000-0000-000000000002';
select is((select status from public.enrollment_applications where id = 'a7000000-0000-0000-0000-000000000002'), 'enrolled', 'Enrolled goes through when the student cannot be placed');
select is((select count(*)::int from public.intake_enrolments where application_id = 'a7000000-0000-0000-0000-000000000002'), 0, 'no Qualification without an intake');
select ok((select detail from public.qualification_tasks where application_id = 'a7000000-0000-0000-0000-000000000002' and kind = 'place_manually' and status = 'open') like '%no intake%', 'a Place student manually task says why');

-- ---------------------------------------------------------------- moves, resume date, reasons, tasks
select pg_temp.as_user('a6000000-0000-0000-0000-000000000002');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'deferred', 'Student request', null, null, current_date + 30)$$) like 'refused:%Admin or an RTO Manager%', 'an Editor cannot change a Qualification');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'deferred', null, null, null, current_date + 30)$$) like 'refused:%reason%', 'deferring needs a reason');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'deferred', 'Student request')$$) like 'refused:%resume date%', 'deferring needs the resume date');
select is(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'deferred', 'Student request', 'Back after surgery', null, current_date + 30)$$), 'ok', 'an Admin defers with a reason and a resume date');
select is((select status_reason || '/' || status_note from public.intake_enrolments where id = pg_temp.qid()), 'Student request/Back after surgery', 'the reason and note are on the Qualification');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.qid() and kind = 'prisms_report' and event = 'deferred' and due_on = public.course_intake_today() + 14), 1, 'a CoE deferral raises Report in PRISMS within 14 days');
select ok(pg_temp.try($$select public.qualification_task_close((select id from public.qualification_tasks where enrolment_id = pg_temp.qid() and kind = 'prisms_report'), null)$$) like 'refused:%PRISMS reference%', 'the PRISMS task closes only with the reference');
select is(pg_temp.try($$select public.qualification_task_close((select id from public.qualification_tasks where enrolment_id = pg_temp.qid() and kind = 'prisms_report'), 'PR-7788')$$), 'ok', 'closed with the PRISMS reference');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'completed')$$) like 'refused:%cannot move from Deferred to Completed%', 'Deferred cannot be Completed');
select is(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'active')$$), 'ok', 'Deferred -> In Progress');
select is((select resume_date from public.intake_enrolments where id = pg_temp.qid()), null, 'the resume date is cleared when back in progress');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'completed')$$) like 'refused:%every unit has a result (2 without one)%', 'Completed needs a result for every unit');
select pg_temp.as_postgres();
-- the trainer's sign-off (inserted as the fixture, its own guards are tested in assessment_management)
set local session_replication_role = replica;
insert into public.asm_unit_outcomes(student_id, unit_id, outcome, signed_by, signed_role, signed_name) select 'e6000000-0000-0000-0000-000000000011', u, 'C', 'a6000000-0000-0000-0000-000000000001', 'trainer', 'Q Admin' from unnest(array['unit-q-1', 'unit-q-2']) u;
set local session_replication_role = origin;
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select is(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'completed')$$), 'ok', 'with every unit result it is Completed');
select ok(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'active')$$) like 'refused:%cannot move from Completed to In Progress%', 'Completed is final');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000002');
select ok(pg_temp.try($$select public.qualification_undo(pg_temp.qid(), 'Recorded by mistake')$$) like 'refused:%Only an Admin%', 'only an Admin can undo');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select is(pg_temp.try($$select public.qualification_undo(pg_temp.qid(), 'Recorded by mistake')$$), 'ok', 'an Admin undoes Completed with a reason');
select is((select status from public.intake_enrolments where id = pg_temp.qid()), 'active', 'back to In Progress');
select is(pg_temp.try($$select public.qualification_set_status(pg_temp.qid(), 'withdrawn', 'Visa refused or cancelled', null, current_date)$$), 'ok', 'In Progress -> Cancelled');
select is((select string_agg(kind, ',' order by kind) from public.qualification_tasks where enrolment_id = pg_temp.qid() and status = 'open'), 'prisms_report,refund_check', 'cancelling a CoE raises the PRISMS and refund tasks');
select is((select withdrawn_on from public.intake_enrolments where id = pg_temp.qid()), current_date, 'the cancellation date is the withdrawal date (AVETMISS outcome 40)');

-- ---------------------------------------------------------------- history is append-only; portal view; paused attendance
select pg_temp.as_postgres();
select ok(pg_temp.try($$update public.intake_enrolment_status_history set note = 'x' where enrolment_id = pg_temp.qid()$$) like 'refused:%cannot be changed%', 'history cannot be changed');
select ok(pg_temp.try($$delete from public.intake_enrolment_status_history where enrolment_id = pg_temp.qid()$$) like 'refused:%cannot be deleted%', 'history cannot be deleted');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select ok(not (public.portal_qualifications('a7000000-0000-0000-0000-000000000001') -> 0 ? 'note') and not (public.portal_qualifications('a7000000-0000-0000-0000-000000000001') -> 0 ? 'reason')
  and public.portal_qualifications('a7000000-0000-0000-0000-000000000001') -> 0 ->> 'label' = 'Cancelled', 'students and agents see the status without reasons or notes');
select pg_temp.as_postgres();
select ok((select prosrc from pg_proc where proname = 'trainer_session_attendance_save') not like '%''active'', ''deferred''%', 'attendance lists only In Progress students (deferred / suspended paused)');

-- daily: a CoE student In Progress for 7+ days with no attendance present or late is a no-show (PRISMS task)
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select is(pg_temp.try($$select public.qualification_undo(pg_temp.qid(), 'Recorded by mistake')$$), 'ok', 'an Admin undoes Cancelled');
select pg_temp.as_postgres();
update public.intake_enrolments set course_start_date = public.course_intake_today() - 8 where id = pg_temp.qid();
select is((public.qualification_daily() ->> 'noShows')::int, 1, 'the daily check finds the no-show');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.qid() and kind = 'prisms_report' and event = 'no_show'), 1, 'a no-show raises Report in PRISMS within 14 days');
-- ---------------------------------------------------------------- QUALIFICATION-GATES (20261128004517): no orphan statuses
-- 1. a live Qualification keeps its application from moving back
select ok(pg_temp.try($$update public.enrollment_applications set status = 'offer_issued' where id = 'a7000000-0000-0000-0000-000000000001'$$) like 'refused:%cancel the Qualification first%', 'gate 1: an application with a live Qualification cannot move back');
select ok(pg_temp.try($$update public.enrollment_applications set status = 'coe_issued' where id = 'a7000000-0000-0000-0000-000000000001'$$) like 'refused:%live Qualification (In Progress)%', 'gate 1: not even to CoE issued');
-- 3. withdrawing the application cancels its own Qualification
update public.enrollment_applications set status = 'withdrawn' where id = 'a7000000-0000-0000-0000-000000000001';
select is((select status || '/' || status_reason from public.intake_enrolments where id = pg_temp.qid()), 'withdrawn/Application Withdrawn', 'gate 3: the application withdrawn cancels its Qualification');
select is((select withdrawn_on from public.intake_enrolments where id = pg_temp.qid()), public.course_intake_today(), 'gate 3: with the withdrawal date');
-- 2. an undone Mark as enrolled cancels the Tentative Qualification quietly
insert into public.enrollment_applications(id, agency_id, student_id, student_name, student_email, status, data, reference)
values ('a7000000-0000-0000-0000-000000000003', 'c6000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000012', 'Zz Quill', 'q.student2@example.test', 'draft', '{"values": {"study_reason": "12"}}', 'ZZ-Q-3');
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id)
values ('a7000000-0000-0000-0000-000000000003', 'course-q-test', 'Q101', 'Q Test Course', 'f6000000-0000-0000-0000-000000000002');
set local session_replication_role = replica;
update public.enrollment_applications set status = 'coe_issued' where id = 'a7000000-0000-0000-0000-000000000003';
set local session_replication_role = origin;
update public.enrollment_applications set status = 'enrolled' where id = 'a7000000-0000-0000-0000-000000000003';
select is((select status from public.intake_enrolments where application_id = 'a7000000-0000-0000-0000-000000000003'), 'tentative', 'gate 2: Enrolled made a Tentative Qualification');
select set_config('portal.status_note', 'Undone: back to CoE / VoE issued', true);
select is(pg_temp.try($$update public.enrollment_applications set status = 'coe_issued' where id = 'a7000000-0000-0000-0000-000000000003'$$), 'ok', 'gate 2: the enrolment can be undone while the Qualification is Tentative');
select set_config('portal.status_note', '', true);
select is((select status || '/' || status_reason from public.intake_enrolments where application_id = 'a7000000-0000-0000-0000-000000000003'), 'withdrawn/Enrolment undone', 'gate 2: its Tentative Qualification is cancelled');
select is((select count(*)::int from public.qualification_tasks t join public.intake_enrolments e on e.id = t.enrolment_id where e.application_id = 'a7000000-0000-0000-0000-000000000003'), 0, 'gate 2: quietly (no PRISMS or refund task)');
-- 4. Active needs this application's own Qualification, not any placement of the student in the course
select set_config('rto.auto_place', 'on', true);
insert into public.intake_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on, study_reason_code) values ('f6000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000012', 'CoE', 'active', current_date, '12');
select set_config('rto.auto_place', 'off', true);
select set_config('qualification.sync', 'on', true);
select ok(pg_temp.try($$update public.enrollment_applications set status = 'active' where id = 'a7000000-0000-0000-0000-000000000002'$$) like 'refused:%no Qualification In Progress%', 'gate 4: a placement without this application does not make it Active');
select set_config('qualification.sync', '', true);
select is((select count(*)::int from public.intake_enrolment_status_history where enrolment_id = pg_temp.qid() and to_status = 'withdrawn' and reason = 'Application Withdrawn'), 1, 'gate 3: the cancellation is in the history');
select * from finish();
rollback;
