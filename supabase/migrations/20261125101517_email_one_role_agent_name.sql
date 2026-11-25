-- EMAIL-ONE-ROLE fix (owner 2026-11-25): adding a student failed with "column g.name does not exist": the agents table names
-- the person full_name. email_used_where now reads g.full_name; everything else is unchanged from 20261125080517.
-- Down: re-run email_used_where from 20261125080517.
begin;

create or replace function public.email_used_where(p_email text, p_table text, p_ref text, p_kind text default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $fn$
declare
  v text := lower(btrim(coalesce(p_email, '')));
  v_kind text := coalesce(p_kind, case when p_table in ('cms_users', 'staff_profiles') then 'staff'
                      when p_table = 'agents' then 'agent'
                      when p_table in ('enrollment_students', 'student_profiles') then 'student'
                      else null end);
  r record;
begin
  if v = '' then return null; end if;
  for r in
    select 'staff' as kind, 'cms_users' as tbl, c.id::text as ref, coalesce(nullif(btrim(c.name), ''), c.email) as who,
           'a CMS user (Administration › Users)' as place from public.cms_users c where lower(btrim(c.email)) = v
    union all
    select 'staff', 'staff_profiles', s.id::text, btrim(concat_ws(' ', s.first_name, s.last_name)), 'a staff member (HRMS › Employees)'
      from hr.staff_profiles s where lower(btrim(s.email)) = v
    union all
    select 'agent', 'agents', g.id::text, g.full_name, 'an agent of ' || coalesce(a.name, 'a business') || ' (Agencies › Agents)'
      from public.agents g left join public.agencies a on a.id = g.business_id where lower(btrim(g.email)) = v
    union all
    select 'student', 'enrollment_students', e.id::text, e.full_name, 'a student (Admissions › Students)'
      from public.enrollment_students e where lower(btrim(e.email)) = v
    union all
    select 'student', 'student_profiles', p.id::text, p.email, 'a student portal account'
      from public.student_profiles p where lower(btrim(p.email)) = v
    union all
    select case when i.role = 'student' then 'student' else 'agent' end, 'agency_invitations', i.id::text, i.email,
           case when i.role = 'student' then 'a pending student portal invitation' else 'a pending agent invitation' end
      from public.agency_invitations i
     where lower(btrim(i.email)) = v and i.status = 'pending' and (i.expires_at is null or i.expires_at > now())
  loop
    -- Another role: always blocks.
    if r.kind is distinct from v_kind then
      return jsonb_build_object('kind', r.kind, 'table', r.tbl, 'name', r.who, 'place', r.place);
    end if;
    -- Same role: another row of the same table blocks (invitations may repeat).
    if r.tbl = p_table and p_table <> 'agency_invitations' and r.ref <> coalesce(p_ref, '') then
      return jsonb_build_object('kind', r.kind, 'table', r.tbl, 'name', r.who, 'place', r.place);
    end if;
  end loop;
  return null;
end $fn$;
revoke all on function public.email_used_where(text, text, text, text) from public, anon, authenticated;

commit;
