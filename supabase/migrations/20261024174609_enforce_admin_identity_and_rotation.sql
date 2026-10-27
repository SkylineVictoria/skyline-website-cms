-- UID mapping is authoritative. Password rotation requires a real Auth password
-- change, not a client flag. Auth records are read only, never written here.
create schema if not exists skyline_private;
revoke all on schema skyline_private from public,anon,authenticated,service_role;
create table skyline_private.password_rotations (
 auth_user_id uuid primary key references auth.users(id) on delete cascade,
 password_fingerprint text not null, requested_at timestamptz not null default clock_timestamp()
);
revoke all on skyline_private.password_rotations from public,anon,authenticated,service_role;
alter table skyline_private.password_rotations enable row level security;
insert into skyline_private.password_rotations(auth_user_id,password_fingerprint)
 select distinct u.id,md5(coalesce(u.encrypted_password,'')) from auth.users u join public.cms_users c on c.auth_user_id=u.id where c.must_change_password;

create or replace function public.cms_rotation_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare saved text; current_hash text;
begin
 if new.auth_user_id is null then return new; end if;
 if new.must_change_password and (tg_op='INSERT' or not old.must_change_password or new.auth_user_id is distinct from old.auth_user_id) then
  insert into skyline_private.password_rotations(auth_user_id,password_fingerprint)
   select id,md5(coalesce(encrypted_password,'')) from auth.users where id=new.auth_user_id
   on conflict(auth_user_id) do update set password_fingerprint=excluded.password_fingerprint,requested_at=clock_timestamp();
 elsif tg_op='UPDATE' and old.must_change_password and not new.must_change_password then
  -- Local migration/fixture administrators retain recovery control. API callers
  -- (including service role) must actually update the Auth credential first.
  if session_user not in ('postgres','supabase_admin') then
   select password_fingerprint into saved from skyline_private.password_rotations where auth_user_id=new.auth_user_id for update;
   select md5(coalesce(encrypted_password,'')) into current_hash from auth.users where id=new.auth_user_id;
   if saved is null or current_hash is null or saved=current_hash then raise exception 'Password change required' using errcode='42501'; end if;
  end if;
  delete from skyline_private.password_rotations where auth_user_id=new.auth_user_id;
 end if;
 return new;
end; $$;
revoke all on function public.cms_rotation_guard() from public,anon,authenticated,service_role;
create trigger cms_rotation_guard before insert or update on public.cms_users for each row execute function public.cms_rotation_guard();

create or replace function public.cms_clear_password_rotation() returns void language plpgsql security definer set search_path=public as $$
declare saved text; current_hash text;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select password_fingerprint into saved from skyline_private.password_rotations where auth_user_id=auth.uid() for update;
 if not found then
  if exists(select 1 from public.cms_users where auth_user_id=auth.uid() and must_change_password) then raise exception 'Rotation evidence missing' using errcode='42501'; end if;
  return;
 end if;
 select md5(coalesce(encrypted_password,'')) into current_hash from auth.users where id=auth.uid();
 if current_hash is null or saved=current_hash then raise exception 'Password change required' using errcode='42501'; end if;
 update public.cms_users set must_change_password=false where auth_user_id=auth.uid();
end; $$;
revoke all on function public.cms_clear_password_rotation() from public,anon;
grant execute on function public.cms_clear_password_rotation() to authenticated;
create or replace function public.cms_is_staff() returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.cms_users where auth_user_id=auth.uid() and status='Active' and not must_change_password);
$$;
create or replace function public.cms_is_admin() returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.cms_users where auth_user_id=auth.uid() and status='Active' and role='Admin' and not must_change_password);
$$;
create policy cms_users_self_recovery_read on public.cms_users for select to authenticated using(auth_user_id=auth.uid());

create or replace function public.portal_is_slit_admin() returns boolean language sql stable security definer set search_path=public as $$
 select public.cms_is_admin();
$$;
