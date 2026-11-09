-- 1) Invited agents -> business (one business, many invites)
alter table public.agency_invitations
  add column if not exists business_id uuid references public.businesses(id) on delete cascade;

update public.agency_invitations i
set business_id = a.business_id
from public.agencies a
where a.id = i.agency_id and i.business_id is null;

create or replace function public.agency_invitations_set_business_id()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.business_id is null and new.agency_id is not null then
    select business_id into new.business_id from public.agencies where id = new.agency_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_agency_invitations_set_business_id on public.agency_invitations;
create trigger trg_agency_invitations_set_business_id
before insert or update of agency_id, business_id on public.agency_invitations
for each row execute function public.agency_invitations_set_business_id();

alter table public.agency_invitations alter column business_id set not null;
create index if not exists agency_invitations_business_id_idx on public.agency_invitations(business_id);

-- 2) Agent -> students (one agent, many students)
alter table public.enrollment_students
  add column if not exists business_agent_id uuid references public.business_agents(id) on delete set null;

create index if not exists enrollment_students_business_agent_id_idx on public.enrollment_students(business_agent_id);

-- Backfill from applications where the student has exactly one assigned agent
with s as (
  select ea.student_id, min(ba.id::text)::uuid as ba_id, count(distinct ba.id) n
  from public.enrollment_applications ea
  join public.business_agents ba on ba.profile_id = ea.assigned_agent_id
  group by ea.student_id
)
update public.enrollment_students es
set business_agent_id = s.ba_id
from s
where s.student_id = es.id and s.n = 1 and es.business_agent_id is null;

-- 3) Index for business -> agents lookups
create index if not exists business_agents_business_id_idx on public.business_agents(business_id);;
