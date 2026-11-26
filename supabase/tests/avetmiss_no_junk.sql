begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- AVETMISS-NO-JUNK (20261127050517): application answers are checked on every write (changed answers only, blanks pass, old answers
-- kept), and every AVETMISS column has a guard. The installed trigger function is exercised on a scratch copy of the table, so no real
-- application is touched. Rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(13);

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
select ok(exists (select 1 from pg_trigger where tgname = 'avetmiss_answers_to_student' and tgrelid = 'public.enrollment_applications'::regclass), 'application answers are copied to the student record');
-- AVETMISS-PAGE-CHECK (20261127110517): each wizard page is checked against the same required answers as Submit.
select ok(cardinality(public.avetmiss_answers_missing('{}'::jsonb)) >= 12, 'an empty application misses every required AVETMISS answer');
select ok('year highest school level completed' = any(public.avetmiss_answers_missing('{"school_level": "Year 12 or equivalent - 12"}'::jsonb)),
  'a school level without the year completed is reported');

select * from finish();
rollback;
