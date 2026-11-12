-- Called by the sign-up page right after Google (or any) sign-in, with the role the person chose.
-- Returns ok=false and a message when the signed-in email already belongs to a different kind of account.
-- Applied on hosted 2026-11-12 as version 20261112080818.
create or replace function public.portal_signup_intent_check(p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_existing text;
  v_wanted text;
begin
  if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_kind not in ('student', 'agent') then raise exception 'Choose Student or Agent.' using errcode = '22023'; end if;
  v_wanted := case p_kind when 'student' then 'a student' else 'an agent' end;

  if exists (select 1 from public.cms_users c where c.auth_user_id = v_uid and c.status = 'Active') then
    return jsonb_build_object('ok', false, 'existing', 'staff',
      'message', 'This email is already registered as a Skyline staff account, so it cannot be used to sign up as ' || v_wanted || '. Use the Sign in tab, or sign up with a different email.');
  end if;

  select m.role into v_role
  from public.portal_profiles p
  join public.agency_memberships m on m.user_id = p.id
  where p.auth_user_id = v_uid
  limit 1;

  if v_role is null then
    return jsonb_build_object('ok', true, 'existing', null, 'message', null);
  end if;

  v_existing := case when v_role = 'student' then 'student' else 'agent' end;
  if v_existing = p_kind then
    return jsonb_build_object('ok', true, 'existing', v_existing, 'message', null);
  end if;

  return jsonb_build_object('ok', false, 'existing', v_existing,
    'message', 'This email is already registered as ' || case v_existing when 'student' then 'a student' else 'an agency' end
      || ' account, so it cannot be used to sign up as ' || v_wanted || '. Use the Sign in tab, or sign up with a different email.');
end;
$$;

revoke all on function public.portal_signup_intent_check(text) from public, anon;
grant execute on function public.portal_signup_intent_check(text) to authenticated;
