-- STUDENT-PORTAL-INVITE + STUDENT-PASSWORD (2026-11-24, owner: a student sent the finish-application link must create a password; agents,
-- business admin agents and SLIT admins send a student a portal invitation by hand, the student creates their password and signs in).
--   public.portal_my_password_set()              true when the signed-in account already has a password (the finish-application page
--                                                asks for one first when it has none: the link signs the student in by email code only)
--   public.portal_student_is_mine(actor, student) the actor's portal profile is the student's agent (student record) or is assigned to one
--                                                of the student's applications in the actor's business
--   public.portal_student_portal_state(student)  sign-in state for the screens: active (password created) / no_password / invited /
--                                                expired / disabled / none, with the invitation id; SLIT, the business's agency admin, or
--                                                the student's own agent only
--   public.portal_invitation_create / _resend     the LIVE definitions (20261124213517) with one change each: the student's own agent may
--                                                invite / resend that student's portal invitation (role student only); an agency admin may
--                                                resend any student invitation of their business
-- portal-admin-users lets an agent call invite (role student) and resend; the database decides the rest.
-- Additive. Rollback: re-apply 20261124213517's two functions; drop the three new functions.
begin;

create or replace function public.portal_my_password_set() returns boolean
language sql stable security definer set search_path = public, auth as $$
 select coalesce((select coalesce(u.encrypted_password, '') <> '' from auth.users u where u.id = auth.uid()), false);
$$;
revoke all on function public.portal_my_password_set() from public, anon;
grant execute on function public.portal_my_password_set() to authenticated;

create or replace function public.portal_student_is_mine(p_actor uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
 with me as (select p.id from public.portal_profiles p where p.auth_user_id = p_actor and p.status = 'Active')
 select p_student is not null and (
  exists (select 1 from public.enrollment_students s join public.agents g on g.id = s.agent_id join me on me.id = g.profile_id
    where s.id = p_student and g.status = 'Active' and g.business_id = s.agency_id)
  or exists (select 1 from public.enrollment_applications a join me on me.id = a.assigned_agent_id
    join public.enrollment_students s on s.id = a.student_id where a.student_id = p_student and a.agency_id = s.agency_id));
$$;
-- Internal: called only from the security-definer functions below, never by a signed-in user directly.
revoke all on function public.portal_student_is_mine(uuid, uuid) from public, anon, authenticated;

create or replace function public.portal_student_portal_state(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare c jsonb := public.portal_actor_context(auth.uid()); s public.enrollment_students; st jsonb; v_pw boolean := false; v_status text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into s from public.enrollment_students where id = p_student;
 if not found then raise exception 'Student not found.' using errcode = 'P0002'; end if;
 if not (coalesce((c->>'slit')::boolean, false)
   or (c->>'role' = 'agency_admin' and s.agency_id = (c->>'agencyId')::uuid)
   or (c->>'role' = 'agent' and s.agency_id = (c->>'agencyId')::uuid and public.portal_student_is_mine(auth.uid(), s.id))) then
  raise exception 'You cannot see this student''s sign-in.' using errcode = '42501'; end if;
 st := public.student_login_state(s.id);
 if st->>'profileId' is not null then
  select coalesce(u.encrypted_password, '') <> '' into v_pw from public.portal_profiles p join auth.users u on u.id = p.auth_user_id where p.id = (st->>'profileId')::uuid;
 end if;
 v_status := case when s.status = 'Inactive' then 'disabled'
   when st->>'status' = 'active' then case when coalesce(v_pw, false) then 'active' else 'no_password' end
   when st->>'status' = 'none' then 'none' else st->>'status' end;
 return jsonb_build_object('status', v_status, 'invitationId', st->>'invitationId', 'invitedAt', st->>'invitedAt', 'expiresAt', st->>'expiresAt',
  'email', coalesce(nullif(s.email, ''), st->>'email'));
end $$;
revoke all on function public.portal_student_portal_state(uuid) from public, anon;
grant execute on function public.portal_student_portal_state(uuid) to authenticated;

create or replace function public.portal_invitation_create(p_actor uuid, p_agency uuid, p_email text, p_name text, p_role text, p_student uuid default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare c jsonb := public.portal_actor_context(p_actor); v_agency uuid; v_email text := lower(btrim(coalesce(p_email, ''))); v_name text := btrim(coalesce(p_name, ''));
 inv public.agency_invitations; s public.enrollment_students;
begin
 -- STUDENT-PORTAL-INVITE: an agent may invite a student of their own (their student record or an application assigned to them).
 if not (c->>'slit')::boolean and c->>'role' is distinct from 'agency_admin'
   and not (c->>'role' = 'agent' and p_role = 'student' and public.portal_student_is_mine(p_actor, p_student)) then
  raise exception 'Only organization or agency administrators, or the student''s own agent, can invite users.' using errcode = '42501'; end if;
 if p_role in ('slit_admin','org_admin','admin','Admin') then raise exception 'Organization administrators cannot be invited to an agency.' using errcode = '42501'; end if;
 if p_role is null or p_role not in ('agency_admin','agent','student') then raise exception 'Role must be agency administrator, agent or student.' using errcode = '22023'; end if;
 if (p_role = 'student') <> (p_student is not null) then raise exception 'A student invitation names the student; other invitations do not.' using errcode = '22023'; end if;
 if p_role = 'student' then
  select * into s from public.enrollment_students where id = p_student;
  if not found then raise exception 'Student not found.' using errcode = 'P0002'; end if;
  if s.status <> 'Active' then raise exception 'This student is disabled. Enable them before inviting them to sign in.' using errcode = '22023'; end if;
  if v_email <> '' and v_email <> lower(btrim(coalesce(s.email, ''))) then raise exception 'The invitation goes to the student''s email on record. Edit the student first to change it.' using errcode = '22023'; end if;
  v_email := lower(btrim(coalesce(s.email, '')));
  if v_email = '' then raise exception 'Add the student''s email before inviting them to sign in.' using errcode = '22023'; end if;
  v_name := btrim(coalesce(s.full_name, ''));
  if char_length(v_name) < 2 then v_name := v_email; end if;
  if exists (select 1 from public.agency_memberships m where m.student_id = s.id and m.status = 'Active') then raise exception 'This student already has a sign-in.' using errcode = '23505'; end if;
 end if;
 if v_name = '' then raise exception 'Full name is required.' using errcode = '22023'; end if;
 if v_name ~ '[[:cntrl:]]' then raise exception 'The name contains characters that are not allowed.' using errcode = '22023'; end if;
 if char_length(v_name) not between 2 and 100 then raise exception 'The name must be 2 to 100 characters.' using errcode = '22023'; end if;
 if (c->>'slit')::boolean then
  v_agency := coalesce(p_agency, s.agency_id);
  if v_agency is null then raise exception 'An agency must be selected.' using errcode = '22023'; end if;
 else
  v_agency := (c->>'agencyId')::uuid;
  if p_agency is not null and p_agency <> v_agency then raise exception 'You can only invite users into your own agency.' using errcode = '42501'; end if;
 end if;
 if s.id is not null and s.agency_id <> v_agency then raise exception 'This student belongs to another business.' using errcode = '42501'; end if;
 if not exists (select 1 from public.agencies a where a.id = v_agency and public.agency_effective_status(a) = 'Active') then
  raise exception '%', coalesce((select public.agency_gate_reason(a) from public.agencies a where a.id = v_agency), 'The agency is not active.') using errcode = '22023', hint = 'business_not_operational';
 end if;
 if v_email ~ '[[:cntrl:]]' or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address (254 characters at most).' using errcode = '22023'; end if;
 if p_role in ('agent', 'agency_admin') and exists (select 1 from public.agencies a where a.id = v_agency and coalesce(a.is_direct, false)) and v_email !~ '@slit\.edu\.au$' then
  raise exception 'Only @slit.edu.au accounts can be agents on SLIT''s direct business.' using errcode = '22023', hint = 'direct_business_domain';
 end if;
 if exists (select 1 from public.cms_users u where lower(u.email) = v_email and u.role = 'Admin') then raise exception 'Organization administrators cannot be invited to an agency.' using errcode = '42501'; end if;
 if exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = v_email and m.status = 'Active' and p.status = 'Active') then
  raise exception 'This email already belongs to an active portal user.' using errcode = '23505', hint = 'email_taken';
 end if;
 select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending';
 if found then
  if inv.expires_at < now() then raise exception 'An earlier invitation for this email has expired. Resend it instead of creating a new one.' using errcode = '23505', hint = 'email_taken'; end if;
  raise exception 'This email has already been invited. Resend or revoke the pending invitation.' using errcode = '23505', hint = 'email_taken';
 end if;
 if p_role in ('agent', 'agency_admin') then
  -- PORTAL-AGENT-INVITES: an Inactive / Declined agent is still refused; one still at Onboarding in this (already operational) business
  -- is made Active by the invitation, so the business admin agent can bring their own agents in.
  if exists (select 1 from public.agents g where g.business_id = v_agency and g.email = v_email and g.status in ('Inactive', 'Declined')) then
   raise exception 'This agent is inactive. A SLIT administrator makes them active again before they can be invited.' using errcode = '22023', hint = 'agent_not_active';
  end if;
  update public.agents set status = 'Active', status_changed_at = now(), status_changed_by = p_actor, updated_at = now()
  where business_id = v_agency and email = v_email and status = 'Onboarding';
 end if;
 insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name, student_id)
 values (v_agency, v_email, v_name, p_role, p_actor, coalesce(c->>'name', ''), s.id) returning * into inv;
 perform public.portal_user_audit(p_actor, c, 'invite_user', inv.id::text, v_agency, jsonb_build_object('email', v_email, 'role', p_role, 'student', s.id));
 return jsonb_build_object('invitationId', inv.id, 'agencyId', v_agency, 'email', v_email, 'name', inv.full_name, 'role', p_role, 'expiresAt', inv.expires_at, 'studentId', s.id);
end;
$function$;

create or replace function public.portal_invitation_resend(p_actor uuid, p_invitation uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare c jsonb := public.portal_actor_context(p_actor); inv public.agency_invitations;
begin
 select * into inv from public.agency_invitations where id = p_invitation for update;
 if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
 if not ((c->>'slit')::boolean or (c->>'role' = 'agency_admin' and inv.agency_id = (c->>'agencyId')::uuid
   and (inv.invited_by = p_actor or inv.role in ('agent', 'agency_admin', 'student')))
   or (c->>'role' = 'agent' and inv.role = 'student' and inv.agency_id = (c->>'agencyId')::uuid
     and (inv.invited_by = p_actor or public.portal_student_is_mine(p_actor, inv.student_id)))) then
  raise exception 'Only the inviting agency administrator, the student''s own agent or an organization administrator can resend this invitation.' using errcode = '42501';
 end if;
 if inv.status <> 'pending' then raise exception 'Only pending invitations can be resent.' using errcode = '22023'; end if;
 if inv.role in ('agent', 'agency_admin') and exists (select 1 from public.agents g where g.business_id = inv.agency_id and g.email = inv.email and g.status <> 'Active') then
  raise exception 'This agent is not active: they get their sign-in invitation once an administrator activates them.' using errcode = '22023', hint = 'agent_not_active';
 end if;
 update public.agency_invitations set expires_at = now() + make_interval(days => greatest(1, public.rule_int('agents.invitation_valid_days', 7))), sent_count = sent_count + 1, last_sent_at = now()
 where id = inv.id returning * into inv;
 perform public.portal_user_audit(p_actor, c, 'resend_invitation', inv.id::text, inv.agency_id, jsonb_build_object('email', inv.email));
 return jsonb_build_object('invitationId', inv.id, 'agencyId', inv.agency_id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at);
end;
$function$;

commit;
