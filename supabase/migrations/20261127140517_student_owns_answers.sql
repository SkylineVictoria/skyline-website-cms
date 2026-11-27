-- STUDENT-OWNS-ANSWERS (owner 2026-11-27): "except course, intake, sign and consent, store all in the student, so no duplicate data".
-- The student record (enrollment_students.details + its AVETMISS columns / tables) is the one place for the student's answers; an
-- application keeps only what belongs to it. Mechanics already in place and kept: every save routes the student's answers into
-- enrollment_students.details (b_route_student_fields -> student_apply_details) and strips them from the application; every read
-- merges them back (application_data / application_values); submit freezes the merged answers in enrollment_application_versions.
-- This migration:
-- * inverts the field list: application_field(key) names what belongs to the application (course and intake, consents and
--   declarations, signature, guardian, agent block, OSHC, offer, fees, RPL / credit, marketing answers, internal keys); every other
--   answer is the student's (is_student_field = not application field). Before, only a hand-made list was routed and the rest
--   (e.g. disability_types, prior_education, au_permanent_resident) stayed on each application.
-- * routes on INSERT too (an application created with answers), and when an application is given its student.
-- * AVETMISS copies (English proficiency, school year, prior education rows, disability types) now follow the student's details
--   (trigger student_details_avetmiss_sync on enrollment_students) instead of the application's answers; the application-side
--   trigger avetmiss_answers_to_student and yesterday's zzy_application_prior_education_fill are dropped (the answers are no longer on
--   the application; reads already merge the student's).
-- * moves the student answers still sitting on existing applications to their students (hosted holds no application today).
-- Documents stay per application in this stage. Down: restore is_student_field from 20261127130517-era definition, recreate the two
-- dropped triggers, drop student_details_avetmiss_sync and application_field.
begin;

create or replace function public.application_field(p_key text) returns boolean
language sql immutable parallel safe set search_path = '' as $fn$
  select p_key in (
      'courses_of_interest', 'preferred_intake', 'intake_note', 'study_reason', 'rpl', 'credit_upload', 'hear_about',
      'consent', 'declaration', 'declaration_read', 'digital_signature', 'checklist', 'usi_consent', 'via_agent')
    or p_key like any (array['course\_%', 'intake\_%', 'consent\_%', 'declaration\_%', 'signature\_%', 'guardian\_%', 'agent\_%',
      'oshc\_%', 'offer\_%', 'fee\_%', 'fees\_%', 'checklist\_%', 'coe\_%', 'voe\_%', 'payment\_%', 'deposit\_%', '\_%']);
$fn$;
comment on function public.application_field(text) is
  'STUDENT-OWNS-ANSWERS: an answer that belongs to one application (course / intake, consent, declaration, signature, guardian, agent, OSHC, offer, fees); every other answer is the student''s.';

create or replace function public.is_student_field(p_key text) returns boolean
language sql immutable parallel safe as $fn$
  select p_key is not null and p_key <> '' and not public.application_field(p_key);
$fn$;

-- Route on insert too, and when the application is given its student.
drop trigger if exists b_route_student_fields on public.enrollment_applications;
create trigger b_route_student_fields
  before insert or update of data, student_id on public.enrollment_applications
  for each row execute function public.application_route_student_fields();

-- AVETMISS copies follow the student's own details.
create or replace function public.student_details_avetmiss_sync() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v jsonb := coalesce(new.details, '{}'::jsonb);
  o jsonb := case when tg_op = 'UPDATE' then coalesce(old.details, '{}'::jsonb) else '{}'::jsonb end;
  v_text text; v_rows jsonb; r jsonb;
begin
  v_text := btrim(coalesce(v->>'english_proficiency_code', ''));
  if v_text is distinct from btrim(coalesce(o->>'english_proficiency_code', '')) and avetmiss_is_code('english_proficiency', v_text) then
    update enrollment_students set english_proficiency_code = v_text where id = new.id and english_proficiency_code is distinct from v_text;
  end if;

  v_text := btrim(coalesce(v->>'year_completed', ''));
  if v_text is distinct from btrim(coalesce(o->>'year_completed', '')) and v_text ~ '^[0-9]{4}$'
     and v_text::int between 1900 and extract(year from current_date)::int then
    update enrollment_students set school_level_year = v_text where id = new.id and school_level_year is distinct from v_text;
  end if;

  if (v->'prior_education') is distinct from (o->'prior_education') and nullif(btrim(coalesce(v->>'prior_education', '')), '') is not null then
    begin
      v_rows := case jsonb_typeof(v->'prior_education') when 'array' then v->'prior_education' else (v->>'prior_education')::jsonb end;
    exception when others then v_rows := null; end;
    if jsonb_typeof(v_rows) = 'array' and exists (select 1 from jsonb_array_elements(v_rows) x
         where avetmiss_is_code('prior_education', x->>'code') and avetmiss_is_code('prior_education_recognition', x->>'recognition')) then
      delete from student_prior_education where student_id = new.id;
      for r in select * from jsonb_array_elements(v_rows) loop
        if avetmiss_is_code('prior_education', r->>'code') and avetmiss_is_code('prior_education_recognition', r->>'recognition') then
          insert into student_prior_education(student_id, prior_education_code, recognition_code, qualification_name)
          values (new.id, r->>'code', r->>'recognition', left(nullif(btrim(coalesce(r->>'name', '')), ''), 200))
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end if;

  if (v->>'disability_types') is distinct from (o->>'disability_types') and nullif(btrim(coalesce(v->>'disability_types', '')), '') is not null then
    if exists (select 1 from unnest(string_to_array(v->>'disability_types', ',')) c where avetmiss_is_code('disability_type', btrim(c))) then
      delete from student_disabilities where student_id = new.id;
      insert into student_disabilities(student_id, disability_type_code)
      select distinct new.id, btrim(c) from unnest(string_to_array(v->>'disability_types', ',')) c
       where avetmiss_is_code('disability_type', btrim(c))
      on conflict do nothing;
    end if;
  end if;
  return null;
end $fn$;
revoke all on function public.student_details_avetmiss_sync() from public, anon, authenticated;

drop trigger if exists student_details_avetmiss_sync on public.enrollment_students;
create trigger student_details_avetmiss_sync
  after insert or update of details on public.enrollment_students
  for each row execute function public.student_details_avetmiss_sync();

drop trigger if exists avetmiss_answers_to_student on public.enrollment_applications;
drop function if exists public.avetmiss_answers_to_student();
drop trigger if exists zzy_application_prior_education_fill on public.enrollment_applications;
drop function if exists public.application_prior_education_fill();

-- Student answers still on existing applications move to their students (oldest first, so the latest application's answer wins).
do $move$
declare r record;
begin
  for r in select a.id from public.enrollment_applications a
            where a.student_id is not null and public.student_values(a.data->'values') <> '{}'::jsonb
            order by a.updated_at loop
    perform set_config('portal.draft_command', r.id::text, true);
    begin
      update public.enrollment_applications set data = data where id = r.id;
    exception when others then
      raise warning 'Application % kept its student answers (%)', r.id, sqlerrm;
    end;
  end loop;
  perform set_config('portal.draft_command', '', true);
end $move$;

commit;
