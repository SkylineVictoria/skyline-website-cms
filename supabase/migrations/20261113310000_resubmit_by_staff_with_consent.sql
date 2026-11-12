-- Action required → Submitted from the form (owner, 2026-11-12): staff can resubmit a corrected application too, and the declaration
-- (consent method and the two confirmations) is recorded again with each resubmission, as on the first submission.
--  * The resubmit transition's allowed_roles gain the staff roles (Admin, tenant_admin, staff); the command checks allowed_roles instead
--    of refusing staff. It stays automatic (not offered in Take action: it happens from the form's Review step).
--  * portal_application_resubmit(application, note, consent): consent as portal_submit_v2 takes it; when given it is checked the same way
--    and a consent row is written (who, method, signed document). Without it (older callers) the first submission's consent stands.

-- The guard locks automatic transitions against edits from the settings page; this owner change goes around it once.
alter table public.application_status_transitions disable trigger application_status_transitions_guard;
update public.application_status_transitions
   set allowed_roles = array(select distinct r from unnest(allowed_roles || array['Admin', 'tenant_admin', 'staff']) r order by r)
 where action_key = 'resubmit' and kind = 'resubmit';
alter table public.application_status_transitions enable trigger application_status_transitions_guard;

drop function if exists public.portal_application_resubmit(uuid, text);
create or replace function public.portal_application_resubmit(p_application uuid, p_note text default '', p_consent jsonb default null) returns void
 language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; t public.application_status_transitions; v_name text; v_staff boolean := public.portal_is_slit_admin(); v_signed text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not (public.portal_can_edit_application(a.id) or (v_staff and public.portal_can_access_application(a.id))) then
  raise exception 'Application not found' using errcode = '42501';
 end if;
 select * into t from public.application_status_transitions x where x.from_status = a.status and x.kind = 'resubmit' and x.is_active limit 1;
 if not found then raise exception 'Only an application that needs action can be resubmitted' using errcode = '22023'; end if;
 if not (t.allowed_roles && public.application_caller_roles()) then raise exception 'Your role cannot resubmit this application' using errcode = '42501'; end if;
 if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1),
   auth.jwt()->>'email', '') into v_name;
 -- The declaration again (same rules as the first submission).
 if p_consent is not null then
  if p_consent->'confirmed' is distinct from 'true'::jsonb or p_consent->'authorised' is distinct from 'true'::jsonb
     or coalesce(p_consent->>'method' not in ('electronic', 'document'), true) then
   raise exception 'Student consent and authorization are required to resubmit' using errcode = '22023';
  end if;
  v_signed := coalesce(p_consent->>'signedDocumentRef', '');
  if p_consent->>'method' = 'document' and not exists (select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id = d.bucket_name and o.name = d.storage_path
     where d.application_id = a.id and d.category = 'Consent' and d.is_current and d.storage_path = v_signed) then
   raise exception 'A signed consent document from this application is required' using errcode = '22023';
  end if;
  insert into public.enrollment_application_consents(application_id, method, signed_document_ref, declaration_version, recorded_by, recorded_by_name)
  values (a.id, p_consent->>'method', v_signed, coalesce(nullif(p_consent->>'declarationVersion', ''), '1.0'), auth.uid(), coalesce(nullif(v_name, ''), auth.jwt()->>'email', 'Authenticated user'));
 end if;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', left(coalesce(nullif(btrim(p_note), ''), 'Resubmitted after corrections') || case when v_staff then ' (by staff)' else '' end, 500), true);
 update public.enrollment_applications set status = 'submitted' where id = a.id;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(nullif(v_name, ''), 'Applicant'),
   case when v_staff then 'slit_admin' when public.portal_student_id() is not null then 'student' when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end,
   'status_change', 'application', a.id::text, a.id, jsonb_build_object('from', a.status, 'to', 'submitted', 'note', left(coalesce(p_note, ''), 500), 'consentRecorded', p_consent is not null));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'application_status_changed', jsonb_build_object('from', a.status, 'to', 'submitted', 'actor', auth.uid()));
end $$;
revoke all on function public.portal_application_resubmit(uuid, text, jsonb) from public, anon;
grant execute on function public.portal_application_resubmit(uuid, text, jsonb) to authenticated;
