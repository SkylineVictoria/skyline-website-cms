-- Email Management > Create Email (owner 2026-11-20): the "Existing person" list. One read-only function for SLIT administrators
-- (admin_business_require): students (CRM, with their Office 365 account if any), employees (HR staff), trainers (HR staff with an active
-- trainer role) and agents. Each row: id, name, email, status, and the Microsoft 365 address already held (a student's created account,
-- or a staff / agent email on the SLIT domain), so the screen can say who already has one. Nothing is created here.
set local lock_timeout = '5s';

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
   'mailbox', case when lower(p.email) like '%@slit.edu.au' then p.email end, 'mailboxStatus', null) x
  from hr.staff_profiles p
  where (p_type = 'employee' or exists (select 1 from hr.staff_roles r where r.profile_id = p.id and r.role = 'trainer' and r.revoked_at is null))
   and lower(concat_ws(' ', p.first_name, p.last_name, p.email)) like q
  order by p.first_name, p.last_name limit 200) t), '[]'::jsonb);
end $f$;
revoke all on function public.email_mgmt_people(text, text) from public, anon;
grant execute on function public.email_mgmt_people(text, text) to authenticated;
