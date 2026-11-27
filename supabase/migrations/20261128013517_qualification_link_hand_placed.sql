-- QUALIFICATION-LINK-HAND-PLACED (owner, 2026-11-27: "link it to the student's application").
-- The one Qualification placed by hand before the link gates (consistency item QUAL-NO-APP) is linked to the student's open
-- application for its course (qualification_link_application picks it: the open one, furthest along), the application's signed
-- offer and CoE / VoE copies are added to it (qualification_copy_documents; nothing removed), and the link is recorded in its
-- history. The application's own status is not changed. Only that row; a fresh database (lab) has no such row and nothing happens.
do $$
declare e public.intake_enrolments; v_app uuid; v_ref text; v_docs integer;
begin
-- rule-policy: technical qualification-link-hand-placed A one-off data link the owner asked for, not a setting.
  select * into e from public.intake_enrolments where id = 'a9986918-2f8a-48a6-a643-e5f5597168cf' and application_id is null;
  if e.id is null then return; end if;
  v_app := public.qualification_link_application(e.id, 'Linked to the student''s application (owner, 2026-11-27)');
  if v_app is null then raise exception 'QUALIFICATION-LINK-HAND-PLACED: no application found for %', e.id; end if;
  v_docs := public.qualification_copy_documents(e.id);
  select reference into v_ref from public.enrollment_applications where id = v_app;
  insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, note, effective_on, changed_by_name)
  values (e.id, e.status, e.status, 'Linked to application',
    'Linked to application ' || coalesce(v_ref, v_app::text) || ' (placed by hand before the link gates); ' || v_docs || ' document(s) copied from it.',
    current_date, 'System (owner request)');
end $$;
