-- SIGNED-APPLICATION (owner, 2026-11-27).
-- 1. LOCK: "Once the student signs the application, no one can edit it; only the student's data (the student record) may change."
--    Replaces ADMIN-EDIT-SUBMITTED (20261127010517): SLIT admins no longer save answers on a Submitted / Under review application.
--    A signed application is corrected by sending it back (Action required): the student corrects it and signs again.
--    Enforced in the database for every writer: after signing (any status other than Draft / Action required, or the student has
--    signed and the parent / guardian has not yet) the answers (data.values) and the qualifications list (data.academicQualifications)
--    are refused (42501). Status moves, offers, CoE / VoE, payments and the student record (enrollment_students) are not affected;
--    documents were already kept once an application leaves Draft (portal-document-delete, portal_change_document_category).
-- 2. SIGNED VIEW: application_signed_copy (the Review & signature card and the signed PDF) returns what was signed at submission: the
--    consents named in the submission snapshot with their stored wording (the declaration text of that version, when its hash is the
--    one the student agreed to), the drawn signatures, the parent / guardian, and the submission snapshot itself. It no longer returns
--    any signing certificate detail (IP, user agent, hashes): those stay in the database only.
-- 3. SIGNED COPY IN THE PORTAL + EMAILS (owner: "once the student signs, generate the form with the signed copy, status Submitted, email
--    the agent, admin and student with the confirmation, and store the copy in the portal for all to see"): the submission email
--    (notification-delivery) attaches the signed application (the form from the submission snapshot + the signature page) and the first
--    send stores it in application_signed_copies, which the student, the agent and SLIT staff open from the application.
--    The student now gets the submission confirmation as well (notifyStudent for application_submitted).
begin;

-- 1a. Only Draft / Action required are saved (SLIT admins included); the student record is edited on the student's page.
create or replace function public.portal_lock_draft(p_application_id uuid, p_expected_version bigint)
 returns public.enrollment_applications
 language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) or a.status not in ('draft','action_required') then
  raise exception '%', case when a.id is not null and a.status not in ('draft','action_required')
    then 'This application is signed, so it cannot be changed. To correct it, send it back with Action required: the student corrects it and signs again.'
    else 'Application is not editable' end using errcode='42501'; end if;
 if not public.application_student_active(a.id) then
  raise exception 'This student is disabled, so their applications are locked' using errcode='42501'; end if;
 -- APPLICATION-STUDENT-SIGNS: the agent is view-only while the student has it; the student while it is back with the agent.
 if skyline_private.handoff_blocks_edit(a.id) then
  raise exception '%', case when skyline_private.is_application_student(a.id)
    then 'Your agent has this application at the moment, so it is view-only'
    else 'The student has this application at the moment, so it is view-only. Take it back to edit it' end using errcode='42501';
 end if;
 if a.draft_version is distinct from p_expected_version then
  raise exception 'Another session changed this application. Reload before saving; your unsaved values remain on this page.' using errcode='PT409'; end if;
 perform set_config('portal.draft_command',a.id::text,true);
 return a;
end; $function$;

-- 1b. Signed: past Draft / Action required, or signed by the student and waiting for the parent / guardian.
create or replace function skyline_private.application_is_signed(p_application uuid, p_status text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(p_status, 'draft') not in ('draft', 'action_required')
    or exists (select 1 from skyline_private.application_handoffs h where h.application_id = p_application and h.state = 'waiting_guardian');
$$;
revoke all on function skyline_private.application_is_signed(uuid, text) from public, anon, authenticated;

create or replace function skyline_private.signed_application_lock() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  -- rule-policy: technical signed-application-lock Owner 2026-11-27: a signed application's answers never change; it is sent back (Action required) and signed again.
  if skyline_private.application_is_signed(old.id, old.status)
     and ((old.data -> 'values') is distinct from (new.data -> 'values')
       or (old.data -> 'academicQualifications') is distinct from (new.data -> 'academicQualifications')) then
    raise exception 'This application is signed, so it cannot be changed. To correct it, send it back with Action required: the student corrects it and signs again.'
      using errcode = '42501', hint = 'signed_application_locked';
  end if;
  return new;
end $$;
revoke all on function skyline_private.signed_application_lock() from public, anon, authenticated;
drop trigger if exists signed_application_lock on public.enrollment_applications;
create trigger signed_application_lock before update of data on public.enrollment_applications
  for each row execute function skyline_private.signed_application_lock();

-- 2. What was signed, for one submission (the latest when p_version is null). No signing certificate details.
create or replace function skyline_private.application_signed_parts(p_application uuid, p_version integer default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_snap jsonb; v_ids uuid[]; v_cut timestamptz;
begin
  select x.snapshot, x.created_at into v_snap, v_cut from public.enrollment_application_versions x
   where x.application_id = p_application and (p_version is null or x.version = p_version) order by x.version desc, x.created_at desc limit 1;
  select array_agg(e::uuid) into v_ids from jsonb_array_elements_text(case when jsonb_typeof(v_snap -> 'submission' -> 'consentIds') = 'array'
    then v_snap -> 'submission' -> 'consentIds' else '[]'::jsonb end) e where e ~* '^[0-9a-f-]{36}$';
  return jsonb_build_object(
    -- the latest drawn signature of each signer made up to this submission (a parent / guardian signs just after it is recorded)
    'signatures', coalesce((select jsonb_agg(jsonb_build_object('role', s.signer_role, 'name', s.signer_name, 'png', s.png, 'signedAt', s.signed_at) order by s.signed_at) from (
        select distinct on (signer_role) * from public.application_signatures
         where application_id = p_application and (v_cut is null or signed_at <= v_cut + interval '1 hour') order by signer_role, signed_at desc) s), '[]'::jsonb),
    'declarations', coalesce((select jsonb_agg(jsonb_build_object('key', c.declaration_key, 'title', coalesce(t.title, c.declaration_key), 'version', c.text_version,
        -- the wording stored for the version agreed to, only while it is exactly that text
        'body', case when t.key is not null and (coalesce(c.text_hash, '') = '' or c.text_hash = t.hash) then t.body end,
        'role', c.signer_role, 'name', c.recorded_by_name, 'at', c.created_at, 'guardian', c.guardian_name, 'guardianRelationship', c.guardian_relationship)
        order by c.created_at, t.sort, c.declaration_key)
      from public.enrollment_application_consents c
      left join public.application_declaration_texts t on t.key = c.declaration_key and t.version = c.text_version
      where c.application_id = p_application and c.declaration_key is not null
        and (case when coalesce(array_length(v_ids, 1), 0) > 0 then c.id = any(v_ids) or (c.signer_role = 'guardian' and c.created_at <= coalesce(v_cut, now()) + interval '1 hour')
             else c.created_at >= coalesce((select max(x.created_at) - interval '1 day' from public.enrollment_application_consents x
               where x.application_id = p_application and x.declaration_key is not null), '-infinity') end)), '[]'::jsonb),
    'guardian', (select jsonb_build_object('name', c.guardian_name, 'relationship', c.guardian_relationship, 'at', c.created_at)
      from public.enrollment_application_consents c where c.application_id = p_application and c.signer_role = 'guardian' and c.guardian_name is not null
      order by c.created_at desc limit 1),
    'signedBy', (select h.signed_by_name from skyline_private.application_handoffs h where h.application_id = p_application),
    'signedAt', (select h.signed_at from skyline_private.application_handoffs h where h.application_id = p_application));
end $$;
revoke all on function skyline_private.application_signed_parts(uuid, integer) from public, anon, authenticated;

-- 3. The portal's signed copy: one PDF per submission, made by the email worker from the submission snapshot (form + signature page).
create table if not exists public.application_signed_copies (
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  version integer not null,
  file_name text not null,
  content bytea not null check (octet_length(content) between 100 and 15728640),
  created_at timestamptz not null default now(),
  primary key (application_id, version)
);
alter table public.application_signed_copies enable row level security;
revoke all on public.application_signed_copies from public, anon, authenticated;

-- The email worker stores it once (the first send of that submission), checked against the delivery's lease.
create or replace function public.notification_store_signed_copy(p_id uuid, p_lease uuid, p_content text) returns boolean
language plpgsql security definer set search_path to '' as $$
declare d public.notification_deliveries; o public.admission_event_outbox; a public.enrollment_applications; v_version integer; v_bytes bytea;
begin
  select * into d from public.notification_deliveries x where x.id = p_id and x.lease_token = p_lease and x.state = 'sending' and x.event = 'application_submitted';
  if not found then return false; end if;
  select * into o from public.admission_event_outbox where id = d.outbox_id;
  select * into a from public.enrollment_applications where id = d.application_id;
  v_version := coalesce(case when (o.payload->>'version') ~ '^[0-9]{1,9}$' then (o.payload->>'version')::integer end,
    (select max(v.version) from public.enrollment_application_versions v where v.application_id = d.application_id));
  if v_version is null then return false; end if;
  v_bytes := decode(coalesce(p_content, ''), 'base64');
  if octet_length(v_bytes) < 100 or octet_length(v_bytes) > 15728640 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then
    raise exception 'Not a PDF' using errcode = '22023';
  end if;
  insert into public.application_signed_copies(application_id, version, file_name, content)
  values (d.application_id, v_version, 'signed-application-' || regexp_replace(coalesce(nullif(a.reference, ''), left(a.id::text, 8)), '[^A-Za-z0-9-]', '', 'g') || '.pdf', v_bytes)
  on conflict do nothing;
  return true;
end $$;
revoke all on function public.notification_store_signed_copy(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.notification_store_signed_copy(uuid, uuid, text) to service_role;

-- 4. What the Review & signature card shows (student, agent, SLIT staff): what was signed, the submission snapshot, the stored copy.
create or replace function public.application_signed_copy(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_snap jsonb; v_version integer; v_at timestamptz; a public.enrollment_applications;
begin
  if auth.uid() is null or not (public.portal_is_slit_admin() or public.portal_can_access_application(p_application)) then
    raise exception 'You cannot see this application''s signature' using errcode = '42501';
  end if;
  select * into a from public.enrollment_applications where id = p_application;
  select x.snapshot, x.version, x.created_at into v_snap, v_version, v_at from public.enrollment_application_versions x
   where x.application_id = p_application order by x.version desc, x.created_at desc limit 1;
  return skyline_private.application_signed_parts(p_application, v_version) || jsonb_build_object(
    'handoff', (select jsonb_build_object('state', h.state, 'signedAt', h.signed_at, 'signedBy', h.signed_by_name)
      from skyline_private.application_handoffs h where h.application_id = p_application),
    'storedCopy', (select jsonb_build_object('version', c.version, 'fileName', c.file_name, 'createdAt', c.created_at)
      from public.application_signed_copies c where c.application_id = p_application order by c.version desc limit 1),
    'submission', case when v_snap is null then null else jsonb_build_object('reference', a.reference, 'submittedAt', coalesce(a.submitted_at, v_at),
      'version', v_version, 'snapshot', (v_snap - 'submission' - 'fieldProvenance' - 'wizard' - 'preparedBy')
        || case when jsonb_typeof(v_snap -> 'submission') = 'object' then jsonb_build_object('submission', (v_snap -> 'submission') - 'actor' - 'consentIds' - 'ip' - 'userAgent') else '{}'::jsonb end) end);
end $$;
revoke all on function public.application_signed_copy(uuid) from public, anon;
grant execute on function public.application_signed_copy(uuid) to authenticated;

-- The stored signed copy as a file, for the same people.
create or replace function public.application_signed_copy_file(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare c public.application_signed_copies;
begin
  if auth.uid() is null or not (public.portal_is_slit_admin() or public.portal_can_access_application(p_application)) then
    raise exception 'You cannot see this application''s signature' using errcode = '42501';
  end if;
  -- rule-policy: technical signed-copy-latest The latest submission's signed copy is the one shown; a fixed rule, not a setting.
  select * into c from public.application_signed_copies x where x.application_id = p_application order by x.version desc limit 1;
  if c.application_id is null then return null; end if;
  return jsonb_build_object('fileName', c.file_name, 'version', c.version, 'createdAt', c.created_at, 'content', encode(c.content, 'base64'));
end $$;
revoke all on function public.application_signed_copy_file(uuid) from public, anon;
grant execute on function public.application_signed_copy_file(uuid) to authenticated;

-- 5. The submission email carries the signed application: what was signed, the student's name, whether the portal copy is still to be
--    made (then the snapshot is released for it even when the institution sends links instead of attachments).
create or replace function public.notification_delivery_submission(p_id uuid, p_lease uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare d public.notification_deliveries; o public.admission_event_outbox; a public.enrollment_applications; v_mode text; v_version integer; v_snapshot jsonb; v_created timestamptz; v_host text; v_site jsonb; v_kind text; v_store boolean;
begin
  select * into d from public.notification_deliveries x where x.id = p_id and x.lease_token = p_lease and x.state = 'sending' and x.event = 'application_submitted';
  if not found then return null; end if;
  select * into o from public.admission_event_outbox where id = d.outbox_id;
  select * into a from public.enrollment_applications where id = d.application_id;
  -- Who this copy is for: portal users have recipient_user; otherwise the address is the student's (case-insensitive, trimmed) or an internal one.
  v_kind := case when d.recipient_user is not null then 'portal'
    when nullif(lower(btrim(coalesce(a.student_email, ''))), '') is not null and lower(btrim(d.recipient_email)) = lower(btrim(a.student_email)) then 'student'
    else 'internal' end;
  v_mode := coalesce((select s.submission_pdf from public.notification_attachment_settings s where s.tenant_id is not distinct from d.tenant_id), 'attach');
  v_version := coalesce(case when (o.payload->>'version') ~ '^[0-9]{1,9}$' then (o.payload->>'version')::integer end,
    (select max(v.version) from public.enrollment_application_versions v where v.application_id = d.application_id));
  select v.snapshot, v.created_at into v_snapshot, v_created from public.enrollment_application_versions v where v.application_id = d.application_id and v.version = v_version;
  v_store := v_version is not null and not exists (select 1 from public.application_signed_copies c where c.application_id = d.application_id and c.version = v_version);
  v_host := case when d.tenant_id is null then public.main_site_host()
    else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = d.tenant_id and t.verified_at is not null) end;
  select to_jsonb(c) into v_site from public.cms_settings c where c.tenant_id is not distinct from d.tenant_id order by c.id limit 1;
  return jsonb_build_object(
    'mode', v_mode,
    -- By recipient: portal users open the agency portal, internal addresses (CMS staff) open the CMS, the student gets no link.
    'link', case when v_host is null or v_kind = 'student' then '' else 'https://' || v_host || case when v_kind = 'portal' then '/agency/applications/' else '/admin/applications/' end || d.application_id::text end,
    'recipientKind', v_kind,
    'host', v_host,
    'applicationId', d.application_id,
    'tenantId', d.tenant_id,
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'version', coalesce(v_version, 0),
    'institution', coalesce(nullif(v_site->>'name', ''), (select t.name from public.tenants t where t.id = d.tenant_id), 'Skyline Institute of Technology'),
    'submittedAt', v_created,
    'branding', jsonb_build_object('logo', coalesce(v_site->>'logo', ''), 'primaryColor', case when coalesce((v_site->>'theme_configured')::boolean, false) then v_site->>'primary_color' end, 'timezone', (select public.institution_tz())),
    'documents', case when v_mode = 'attach' or v_store then coalesce((select jsonb_agg(jsonb_build_object('category', x.category, 'filename', x.filename,
        'bucket', case when v_kind = 'student' or v_mode <> 'attach' then '' else x.bucket_name end, 'path', case when v_kind = 'student' or v_mode <> 'attach' then '' else x.storage_path end) order by x.created_at)
      from public.enrollment_application_documents x where x.id in (select public.application_document_ids(d.application_id)) and x.is_current
        and (x.category <> 'Credit Evidence' or coalesce(v_snapshot->'values'->>'rpl', '') = 'Yes')), '[]'::jsonb) else '[]'::jsonb end,
    'snapshot', case when v_mode = 'attach' or v_store then v_snapshot else null end,
    'signed', skyline_private.application_signed_parts(d.application_id, v_version),
    'studentName', coalesce(nullif(btrim(a.student_name), ''), ''),
    'storeCopy', v_store);
end;
$function$;

-- 6. The student gets the submission confirmation too (with the signed application), as the agent and SLIT admissions do.
insert into public.notification_legacy_event_settings(event, settings)
values ('application_submitted', jsonb_build_object('notifyStudent', true))
on conflict (event) do update set settings = coalesce(public.notification_legacy_event_settings.settings, '{}'::jsonb) || jsonb_build_object('notifyStudent', true);

commit;
