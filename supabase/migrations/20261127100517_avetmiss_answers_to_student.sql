-- AVETMISS-SUBMIT-FIX (owner 2026-11-26: a student submitting got "Missing: English proficiency / year highest school level
-- completed / prior qualifications · About the student" although they had answered). The submit check (avetmiss_student_missing)
-- reads the student record; these three answers were kept only in the application values and copied to the student tables by the
-- browser, which a student may not write (the copy ran only for staff), and the year had no box in the wizard.
-- Now the database copies them whenever the application's answers change (any writer: student, agent, staff):
--   english_proficiency_code -> enrollment_students.english_proficiency_code (AVETMISS code)
--   year_completed (4 digits)  -> enrollment_students.school_level_year
--   prior_education (JSON rows { code, recognition, name }) -> student_prior_education (replaced)
--   disability_types (codes separated by commas)            -> student_disabilities (replaced)
-- Only valid AVETMISS codes are copied (invalid ones are skipped; the application trigger already refuses junk). A value is copied
-- only when it changed in this write, so staff edits on the student page are not overwritten by an unrelated save. One backfill
-- fills the same fields for students where they are still empty. Down: drop trigger avetmiss_answers_to_student and its function.
begin;

create or replace function public.avetmiss_answers_to_student() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v jsonb := coalesce(new.data->'values', '{}'::jsonb);
  o jsonb := case when tg_op = 'UPDATE' then coalesce(old.data->'values', '{}'::jsonb) else '{}'::jsonb end;
  v_text text; v_rows jsonb; r jsonb;
begin
  if new.student_id is null then return null; end if;

  v_text := btrim(coalesce(v->>'english_proficiency_code', ''));
  if v_text is distinct from btrim(coalesce(o->>'english_proficiency_code', '')) and avetmiss_is_code('english_proficiency', v_text) then
    update enrollment_students set english_proficiency_code = v_text
     where id = new.student_id and english_proficiency_code is distinct from v_text;
  end if;

  v_text := btrim(coalesce(v->>'year_completed', ''));
  if v_text is distinct from btrim(coalesce(o->>'year_completed', '')) and v_text ~ '^[0-9]{4}$'
     and v_text::int between 1900 and extract(year from current_date)::int then
    update enrollment_students set school_level_year = v_text
     where id = new.student_id and school_level_year is distinct from v_text;
  end if;

  if (v->'prior_education') is distinct from (o->'prior_education') and nullif(btrim(coalesce(v->>'prior_education', '')), '') is not null then
    begin
      v_rows := case jsonb_typeof(v->'prior_education') when 'array' then v->'prior_education' else (v->>'prior_education')::jsonb end;
    exception when others then v_rows := null; end;
    if jsonb_typeof(v_rows) = 'array' and exists (select 1 from jsonb_array_elements(v_rows) x
         where avetmiss_is_code('prior_education', x->>'code') and avetmiss_is_code('prior_education_recognition', x->>'recognition')) then
      delete from student_prior_education where student_id = new.student_id;
      for r in select * from jsonb_array_elements(v_rows) loop
        if avetmiss_is_code('prior_education', r->>'code') and avetmiss_is_code('prior_education_recognition', r->>'recognition') then
          insert into student_prior_education(student_id, prior_education_code, recognition_code, qualification_name)
          values (new.student_id, r->>'code', r->>'recognition', left(nullif(btrim(coalesce(r->>'name', '')), ''), 200))
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end if;

  if (v->>'disability_types') is distinct from (o->>'disability_types') and nullif(btrim(coalesce(v->>'disability_types', '')), '') is not null then
    if exists (select 1 from unnest(string_to_array(v->>'disability_types', ',')) c where avetmiss_is_code('disability_type', btrim(c))) then
      delete from student_disabilities where student_id = new.student_id;
      insert into student_disabilities(student_id, disability_type_code)
      select distinct new.student_id, btrim(c) from unnest(string_to_array(v->>'disability_types', ',')) c
       where avetmiss_is_code('disability_type', btrim(c))
      on conflict do nothing;
    end if;
  end if;
  return null;
end $fn$;
revoke all on function public.avetmiss_answers_to_student() from public, anon, authenticated;

drop trigger if exists avetmiss_answers_to_student on public.enrollment_applications;
create trigger avetmiss_answers_to_student
  after insert or update of data, student_id on public.enrollment_applications
  for each row execute function public.avetmiss_answers_to_student();

-- Backfill: students whose fields are still empty get them from their latest application that has the answer.
update enrollment_students s set english_proficiency_code = x.code
  from (select distinct on (a.student_id) a.student_id, btrim(a.data#>>'{values,english_proficiency_code}') code
          from enrollment_applications a where avetmiss_is_code('english_proficiency', btrim(a.data#>>'{values,english_proficiency_code}'))
         order by a.student_id, a.updated_at desc) x
 where s.id = x.student_id and s.english_proficiency_code is null;
update enrollment_students s set english_proficiency_code = btrim(s.details->>'english_proficiency_code')
 where s.english_proficiency_code is null and avetmiss_is_code('english_proficiency', btrim(s.details->>'english_proficiency_code'));

update enrollment_students s set school_level_year = x.yr
  from (select distinct on (a.student_id) a.student_id, btrim(a.data#>>'{values,year_completed}') yr
          from enrollment_applications a where btrim(coalesce(a.data#>>'{values,year_completed}', '')) ~ '^[0-9]{4}$'
         order by a.student_id, a.updated_at desc) x
 where s.id = x.student_id and s.school_level_year is null;

insert into student_prior_education(student_id, prior_education_code, recognition_code, qualification_name)
select distinct on (a.student_id, r->>'code', r->>'recognition') a.student_id, r->>'code', r->>'recognition', left(nullif(btrim(coalesce(r->>'name', '')), ''), 200)
  from enrollment_applications a
  cross join lateral jsonb_array_elements(case when a.data#>>'{values,prior_education}' ~ '^\s*\[' then (a.data#>>'{values,prior_education}')::jsonb else '[]'::jsonb end) r
 where a.student_id is not null
   and avetmiss_is_code('prior_education', r->>'code') and avetmiss_is_code('prior_education_recognition', r->>'recognition')
   and not exists (select 1 from student_prior_education p where p.student_id = a.student_id)
on conflict do nothing;

insert into student_disabilities(student_id, disability_type_code)
select distinct a.student_id, btrim(c)
  from enrollment_applications a cross join lateral unnest(string_to_array(coalesce(a.data#>>'{values,disability_types}', ''), ',')) c
 where a.student_id is not null and avetmiss_is_code('disability_type', btrim(c))
   and not exists (select 1 from student_disabilities d where d.student_id = a.student_id)
on conflict do nothing;

commit;
