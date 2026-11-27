begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- QUALIFICATION-BRIEF (owner 2026-11-27): the owner's Qualification brief, with the owner's decisions of 2026-11-27, checked against the
-- Qualification (20261128003517_qualification and later, 20261128014517_qualification_brief_fixes): creation at Enrolled (the CoE / VoE
-- enrols in one step), documents (study copies, personal ones linked), the moves and their reasons (from the list, Other with a note;
-- resume and complete without), PRISMS tasks, the daily start and no-show, completion and its dates, the Admin's date edit, the links
-- on unit enrolments and attempts, and the portal view. The released placement path (auto at Enrolled) is kept; no student_type column
-- or student_qualifications view (owner).
-- Fixtures only; rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(65);

create temp table t(k text primary key, v text);
grant all on t to public;
create function pg_temp.v(text) returns uuid language sql stable as $$ select v::uuid from t where k = $1 $$;
create function pg_temp.put(text, text) returns void language sql as $$ insert into t values ($1, $2) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claim.sub', p::text, true); end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claim.sub', '', true); end $$;
-- runs a statement and always rolls it back: 'accepted' or 'refused: <message>' (a probe never changes the state of later checks)
create function pg_temp.probe(p_sql text) returns text language plpgsql as $$
begin
 begin execute p_sql; raise exception 'QBRIEF_PROBE_ACCEPTED';
 exception when others then if sqlerrm = 'QBRIEF_PROBE_ACCEPTED' then return 'accepted'; end if; return 'refused: ' || sqlerrm; end;
end $$;
create function pg_temp.reason(p_status text) returns text language sql stable as $$
 select label from public.qualification_status_reasons where status = p_status and is_active and not is_other order by sort, label limit 1 $$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a8000000-0000-0000-0000-000000000001', 'qb.admin@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a8000000-0000-0000-0000-000000000011', 'qb.student1@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password, rto_manager) values
 ('qb-admin', 'QB Admin', 'qb.admin@example.test', 'Admin', 'Active', 'a8000000-0000-0000-0000-000000000001', false, true);
insert into public.agencies(id, name, code) values ('c8000000-0000-0000-0000-000000000001', 'QB Agency', 'QB-AG');
insert into public.business_documents(business_id, kind, file_name, storage_path) values ('c8000000-0000-0000-0000-000000000001', 'agent_agreement', 'a.pdf', 'fixtures/qb/agreement.pdf');
insert into public.enrollment_students(id, agency_id, full_name, email) values
 ('e8000000-0000-0000-0000-000000000011', 'c8000000-0000-0000-0000-000000000001', 'Zz Brief One', 'qb.student1@example.test'),
 ('e8000000-0000-0000-0000-000000000012', 'c8000000-0000-0000-0000-000000000001', 'Zz Brief Two', 'qb.student2@example.test'),
 ('e8000000-0000-0000-0000-000000000013', 'c8000000-0000-0000-0000-000000000001', 'Zz Brief Three', 'qb.student3@example.test');
update public.enrollment_students set sex_code = 'F', birth_country_code = '7103', home_language_code = '1201', indigenous_status_code = '4', school_level_code = '12',
  school_level_year = '2017', at_school_flag = 'N', labour_force_code = '01', disability_flag = 'N', prior_education_flag = 'N',
  details = coalesce(details, '{}'::jsonb) || jsonb_build_object('first_name', 'Zz', 'last_name', split_part(full_name, ' ', 3))
    || '{"dob": "2000-01-01", "usi_number": "ABCDE12345", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC", "issuing_country": "India", "citizenship": "India"}'::jsonb
 where id in ('e8000000-0000-0000-0000-000000000011', 'e8000000-0000-0000-0000-000000000012', 'e8000000-0000-0000-0000-000000000013');
update public.enrollment_students set residency_status = 'international' where id in ('e8000000-0000-0000-0000-000000000011', 'e8000000-0000-0000-0000-000000000012', 'e8000000-0000-0000-0000-000000000013');
insert into public.portal_profiles(id, auth_user_id, full_name, email) values ('d8000000-0000-0000-0000-000000000011', 'a8000000-0000-0000-0000-000000000011', 'Zz Brief One', 'qb.student1@example.test');
insert into public.agency_memberships(user_id, agency_id, role, student_id) values ('d8000000-0000-0000-0000-000000000011', 'c8000000-0000-0000-0000-000000000001', 'student', 'e8000000-0000-0000-0000-000000000011');
insert into public.cms_courses(id, slug, code, name, status, mode, tga_field_of_education_code, tga_anzsco_code, tga_qualification_level)
 values ('course-qb-test', 'qb-test-course', 'QB101', 'QB Test Course', 'Draft', 'Face to Face', '0403', '332211', 'Certificate III');
insert into public.cms_course_units(id, course_id, code, name, slit_hours, field_of_education_code, vet_flag) values ('unit-qb-1', 'course-qb-test', 'QBU1', 'Prepare surfaces', 40, '040300', 'Y');
-- intake 1 starts in ten days (Tentative until then); intake 2 started eight days ago (the daily job starts it; the released no-show rule waits 7 days)
insert into public.course_intakes(id, course_id, start_date, end_date, label, study_load) values
 ('f8000000-0000-0000-0000-000000000001', 'course-qb-test', current_date + 10, current_date + 200, 'QB later', 'coe'),
 ('f8000000-0000-0000-0000-000000000002', 'course-qb-test', current_date - 8, current_date + 190, 'QB now', 'coe');
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values
 ('f8000000-0000-0000-0000-000000000001', 'unit-qb-1', current_date + 10, current_date + 200),
 ('f8000000-0000-0000-0000-000000000002', 'unit-qb-1', current_date - 8, current_date + 190);
-- an intake is a class group once it has a classroom (as the released suite does)
update public.course_intakes set classroom_id = (select x.classroom_id from public.course_intakes x where x.classroom_id is not null limit 1)
 where id in ('f8000000-0000-0000-0000-000000000001', 'f8000000-0000-0000-0000-000000000002') and exists (select 1 from public.course_intakes x where x.classroom_id is not null);
update public.cms_courses set status = 'Published' where id = 'course-qb-test';
set local session_replication_role = replica;
insert into public.enrollment_applications(id, agency_id, student_id, student_name, student_email, status, data, reference) values
 ('b8000000-0000-0000-0000-000000000001', 'c8000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000011', 'Zz Brief One', 'qb.student1@example.test', 'coe_issued', '{"values":{"study_reason":"12"}}', 'ZZ-QB-1'),
 ('b8000000-0000-0000-0000-000000000002', 'c8000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000012', 'Zz Brief Two', 'qb.student2@example.test', 'coe_issued', '{"values":{"study_reason":"12"}}', 'ZZ-QB-2'),
 ('b8000000-0000-0000-0000-000000000003', 'c8000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000013', 'Zz Brief Three', 'qb.student3@example.test', 'offer_accepted', '{"values":{"study_reason":"12"}}', 'ZZ-QB-3');
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values
 ('b8000000-0000-0000-0000-000000000001', 'course-qb-test', 'QB101', 'QB Test Course', 'f8000000-0000-0000-0000-000000000001'),
 ('b8000000-0000-0000-0000-000000000002', 'course-qb-test', 'QB101', 'QB Test Course', 'f8000000-0000-0000-0000-000000000002'),
 ('b8000000-0000-0000-0000-000000000003', 'course-qb-test', 'QB101', 'QB Test Course', 'f8000000-0000-0000-0000-000000000001');
insert into public.enrollment_registrations(id, application_id, state, coe_number, lodged_at, lodged_by, verified_at, verified_by) values
 ('98000000-0000-0000-0000-000000000003', 'b8000000-0000-0000-0000-000000000003', 'verified', 'E3333333', now(), 'a8000000-0000-0000-0000-000000000001', now(), 'a8000000-0000-0000-0000-000000000001');
insert into public.enrollment_coe_documents(registration_id, application_id, kind, file_name, size_bytes, sha256, content, issued_at, document_number, issue_date) values
 (gen_random_uuid(), 'b8000000-0000-0000-0000-000000000001', 'coe', 'coe.pdf', 8, repeat('a', 64), '\x255044462d312e34'::bytea, now(), 'E1234567', current_date),
 (gen_random_uuid(), 'b8000000-0000-0000-0000-000000000002', 'coe', 'coe.pdf', 8, repeat('a', 64), '\x255044462d312e34'::bytea, now(), 'E7654321', current_date);
insert into public.enrollment_offer_letters(application_id, source, recipient_kind, file_name, size_bytes, sha256, content, signed_content, signed_sha256, accepted_at, accepted_via)
 values ('b8000000-0000-0000-0000-000000000001', 'upload', 'student', 'offer.pdf', 8, repeat('b', 64), '\x255044462d312e34'::bytea, '\x255044462d312e35'::bytea, repeat('c', 64), now(), 'signing');
insert into public.enrollment_application_documents(application_id, category, bucket_name, storage_path, filename, mime_type, file_size, is_current) values
 ('b8000000-0000-0000-0000-000000000001', 'Other', 'enrollment-documents', 'b8000000-0000-0000-0000-000000000001/validated-1.pdf', 'credit-evidence.pdf', 'application/pdf', 100, true),
 ('b8000000-0000-0000-0000-000000000001', 'Passport', 'enrollment-documents', 'b8000000-0000-0000-0000-000000000001/validated-2.pdf', 'passport.pdf', 'application/pdf', 100, true);
set local session_replication_role = origin;

-- ---------------------------------------------------------------- created at Enrolled
update public.enrollment_applications set status = 'enrolled' where id = 'b8000000-0000-0000-0000-000000000001';
select pg_temp.put('q1', (select id::text from public.intake_enrolments where application_id = 'b8000000-0000-0000-0000-000000000001'));
select ok(pg_temp.v('q1') is not null, 'CREATE the application becoming Enrolled creates its Qualification');
select is((select status || '|' || coalesce(coe_number, '-') || '|' || enrolment_type from public.intake_enrolments where id = pg_temp.v('q1')), 'tentative|E1234567|CoE', 'CREATE Tentative, with the CoE number');
select is((select count(*)::int || '|' || max(to_status) from public.intake_enrolment_status_history where enrolment_id = pg_temp.v('q1')), '1|tentative', 'CREATE the history starts with the creation');
select is((select count(*)::int from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1') and kind = 'coe' and content is not null), 1, 'DOCS the CoE is copied as its own document');
select is((select (content = '\x255044462d312e35'::bytea)::text from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1') and kind = 'signed_offer'), 'true', 'DOCS the signed offer is copied (the signed one)');
select is((select count(*)::int from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1') and kind = 'application_document' and file_name = 'credit-evidence.pdf'), 1, 'DOCS a non-personal application document gets its own copy');
select is((select count(*)::int from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1') and file_name = 'passport.pdf'), 0, 'DOCS a personal document (passport) is not copied: it stays on the student record');
select pg_temp.as_user('a8000000-0000-0000-0000-000000000001');
select ok((select bool_or(d->>'fileName' = 'passport.pdf' and (d->>'isCurrent')::boolean) from jsonb_array_elements(public.qualification_get(pg_temp.v('q1'))->'personalDocuments') d),
  'DOCS the passport is linked from the student record on the Qualification');
select pg_temp.as_postgres();
select pg_temp.put('docs', (select count(*)::text from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1')));
select lives_ok($$select public.qualification_create_from_application('b8000000-0000-0000-0000-000000000001')$$, 'CREATE running it again is harmless');
select is((select count(*)::int from public.intake_enrolments where student_id = 'e8000000-0000-0000-0000-000000000011'), 1, 'CREATE one record per student and intake');
select is((select count(*)::text from public.intake_enrolment_documents where enrolment_id = pg_temp.v('q1')), (select v from t where k = 'docs'), 'DOCS nothing copied twice');

-- ---------------------------------------------------------------- the moves and their reasons (as an Admin)
select pg_temp.as_user('a8000000-0000-0000-0000-000000000001');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'active', '')$$, pg_temp.v('q1'))) like 'refused:%', 'START by hand (Tentative -> In Progress) needs a reason');
select is(pg_temp.probe(format($$select public.qualification_set_status('%s', 'active', '%s')$$, pg_temp.v('q1'), pg_temp.reason('active'))), 'accepted', 'START by hand with a reason from the list is allowed');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'deferred', '', '', null, current_date + 60)$$, pg_temp.v('q1'))) like 'refused:%', 'REASON a reason is required to defer');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'deferred', 'Not a reason from the list', '', null, current_date + 60)$$, pg_temp.v('q1'))) like 'refused:%', 'REASON the reason comes from the list');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'deferred', '%s')$$, pg_temp.v('q1'), pg_temp.reason('deferred'))) like 'refused:%', 'DEFER a resume date is required');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'deferred', (select label from public.qualification_status_reasons where status = 'deferred' and is_other limit 1), '', null, current_date + 60)$$, pg_temp.v('q1'))) like 'refused:%', 'REASON an "Other" reason needs a note');
select lives_ok(format($$select public.qualification_set_status('%s', 'deferred', '%s', 'Surgery', null, current_date + 60)$$, pg_temp.v('q1'), pg_temp.reason('deferred')), 'DEFER with a reason and a resume date');
select is((select status || '|' || resume_date::text from public.intake_enrolments where id = pg_temp.v('q1')), 'deferred|' || (current_date + 60)::text, 'DEFER status and resume date stored');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.v('q1') and kind = 'prisms_report' and status = 'open' and due_on = public.course_intake_today() + 14), 1, 'PRISMS an international deferral opens "Report in PRISMS within 14 days"');
select pg_temp.as_postgres();
select ok(pg_temp.probe(format($$update public.intake_enrolments set status = 'completed' where id = '%s'$$, pg_temp.v('q1'))) like 'refused:%', 'RULES the database refuses Deferred -> Completed, whoever writes it');
select pg_temp.as_user('a8000000-0000-0000-0000-000000000001');
select is(public.qualification_moves('deferred'), array['active', 'withdrawn'], 'MOVES Deferred: In Progress or Cancelled');
select lives_ok(format($$select public.qualification_set_status('%s', 'active')$$, pg_temp.v('q1')), 'RESUME Deferred -> In Progress needs no reason');
select is((select status || '|' || coalesce(resume_date::text, '-') from public.intake_enrolments where id = pg_temp.v('q1')), 'active|-', 'RESUME In Progress, the resume date cleared');
select is(public.qualification_moves('active'), array['deferred', 'suspended', 'withdrawn', 'completed'], 'MOVES In Progress: Deferred, Suspended, Cancelled, Completed');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'completed', 'All units competent')$$, pg_temp.v('q1'))) like 'refused:%', 'COMPLETE refused while a unit has no result');
select lives_ok(format($$select public.qualification_set_status('%s', 'suspended', '%s', '', null, current_date + 30)$$, pg_temp.v('q1'), pg_temp.reason('suspended')), 'SUSPEND In Progress -> Suspended');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.v('q1') and kind = 'prisms_report' and status = 'open'), 2, 'PRISMS a suspension opens its own task');
select lives_ok(format($$select public.qualification_set_status('%s', 'withdrawn', '%s', 'Returned home', current_date)$$, pg_temp.v('q1'), pg_temp.reason('withdrawn')), 'CANCEL Suspended -> Cancelled');
select is((select status || '|' || (withdrawn_on = current_date)::text from public.intake_enrolments where id = pg_temp.v('q1')), 'withdrawn|true', 'CANCEL Cancelled with its withdrawal date');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.v('q1') and kind = 'refund_check' and status = 'open'), 1, 'CANCEL flags a refund check');
select is((select actual_completion_date from public.intake_enrolments where id = pg_temp.v('q1')), current_date, 'CANCEL sets the actual completion date (the withdrawal date)');
select is(public.qualification_moves('withdrawn'), array[]::text[], 'FINAL Cancelled offers no move');
select ok(pg_temp.probe(format($$select public.qualification_undo('%s', 'Not a reason from the list')$$, pg_temp.v('q1'))) like 'refused:%', 'UNDO takes a reason from the list');
select lives_ok(format($$select public.qualification_undo('%s', '%s')$$, pg_temp.v('q1'), coalesce(pg_temp.reason('undo'), 'Recorded in error')), 'UNDO an Admin undoes the cancellation with a reason');
select is((select status || '|' || coalesce(actual_completion_date::text, '-') from public.intake_enrolments where id = pg_temp.v('q1')), 'active|-', 'UNDO back to In Progress, the actual completion date cleared');
select is((select count(*)::int from public.intake_enrolment_status_history where enrolment_id = pg_temp.v('q1') and reason is distinct from 'Dates changed'), 6, 'HISTORY every change recorded (created, deferred, resumed, suspended, cancelled, undone)');
select ok(exists (select 1 from public.intake_enrolment_status_history where enrolment_id = pg_temp.v('q1') and reason like 'Undo:%'), 'HISTORY the undo names its reason');
select ok(pg_temp.probe(format($$select public.qualification_task_close('%s', '')$$, (select id from public.qualification_tasks where enrolment_id = pg_temp.v('q1') and kind = 'prisms_report' and status = 'open' order by created_at limit 1))) like 'refused:%', 'PRISMS closing a task needs the PRISMS reference');
select lives_ok(format($$select public.qualification_task_close('%s', 'PRISMS-REF-1')$$, (select id from public.qualification_tasks where enrolment_id = pg_temp.v('q1') and kind = 'prisms_report' and status = 'open' order by created_at limit 1)), 'PRISMS closed with the reference');
select ok(pg_temp.probe(format($$select public.qualification_set_dates('%s', current_date + 20, current_date + 5)$$, pg_temp.v('q1'))) like 'refused:%', 'DATES expected completion before commencement is refused');
select lives_ok(format($$select public.qualification_set_dates('%s', current_date + 12, current_date + 210, 'Late arrival agreed')$$, pg_temp.v('q1')), 'DATES an Admin edits commencement and expected completion');
select is((select (course_start_date = current_date + 12)::text || '|' || (course_end_date = current_date + 210)::text from public.intake_enrolments where id = pg_temp.v('q1')), 'true|true', 'DATES stored');
select ok(exists (select 1 from public.intake_enrolment_status_history where enrolment_id = pg_temp.v('q1') and reason = 'Dates changed' and note like '%Late arrival agreed%'), 'DATES the change is logged in the history');
select pg_temp.as_postgres();
select ok(pg_temp.probe(format($$update public.intake_enrolment_status_history set reason = 'x' where enrolment_id = '%s'$$, pg_temp.v('q1'))) like 'refused:%', 'HISTORY append-only: no edits');
select ok(pg_temp.probe(format($$delete from public.intake_enrolment_status_history where enrolment_id = '%s'$$, pg_temp.v('q1'))) like 'refused:%', 'HISTORY append-only: no deletes');

-- ---------------------------------------------------------------- completed only with every unit's result; the brief's links and dates
insert into public.lms_intake_students(intake_id, student_id) values ('f8000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000011') on conflict do nothing;
insert into public.lms_unit_students(intake_id, unit_id, student_id, course_id, assigned_start_date, assigned_end_date)
 values ('f8000000-0000-0000-0000-000000000001', 'unit-qb-1', 'e8000000-0000-0000-0000-000000000011', 'course-qb-test', current_date + 10, current_date + 200)
 on conflict (intake_id, unit_id, student_id) do nothing;
-- (the result itself is the assessments' business: recorded here directly)
set local session_replication_role = replica;
update public.lms_unit_students set outcome_code = '20', actual_start_date = current_date, actual_end_date = current_date
 where intake_id = 'f8000000-0000-0000-0000-000000000001' and student_id = 'e8000000-0000-0000-0000-000000000011';
set local session_replication_role = origin;
select is((select qualification_id from public.lms_unit_students where intake_id = 'f8000000-0000-0000-0000-000000000001' and student_id = 'e8000000-0000-0000-0000-000000000011'), pg_temp.v('q1'), 'LINK a unit enrolment carries its Qualification''s id');
select ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'asm_attempts' and column_name = 'qualification_id')
   and exists (select 1 from pg_trigger where tgname = 'qualification_attempt_link'), 'LINK an assessment attempt gets its Qualification''s id when it starts');
update public.intake_enrolments set status = 'active' where id = pg_temp.v('q1') and status <> 'active';
select pg_temp.as_user('a8000000-0000-0000-0000-000000000001');
select lives_ok(format($$select public.qualification_set_status('%s', 'completed')$$, pg_temp.v('q1')), 'COMPLETE every unit has a result: Completed, no reason needed');
select is((select status || '|' || (actual_completion_date = public.course_intake_today())::text from public.intake_enrolments where id = pg_temp.v('q1')), 'completed|true', 'COMPLETE stored with its actual completion date');
select pg_temp.as_postgres();
insert into public.course_completions(enrolment_id, student_id, course_id, kind, certificate_no, student_name, issued_at)
 values (pg_temp.v('q1'), 'e8000000-0000-0000-0000-000000000011', 'course-qb-test', 'certificate', 'QB-CERT-1', 'Zz Brief One', now());
select is((select award_issued_date from public.intake_enrolments where id = pg_temp.v('q1')), (now() at time zone public.institution_tz())::date, 'AWARD issuing the certificate sets the award issued date');
update public.course_completions set revoked_at = now(), revoked_by = 'a8000000-0000-0000-0000-000000000001', revoke_reason = 'test' where enrolment_id = pg_temp.v('q1') and kind = 'certificate';
select is((select award_issued_date from public.intake_enrolments where id = pg_temp.v('q1')), null, 'AWARD revoking it clears the date');

-- ---------------------------------------------------------------- the daily start and the no-show
select pg_temp.as_postgres();
update public.enrollment_applications set status = 'enrolled' where id = 'b8000000-0000-0000-0000-000000000002';
select pg_temp.put('q2', (select id::text from public.intake_enrolments where application_id = 'b8000000-0000-0000-0000-000000000002'));
select ok(pg_temp.v('q2') is not null, 'DAILY a Qualification in an intake that already started is created');
select lives_ok($$select public.qualification_daily()$$, 'DAILY the job runs');
select is((select status from public.intake_enrolments where id = pg_temp.v('q2')), 'active', 'DAILY it is In Progress from its commencement date');
select is((select count(*)::int from public.qualification_tasks where enrolment_id = pg_temp.v('q2') and kind = 'prisms_report' and status = 'open'), 1, 'NO-SHOW no attendance 7 days after the commencement date (released rule; the brief says by the commencement date): a PRISMS task');

-- ---------------------------------------------------------------- who sees what
select pg_temp.as_user('a8000000-0000-0000-0000-000000000011');
select ok(not (public.portal_qualifications('b8000000-0000-0000-0000-000000000001')::text ~* '"(note|status_?note|statusNote|history)"'), 'PORTAL the student sees no internal note or history');
select ok(pg_temp.probe($$select public.portal_qualifications('b8000000-0000-0000-0000-000000000002')$$) like 'refused:%' or public.portal_qualifications('b8000000-0000-0000-0000-000000000002') = '[]'::jsonb, 'PORTAL another student''s Qualification is not shown');
select ok(pg_temp.probe(format($$select public.qualification_set_status('%s', 'deferred', 'x', '', null, current_date + 60)$$, pg_temp.v('q2'))) like 'refused:%', 'PORTAL a student cannot change a status');

-- ---------------------------------------------------------------- existing behaviour and the one-step CoE
select pg_temp.as_postgres();
select ok(pg_get_functiondef('public.trainer_session_attendance(uuid)'::regprocedure) !~ '''deferred''', 'PAUSE the attendance roster lists In Progress students only');
select pg_temp.as_user('a8000000-0000-0000-0000-000000000001');
select lives_ok($$select public.issue_coe_voe('b8000000-0000-0000-0000-000000000003', 'coe', 'E3333333', current_date, 'coe.pdf', encode(convert_to(E'%PDF-1.4
1 0 obj<<>>endobj
trailer<<>>
%%EOF
', 'UTF8'), 'base64'), '', false)$$,
  'ONE STEP the Admin records the CoE');
select is((select status from public.enrollment_applications where id = 'b8000000-0000-0000-0000-000000000003'), 'enrolled', 'ONE STEP recording the CoE makes the application Enrolled');
select ok(exists (select 1 from public.intake_enrolments where application_id = 'b8000000-0000-0000-0000-000000000003'), 'ONE STEP and creates its Qualification');
select ok(pg_temp.probe($$select public.change_application_status('b8000000-0000-0000-0000-000000000003', 'enrol', '{}')$$) like 'refused:%', 'ONE STEP "Mark as enrolled" cannot be chosen any more');
select is((select is_automatic from public.application_status_transitions where from_status = 'coe_issued' and action_key = 'enrol'), true, 'ONE STEP the enrol move is automatic (not in Take action)');

select * from finish();
rollback;
