-- Applied on hosted 20261126125106 (avetmiss_field_errors_rpc) outside this repo; pulled from supabase_migrations.schema_migrations.statements so the lab replays what hosted has.
-- One source of truth: field key -> message, for answers that were filled in but are not valid for AVETMISS.
create or replace function public.avetmiss_field_errors(p_values jsonb)
 returns jsonb language plpgsql stable set search_path to 'public'
as $function$
declare d jsonb := coalesce(p_values, '{}'::jsonb); e jsonb := '{}'::jsonb; v text; v_dob date;
begin
  v := nullif(btrim(d->>'gender'), '');
  if v is not null and avetmiss_code('sex', v) is null then e := e || '{"gender":"Choose a gender from the list."}'; end if;
  v := nullif(btrim(d->>'atsi'), '');
  if v is not null and avetmiss_code('indigenous_status', v) is null then e := e || '{"atsi":"Choose an Aboriginal or Torres Strait Islander status from the list."}'; end if;
  v := nullif(btrim(d->>'school_level'), '');
  if v is not null and avetmiss_code('school_level', v) is null then e := e || '{"school_level":"Choose your highest school level from the list."}'; end if;
  v := nullif(btrim(d->>'employment'), '');
  if v is not null and avetmiss_code('labour_force', v) is null then e := e || '{"employment":"Choose an employment status from the list."}'; end if;
  v := nullif(btrim(d->>'disability'), '');
  if v is not null and avetmiss_code('flag', v) is null then e := e || '{"disability":"Answer Yes or No."}'; end if;
  v := nullif(btrim(d->>'prior_ed'), '');
  if v is not null and avetmiss_code('flag', v) is null then e := e || '{"prior_ed":"Answer Yes or No."}'; end if;
  v := nullif(btrim(d->>'secondary_enrolled'), '');
  if v is not null and avetmiss_code('flag', v) is null then e := e || '{"secondary_enrolled":"Answer Yes or No."}'; end if;
  v := nullif(btrim(d->>'birth_country'), '');
  if v is not null and avetmiss_code('country', v) is null then e := e || '{"birth_country":"Choose a country from the list."}'; end if;
  v := nullif(btrim(d->>'language_other'), '');
  if v is not null and avetmiss_code('language', v) is null then e := e || '{"language_other":"Choose a language from the list."}'; end if;
  v := nullif(btrim(d->>'language_home'), '');
  if v is not null and avetmiss_code('language', v) is null and lower(v) !~ '^yes' then e := e || '{"language_home":"Choose an option from the list."}'; end if;
  v := nullif(btrim(d->>'year_completed'), '');
  if v is not null and not (v = '@@@@' or (v ~ '^[0-9]{4}$' and v::int between 1920 and extract(year from current_date)::int)) then
    e := e || '{"year_completed":"Enter the 4-digit year, e.g. 2018."}'; end if;
  v := nullif(btrim(d->>'dob'), '');
  if v is not null then
    begin v_dob := v::date; exception when others then v_dob := null; end;
    if v_dob is null or v_dob > current_date or v_dob < current_date - interval '100 years' then e := e || '{"dob":"Enter a valid date of birth."}'; end if;
  end if;
  v := nullif(btrim(d->>'study_reason'), '');
  if v is not null and avetmiss_code('study_reason', v) is null then e := e || '{"study_reason":"Choose a reason from the list."}'; end if;
  if coalesce(d->>'address_type', 'Australian Address') = 'Australian Address' then
    v := nullif(btrim(d->>'au_zip'), '');
    if v is not null and v !~ '^[0-9]{4}$' then e := e || '{"au_zip":"Enter a 4-digit Australian postcode."}'; end if;
    v := nullif(btrim(d->>'au_state'), '');
    if v is not null and avetmiss_code('state', v) is null then e := e || '{"au_state":"Choose a state, e.g. VIC."}'; end if;
  end if;
  return e;
end $function$;

-- Keep the save/submit triggers on the same rules.
create or replace function public.avetmiss_details_invalid(d jsonb)
 returns text[] language sql stable set search_path to 'public'
as $function$
  select coalesce(array_agg(case k
    when 'gender' then 'gender' when 'atsi' then 'Aboriginal or Torres Strait Islander status'
    when 'school_level' then 'highest school level completed' when 'employment' then 'employment status'
    when 'disability' then 'disability (yes/no)' when 'prior_ed' then 'prior education (yes/no)'
    when 'secondary_enrolled' then 'still at secondary school' when 'birth_country' then 'country of birth'
    when 'language_home' then 'language spoken at home' when 'language_other' then 'language spoken at home'
    when 'year_completed' then 'year school completed (4 digits)' when 'dob' then 'date of birth'
    when 'study_reason' then 'study reason' when 'au_zip' then 'postcode (4 digits)' when 'au_state' then 'state'
    else k end order by k), '{}')
  from jsonb_object_keys(public.avetmiss_field_errors(d)) k;
$function$;

-- For the forms: errors for the answers on screen, plus (optionally) what is still required before submitting.
create or replace function public.avetmiss_check_answers(p_values jsonb, p_student uuid default null)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_missing text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_student is not null then
    v_missing := array_remove(avetmiss_student_missing(p_student), 'USI');
  end if;
  return jsonb_build_object('fieldErrors', avetmiss_field_errors(p_values),
                            'missingForSubmit', to_jsonb(v_missing),
                            'ok', avetmiss_field_errors(p_values) = '{}'::jsonb);
end $function$;

revoke all on function public.avetmiss_check_answers(jsonb, uuid) from public, anon;
grant execute on function public.avetmiss_check_answers(jsonb, uuid) to authenticated;
