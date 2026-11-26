-- APPLICATION-AGENT-BLOCK (owner 2026-11-26: submitting SLIT-2026-0124 refused with "Required missing: agent / via_agent").
-- The agent block (via_agent, agent_agency, agent_contact_name, agent_email, agent_phone) is the agent's: the wizard filled it only
-- for the agent / staff, and a student finishing an application the agent sent never writes it, so it stayed empty and the submit
-- check (portal_validate_submission) refused. The database now fills any BLANK field of the block whenever the answers are saved,
-- from the application itself: the business (agencies.name), then the agent assigned to the application (portal_profiles), else the
-- student's agent (agents). A value already there is never changed. Runs last among the BEFORE triggers (after the guards).
-- Down: drop trigger zzz_application_agent_block and function application_fill_agent_block.
begin;

create or replace function public.application_fill_agent_block() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v jsonb := coalesce(new.data->'values', '{}'::jsonb); v_agency text; v_name text; v_email text; v_phone text;
  blank text[]; add jsonb := '{}'::jsonb;
begin
  if new.agency_id is null then return new; end if;
  select array_agg(k) into blank from unnest(array['via_agent', 'agent_agency', 'agent_contact_name', 'agent_email', 'agent_phone']) k
   where nullif(btrim(coalesce(v->>k, '')), '') is null;
  if blank is null then return new; end if;
  select g.name into v_agency from agencies g where g.id = new.agency_id;
  if v_agency is null then return new; end if;
  select p.full_name, p.email, p.phone into v_name, v_email, v_phone from portal_profiles p where p.id = new.assigned_agent_id;
  if v_name is null and v_email is null then
    select ag.full_name, ag.email, ag.phone into v_name, v_email, v_phone
      from enrollment_students s join agents ag on ag.id = s.agent_id where s.id = new.student_id;
  end if;
  if 'via_agent' = any(blank) then add := add || jsonb_build_object('via_agent', 'Yes'); end if;
  if 'agent_agency' = any(blank) then add := add || jsonb_build_object('agent_agency', v_agency); end if;
  if 'agent_contact_name' = any(blank) and nullif(btrim(v_name), '') is not null then add := add || jsonb_build_object('agent_contact_name', v_name); end if;
  if 'agent_email' = any(blank) and nullif(btrim(v_email), '') is not null then add := add || jsonb_build_object('agent_email', lower(btrim(v_email))); end if;
  if 'agent_phone' = any(blank) and nullif(btrim(v_phone), '') is not null then add := add || jsonb_build_object('agent_phone', v_phone); end if;
  if add <> '{}'::jsonb then
    new.data := jsonb_set(coalesce(new.data, '{}'::jsonb), '{values}', v || add);
  end if;
  return new;
end $fn$;
revoke all on function public.application_fill_agent_block() from public, anon, authenticated;

drop trigger if exists zzz_application_agent_block on public.enrollment_applications;
create trigger zzz_application_agent_block
  before insert or update of data on public.enrollment_applications
  for each row execute function public.application_fill_agent_block();

commit;
