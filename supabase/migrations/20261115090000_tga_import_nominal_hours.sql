alter table public.cms_course_units add column if not exists nominal_hours_source text;
create or replace function public.rto_tga_import_save(p_actor uuid, p_tenant uuid, p_course jsonb, p_units jsonb) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_code text := p_course->>'code';
  v_id text := 'course-' || replace(gen_random_uuid()::text, '-', '');
begin
  if not exists (
    select 1 from public.cms_users
    where auth_user_id = p_actor and status = 'Active' and not must_change_password and rto_manager
  ) then
    raise exception 'RTO Manager access is required.' using errcode = '42501';
  end if;

  if v_code is null or v_code !~ '^[A-Z][A-Z0-9]{4,19}$' or nullif(btrim(p_course->>'name'), '') is null
     or jsonb_typeof(p_units) is distinct from 'array' then
    raise exception 'Invalid qualification or units.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_units) = 0 or exists (
    select 1 from jsonb_array_elements(p_units) as payload(unit)
    where coalesce(unit->>'code', '') !~ '^[A-Z][A-Z0-9]{4,19}$'
       or nullif(btrim(unit->>'name'), '') is null
       or coalesce(unit->>'type', '') not in ('core', 'elective')
  ) then
    raise exception 'The import requires valid unit codes, titles and types.' using errcode = '22023';
  end if;

  -- Serialize the duplicate check with concurrent CMS inserts and edits.
  -- Other course workflows can still maintain existing variants.
  lock table public.cms_courses in share row exclusive mode;
  if exists (
    select 1 from public.cms_courses
    where tenant_id is not distinct from p_tenant and upper(btrim(code)) = v_code
  ) then
    raise exception 'A course with this qualification code already exists.' using errcode = '23505';
  end if;

  insert into public.cms_courses (
    id, tenant_id, slug, code, name, category, training_package, full_description, entry_requirements, tga_url, status, is_active,
    tga_training_package_code, tga_national_status, tga_release_number, tga_release_date, tga_packaging_rules
  ) values (
    v_id, p_tenant, lower(v_code), v_code, p_course->>'name', coalesce(p_course->>'aqf', ''),
    coalesce(p_course->>'packageName', ''), coalesce(p_course->>'description', ''),
    coalesce(p_course->>'entryRequirements', ''), 'https://training.gov.au/training/details/' || v_code, 'Draft', false,
    nullif(p_course->>'packageCode', ''), nullif(p_course->>'status', ''), nullif(p_course->>'releaseNumber', ''),
    nullif(p_course->>'releaseDate', '')::date, p_course->>'packagingRules'
  );

  insert into public.cms_course_units (id, tenant_id, course_id, code, name, category, unit_type, sort, nominal_hours, nominal_hours_source)
  select 'unit-' || replace(gen_random_uuid()::text, '-', ''), p_tenant, v_id,
    unit->>'code', unit->>'name', case unit->>'type' when 'core' then 'Core' else 'Elective' end,
    unit->>'type', position::integer, nullif(unit->>'nominalHours', '')::integer, unit->>'hoursSource'
  from jsonb_array_elements(p_units) with ordinality as payload(unit, position);

  return v_id;
end;
$$;
revoke all on function public.rto_tga_import_save(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.rto_tga_import_save(uuid, uuid, jsonb, jsonb) to service_role;
