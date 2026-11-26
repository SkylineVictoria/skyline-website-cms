-- AVETMISS-PAGE-CHECK (owner 2026-11-26: "apply validation at each page of the wizard; if a problem is there don't move further").
-- The Submit check (avetmiss_student_missing) reads the student record, so a gap showed only at the end. avetmiss_answers_missing
-- runs the same required-answer rules on the answers themselves (application values), with the same wording, so the wizard can block
-- each page's Next until that page is complete. avetmiss_check_answers returns it as missingInAnswers (fieldErrors / missingForSubmit
-- unchanged). Read-only. Down: re-create avetmiss_check_answers from 20261127050517-era definition; drop avetmiss_answers_missing.
begin;

create or replace function public.avetmiss_answers_missing(p_values jsonb) returns text[]
language plpgsql stable security definer set search_path = public as $fn$
declare v jsonb := coalesce(p_values, '{}'::jsonb); m text[] := '{}'; v_dob date; v_lang text; v_school text; v_year text; v_rows jsonb;
  t text := '';
begin
  if nullif(btrim(v->>'first_name'), '') is null and nullif(btrim(v->>'last_name'), '') is null then m := m || 'name'::text; end if;
  begin v_dob := nullif(btrim(v->>'dob'), '')::date; exception when others then v_dob := null; end;
  if v_dob is null then m := m || 'date of birth'::text;
  elsif v_dob > current_date - interval '10 years' or v_dob < current_date - interval '100 years' then m := m || 'valid date of birth (age 10-100)'::text; end if;
  if avetmiss_code('sex', v->>'gender') is null then m := m || 'gender'::text; end if;
  if avetmiss_code('country', v->>'birth_country') is null then m := m || 'country of birth'::text; end if;
  v_lang := coalesce(avetmiss_code('language', v->>'language_home'), avetmiss_code('language', v->>'language_other'));
  if v_lang is null then m := m || 'language spoken at home'::text;
  elsif v_lang not in ('1201', '@@@@') and not avetmiss_is_code('english_proficiency', btrim(coalesce(v->>'english_proficiency_code', ''))) then
    m := m || 'English proficiency'::text; end if;
  if avetmiss_code('indigenous_status', v->>'atsi') is null then m := m || 'Aboriginal or Torres Strait Islander status'::text; end if;
  v_school := avetmiss_code('school_level', v->>'school_level');
  v_year := btrim(coalesce(v->>'year_completed', ''));
  if v_school is null then m := m || 'highest school level completed'::text;
  elsif v_school not in ('02', '@@') and v_year !~ '^[0-9]{4}$' then m := m || 'year highest school level completed'::text;
  elsif v_year ~ '^[0-9]{4}$' and v_dob is not null and (v_year::int < extract(year from v_dob) + 5 or v_year::int > extract(year from current_date)) then
    m := m || 'valid year school completed'::text; end if;
  if avetmiss_code('flag', v->>'secondary_enrolled') is null then m := m || 'still at secondary school'::text; end if;
  if avetmiss_code('labour_force', v->>'employment') is null then m := m || 'employment status'::text; end if;
  if avetmiss_code('flag', v->>'disability') is null then m := m || 'disability (yes/no)'::text;
  elsif avetmiss_code('flag', v->>'disability') = 'Y' and not exists (select 1 from unnest(string_to_array(coalesce(v->>'disability_types', ''), ',')) c
       where avetmiss_is_code('disability_type', btrim(c))) then m := m || 'disability type'::text; end if;
  if avetmiss_code('flag', v->>'prior_ed') is null then m := m || 'prior education (yes/no)'::text;
  elsif avetmiss_code('flag', v->>'prior_ed') = 'Y' then
    begin
      v_rows := case jsonb_typeof(v->'prior_education') when 'array' then v->'prior_education' else nullif(btrim(coalesce(v->>'prior_education', '')), '')::jsonb end;
    exception when others then v_rows := null; end;
    if v_rows is null or jsonb_typeof(v_rows) <> 'array' or not exists (select 1 from jsonb_array_elements(v_rows) x
         where avetmiss_is_code('prior_education', x->>'code') and avetmiss_is_code('prior_education_recognition', x->>'recognition')) then
      m := m || 'prior qualifications'::text; end if;
  end if;
  -- The wizard's address is Australian (the full form's overseas address keeps the student-record check at Submit).
  if coalesce(v->>'address_type', 'Australian Address') <> 'Overseas Address' then
    if nullif(btrim(v->>'au_street'), '') is null then m := m || 'street address'::text; end if;
    if nullif(btrim(v->>'au_suburb'), '') is null then m := m || 'residential suburb'::text; end if;
    if coalesce(btrim(v->>'au_zip'), '') !~ '^[0-9]{4}$' then m := m || 'residential postcode'::text; end if;
    if avetmiss_code('state', v->>'au_state') is null then m := m || 'residential state'::text; end if;
  end if;
  return m;
end $fn$;
revoke all on function public.avetmiss_answers_missing(jsonb) from public, anon;
grant execute on function public.avetmiss_answers_missing(jsonb) to authenticated;

create or replace function public.avetmiss_check_answers(p_values jsonb, p_student uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_missing text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_student is not null then
    v_missing := array_remove(avetmiss_student_missing(p_student), 'USI');
  end if;
  return jsonb_build_object('fieldErrors', avetmiss_field_errors(p_values),
                            'missingForSubmit', to_jsonb(v_missing),
                            'missingInAnswers', to_jsonb(avetmiss_answers_missing(p_values)),
                            'ok', avetmiss_field_errors(p_values) = '{}'::jsonb);
end $function$;

commit;
