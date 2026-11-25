-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
create or replace function public.unit_foe_fill_dispatch(p_unit_ids text[] default null)
returns bigint language plpgsql security definer
set search_path to 'public', 'vault', 'net', 'pg_temp' as $$
declare v_key text; v_url text;
begin
  if not exists (select 1 from public.cms_course_units where field_of_education_code is null
                   and (p_unit_ids is null or id = any(p_unit_ids))) then
    return null;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
  select regexp_replace(decrypted_secret, '^(https?://[^/]+)/.*$', '\1') || '/functions/v1/unit-foe-fill'
    into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
  if nullif(v_key, '') is null or v_url !~ '^https://[^/]+/functions/v1/unit-foe-fill$' then return null; end if;
  return public.cron_http_post('unit-foe-fill', url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := case when p_unit_ids is null then '{}'::jsonb else jsonb_build_object('unitIds', to_jsonb(p_unit_ids)) end,
    timeout_milliseconds := 55000);
end $$;
revoke all on function public.unit_foe_fill_dispatch(text[]) from public, anon, authenticated;

-- New units (TGA import, Add units, typed by hand): one request per save
create or replace function public.cms_course_units_foe_queue()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_ids text[];
begin
  select array_agg(id) into v_ids from new_rows where field_of_education_code is null;
  if v_ids is not null then
    begin
      perform public.unit_foe_fill_dispatch(v_ids);
    exception when others then null; -- never block saving units; the hourly sweep retries
    end;
  end if;
  return null;
end $$;
revoke all on function public.cms_course_units_foe_queue() from public, anon, authenticated;

create trigger cms_course_units_foe_after_insert
  after insert on public.cms_course_units
  referencing new table as new_rows
  for each statement execute function public.cms_course_units_foe_queue();

-- A unit's code changed: clear the old code's value and fetch the new one
create or replace function public.cms_course_units_foe_code_change()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_when = 'BEFORE' then
    if new.field_of_education_code is not distinct from old.field_of_education_code then
      new.field_of_education_code := null;
    end if;
    return new;
  end if;
  if new.field_of_education_code is null then
    begin
      perform public.unit_foe_fill_dispatch(array[new.id]);
    exception when others then null;
    end;
  end if;
  return null;
end $$;
revoke all on function public.cms_course_units_foe_code_change() from public, anon, authenticated;

create trigger cms_course_units_foe_code_change_before
  before update of code on public.cms_course_units
  for each row when (new.code is distinct from old.code)
  execute function public.cms_course_units_foe_code_change();
create trigger cms_course_units_foe_code_change_after
  after update of code on public.cms_course_units
  for each row when (new.code is distinct from old.code)
  execute function public.cms_course_units_foe_code_change();

-- Safety net: retry anything still missing every hour (no request when nothing is missing)
select cron.schedule('unit-foe-fill', '35 * * * *', $$select public.unit_foe_fill_dispatch();$$);
