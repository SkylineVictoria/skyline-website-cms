begin;

-- Lists and dashboards use their own projected results. The underlying set is private.
revoke execute on function public.portal_scoped_applications() from public, anon, authenticated;

-- The document worker and CRM summaries still need the application status and relationships.
-- Form payloads are read through the authorisation-checked application endpoint.
revoke select on public.enrollment_applications from public, anon, authenticated;
grant select (id, status, agency_id, assigned_agent_id, student_id, reference, created_at, updated_at, submitted_at)
  on public.enrollment_applications to authenticated;
create policy wizard_application_scope on public.enrollment_applications as restrictive
  for select to authenticated using (public.portal_can_access_application(id));
create policy wizard_only_consents on public.enrollment_application_consents as restrictive
  for all to authenticated using (public.portal_submitted_application(application_id))
  with check (public.portal_submitted_application(application_id));
create policy wizard_only_messages on public.enrollment_application_messages as restrictive
  for all to authenticated using (public.portal_submitted_application(application_id))
  with check (public.portal_submitted_application(application_id));
create policy wizard_only_history on public.enrollment_application_status_history as restrictive
  for all to authenticated using (public.portal_submitted_application(application_id))
  with check (public.portal_submitted_application(application_id));
create policy wizard_document_scope on public.enrollment_application_documents as restrictive
  for select to authenticated using (public.portal_can_access_application(application_id));

commit;
