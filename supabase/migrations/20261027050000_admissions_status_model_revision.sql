-- Migration 91 (P08-04): admissions status model, labels and permissions. Additive; local only until released.
-- Stored status values do NOT change; coe_issued stays and is labelled "CoE / VoE issued". "Under review" and "Offer issued" leave the default
-- workflow graph and every selectable list; existing rows in those statuses stay valid and can only move forward (portal_legacy_transition_allowed).
-- New default graph: draft -> submitted; submitted <-> action_required; submitted / action_required -> offer_accepted; offer_accepted -> coe_issued ->
-- enrolled; rejected (from submitted, action_required, offer_accepted) and withdrawn (from submitted, action_required, offer_accepted, coe_issued) by admins.
-- After submission agents and agency admins have NO status transitions: portal_set_application_status stays reviewer-only, direct status writes stay
-- blocked by portal_protect_admission_state, and portal_submit_v2 now accepts drafts only (an action_required application is returned to submitted by an admin;
-- during action_required agents can still add documents and edit allowed fields). Pinned workflow versions already attached to applications are untouched.
-- Notification text uses portal_status_label (lower-case sentence form; "CoE / VoE issued"). Migration 84 activation / suppression rules are reproduced unchanged.
-- Rollback (manual): re-create tenant_config_defaults / portal_legacy_transition_allowed from 20261026180000 / 20261026160000, portal_submit_v2 from
-- 20261025155814, notification_enqueue_deliveries from 20261026240000; drop function public.portal_status_label(text).
begin;

create or replace function public.tenant_config_defaults(p_kind text) returns jsonb language sql immutable set search_path = public as $$
  select case p_kind
    when 'workflow' then jsonb_build_object(
      'statuses', '["draft","submitted","action_required","offer_accepted","coe_issued","enrolled","rejected","withdrawn"]'::jsonb,
      'transitions', '[{"from":"draft","to":"submitted"},
        {"from":"submitted","to":"action_required"},{"from":"submitted","to":"offer_accepted"},{"from":"submitted","to":"rejected"},{"from":"submitted","to":"withdrawn"},
        {"from":"action_required","to":"submitted"},{"from":"action_required","to":"offer_accepted"},{"from":"action_required","to":"rejected"},{"from":"action_required","to":"withdrawn"},
        {"from":"offer_accepted","to":"coe_issued"},{"from":"offer_accepted","to":"rejected"},{"from":"offer_accepted","to":"withdrawn"},
        {"from":"coe_issued","to":"enrolled"},{"from":"coe_issued","to":"withdrawn"}]'::jsonb)
    when 'roles' then '{"roles":{"tenant_admin":["cms.read","cms.edit","applications.review","members.manage","domains.manage","config.manage"],"editor":["cms.read","cms.edit"],"staff":["cms.read","applications.review"],"viewer":[]}}'::jsonb
    when 'integration' then '{"integrations":[]}'::jsonb
    when 'notifications' then jsonb_build_object(
      'templates', jsonb_build_object(
        'application_submitted', jsonb_build_object('subject', 'Application {{reference}} was submitted', 'body', 'Application {{reference}} has been submitted to {{institution}} and is awaiting review.'),
        'application_status_changed', jsonb_build_object('subject', 'Application {{reference}} is now {{status}}', 'body', 'The status of application {{reference}} changed from {{previousStatus}} to {{status}}.')),
      'defaults', '{"application_submitted":true,"application_status_changed":true}'::jsonb)
    when 'branding' then '{"primaryColor":"#2563eb","headingFont":"Arial","bodyFont":"Arial"}'::jsonb
  end;
$$;

create or replace function public.portal_legacy_transition_allowed(p_from text, p_to text) returns boolean language sql immutable set search_path = public as $$
  select case p_from
    when 'submitted' then p_to in ('action_required','offer_accepted','rejected','withdrawn')
    when 'action_required' then p_to in ('submitted','offer_accepted','rejected','withdrawn')
    when 'offer_accepted' then p_to in ('coe_issued','rejected','withdrawn')
    when 'coe_issued' then p_to in ('enrolled','withdrawn')
    -- Legacy rows (no longer selectable) can only move forward.
    when 'under_review' then p_to in ('action_required','offer_accepted','rejected','withdrawn')
    when 'offer_issued' then p_to in ('offer_accepted','rejected','withdrawn')
    else false end;
$$;

create function public.portal_status_label(p_status text) returns text language sql immutable set search_path = public as $$
  select case p_status when 'coe_issued' then 'CoE / VoE issued' else replace(coalesce(p_status, ''), '_', ' ') end;
$$;
revoke all on function public.portal_status_label(text) from public;
grant execute on function public.portal_status_label(text) to authenticated, service_role;

create or replace function public.portal_submit_v2(p_application_id uuid,p_expected_version bigint,p_request_key text,p_consent jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; r public.admission_submission_receipts; snap jsonb; v integer; signed_path text;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) then raise exception 'Submission not authorized' using errcode='42501'; end if;
 if nullif(btrim(p_request_key),'') is null or length(p_request_key)>200 then raise exception 'Submission request key required' using errcode='22023'; end if;
 select * into r from public.admission_submission_receipts where application_id=a.id and request_key=p_request_key;
 if found then return to_jsonb(r); end if;
 if a.status <> 'draft' then
  select * into r from public.admission_submission_receipts where application_id=a.id order by version desc limit 1;
  if found then return to_jsonb(r); end if;
  raise exception 'Application is not awaiting submission' using errcode='PT409';
 end if;
 perform public.portal_lock_draft(a.id,p_expected_version);
 perform public.portal_validate_submission(a.id);
 if p_consent->'confirmed' is distinct from 'true'::jsonb or p_consent->'authorised' is distinct from 'true'::jsonb
  or coalesce(p_consent->>'method' not in ('electronic','document'),true) or p_consent->>'declarationVersion' is distinct from '1.0' then
  raise exception 'Student consent and agent authorization are required' using errcode='22023'; end if;
 signed_path:=coalesce(p_consent->>'signedDocumentRef','');
 if p_consent->>'method'='document' and not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
  where d.application_id=a.id and d.category='Consent' and d.is_current and d.storage_path=signed_path) then
  raise exception 'A signed consent document from this application is required' using errcode='22023'; end if;
 select coalesce(max(version),0)+1 into v from public.enrollment_application_versions where application_id=a.id;
 snap:=a.data||jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.enrollment_application_courses c where application_id=a.id),
  'submission',jsonb_build_object('actor',auth.uid(),'declarationVersion','1.0','consent',p_consent,'draftVersion',a.draft_version));
 perform set_config('portal.status_command',a.id::text,true);
 update public.enrollment_applications set status='submitted',submitted_at=now(),submitted_by=auth.uid(),
  reference=coalesce(nullif(a.reference,''),public.portal_next_application_reference()),version=v where id=a.id returning * into a;
 insert into public.enrollment_application_consents(application_id,method,signed_document_ref,declaration_version,recorded_by_name)
 values(a.id,p_consent->>'method',signed_path,'1.0',coalesce(auth.jwt()->>'email','Authenticated agent'));
 insert into public.enrollment_application_versions(application_id,version,snapshot,created_by,created_by_name)
 values(a.id,v,snap,auth.uid(),coalesce(auth.jwt()->>'email','Authenticated agent'));
 insert into public.admission_submission_receipts(application_id,tenant_id,version,request_key,reference,actor)
 values(a.id,a.tenant_id,v,p_request_key,a.reference,auth.uid()) returning * into r;
 insert into public.admission_event_outbox(receipt_id,application_id,tenant_id,event,payload)
 values(r.id,a.id,a.tenant_id,'application_submitted',jsonb_build_object('receiptId',r.id,'reference',a.reference,'version',v));
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authenticated user'),case when public.portal_is_agency_admin() then 'agency_admin' when public.portal_is_slit_admin() then 'slit_admin' else 'agent' end,
  'application_submitted','application',a.id::text,a.id,jsonb_build_object('receiptId',r.id,'version',v));
 return to_jsonb(r);
end; $$;

create or replace function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean;
begin
  if new.event not in ('application_submitted', 'application_status_changed') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', public.portal_status_label(coalesce(new.payload->>'to', a.status)),
    'previousStatus', public.portal_status_label(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end)),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  for r in
    select p.auth_user_id, lower(trim(p.email)) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null and nullif(trim(p.email), '') is not null
      and (p.id = a.assigned_agent_id or exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin'))
  loop
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, case when v_cfg is null then 'default' else 'published' end, v_id, v_sender,
      public.notification_render(v_tpl->>'subject', v_vars), public.notification_render(v_tpl->>'body', v_vars),
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict (outbox_id, recipient_user) do nothing;
  end loop;
  return new;
end;
$$;

commit;
