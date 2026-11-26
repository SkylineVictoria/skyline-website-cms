-- APPLICATION-AGENT-BLOCK + STUDENT-ONE-AGENT (owner 2026-11-26: submitting SLIT-2026-0124 refused with "Required field missing:
-- via_agent"; "a student and its applications are always connected to the same agent").
-- The student's agent (enrollment_students.agent_id) is the one source:
-- * Every save of an application writes its agent block from it: via_agent Yes, agent_agency = the business, agent_contact_name /
--   _email / _phone = the student's agent (falls back to the application's assigned agent only when the student has none). The
--   student never typed this block (it is the agent's) and a student finishing an application the agent sent left it empty.
-- * The application's assigned agent (assigned_agent_id, a portal login) follows the student's agent when that agent has a login.
-- * Changing the agent anywhere moves the student and all their applications: an application reassigned to another agent already
--   moves the student (zz_application_sync_student); the student's agent changing now moves every application of the student
--   (assigned agent, and the agent block of each application that is still a draft; submitted applications keep the block they were
--   submitted with, their assigned agent follows).
-- Runs last among the BEFORE triggers (after the guards). Down: drop triggers zzz_application_agent_block and zz_student_agent_follow
-- and their functions.
begin;

create or replace function public.application_fill_agent_block() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v jsonb := coalesce(new.data->'values', '{}'::jsonb); v_agency text; v_name text; v_email text; v_phone text; v_profile uuid;
  add jsonb;
begin
  if new.agency_id is null then return new; end if;
  select g.name into v_agency from agencies g where g.id = new.agency_id;
  select ag.full_name, ag.email, ag.phone, ag.profile_id into v_name, v_email, v_phone, v_profile
    from enrollment_students s join agents ag on ag.id = s.agent_id where s.id = new.student_id;
  if v_name is null and v_email is null then
    select p.full_name, p.email, p.phone into v_name, v_email, v_phone from portal_profiles p where p.id = new.assigned_agent_id;
  elsif v_profile is not null and new.assigned_agent_id is null then
    new.assigned_agent_id := v_profile;
  end if;
  if v_agency is null then return new; end if;
  add := jsonb_strip_nulls(jsonb_build_object('via_agent', 'Yes', 'agent_agency', v_agency,
    'agent_contact_name', nullif(btrim(v_name), ''), 'agent_email', lower(nullif(btrim(v_email), '')), 'agent_phone', nullif(btrim(v_phone), '')));
  if (v || add) is distinct from v then
    new.data := jsonb_set(coalesce(new.data, '{}'::jsonb), '{values}', v || add);
  end if;
  return new;
end $fn$;
revoke all on function public.application_fill_agent_block() from public, anon, authenticated;

drop trigger if exists zzz_application_agent_block on public.enrollment_applications;
create trigger zzz_application_agent_block
  before insert or update of data, student_id, assigned_agent_id on public.enrollment_applications
  for each row execute function public.application_fill_agent_block();

-- The student's agent changed: every application of the student follows (assigned agent; agent block of drafts).
create or replace function public.student_agent_follow() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_profile uuid; a record;
begin
  select profile_id into v_profile from agents where id = new.agent_id;
  for a in select id, status from enrollment_applications where student_id = new.id loop
    perform set_config('portal.draft_command', a.id::text, true);
    if a.status = 'draft' then
      -- Touch the answers so zzz_application_agent_block rewrites the agent block from the new agent.
      update enrollment_applications set assigned_agent_id = coalesce(v_profile, assigned_agent_id), data = data
       where id = a.id;
    elsif v_profile is not null then
      update enrollment_applications set assigned_agent_id = v_profile where id = a.id and assigned_agent_id is distinct from v_profile;
    end if;
  end loop;
  perform set_config('portal.draft_command', '', true);
  return null;
end $fn$;
revoke all on function public.student_agent_follow() from public, anon, authenticated;

drop trigger if exists zz_student_agent_follow on public.enrollment_students;
create trigger zz_student_agent_follow
  after update of agent_id on public.enrollment_students
  for each row when (new.agent_id is distinct from old.agent_id and new.agent_id is not null)
  execute function public.student_agent_follow();

commit;
