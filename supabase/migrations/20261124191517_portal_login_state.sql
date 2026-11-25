-- PORTAL-LOGIN-STATE (owner, 2026-11-24: "agent created password as POC, still it's showing wrong detail"): the business page said
-- "Sign-in invitation sent, waiting for password" for every agent without a linked portal profile, but the profile is linked only at
-- the first sign-in; an agency admin who created their password while signing the application already has a login. This read-only
-- function tells the screens, per email, whether a login with a password exists, whether it was made at signing, and the last sign-in.
-- SLIT administrators only; at most 200 emails; nothing else from auth.users is returned.
-- Rollback: drop function public.admin_portal_login_state(text[]).
begin;

create or replace function public.admin_portal_login_state(p_emails text[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare out jsonb;
begin
 perform public.admin_business_require();
 if coalesce(array_length(p_emails, 1), 0) > 200 then raise exception 'Too many emails.' using errcode = '22023'; end if;
 select coalesce(jsonb_object_agg(lower(u.email), jsonb_build_object(
   'passwordSet', coalesce(u.encrypted_password, '') <> '',
   'setAtSigning', (u.raw_user_meta_data ? 'portal_password_set_at_signing'),
   'lastSignInAt', u.last_sign_in_at)), '{}'::jsonb)
  into out
  from auth.users u
  where lower(u.email) in (select lower(btrim(e)) from unnest(coalesce(p_emails, '{}'::text[])) e where btrim(coalesce(e, '')) <> '');
 return out;
end $$;
revoke all on function public.admin_portal_login_state(text[]) from public, anon;
grant execute on function public.admin_portal_login_state(text[]) to authenticated;

commit;
