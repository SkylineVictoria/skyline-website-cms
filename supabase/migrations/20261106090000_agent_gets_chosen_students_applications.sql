-- A student who signed up by themselves and picked an agent (migration 20261105160000) gets an application with no
-- assigned agent when that agent has no sign-in yet, and nothing assigned it later, so the agent's Applications table
-- never showed it (an agent sees only applications assigned to them). Now, when an agent record is linked to a sign-in,
-- that agent's students' unassigned applications in the same business are assigned to them; existing ones are backfilled.
-- Institution (tenant) applications are left alone. Requires 20261105080000 and 20261105160000.
-- Rollback (manual): drop trigger agents_claim_student_applications on public.agents;
-- drop function public.agent_claim_student_applications().
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.agent_claim_student_applications() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
 if new.profile_id is null or new.role <> 'agent' or new.status <> 'Active' then return new; end if;
 if tg_op = 'UPDATE' and new.profile_id is not distinct from old.profile_id and new.status is not distinct from old.status
  and new.role is not distinct from old.role then return new; end if;
 update public.enrollment_applications e set assigned_agent_id = new.profile_id
  from public.enrollment_students s
  where s.id = e.student_id and s.agent_id = new.id and e.agency_id = new.business_id
   and e.assigned_agent_id is null and e.tenant_id is null;
 return new;
end $fn$;
revoke all on function public.agent_claim_student_applications() from public, anon, authenticated;

drop trigger if exists agents_claim_student_applications on public.agents;
create trigger agents_claim_student_applications after insert or update of profile_id, status, role on public.agents
 for each row execute function public.agent_claim_student_applications();

-- Backfill: applications already waiting for an agent who has since signed in.
update public.enrollment_applications e set assigned_agent_id = g.profile_id
 from public.enrollment_students s join public.agents g on g.id = s.agent_id
 where s.id = e.student_id and e.agency_id = g.business_id and g.profile_id is not null and g.role = 'agent'
  and g.status = 'Active' and e.assigned_agent_id is null and e.tenant_id is null;
