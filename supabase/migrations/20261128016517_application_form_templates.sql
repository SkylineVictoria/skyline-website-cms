-- APPLICATION-FORM-TEMPLATES (owner, 2026-11-27: "create the form and save it as a template in Sign so it is used always and comes out the
-- same always; give me UI; one super looking form, it is the first impression"; owner choices: one general form, staff pick the default,
-- it drives the signed PDF only).
-- 1. New template type "Application form" (hr.sign_templates category application_form) in Documents & Signatures › Templates, edited with
--    the existing editor (header, body, footer, versions); one default at a time, chosen by staff (application_form_template_set_default).
-- 2. The standard template (letterhead, title band, summary card, answers, declarations as agreed, signature panel, office use, footer
--    with the page count and the registration details) is added as the default.
-- 3. At submission (a row in enrollment_application_versions) the default template's content is copied into application_form_used for
--    that submission, so the signed PDF always comes out of the same template, whatever is edited later. Every submission already made
--    gets the standard template (one-off), so its signed PDF looks the same from now on.
-- 4. application_signed_copy returns that template (formTemplate) and the institute's details for the printout; the email worker gets
--    the same through notification_delivery_submission.
begin;

-- 1. The type.
alter table hr.sign_templates drop constraint if exists sign_templates_category_check;
alter table hr.sign_templates add constraint sign_templates_category_check check (category = any (array['enrolment_agreement', 'consent_form', 'fee_agreement',
  'employment_contract', 'offer_letter', 'hr_declaration', 'agency_agreement', 'commission_agreement', 'other', 'offer_email', 'document_request', 'document_reupload',
  'welcome_login', 'rejection', 'student_offer_letter', 'individual_agent_agreement', 'application_form']));
create unique index if not exists sign_templates_one_application_form_default on hr.sign_templates(category)
  where category = 'application_form' and is_default and deleted_at is null;

-- Staff choose the default (CMS administrators, as for every template).
create or replace function public.application_form_template_set_default(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hr', 'public', 'pg_temp' as $$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates;
begin
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  -- rule-policy: technical application-form-default One default Application form at a time, chosen by staff (owner 2026-11-27).
  if t.id is null or t.category <> 'application_form' then raise exception 'Choose an Application form template' using errcode = '22023'; end if;
  if t.status <> 'active' then raise exception 'An archived template cannot be the default. Unarchive it first.' using errcode = '22023'; end if;
  update hr.sign_templates set is_default = false where category = 'application_form' and is_default and id <> t.id;
  update hr.sign_templates set is_default = true where id = t.id;
  return jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version, 'by', v_admin);
end $$;
revoke all on function public.application_form_template_set_default(uuid) from public, anon;
grant execute on function public.application_form_template_set_default(uuid) to authenticated;

-- 2. The standard template, as the default.
do $seed$
declare v_name text; v_title text; v_header text; v_body text; v_footer text; t hr.sign_templates;
begin
  if exists (select 1 from hr.sign_templates where category = 'application_form' and deleted_at is null) then return; end if;
  -- generated from DEFAULT_APPLICATION_FORM_TEMPLATE (supabase/functions/_shared/notification/application-form.ts)
  v_name := $afm$Application for Enrolment (standard)$afm$;
  v_title := $afm$Application for Enrolment {{application.reference}}$afm$;
  v_header := $afm$<table style="border:none;width:100%"><tr><td style="width:50%;vertical-align:middle;padding:0pt 0pt">{{institute.logo}}</td><td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt"><p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.address}}</span></span></p><p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.contact_line}}</span></span></p><p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.registration_line}}</span></span></p></td></tr><tr><td colspan="2" style="border-bottom:2.5pt solid #ea6619;padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:3pt">&nbsp;</span></p></td></tr></table>$afm$;
  v_body := $afm$<table style="border:none;width:100%"><tr><td style="background-color:#1f2937;width:64%;padding:12pt 14pt;vertical-align:middle"><p style="margin-bottom:2pt"><span style="font-size:17pt"><strong><span style="color:#ffffff">APPLICATION FOR ENROLMENT</span></strong></span></p><p style="margin-bottom:0pt"><span style="font-size:9pt"><span style="color:#d1d5db">Student application, declarations and signature</span></span></p></td><td style="background-color:#ea6619;padding:12pt 14pt;vertical-align:middle"><p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#fde7d9">REFERENCE</span></span></p><p style="text-align:right;margin-bottom:4pt"><span style="font-size:12pt"><strong><span style="color:#ffffff">{{application.reference}}</span></strong></span></p><p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#fde7d9">SUBMITTED</span></span></p><p style="text-align:right;margin-bottom:0pt"><span style="font-size:10pt"><strong><span style="color:#ffffff">{{application.submitted_on}}</span></strong></span></p></td></tr></table><p style="margin-bottom:0pt"><span style="font-size:8pt">&nbsp;</span></p><table style="border:none;width:100%"><tr><td style="background-color:#f8fafc;border-top:0.5pt solid #e5e7eb;border-left:0.5pt solid #e5e7eb;padding:7pt 10pt;width:50%"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">STUDENT</span></span></p><p style="margin-bottom:0pt"><span style="font-size:11pt"><strong>{{student.full_name}}</strong></span></p><p style="margin-bottom:0pt"><span style="font-size:8.5pt"><span style="color:#4b5563">{{student.email}}</span></span></p></td><td style="background-color:#f8fafc;border-top:0.5pt solid #e5e7eb;border-right:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">DATE OF BIRTH</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{student.date_of_birth}}</strong></span></p></td></tr><tr><td style="background-color:#f8fafc;border-bottom:0.5pt solid #e5e7eb;border-left:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">COURSE</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{course.name}}</strong></span></p></td><td style="background-color:#f8fafc;border-bottom:0.5pt solid #e5e7eb;border-right:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">INTAKE</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{course.intake}}</strong></span></p></td></tr></table><p style="margin-bottom:0pt"><span style="font-size:10pt">&nbsp;</span></p><p>{{application.answers}}</p><table style="border:none;width:100%"><tr><td style="background-color:#fdf1ea;border-left:3pt solid #ea6619;padding:5pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:10.5pt"><strong>DECLARATIONS</strong></span></p></td></tr></table><p style="margin-bottom:2pt"><span style="font-size:8.5pt"><span style="color:#4b5563">The student read and agreed to each declaration below, in the wording shown, when signing this application.</span></span></p><p>{{application.declarations}}</p><table style="border:none;width:100%"><tr><td style="padding:0pt 0pt"><table style="border:none;width:100%"><tr><td style="background-color:#fdf1ea;border-left:3pt solid #ea6619;padding:5pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:10.5pt"><strong>SIGNATURE</strong></span></p></td></tr></table><p style="margin-bottom:4pt"><span style="font-size:8.5pt"><span style="color:#4b5563">By signing, the student confirms that the information in this application is true and complete, and that the documents provided are genuine.</span></span></p><p>{{application.signatures}}</p></td></tr></table><p style="margin-bottom:0pt"><span style="font-size:10pt">&nbsp;</span></p><table style="width:100%"><tr><td colspan="4" style="background-color:#f3f4f6;padding:4pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><strong><span style="color:#374151">FOR OFFICE USE ONLY</span></strong></span></p></td></tr><tr><td style="width:22%;padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Received by</span></span></p></td><td style="width:28%;padding:6pt 8pt"><p>&nbsp;</p></td><td style="width:22%;padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Date</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td></tr><tr><td style="padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Entry requirements checked</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td><td style="padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Student ID</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td></tr></table>$afm$;
  v_footer := $afm$<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt"><p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">Application for Enrolment  |  {{application.reference}}  |  Page {{page.number}} of {{page.total}}</span></span></p><p style="text-align:center;margin-bottom:0pt"><span style="font-size:6.5pt"><span style="color:#9ca3af">{{institute.legal_name}}  |  ABN {{institute.abn}}  |  {{institute.registration_line}}</span></span></p></td></tr></table>$afm$;
  insert into hr.sign_templates(id, name, title, body, body_html, header_html, footer_html, kind, audience, category, status, version, created_by, is_default, bracket_variables, roles)
  values ('a9f0e000-0000-4000-8000-000000000001', v_name, v_title, 'Application for Enrolment', v_body, v_header, v_footer, 'text', 'student', 'application_form', 'active', 1,
    '00000000-0000-0000-0000-000000000000', true, false, '[]'::jsonb)
  returning * into t;
  insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, 1, to_jsonb(t), t.created_by);
end $seed$;

-- 3. What each submission is printed from.
create table if not exists public.application_form_used (
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  version integer not null,
  template_id uuid,
  template_version integer,
  template_name text not null,
  title text not null,
  header_html text,
  body_html text not null,
  footer_html text,
  created_at timestamptz not null default now(),
  primary key (application_id, version)
);
alter table public.application_form_used enable row level security;
revoke all on public.application_form_used from public, anon, authenticated;

create or replace function skyline_private.application_form_record() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  -- rule-policy: technical application-form-record The default Application form at the moment of submission prints that submission, always.
  insert into public.application_form_used(application_id, version, template_id, template_version, template_name, title, header_html, body_html, footer_html)
  select new.application_id, new.version, t.id, t.version, t.name, t.title, t.header_html, coalesce(t.body_html, ''), t.footer_html
    from hr.sign_templates t where t.category = 'application_form' and t.is_default and t.status = 'active' and t.deleted_at is null and coalesce(t.body_html, '') <> ''
  on conflict do nothing;
  return null;
end $$;
revoke all on function skyline_private.application_form_record() from public, anon, authenticated;
drop trigger if exists application_form_record on public.enrollment_application_versions;
create trigger application_form_record after insert on public.enrollment_application_versions
  for each row execute function skyline_private.application_form_record();

-- Every submission already made: the standard template (one-off).
insert into public.application_form_used(application_id, version, template_id, template_version, template_name, title, header_html, body_html, footer_html)
select v.application_id, v.version, t.id, t.version, t.name, t.title, t.header_html, t.body_html, t.footer_html
  from public.enrollment_application_versions v
  cross join lateral (select * from hr.sign_templates x where x.category = 'application_form' and x.is_default and x.deleted_at is null limit 1) t
on conflict do nothing;

-- The institute's details for the printout (Website Settings; the logo is a URL the printer turns into a picture).
create or replace function skyline_private.application_form_institute(p_tenant uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('name', c.name, 'legalName', c.legal_name, 'address', c.address, 'phone', c.phone, 'email', c.email, 'website', c.website,
    'rto', c.rto, 'cricos', c.cricos, 'abn', c.abn, 'logoUrl', c.logo)
    from public.cms_settings c where c.tenant_id is not distinct from p_tenant order by c.id limit 1;
$$;
revoke all on function skyline_private.application_form_institute(uuid) from public, anon, authenticated;

-- 4. The Review & signature card / Download: what was signed, the template it prints from, the institute.
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
    'formTemplate', (select jsonb_build_object('id', u.template_id, 'version', u.template_version, 'name', u.template_name, 'title', u.title,
        'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html)
      from public.application_form_used u where u.application_id = p_application and u.version = v_version),
    'institute', skyline_private.application_form_institute(a.tenant_id),
    'submission', case when v_snap is null then null else jsonb_build_object('reference', a.reference, 'submittedAt', coalesce(a.submitted_at, v_at),
      'version', v_version, 'snapshot', (v_snap - 'submission' - 'fieldProvenance' - 'wizard' - 'preparedBy')
        || case when jsonb_typeof(v_snap -> 'submission') = 'object' then jsonb_build_object('submission', (v_snap -> 'submission') - 'actor' - 'consentIds' - 'ip' - 'userAgent') else '{}'::jsonb end) end);
end $$;
revoke all on function public.application_signed_copy(uuid) from public, anon;
grant execute on function public.application_signed_copy(uuid) to authenticated;

-- The email worker prints the same template (and stores that copy for the portal).
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
    'storeCopy', v_store,
    'formTemplate', (select jsonb_build_object('id', u.template_id, 'version', u.template_version, 'name', u.template_name, 'title', u.title,
        'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html)
      from public.application_form_used u where u.application_id = d.application_id and u.version = v_version),
    'institute', skyline_private.application_form_institute(d.tenant_id));
end;
$function$;

commit;
