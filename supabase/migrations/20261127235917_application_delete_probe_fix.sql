-- APPLICATION-DELETE-PROBE-FIX (owner 2026-11-27): every submitted application was refused "has records that must be kept": the probe
-- in portal_delete_draft_prepare (20261127235517) deleted the submission receipt while the notification outbox row still pointed at
-- it. The probe now runs the delete's own steps in the delete's order (link sends, notification events / attempts / deliveries,
-- outbox, audit link, receipts, application), then is undone; a real refusal names the record that keeps the application.
-- Down: re-run both functions from 20261127235517_application_delete_any_but_active.sql.
begin;

CREATE OR REPLACE FUNCTION public.portal_delete_draft_prepare(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v_docs jsonb;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or not found or not public.portal_can_access_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  -- APPLICATION-DELETE-ANY (owner 2026-11-27): every application except an Active one may be deleted, by anyone who can open it
  -- (the student, their agent, the business admin agent, SLIT admins); a draft also needs edit rights as before.
  if a.status = 'active' then
    raise exception 'An Active application cannot be deleted.' using errcode = '55000'; end if;
  if a.status = 'draft' and not public.portal_can_edit_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  -- The delete is tried first and undone, so a record that keeps the application (offer letter, payment, registration, enrolment...)
  -- refuses here, before the function removes any file.
  -- The probe runs the same steps as portal_delete_draft_application, in the same order (the notification rows point at the
  -- outbox, the outbox at the submission receipt), then is undone.
  begin
    delete from public.guest_link_sends where application_id = a.id;
    delete from public.notification_provider_events where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
    delete from public.notification_delivery_attempts where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
    delete from public.notification_deliveries where application_id = a.id;
    delete from public.admission_event_outbox where application_id = a.id;
    update public.portal_audit_log set application_id = null where application_id = a.id;
    delete from public.admission_submission_receipts where application_id = a.id;
    delete from public.enrollment_applications where id = a.id;
    raise exception 'probe' using errcode = 'P0D01';
  exception
    when sqlstate 'P0D01' then null;
    when foreign_key_violation or restrict_violation then
      raise exception 'This application is still used by other records, so it cannot be deleted (%). Withdraw it instead.', sqlerrm using errcode = '55000';
    when others then
      raise exception 'This application cannot be deleted: %', sqlerrm using errcode = '55000';
  end;
  update public.guest_document_links set revoked_at = now() where application_id = a.id and revoked_at is null;
  update public.enrollment_document_extraction_jobs set state = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = now()
    where application_id = a.id and state in ('queued', 'processing');
  select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_name, 'path', storage_path, 'filename', filename)), '[]'::jsonb) into v_docs from public.enrollment_application_documents where id in (select public.application_delete_document_ids(a.id));
  return jsonb_build_object('reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'documents', v_docs, 'count', jsonb_array_length(v_docs));
end; $function$;

CREATE OR REPLACE FUNCTION public.portal_delete_draft_application(p_application uuid, p_expected_documents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v_count integer; v_ref text; v_name text; v_role text;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or not found or not public.portal_can_access_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  -- APPLICATION-DELETE-ANY (owner 2026-11-27): every application except an Active one may be deleted, by anyone who can open it
  -- (the student, their agent, the business admin agent, SLIT admins); a draft also needs edit rights as before.
  if a.status = 'active' then
    raise exception 'An Active application cannot be deleted.' using errcode = '55000'; end if;
  if a.status = 'draft' and not public.portal_can_edit_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  select count(*) into v_count from public.enrollment_application_documents where id in (select public.application_delete_document_ids(a.id));
  if v_count is distinct from p_expected_documents then raise exception 'Documents changed while deleting; try again' using errcode = 'PT409'; end if;
  v_ref := coalesce(nullif(a.reference, ''), left(a.id::text, 8));
  -- Link emails (sent, pending or suppressed) and their provider records, then the outbox rows that point at the application.
  delete from public.guest_link_sends where application_id = a.id;
  delete from public.notification_provider_events where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
  delete from public.notification_delivery_attempts where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
  delete from public.notification_deliveries where application_id = a.id;
  delete from public.admission_event_outbox where application_id = a.id;
  -- Earlier audit entries about this application stay as history; only their link to the (now deleted) row is cut.
  update public.portal_audit_log set application_id = null where application_id = a.id;
  select coalesce(nullif(btrim(full_name), ''), 'User') into v_name from public.portal_profiles where auth_user_id = auth.uid();
  v_role := case when public.portal_is_slit_admin() then 'slit_admin' when public.portal_is_agency_admin() then 'agency_admin' when public.portal_student_id() is not null then 'student' else 'agent' end;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, application_id, detail, tenant_id)
  values (auth.uid(), coalesce(v_name, 'User'), v_role, case when a.status = 'draft' then 'draft_deleted' else 'application_deleted' end, 'application', v_ref, a.agency_id, null, jsonb_build_object('reference', v_ref, 'documents', v_count, 'status', a.status), a.tenant_id);
  -- Documents, field reviews (suggestions), extraction jobs, guest links and consents, notifications, messages, requests, versions and history cascade.
  delete from public.admission_submission_receipts where application_id = a.id;
  begin
    delete from public.enrollment_applications where id = a.id;
  exception when foreign_key_violation or restrict_violation then
    raise exception 'This application is still used by other records, so it cannot be deleted (%). Withdraw it instead.', sqlerrm using errcode = '55000';
  end;
  return jsonb_build_object('reference', v_ref, 'documents', v_count);
end; $function$;

commit;
