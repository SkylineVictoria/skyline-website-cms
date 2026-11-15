-- TGA-HOURS: NCVER nationally agreed nominal hours kept in the database.
-- The Edge runtime cannot reliably download the NCVER file (1.1 MB, slow host), so tga-course-import reads hours
-- from this table. Refresh (service role / SQL editor), NCVER republishes about once a year:
--   select net.http_get('https://www.ncver.edu.au/sites/default/files/ncver-documents/Nationally-agreed-hours.txt',
--                       timeout_milliseconds => 60000);            -- returns a request id
--   select public.tga_nominal_hours_load(<request id>);           -- once net._http_response has the row
-- Unknown and ambiguous unit codes stay absent; hours are never manufactured.

create table if not exists public.tga_nominal_hours (
  unit_code text primary key check (unit_code ~ '^[A-Z][A-Z0-9]{4,19}$'),
  hours integer not null check (hours between 0 and 5000),
  loaded_at timestamptz not null default now()
);
alter table public.tga_nominal_hours enable row level security;
revoke all on table public.tga_nominal_hours from public, anon, authenticated;
grant select, insert, update, delete on table public.tga_nominal_hours to service_role;

create or replace function public.tga_nominal_hours_parse(p_content text) returns integer
language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  if p_content is null or left(regexp_replace(p_content, '^\uFEFF', ''), 10) <> 'Subject Id' then
    raise exception 'Not the NCVER nationally agreed hours file.' using errcode = '22023';
  end if;
  create temporary table if not exists pg_temp.ncver_hours (unit_code text, hours integer) on commit drop;
  truncate pg_temp.ncver_hours;
  insert into pg_temp.ncver_hours
  select split_part(line, E'\t', 1), split_part(line, E'\t', 3)::integer
  from regexp_split_to_table(p_content, E'\r?\n') with ordinality as l(line, n)
  where n > 1 and split_part(line, E'\t', 1) ~ '^[A-Z][A-Z0-9]{4,19}$' and split_part(line, E'\t', 2) ~ '^[A-Z]$'
    and split_part(line, E'\t', 3) ~ '^[0-9]{1,4}$' and split_part(line, E'\t', 3)::integer <= 5000;
  select count(*) into v_count from pg_temp.ncver_hours;
  if v_count < 1000 then raise exception 'The NCVER hours file has only % usable rows.', v_count using errcode = '22023'; end if;

  delete from public.tga_nominal_hours;
  -- A code listed with different hours is ambiguous and left out.
  insert into public.tga_nominal_hours (unit_code, hours)
  select unit_code, min(hours) from pg_temp.ncver_hours group by unit_code having count(distinct hours) = 1;
  get diagnostics v_count = row_count;

  -- Fill hours on already imported units that have none; manual hours are never replaced.
  update public.cms_course_units u
     set nominal_hours = h.hours, nominal_hours_source = 'NCVER nationally agreed nominal hours (2026)'
    from public.tga_nominal_hours h, public.cms_courses c
   where h.unit_code = upper(btrim(u.code)) and c.id = u.course_id and c.tga_release_number is not null
     and u.nominal_hours is null;
  return v_count;
end;
$$;

create or replace function public.tga_nominal_hours_load(p_request_id bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select status_code, content into r from net._http_response where id = p_request_id;
  if not found then raise exception 'No response yet for request %.', p_request_id using errcode = 'P0002'; end if;
  if r.status_code is distinct from 200 then raise exception 'NCVER returned HTTP %.', r.status_code using errcode = '22023'; end if;
  return public.tga_nominal_hours_parse(r.content);
end;
$$;

revoke all on function public.tga_nominal_hours_parse(text) from public, anon, authenticated;
revoke all on function public.tga_nominal_hours_load(bigint) from public, anon, authenticated;
grant execute on function public.tga_nominal_hours_parse(text) to service_role;
grant execute on function public.tga_nominal_hours_load(bigint) to service_role;
