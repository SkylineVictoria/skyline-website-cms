-- STUDENT-DELETE-FILES (owner 2026-11-26): "if a student is deleted, all their applications and application documents are
-- deleted, after asking Are you sure, showing how many applications and the student's status".
-- The delete itself stays admin_student_purge (20261125070517: every application with everything linked, then the student).
-- Until now the application files were only queued in storage_cleanup_queue and nothing removed them (111 queued on hosted,
-- none removed). This adds:
-- * admin_student_delete_preview(student): the student (name, email, status, portal access) and each application (reference,
--   status, submitted, completion, documents, file count), plus the other linked records (admin_student_links), for the
--   confirmation.
-- * admin_student_delete_all(student, 'DELETE'): runs admin_student_purge and returns the deleted application ids and the
--   storage_cleanup_queue ids it queued in this transaction (requested_at = now() of this transaction, requested_by = caller),
--   so the portal-application-delete Edge Function (action student_files) removes exactly those files and every object left
--   in the deleted applications' folders, then marks the queue rows done. Older queue rows are not touched.
-- * The student's portal login goes too (owner 2026-11-26: "once the student is deleted the workspace didn't get deleted, delete all
--   with the student"): admin_student_login_plan lists each login of the student (their student membership, their student profile,
--   or a leftover login on the same email with nothing else on it) and whether it is deleted; a login that is also an agent, a CMS
--   user, staff, or another student's is kept (only unlinked). Deleted = waiting invitations for the email, the portal profile (its
--   memberships cascade), the student profile, the Supabase Auth user (sessions, identities cascade).
-- Admins only (admin_business_require), same as the purge. Down: drop the three functions.
begin;

-- The student's logins and whether each one is deleted with the student (kept when it is used for anything else).
create or replace function public.admin_student_login_plan(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare s public.enrollment_students; v jsonb;
begin
  perform public.admin_business_require();
  select * into s from public.enrollment_students where id = p_student;
  if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
  with logins as (
    select p.id profile_id, p.auth_user_id, p.email from public.portal_profiles p
     where exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.student_id = s.id)
        or p.auth_user_id = (select sp.auth_user_id from public.student_profiles sp where sp.id = s.student_profile_id)
        or (nullif(btrim(s.email), '') is not null and lower(p.email) = lower(btrim(s.email)))
    union
    select null, sp.auth_user_id, sp.email from public.student_profiles sp
     where sp.id = s.student_profile_id and not exists (select 1 from public.portal_profiles p where p.auth_user_id = sp.auth_user_id)
  ), checked as (
    select l.*, case
      when exists (select 1 from public.agents a where a.profile_id = l.profile_id) then 'also an agent'
      when exists (select 1 from public.agency_memberships m where m.user_id = l.profile_id and (m.role <> 'student' or (m.student_id is not null and m.student_id <> s.id))) then 'also used by another business or student'
      when exists (select 1 from public.cms_users c where c.auth_user_id = l.auth_user_id or lower(c.email) = lower(l.email)) then 'also a CMS user'
      when exists (select 1 from hr.staff_profiles h where h.auth_user_id = l.auth_user_id) then 'also staff'
      when exists (select 1 from public.enrollment_students o join public.student_profiles sp on sp.id = o.student_profile_id
                    where o.id <> s.id and sp.auth_user_id = l.auth_user_id) then 'also another student'
    end keep_reason from logins l)
  select coalesce(jsonb_agg(jsonb_build_object('profileId', profile_id, 'authUserId', auth_user_id, 'email', email,
           'delete', keep_reason is null, 'keepReason', keep_reason)), '[]'::jsonb) into v from checked;
  return v;
end $fn$;
revoke all on function public.admin_student_login_plan(uuid) from public, anon;
grant execute on function public.admin_student_login_plan(uuid) to authenticated;

create or replace function public.admin_student_delete_preview(p_student uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare s public.enrollment_students; v_apps jsonb; v_links jsonb;
begin
  perform public.admin_business_require();
  select * into s from public.enrollment_students where id = p_student;
  if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'reference', a.reference, 'status', a.status, 'submittedAt', a.submitted_at,
           'completion', a.completion, 'createdAt', a.created_at,
           'documents', (select count(*) from public.enrollment_application_documents d where d.application_id = a.id),
           'files', (select count(*) from public.enrollment_application_documents d where d.application_id = a.id and coalesce(d.storage_path, '') <> ''),
           'offerLetters', (select count(*) from public.enrollment_offer_letters o where o.application_id = a.id))
         order by a.created_at), '[]'::jsonb)
    into v_apps from public.enrollment_applications a where a.student_id = s.id;
  v_links := public.admin_student_links(p_student);
  return jsonb_build_object(
    'student', jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email, 'status', s.status,
      'archived', s.archived_at is not null,
      'hasLogin', exists (select 1 from public.agency_memberships m where m.student_id = s.id)),
    'applications', v_apps,
    'logins', public.admin_student_login_plan(p_student),
    'links', coalesce(v_links->'links', '[]'::jsonb));
end $fn$;
revoke all on function public.admin_student_delete_preview(uuid) from public, anon;
grant execute on function public.admin_student_delete_preview(uuid) to authenticated;

create or replace function public.admin_student_delete_all(p_student uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public, auth as $fn$
declare v_apps uuid[]; v_result jsonb; v_queue bigint[]; v_logins jsonb; v_email text; v_profiles uuid[]; v_auth uuid[]; n int := 0;
begin
  perform public.admin_business_require();
  select coalesce(array_agg(id), '{}') into v_apps from public.enrollment_applications where student_id = p_student;
  select lower(nullif(btrim(email), '')) into v_email from public.enrollment_students where id = p_student;
  v_logins := public.admin_student_login_plan(p_student);
  v_result := public.admin_student_purge(p_student, p_confirm);
  select coalesce(array_agg(q.id), '{}') into v_queue from public.storage_cleanup_queue q
   where q.requested_at = now() and q.requested_by is not distinct from auth.uid() and q.done_at is null;
  -- The login (workspace) goes with the student unless it is used for anything else.
  select coalesce(array_agg((x->>'profileId')::uuid) filter (where x->>'profileId' is not null), '{}'),
         coalesce(array_agg((x->>'authUserId')::uuid) filter (where x->>'authUserId' is not null), '{}')
    into v_profiles, v_auth from jsonb_array_elements(v_logins) x where (x->>'delete')::boolean;
  if v_email is not null then
    delete from public.agency_invitations where lower(email) = v_email and role = 'student' and accepted_at is null;
  end if;
  delete from public.portal_profiles where id = any(v_profiles);
  delete from public.student_profiles sp where sp.auth_user_id = any(v_auth)
    and not exists (select 1 from public.enrollment_students o where o.student_profile_id = sp.id);
  delete from auth.users where id = any(v_auth);
  get diagnostics n = row_count;
  return v_result || jsonb_build_object('applicationIds', to_jsonb(v_apps), 'cleanupIds', to_jsonb(v_queue), 'loginsDeleted', n,
    'loginsKept', (select count(*) from jsonb_array_elements(v_logins) x where not (x->>'delete')::boolean));
end $fn$;
revoke all on function public.admin_student_delete_all(uuid, text) from public, anon;
grant execute on function public.admin_student_delete_all(uuid, text) to authenticated;

commit;
