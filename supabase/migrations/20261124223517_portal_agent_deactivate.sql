-- PORTAL-AGENT-DEACTIVATE (2026-11-24, owner: "super admin of agency can deactivate any agents; SLIT can ... deactivate agents also").
--   public.portal_agent_set_status(p_agent, p_status)  the business admin agent (own business, agents only, never themselves) or a SLIT
--     admin makes an agent Inactive or Active again. Inactive: the agent record, their portal sign-in (membership + profile) and any
--     invitation still waiting are all switched off, the same as the CMS Deactivate (admin_agent_deactivate). Active: the agent record and
--     their sign-in come back (agents_require_agreement still applies); a new invitation is sent separately (Invite).
--   public.portal_member_update  the LIVE definition (2026-11-24) plus one line: the agent record follows the sign-in's status, so an agent
--     switched off in the portal Users list also shows Inactive in the CMS.
-- Additive. Rollback: drop portal_agent_set_status; re-create portal_member_update from its previous definition.
begin;

create or replace function public.portal_agent_set_status(p_agent uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(auth.uid()); g public.agents; v_self boolean; v_slit boolean := false;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_status not in ('Active', 'Inactive') then raise exception 'Status must be Active or Inactive.' using errcode = '22023'; end if;
 select * into g from public.agents where id = p_agent for update;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 v_slit := coalesce((c->>'slit')::boolean, false) or public.portal_is_slit_admin();
 v_self := exists (select 1 from public.portal_profiles p where p.id = g.profile_id and p.auth_user_id = auth.uid())
   or exists (select 1 from auth.users u where u.id = auth.uid() and lower(u.email) = lower(g.email));
 if not v_slit then
  if c->>'role' is distinct from 'agency_admin' or g.business_id is distinct from (c->>'agencyId')::uuid then
   raise exception 'You can only manage agents of your own business.' using errcode = '42501'; end if;
  if v_self then raise exception 'You cannot change your own access.' using errcode = '42501'; end if;
  if g.role = 'agency_admin' then raise exception 'Only SLIT can change another business admin agent.' using errcode = '42501'; end if;
 end if;
 if g.status in ('Onboarding', 'Declined') then raise exception 'This agent is still in onboarding; SLIT manages them until the business is active.' using errcode = '22023'; end if;
 if g.status = p_status then return jsonb_build_object('agentId', g.id, 'status', g.status, 'unchanged', true); end if;
 if p_status = 'Inactive' and g.role = 'agency_admin' and g.profile_id is not null and not exists (
   select 1 from public.agency_memberships o join public.portal_profiles op on op.id = o.user_id
   where o.agency_id = g.business_id and o.role = 'agency_admin' and o.status = 'Active' and op.status = 'Active' and o.user_id <> g.profile_id) then
  raise exception 'This is the last active business admin agent. Add another one first.' using errcode = '23514'; end if;
 update public.agents set status = p_status, status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id;
 if g.profile_id is not null then
  update public.agency_memberships set status = p_status, updated_at = now() where user_id = g.profile_id and agency_id = g.business_id;
  update public.portal_profiles set status = p_status, updated_at = now() where id = g.profile_id and status <> p_status;
 end if;
 if p_status = 'Inactive' and g.email <> '' then
  update public.agency_invitations set status = 'revoked', revoked_at = now() where agency_id = g.business_id and email = g.email and status = 'pending';
 end if;
 perform public.portal_user_audit(auth.uid(), c, case when p_status = 'Inactive' then 'deactivate_user' else 'reactivate_user' end, g.id::text, g.business_id,
  jsonb_build_object('agent', g.full_name, 'email', g.email, 'by', case when v_slit then 'slit' else 'business_admin' end));
 return jsonb_build_object('agentId', g.id, 'status', p_status);
end $$;
revoke all on function public.portal_agent_set_status(uuid, text) from public, anon;
grant execute on function public.portal_agent_set_status(uuid, text) to authenticated;

create or replace function public.portal_member_update(p_actor uuid, p_profile uuid, p_role text, p_status text, p_agency uuid default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare c jsonb := public.portal_actor_context(p_actor); m public.agency_memberships; p public.portal_profiles; v_role text; v_status text; v_agency uuid; v_self boolean;
begin
 select * into m from public.agency_memberships where user_id = p_profile for update;
 if not found then raise exception 'Portal user not found.' using errcode = 'P0002'; end if;
 select * into p from public.portal_profiles where id = p_profile;
 v_self := p.auth_user_id = p_actor;
 if not (c->>'slit')::boolean then
  if c->>'role' is distinct from 'agency_admin' or m.agency_id is distinct from (c->>'agencyId')::uuid then raise exception 'You can only manage users in your own agency.' using errcode = '42501'; end if;
  if p_agency is not null and p_agency <> m.agency_id then raise exception 'Only an organization administrator can move a user between agencies.' using errcode = '42501'; end if;
  if m.role = 'agency_admin' and not v_self then raise exception 'Only an organization administrator can change another agency administrator.' using errcode = '42501'; end if;
 end if;
 if p_role is not null and p_role not in ('agency_admin','agent') then raise exception 'Role must be agency administrator or agent.' using errcode = '22023'; end if;
 if p_status is not null and p_status not in ('Active','Inactive') then raise exception 'Status must be Active or Inactive.' using errcode = '22023'; end if;
 v_role := coalesce(p_role, m.role); v_status := coalesce(p_status, m.status); v_agency := coalesce(p_agency, m.agency_id);
 if m.role = 'agency_admin' and m.status = 'Active' and (v_role <> 'agency_admin' or v_status <> 'Active' or v_agency <> m.agency_id)
  and not exists (select 1 from public.agency_memberships o join public.portal_profiles op on op.id = o.user_id where o.agency_id = m.agency_id and o.role = 'agency_admin' and o.status = 'Active' and op.status = 'Active' and o.user_id <> m.user_id) then
  raise exception 'This is the last active agency administrator. Add another administrator first.' using errcode = '23514';
 end if;
 update public.agency_memberships set role = v_role, status = v_status, agency_id = v_agency, updated_at = now() where user_id = p_profile;
 update public.portal_profiles set status = v_status, updated_at = now() where id = p_profile and status <> v_status;
 -- PORTAL-AGENT-DEACTIVATE: the agent record follows the sign-in (the CMS shows the same status).
 if v_status is distinct from m.status then
  update public.agents set status = v_status, status_changed_at = now(), status_changed_by = p_actor, updated_at = now()
  where profile_id = p_profile and business_id = m.agency_id and status in ('Active', 'Inactive') and status <> v_status;
 end if;
 perform public.portal_user_audit(p_actor, c, case when v_status <> m.status then (case when v_status = 'Inactive' then 'deactivate_user' else 'reactivate_user' end) else 'update_user_role' end, p_profile::text, v_agency,
  jsonb_build_object('role', v_role, 'status', v_status, 'previousRole', m.role, 'previousStatus', m.status));
 return jsonb_build_object('profileId', p_profile, 'role', v_role, 'status', v_status, 'agencyId', v_agency);
end;
$function$;

commit;
