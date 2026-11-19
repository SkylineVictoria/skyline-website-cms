-- Create Email for staff (owner 2026-11-20): employees and trainers get <first.last>@slit.edu.au with Office 365 A1 for faculty, created by
-- the student-office365 Edge Function exactly like a student's account. Only the account record is kept (never a password).
-- Also: link an existing Microsoft 365 account to a student or staff record instead of creating a second one (o365_link), and the
-- Create Email person list shows the linked / created staff accounts. SLIT administrators only (admin_business_require). Additive.
set local lock_timeout = '5s';

create table if not exists public.staff_office365_accounts (
 staff_id uuid primary key references hr.staff_profiles(id) on delete cascade,
 upn text not null unique check (upn ~ '^[a-z0-9]([a-z0-9.]*[a-z0-9])?@[a-z0-9.-]+$'),
 ms_user_id text,
 status text not null default 'creating' check (status in ('creating','active','failed')),
 licence_sku text,
 last_error text check (last_error is null or last_error ~ '^[a-z_]{1,60}$'),
 welcome_sent_at timestamptz,
 linked boolean not null default false,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.staff_office365_accounts enable row level security;
revoke all on public.staff_office365_accounts from anon, authenticated;
-- A student's existing account can be linked too (not created by Skyline).
alter table public.student_office365_accounts add column if not exists linked boolean not null default false;

create or replace function public.staff_o365_prepare(p_staff uuid)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare s hr.staff_profiles; a public.staff_office365_accounts;
begin
 perform public.admin_business_require();
 select * into s from hr.staff_profiles where id = p_staff;
 if not found then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
 select * into a from public.staff_office365_accounts where staff_id = p_staff;
 return jsonb_build_object('staffId', s.id, 'fullName', btrim(concat_ws(' ', s.first_name, s.last_name)), 'recordEmail', s.email, 'status', s.status,
  'trainer', exists (select 1 from hr.staff_roles r where r.profile_id = s.id and r.role = 'trainer' and r.revoked_at is null),
  'account', case when a.staff_id is null then null else jsonb_build_object('email', a.upn, 'status', a.status, 'lastError', a.last_error,
   'welcomeSentAt', a.welcome_sent_at, 'createdAt', a.created_at, 'msUserId', a.ms_user_id, 'linked', a.linked) end);
end $$;

create or replace function public.staff_o365_claim(p_staff uuid, p_upn text)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare a public.staff_office365_accounts; v_upn text := lower(btrim(coalesce(p_upn, '')));
begin
 perform public.admin_business_require();
 perform 1 from hr.staff_profiles where id = p_staff for update;
 if not found then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
 select * into a from public.staff_office365_accounts where staff_id = p_staff for update;
 if found then
  if a.status = 'active' then raise exception 'This staff member already has an Office 365 email' using errcode = '23505'; end if;
  if a.status = 'creating' and a.updated_at > now() - interval '5 minutes' then raise exception 'Creation is already in progress' using errcode = '55P03'; end if;
  update public.staff_office365_accounts set status = 'creating', last_error = null, updated_at = now() where staff_id = p_staff returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.staff_office365_accounts where upn = v_upn) or exists (select 1 from public.student_office365_accounts where upn = v_upn) then
  return jsonb_build_object('conflict', true);
 end if;
 insert into public.staff_office365_accounts(staff_id, upn, created_by) values (p_staff, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
end $$;

create or replace function public.staff_o365_finish(p_staff uuid, p_ms_user text, p_ok boolean, p_error text, p_sku text, p_welcome boolean)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare a public.staff_office365_accounts;
begin
 perform public.admin_business_require();
 update public.staff_office365_accounts set
  ms_user_id = coalesce(nullif(p_ms_user, ''), ms_user_id),
  status = case when p_ok then 'active' else 'failed' end,
  last_error = case when p_ok then null else p_error end,
  licence_sku = coalesce(nullif(p_sku, ''), licence_sku),
  welcome_sent_at = case when p_welcome then now() else welcome_sent_at end,
  updated_at = now()
 where staff_id = p_staff and status = 'creating' returning * into a;
 if not found then raise exception 'No creation in progress for this staff member' using errcode = 'P0002'; end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', case when p_ok then 'staff_office365_created' else 'staff_office365_failed' end, 'staff', p_staff::text, null, jsonb_build_object('email', a.upn, 'error', a.last_error, 'welcomeSent', p_welcome));
 return jsonb_build_object('email', a.upn, 'status', a.status, 'lastError', a.last_error, 'welcomeSentAt', a.welcome_sent_at);
end $$;

-- Link an account that already exists in Microsoft 365 (checked by the Edge Function) to the record; never two records on one address.
create or replace function public.o365_link(p_kind text, p_person uuid, p_upn text, p_ms_user text)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare v_upn text := lower(btrim(coalesce(p_upn, '')));
begin
 perform public.admin_business_require();
 if p_kind not in ('student', 'staff') or v_upn !~ '^[a-z0-9]([a-z0-9.]*[a-z0-9])?@[a-z0-9.-]+$' or coalesce(p_ms_user, '') !~ '^[0-9a-f-]{36}$' then
  raise exception 'Choose the account to link' using errcode = '22023';
 end if;
 if p_kind = 'student' then
  perform 1 from public.enrollment_students where id = p_person for update;
  if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.student_office365_accounts where upn = v_upn and student_id <> p_person) or exists (select 1 from public.staff_office365_accounts where upn = v_upn) then
   raise exception 'This address is linked to another record' using errcode = '23505'; end if;
  if exists (select 1 from public.student_office365_accounts where student_id = p_person and status = 'active' and upn <> v_upn) then
   raise exception 'This student already has another Office 365 email' using errcode = '22023'; end if;
  insert into public.student_office365_accounts(student_id, upn, ms_user_id, status, linked, created_by) values (p_person, v_upn, p_ms_user, 'active', true, auth.uid())
  on conflict (student_id) do update set upn = excluded.upn, ms_user_id = excluded.ms_user_id, status = 'active', linked = true, last_error = null, updated_at = now();
 else
  perform 1 from hr.staff_profiles where id = p_person for update;
  if not found then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.staff_office365_accounts where upn = v_upn and staff_id <> p_person) or exists (select 1 from public.student_office365_accounts where upn = v_upn) then
   raise exception 'This address is linked to another record' using errcode = '23505'; end if;
  if exists (select 1 from public.staff_office365_accounts where staff_id = p_person and status = 'active' and upn <> v_upn) then
   raise exception 'This staff member already has another Office 365 email' using errcode = '22023'; end if;
  insert into public.staff_office365_accounts(staff_id, upn, ms_user_id, status, linked, created_by) values (p_person, v_upn, p_ms_user, 'active', true, auth.uid())
  on conflict (staff_id) do update set upn = excluded.upn, ms_user_id = excluded.ms_user_id, status = 'active', linked = true, last_error = null, updated_at = now();
 end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', 'office365_linked', p_kind, p_person::text, null, jsonb_build_object('email', v_upn));
 return jsonb_build_object('linked', true, 'email', v_upn);
end $$;

revoke all on function public.staff_o365_prepare(uuid), public.staff_o365_claim(uuid, text), public.staff_o365_finish(uuid, text, boolean, text, text, boolean),
 public.o365_link(text, uuid, text, text) from public, anon;
grant execute on function public.staff_o365_prepare(uuid), public.staff_o365_claim(uuid, text), public.staff_o365_finish(uuid, text, boolean, text, text, boolean),
 public.o365_link(text, uuid, text, text) to authenticated;

-- The person list: a staff member's created or linked account counts as their mailbox.
create or replace function public.email_mgmt_people(p_type text, p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare q text := '%' || lower(btrim(coalesce(p_query, ''))) || '%';
begin
 perform public.admin_business_require();
 if p_type not in ('student', 'employee', 'trainer', 'agent') then raise exception 'Choose a person type' using errcode = '22023'; end if;
 if length(coalesce(p_query, '')) > 80 then raise exception 'Search text is too long' using errcode = '22023'; end if;
 if p_type = 'student' then
  return coalesce((select jsonb_agg(x order by x->>'name') from (
   select jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email, 'status', s.status,
    'mailbox', case when a.status = 'active' then a.upn end, 'mailboxStatus', a.status) x
   from public.enrollment_students s left join public.student_office365_accounts a on a.student_id = s.id
   where lower(coalesce(s.full_name, '') || ' ' || coalesce(s.email, '')) like q
   order by s.full_name limit 200) t), '[]'::jsonb);
 elsif p_type = 'agent' then
  return coalesce((select jsonb_agg(x order by x->>'name') from (
   select jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'status', g.status,
    'mailbox', case when lower(g.email) like '%@slit.edu.au' then g.email end, 'mailboxStatus', null) x
   from public.agents g where lower(coalesce(g.full_name, '') || ' ' || coalesce(g.email, '')) like q
   order by g.full_name limit 200) t), '[]'::jsonb);
 end if;
 return coalesce((select jsonb_agg(x order by x->>'name') from (
  select jsonb_build_object('id', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'status', p.status,
   'mailbox', case when a.status = 'active' then a.upn when lower(p.email) like '%@slit.edu.au' then p.email end, 'mailboxStatus', a.status) x
  from hr.staff_profiles p left join public.staff_office365_accounts a on a.staff_id = p.id
  where (p_type = 'employee' or exists (select 1 from hr.staff_roles r where r.profile_id = p.id and r.role = 'trainer' and r.revoked_at is null))
   and lower(concat_ws(' ', p.first_name, p.last_name, p.email)) like q
  order by p.first_name, p.last_name limit 200) t), '[]'::jsonb);
end $f$;
