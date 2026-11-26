-- Applied on hosted 20261126124747 (avetmiss_reject_invalid_input) outside this repo; pulled from supabase_migrations.schema_migrations.statements so the lab replays what hosted has.
-- Fields that were filled in but do not match an AVETMISS code or format.
-- Blank fields are allowed here (drafts save as they go); completeness is checked at submission and enrolment.
create or replace function public.avetmiss_details_invalid(d jsonb)
 returns text[] language plpgsql stable set search_path to 'public'
as $function$
declare m text[] := '{}'; v text; v_dob date;
  function_blank boolean;
begin
  d := coalesce(d, '{}'::jsonb);
  v := nullif(btrim(d->>'gender'), '');
  if v is not null and avetmiss_code('sex', v) is null then m := array_append(m, 'gender'); end if;
  v := nullif(btrim(d->>'atsi'), '');
  if v is not null and avetmiss_code('indigenous_status', v) is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  v := nullif(btrim(d->>'school_level'), '');
  if v is not null and avetmiss_code('school_level', v) is null then m := array_append(m, 'highest school level completed'); end if;
  v := nullif(btrim(d->>'employment'), '');
  if v is not null and avetmiss_code('labour_force', v) is null then m := array_append(m, 'employment status'); end if;
  v := nullif(btrim(d->>'disability'), '');
  if v is not null and avetmiss_code('flag', v) is null then m := array_append(m, 'disability (yes/no)'); end if;
  v := nullif(btrim(d->>'prior_ed'), '');
  if v is not null and avetmiss_code('flag', v) is null then m := array_append(m, 'prior education (yes/no)'); end if;
  v := nullif(btrim(d->>'secondary_enrolled'), '');
  if v is not null and avetmiss_code('flag', v) is null then m := array_append(m, 'still at secondary school'); end if;
  v := nullif(btrim(d->>'birth_country'), '');
  if v is not null and avetmiss_code('country', v) is null then m := array_append(m, 'country of birth'); end if;
  -- Home language: either the answer itself maps, or "Yes" with the other language chosen (may still be blank in a draft)
  v := nullif(btrim(d->>'language_other'), '');
  if v is not null and avetmiss_code('language', v) is null then m := array_append(m, 'language spoken at home'); end if;
  v := nullif(btrim(d->>'language_home'), '');
  if v is not null and avetmiss_code('language', v) is null and lower(v) !~ '^yes' then m := array_append(m, 'language spoken at home'); end if;
  v := nullif(btrim(d->>'year_completed'), '');
  if v is not null and not (v = '@@@@' or (v ~ '^[0-9]{4}$' and v::int between 1920 and extract(year from current_date)::int)) then
    m := array_append(m, 'year school completed (4 digits)'); end if;
  v := nullif(btrim(d->>'dob'), '');
  if v is not null then
    begin v_dob := v::date; exception when others then v_dob := null; end;
    if v_dob is null or v_dob > current_date or v_dob < current_date - interval '100 years' then m := array_append(m, 'date of birth'); end if;
  end if;
  v := nullif(btrim(d->>'study_reason'), '');
  if v is not null and avetmiss_code('study_reason', v) is null then m := array_append(m, 'study reason'); end if;
  if coalesce(d->>'address_type', 'Australian Address') = 'Australian Address' then
    v := nullif(btrim(d->>'au_zip'), '');
    if v is not null and v !~ '^[0-9]{4}$' then m := array_append(m, 'postcode (4 digits)'); end if;
    v := nullif(btrim(d->>'au_state'), '');
    if v is not null and avetmiss_code('state', v) is null then m := array_append(m, 'state'); end if;
  end if;
  return m;
end $function$;

-- Rule 1: never store an invalid AVETMISS value on a student, even in a draft.
create or replace function public.enrollment_students_avetmiss_valid()
 returns trigger language plpgsql set search_path to 'public'
as $function$
declare v_bad text[];
begin
  if tg_op = 'INSERT' or new.details is distinct from old.details then
    v_bad := avetmiss_details_invalid(new.details);
    if array_length(v_bad, 1) > 0 then
      raise exception 'These answers are not valid for AVETMISS reporting: %. Choose an option from the list.', array_to_string(v_bad, ', ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $function$;

drop trigger if exists avetmiss_student_valid on public.enrollment_students;
create trigger avetmiss_student_valid before insert or update on public.enrollment_students
  for each row execute function public.enrollment_students_avetmiss_valid();

-- Rule 2: an application can only leave draft / action required when the student's AVETMISS details are complete and valid.
-- (USI is checked by the USI API flow and again at enrolment.)
create or replace function public.enrollment_applications_avetmiss_submit()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_missing text[]; v_vals jsonb := coalesce(new.data->'values', '{}'::jsonb); v_reason text;
begin
  if new.status in ('draft', 'action_required', 'rejected', 'withdrawn') then return new; end if;
  if tg_op = 'UPDATE' and old.status not in ('draft', 'action_required') then return new; end if;

  v_missing := avetmiss_details_invalid(v_vals);
  if new.student_id is null then
    v_missing := array_append(v_missing, 'student record');
  else
    v_missing := v_missing || array_remove(avetmiss_student_missing(new.student_id), 'USI');
  end if;
  v_reason := coalesce(avetmiss_code('study_reason', v_vals->>'study_reason'),
                       (select avetmiss_code('study_reason', s.details->>'study_reason') from enrollment_students s where s.id = new.student_id));
  if v_reason is null then v_missing := array_append(v_missing, 'main reason for undertaking this course'); end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'This application cannot be submitted yet. AVETMISS details missing or invalid: %.', array_to_string(v_missing, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists avetmiss_application_submit on public.enrollment_applications;
create trigger avetmiss_application_submit before insert or update of status on public.enrollment_applications
  for each row execute function public.enrollment_applications_avetmiss_submit();
