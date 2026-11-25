-- EMAIL-ONE-ROLE (owner 2026-11-25): "one email is unique across our system; if the email is matching somewhere give a warning
-- stating the email exists with the place where, and stop the duplicate, so one email for one role only".
-- Until now an email was unique WITHIN a role (20261112042544): the same email could be a student, an agent and a staff member.
-- Now one email belongs to one role only:
-- * public.email_used_where(email, table, ref): the first record that already holds the email and blocks it: any record of
--   ANOTHER role (student: enrollment_students / student_profiles / pending student invitations; agent: agents / pending agent
--   invitations; staff: cms_users / hr.staff_profiles), or another row of the SAME table (two students, two agents, two CMS
--   users, two HR profiles). Within a role the person's own linked records stay allowed (a CMS user with an HR profile, a student
--   record with its portal profile, an agent with their invitation); the nuanced same-role rules of identity_email_guard stay.
-- * Trigger aa_email_one_role_guard (fires before identity_email_guard) on cms_users, hr.staff_profiles, agents,
--   enrollment_students, student_profiles and agency_invitations: refuses a NEW email (insert, or an update that changes the email)
--   with 23505 / hint email_taken; the message stays the generic sentence and the detail says where (shown to Admin CMS only).
--   Records that already share an email are left as they are.
-- * email_available (live check under the email box): also refuses those emails; CMS admins get the place in the message.
-- Down: drop trigger aa_email_one_role_guard on the six tables; drop function public.aa_email_one_role_guard(),
--       public.email_used_where(text, text, text, text); re-run email_available from 20261113250000.
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
    select 'agent', 'agents', g.id::text, g.name, 'an agent of ' || coalesce(a.name, 'a business') || ' (Agencies › Agents)'
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

create or replace function public.aa_email_one_role_guard() returns trigger
language plpgsql security definer set search_path = public, hr as $fn$
declare n jsonb := to_jsonb(new); v text; w jsonb;
begin
  v := lower(btrim(coalesce(n->>'email', '')));
  if v = '' then return new; end if;
  if tg_op = 'UPDATE' and lower(btrim(coalesce(to_jsonb(old)->>'email', ''))) = v then return new; end if;
  if tg_table_name = 'agency_invitations' then
    if n->>'status' is distinct from 'pending' then return new; end if;
    -- Only another role blocks an invitation: inviting an existing student or agent is that same person.
    w := public.email_used_where(v, 'agency_invitations', n->>'id', case when n->>'role' = 'student' then 'student' else 'agent' end);
  else
    w := public.email_used_where(v, tg_table_name, n->>'id');
  end if;
  if w is not null then
    raise exception 'This email is already in use. Please use a different email address.'
      using errcode = '23505',
            detail = format('%s is already used by %s%s. One email can be used for one role only.', v, w->>'place',
                            case when coalesce(w->>'name', '') <> '' and w->>'name' <> v then ': ' || (w->>'name') else '' end),
            hint = 'email_taken';
  end if;
  return new;
end $fn$;
revoke all on function public.aa_email_one_role_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['public.cms_users', 'hr.staff_profiles', 'public.agents', 'public.enrollment_students', 'public.student_profiles', 'public.agency_invitations'] loop
    execute format('drop trigger if exists aa_email_one_role_guard on %s', t);
    execute format('create trigger aa_email_one_role_guard before insert or update of email%s on %s for each row execute function public.aa_email_one_role_guard()',
                   case when t = 'public.agency_invitations' then ', status' else '' end, t);
  end loop;
end $$;

-- The live check under the email box (from 20261113250000) also refuses an email held by another role or another record of
-- the same kind, and tells a CMS admin where it is used.
create or replace function public.email_available(p_email text, p_kind text default null, p_ref text default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, hr
as $$
declare v text := lower(btrim(coalesce(p_email,''))); v_hit text; v_kind text; v_table text; v_agency uuid; w jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('staff','hr_staff','agent','student') then
    raise exception 'p_kind must be staff, hr_staff, agent or student' using errcode = '22023';
  end if;
  if v = '' then return jsonb_build_object('available', false, 'message', 'Enter an email address.'); end if;
  v_kind  := case when p_kind = 'hr_staff' then 'staff' else p_kind end;
  v_table := case p_kind when 'staff' then 'cms_users' when 'hr_staff' then 'staff_profiles'
                         when 'agent' then 'agents' else 'enrollment_students' end;
  -- Editing an agent: their own business, so their own pending invite there is not a conflict.
  if p_kind = 'agent' and p_ref ~ '^[0-9a-f-]{36}$' then
    select g.business_id into v_agency from public.agents g where g.id = p_ref::uuid;
  end if;
  w := public.email_used_where(v, v_table, coalesce(p_ref, ''));
  v_hit := public.identity_email_conflict(v, v_kind, v_table, coalesce(p_ref, ''),
             case when p_kind = 'student' and p_ref ~ '^[0-9a-f-]{36}$' then p_ref::uuid end, null, v_agency);
  if w is null and v_hit is null then return jsonb_build_object('available', true, 'message', null); end if;
  return jsonb_build_object('available', false,
    'message', case when w is not null and public.cms_is_admin()
                    then format('This email is already used by %s%s. One email can be used for one role only.', w->>'place',
                                case when coalesce(w->>'name', '') <> '' and w->>'name' <> v then ': ' || (w->>'name') else '' end)
                    else 'This email is already in use. Please use a different email address.' end);
end $$;
revoke all on function public.email_available(text,text,text) from public, anon;
grant execute on function public.email_available(text,text,text) to authenticated;

commit;
