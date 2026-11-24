-- AGENT-DELETE (2026-11-24, owner: "inside agent we need functionality to delete agent too"): SLIT admins can delete an agent
-- from Agencies > Agents > {name}.
--   * The business's point of contact (agency_onboarding.agent_id) is never deleted here: delete or re-point the business instead.
--   * An agent with students must hand them to another agent of the same business (p_move_to): the students move, and the
--     applications assigned to the deleted agent's login move to the new agent's login (or become unassigned if it has none).
--   * The agent's sign-in to that business ends (membership removed, pending invitations revoked). Their portal profile stays,
--     because applications, documents and reviews they created still name it. The agent's Microsoft 365 link row goes with the
--     agent (on delete cascade); the Microsoft 365 account itself is not touched.
--   * Applications, students, signed documents and history are never deleted. The action is written to the business audit log.
begin;

create or replace function public.admin_agent_delete_preview(p_agent uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare g public.agents;
begin
 perform public.admin_business_require();
 select * into g from public.agents where id = p_agent;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 return jsonb_build_object(
  'agentId', g.id, 'name', g.full_name,
  'students', (select count(*) from public.enrollment_students s where s.agent_id = g.id),
  'assignedApplications', case when g.profile_id is null then 0
    else (select count(*) from public.enrollment_applications e where e.assigned_agent_id = g.profile_id and e.agency_id = g.business_id) end,
  'pointOfContact', exists (select 1 from public.agency_onboarding o where o.agent_id = g.id),
  'moveTo', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.full_name, 'status', a.status, 'role', a.role) order by lower(a.full_name))
     from public.agents a where a.business_id = g.business_id and a.id <> g.id and a.status not in ('Declined')), '[]'::jsonb));
end $function$;
revoke all on function public.admin_agent_delete_preview(uuid) from public, anon;
grant execute on function public.admin_agent_delete_preview(uuid) to authenticated;

create or replace function public.admin_agent_delete(p_agent uuid, p_move_to uuid default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare g public.agents; t public.agents; v_students integer; v_apps integer := 0;
begin
 perform public.admin_business_require();
 select * into g from public.agents where id = p_agent for update;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 if exists (select 1 from public.agency_onboarding o where o.agent_id = g.id) then
  raise exception '% is the point of contact of their business. Delete the business instead, or make someone else its point of contact first.', g.full_name
   using errcode = '23514'; end if;

 select count(*) into v_students from public.enrollment_students s where s.agent_id = g.id;
 if p_move_to is not null then
  select * into t from public.agents where id = p_move_to for update;
  if not found or t.id = g.id or t.business_id is distinct from g.business_id then
   raise exception 'Choose another agent of the same business to take over the students.' using errcode = '22023'; end if;
 elsif v_students > 0 then
  raise exception '% has % student%. Choose another agent of the same business to take them over.', g.full_name, v_students, case when v_students = 1 then '' else 's' end
   using errcode = '23514';
 end if;

 if v_students > 0 then
  update public.enrollment_students set agent_id = t.id, updated_at = now() where agent_id = g.id;
 end if;
 if g.profile_id is not null then
  update public.enrollment_applications set assigned_agent_id = t.profile_id, updated_at = now()
   where assigned_agent_id = g.profile_id and agency_id = g.business_id;
  get diagnostics v_apps = row_count;
  delete from public.agency_memberships where user_id = g.profile_id and agency_id = g.business_id and role in ('agent', 'agency_admin');
 end if;
 if coalesce(g.email, '') <> '' then
  update public.agency_invitations set status = 'revoked', revoked_at = now()
   where agency_id = g.business_id and lower(email) = lower(g.email) and status = 'pending' and role in ('agent', 'agency_admin');
 end if;
 delete from public.agents where id = g.id;

 perform public.admin_business_audit('agent_deleted', g.business_id, g.business_id, jsonb_build_object(
  'agent', g.full_name, 'email', g.email, 'role', g.role, 'studentsMoved', v_students, 'applicationsMoved', v_apps,
  'movedTo', case when t.id is null then null else t.full_name end));
 return jsonb_build_object('deleted', g.id, 'name', g.full_name, 'studentsMoved', v_students, 'applicationsMoved', v_apps,
  'movedTo', case when t.id is null then null else t.full_name end, 'businessId', g.business_id);
end $function$;
revoke all on function public.admin_agent_delete(uuid, uuid) from public, anon;
grant execute on function public.admin_agent_delete(uuid, uuid) to authenticated;

commit;
