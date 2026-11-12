-- A signed-in student without a mobile on their student record is asked for one (portal prompt), whatever way the account
-- was created (Google, converted account, invitation). Mobile numbers stay unique per student (enrollment_students_phone_unique).
create or replace function public.portal_student_needs_mobile()
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select coalesce((select coalesce(btrim(s.phone), '') = '' from public.enrollment_students s where s.id = public.portal_student_id()), false)
$$;

create or replace function public.portal_student_set_mobile(p_phone text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_student uuid := public.portal_student_id(); v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
begin
  if auth.uid() is null or v_student is null then raise exception 'Only students can do this.' using errcode = '42501'; end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Enter your mobile number with its country code.' using errcode = '22023'; end if;
  if exists (select 1 from public.enrollment_students s where s.id <> v_student and public.student_phone_key(s.phone) = public.student_phone_key(v_phone)) then
    raise exception 'This mobile number is already used by another student. Use your own mobile number.' using errcode = '23505';
  end if;
  update public.enrollment_students
     set phone = v_phone, details = jsonb_set(coalesce(details, '{}'::jsonb), '{mobile}', to_jsonb(v_phone)), updated_at = now()
   where id = v_student;
  update public.portal_profiles set phone = v_phone, updated_at = now() where auth_user_id = auth.uid() and coalesce(btrim(phone), '') = '';
  return jsonb_build_object('ok', true, 'phone', v_phone);
end $$;

revoke all on function public.portal_student_needs_mobile(), public.portal_student_set_mobile(text) from public, anon;
grant execute on function public.portal_student_needs_mobile(), public.portal_student_set_mobile(text) to authenticated;
