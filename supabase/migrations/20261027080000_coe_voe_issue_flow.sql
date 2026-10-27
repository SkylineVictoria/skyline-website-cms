-- Migration 94 (P08-07): CoE / VoE issue flow (manual until the PRISMS API). Additive; local only until released.
-- * Registration verification is possible from offer_accepted (was coe_issued / enrolled), so the flow is: register -> lodge -> verify -> upload the PDF -> approve and issue.
-- * enrollment_coe_documents holds the uploaded CoE or VoE PDF (kind, size <= 3 MB, %PDF- header and %%EOF validated, sha256). It is private by construction:
--   RLS on, no grants to browser roles, written only by portal_coe_document_upload (reviewers), read by reviewers through portal_coe_document_content and by the worker
--   (service role, claimed coe_voe_issued delivery with a matching lease, issued documents only). Nothing in Storage changes. An issued document is immutable.
-- * portal_coe_voe_issue ("Approve and issue") needs a verified registration, the offer accepted and an uploaded PDF; in ONE transaction it moves the application to
--   coe_issued through the existing status command (so the coe_voe_issued event and its P08-05 recipients are produced) and marks the document issued; audited.
-- * A missing or malformed student / user address now creates a visible suppressed delivery (reason invalid_recipient) instead of being skipped, and
--   notification_invalid_recipients lists them for administrators of the scope.
-- Rollback (manual): re-create portal_registration_transition (20261026220000) and notification_enqueue_deliveries (20261027060000); drop the functions and table added here.
begin;

create or replace function public.portal_registration_transition(p_registration uuid, p_to text, p_coe_number text default null, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_coe text; v_name text; v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))) then
    raise exception 'Invalid registration transition: % to %', r.state, p_to using errcode = '22023';
  end if;
  if p_to = 'lodged' then
    update public.enrollment_registrations set state = 'lodged', lodged_at = now(), lodged_by = auth.uid(), updated_at = now() where id = r.id;
  elsif p_to = 'verified' then
    if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'The offer must be accepted before registration can be verified' using errcode = '22023'; end if;
    v_coe := upper(trim(coalesce(p_coe_number, '')));
    if v_coe !~ '^[A-Z0-9-]{6,20}$' then raise exception 'A CoE number of 6-20 letters, digits or hyphens is required' using errcode = '22023'; end if;
    if not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'verified', coe_number = v_coe, verified_at = now(), verified_by = auth.uid(), updated_at = now() where id = r.id;
  else
    if v_note = '' then raise exception 'A reason is required to cancel' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_note, updated_at = now() where id = r.id;
  end if;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (r.id, r.tenant_id, r.state, p_to, auth.uid(), v_name, v_note);
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_name, 'slit_admin', 'registration_' || p_to, 'registration', r.id::text, a.id,
    jsonb_build_object('from', r.state, 'to', p_to, 'note', v_note) || case when p_to = 'verified' then jsonb_build_object('coeNumber', v_coe) else '{}'::jsonb end);
end;
$$;

create or replace function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean; v_set jsonb; v_source text;
  v_subject text; v_body text; v_addr text; v_state text; v_reason text;
begin
  if new.event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
  v_set := public.notification_event_settings(new.tenant_id, new.event);
  v_source := case when v_cfg is null then 'default' else 'published' end;
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', public.portal_status_label(coalesce(new.payload->>'to', a.status)),
    'previousStatus', public.portal_status_label(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end)),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  v_subject := public.notification_render(v_tpl->>'subject', v_vars);
  v_body := public.notification_render(v_tpl->>'body', v_vars);
  -- Portal users: the assigned agent and / or the agency admins, per the event settings; per-user opt-outs apply.
  for r in
    select p.auth_user_id, lower(trim(coalesce(p.email, ''))) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null
      and ((coalesce((v_set->>'notifyAgent')::boolean, false) and p.id = a.assigned_agent_id)
        or (coalesce((v_set->>'notifyAgencyAdmins')::boolean, false) and exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin')))
  loop
    -- A selected user without a usable address is recorded as a visible suppressed delivery, never skipped silently.
    if r.email = '' or length(r.email) > 254 or r.email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
      insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
      values (new.id, new.tenant_id, new.application_id, r.auth_user_id, left(r.email, 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
      on conflict do nothing;
      continue;
    end if;
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict do nothing;
  end loop;
  -- Recipients without a portal account: the configured internal addresses and, when enabled, the student. One delivery per address per event.
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;
  if coalesce((v_set->>'notifyStudent')::boolean, false)
     and not (a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254) then
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, left(lower(btrim(coalesce(a.student_email, ''))), 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
    on conflict do nothing;
  end if;
  for v_addr in
    select distinct x from (
      select lower(btrim(e)) as x from jsonb_array_elements_text(coalesce(v_set->'recipients', '[]'::jsonb)) e
      union all
      select lower(btrim(a.student_email)) where coalesce((v_set->>'notifyStudent')::boolean, false) and a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254
    ) s where x is not null and x <> ''
  loop
    if exists (select 1 from public.notification_deliveries d where d.outbox_id = new.id and lower(d.recipient_email) = v_addr) then continue; end if;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, v_addr, new.event, v_source, v_id, v_sender, v_subject, v_body, v_state, v_reason, clock_timestamp())
    on conflict do nothing;
  end loop;
  return new;
end;
$$;

create table public.enrollment_coe_documents(
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete restrict,
  tenant_id uuid,
  registration_id uuid not null references public.enrollment_registrations(id) on delete restrict,
  kind text not null check (kind in ('coe', 'voe')),
  file_name text not null check (length(file_name) between 5 and 120),
  size_bytes integer not null check (size_bytes between 8 and 3145728),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  superseded_at timestamptz,
  issued_at timestamptz,
  issued_by uuid,
  foreign key (application_id, tenant_id) references public.enrollment_applications(id, tenant_id),
  check (issued_at is null or superseded_at is null)
);
create unique index enrollment_coe_documents_one_current on public.enrollment_coe_documents(application_id) where superseded_at is null;
alter table public.enrollment_coe_documents enable row level security;
revoke all on public.enrollment_coe_documents from public, anon, authenticated, service_role;

create function public.portal_coe_document_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'CoE / VoE documents are never deleted' using errcode = '42501'; end if;
  if old.issued_at is not null then raise exception 'An issued CoE / VoE document is immutable' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['superseded_at', 'issued_at', 'issued_by']) is distinct from (to_jsonb(old) - array['superseded_at', 'issued_at', 'issued_by']) then
    raise exception 'Only the issue and supersede markers can change' using errcode = '42501'; end if;
  return new;
end;
$$;
create trigger enrollment_coe_documents_guard before update or delete on public.enrollment_coe_documents for each row execute function public.portal_coe_document_guard();

create function public.portal_coe_document_upload(p_registration uuid, p_kind text, p_file_name text, p_content text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_bytes bytea; v_name text := btrim(coalesce(p_file_name, '')); v_id uuid; v_actor text;
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if r.state <> 'verified' then raise exception 'The registration must be verified before a CoE / VoE is uploaded' using errcode = '22023'; end if;
  if a.status <> 'offer_accepted' then raise exception 'A CoE / VoE can only be uploaded while the offer is accepted' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('coe', 'voe') then raise exception 'Choose CoE or VoE' using errcode = '22023'; end if;
  if v_name !~* '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,110}\.pdf$' then raise exception 'The file name must end in .pdf and use letters, digits, spaces, dots, dashes or brackets' using errcode = '22023'; end if;
  if p_content is null or length(p_content) > 4300000 then raise exception 'The PDF is too large (3 MB at most)' using errcode = '22023'; end if;
  begin v_bytes := decode(p_content, 'base64'); exception when others then raise exception 'The file could not be read' using errcode = '22023'; end;
  if length(v_bytes) not between 8 and 3145728 then raise exception 'The PDF must be between 8 bytes and 3 MB' using errcode = '22023'; end if;
  if convert_from(substring(v_bytes from 1 for 5), 'LATIN1') <> '%PDF-' then raise exception 'Only PDF files are accepted' using errcode = '22023'; end if;
  if position('%%EOF'::bytea in substring(v_bytes from greatest(1, length(v_bytes) - 1023))) = 0 then raise exception 'The PDF looks incomplete (no end-of-file marker)' using errcode = '22023'; end if;
  update public.enrollment_coe_documents set superseded_at = now() where application_id = a.id and superseded_at is null and issued_at is null;
  if exists (select 1 from public.enrollment_coe_documents where application_id = a.id and superseded_at is null) then raise exception 'A CoE / VoE has already been issued for this application' using errcode = '22023'; end if;
  insert into public.enrollment_coe_documents(application_id, tenant_id, registration_id, kind, file_name, size_bytes, sha256, content, uploaded_by)
  values (a.id, a.tenant_id, r.id, p_kind, v_name, length(v_bytes), encode(sha256(v_bytes), 'hex'), v_bytes, auth.uid()) returning id into v_id;
  v_actor := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_actor, 'slit_admin', 'coe_voe_upload', 'coe_document', v_id::text, a.id, jsonb_build_object('kind', p_kind, 'sizeBytes', length(v_bytes), 'sha256', encode(sha256(v_bytes), 'hex')));
  return v_id;
end;
$$;

create function public.portal_coe_document_list(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.portal_is_slit_admin() or not public.portal_can_access_application(p_application) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_build_object('id', d.id, 'kind', d.kind, 'fileName', d.file_name, 'sizeBytes', d.size_bytes, 'sha256', d.sha256, 'uploadedAt', d.uploaded_at, 'issuedAt', d.issued_at)
    from public.enrollment_coe_documents d where d.application_id = p_application and d.superseded_at is null), 'null'::jsonb);
end;
$$;

create function public.portal_coe_document_content(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.portal_is_slit_admin() or not public.portal_can_access_application(p_application) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_build_object('kind', d.kind, 'fileName', d.file_name, 'contentBase64', encode(d.content, 'base64'))
    from public.enrollment_coe_documents d where d.application_id = p_application and d.superseded_at is null), 'null'::jsonb);
end;
$$;

create function public.portal_coe_voe_issue(p_application uuid, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; r public.enrollment_registrations; d public.enrollment_coe_documents; v_actor text;
begin
  a := public.portal_registration_authority(p_application);
  if a.status <> 'offer_accepted' then raise exception 'The offer must be accepted before the CoE / VoE is issued' using errcode = '22023'; end if;
  select * into r from public.enrollment_registrations where application_id = a.id and state = 'verified';
  if not found then raise exception 'A verified registration is required before the CoE / VoE is issued' using errcode = '22023'; end if;
  select * into d from public.enrollment_coe_documents where application_id = a.id and registration_id = r.id and superseded_at is null and issued_at is null for update;
  if not found then raise exception 'Upload the CoE / VoE PDF before issuing it' using errcode = '22023'; end if;
  -- The existing status command: reviewer check, workflow graph, audit and the coe_voe_issued outbox event with its recipients.
  perform public.portal_set_application_status(a.id, 'coe_issued', left(coalesce(p_note, ''), 300));
  update public.enrollment_coe_documents set issued_at = now(), issued_by = auth.uid() where id = d.id;
  v_actor := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_actor, 'slit_admin', 'coe_voe_issue', 'coe_document', d.id::text, a.id, jsonb_build_object('kind', d.kind, 'sizeBytes', d.size_bytes, 'registration', r.id));
  return jsonb_build_object('applicationId', a.id, 'documentId', d.id, 'kind', d.kind);
end;
$$;

-- Worker read: only the issued document of the application behind a claimed coe_voe_issued delivery, for the matching lease.
create function public.notification_delivery_coe_document(p_id uuid, p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare x public.notification_deliveries; d public.enrollment_coe_documents;
begin
  select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending' and y.event = 'coe_voe_issued';
  if not found then return null; end if;
  select * into d from public.enrollment_coe_documents c where c.application_id = x.application_id and c.issued_at is not null order by c.issued_at desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('kind', d.kind, 'sizeBytes', d.size_bytes, 'contentBase64', encode(d.content, 'base64'),
    'reference', coalesce(nullif((select a.reference from public.enrollment_applications a where a.id = x.application_id), ''), left(x.application_id::text, 8)));
end;
$$;

-- Administrators of a scope see the deliveries that could not be addressed (last 60 days, masked).
create function public.notification_invalid_recipients(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.notification_sender_admin(p_tenant) then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'recipient', case when x.recipient_email = '' then '(no address)' else public.notification_mask_email(x.recipient_email) end, 'at', x.created_at) order by x.created_at desc)
    from (select * from public.notification_deliveries d where d.state = 'suppressed' and d.state_reason = 'invalid_recipient' and d.tenant_id is not distinct from p_tenant and d.created_at > now() - interval '60 days' order by d.created_at desc limit 50) x
    join public.enrollment_applications a on a.id = x.application_id), '[]'::jsonb);
end;
$$;

revoke all on function public.portal_coe_document_guard(), public.portal_coe_document_upload(uuid, text, text, text), public.portal_coe_document_list(uuid), public.portal_coe_document_content(uuid),
  public.portal_coe_voe_issue(uuid, text), public.notification_delivery_coe_document(uuid, uuid), public.notification_invalid_recipients(uuid) from public, anon, authenticated, service_role;
grant execute on function public.portal_coe_document_upload(uuid, text, text, text), public.portal_coe_document_list(uuid), public.portal_coe_document_content(uuid),
  public.portal_coe_voe_issue(uuid, text), public.notification_invalid_recipients(uuid) to authenticated;
grant execute on function public.notification_delivery_coe_document(uuid, uuid) to service_role;

commit;
