-- Create Email: editable username (owner 2026-11-21). The administrator may change the suggested username, and student-office365 uses
-- the submitted address exactly. A person whose earlier attempt failed before the Microsoft user existed (ms_user_id null) keeps a
-- reserved row; until now the claim returned that old address and ignored p_upn. Now the claim takes the new address for such a row when
-- no other SLIT record holds it (any of the three account tables), else answers conflict. A row with a Microsoft user is never re-addressed.
-- Everything else is unchanged from 20261111143429 (student), 20261120183517 (staff) and 20261120193517 (agent).
-- The upn checks allowed only letters, digits and dots before the @; the username rules (and the Business Rule format first_last) also
-- allow hyphen and underscore, so the checks now hold exactly the username rules of the screen and student-office365 (usernameProblem):
-- a-z 0-9 . _ - only, no leading or trailing dot, no two dots in a row, at most 64 characters before the @. Every existing row still passes.

alter table public.student_office365_accounts drop constraint if exists student_office365_accounts_upn_check,
 add constraint student_office365_accounts_upn_check check (upn ~ '^[a-z0-9_-]([a-z0-9._-]{0,62}[a-z0-9_-])?@[a-z0-9.-]+$' and strpos(split_part(upn, '@', 1), '..') = 0);
alter table public.staff_office365_accounts drop constraint if exists staff_office365_accounts_upn_check,
 add constraint staff_office365_accounts_upn_check check (upn ~ '^[a-z0-9_-]([a-z0-9._-]{0,62}[a-z0-9_-])?@[a-z0-9.-]+$' and strpos(split_part(upn, '@', 1), '..') = 0);
alter table public.agent_office365_accounts drop constraint if exists agent_office365_accounts_upn_check,
 add constraint agent_office365_accounts_upn_check check (upn ~ '^[a-z0-9_-]([a-z0-9._-]{0,62}[a-z0-9_-])?@[a-z0-9.-]+$' and strpos(split_part(upn, '@', 1), '..') = 0);

create or replace function public.student_o365_claim(p_student uuid, p_upn text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare a public.student_office365_accounts; v_upn text := lower(btrim(coalesce(p_upn, '')));
begin
 perform public.admin_business_require();
 perform 1 from public.enrollment_students where id = p_student for update;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into a from public.student_office365_accounts where student_id = p_student for update;
 if found then
  if a.status = 'active' then raise exception 'This student already has an Office 365 email' using errcode = '23505'; end if;
  if a.status = 'creating' and a.updated_at > now() - interval '5 minutes' then raise exception 'Creation is already in progress' using errcode = '55P03'; end if;
  if a.ms_user_id is null and v_upn <> '' and v_upn <> a.upn then
   if exists (select 1 from public.student_office365_accounts where upn = v_upn and student_id <> p_student)
    or exists (select 1 from public.staff_office365_accounts where upn = v_upn)
    or exists (select 1 from public.agent_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
   update public.student_office365_accounts set upn = v_upn where student_id = p_student;
  end if;
  update public.student_office365_accounts set status = 'creating', last_error = null, updated_at = now() where student_id = p_student returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.student_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
 insert into public.student_office365_accounts(student_id, upn, created_by) values (p_student, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
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
  if a.ms_user_id is null and v_upn <> '' and v_upn <> a.upn then
   if exists (select 1 from public.staff_office365_accounts where upn = v_upn and staff_id <> p_staff)
    or exists (select 1 from public.student_office365_accounts where upn = v_upn)
    or exists (select 1 from public.agent_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
   update public.staff_office365_accounts set upn = v_upn where staff_id = p_staff;
  end if;
  update public.staff_office365_accounts set status = 'creating', last_error = null, updated_at = now() where staff_id = p_staff returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.staff_office365_accounts where upn = v_upn) or exists (select 1 from public.student_office365_accounts where upn = v_upn) then
  return jsonb_build_object('conflict', true);
 end if;
 insert into public.staff_office365_accounts(staff_id, upn, created_by) values (p_staff, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
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
  if a.ms_user_id is null and v_upn <> '' and v_upn <> a.upn then
   if exists (select 1 from public.agent_office365_accounts where upn = v_upn and agent_id <> p_agent)
    or exists (select 1 from public.staff_office365_accounts where upn = v_upn)
    or exists (select 1 from public.student_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
   update public.agent_office365_accounts set upn = v_upn where agent_id = p_agent;
  end if;
  update public.agent_office365_accounts set status = 'creating', last_error = null, updated_at = now() where agent_id = p_agent returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.agent_office365_accounts where upn = v_upn) or exists (select 1 from public.staff_office365_accounts where upn = v_upn)
  or exists (select 1 from public.student_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
 insert into public.agent_office365_accounts(agent_id, upn, created_by) values (p_agent, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
end $$;
