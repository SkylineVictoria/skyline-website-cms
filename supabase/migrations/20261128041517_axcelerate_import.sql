-- AXCELERATE-IMPORT stage 1 (owner, 2026-11-28): the aXcelerate import engine, first entities trainers, classes and breaks.
-- Owner decisions 2026-11-28: one way only (aXcelerate -> Skyline, nothing ever goes back); imported data belongs to Skyline
-- (admins edit / delete it like any record; later imports never overwrite an admin's edit); a reference that does not exist yet in
-- Skyline is created (course, unit, location, trainer) so imports never fail on a missing link; every imported Qualification will get
-- an application (later stage); the "aXcelerate import" permission lives in its own table; classes match aXcelerate's classes.
--
-- What this adds (additive: new tables and functions; no existing table changes shape):
--   * public.cms_permissions (user, permission): 'axcelerate.import', SLIT admins only (seeded with the active Admins),
--     cms_has_permission(), cms_permission_set() / cms_permission_list().
--   * public.axcelerate_links: aXcelerate id <-> Skyline record (entity, target table + id, raw aXcelerate record, imported at,
--     last run, edited_in_skyline_at). public.axcelerate_skipped: records an admin deleted (later imports leave them out; undo).
--     public.axcelerate_import_runs / _errors / _conflicts.
--   * Triggers on the tables imports write (hr.staff_profiles, cms_courses, cms_course_units, course_intakes, intake_units, locations,
--     academic_breaks): an edit outside an import stamps edited_in_skyline_at; a delete moves the link to the skipped list.
--   * Import functions (service role only, called by the Edge Function axcelerate-import with data it read through axcelerateClient):
--     axcelerate_import_location / _course / _unit / _trainer / _class / _break. Each: skipped -> nothing; linked and edited in Skyline
--     -> a conflict row per differing field (Skyline kept); linked -> updated; not linked -> matched by its natural key (location name,
--     course code, unit code in the course, staff email, break dates) and linked without overwriting Skyline's values; else created.
--   * Audit: every connection change, run start / cancel / retry, skip undo, conflict decision and permission change is a row in the
--     append-only public.portal_audit_log (target_type 'axcelerate', who, when, IP from the request headers, scope).
--     axcelerate_security_event() records a blocked call (wrong method, path not allowed, custom request, missing permission) and
--     emails every active SLIT Admin (notification queue, event ops_axcelerate_security).
--   * integration_axcelerate_save stores who saved the tokens and when; integration_axcelerate_summary returns that, and no part of a token.
-- Rollback (manual): drop the triggers axcelerate_link_touch_*, the functions and tables named above; re-create integration_axcelerate_save /
-- _summary from 20261128030517.
begin;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Permission
create table if not exists public.cms_permissions (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('axcelerate.import')),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);
alter table public.cms_permissions enable row level security;
revoke all on public.cms_permissions from public, anon, authenticated;
grant select on public.cms_permissions to authenticated;
create policy cms_permissions_admin_read on public.cms_permissions for select to authenticated using (public.cms_is_admin());

/** True when the signed-in user is an active SLIT Admin holding the permission. */
create or replace function public.cms_has_permission(p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_admin(), false)
     and exists (select 1 from public.cms_permissions p where p.user_id = auth.uid() and p.permission = p_permission);
$$;

-- SLIT admins hold it from the start (owner: "given to SLIT admins only").
insert into public.cms_permissions(user_id, permission)
select u.auth_user_id, 'axcelerate.import' from public.cms_users u
 where u.auth_user_id is not null and u.role = 'Admin' and u.status = 'Active'
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Audit (append-only portal_audit_log) and security events
create or replace function public.axcelerate_request_ip() returns text
language sql stable set search_path = public as $$
  select nullif(btrim(split_part(coalesce((nullif(current_setting('request.headers', true), '')::json)->>'x-forwarded-for', ''), ',', 1)), '');
$$;

create or replace function public.axcelerate_audit(p_connection uuid, p_actor uuid, p_action text, p_detail jsonb, p_ip text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_tenant uuid;
begin
  select coalesce(u.name, u.email) into v_name from public.cms_users u where u.auth_user_id = p_actor limit 1;
  select c.tenant_id into v_tenant from public.integration_connections c where c.id = p_connection;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, detail, tenant_id)
  values (p_actor, coalesce(v_name, case when p_actor is null then 'System' else 'Unknown user' end), case when p_actor is null then 'system' else 'admin' end,
          left(p_action, 80), 'axcelerate', coalesce(p_connection::text, ''),
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('ip', coalesce(p_ip, public.axcelerate_request_ip())), v_tenant);
end $$;

/** A refused aXcelerate call: audit row + an email to every active SLIT Admin. Service role only. */
create or replace function public.axcelerate_security_event(p_connection uuid, p_user uuid, p_method text, p_path text, p_reason text, p_ip text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_who text;
begin
  perform public.axcelerate_audit(p_connection, p_user, 'axcelerate_blocked_call',
    jsonb_build_object('method', left(coalesce(p_method, ''), 10), 'path', left(coalesce(p_path, ''), 200), 'reason', left(coalesce(p_reason, ''), 40)), p_ip);
  select coalesce(u.name, u.email) into v_who from public.cms_users u where u.auth_user_id = p_user limit 1;
  for r in select distinct lower(u.email) as email from public.cms_users u where u.role = 'Admin' and u.status = 'Active' and coalesce(u.email, '') <> '' loop
    insert into public.notification_deliveries(recipient_email, event, template_source, subject, body)
    values (r.email, 'ops_axcelerate_security', 'default', 'Skyline blocked an aXcelerate request',
      'Skyline refused a request to aXcelerate and recorded it.' || E'\n\n'
      || 'Who: ' || coalesce(v_who, 'unknown user') || E'\n'
      || 'When: ' || to_char(now() at time zone public.institution_tz(), 'DD Mon YYYY HH24:MI') || E'\n'
      || 'Request: ' || left(coalesce(p_method, ''), 10) || ' ' || left(coalesce(p_path, ''), 200) || E'\n'
      || 'Why: ' || case p_reason when 'method_not_allowed' then 'only reading (GET) is allowed'
                                  when 'path_not_allowed' then 'the address is not on the read-only list'
                                  when 'custom_request' then 'custom requests are not allowed'
                                  when 'no_permission' then 'the user does not hold the aXcelerate import permission'
                                  else coalesce(p_reason, 'refused') end || E'\n'
      || 'IP: ' || coalesce(p_ip, public.axcelerate_request_ip(), 'unknown') || E'\n\n'
      || 'Nothing was sent to aXcelerate. The record is in the aXcelerate Import centre > Audit.');
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Links, skipped list, runs, errors, conflicts
create table if not exists public.axcelerate_links (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  entity text not null check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break')),
  axcelerate_id text not null check (char_length(axcelerate_id) between 1 and 120),
  target_table text not null,
  target_id text not null,
  raw jsonb not null default '{}'::jsonb,
  first_imported_at timestamptz not null default now(),
  last_imported_at timestamptz not null default now(),
  last_run_id uuid,
  edited_in_skyline_at timestamptz,
  unique (connection_id, entity, axcelerate_id)
);
create index if not exists axcelerate_links_target on public.axcelerate_links(target_table, target_id);

create table if not exists public.axcelerate_skipped (
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  entity text not null,
  axcelerate_id text not null,
  label text,
  reason text not null default 'deleted_in_skyline',
  skipped_by uuid,
  skipped_at timestamptz not null default now(),
  primary key (connection_id, entity, axcelerate_id)
);

create table if not exists public.axcelerate_import_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  mode text not null check (mode in ('page', 'everything', 'nightly')),
  entities text[] not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'cancelled')),
  cursor jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  cancel_requested boolean not null default false,
  retry_of uuid references public.axcelerate_import_runs(id),
  started_by uuid,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text
);
create index if not exists axcelerate_import_runs_connection on public.axcelerate_import_runs(connection_id, started_at desc);
create unique index if not exists axcelerate_import_runs_one_running on public.axcelerate_import_runs(connection_id) where status = 'running';

create table if not exists public.axcelerate_import_errors (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.axcelerate_import_runs(id) on delete cascade,
  entity text not null,
  axcelerate_id text,
  label text,
  message text not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists axcelerate_import_errors_run on public.axcelerate_import_errors(run_id);

create table if not exists public.axcelerate_conflicts (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.axcelerate_links(id) on delete cascade,
  run_id uuid references public.axcelerate_import_runs(id) on delete set null,
  field text not null,
  skyline_value jsonb,
  axcelerate_value jsonb,
  status text not null default 'open' check (status in ('open', 'keep_skyline', 'take_axcelerate')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists axcelerate_conflicts_one_open on public.axcelerate_conflicts(link_id, field) where status = 'open';

do $$ declare t text; begin
  foreach t in array array['axcelerate_links', 'axcelerate_skipped', 'axcelerate_import_runs', 'axcelerate_import_errors', 'axcelerate_conflicts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.cms_has_permission(''axcelerate.import''))', t || '_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Edits and deletes in Skyline
create or replace function public.axcelerate_link_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_table text := tg_table_schema || '.' || tg_table_name; v_id text := to_jsonb(old)->>'id';
begin
  if coalesce(current_setting('axcelerate.importing', true), '') = 'on' or v_id is null then return null; end if;
  if tg_op = 'UPDATE' then
    update public.axcelerate_links set edited_in_skyline_at = clock_timestamp() where target_table = v_table and target_id = v_id;
  else
    insert into public.axcelerate_skipped(connection_id, entity, axcelerate_id, label, reason, skipped_by)
    select l.connection_id, l.entity, l.axcelerate_id, left(coalesce(l.raw->>'NAME', l.raw->>'name', l.raw->>'label', l.axcelerate_id), 200), 'deleted_in_skyline', auth.uid()
      from public.axcelerate_links l where l.target_table = v_table and l.target_id = v_id
    on conflict do nothing;
    delete from public.axcelerate_links where target_table = v_table and target_id = v_id;
  end if;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['hr.staff_profiles', 'public.cms_courses', 'public.cms_course_units', 'public.course_intakes', 'public.intake_units',
                           'public.locations', 'public.academic_breaks'] loop
    execute format('drop trigger if exists axcelerate_link_touch on %s', t);
    execute format('create trigger axcelerate_link_touch after update or delete on %s for each row execute function public.axcelerate_link_touch()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Import helpers
create or replace function public.axcelerate_date(p text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  if btrim(p) ~ '^\d{4}-\d{2}-\d{2}' then return left(btrim(p), 10)::date; end if;
  if btrim(p) ~ '^\d{1,2}/\d{1,2}/\d{4}' then return to_date(substring(btrim(p) from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY'); end if;
  return null;
exception when others then return null;
end $$;

create or replace function public.axcelerate_text(p jsonb, variadic p_keys text[]) returns text
language sql immutable set search_path = public as $$
  select nullif(btrim(p->>k), '') from unnest(p_keys) k where nullif(btrim(p->>k), '') is not null limit 1;
$$;

/** Begins an import write: later triggers know it is an import (no "edited in Skyline" stamp). */
create or replace function public.axcelerate_importing(p_actor uuid) returns void
language plpgsql set search_path = public as $$
begin
  perform set_config('axcelerate.importing', 'on', true);
  if p_actor is not null then perform set_config('hr.actor', p_actor::text, true); end if;
  perform set_config('hr.actor_kind', 'admin', true);
end $$;

/** The decision for one aXcelerate record: skipped, the existing link, or none. */
create or replace function public.axcelerate_link_find(p_connection uuid, p_entity text, p_ax text)
returns public.axcelerate_links language sql stable set search_path = public as $$
  select l.* from public.axcelerate_links l where l.connection_id = p_connection and l.entity = p_entity and l.axcelerate_id = p_ax;
$$;

create or replace function public.axcelerate_is_skipped(p_connection uuid, p_entity text, p_ax text) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from public.axcelerate_skipped s where s.connection_id = p_connection and s.entity = p_entity and s.axcelerate_id = p_ax);
$$;

create or replace function public.axcelerate_link_save(p_connection uuid, p_run uuid, p_entity text, p_ax text, p_table text, p_target text, p_raw jsonb)
returns uuid language plpgsql set search_path = public as $$
declare v uuid;
begin
  insert into public.axcelerate_links(connection_id, entity, axcelerate_id, target_table, target_id, raw, last_run_id, last_imported_at)
  values (p_connection, p_entity, p_ax, p_table, p_target, coalesce(p_raw, '{}'::jsonb), p_run, clock_timestamp())
  on conflict (connection_id, entity, axcelerate_id) do update
    set target_table = excluded.target_table, target_id = excluded.target_id, raw = excluded.raw, last_run_id = p_run,
        -- A record edited in Skyline stays "edited after the last import": later imports keep raising conflicts, never overwrite it.
        last_imported_at = case when public.axcelerate_links.edited_in_skyline_at > public.axcelerate_links.last_imported_at
                                then public.axcelerate_links.last_imported_at else clock_timestamp() end
  returning id into v;
  return v;
end $$;

/** Compares Skyline's values with aXcelerate's for a record edited in Skyline: one open conflict per differing field. */
create or replace function public.axcelerate_conflicts_record(p_link uuid, p_run uuid, p_skyline jsonb, p_axcelerate jsonb) returns int
language plpgsql set search_path = public as $$
declare k text; n int := 0;
begin
  for k in select jsonb_object_keys(p_axcelerate) loop
    if (p_axcelerate->k) is distinct from (p_skyline->k) then
      insert into public.axcelerate_conflicts(link_id, run_id, field, skyline_value, axcelerate_value)
      values (p_link, p_run, k, p_skyline->k, p_axcelerate->k)
      on conflict (link_id, field) where status = 'open' do update set axcelerate_value = excluded.axcelerate_value, run_id = excluded.run_id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

/** The outcome every import function returns. */
create or replace function public.axcelerate_outcome(p_action text, p_id text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object('action', p_action, 'id', p_id) || coalesce(p_extra, '{}'::jsonb) $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Locations (aXcelerate delivery locations / venues)
create or replace function public.axcelerate_import_location(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'ID', 'CONTACTID', 'DELIVERYLOCATIONID');
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), 'aXcelerate location ' || v_ax), 120);
  v_street text := concat_ws(' ', public.axcelerate_text(p_rec, 'UNITNO'), public.axcelerate_text(p_rec, 'STREETNO'), public.axcelerate_text(p_rec, 'STREETNAME'));
  v_suburb text := left(public.axcelerate_text(p_rec, 'CITY', 'SCITY'), 50);
  v_state text := upper(coalesce(public.axcelerate_text(p_rec, 'STATE', 'SSTATE'), ''));
  v_post text := public.axcelerate_text(p_rec, 'POSTCODE', 'SPOSTCODE');
  v_code text := public.axcelerate_text(p_rec, 'CODE');
  v_addr text; v_state_code text; l public.axcelerate_links; v_id uuid; v_new jsonb; v_old jsonb; v_complete boolean;
begin
  if v_ax is null then raise exception 'The location has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'location', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if btrim(v_street) = '' then v_street := public.axcelerate_text(p_rec, 'ADDRESS1', 'SADDRESS1', 'BUILDINGNAME'); end if;
  v_state_code := case v_state when 'NSW' then '01' when 'VIC' then '02' when 'QLD' then '03' when 'SA' then '04' when 'WA' then '05'
                               when 'TAS' then '06' when 'NT' then '07' when 'ACT' then '08' when 'OTHER' then '09' else null end;
  v_addr := nullif(btrim(concat_ws(', ', nullif(btrim(v_street), ''), concat_ws(' ', v_suburb, v_state, v_post))), '');
  if v_post !~ '^[0-9]{4}$' then v_post := null; end if;
  if v_code !~ '^[A-Za-z0-9 ]{1,10}$' then v_code := null; end if;
  v_complete := v_addr is not null and v_suburb is not null and v_post is not null and v_state_code is not null;
  v_new := jsonb_build_object('name', v_name, 'address', v_addr, 'suburb', v_suburb, 'postcode', v_post, 'state_code', v_state_code);
  l := public.axcelerate_link_find(p_connection, 'location', v_ax);
  if l.id is not null then
    select to_jsonb(x) - 'id' into v_old from (select name, address, suburb, postcode, state_code from public.locations where id = l.target_id::uuid) x;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      update public.locations set name = v_name, address = coalesce(v_addr, address), suburb = coalesce(v_suburb, suburb),
             postcode = coalesce(v_post, postcode), state_code = coalesce(v_state_code, state_code) where id = l.target_id::uuid;
      perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', l.target_id, p_rec);
      return public.axcelerate_outcome('updated', l.target_id);
    end if;
  end if;
  select id into v_id from public.locations where lower(btrim(name)) = lower(btrim(v_name)) limit 1;
  if v_id is not null then
    perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', v_id::text, p_rec);
    return public.axcelerate_outcome('linked', v_id::text);
  end if;
  -- An incomplete aXcelerate address is still created (switched off) so classes can point at it; an admin completes it to use it.
  insert into public.locations(name, address, suburb, postcode, state_code, country_code, avetmiss_location_id, kind, is_active)
  values (v_name, v_addr, v_suburb, v_post, v_state_code, '1101', v_code, 'theory', v_complete)
  returning id into v_id;
  perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', v_id::text, p_rec);
  return public.axcelerate_outcome('created', v_id::text, jsonb_build_object('active', v_complete));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Courses (qualifications, aXcelerate type p). The key is the national code; CRICOS stays Skyline's course key once set.
create or replace function public.axcelerate_import_course(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'ID');
  v_code text := upper(regexp_replace(coalesce(public.axcelerate_text(p_rec, 'CODE'), ''), '\s', '', 'g'));
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), v_code), 200);
  v_duration text := nullif(btrim(concat_ws(' ', public.axcelerate_text(p_rec, 'DURATION'), public.axcelerate_text(p_rec, 'DURATIONTYPE'))), '');
  l public.axcelerate_links; v_id text; v_slug text; v_old jsonb; v_new jsonb;
begin
  if v_ax is null then raise exception 'The course has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'course', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if v_code = '' then v_code := 'AX' || left(regexp_replace(v_ax, '[^0-9A-Za-z]', '', 'g'), 8); end if;
  v_new := jsonb_build_object('name', v_name);
  l := public.axcelerate_link_find(p_connection, 'course', v_ax);
  if l.id is not null then
    select jsonb_build_object('name', name) into v_old from public.cms_courses where id = l.target_id;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'course', v_ax, 'public.cms_courses', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      -- An existing course keeps its Skyline content; only a course aXcelerate created is renamed with it.
      update public.cms_courses set name = v_name, updated_at = now() where id = l.target_id and status = 'Draft' and name is distinct from v_name;
      perform public.axcelerate_link_save(p_connection, p_run, 'course', v_ax, 'public.cms_courses', l.target_id, p_rec);
      return public.axcelerate_outcome('updated', l.target_id);
    end if;
  end if;
  select id into v_id from public.cms_courses where upper(btrim(code)) = v_code and tenant_id is null limit 1;
  if v_id is not null then
    perform public.axcelerate_link_save(p_connection, p_run, 'course', v_ax, 'public.cms_courses', v_id, p_rec);
    return public.axcelerate_outcome('linked', v_id);
  end if;
  -- Created as a Draft (not on the website, not offered): an admin completes it (Training.gov.au import, CRICOS) to publish it.
  v_id := 'course-' || replace(gen_random_uuid()::text, '-', '');
  v_slug := lower(regexp_replace(v_code, '[^A-Za-z0-9]+', '-', 'g'));
  if exists (select 1 from public.cms_courses where slug = v_slug and tenant_id is null) then v_slug := v_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6); end if;
  insert into public.cms_courses(id, slug, code, name, duration, status, is_active, show_fees, updated_by)
  values (v_id, v_slug, v_code, v_name, coalesce(v_duration, ''), 'Draft', false, false, 'aXcelerate import');
  perform public.axcelerate_link_save(p_connection, p_run, 'course', v_ax, 'public.cms_courses', v_id, p_rec);
  return public.axcelerate_outcome('created', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. Units of a course (from a class's unit list). Key: the unit code within the course.
create or replace function public.axcelerate_import_unit(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code text := upper(regexp_replace(coalesce(public.axcelerate_text(p_rec, 'UNITCODE', 'CODE'), ''), '\s', '', 'g'));
  v_ax text; v_name text := left(coalesce(public.axcelerate_text(p_rec, 'UNIT', 'NAME'), v_code), 300);
  v_elective boolean := lower(coalesce(p_rec->>'ELECTIVE', 'false')) in ('true', '1', 'yes', 'y');
  v_start date := public.axcelerate_date(p_rec->>'SCHEDULEDSTARTDATE'); v_end date := public.axcelerate_date(p_rec->>'SCHEDULEDENDDATE');
  v_weeks int; l public.axcelerate_links; v_id text;
begin
  if v_code = '' then raise exception 'A unit of the class has no unit code' using errcode = '22023'; end if;
  if p_course is null then raise exception 'The unit % has no course', v_code using errcode = '22023'; end if;
  v_ax := p_course || ':' || v_code;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'unit', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  select id into v_id from public.cms_course_units where course_id = p_course and upper(btrim(code)) = v_code limit 1;
  l := public.axcelerate_link_find(p_connection, 'unit', v_ax);
  if v_id is not null then
    perform public.axcelerate_link_save(p_connection, p_run, 'unit', v_ax, 'public.cms_course_units', v_id, p_rec);
    return public.axcelerate_outcome(case when l.id is null then 'linked' else 'unchanged' end, v_id);
  end if;
  v_weeks := case when v_start is not null and v_end is not null and v_end >= v_start then greatest(1, least(104, ceil(((v_end - v_start) + 1) / 7.0)::int)) end;
  v_id := 'unit-' || replace(gen_random_uuid()::text, '-', '');
  insert into public.cms_course_units(id, course_id, code, name, unit_type, category, sort, default_weeks)
  values (v_id, p_course, v_code, v_name, case when v_elective then 'elective' else 'core' end, case when v_elective then 'Elective' else 'Core' end,
          coalesce(nullif(p_rec->>'UNITORDER', '')::int, (select coalesce(max(sort), 0) + 1 from public.cms_course_units where course_id = p_course)),
          coalesce(v_weeks, public.rule_int('lms.unit_default_duration_weeks', 4)));
  perform public.axcelerate_link_save(p_connection, p_run, 'unit', v_ax, 'public.cms_course_units', v_id, p_rec);
  return public.axcelerate_outcome('created', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 9. Trainers -> staff (HRMS › Employees), Active, role trainer. Key: email. No email, no sign-in invitation is sent.
create or replace function public.axcelerate_phone(p text) returns text
language plpgsql immutable set search_path = public as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
begin
  if d ~ '^0[2-9][0-9]{8}$' then d := '+61' || substr(d, 2);
  elsif d ~ '^61[2-9][0-9]{8}$' then d := '+' || d; end if;
  return case when d ~ '^\+[1-9][0-9]{6,14}$' then d end;
end $$;

create or replace function public.axcelerate_import_trainer(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public, hr as $$
declare v_ax text := public.axcelerate_text(p_rec, 'CONTACTID');
  v_first text := public.axcelerate_text(p_rec, 'GIVENNAME', 'FIRSTNAME'); v_last text := public.axcelerate_text(p_rec, 'SURNAME', 'LASTNAME');
  v_full text := public.axcelerate_text(p_rec, 'NAME', 'CONTACT_NAME');
  v_email text := lower(public.axcelerate_text(p_rec, 'EMAILADDRESS', 'EMAIL'));
  v_phone text := public.axcelerate_phone(public.axcelerate_text(p_rec, 'MOBILEPHONE', 'PHONE', 'WORKPHONE'));
  v_active boolean := lower(coalesce(p_rec->>'ACTIVE', 'true')) not in ('false', '0', 'no', 'n');
  l public.axcelerate_links; v_id uuid; v_old jsonb; v_new jsonb;
begin
  if v_ax is null then raise exception 'The trainer has no aXcelerate contact ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'trainer', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if v_first is null and v_full is not null then v_first := split_part(v_full, ' ', 1); v_last := nullif(btrim(substr(v_full, char_length(split_part(v_full, ' ', 1)) + 1)), ''); end if;
  v_first := left(coalesce(v_first, 'Trainer'), 100); v_last := left(coalesce(v_last, v_ax), 100);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then v_email := null; end if;
  if v_phone is not null and exists (select 1 from hr.staff_profiles where phone_e164 = v_phone) then v_phone := null; end if;
  v_new := jsonb_build_object('first_name', v_first, 'last_name', v_last, 'email', v_email);
  l := public.axcelerate_link_find(p_connection, 'trainer', v_ax);
  if l.id is not null then
    select jsonb_build_object('first_name', first_name, 'last_name', last_name, 'email', email) into v_old from hr.staff_profiles where id = l.target_id::uuid;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'trainer', v_ax, 'hr.staff_profiles', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      update hr.staff_profiles set first_name = v_first, last_name = v_last,
             email = case when auth_user_id is null then coalesce(v_email, email) else email end where id = l.target_id::uuid;
      perform public.axcelerate_link_save(p_connection, p_run, 'trainer', v_ax, 'hr.staff_profiles', l.target_id, p_rec);
      return public.axcelerate_outcome('updated', l.target_id);
    end if;
  end if;
  if v_email is not null then
    select id into v_id from hr.staff_profiles where lower(email) = v_email limit 1;
    if v_id is not null then
      perform public.axcelerate_link_save(p_connection, p_run, 'trainer', v_ax, 'hr.staff_profiles', v_id::text, p_rec);
      return public.axcelerate_outcome('linked', v_id::text);
    end if;
  end if;
  insert into hr.staff_profiles(first_name, last_name, email, phone_e164, status) values (v_first, v_last, v_email, v_phone, 'active') returning id into v_id;
  insert into hr.staff_applications(profile_id) values (v_id) on conflict (profile_id) do nothing;
  insert into hr.employment(profile_id) values (v_id) on conflict (profile_id) do nothing;
  insert into hr.staff_roles(profile_id, role, granted_by) select v_id, 'trainer', p_actor
   where not exists (select 1 from hr.staff_roles r where r.profile_id = v_id and r.role = 'trainer' and r.revoked_at is null);
  if not v_active then
    begin update hr.staff_profiles set status = 'inactive' where id = v_id; exception when others then null; end;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'trainer', v_ax, 'hr.staff_profiles', v_id::text, p_rec);
  return public.axcelerate_outcome('created', v_id::text);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 10. Classes (aXcelerate class instances, type p) -> intakes, with their units and trainer.
--   p_rec: the instance (ID / INSTANCEID, NAME, STARTDATE, FINISHDATE, MAXPARTICIPANTS, ISACTIVE, ENROLMENTOPEN, STATUS, UNITS[]);
--   p_course: the Skyline course id; p_units: [{unitId, start, end, order, ax}] already imported; p_trainer: hr.staff_profiles id or null;
--   p_location: locations id or null.
create or replace function public.axcelerate_import_class(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb, p_course text,
  p_units jsonb, p_trainer uuid, p_location uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'INSTANCEID', 'ID');
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), 'aXcelerate class ' || v_ax), 160);
  v_start date := public.axcelerate_date(p_rec->>'STARTDATE'); v_end date := public.axcelerate_date(p_rec->>'FINISHDATE');
  v_cap int := nullif(regexp_replace(coalesce(p_rec->>'MAXPARTICIPANTS', ''), '[^0-9]', '', 'g'), '')::int;
  v_active boolean := lower(coalesce(p_rec->>'ISACTIVE', 'true')) not in ('false', '0', 'no');
  v_open boolean := lower(coalesce(p_rec->>'ENROLMENTOPEN', 'true')) not in ('false', '0', 'no');
  v_status text; v_load text; v_campus text; l public.axcelerate_links; v_id uuid; v_old jsonb; v_new jsonb; u jsonb; v_iu uuid;
  v_ustart date; v_uend date; v_batch uuid; n_units int := 0;
begin
  if v_ax is null then raise exception 'The class has no aXcelerate instance ID' using errcode = '22023'; end if;
  if p_course is null then raise exception 'The class % has no course', v_name using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'class', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if v_start is null then
    select min(public.axcelerate_date(x->>'start')) into v_start from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x;
  end if;
  if v_start is null then raise exception 'The class % has no start date', v_name using errcode = '22023'; end if;
  if v_end is not null and v_end < v_start then v_end := v_start; end if;
  if v_cap is not null and (v_cap < 1 or v_cap > 10000) then v_cap := null; end if;
  v_status := case when v_active and v_open and coalesce(v_end, v_start) >= current_date then 'open' else 'closed' end;
  -- CoE (international, CRICOS) when the course has a CRICOS code, else VoE.
  select case when coalesce(nullif(btrim(cricos), ''), cricos_course_code) is not null then 'coe' else 'voe' end into v_load from public.cms_courses where id = p_course;
  select left(name, 200) into v_campus from public.locations where id = p_location;
  v_new := jsonb_build_object('name', v_name, 'start_date', v_start, 'end_date', v_end, 'capacity', v_cap, 'status', v_status);
  l := public.axcelerate_link_find(p_connection, 'class', v_ax);
  if l.id is not null then
    select jsonb_build_object('name', name, 'start_date', start_date, 'end_date', end_date, 'capacity', capacity, 'status', status)
      into v_old from public.course_intakes where id = l.target_id::uuid;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'class', v_ax, 'public.course_intakes', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      v_id := l.target_id::uuid;
      update public.course_intakes set name = v_name, label = left(v_name, 80), start_date = v_start, end_date = v_end, capacity = v_cap, status = v_status,
             campus = coalesce(v_campus, campus), updated_at = now(), updated_by = p_actor where id = v_id;
    end if;
  end if;
  if v_id is null then
    insert into public.course_intakes(course_id, start_date, end_date, label, name, campus, capacity, status, study_load, updated_by)
    values (p_course, v_start, v_end, left(v_name, 80), v_name, v_campus, v_cap, v_status, coalesce(v_load, 'voe'), p_actor)
    returning id into v_id;
  end if;
  -- Units of the class on aXcelerate's dates (a course on a Skyline master timetable keeps the master's dates while the class is open).
  for u in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) loop
    v_ustart := coalesce(public.axcelerate_date(u->>'start'), v_start);
    v_uend := greatest(coalesce(public.axcelerate_date(u->>'end'), v_end, v_ustart), v_ustart);
    select id into v_iu from public.intake_units where intake_id = v_id and unit_id = u->>'unitId';
    if v_iu is null then
      insert into public.intake_units(intake_id, unit_id, start_date, end_date, sort, trainer_id)
      values (v_id, u->>'unitId', v_ustart, v_uend, coalesce(nullif(u->>'order', '')::int, n_units + 1), p_trainer) returning id into v_iu;
    elsif not exists (select 1 from public.axcelerate_links x where x.target_table = 'public.intake_units' and x.target_id = v_iu::text
                        and x.edited_in_skyline_at is not null and x.edited_in_skyline_at > x.last_imported_at) then
      update public.intake_units set start_date = v_ustart, end_date = v_uend, trainer_id = coalesce(p_trainer, trainer_id) where id = v_iu;
    end if;
    perform public.axcelerate_link_save(p_connection, p_run, 'class_unit', v_ax || ':' || (u->>'unitId'), 'public.intake_units', v_iu::text, u);
    n_units := n_units + 1;
  end loop;
  if p_trainer is not null then
    v_batch := public.intake_default_batch(v_id);
    insert into public.intake_trainers(intake_id, staff_id, batch_id) select v_id, p_trainer, v_batch
     where not exists (select 1 from public.intake_trainers t where t.intake_id = v_id and t.staff_id = p_trainer);
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'class', v_ax, 'public.course_intakes', v_id::text, p_rec);
  return public.axcelerate_outcome(case when l.id is null then 'created' else 'updated' end, v_id::text, jsonb_build_object('units', n_units));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 11. Breaks -> term breaks of a course (academic_breaks). p_rec: {id, label, start, end}; key: the aXcelerate id per course.
create or replace function public.axcelerate_import_break(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_src text := public.axcelerate_text(p_rec, 'id', 'ID'); v_ax text;
  v_label text := left(coalesce(public.axcelerate_text(p_rec, 'label', 'NAME', 'TITLE'), 'Break'), 80);
  v_start date := public.axcelerate_date(coalesce(p_rec->>'start', p_rec->>'STARTDATE', p_rec->>'DATE'));
  v_end date := public.axcelerate_date(coalesce(p_rec->>'end', p_rec->>'FINISHDATE', p_rec->>'ENDDATE', p_rec->>'start', p_rec->>'STARTDATE', p_rec->>'DATE'));
  l public.axcelerate_links; v_id uuid; v_old jsonb; v_new jsonb;
begin
  if p_course is null then raise exception 'The break has no course' using errcode = '22023'; end if;
  if v_start is null then raise exception 'The break "%" has no start date', v_label using errcode = '22023'; end if;
  if v_end is null or v_end < v_start then v_end := v_start; end if;
  v_ax := p_course || ':' || coalesce(v_src, v_start::text || '/' || v_end::text);
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'break', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  v_new := jsonb_build_object('label', v_label, 'start_date', v_start, 'end_date', v_end);
  l := public.axcelerate_link_find(p_connection, 'break', v_ax);
  if l.id is not null then
    select jsonb_build_object('label', label, 'start_date', start_date, 'end_date', end_date) into v_old from public.academic_breaks where id = l.target_id::uuid;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'break', v_ax, 'public.academic_breaks', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      update public.academic_breaks set label = v_label, start_date = v_start, end_date = v_end, updated_by = p_actor where id = l.target_id::uuid;
      perform public.axcelerate_link_save(p_connection, p_run, 'break', v_ax, 'public.academic_breaks', l.target_id, p_rec);
      return public.axcelerate_outcome('updated', l.target_id);
    end if;
  end if;
  select id into v_id from public.academic_breaks where course_id = p_course and start_date = v_start and end_date = v_end limit 1;
  if v_id is not null then
    perform public.axcelerate_link_save(p_connection, p_run, 'break', v_ax, 'public.academic_breaks', v_id::text, p_rec);
    return public.axcelerate_outcome('linked', v_id::text);
  end if;
  insert into public.academic_breaks(label, start_date, end_date, course_id, source, updated_by)
  values (v_label, v_start, v_end, p_course, 'manual', p_actor) returning id into v_id;
  perform public.axcelerate_link_save(p_connection, p_run, 'break', v_ax, 'public.academic_breaks', v_id::text, p_rec);
  return public.axcelerate_outcome('created', v_id::text);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 12. Runs (called by axcelerate-import with the service role, on behalf of the checked user)
create or replace function public.axcelerate_run_start(p_connection uuid, p_actor uuid, p_mode text, p_entities text[], p_retry_of uuid default null, p_ip text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if exists (select 1 from public.axcelerate_import_runs where connection_id = p_connection and status = 'running') then
    raise exception 'An aXcelerate import is already running. Wait for it to finish or cancel it.' using errcode = '55P03';
  end if;
  insert into public.axcelerate_import_runs(connection_id, mode, entities, started_by, retry_of)
  values (p_connection, p_mode, p_entities, p_actor, p_retry_of) returning id into v;
  perform public.axcelerate_audit(p_connection, p_actor, case when p_retry_of is null then 'axcelerate_import_started' else 'axcelerate_import_retried' end,
    jsonb_build_object('run', v, 'mode', p_mode, 'entities', p_entities, 'retryOf', p_retry_of), p_ip);
  return v;
end $$;

create or replace function public.axcelerate_run_save(p_run uuid, p_cursor jsonb, p_counts jsonb, p_status text default null, p_error text default null)
returns public.axcelerate_import_runs language plpgsql security definer set search_path = public as $$
declare r public.axcelerate_import_runs;
begin
  update public.axcelerate_import_runs
     set cursor = coalesce(p_cursor, cursor), counts = coalesce(p_counts, counts), updated_at = now(),
         status = case when status <> 'running' then status when cancel_requested and p_status is null then 'cancelled' else coalesce(p_status, status) end,
         finished_at = case when coalesce(p_status, case when cancel_requested then 'cancelled' end) is not null and finished_at is null then now() else finished_at end,
         last_error = coalesce(left(p_error, 1000), last_error)
   where id = p_run returning * into r;
  return r;
end $$;

create or replace function public.axcelerate_import_error(p_run uuid, p_entity text, p_ax text, p_label text, p_message text, p_raw jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.axcelerate_import_errors(run_id, entity, axcelerate_id, label, message, raw)
  values (p_run, left(p_entity, 40), left(p_ax, 120), left(p_label, 200), left(coalesce(p_message, 'Unknown error'), 1000), coalesce(p_raw, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 13. Screens (authenticated; the permission is checked here, the browser only shows what this returns)
create or replace function public.axcelerate_require() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.cms_has_permission('axcelerate.import') then
    raise exception 'The aXcelerate import permission is required.' using errcode = '42501';
  end if;
end $$;

/** Whether the signed-in user may see the import controls (buttons, Import centre, dashboard card). */
create or replace function public.axcelerate_import_allowed() returns boolean
language sql stable security definer set search_path = public as $$ select public.cms_has_permission('axcelerate.import') $$;

create or replace function public.axcelerate_connection_for_scope() returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.integration_connections c where c.connector_id = 'axcelerate' and c.tenant_id is not distinct from public.tenant_current()
  order by c.created_at limit 1;
$$;

create or replace function public.axcelerate_import_overview(p_connection uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_conn uuid := coalesce(p_connection, public.axcelerate_connection_for_scope()); c record;
begin
  perform public.axcelerate_require();
  select id, status, last_success_at, credential_configured into c from public.integration_connections where id = v_conn and connector_id = 'axcelerate';
  return jsonb_build_object(
    'connection', case when c.id is null then null else jsonb_build_object('id', c.id, 'status', c.status, 'lastSuccessAt', c.last_success_at, 'saved', c.credential_configured) end,
    'runs', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('startedByName', (select coalesce(u.name, u.email) from public.cms_users u where u.auth_user_id = r.started_by limit 1),
                        'openErrors', (select count(*) from public.axcelerate_import_errors e where e.run_id = r.id and e.resolved_at is null)) order by r.started_at desc)
                      from (select * from public.axcelerate_import_runs where connection_id = v_conn order by started_at desc limit 25) r), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select e.* from public.axcelerate_import_errors e join public.axcelerate_import_runs r on r.id = e.run_id
                         where r.connection_id = v_conn and e.resolved_at is null order by e.created_at desc limit 200) e), '[]'::jsonb),
    'conflicts', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'field', k.field, 'skyline', k.skyline_value, 'axcelerate', k.axcelerate_value, 'createdAt', k.created_at,
                         'entity', l.entity, 'axcelerateId', l.axcelerate_id, 'targetTable', l.target_table, 'targetId', l.target_id,
                         'label', coalesce(l.raw->>'NAME', l.raw->>'label', l.axcelerate_id)) order by k.created_at desc)
                         from public.axcelerate_conflicts k join public.axcelerate_links l on l.id = k.link_id where l.connection_id = v_conn and k.status = 'open'), '[]'::jsonb),
    'skipped', coalesce((select jsonb_agg(to_jsonb(s) order by s.skipped_at desc) from public.axcelerate_skipped s where s.connection_id = v_conn), '[]'::jsonb),
    'linked', coalesce((select jsonb_object_agg(entity, n) from (select entity, count(*) n from public.axcelerate_links where connection_id = v_conn group by entity) x), '{}'::jsonb),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'who', a.actor_name, 'action', a.action, 'detail', a.detail) order by a.created_at desc)
                       from (select * from public.portal_audit_log where target_type = 'axcelerate' and target_id = coalesce(v_conn::text, '') order by created_at desc limit 200) a), '[]'::jsonb),
    'permission', coalesce((select jsonb_agg(jsonb_build_object('userId', u.auth_user_id, 'name', u.name, 'email', u.email,
                         'granted', exists (select 1 from public.cms_permissions p where p.user_id = u.auth_user_id and p.permission = 'axcelerate.import')) order by u.name)
                         from public.cms_users u where u.role = 'Admin' and u.status = 'Active' and u.auth_user_id is not null), '[]'::jsonb));
end $$;

/** The import badge on a record: imported from aXcelerate on <date> (information only, never a lock). */
create or replace function public.axcelerate_record_badge(p_table text, p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.cms_is_admin() then (select jsonb_build_object('importedAt', l.first_imported_at, 'lastImportedAt', l.last_imported_at, 'editedInSkylineAt', l.edited_in_skyline_at)
           from public.axcelerate_links l where l.target_table = p_table and l.target_id = p_id order by l.first_imported_at limit 1) end;
$$;

create or replace function public.axcelerate_run_cancel(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.axcelerate_import_runs;
begin
  perform public.axcelerate_require();
  update public.axcelerate_import_runs set cancel_requested = true, updated_at = now() where id = p_run and status = 'running' returning * into r;
  if r.id is null then raise exception 'This import is not running.' using errcode = '55000'; end if;
  perform public.axcelerate_audit(r.connection_id, auth.uid(), 'axcelerate_import_cancelled', jsonb_build_object('run', r.id));
end $$;

create or replace function public.axcelerate_skip_undo(p_connection uuid, p_entity text, p_ax text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.axcelerate_require();
  delete from public.axcelerate_skipped where connection_id = p_connection and entity = p_entity and axcelerate_id = p_ax;
  if not found then raise exception 'Not on the skipped list.' using errcode = 'P0002'; end if;
  perform public.axcelerate_audit(p_connection, auth.uid(), 'axcelerate_skip_undone', jsonb_build_object('entity', p_entity, 'axcelerateId', p_ax));
end $$;

create or replace function public.axcelerate_error_resolve(p_error uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.axcelerate_require();
  update public.axcelerate_import_errors set resolved_at = now(), resolved_by = auth.uid() where id = p_error and resolved_at is null;
end $$;

/** Keep Skyline's value, or take aXcelerate's (written into the record; only the fields imports manage). */
create or replace function public.axcelerate_conflict_decide(p_conflict uuid, p_take_axcelerate boolean) returns void
language plpgsql security definer set search_path = public, hr as $$
declare k public.axcelerate_conflicts; l public.axcelerate_links; v_allowed text[]; v_col text;
begin
  perform public.axcelerate_require();
  select * into k from public.axcelerate_conflicts where id = p_conflict and status = 'open' for update;
  if k.id is null then raise exception 'This conflict is already decided.' using errcode = '55000'; end if;
  select * into l from public.axcelerate_links where id = k.link_id;
  if p_take_axcelerate then
    v_allowed := case l.target_table
      when 'hr.staff_profiles' then array['first_name', 'last_name', 'email']
      when 'public.locations' then array['name', 'address', 'suburb', 'postcode', 'state_code']
      when 'public.cms_courses' then array['name']
      when 'public.course_intakes' then array['name', 'start_date', 'end_date', 'capacity', 'status']
      when 'public.academic_breaks' then array['label', 'start_date', 'end_date'] else array[]::text[] end;
    v_col := k.field;
    if not v_col = any(v_allowed) then raise exception 'This field cannot be taken from aXcelerate.' using errcode = '22023'; end if;
    perform set_config('axcelerate.importing', 'on', true);
    perform set_config('hr.actor', auth.uid()::text, true);
    execute format('update %s set %I = (select (jsonb_populate_record(null::%s, jsonb_build_object(%L, $1))).%I) where id::text = $2',
                   l.target_table, v_col, l.target_table, v_col, v_col)
      using k.axcelerate_value, l.target_id;
  end if;
  update public.axcelerate_conflicts set status = case when p_take_axcelerate then 'take_axcelerate' else 'keep_skyline' end, decided_by = auth.uid(), decided_at = now() where id = k.id;
  perform public.axcelerate_audit(l.connection_id, auth.uid(), 'axcelerate_conflict_decided',
    jsonb_build_object('conflict', k.id, 'entity', l.entity, 'field', k.field, 'decision', case when p_take_axcelerate then 'take_axcelerate' else 'keep_skyline' end));
end $$;

/** Grant or remove the permission (SLIT admins only; a holder grants it). */
create or replace function public.cms_permission_set(p_user uuid, p_permission text, p_grant boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.cms_has_permission(p_permission) then raise exception 'Only a holder of this permission can change it.' using errcode = '42501'; end if;
  if p_grant then
    if not exists (select 1 from public.cms_users u where u.auth_user_id = p_user and u.role = 'Admin' and u.status = 'Active') then
      raise exception 'This permission is for active SLIT admins only.' using errcode = '22023';
    end if;
    insert into public.cms_permissions(user_id, permission, granted_by) values (p_user, p_permission, auth.uid()) on conflict do nothing;
  else
    if p_user = auth.uid() then raise exception 'You cannot remove your own permission.' using errcode = '22023'; end if;
    delete from public.cms_permissions where user_id = p_user and permission = p_permission;
  end if;
  perform public.axcelerate_audit(public.axcelerate_connection_for_scope(), auth.uid(), case when p_grant then 'permission_granted' else 'permission_removed' end,
    jsonb_build_object('permission', p_permission, 'user', p_user));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 14. Token saved by / on (replaces the 20261128030517 versions; the tokens themselves never come back)
create or replace function public.integration_axcelerate_save(p_connection uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c record; f jsonb := coalesce(p_fields, '{}'::jsonb); v_env text; v_sub text; v_api text; v_ws text; v_by text;
begin
  select id, tenant_id, connector_id, status into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id <> 'axcelerate' then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  if c.status = 'disabled' then raise exception 'Enable the connection first' using errcode = '55000'; end if;
  v_env := lower(btrim(coalesce(f->>'environment', '')));
  v_sub := lower(btrim(coalesce(f->>'subdomain', '')));
  v_sub := regexp_replace(v_sub, '^https?://', '');
  v_sub := regexp_replace(v_sub, '\.(app|stg)\.axcelerate\.com.*$', '');
  v_api := btrim(coalesce(f->>'apiToken', '')); v_ws := btrim(coalesce(f->>'wsToken', ''));
  if v_env not in ('production', 'staging') then raise exception 'Choose Live (production) or Staging' using errcode = '22023'; end if;
  if v_sub !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception 'Enter your aXcelerate subdomain: the first part of your aXcelerate address (yourcollege in yourcollege.app.axcelerate.com)' using errcode = '22023';
  end if;
  if v_api !~ '^[A-Za-z0-9._-]+$' or length(v_api) not between 8 and 500 then raise exception 'Enter the aXcelerate API token (from aXcelerate support)' using errcode = '22023'; end if;
  if v_ws !~ '^[A-Za-z0-9._-]+$' or length(v_ws) not between 8 and 500 then raise exception 'Enter the aXcelerate web service token' using errcode = '22023'; end if;
  select coalesce(u.name, u.email) into v_by from public.cms_users u where u.auth_user_id = auth.uid() limit 1;
  perform public.integration_credential_write(c.id, 'api_key',
    jsonb_build_object('version', 1, 'fields', jsonb_build_object('environment', v_env, 'subdomain', v_sub, 'apiToken', v_api, 'wsToken', v_ws),
                       'savedAt', now(), 'savedBy', coalesce(v_by, 'an administrator'))::text);
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credential_rotated', gen_random_uuid());
  perform public.axcelerate_audit(c.id, auth.uid(), 'axcelerate_connection_saved', jsonb_build_object('environment', v_env, 'subdomain', v_sub));
end;
$$;

create or replace function public.integration_axcelerate_clear(p_connection uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id <> 'axcelerate' then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key', '');
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credentials_revoked', gen_random_uuid());
  perform public.axcelerate_audit(c.id, auth.uid(), 'axcelerate_connection_removed', '{}'::jsonb);
end;
$$;

create or replace function public.integration_axcelerate_summary(p_connection uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record; v text; d jsonb; f jsonb;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found or c.connector_id <> 'axcelerate' then return null; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) then raise exception 'Administrator access required' using errcode = '42501'; end if;
  v := public.integration_credential_read(c.id, 'api_key');
  if v is null or v = '' then return jsonb_build_object('saved', false); end if;
  d := v::jsonb; f := d->'fields';
  return jsonb_build_object('saved', true, 'environment', f->>'environment', 'subdomain', f->>'subdomain',
    'baseUrl', 'https://' || (f->>'subdomain') || case when f->>'environment' = 'staging' then '.stg' else '.app' end || '.axcelerate.com/api',
    'savedAt', d->>'savedAt', 'savedBy', d->>'savedBy');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Grants
revoke all on function public.cms_has_permission(text), public.axcelerate_request_ip(), public.axcelerate_audit(uuid, uuid, text, jsonb, text),
  public.axcelerate_security_event(uuid, uuid, text, text, text, text), public.axcelerate_link_touch(), public.axcelerate_date(text),
  public.axcelerate_text(jsonb, text[]), public.axcelerate_importing(uuid), public.axcelerate_link_find(uuid, text, text),
  public.axcelerate_is_skipped(uuid, text, text), public.axcelerate_link_save(uuid, uuid, text, text, text, text, jsonb),
  public.axcelerate_conflicts_record(uuid, uuid, jsonb, jsonb), public.axcelerate_outcome(text, text, jsonb),
  public.axcelerate_import_location(uuid, uuid, uuid, jsonb), public.axcelerate_import_course(uuid, uuid, uuid, jsonb),
  public.axcelerate_import_unit(uuid, uuid, uuid, text, jsonb), public.axcelerate_phone(text), public.axcelerate_import_trainer(uuid, uuid, uuid, jsonb),
  public.axcelerate_import_class(uuid, uuid, uuid, jsonb, text, jsonb, uuid, uuid), public.axcelerate_import_break(uuid, uuid, uuid, text, jsonb),
  public.axcelerate_run_start(uuid, uuid, text, text[], uuid, text), public.axcelerate_run_save(uuid, jsonb, jsonb, text, text),
  public.axcelerate_import_error(uuid, text, text, text, text, jsonb), public.axcelerate_require(), public.axcelerate_import_allowed(),
  public.axcelerate_connection_for_scope(), public.axcelerate_import_overview(uuid), public.axcelerate_record_badge(text, text),
  public.axcelerate_run_cancel(uuid), public.axcelerate_skip_undo(uuid, text, text), public.axcelerate_error_resolve(uuid),
  public.axcelerate_conflict_decide(uuid, boolean), public.cms_permission_set(uuid, text, boolean),
  public.integration_axcelerate_save(uuid, jsonb), public.integration_axcelerate_clear(uuid), public.integration_axcelerate_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.axcelerate_security_event(uuid, uuid, text, text, text, text), public.axcelerate_audit(uuid, uuid, text, jsonb, text),
  public.axcelerate_import_location(uuid, uuid, uuid, jsonb), public.axcelerate_import_course(uuid, uuid, uuid, jsonb),
  public.axcelerate_import_unit(uuid, uuid, uuid, text, jsonb), public.axcelerate_import_trainer(uuid, uuid, uuid, jsonb),
  public.axcelerate_import_class(uuid, uuid, uuid, jsonb, text, jsonb, uuid, uuid), public.axcelerate_import_break(uuid, uuid, uuid, text, jsonb),
  public.axcelerate_run_start(uuid, uuid, text, text[], uuid, text), public.axcelerate_run_save(uuid, jsonb, jsonb, text, text),
  public.axcelerate_import_error(uuid, text, text, text, text, jsonb), public.axcelerate_connection_for_scope()
  to service_role;
grant execute on function public.cms_has_permission(text), public.axcelerate_import_allowed(), public.axcelerate_import_overview(uuid),
  public.axcelerate_record_badge(text, text), public.axcelerate_run_cancel(uuid), public.axcelerate_skip_undo(uuid, text, text),
  public.axcelerate_error_resolve(uuid), public.axcelerate_conflict_decide(uuid, boolean), public.cms_permission_set(uuid, text, boolean),
  public.integration_axcelerate_save(uuid, jsonb), public.integration_axcelerate_clear(uuid), public.integration_axcelerate_summary(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 15. The new Edge Function axcelerate-import joins the Edge Function allowlist (browser error reports and the daily health check).
do $do$
declare names text[] := public.edge_function_names();
begin
 if not ('axcelerate-import' = any(names)) then
  names := array(select x from unnest(names || array['axcelerate-import']) x order by x);
  execute format('create or replace function public.edge_function_names() returns text[] language sql immutable as $f$ select %L::text[] $f$', names);
 end if;
end $do$;

commit;
