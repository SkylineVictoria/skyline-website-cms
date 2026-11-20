-- Email Management > Account directory (owner 2026-11-21). The Microsoft 365 users are read live by student-office365 (directory); this
-- migration gives it (a) who is who in Skyline (o365_directory_people), (b) the record of a licence change on the Skyline side
-- (o365_licence_record: the person's account row keeps its licence) and (c) the audit log of every licence assign / remove
-- (email_account_audit, read by Email Management > Audit Logs). SLIT administrators only (admin_business_require).

create table if not exists public.email_account_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text,
  action text not null check (action in ('licence_assigned', 'licence_removed')),
  account_upn text not null,
  ms_user_id text,
  sku text,
  licence_name text,
  result text not null check (result in ('ok', 'refused', 'failed')),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists email_account_audit_at_idx on public.email_account_audit (at desc);
alter table public.email_account_audit enable row level security;
revoke all on public.email_account_audit from public, anon, authenticated;

/** One licence action (who: the signed-in administrator; when: now), written by student-office365 for every account it touched. */
create or replace function public.email_account_audit_add(p_action text, p_upn text, p_ms_user text, p_sku text, p_licence_name text, p_result text, p_detail jsonb)
 returns bigint language plpgsql security definer set search_path to pg_catalog, public
as $$
declare v_id bigint;
begin
 perform public.admin_business_require();
 insert into public.email_account_audit(actor, actor_name, action, account_upn, ms_user_id, sku, licence_name, result, detail)
 values (auth.uid(), (select u.name from public.cms_users u where u.auth_user_id = auth.uid() limit 1), p_action, lower(btrim(p_upn)), nullif(btrim(coalesce(p_ms_user, '')), ''),
   nullif(btrim(coalesce(p_sku, '')), ''), nullif(btrim(coalesce(p_licence_name, '')), ''), p_result, coalesce(p_detail, '{}'::jsonb))
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.email_account_audit_add(text, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.email_account_audit_add(text, text, text, text, text, text, jsonb) to authenticated;

create or replace function public.email_account_audit_list(p_limit integer default 200)
 returns jsonb language plpgsql stable security definer set search_path to pg_catalog, public
as $$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor', coalesce(a.actor_name, 'Administrator'), 'action', a.action, 'account', a.account_upn,
   'sku', a.sku, 'licence', a.licence_name, 'result', a.result, 'detail', a.detail) order by a.at desc)
  from (select * from public.email_account_audit order by at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) a), '[]'::jsonb);
end $$;
revoke all on function public.email_account_audit_list(integer) from public, anon;
grant execute on function public.email_account_audit_list(integer) to authenticated;

/**
 * Skyline people by email address, for the Account directory: the Microsoft 365 account each record holds (its UPN, strongest), then the
 * email on the record. kind: student / employee / trainer / agent; source: account / record.
 */
create or replace function public.o365_directory_people()
 returns jsonb language plpgsql stable security definer set search_path to pg_catalog, public, hr
as $$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(x) from (
  select lower(a.upn) as email, 'student' as kind, s.id, s.full_name as name, 'account' as source from public.student_office365_accounts a join public.enrollment_students s on s.id = a.student_id
  union all
  select lower(a.upn), case when exists (select 1 from hr.staff_roles r where r.profile_id = p.id and r.role = 'trainer' and r.revoked_at is null) then 'trainer' else 'employee' end, p.id,
   btrim(concat_ws(' ', p.first_name, p.last_name)), 'account' from public.staff_office365_accounts a join hr.staff_profiles p on p.id = a.staff_id
  union all
  select lower(a.upn), 'agent', g.id, g.full_name, 'account' from public.agent_office365_accounts a join public.agents g on g.id = a.agent_id
  union all
  select lower(btrim(s.email)), 'student', s.id, s.full_name, 'record' from public.enrollment_students s where btrim(coalesce(s.email, '')) <> ''
  union all
  select lower(btrim(p.email)), case when exists (select 1 from hr.staff_roles r where r.profile_id = p.id and r.role = 'trainer' and r.revoked_at is null) then 'trainer' else 'employee' end,
   p.id, btrim(concat_ws(' ', p.first_name, p.last_name)), 'record' from hr.staff_profiles p where btrim(coalesce(p.email, '')) <> ''
  union all
  select lower(btrim(g.email)), 'agent', g.id, g.full_name, 'record' from public.agents g where btrim(coalesce(g.email, '')) <> ''
 ) x), '[]'::jsonb);
end $$;
revoke all on function public.o365_directory_people() from public, anon;
grant execute on function public.o365_directory_people() to authenticated;

/** A licence assigned (p_sku) or removed (null) in Microsoft 365: the Skyline account row holding that UPN keeps it. Rows changed. */
create or replace function public.o365_licence_record(p_upn text, p_sku text)
 returns integer language plpgsql security definer set search_path to pg_catalog, public
as $$
declare v_upn text := lower(btrim(coalesce(p_upn, ''))); v_sku text := nullif(btrim(coalesce(p_sku, '')), ''); n int := 0; k int;
begin
 perform public.admin_business_require();
 update public.student_office365_accounts set licence_sku = v_sku, licence_assigned_at = case when v_sku is null then null else now() end, updated_at = now() where lower(upn) = v_upn;
 get diagnostics k = row_count; n := n + k;
 update public.staff_office365_accounts set licence_sku = v_sku, licence_assigned_at = case when v_sku is null then null else now() end, updated_at = now() where lower(upn) = v_upn;
 get diagnostics k = row_count; n := n + k;
 update public.agent_office365_accounts set licence_sku = v_sku, licence_assigned_at = case when v_sku is null then null else now() end, updated_at = now() where lower(upn) = v_upn;
 get diagnostics k = row_count; n := n + k;
 return n;
end $$;
revoke all on function public.o365_licence_record(text, text) from public, anon;
grant execute on function public.o365_licence_record(text, text) to authenticated;
