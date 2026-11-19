-- Create Email, round 2 (owner 2026-11-20):
--  * Each person's Office 365 account records its steps, so a partial failure is visible and resumable: account created, licence
--    assigned, groups added (or the error), login email sent (or Microsoft's error code). o365_step(kind, person, step, ok, detail) writes them.
--  * Agents get an account too (Office 365 A1 for faculty at slit.edu.au): agent_office365_accounts + agent_o365_prepare / _claim / _finish.
--  * The prepare functions return the Microsoft user id and the steps; o365_link accepts agents; the person list shows agents' accounts.
-- Never a password. SLIT administrators only (admin_business_require). Additive.
set local lock_timeout = '5s';

alter table public.student_office365_accounts
 add column if not exists account_created_at timestamptz, add column if not exists licence_assigned_at timestamptz,
 add column if not exists groups_added_at timestamptz, add column if not exists groups_error text, add column if not exists welcome_error text;
alter table public.staff_office365_accounts
 add column if not exists account_created_at timestamptz, add column if not exists licence_assigned_at timestamptz,
 add column if not exists groups_added_at timestamptz, add column if not exists groups_error text, add column if not exists welcome_error text;
-- What is known of the existing rows: a Microsoft user id means the account exists.
update public.student_office365_accounts set account_created_at = coalesce(account_created_at, created_at) where ms_user_id is not null and account_created_at is null;
update public.staff_office365_accounts set account_created_at = coalesce(account_created_at, created_at) where ms_user_id is not null and account_created_at is null;
update public.student_office365_accounts set welcome_error = 'unknown_before_2026_11_20' where last_error = 'welcome_email_failed' and welcome_error is null;

create table if not exists public.agent_office365_accounts (
 agent_id uuid primary key references public.agents(id) on delete cascade,
 upn text not null unique check (upn ~ '^[a-z0-9]([a-z0-9.]*[a-z0-9])?@[a-z0-9.-]+$'),
 ms_user_id text,
 status text not null default 'creating' check (status in ('creating','active','failed')),
 licence_sku text,
 last_error text check (last_error is null or last_error ~ '^[a-z_]{1,60}$'),
 welcome_sent_at timestamptz,
 linked boolean not null default false,
 account_created_at timestamptz, licence_assigned_at timestamptz, groups_added_at timestamptz, groups_error text, welcome_error text,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.agent_office365_accounts enable row level security;
revoke all on public.agent_office365_accounts from anon, authenticated;

/** One account row as the screens and the Edge Function read it. */
create or replace function public.o365_account_json(p_upn text, p_status text, p_last_error text, p_welcome timestamptz, p_created timestamptz, p_ms text,
 p_linked boolean, p_sku text, p_acc timestamptz, p_lic timestamptz, p_grp timestamptz, p_grp_err text, p_wel_err text)
returns jsonb language sql immutable set search_path = pg_catalog as $$
 select jsonb_build_object('email', p_upn, 'status', p_status, 'lastError', p_last_error, 'welcomeSentAt', p_welcome, 'createdAt', p_created,
  'hasMicrosoftUser', p_ms is not null, 'msUserId', p_ms, 'linked', coalesce(p_linked, false), 'licenceSku', p_sku,
  'steps', jsonb_build_object('accountCreatedAt', p_acc, 'licenceAssignedAt', p_lic, 'groupsAddedAt', p_grp, 'groupsError', p_grp_err, 'welcomeSentAt', p_welcome, 'welcomeError', p_wel_err))
$$;
revoke all on function public.o365_account_json(text, text, text, timestamptz, timestamptz, text, boolean, text, timestamptz, timestamptz, timestamptz, text, text) from public, anon;

create or replace function public.student_o365_prepare(p_student uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare s public.enrollment_students; a public.student_office365_accounts;
begin
 perform public.admin_business_require();
 select * into s from public.enrollment_students where id = p_student;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into a from public.student_office365_accounts where student_id = p_student;
 return jsonb_build_object('studentId', s.id, 'fullName', s.full_name, 'personalEmail', s.email, 'studentStatus', s.status,
  'account', case when a.student_id is null then null else public.o365_account_json(a.upn, a.status, a.last_error, a.welcome_sent_at, a.created_at, a.ms_user_id,
   a.linked, a.licence_sku, a.account_created_at, a.licence_assigned_at, a.groups_added_at, a.groups_error, a.welcome_error) end);
end $$;

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
  'account', case when a.staff_id is null then null else public.o365_account_json(a.upn, a.status, a.last_error, a.welcome_sent_at, a.created_at, a.ms_user_id,
   a.linked, a.licence_sku, a.account_created_at, a.licence_assigned_at, a.groups_added_at, a.groups_error, a.welcome_error) end);
end $$;

create or replace function public.agent_o365_prepare(p_agent uuid)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public
as $$
declare g public.agents; a public.agent_office365_accounts;
begin
 perform public.admin_business_require();
 select * into g from public.agents where id = p_agent;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 select * into a from public.agent_office365_accounts where agent_id = p_agent;
 return jsonb_build_object('agentId', g.id, 'fullName', g.full_name, 'recordEmail', g.email, 'status', g.status,
  'account', case when a.agent_id is null then null else public.o365_account_json(a.upn, a.status, a.last_error, a.welcome_sent_at, a.created_at, a.ms_user_id,
   a.linked, a.licence_sku, a.account_created_at, a.licence_assigned_at, a.groups_added_at, a.groups_error, a.welcome_error) end);
end $$;

create or replace function public.agent_o365_claim(p_agent uuid, p_upn text)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public
as $$
declare a public.agent_office365_accounts; v_upn text := lower(btrim(coalesce(p_upn, '')));
begin
 perform public.admin_business_require();
 perform 1 from public.agents where id = p_agent for update;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 select * into a from public.agent_office365_accounts where agent_id = p_agent for update;
 if found then
  if a.status = 'active' then raise exception 'This agent already has an Office 365 email' using errcode = '23505'; end if;
  if a.status = 'creating' and a.updated_at > now() - interval '5 minutes' then raise exception 'Creation is already in progress' using errcode = '55P03'; end if;
  update public.agent_office365_accounts set status = 'creating', last_error = null, updated_at = now() where agent_id = p_agent returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.agent_office365_accounts where upn = v_upn) or exists (select 1 from public.staff_office365_accounts where upn = v_upn)
  or exists (select 1 from public.student_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
 insert into public.agent_office365_accounts(agent_id, upn, created_by) values (p_agent, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
end $$;

create or replace function public.agent_o365_finish(p_agent uuid, p_ms_user text, p_ok boolean, p_error text, p_sku text, p_welcome boolean)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public
as $$
declare a public.agent_office365_accounts;
begin
 perform public.admin_business_require();
 update public.agent_office365_accounts set
  ms_user_id = coalesce(nullif(p_ms_user, ''), ms_user_id), status = case when p_ok then 'active' else 'failed' end,
  last_error = case when p_ok then null else p_error end, licence_sku = coalesce(nullif(p_sku, ''), licence_sku),
  welcome_sent_at = case when p_welcome then now() else welcome_sent_at end, updated_at = now()
 where agent_id = p_agent and status = 'creating' returning * into a;
 if not found then raise exception 'No creation in progress for this agent' using errcode = 'P0002'; end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', case when p_ok then 'agent_office365_created' else 'agent_office365_failed' end, 'agent', p_agent::text, null,
   jsonb_build_object('email', a.upn, 'error', a.last_error, 'welcomeSent', p_welcome));
 return jsonb_build_object('email', a.upn, 'status', a.status, 'lastError', a.last_error, 'welcomeSentAt', a.welcome_sent_at);
end $$;

-- One step of an account: account / licence / groups / welcome, ok or failed with a short code (Microsoft's error code, never text).
create or replace function public.o365_step(p_kind text, p_person uuid, p_step text, p_ok boolean, p_detail text default null)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public
as $$
declare v_table text; v_key text; v_set text; v_detail text := nullif(btrim(coalesce(p_detail, '')), ''); v_n integer;
begin
 perform public.admin_business_require();
 if p_kind not in ('student', 'staff', 'agent') or p_step not in ('account', 'licence', 'groups', 'welcome') then raise exception 'Unknown step' using errcode = '22023'; end if;
 if v_detail is not null and v_detail !~ '^[A-Za-z0-9_.:,-]{1,160}$' then raise exception 'Invalid step detail' using errcode = '22023'; end if;
 v_table := p_kind || '_office365_accounts'; v_key := case p_kind when 'student' then 'student_id' when 'staff' then 'staff_id' else 'agent_id' end;
 v_set := case
  when p_step = 'account' and p_ok then 'account_created_at = coalesce(account_created_at, now())'
  when p_step = 'licence' and p_ok then 'licence_assigned_at = coalesce(licence_assigned_at, now()), licence_sku = coalesce($2, licence_sku)'
  when p_step = 'groups' and p_ok then 'groups_added_at = now(), groups_error = $2'
  when p_step = 'groups' then 'groups_error = coalesce($2, ''failed'')'
  when p_step = 'welcome' and p_ok then 'welcome_sent_at = now(), welcome_error = null, status = ''active'', last_error = null'
  when p_step = 'welcome' then 'welcome_error = coalesce($2, ''failed''), status = case when status = ''active'' then status else ''failed'' end, last_error = case when status = ''active'' then last_error else ''welcome_email_failed'' end'
  else 'updated_at = updated_at' end;
 execute format('update public.%I set %s, updated_at = now() where %I = $1', v_table, v_set, v_key) using p_person, v_detail;
 get diagnostics v_n = row_count;
 if v_n = 0 then raise exception 'No Office 365 account for this person' using errcode = 'P0002'; end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', 'office365_' || p_step || case when p_ok then '_ok' else '_failed' end, p_kind, p_person::text, null,
   jsonb_build_object('detail', v_detail));
 return jsonb_build_object('ok', true);
end $$;

create or replace function public.o365_link(p_kind text, p_person uuid, p_upn text, p_ms_user text)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare v_upn text := lower(btrim(coalesce(p_upn, ''))); v_table text; v_key text; v_n integer;
begin
 perform public.admin_business_require();
 if p_kind not in ('student', 'staff', 'agent') or v_upn !~ '^[a-z0-9]([a-z0-9.]*[a-z0-9])?@[a-z0-9.-]+$' or coalesce(p_ms_user, '') !~ '^[0-9a-f-]{36}$' then
  raise exception 'Choose the account to link' using errcode = '22023';
 end if;
 if p_kind = 'student' then perform 1 from public.enrollment_students where id = p_person for update;
 elsif p_kind = 'staff' then perform 1 from hr.staff_profiles where id = p_person for update;
 else perform 1 from public.agents where id = p_person for update; end if;
 if not found then raise exception 'Person not found' using errcode = 'P0002'; end if;
 v_table := p_kind || '_office365_accounts'; v_key := case p_kind when 'student' then 'student_id' when 'staff' then 'staff_id' else 'agent_id' end;
 if exists (select 1 from public.student_office365_accounts where upn = v_upn and not (p_kind = 'student' and student_id = p_person))
  or exists (select 1 from public.staff_office365_accounts where upn = v_upn and not (p_kind = 'staff' and staff_id = p_person))
  or exists (select 1 from public.agent_office365_accounts where upn = v_upn and not (p_kind = 'agent' and agent_id = p_person)) then
  raise exception 'This address is linked to another record' using errcode = '23505'; end if;
 execute format('select count(*) from public.%I where %I = $1 and status = ''active'' and upn <> $2', v_table, v_key) into v_n using p_person, v_upn;
 if v_n > 0 then raise exception 'This person already has another Office 365 email' using errcode = '22023'; end if;
 execute format('insert into public.%I(%I, upn, ms_user_id, status, linked, account_created_at, created_by) values ($1, $2, $3, ''active'', true, now(), auth.uid())
  on conflict (%I) do update set upn = excluded.upn, ms_user_id = excluded.ms_user_id, status = ''active'', linked = true, last_error = null, updated_at = now()', v_table, v_key, v_key)
  using p_person, v_upn, p_ms_user;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', 'office365_linked', p_kind, p_person::text, null, jsonb_build_object('email', v_upn));
 return jsonb_build_object('linked', true, 'email', v_upn);
end $$;

revoke all on function public.agent_o365_prepare(uuid), public.agent_o365_claim(uuid, text), public.agent_o365_finish(uuid, text, boolean, text, text, boolean),
 public.o365_step(text, uuid, text, boolean, text), public.o365_link(text, uuid, text, text) from public, anon;
grant execute on function public.agent_o365_prepare(uuid), public.agent_o365_claim(uuid, text), public.agent_o365_finish(uuid, text, boolean, text, text, boolean),
 public.o365_step(text, uuid, text, boolean, text), public.o365_link(text, uuid, text, text) to authenticated;

-- The person list: agents' created or linked accounts.
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
    'mailbox', case when a.ms_user_id is not null or a.status = 'active' then a.upn end, 'mailboxStatus', a.status) x
   from public.enrollment_students s left join public.student_office365_accounts a on a.student_id = s.id
   where lower(coalesce(s.full_name, '') || ' ' || coalesce(s.email, '')) like q
   order by s.full_name limit 200) t), '[]'::jsonb);
 elsif p_type = 'agent' then
  return coalesce((select jsonb_agg(x order by x->>'name') from (
   select jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'status', g.status,
    'mailbox', case when a.ms_user_id is not null or a.status = 'active' then a.upn when lower(g.email) like '%@slit.edu.au' then g.email end, 'mailboxStatus', a.status) x
   from public.agents g left join public.agent_office365_accounts a on a.agent_id = g.id
   where lower(coalesce(g.full_name, '') || ' ' || coalesce(g.email, '')) like q
   order by g.full_name limit 200) t), '[]'::jsonb);
 end if;
 return coalesce((select jsonb_agg(x order by x->>'name') from (
  select jsonb_build_object('id', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'status', p.status,
   'mailbox', case when a.ms_user_id is not null or a.status = 'active' then a.upn when lower(p.email) like '%@slit.edu.au' then p.email end, 'mailboxStatus', a.status) x
  from hr.staff_profiles p left join public.staff_office365_accounts a on a.staff_id = p.id
  where (p_type = 'employee' or exists (select 1 from hr.staff_roles r where r.profile_id = p.id and r.role = 'trainer' and r.revoked_at is null))
   and lower(concat_ws(' ', p.first_name, p.last_name, p.email)) like q
  order by p.first_name, p.last_name limit 200) t), '[]'::jsonb);
end $f$;

-- The Edge Function error check knows every function (intake-groups arrived with #128 after the list was written).
create or replace function public.edge_function_names()
 returns text[] language sql immutable as $$
 select array['address-search', 'admin-view-as', 'calendly-admin', 'cms-admin-users', 'cricos-lookup', 'document-signing', 'email-sender', 'guest-documents',
  'holiday-sync', 'intake-groups', 'integrations-admin', 'integrations-credentials', 'integrations-refresh', 'integrations-webhook', 'notification-delivery', 'omara-abr-enrich',
  'omara-ingest', 'payments', 'portal-admin-users', 'portal-application-delete', 'portal-document-delete', 'portal-document-extract', 'portal-invite-activate',
  'portal-self-register', 'public-assistant', 'public-assistant-index', 'staff-admin', 'staff-onboarding', 'staff-register', 'student-office365',
  'support-ticket-mail', 'tga-course-import', 'validated-document-upload', 'xero-push']::text[]
$$;
