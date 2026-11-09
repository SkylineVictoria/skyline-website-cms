-- Australian course catalogue: national sync from training.gov.au, autocomplete search,
-- and Skyline activation. Additive; national fields and Skyline fields stay separate.

alter table public.australian_course_catalogue
  add column if not exists nrt_id text,
  add column if not exists qualification_level_code text,
  add column if not exists release_date date,
  add column if not exists currency_start_date date,
  add column if not exists currency_end_date date,
  add column if not exists usage_recommendation text,
  add column if not exists recognition_manager_code text,
  add column if not exists recognition_manager_name text,
  add column if not exists anzsco_code text,
  add column if not exists anzsco_name text,
  add column if not exists field_of_education_code text,
  add column if not exists field_of_education_name text;

alter table public.australian_course_catalogue
  add column if not exists website_enabled boolean not null default false,
  add column if not exists admissions_enabled boolean not null default false,
  add column if not exists domestic_enabled boolean not null default false,
  add column if not exists international_enabled boolean not null default false,
  add column if not exists cms_course_id text references public.cms_courses(id) on delete set null,
  add column if not exists skyline_updated_at timestamptz,
  add column if not exists skyline_updated_by uuid;

comment on column public.australian_course_catalogue.is_active is 'Skyline activation. Never written by the national sync.';
comment on column public.australian_course_catalogue.cms_course_id is 'Skyline cms_courses record managing this national course (Skyline-controlled).';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'australian_course_catalogue_national_status_check') then
    alter table public.australian_course_catalogue
      add constraint australian_course_catalogue_national_status_check
      check (national_status in ('CURRENT','SUPERSEDED','DELETED','CANCELLED','NON_CURRENT'));
  end if;
end $$;

drop index if exists public.australian_course_catalogue_code_idx;
create index if not exists australian_course_catalogue_code_trgm_idx
  on public.australian_course_catalogue using gin (lower(course_code) extensions.gin_trgm_ops);
create index if not exists australian_course_catalogue_name_trgm_idx
  on public.australian_course_catalogue using gin (lower(course_name) extensions.gin_trgm_ops);
create index if not exists australian_course_catalogue_name_lower_idx
  on public.australian_course_catalogue (lower(course_name) text_pattern_ops);
create index if not exists australian_course_catalogue_code_lower_idx
  on public.australian_course_catalogue (lower(course_code) text_pattern_ops);
create index if not exists australian_course_catalogue_aqf_idx
  on public.australian_course_catalogue (aqf_level);
create index if not exists australian_course_catalogue_package_idx
  on public.australian_course_catalogue (training_package_code) where training_package_code is not null;
create index if not exists australian_course_catalogue_cms_course_idx
  on public.australian_course_catalogue (cms_course_id) where cms_course_id is not null;

revoke all on public.australian_course_catalogue from anon;
revoke insert, update, delete, truncate, references, trigger on public.australian_course_catalogue from authenticated;
grant select on public.australian_course_catalogue to authenticated;

create table if not exists public.australian_course_catalogue_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'requested' check (status in ('requested','completed','failed')),
  source text not null default 'training.gov.au /api/search/training',
  filter text not null,
  page_size integer not null,
  request_ids bigint[] not null default '{}',
  source_total integer,
  received integer,
  inserted integer,
  updated integer,
  not_in_source integer,
  error text
);
alter table public.australian_course_catalogue_sync_runs enable row level security;
revoke all on public.australian_course_catalogue_sync_runs from anon, authenticated;

create or replace function public.australian_course_catalogue_sync_start(p_pages integer default 4)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filter constant text := '(Status/Id eq 0) and (Type/Id eq 1 or Type/Id eq 2)';
  v_size constant integer := 1000;
  v_ids bigint[] := '{}';
  v_run bigint;
  i integer;
begin
  if p_pages < 1 or p_pages > 10 then raise exception 'p_pages must be 1..10'; end if;
  for i in 0 .. p_pages - 1 loop
    v_ids := v_ids || net.http_get(
      url := 'https://training.gov.au/api/search/training',
      params := jsonb_build_object('searchText', '', 'orderBy', 'Code', 'offset', (i * v_size)::text,
                                   'pageSize', v_size::text, 'filter', v_filter),
      timeout_milliseconds := 120000);
  end loop;
  insert into public.australian_course_catalogue_sync_runs(filter, page_size, request_ids)
  values (v_filter, v_size, v_ids) returning id into v_run;
  return v_run;
end $$;

create or replace function public.australian_course_catalogue_sync_apply(p_run bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.australian_course_catalogue_sync_runs;
  v_pending integer; v_bad text; v_total integer; v_received integer;
  v_inserted integer; v_updated integer; v_stale integer; v_last_page integer;
  v_now timestamptz := now();
begin
  select * into r from public.australian_course_catalogue_sync_runs where id = p_run for update;
  if not found then raise exception 'Sync run % not found', p_run; end if;
  if r.status <> 'requested' then raise exception 'Sync run % is already %', p_run, r.status; end if;

  select count(*) into v_pending from unnest(r.request_ids) rid
   where not exists (select 1 from net._http_response h where h.id = rid);
  if v_pending > 0 then raise exception 'Sync run %: % page(s) not received yet; retry shortly', p_run, v_pending; end if;

  select string_agg(h.id || ':' || coalesce(h.status_code::text, 'none') || coalesce(' ' || h.error_msg, ''), ', ')
    into v_bad from net._http_response h where h.id = any(r.request_ids) and (h.status_code is distinct from 200);
  if v_bad is not null then
    update public.australian_course_catalogue_sync_runs set status='failed', finished_at=now(), error='HTTP '||v_bad where id=p_run;
    return jsonb_build_object('run', p_run, 'status', 'failed', 'error', 'HTTP ' || v_bad);
  end if;

  select sum(value::int) into v_total
    from net._http_response h,
         jsonb_array_elements(h.content::jsonb -> 'facets') f,
         jsonb_each_text(f -> 'counts')
   where h.id = r.request_ids[1] and f ->> 'propertyName' = 'Type/Id';

  select jsonb_array_length(h.content::jsonb -> 'data') into v_last_page
    from net._http_response h where h.id = r.request_ids[array_length(r.request_ids, 1)];
  if v_last_page >= r.page_size then
    update public.australian_course_catalogue_sync_runs set status='failed', finished_at=now(),
      error='More source pages exist than were requested; rerun with more pages' where id=p_run;
    return jsonb_build_object('run', p_run, 'status', 'failed', 'error', 'more pages needed');
  end if;

  create temporary table tga_src on commit drop as
  select distinct on (d ->> 'code')
    d ->> 'code' as course_code,
    d ->> 'title' as course_name,
    case d -> 'type' ->> 'id' when 'qualification' then 'QUALIFICATION' when 'accreditedCourse' then 'ACCREDITED_COURSE' end as course_type,
    nullif(d -> 'qualificationLevel' ->> 'name', '') as aqf_level,
    nullif(d -> 'qualificationLevel' ->> 'code', '') as qualification_level_code,
    nullif(d -> 'trainingPackage' ->> 'code', '') as training_package_code,
    nullif(d -> 'trainingPackage' ->> 'title', '') as training_package_name,
    upper(d -> 'status' ->> 'id') as national_status,
    nullif(d -> 'latestRelease' ->> 'number', '') as release_number,
    nullif(d -> 'latestRelease' ->> 'date', '')::date as release_date,
    nullif(d -> 'currencyPeriod' ->> 'startDate', '')::date as currency_start_date,
    nullif(d -> 'currencyPeriod' ->> 'endDate', '')::date as currency_end_date,
    nullif(d -> 'usageRecommendation' ->> 'name', '') as usage_recommendation,
    nullif((select string_agg(s ->> 'code', ', ' order by s ->> 'code') from jsonb_array_elements(coalesce(d -> 'supersedes', '[]')) s), '') as supersedes_code,
    nullif((select string_agg(s ->> 'code', ', ' order by s ->> 'code') from jsonb_array_elements(coalesce(d -> 'supersededBy', '[]')) s), '') as superseded_by_code,
    nullif(d ->> 'nrtId', '') as nrt_id,
    nullif(d -> 'recognitionManager' ->> 'code', '') as recognition_manager_code,
    nullif(d -> 'recognitionManager' ->> 'name', '') as recognition_manager_name,
    nullif(d -> 'anzsco' ->> 'code', '') as anzsco_code,
    nullif(d -> 'anzsco' ->> 'name', '') as anzsco_name,
    nullif(d -> 'asced4' ->> 'code', '') as field_of_education_code,
    nullif(d -> 'asced4' ->> 'name', '') as field_of_education_name
  from net._http_response h, jsonb_array_elements(h.content::jsonb -> 'data') d
  where h.id = any(r.request_ids)
    and d -> 'type' ->> 'id' in ('qualification', 'accreditedCourse')
    and d -> 'status' ->> 'id' = 'current'
    and coalesce(trim(d ->> 'code'), '') <> '' and coalesce(trim(d ->> 'title'), '') <> ''
  order by d ->> 'code', nullif(d -> 'latestRelease' ->> 'date', '')::date desc nulls last;

  select count(*) into v_received from tga_src;
  if v_total is null or v_received <> v_total then
    update public.australian_course_catalogue_sync_runs set status='failed', finished_at=now(),
      source_total=v_total, received=v_received, error='Received count does not match source total' where id=p_run;
    return jsonb_build_object('run', p_run, 'status', 'failed', 'source_total', v_total, 'received', v_received);
  end if;

  select count(*) into v_inserted from tga_src s
   where not exists (select 1 from public.australian_course_catalogue c where c.course_code = s.course_code);

  insert into public.australian_course_catalogue as c (
    course_code, course_name, course_type, aqf_level, qualification_level_code, training_package_code,
    training_package_name, national_status, release_number, release_date, currency_start_date, currency_end_date,
    usage_recommendation, supersedes_code, superseded_by_code, nrt_id, recognition_manager_code,
    recognition_manager_name, anzsco_code, anzsco_name, field_of_education_code, field_of_education_name,
    source, source_url, source_updated_at, last_synced_at)
  select course_code, course_name, course_type, aqf_level, qualification_level_code, training_package_code,
    training_package_name, national_status, release_number, release_date, currency_start_date, currency_end_date,
    usage_recommendation, supersedes_code, superseded_by_code, nrt_id, recognition_manager_code,
    recognition_manager_name, anzsco_code, anzsco_name, field_of_education_code, field_of_education_name,
    'training.gov.au', 'https://training.gov.au/training/details/' || course_code, release_date::timestamptz, v_now
  from tga_src
  on conflict (course_code) do update set
    course_name = excluded.course_name, course_type = excluded.course_type, aqf_level = excluded.aqf_level,
    qualification_level_code = excluded.qualification_level_code, training_package_code = excluded.training_package_code,
    training_package_name = excluded.training_package_name, national_status = excluded.national_status,
    release_number = excluded.release_number, release_date = excluded.release_date,
    currency_start_date = excluded.currency_start_date, currency_end_date = excluded.currency_end_date,
    usage_recommendation = excluded.usage_recommendation, supersedes_code = excluded.supersedes_code,
    superseded_by_code = excluded.superseded_by_code, nrt_id = excluded.nrt_id,
    recognition_manager_code = excluded.recognition_manager_code, recognition_manager_name = excluded.recognition_manager_name,
    anzsco_code = excluded.anzsco_code, anzsco_name = excluded.anzsco_name,
    field_of_education_code = excluded.field_of_education_code, field_of_education_name = excluded.field_of_education_name,
    source = excluded.source, source_url = excluded.source_url, source_updated_at = excluded.source_updated_at,
    last_synced_at = excluded.last_synced_at, updated_at = now();

  v_updated := v_received - v_inserted;
  select count(*) into v_stale from public.australian_course_catalogue where last_synced_at < v_now;

  update public.australian_course_catalogue_sync_runs set status='completed', finished_at=now(),
    source_total=v_total, received=v_received, inserted=v_inserted, updated=v_updated, not_in_source=v_stale
  where id = p_run;

  return jsonb_build_object('run', p_run, 'status', 'completed', 'source_total', v_total, 'received', v_received,
    'inserted', v_inserted, 'updated', v_updated, 'not_in_source', v_stale);
end $$;

revoke all on function public.australian_course_catalogue_sync_start(integer) from public, anon, authenticated;
revoke all on function public.australian_course_catalogue_sync_apply(bigint) from public, anon, authenticated;
grant execute on function public.australian_course_catalogue_sync_start(integer) to service_role;
grant execute on function public.australian_course_catalogue_sync_apply(bigint) to service_role;

create or replace function public.search_australian_course_catalogue(
  p_query text default '',
  p_course_type text default null,
  p_aqf_level text default null,
  p_national_status text default null,
  p_skyline text default null,
  p_limit integer default 20,
  p_offset integer default 0)
returns table (
  course_code text, course_name text, course_type text, aqf_level text,
  training_package_code text, training_package_name text, national_status text, release_number text,
  is_active boolean, website_enabled boolean, admissions_enabled boolean, domestic_enabled boolean,
  international_enabled boolean, cms_course_id text, match_rank integer, total_count bigint)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with q as (
    select lower(btrim(coalesce(p_query, ''))) as raw,
           replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') as esc
  ), w as (
    select coalesce(array_agg(x) filter (where x <> ''), '{}') as words
    from q, regexp_split_to_table(q.esc, '\s+') x
  ), m as (
    select c.*,
      case
        when q.raw = '' then 9
        when lower(c.course_code) = q.raw then 0
        when lower(c.course_code) like q.esc || '%' then 1
        when lower(c.course_name) like q.esc || '%' then 2
        when lower(c.course_name) like '%' || q.esc || '%' then 3
        else 4
      end as match_rank
    from public.australian_course_catalogue c, q, w
    where (q.raw = '' or not exists (
            select 1 from unnest(w.words) word
            where not (lower(c.course_name) like '%' || word || '%' or lower(c.course_code) like word || '%')))
      and (p_course_type is null or p_course_type = '' or c.course_type = p_course_type)
      and (p_aqf_level is null or p_aqf_level = '' or c.aqf_level = p_aqf_level)
      and (p_national_status is null or p_national_status = '' or c.national_status = p_national_status)
      and (p_skyline is null or p_skyline = '' or (p_skyline = 'active' and c.is_active) or (p_skyline = 'inactive' and not c.is_active))
  )
  select m.course_code, m.course_name, m.course_type, m.aqf_level, m.training_package_code, m.training_package_name,
         m.national_status, m.release_number, m.is_active, m.website_enabled, m.admissions_enabled,
         m.domestic_enabled, m.international_enabled, m.cms_course_id, m.match_rank, count(*) over ()
  from m, q
  order by m.match_rank, extensions.similarity(lower(m.course_name), q.raw) desc, m.course_code
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_australian_course_catalogue(text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.search_australian_course_catalogue(text, text, text, text, text, integer, integer) to authenticated;

create or replace function public.australian_course_catalogue_aqf_levels()
returns setof text
language sql stable security invoker set search_path = public
as $$ select distinct aqf_level from public.australian_course_catalogue where aqf_level is not null order by 1 $$;
revoke all on function public.australian_course_catalogue_aqf_levels() from public, anon;
grant execute on function public.australian_course_catalogue_aqf_levels() to authenticated;

create or replace function public.activate_australian_course(
  p_course_code text,
  p_active boolean default true,
  p_website boolean default false,
  p_applications boolean default false,
  p_domestic boolean default false,
  p_international boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cat public.australian_course_catalogue;
  v_course text; v_created boolean := false; v_slug text; v_base text; v_n integer := 1;
begin
  if not (public.cms_is_staff() and public.tenant_scope_write(null)) then
    raise exception 'Not authorised to manage Skyline courses' using errcode = '42501';
  end if;

  select * into cat from public.australian_course_catalogue where course_code = upper(btrim(p_course_code)) for update;
  if not found then raise exception 'Course % is not in the Australian catalogue', p_course_code using errcode = 'P0002'; end if;
  if p_active and cat.national_status <> 'CURRENT' then
    raise exception 'Only CURRENT national courses can be activated (% is %)', cat.course_code, cat.national_status using errcode = '22023';
  end if;

  select id into v_course from public.cms_courses where id = cat.cms_course_id;
  if v_course is null then
    select id into v_course from public.cms_courses
     where tenant_id is null and upper(code) = cat.course_code
     order by display_order, id limit 1;
  end if;

  if v_course is null and p_active then
    v_base := btrim(regexp_replace(lower(cat.course_code || '-' || cat.course_name), '[^a-z0-9]+', '-', 'g'), '-');
    v_slug := v_base;
    while exists (select 1 from public.cms_courses where tenant_id is null and slug = v_slug) loop
      v_n := v_n + 1; v_slug := v_base || '-' || v_n;
    end loop;
    v_course := 'course-' || (floor(extract(epoch from clock_timestamp()) * 1000))::bigint;
    insert into public.cms_courses (id, slug, code, name, training_package, status, display_order, featured, updated_at, updated_by)
    values (v_course, v_slug, cat.course_code, cat.course_code || ' ' || cat.course_name,
            coalesce(cat.training_package_name, ''), 'Draft',
            coalesce((select max(display_order) + 1 from public.cms_courses where tenant_id is null), 0),
            false, now(), auth.uid()::text);
    v_created := true;
  end if;

  update public.australian_course_catalogue set
    is_active = p_active, website_enabled = p_website, admissions_enabled = p_applications,
    domestic_enabled = p_domestic, international_enabled = p_international,
    cms_course_id = coalesce(v_course, cms_course_id), skyline_updated_at = now(), skyline_updated_by = auth.uid()
  where id = cat.id;

  return jsonb_build_object('course_code', cat.course_code, 'cms_course_id', v_course, 'created', v_created, 'is_active', p_active);
end $$;

revoke all on function public.activate_australian_course(text, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.activate_australian_course(text, boolean, boolean, boolean, boolean, boolean) to authenticated;

update public.australian_course_catalogue a
   set cms_course_id = c.id
  from (select distinct on (upper(code)) id, upper(code) as code
          from public.cms_courses where tenant_id is null and code <> '' order by upper(code), display_order, id) c
 where a.course_code = c.code and a.cms_course_id is null;;
