-- Match AVETMISS 8.0 NAT00080 exactly: English proficiency is not an AVETMISS 8.0 field, so it no longer blocks enrolment.
-- Street address is required (8.0 reports street number and street name).
create or replace function public.avetmiss_student_missing(p_student uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare s enrollment_students; d jsonb; m text[] := '{}'; v_overseas boolean;
begin
  select * into s from enrollment_students where id = p_student;
  if not found then return array['student record']; end if;
  d := coalesce(s.details, '{}'::jsonb);
  v_overseas := nullif(btrim(d->>'au_country'), '') is not null and lower(btrim(d->>'au_country')) not in ('australia', 'au');
  if nullif(btrim(d->>'first_name'), '') is null and nullif(btrim(d->>'last_name'), '') is null then m := array_append(m, 'name'); end if;
  if nullif(btrim(d->>'dob'), '') is null then m := array_append(m, 'date of birth'); end if;
  if s.sex_code is null then m := array_append(m, 'gender'); end if;
  if s.birth_country_code is null then m := array_append(m, 'country of birth'); end if;
  if s.home_language_code is null then m := array_append(m, 'language spoken at home'); end if;
  if s.indigenous_status_code is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  if s.school_level_code is null then m := array_append(m, 'highest school level completed'); end if;
  if s.at_school_flag is null then m := array_append(m, 'still at secondary school'); end if;
  if s.labour_force_code is null then m := array_append(m, 'employment status'); end if;
  if s.disability_flag is null then m := array_append(m, 'disability (yes/no)'); end if;
  if s.disability_flag = 'Y' and not exists (select 1 from student_disabilities x where x.student_id = s.id) then m := array_append(m, 'disability type'); end if;
  if s.prior_education_flag is null then m := array_append(m, 'prior education (yes/no)'); end if;
  if s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education x where x.student_id = s.id) then m := array_append(m, 'prior qualifications'); end if;
  if nullif(btrim(d->>'usi_number'), '') is null
     and not exists (select 1 from application_usi u join enrollment_applications a on a.id = u.application_id where a.student_id = s.id) then
    m := array_append(m, 'USI'); end if;
  if not v_overseas then
    if nullif(btrim(d->>'au_street'), '') is null then m := array_append(m, 'street address'); end if;
    if nullif(btrim(d->>'au_suburb'), '') is null then m := array_append(m, 'residential suburb'); end if;
    if coalesce(btrim(d->>'au_zip'), '') !~ '^[0-9]{4}$' then m := array_append(m, 'residential postcode'); end if;
    if nullif(btrim(d->>'au_state'), '') is null then m := array_append(m, 'residential state'); end if;
  end if;
  return m;
end $$;