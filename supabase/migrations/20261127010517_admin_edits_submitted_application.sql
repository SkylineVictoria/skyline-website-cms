-- ADMIN-EDIT-SUBMITTED (owner, 2026-11-26: "when student submit application allow admin to change application", on one page):
-- a SLIT admin may correct the answers of a Submitted / Under review application (before an offer is issued) on the application
-- page; every such save is written to portal_audit_log (action application_edited_after_submit, with the draft version).
-- Students and agents still only edit Draft / Action required. Down: patch the status check back.
begin;

select public.business_rule_patch_function('public.portal_lock_draft(uuid, bigint)'::regprocedure,
$old$ if auth.uid() is null or not public.portal_can_access_application(a.id) or a.status not in ('draft','action_required') then
  raise exception 'Application is not editable' using errcode='42501'; end if;$old$,
$new$ if auth.uid() is null or not public.portal_can_access_application(a.id)
   or (a.status not in ('draft','action_required') and not (a.status in ('submitted','under_review') and public.portal_is_slit_admin())) then
  raise exception 'Application is not editable' using errcode='42501'; end if;
 if a.status in ('submitted','under_review') then
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', 'application_edited_after_submit', 'application',
    a.id::text, a.id, a.agency_id, a.tenant_id, jsonb_build_object('status', a.status, 'version', a.draft_version));
 end if;$new$);

commit;
