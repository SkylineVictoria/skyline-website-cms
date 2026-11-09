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

  select sum(kv.cnt::int) into v_total
    from net._http_response h,
         jsonb_array_elements(h.content::jsonb -> 'facets') as f(facet),
         jsonb_each_text(f.facet -> 'counts') as kv(type_id, cnt)
   where h.id = r.request_ids[1] and f.facet ->> 'propertyName' = 'Type/Id';

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
end $$;;
