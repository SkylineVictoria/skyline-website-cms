-- TGA-CRICOS: keep everything the government registers publish about an imported qualification.
-- Sources (read by tga-course-import): training.gov.au public API (classification, release, specialisations, unit grid,
-- content bundle, mapping, developer, occupations) and the CRICOS register on data.gov.au (the tenant's provider code
-- from cms_settings.cricos). Additive only; the existing cricos/duration/career columns are filled when empty.

alter table public.cms_courses
  add column if not exists tga_anzsco_code text,
  add column if not exists tga_anzsco_title text,
  add column if not exists tga_field_of_education_code text,
  add column if not exists tga_field_of_education text,
  add column if not exists tga_qualification_level text,
  add column if not exists tga_developer text,
  add column if not exists tga_developer_url text,
  add column if not exists tga_usage_recommendation text,
  add column if not exists tga_supersedes_code text,
  add column if not exists tga_supersedes_title text,
  add column if not exists tga_supersedes_equivalent boolean,
  add column if not exists tga_specialisation_code text,
  add column if not exists tga_specialisation_title text,
  add column if not exists tga_core_units integer,
  add column if not exists tga_elective_units integer,
  add column if not exists tga_occupations jsonb,
  add column if not exists tga_industry_sectors jsonb,
  add column if not exists tga_foundation_skills text,
  add column if not exists tga_documents jsonb,
  add column if not exists tga_companion_url text,
  add column if not exists tga_imported_at timestamptz,
  add column if not exists cricos_provider_code text,
  add column if not exists cricos_registered boolean,
  add column if not exists cricos_duration_weeks integer,
  add column if not exists cricos_tuition_fee numeric(12,2),
  add column if not exists cricos_non_tuition_fee numeric(12,2),
  add column if not exists cricos_total_cost numeric(12,2),
  add column if not exists cricos_course_level text,
  add column if not exists cricos_field_of_education text,
  add column if not exists cricos_work_component text,
  add column if not exists cricos_language text,
  add column if not exists cricos_dual_qualification boolean,
  add column if not exists cricos_locations jsonb,
  add column if not exists cricos_checked_at timestamptz;

alter table public.cms_course_units
  add column if not exists has_prerequisites boolean,
  add column if not exists elective_groups text,
  add column if not exists usage_recommendation text;

create or replace function public.rto_tga_import_save(p_actor uuid, p_tenant uuid, p_course jsonb, p_units jsonb) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_code text := p_course->>'code';
  v_id text := 'course-' || replace(gen_random_uuid()::text, '-', '');
  g jsonb := coalesce(p_course->'government', '{}'::jsonb);
  c jsonb := coalesce(p_course->'cricos', '{}'::jsonb);
  v_registered boolean := coalesce((c->>'registered')::boolean, false);
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
  lock table public.cms_courses in share row exclusive mode;
  if exists (
    select 1 from public.cms_courses
    where tenant_id is not distinct from p_tenant and upper(btrim(code)) = v_code
  ) then
    raise exception 'A course with this qualification code already exists.' using errcode = '23505';
  end if;

  insert into public.cms_courses (
    id, tenant_id, slug, code, name, category, training_package, full_description, entry_requirements, tga_url, status, is_active,
    tga_training_package_code, tga_national_status, tga_release_number, tga_release_date, tga_packaging_rules,
    cricos, duration, career,
    tga_anzsco_code, tga_anzsco_title, tga_field_of_education_code, tga_field_of_education, tga_qualification_level,
    tga_developer, tga_developer_url, tga_usage_recommendation, tga_supersedes_code, tga_supersedes_title, tga_supersedes_equivalent,
    tga_specialisation_code, tga_specialisation_title, tga_core_units, tga_elective_units, tga_occupations, tga_industry_sectors,
    tga_foundation_skills, tga_documents, tga_companion_url, tga_imported_at,
    cricos_provider_code, cricos_registered, cricos_duration_weeks, cricos_tuition_fee, cricos_non_tuition_fee, cricos_total_cost,
    cricos_course_level, cricos_field_of_education, cricos_work_component, cricos_language, cricos_dual_qualification,
    cricos_locations, cricos_checked_at
  ) values (
    v_id, p_tenant, lower(v_code), v_code, p_course->>'name', coalesce(p_course->>'aqf', ''),
    coalesce(p_course->>'packageName', ''), coalesce(p_course->>'description', ''),
    coalesce(p_course->>'entryRequirements', ''), 'https://training.gov.au/training/details/' || v_code, 'Draft', false,
    nullif(p_course->>'packageCode', ''), nullif(p_course->>'status', ''), nullif(p_course->>'releaseNumber', ''),
    nullif(p_course->>'releaseDate', '')::date, p_course->>'packagingRules',
    case when v_registered then coalesce(c->>'courseCode', '') else '' end,
    case when v_registered and (c->>'durationWeeks') is not null then (c->>'durationWeeks') || ' weeks' else '' end,
    coalesce((select string_agg(value, ', ') from jsonb_array_elements_text(coalesce(g->'occupations', '[]'::jsonb))), ''),
    nullif(g->>'anzscoCode', ''), nullif(g->>'anzscoTitle', ''), nullif(g->>'fieldOfEducationCode', ''), nullif(g->>'fieldOfEducation', ''),
    nullif(g->>'qualificationLevel', ''), nullif(g->>'developer', ''), nullif(g->>'developerUrl', ''), nullif(g->>'usageRecommendation', ''),
    nullif(g->>'supersedesCode', ''), nullif(g->>'supersedesTitle', ''), (g->>'supersedesEquivalent')::boolean,
    nullif(p_course->>'specialisationCode', ''), nullif(p_course->>'specialisationTitle', ''),
    (p_course->>'coreUnits')::integer, (p_course->>'electiveUnits')::integer,
    g->'occupations', g->'industrySectors', nullif(g->>'foundationSkills', ''), g->'documents', nullif(g->>'companionUrl', ''), now(),
    nullif(c->>'providerCode', ''), case when c ? 'registered' then v_registered end, (c->>'durationWeeks')::integer,
    (c->>'tuitionFee')::numeric, (c->>'nonTuitionFee')::numeric, (c->>'totalCost')::numeric,
    nullif(c->>'courseLevel', ''), nullif(c->>'fieldOfEducation', ''), nullif(c->>'workComponent', ''), nullif(c->>'language', ''),
    (c->>'dualQualification')::boolean, c->'locations', case when c ? 'registered' then now() end
  );

  insert into public.cms_course_units (id, tenant_id, course_id, code, name, category, unit_type, sort, nominal_hours, nominal_hours_source,
    has_prerequisites, elective_groups, usage_recommendation)
  select 'unit-' || replace(gen_random_uuid()::text, '-', ''), p_tenant, v_id,
    unit->>'code', unit->>'name', case unit->>'type' when 'core' then 'Core' else 'Elective' end,
    unit->>'type', position::integer, nullif(unit->>'nominalHours', '')::integer, unit->>'hoursSource',
    (unit->>'hasPrerequisites')::boolean, nullif(unit->>'groups', ''), nullif(unit->>'usageRecommendation', '')
  from jsonb_array_elements(p_units) with ordinality as payload(unit, position);

  return v_id;
end;
$$;
revoke all on function public.rto_tga_import_save(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.rto_tga_import_save(uuid, uuid, jsonb, jsonb) to service_role;
