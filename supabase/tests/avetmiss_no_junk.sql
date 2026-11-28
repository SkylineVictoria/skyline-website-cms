begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- AVETMISS-NO-JUNK (20261127050517): application answers are checked on every write (changed answers only, blanks pass, old answers
-- kept), and every AVETMISS column has a guard. The installed trigger function is exercised on a scratch copy of the table, so no real
-- application is touched. Rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(28);

-- Every AVETMISS code column has a foreign key, a check or a validating trigger: a new column added without one fails here.
select is((select count(*)::int from public.avetmiss_guard_gaps()), 0, 'no AVETMISS column without a guard');

create schema avetmiss_junk_t;
create table avetmiss_junk_t.apps (id int primary key, data jsonb);
create trigger t before insert or update of data on avetmiss_junk_t.apps
  for each row execute function public.enrollment_applications_avetmiss_values();

create function pg_temp.refused(sql text) returns text language plpgsql as $$
begin execute sql; return 'accepted';
exception when check_violation then return 'refused: ' || sqlerrm; end $$;

select is(pg_temp.refused($$insert into avetmiss_junk_t.apps values (1, '{"values": {"gender": "", "au_zip": "", "dob": ""}}')$$),
  'accepted', 'blank answers save (a draft)');
select is(pg_temp.refused($$insert into avetmiss_junk_t.apps values (2, '{"values": {"gender": "Female", "atsi": "No", "school_level": "Year 12 or equivalent - 12", "employment": "Full-Time Employee - 01", "disability": "No", "prior_ed": "Not specified", "secondary_enrolled": "No", "language_home": "No, English only - 1201", "study_reason": "To get a job - 01", "au_state": "VIC", "au_zip": "3000", "dob": "2000-05-01", "birth_country": "India"}}')$$),
  'accepted', 'every valid wizard option saves');
select ok(pg_temp.refused($$insert into avetmiss_junk_t.apps values (3, '{"values": {"gender": "Robot"}}')$$) like 'refused: These answers are not valid for AVETMISS reporting: Choose a gender%', 'an invalid gender is refused with its message');
select ok(pg_temp.refused($$update avetmiss_junk_t.apps set data = jsonb_set(data, '{values,au_zip}', '"12"') where id = 2$$) like 'refused:%postcode%', 'changing a valid postcode to junk is refused');
select ok(pg_temp.refused($$update avetmiss_junk_t.apps set data = jsonb_set(data, '{values,dob}', '"2099-01-01"') where id = 2$$) like 'refused:%date of birth%', 'a future date of birth is refused');
select is(pg_temp.refused($$update avetmiss_junk_t.apps set data = jsonb_set(data, '{values,gender}', '"Male"') where id = 2$$), 'accepted', 'a valid change saves');

-- The past: an old row with junk (written before the trigger) still saves when another answer changes, but its junk cannot change to new junk.
alter table avetmiss_junk_t.apps disable trigger t;
insert into avetmiss_junk_t.apps values (4, '{"values": {"gender": "Robot", "first_name": "Old"}}');
alter table avetmiss_junk_t.apps enable trigger t;
select is(pg_temp.refused($$update avetmiss_junk_t.apps set data = jsonb_set(data, '{values,first_name}', '"Older"') where id = 4$$), 'accepted', 'old junk does not block other edits');
select ok(pg_temp.refused($$update avetmiss_junk_t.apps set data = jsonb_set(data, '{values,gender}', '"Alien"') where id = 4$$) like 'refused:%', 'old junk cannot be replaced by new junk');

select ok(exists (select 1 from pg_trigger where tgname = 'avetmiss_application_values' and tgrelid = 'public.enrollment_applications'::regclass), 'the trigger is on enrollment_applications');

-- AVETMISS-SUBMIT-FIX (20261127100517): the student's answers reach the student record the submit check reads.
select ok(exists (select 1 from pg_trigger where tgname = 'student_details_avetmiss_sync' and tgrelid = 'public.enrollment_students'::regclass), 'the student''s answers reach the AVETMISS columns and tables (STUDENT-OWNS-ANSWERS)');
-- AVETMISS-PAGE-CHECK (20261127110517): each wizard page is checked against the same required answers as Submit.
select ok(cardinality(public.avetmiss_answers_missing('{}'::jsonb)) >= 12, 'an empty application misses every required AVETMISS answer');
select ok('year highest school level completed' = any(public.avetmiss_answers_missing('{"school_level": "Year 12 or equivalent - 12"}'::jsonb)),
  'a school level without the year completed is reported');

-- MIGRATION-SYNC (2026-11-27): the street address split (20261125113726) and residency (20261125123147), restored from hosted.
select is((select row(flat, street_number, street_name)::text from public.avetmiss_split_street('Unit 4/12-14 Smith Street')), '(4,12-14,"Smith Street")', 'a unit / number / street address is split into the NAT00080 parts');
select is((select needs_review from public.avetmiss_split_street('PO Box 99')), true, 'a PO box is flagged for staff review (no street number)');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.enrollment_students'::regclass and conname = 'enrollment_students_address_street_number_check'), 'the street number is length-checked (AVETMISS 15)');
select ok(pg_get_constraintdef((select oid from pg_constraint where conrelid = 'public.enrollment_students'::regclass and conname = 'enrollment_students_residency_status_check')) like '%permanent_resident%', 'residency status accepts only the four kinds');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.enrollment_students'::regclass and tgname in ('avetmiss_address_split', 'avetmiss_residency') having count(*) = 2), 'address split and residency triggers are on enrollment_students');
-- QUALIFICATION (20261128003517): the withdrawal guard stays (a Cancelled Qualification needs its withdrawal date, units close as 40),
-- and the new Qualification statuses keep the text columns guarded.
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.intake_enrolments'::regclass and tgname in ('intake_enrolments_withdrawal_before', 'intake_enrolments_withdrawal_after', 'a1_qualification_status') having count(*) = 3), 'the withdrawal guard and the Qualification status guard are on intake_enrolments');
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'intake_enrolments_status_text_check')) like '%status_reason%', 'the Qualification reason, note and CoE / VoE numbers are length-checked');
-- QUALIFICATION-BRIEF (2026-11-27): the Qualification's new columns (dates, the Qualification's id on unit enrolments) leave no guard gap
select is((select count(*)::int from public.avetmiss_guard_gaps() where table_name in ('intake_enrolments', 'lms_unit_students')), 0, 'the Qualification''s dates and links on NAT source tables leave no AVETMISS guard gap');
-- AXCELERATE-STUDENT-LISTS (20261128061517): aXcelerate's list fields (JSON arrays or comma text) become prior education and disability
-- rows; a bad item is skipped with a warning and never fails the student; the sync never inserts a row without a code.
select is(public.axcelerate_student_values('{"PRIOREDUCATIONIDS": ["008I"], "PRIOREDUCATIONNAMES": ["Bachelor degree or higher degree"]}')->'details'->'prior_education',
  '[{"code": "008", "recognition": "I", "name": "Bachelor degree or higher degree"}]'::jsonb, 'a JSON array item 008I is code 008, recognition I, with its name');
insert into public.enrollment_students(agency_id, full_name, email, details)
select (select id from public.agencies where is_direct order by created_at limit 1), 'Zz Lists One', 'zz.lists.one@blackhole.postmarkapp.com',
       public.axcelerate_student_values('{"PRIOREDUCATIONIDS": ["008I"], "PRIOREDUCATIONNAMES": ["Bachelor degree or higher degree"], "DISABILITYTYPEIDS": ["11", "12"]}')->'details';
select is((select array_agg(prior_education_code || recognition_code || ':' || coalesce(qualification_name, '')) from public.student_prior_education p
            join public.enrollment_students s on s.id = p.student_id where s.email = 'zz.lists.one@blackhole.postmarkapp.com'),
  array['008I:Bachelor degree or higher degree'], 'the student gets prior education 008 / I with the name');
select is((select array_agg(disability_type_code order by disability_type_code) from public.student_disabilities d
            join public.enrollment_students s on s.id = d.student_id where s.email = 'zz.lists.one@blackhole.postmarkapp.com'),
  array['11', '12'], 'a JSON array ["11","12"] gives two disability types');
insert into public.enrollment_students(agency_id, full_name, email, details)
select (select id from public.agencies where is_direct order by created_at limit 1), 'Zz Lists Two', 'zz.lists.two@blackhole.postmarkapp.com',
       public.axcelerate_student_values('{"PRIOREDUCATIONIDS": "008A,410E"}')->'details';
select is((select array_agg(prior_education_code || recognition_code order by prior_education_code) from public.student_prior_education p
            join public.enrollment_students s on s.id = p.student_id where s.email = 'zz.lists.two@blackhole.postmarkapp.com'),
  array['008A', '410E'], 'comma text "008A,410E" gives two prior education rows');
select ok((select bool_or(w like '%"XYZ"%skipped%') from jsonb_array_elements_text(public.axcelerate_student_values('{"PRIOREDUCATIONIDS": ["XYZ", "008I"], "DISABILITYTYPEIDS": ["11", "ABC"]}')->'warnings') w)
  and public.axcelerate_student_values('{"PRIOREDUCATIONIDS": ["XYZ", "008I"]}')->'details'->'prior_education' = '[{"code": "008", "recognition": "I"}]'::jsonb,
  'a bad item (XYZ) is skipped with a warning; the good items are kept');
select lives_ok($$insert into public.enrollment_students(agency_id, full_name, email, details)
  select (select id from public.agencies where is_direct order by created_at limit 1), 'Zz Lists Three', 'zz.lists.three@blackhole.postmarkapp.com',
         public.axcelerate_student_values('{"PRIOREDUCATIONIDS": ["XYZ"], "DISABILITYTYPEIDS": ["ABC"]}')->'details'$$, 'a student with only bad list items still saves');
select lives_ok($$insert into public.enrollment_students(agency_id, full_name, email, details)
  select (select id from public.agencies where is_direct order by created_at limit 1), 'Zz Lists Four', 'zz.lists.four@blackhole.postmarkapp.com',
         '{"prior_education": [{"code": null, "recognition": null}, {"code": "008"}], "disability_types": " , "}'::jsonb$$,
  'the sync skips prior education rows without a code or recognition, and empty disability items (no NULL insert)');
select * from finish();
rollback;
