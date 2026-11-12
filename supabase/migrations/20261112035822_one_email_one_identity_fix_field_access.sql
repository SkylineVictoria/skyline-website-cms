create or replace function public.identity_email_guard()
returns trigger
language plpgsql security definer
set search_path = public, hr
as $$
declare
  n jsonb := to_jsonb(new); o jsonb;
  col text := case when tg_table_name = 'enrollment_applications' then 'student_email' else 'email' end;
  v_new text; v_kind text; v_student uuid; v_sp uuid; v_hit text;
begin
  v_new := lower(btrim(coalesce(n->>col, '')));
  if v_new = '' then return new; end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'agency_invitations' then
    o := to_jsonb(old);
    if lower(btrim(coalesce(o->>col, ''))) = v_new then return new; end if;
  end if;

  case tg_table_name
    when 'cms_users', 'staff_profiles' then v_kind := 'staff';
    when 'agents' then v_kind := 'agent';
    when 'enrollment_students' then v_kind := 'student'; v_student := (n->>'id')::uuid; v_sp := (n->>'student_profile_id')::uuid;
    when 'student_profiles' then v_kind := 'student'; v_sp := (n->>'id')::uuid;
    when 'enrollment_applications' then v_kind := 'student'; v_student := (n->>'student_id')::uuid;
    when 'agency_invitations' then
      if n->>'status' <> 'pending' then return new; end if;
      v_kind := case when n->>'role' = 'student' then 'student' else 'agent' end;
      v_student := (n->>'student_id')::uuid;
  end case;

  perform pg_advisory_xact_lock(hashtext('identity_email:' || v_new));
  v_hit := public.identity_email_conflict(v_new, v_kind, tg_table_name, n->>'id', v_student, v_sp);
  if v_hit is not null then
    raise exception 'This email is already in use. Please use a different email address.'
      using errcode = '23505',
            detail  = format('%s is already registered in SLIT as %s. One email can belong to only one account.',
                             v_new, case v_hit when 'staff' then 'a staff member' when 'agent' then 'an agent' else 'a student' end),
            hint    = 'email_taken';
  end if;
  return new;
end $$;
revoke all on function public.identity_email_guard() from public, anon, authenticated;
