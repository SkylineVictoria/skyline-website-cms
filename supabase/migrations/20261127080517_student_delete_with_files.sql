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
-- Admins only (admin_business_require), same as the purge. Down: drop both functions.
begin;

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
    'links', coalesce(v_links->'links', '[]'::jsonb));
end $fn$;
revoke all on function public.admin_student_delete_preview(uuid) from public, anon;
grant execute on function public.admin_student_delete_preview(uuid) to authenticated;

create or replace function public.admin_student_delete_all(p_student uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_apps uuid[]; v_result jsonb; v_queue bigint[];
begin
  perform public.admin_business_require();
  select coalesce(array_agg(id), '{}') into v_apps from public.enrollment_applications where student_id = p_student;
  v_result := public.admin_student_purge(p_student, p_confirm);
  select coalesce(array_agg(q.id), '{}') into v_queue from public.storage_cleanup_queue q
   where q.requested_at = now() and q.requested_by is not distinct from auth.uid() and q.done_at is null;
  return v_result || jsonb_build_object('applicationIds', to_jsonb(v_apps), 'cleanupIds', to_jsonb(v_queue));
end $fn$;
revoke all on function public.admin_student_delete_all(uuid, text) from public, anon;
grant execute on function public.admin_student_delete_all(uuid, text) to authenticated;

commit;
