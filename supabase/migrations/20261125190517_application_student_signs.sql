-- APPLICATION-STUDENT-SIGNS (owner, 2026-11-25): an agent fills an application, only the student signs.
--   1. Only the student (their own portal account), or a parent / guardian when the student is under 18, consents and submits.
--      portal_submit_v2 / portal_application_resubmit refuse agents, agency admins and staff. Each declaration is ticked on its own
--      and recorded with the signer, IP, user agent, text version and a SHA-256 hash of the exact text shown
--      (public.application_declaration_texts). Earlier consent rows stay readable.
--   2. While the application is with the student the agent is view-only (portal_can_edit_application, portal_lock_draft and so every
--      save path). Take back (before submit) revokes the invite and returns editing to the agent. Resend = the existing invite.
--   3. The student may edit everything except agency / agent, course, intake and fees (refused by portal_save_draft_v2).
--   4. Request a change: a note to the agent, the invite paused, the student read-only until the agent sends again.
--   5. Every invite needs a portal account with a password or Google sign-in for the invited email (portal_wizard_invite_accept).
--      Invites also work for Action required (resubmission). Guest links stay for missing documents only (guest_link_resolve:
--      action_required only, unchanged).
--   6. Under 18 at signing (date of birth): the student names a parent / guardian, who gets an email link, a one-time code, the same
--      declarations, and signs; the application is submitted only when both have signed.
--   The application is snapshotted when it is sent to the student; after submission the agent sees a field-level diff.
--   Timeline: skyline_private.application_handoff_events (+ portal_audit_log). Notifications: notification_deliveries (email-sender).

-- ---------------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.application_declaration_texts (
  key text not null check (key in ('esos_written_agreement', 'ncver_privacy_declaration', 'usi_permission')),
  version text not null,
  title text not null,
  body text not null,
  sort smallint not null default 0,
  active boolean not null default true,
  hash text not null default '',
  created_at timestamptz not null default now(),
  primary key (key, version)
);
-- The hash is always the SHA-256 of the body as stored (UTF-8), never a value a caller supplies.
create or replace function skyline_private.declaration_text_hash() returns trigger language plpgsql set search_path to '' as $$
begin new.hash := encode(sha256(convert_to(new.body, 'UTF8')), 'hex'); return new; end $$;
drop trigger if exists application_declaration_texts_hash on public.application_declaration_texts;
create trigger application_declaration_texts_hash before insert or update on public.application_declaration_texts
  for each row execute function skyline_private.declaration_text_hash();
create unique index if not exists application_declaration_texts_one_active on public.application_declaration_texts(key) where active;
alter table public.application_declaration_texts enable row level security;
drop policy if exists application_declaration_texts_read on public.application_declaration_texts;
create policy application_declaration_texts_read on public.application_declaration_texts for select to authenticated using (true);
revoke insert, update, delete on public.application_declaration_texts from anon, authenticated;
grant select on public.application_declaration_texts to authenticated;

insert into public.application_declaration_texts(key, version, title, body, sort) values
('esos_written_agreement', '2026-11-25', 'Written agreement (ESOS)',
'I accept this application, the letter of offer that SLIT will issue and SLIT''s policies as my written agreement with Skyline Institute of Technology (SLIT) under the Education Services for Overseas Students (ESOS) Act 2000 and the National Code 2018.
I have read and understand the description of the course(s) I am applying for, the tuition and non-tuition fees, the payment schedule, and SLIT''s fees and refund policy as set out in the Student Handbook.
I agree to pay the applicable fees and I am personally liable for any fees owing. I understand that SLIT may use an external debt collection agency and that I will be liable for any charges of such an agency.
I acknowledge that SLIT reserves the right to change a course, subject, admission requirement or fee, as its policies allow.
I have read and understand the ESOS framework made available at https://internationaleducation.gov.au/regulatory-information/pages/regulatoryinformation.aspx.
I authorise SLIT to access the Australian immigration Visa Entitlements Verification Online (VEVO) system at any time to obtain information on my visa status.', 1),
('ncver_privacy_declaration', '2026-11-25', 'Privacy notice (NCVER) and student declaration',
'Privacy notice. Under the Data Provision Requirements 2020, SLIT is required to collect personal information about you and to disclose that personal information to the National Centre for Vocational Education Research Ltd (NCVER).
Your personal information (including the personal information contained in this application and your training activity data) may be used or disclosed by SLIT for statistical, regulatory and research purposes. SLIT may disclose your personal information for these purposes to third parties, including: Commonwealth and State or Territory government departments and authorised agencies; NCVER; organisations conducting student surveys; and researchers.
Personal information disclosed to NCVER may be used or disclosed for the following purposes: populating authenticated VET transcripts; administration of VET, including program administration, regulation, monitoring and evaluation; facilitation of statistics and research relating to education, including surveys and data linkage; and understanding how the VET market operates, for policy, workforce planning and consumer information.
NCVER will handle your personal information in accordance with the Privacy Act 1988 (Cth), the National VET Data Policy and all NCVER policies and protocols (including those published on NCVER''s website at www.ncver.edu.au). You may receive a student survey which may be run by a government department or an NCVER employee, agent, third-party contractor or another authorised agency. You may opt out of the survey at the time of being contacted. For more information about NCVER''s Privacy Policy go to https://www.ncver.edu.au/privacy.
Student declaration. I declare that the information I have provided in this application and the documents supporting it is true and complete. I understand that failing to provide a document or disclose my academic record may lead SLIT to revoke an offer or end my studies. I authorise SLIT to verify my qualifications and work experience, and I will provide original documents at enrolment. I consent to the collection, use and disclosure of my personal information in accordance with the privacy notice above, and I will tell SLIT in writing of any change of address or contact details within 5 working days.', 2),
('usi_permission', '2026-11-25', 'Unique Student Identifier (USI)',
'I consent to SLIT using and providing my Unique Student Identifier (USI) for enrolment, reporting and verification purposes where required, and, if I do not have a USI, to SLIT applying for one on my behalf.', 3)
on conflict (key, version) do nothing;

alter table public.enrollment_application_consents
  add column if not exists signer_role text check (signer_role in ('student', 'guardian')),
  add column if not exists signer_user_id uuid,
  add column if not exists declaration_key text,
  add column if not exists text_version text,
  add column if not exists text_hash text check (text_hash is null or text_hash ~ '^[a-f0-9]{64}$'),
  add column if not exists ip text,
  add column if not exists user_agent text,
  add column if not exists guardian_name text,
  add column if not exists guardian_relationship text,
  add column if not exists guardian_email text;
comment on column public.enrollment_application_consents.text_hash is
  'SHA-256 (hex) of the exact declaration text shown to the signer (public.application_declaration_texts.hash).';

create table if not exists skyline_private.application_handoffs (
  application_id uuid primary key references public.enrollment_applications(id) on delete cascade,
  state text not null check (state in ('with_agent', 'with_student', 'change_requested', 'waiting_guardian', 'submitted')),
  sent_at timestamptz,
  sent_by uuid,
  sent_snapshot jsonb,
  opened_at timestamptz,
  last_saved_at timestamptz,
  change_note text,
  change_requested_at timestamptz,
  signed_at timestamptz,
  signed_by uuid,
  signed_by_name text,
  finalize_kind text check (finalize_kind in ('submit', 'resubmit')),
  request_key text,
  finalize_note text,
  submitted_at timestamptz,
  taken_back_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists skyline_private.application_handoff_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  event text not null,
  actor uuid,
  actor_role text,
  actor_name text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists application_handoff_events_app on skyline_private.application_handoff_events(application_id, created_at);

create table if not exists skyline_private.application_guardian_requests (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  name text not null,
  relationship text not null,
  email text not null,
  mobile text not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('sending', 'sent', 'failed', 'signed', 'revoked')),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  verified_until timestamptz,
  signed_at timestamptz
);
create index if not exists application_guardian_requests_app on skyline_private.application_guardian_requests(application_id, created_at desc);

create table if not exists skyline_private.application_guardian_codes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references skyline_private.application_guardian_requests(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists application_guardian_codes_req on skyline_private.application_guardian_codes(request_id, created_at desc);

revoke all on skyline_private.application_handoffs, skyline_private.application_handoff_events,
  skyline_private.application_guardian_requests, skyline_private.application_guardian_codes from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------------------
-- Values the student sees but cannot change (agency / agent, course, intake, fees): "Request a change" instead.
create or replace function skyline_private.handoff_view_only_fields() returns text[]
language sql immutable set search_path to '' as $$
  select array['via_agent', 'agent_agency', 'agent_contact_name', 'agent_email', 'agent_phone', 'courses_of_interest', 'course',
    'preferred_intake', 'intake_id', 'intake_join_date', 'intake_note', 'study_load', 'tuition_fee', 'fees']::text[];
$$;

create or replace function skyline_private.is_application_student(p_application uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select auth.uid() is not null and exists(select 1 from public.enrollment_applications a
    where a.id = p_application and a.student_id is not null and a.student_id = public.portal_student_id());
$$;

create or replace function skyline_private.handoff_state(p_application uuid) returns text
language sql stable security definer set search_path to '' as $$
  select h.state from skyline_private.application_handoffs h where h.application_id = p_application;
$$;

-- True when the handoff takes editing away from the caller: the agent / staff while it is with the student (or waiting for the
-- guardian); the student while it is back with the agent, a change is requested, or it waits for the guardian.
create or replace function skyline_private.handoff_blocks_edit(p_application uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select case when skyline_private.is_application_student(p_application)
      then h.state in ('with_agent', 'change_requested', 'waiting_guardian')
      else h.state in ('with_student', 'waiting_guardian') end
    from skyline_private.application_handoffs h where h.application_id = p_application), false);
$$;

create or replace function skyline_private.handoff_actor_role(p_application uuid) returns text
language sql stable security definer set search_path to '' as $$
  select case when auth.uid() is null then 'system'
    when skyline_private.is_application_student(p_application) then 'student'
    when public.portal_is_slit_admin() then 'slit_admin'
    when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end;
$$;

create or replace function skyline_private.handoff_actor_name() returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((select nullif(p.full_name, '') from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1),
    (select nullif(c.name, '') from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'System');
$$;

create or replace function skyline_private.handoff_log(p_application uuid, p_event text, p_detail jsonb default '{}'::jsonb,
  p_role text default null, p_name text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare a public.enrollment_applications; v_role text := coalesce(p_role, skyline_private.handoff_actor_role(p_application));
  v_name text := coalesce(p_name, skyline_private.handoff_actor_name());
begin
  select * into a from public.enrollment_applications where id = p_application;
  insert into skyline_private.application_handoff_events(application_id, event, actor, actor_role, actor_name, detail)
  values (p_application, p_event, auth.uid(), v_role, v_name, coalesce(p_detail, '{}'::jsonb));
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), v_name, v_role, 'handoff_' || p_event, 'application', p_application::text, p_application, a.agency_id, a.tenant_id, coalesce(p_detail, '{}'::jsonb));
end $$;

-- One email through the existing queue (email-sender sends it; HTML made by notification_delivery_html).
-- p_to: 'agent' (assigned agent, else the agent who started it) or 'student' (the student record's email).
create or replace function skyline_private.handoff_notify(p_application uuid, p_event text, p_to text, p_subject text, p_body text)
returns void language plpgsql security definer set search_path to '' as $$
declare a public.enrollment_applications; p public.portal_profiles; v_addr text; v_user uuid; v_active boolean; v_valid boolean; v_host text; v_link text;
begin
  select * into a from public.enrollment_applications where id = p_application;
  if not found then return; end if;
  if p_to = 'agent' then
    select * into p from public.portal_profiles x where x.id = a.assigned_agent_id and x.status = 'Active' and coalesce(btrim(x.email), '') <> '';
    if not found then
      select * into p from public.portal_profiles x where x.id = a.created_by and x.status = 'Active'
        and exists(select 1 from public.agency_memberships m where m.user_id = x.id and m.role in ('agent', 'agency_admin'));
    end if;
    if p.id is null then return; end if;
    v_addr := lower(btrim(coalesce(p.email, ''))); v_user := p.auth_user_id;
  else
    select lower(btrim(coalesce(nullif(s.email, ''), a.student_email, ''))) into v_addr
      from (select 1) one left join public.enrollment_students s on s.id = a.student_id;
  end if;
  v_valid := coalesce(v_addr, '') ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(v_addr) <= 254;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from a.tenant_id);
  v_host := case when a.tenant_id is null then public.main_site_host()
    else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = a.tenant_id and t.verified_at is not null) end;
  v_link := case when v_host is null then '' else E'\n\nOpen the application (sign-in required): https://' || v_host || '/agency/applications/' || a.id::text end;
  insert into public.notification_deliveries(tenant_id, application_id, recipient_user, recipient_email, event, template_source, subject, body, state, state_reason, created_at)
  values (a.tenant_id, a.id, v_user, left(coalesce(v_addr, ''), 254), p_event, 'default', left(p_subject, 300), p_body || v_link,
    case when v_valid and v_active then 'pending' else 'suppressed' end,
    case when not v_valid then 'invalid_recipient' when not v_active then 'legacy_scope_not_activated' end, clock_timestamp());
end $$;

create or replace function skyline_private.application_label(a public.enrollment_applications) returns text
language sql stable set search_path to '' as $$
  select coalesce(nullif(btrim(a.student_name), ''), 'the student') || ' (' || coalesce(nullif(a.reference, ''), left(a.id::text, 8)) || ')';
$$;

create or replace function skyline_private.application_snapshot(p_application uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select public.application_data(p_application) || jsonb_build_object('courses',
    (select coalesce(jsonb_agg(jsonb_build_object('courseId', c.course_id, 'code', c.course_code, 'title', c.course_title,
       'variant', c.variant, 'intakeId', c.intake_id) order by c.course_id, c.variant), '[]'::jsonb)
     from public.enrollment_application_courses c where c.application_id = p_application));
$$;

-- The caller's IP and browser from the PostgREST request headers (empty outside an API request).
create or replace function skyline_private.request_ip() returns text language sql stable set search_path to '' as $$
  select left(btrim(split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb->>'cf-connecting-ip',
    nullif(current_setting('request.headers', true), '')::jsonb->>'x-forwarded-for',
    nullif(current_setting('request.headers', true), '')::jsonb->>'x-real-ip', ''), ',', 1)), 64);
$$;
create or replace function skyline_private.request_user_agent() returns text language sql stable set search_path to '' as $$
  select left(coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'user-agent', ''), 500);
$$;

-- Age in whole years on the Melbourne date today, from the application's date of birth (YYYY-MM-DD or DD/MM/YYYY).
create or replace function skyline_private.application_age(p_application uuid) returns int
language plpgsql stable security definer set search_path to '' as $$
declare v text; d date;
begin
  select btrim(coalesce(public.application_data(p_application)#>>'{values,dob}', '')) into v;
  begin
    if v ~ '^\d{4}-\d{2}-\d{2}' then d := left(v, 10)::date;
    elsif v ~ '^\d{1,2}/\d{1,2}/\d{4}$' then d := to_date(v, 'DD/MM/YYYY');
    end if;
  exception when others then d := null; end;
  if d is null then return null; end if;
  return extract(year from age((clock_timestamp() at time zone public.institution_tz())::date, d))::int;
end $$;

-- Records one consent row per active declaration. p_declarations = {key: hash of the text shown}; every active declaration must be
-- ticked with the hash of its current text (so the text recorded is exactly the text shown).
create or replace function skyline_private.record_declarations(p_application uuid, p_declarations jsonb, p_role text, p_user uuid,
  p_name text, p_ip text, p_user_agent text, p_guardian jsonb default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare t public.application_declaration_texts; ids jsonb := '[]'::jsonb; v_id uuid;
begin
  if jsonb_typeof(p_declarations) is distinct from 'object' then
    raise exception 'Tick each declaration before signing' using errcode = '22023';
  end if;
  for t in select * from public.application_declaration_texts where active order by sort loop
    if p_declarations->>t.key is null then
      raise exception 'Tick each declaration before signing: %', t.title using errcode = '22023';
    end if;
    if p_declarations->>t.key is distinct from t.hash then
      raise exception 'The declaration "%" has changed. Reload the page and read it again before signing', t.title using errcode = '22023';
    end if;
    insert into public.enrollment_application_consents(application_id, method, signed_document_ref, declaration_version, recorded_by, recorded_by_name,
      signer_role, signer_user_id, declaration_key, text_version, text_hash, ip, user_agent, guardian_name, guardian_relationship, guardian_email)
    values (p_application, 'electronic', '', t.version, p_user, left(coalesce(nullif(p_name, ''), 'Student'), 200),
      p_role, p_user, t.key, t.version, t.hash, nullif(p_ip, ''), nullif(p_user_agent, ''),
      p_guardian->>'name', p_guardian->>'relationship', p_guardian->>'email')
    returning id into v_id;
    ids := ids || to_jsonb(v_id);
  end loop;
  return ids;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Edit locks
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.portal_can_edit_application(app_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $function$
  select auth.uid() is not null and public.portal_can_access_application(app_id)
    and public.application_student_active(app_id)
    and exists(select 1 from public.enrollment_applications a where a.id=app_id
      and (public.portal_is_slit_admin() or a.status in ('draft','action_required')))
    and not skyline_private.handoff_blocks_edit(app_id);
$function$;

create or replace function public.portal_lock_draft(p_application_id uuid, p_expected_version bigint)
 returns enrollment_applications language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) or a.status not in ('draft','action_required') then
  raise exception 'Application is not editable' using errcode='42501'; end if;
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

create or replace function public.portal_save_draft_v2(p_application_id uuid, p_expected_version bigint, p_patch jsonb)
 returns bigint language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications; d jsonb; v bigint; c jsonb; course public.cms_courses; v_intake public.course_intakes; v_intake_id uuid; v_intake_label text;
 v_student_handoff boolean; k text; v_now jsonb; v_before jsonb;
begin
 a:=public.portal_lock_draft(p_application_id,p_expected_version);
 if jsonb_typeof(p_patch) is distinct from 'object' or p_patch-array['values','courses','savedAt','preparedBy','progress','wizard','academicQualifications']<>'{}'::jsonb
 or octet_length(p_patch::text)>500000 or p_patch ? 'values' and jsonb_typeof(p_patch->'values')<>'object' then
  raise exception 'Invalid draft fields' using errcode='22023'; end if;
 if p_patch->'values' ? 'email' and (public.portal_student_id() is not null or a.status = 'draft')
    and not exists(select 1 from public.enrollment_students s where s.id = a.student_id
      and lower(btrim(s.email)) = lower(btrim(p_patch#>>'{values,email}'))) then
   raise exception 'Use Finish Application to correct the student sign-in email' using errcode = '42501';
 end if;
 -- APPLICATION-STUDENT-SIGNS: on an application an agent sent, the student cannot change agency / agent, course, intake or fees.
 v_student_handoff := skyline_private.is_application_student(a.id) and skyline_private.handoff_state(a.id) is not null;
 if v_student_handoff then
  foreach k in array skyline_private.handoff_view_only_fields() loop
   if p_patch->'values' ? k and coalesce(p_patch->'values'->>k, '') is distinct from coalesce(a.data->'values'->>k, '') then
    raise exception 'Your agent set the agency, course, intake and fees. Use Request a change to ask for a change' using errcode='42501';
   end if;
  end loop;
  if p_patch ? 'courses' then
   select coalesce(jsonb_agg(jsonb_build_object('c', x->>'courseId', 'i', coalesce(nullif(x->>'intakeId', ''), ''), 'v', coalesce(x->>'variant', ''))
     order by x->>'courseId', coalesce(x->>'variant', ''), coalesce(x->>'intakeId', '')), '[]'::jsonb) into v_now
     from jsonb_array_elements(case when jsonb_typeof(p_patch->'courses') = 'array' then p_patch->'courses' else '[]'::jsonb end) x;
   select coalesce(jsonb_agg(jsonb_build_object('c', r.course_id, 'i', coalesce(r.intake_id::text, ''), 'v', coalesce(r.variant, ''))
     order by r.course_id, coalesce(r.variant, ''), coalesce(r.intake_id::text, '')), '[]'::jsonb) into v_before
     from public.enrollment_application_courses r where r.application_id = a.id;
   if v_now is distinct from v_before then
    raise exception 'Your agent set the agency, course, intake and fees. Use Request a change to ask for a change' using errcode='42501';
   end if;
  end if;
 end if;
 d:=coalesce(a.data,'{}') || (p_patch-'values'-'wizard')
   || jsonb_build_object('savedAt', clock_timestamp(), 'preparedBy', auth.uid());
 if p_patch ? 'values' then d:=jsonb_set(d,'{values}',coalesce(a.data->'values','{}')||(p_patch->'values')); end if;
 if p_patch ? 'wizard' then d:=jsonb_set(d,'{wizard}',coalesce(a.data->'wizard','{}')||(p_patch->'wizard')); end if;
 if p_patch ? 'courses' then
  if jsonb_typeof(p_patch->'courses')<>'array' or jsonb_array_length(p_patch->'courses')>30 then raise exception 'Invalid courses' using errcode='22023'; end if;
  delete from public.enrollment_application_courses where application_id=a.id;
  for c in select value from jsonb_array_elements(p_patch->'courses') loop
   v_intake_id:=null;
   if nullif(c->>'intakeId','') is not null then
    begin v_intake_id:=(c->>'intakeId')::uuid; exception when others then raise exception 'Invalid intake' using errcode='22023'; end;
   end if;
   if a.tenant_id is not null then
    select * into course from public.cms_courses where id=c->>'courseId' and tenant_id=a.tenant_id and public.portal_course_options() @> jsonb_build_array(jsonb_build_object('courseId', c->>'courseId'));
    if not found then raise exception 'Course is not published for this institution' using errcode='23503'; end if;
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant,intake_id)
    values(a.id,course.id,course.code,course.name,coalesce(c->>'variant',''),v_intake_id);
   else
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant,intake_id)
    values(a.id,c->>'courseId',c->>'code',c->>'title',coalesce(c->>'variant',''),v_intake_id);
   end if;
   -- The intake's own label is what the application records (the first course's intake), never the text the client sent.
   if v_intake_id is not null and v_intake_label is null then
    select * into v_intake from public.course_intakes where id=v_intake_id;
    v_intake_label:=public.course_intake_display(v_intake);
   end if;
  end loop;
  if v_intake_label is not null then d:=jsonb_set(d,'{values}',coalesce(d->'values','{}')||jsonb_build_object('preferred_intake',v_intake_label)); end if;
 end if;
 update public.enrollment_applications set data=d,
 student_name=coalesce(nullif(concat_ws(' ',d#>>'{values,first_name}',d#>>'{values,last_name}'),''),a.student_name),
 student_email=coalesce(d#>>'{values,email}',a.student_email),intake=coalesce(d#>>'{values,preferred_intake}',a.intake),
 completion=case when d#>>'{progress,overall}' ~ '^\d{1,3}$' then least(100,(d#>>'{progress,overall}')::integer) else a.completion end,
 updated_at=clock_timestamp() where id=a.id returning draft_version into v;
 if v_student_handoff then
  update skyline_private.application_handoffs set last_saved_at = clock_timestamp(), updated_at = clock_timestamp() where application_id = a.id;
 end if;
 return v;
end; $function$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Submission (student only)
-- ---------------------------------------------------------------------------------------------------------------------------
-- The submission itself (shared by the student's signature and, under 18, the guardian's). The caller checked who signs.
create or replace function skyline_private.application_finalize(p_application uuid, p_actor uuid, p_actor_name text,
  p_kind text, p_request_key text, p_consent_ids jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare a public.enrollment_applications; r public.admission_submission_receipts; snap jsonb; v integer; v_from text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 v_from := a.status;
 if p_kind = 'submit' then
  if a.status <> 'draft' then raise exception 'Application is not awaiting submission' using errcode='PT409'; end if;
  select coalesce(max(version),0)+1 into v from public.enrollment_application_versions where application_id=a.id;
  snap:=public.application_data(a.id)||jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.enrollment_application_courses c where application_id=a.id),
   'submission',jsonb_build_object('actor',p_actor,'declarationVersion','2026-11-25','consentIds',coalesce(p_consent_ids,'[]'::jsonb),'draftVersion',a.draft_version));
  perform set_config('portal.status_command',a.id::text,true);
  update public.enrollment_applications set status='submitted',submitted_at=now(),submitted_by=p_actor,completion=100,
   reference=coalesce(nullif(a.reference,''),public.portal_next_application_reference()),version=v where id=a.id returning * into a;
  insert into public.enrollment_application_versions(application_id,version,snapshot,created_by,created_by_name)
  values(a.id,v,snap,p_actor,coalesce(p_actor_name,'Student'));
  insert into public.admission_submission_receipts(application_id,tenant_id,version,request_key,reference,actor)
  values(a.id,a.tenant_id,v,p_request_key,a.reference,p_actor) returning * into r;
  insert into public.admission_event_outbox(receipt_id,application_id,tenant_id,event,payload)
  values(r.id,a.id,a.tenant_id,'application_submitted',jsonb_build_object('receiptId',r.id,'reference',a.reference,'version',v));
  insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
  values(p_actor,coalesce(p_actor_name,'Student'),'student','application_submitted','application',a.id::text,a.id,jsonb_build_object('receiptId',r.id,'version',v));
 else
  if a.status <> 'action_required' then raise exception 'Only an application that needs action can be resubmitted' using errcode='22023'; end if;
  select coalesce(max(version),0)+1 into v from public.enrollment_application_versions where application_id=a.id;
  snap:=public.application_data(a.id)||jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.enrollment_application_courses c where application_id=a.id),
   'submission',jsonb_build_object('actor',p_actor,'declarationVersion','2026-11-25','consentIds',coalesce(p_consent_ids,'[]'::jsonb),'resubmit',true));
  insert into public.enrollment_application_versions(application_id,version,snapshot,created_by,created_by_name)
  values(a.id,v,snap,p_actor,coalesce(p_actor_name,'Student'));
  perform set_config('portal.status_command', a.id::text, true);
  perform set_config('portal.status_note', left(coalesce(nullif(btrim(p_note), ''), 'Resubmitted after corrections'), 500), true);
  update public.enrollment_applications set status = 'submitted', version = v where id = a.id;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (p_actor, coalesce(p_actor_name, 'Student'), 'student', 'status_change', 'application', a.id::text, a.id,
    jsonb_build_object('from', v_from, 'to', 'submitted', 'note', left(coalesce(p_note, ''), 500), 'consentRecorded', true));
  insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
  values (a.id, a.tenant_id, 'application_status_changed', jsonb_build_object('from', v_from, 'to', 'submitted', 'actor', p_actor));
 end if;
 update skyline_private.application_handoffs set state = 'submitted', submitted_at = clock_timestamp(), updated_at = clock_timestamp()
   where application_id = a.id;
 if found then
  perform skyline_private.handoff_log(a.id, 'submitted', jsonb_build_object('version', v), 'student', p_actor_name);
  perform skyline_private.handoff_notify(a.id, 'handoff_submitted', 'agent', 'Submitted: ' || skyline_private.application_label(a),
    'The student signed and submitted the application ' || skyline_private.application_label(a) || '. Open it to see what the student changed.');
 end if;
 if r.id is not null then return to_jsonb(r); end if;
 return jsonb_build_object('application_id', a.id, 'version', v, 'state', 'submitted');
end $$;

-- The student signs. Adult: submitted now. Under 18: waits for the parent / guardian (state waiting_guardian).
create or replace function skyline_private.student_sign(a public.enrollment_applications, p_kind text, p_request_key text,
  p_consent jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_age int; v_ids jsonb; v_name text := skyline_private.handoff_actor_name(); v_state text;
begin
 if not skyline_private.is_application_student(a.id) then
  raise exception 'Only the student can sign and submit this application. Send it to the student to review and sign' using errcode='42501';
 end if;
 v_age := skyline_private.application_age(a.id);
 if v_age is null then raise exception 'Enter the date of birth before signing' using errcode='22023'; end if;
 v_ids := skyline_private.record_declarations(a.id, p_consent->'declarations', 'student', auth.uid(), v_name,
   skyline_private.request_ip(), skyline_private.request_user_agent());
 if p_consent->'declarations' ? 'usi_permission' then perform public.usi_consent_set(a.id, true, false); end if;
 v_state := skyline_private.handoff_state(a.id);
 if v_state is null then
  insert into skyline_private.application_handoffs(application_id, state) values (a.id, 'with_student');
 end if;
 update skyline_private.application_handoffs set signed_at = clock_timestamp(), signed_by = auth.uid(), signed_by_name = v_name,
   finalize_kind = p_kind, request_key = p_request_key, finalize_note = p_note, updated_at = clock_timestamp(),
   state = case when v_age < 18 then 'waiting_guardian' else state end
   where application_id = a.id;
 perform skyline_private.handoff_log(a.id, 'signed', jsonb_build_object('age', v_age, 'consentIds', v_ids, 'needsGuardian', v_age < 18));
 perform skyline_private.handoff_notify(a.id, 'handoff_signed', 'agent', 'Signed by the student: ' || skyline_private.application_label(a),
   'The student signed the application ' || skyline_private.application_label(a) || '.'
   || case when v_age < 18 then ' The student is under 18, so it is submitted once their parent or guardian signs.' else '' end);
 if v_age < 18 then
  return jsonb_build_object('application_id', a.id, 'state', 'waiting_guardian');
 end if;
 return skyline_private.application_finalize(a.id, auth.uid(), v_name, p_kind, p_request_key, v_ids, p_note);
end $$;

create or replace function public.portal_submit_v2(p_application_id uuid, p_expected_version bigint, p_request_key text, p_consent jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications; r public.admission_submission_receipts;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) then raise exception 'Submission not authorized' using errcode='42501'; end if;
 if nullif(btrim(p_request_key),'') is null or length(p_request_key)>200 then raise exception 'Submission request key required' using errcode='22023'; end if;
 select * into r from public.admission_submission_receipts where application_id=a.id and request_key=p_request_key;
 if found then return to_jsonb(r); end if;
 -- The same signature again while the parent / guardian has not signed yet.
 if exists(select 1 from skyline_private.application_handoffs h where h.application_id = a.id and h.state = 'waiting_guardian' and h.request_key = p_request_key) then
  return jsonb_build_object('application_id', a.id, 'state', 'waiting_guardian');
 end if;
 if a.status <> 'draft' then
  select * into r from public.admission_submission_receipts where application_id=a.id order by version desc limit 1;
  if found then return to_jsonb(r); end if;
  raise exception 'Application is not awaiting submission' using errcode='PT409';
 end if;
 -- APPLICATION-STUDENT-SIGNS: only the student's own portal account signs (agents, agency admins and staff are refused).
 if not skyline_private.is_application_student(a.id) then
  raise exception 'Only the student can sign and submit this application. Send it to the student to review and sign' using errcode='42501';
 end if;
 perform public.portal_lock_draft(a.id,p_expected_version);
 perform public.portal_validate_submission(a.id);
 return skyline_private.student_sign(a, 'submit', p_request_key, p_consent);
end; $function$;

create or replace function public.portal_application_resubmit(p_application uuid, p_note text default ''::text, p_consent jsonb default null::jsonb)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications; t public.application_status_transitions;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_edit_application(a.id) then
  raise exception 'Application not found' using errcode = '42501';
 end if;
 -- APPLICATION-STUDENT-SIGNS: resubmission is signed by the student (agents, agency admins and staff are refused).
 if not skyline_private.is_application_student(a.id) then
  raise exception 'Only the student can sign and resubmit this application. Send it to the student to review and sign' using errcode = '42501';
 end if;
 select * into t from public.application_status_transitions x where x.from_status = a.status and x.kind = 'resubmit' and x.is_active limit 1;
 if not found then raise exception 'Only an application that needs action can be resubmitted' using errcode = '22023'; end if;
 if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
 if p_consent is null then raise exception 'Tick each declaration before signing' using errcode = '22023'; end if;
 perform skyline_private.student_sign(a, 'resubmit', null, p_consent, p_note);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Invites (send to student / resend / accept)
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function skyline_private.reserve_student_application_invite(a enrollment_applications, email_address text, p_hash text, p_actor uuid)
 returns jsonb language plpgsql set search_path to '' as $function$
declare
  invitation uuid;
  expiry int;
  send_limit int;
  sender text;
  template jsonb;
begin
  select
  -- rule-policy: business admissions.application_invite_hours Read the published validity period for the application scope.
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_hours', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_hours', '{}')) #>> '{}')::int,
  -- rule-policy: business admissions.application_invite_resend_limit Read the published resend ceiling for the application scope.
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_resend_limit', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_resend_limit', '{}')) #>> '{}')::int,
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_sender', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_sender', '{}')) #>> '{}',
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_template', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_template', '{}'))
  into expiry, send_limit, sender, template;
  -- rule-policy: technical invitation-config-bounds Validate the supported range and required configuration already used by CRM.
  if expiry not between 1 and 720 or send_limit not between 1 and 30 or expiry is null or send_limit is null or not skyline_private.student_application_email_valid(sender)
     or coalesce(jsonb_typeof(template) <> 'object', true) then
    raise exception 'Publish the student invitation settings in Business Rules & Policies before sending' using errcode = '22023';
  end if;
  -- A timed-out Edge request may have reached the provider. A short lease prevents concurrent sends.
  update skyline_private.student_application_invites set state = 'failed'
  -- rule-policy: technical invitation-reservation-lease Recover a previously interrupted send through the existing fixed lease.
    where application_id = a.id and state = 'sending' and created_at < statement_timestamp() - interval '2 minutes';
  -- rule-policy: security invitation-reservation-concurrency Prevent overlapping attempts for the same application.
  if exists(select 1 from skyline_private.student_application_invites where application_id = a.id and state = 'sending') then
    raise exception 'An invitation is already sending. Check its status before trying again' using errcode = '22023';
  end if;
  -- rule-policy: business admissions.application_invite_resend_limit Enforce the published resend limit within its existing daily window.
  -- (APPLICATION-STUDENT-SIGNS: at most send_limit sends a day; the earlier check allowed one more.)
  if (select count(*) from skyline_private.student_application_invites where application_id = a.id
       and created_at >= statement_timestamp() - interval '1 day') >= send_limit then
    -- rule-policy: business admissions.application_invite_resend_limit Report that the configured daily limit has been reached.
    raise exception 'The configured daily resend limit has been reached' using errcode = '22023';
  end if;
  insert into skyline_private.student_application_invites(application_id, recipient, token_hash, state, created_by, expires_at)
  -- rule-policy: business admissions.application_invite_hours Set the token expiration from the published validity period.
    values (a.id, email_address, p_hash, 'sending', p_actor, statement_timestamp() + make_interval(hours => expiry))
    returning id into invitation;
  return jsonb_build_object('id', invitation, 'recipient', email_address, 'sender', sender, 'template', template);
end;
$function$;

create or replace function public.portal_wizard_invite_begin(p_application uuid, p_hash text, p_corrected_email text default null::text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  a public.enrollment_applications;
  s public.enrollment_students;
  email_address text;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  -- rule-policy: security invitation-crm-draft-scope Retain the verified actor and active draft (or Action required) checks.
  if auth.uid() is null or public.portal_student_id() is not null or a.id is null or not public.portal_can_access_application(a.id)
     or not public.application_student_active(a.id) or a.status not in ('draft', 'action_required')
     or (a.status = 'draft' and a.submitted_at is not null) then
    raise exception 'You cannot invite a student for this application' using errcode = '42501';
  end if;
  if skyline_private.handoff_state(a.id) = 'waiting_guardian' then
    raise exception 'The student has signed and the parent or guardian has not yet. Take it back first to send it again' using errcode = '22023';
  end if;
  select * into strict s from public.enrollment_students where id = a.student_id for update;
  email_address := lower(btrim(coalesce(p_corrected_email, s.email)));
  if not skyline_private.student_application_email_valid(email_address) then
    raise exception 'Enter a valid student email address before sending the invitation' using errcode = '22023';
  end if;
  if p_corrected_email is not null and email_address is distinct from s.email then
    if exists(select 1 from public.agency_memberships m where m.student_id = s.id) then
      raise exception 'Change the student’s linked sign-in email through the existing email change workflow' using errcode = '22023';
    end if;
    if skyline_private.handoff_state(a.id) = 'with_student' then
      raise exception 'Take the application back before changing the student email' using errcode = '22023';
    end if;
    -- Change the student first so the existing email propagation trigger runs outside an application UPDATE.
    perform set_config('portal.draft_command', a.id::text, true);
    update public.enrollment_students set email = email_address,
      details = coalesce(details, '{}'::jsonb) || jsonb_build_object('email', email_address, 'confirm_email', email_address)
      where id = s.id;
    select * into a from public.enrollment_applications where id = p_application;
    perform public.portal_wizard_save(a.id, a.draft_version, '{}', a.data->>'savedAt');
  end if;
  return skyline_private.reserve_student_application_invite(a, email_address, p_hash, auth.uid());
end;
$function$;

create or replace function public.portal_wizard_retry_failed_invite(p_failed_invitation uuid, p_hash text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  a public.enrollment_applications;
  prior skyline_private.student_application_invites;
  email_address text;
begin
  select e.* into a from public.enrollment_applications e
    join skyline_private.student_application_invites i on i.application_id = e.id
    where i.id = p_failed_invitation for update of e;
  -- rule-policy: security invitation-retry-lifecycle Require the original application to be an active draft (or Action required).
  if a.id is null or a.status not in ('draft', 'action_required') or (a.status = 'draft' and a.submitted_at is not null)
     or not public.application_student_active(a.id) or skyline_private.handoff_state(a.id) = 'waiting_guardian' then
    raise exception 'The application is unavailable for invitation retry' using errcode = '42501';
  end if;
  -- rule-policy: security invitation-retry-idempotency Resolve only the newest attempt while holding the application lock.
  select * into prior from skyline_private.student_application_invites
    where application_id = a.id order by created_at desc, id desc limit 1;
  -- rule-policy: security invitation-retry-idempotency Retry only the latest failed attempt while holding the application lock.
  if prior.id is distinct from p_failed_invitation or prior.state <> 'failed' then
    raise exception 'Only the latest failed invitation can be retried' using errcode = '22023';
  end if;
  select lower(btrim(s.email)) into email_address from public.enrollment_students s where s.id = a.student_id for update;
  if email_address is distinct from prior.recipient or not skyline_private.student_application_email_valid(email_address) then
    raise exception 'The student email changed. Start a new invitation from CRM' using errcode = '22023';
  end if;
  return skyline_private.reserve_student_application_invite(a, email_address, p_hash, prior.created_by);
end;
$function$;

-- Delivered: the application is now with the student (snapshot taken when it comes from the agent).
create or replace function public.portal_wizard_invite_delivered(p_invitation uuid, p_accepted boolean)
 returns boolean language plpgsql security definer set search_path to '' as $function$
declare app_id uuid; i skyline_private.student_application_invites; h skyline_private.application_handoffs; a public.enrollment_applications;
  v_agent_name text;
begin
  select application_id into app_id from skyline_private.student_application_invites where id = p_invitation;
  select * into a from public.enrollment_applications where id = app_id for update;
  update skyline_private.student_application_invites
    set state = case when p_accepted then 'sent' else 'failed' end,
    sent_at = case when p_accepted then clock_timestamp() else null end
    where id = p_invitation and state = 'sending' returning * into i;
  if not found then return false; end if;
  if p_accepted then
    update skyline_private.student_application_invites set state = 'revoked'
      where application_id = app_id and id <> p_invitation and state in ('sent', 'accepted');
    select coalesce(nullif(p.full_name, ''), p.email, 'Agent') into v_agent_name from public.portal_profiles p where p.auth_user_id = i.created_by limit 1;
    select * into h from skyline_private.application_handoffs where application_id = app_id for update;
    if h.application_id is null then
      insert into skyline_private.application_handoffs(application_id, state, sent_at, sent_by, sent_snapshot)
      values (app_id, 'with_student', clock_timestamp(), i.created_by, skyline_private.application_snapshot(app_id));
      perform skyline_private.handoff_log(app_id, 'sent', jsonb_build_object('recipient', i.recipient, 'expiresAt', i.expires_at), 'agent', v_agent_name);
    elsif h.state = 'with_student' then
      perform skyline_private.handoff_log(app_id, 'resent', jsonb_build_object('recipient', i.recipient, 'expiresAt', i.expires_at), 'agent', v_agent_name);
    else
      update skyline_private.application_handoffs set state = 'with_student', sent_at = clock_timestamp(), sent_by = i.created_by,
        sent_snapshot = skyline_private.application_snapshot(app_id), opened_at = null, signed_at = null, signed_by = null,
        signed_by_name = null, finalize_kind = null, request_key = null, submitted_at = null, updated_at = clock_timestamp()
        where application_id = app_id;
      perform skyline_private.handoff_log(app_id, 'sent', jsonb_build_object('recipient', i.recipient, 'expiresAt', i.expires_at,
        'afterChangeRequest', h.state = 'change_requested'), 'agent', v_agent_name);
      if h.state = 'change_requested' then
        perform skyline_private.handoff_notify(app_id, 'handoff_change_applied', 'student', 'Your agent updated your application',
          'Your agent has made the change you asked for and sent the application ' || skyline_private.application_label(a)
          || ' back to you to review and sign.' || coalesce(E'\n\nYou asked: ' || nullif(btrim(h.change_note), ''), ''));
      end if;
    end if;
  end if;
  return true;
end;
$function$;

-- Accept: the student signs in with a password or Google using the invited email (never a link alone).
create or replace function public.portal_wizard_invite_accept(p_token text)
 returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  a public.enrollment_applications;
  i skyline_private.student_application_invites;
  s public.enrollment_students;
  u auth.users;
  p public.portal_profiles;
  m public.agency_memberships;
  fingerprint text;
  first_open boolean;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'This invitation is invalid, expired, or no longer available' using errcode = '42501';
  end if;
  fingerprint := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into u from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if not found then raise exception 'Sign in with the invited email address' using errcode = '42501'; end if;
  select e.* into a from public.enrollment_applications e join skyline_private.student_application_invites x
    on x.application_id = e.id where x.token_hash = fingerprint for update of e;
  select * into i from skyline_private.student_application_invites where token_hash = fingerprint for update;
  select * into s from public.enrollment_students where id = a.student_id for update;
  if a.id is null or i.state not in ('sent', 'accepted') or i.expires_at <= statement_timestamp()
     or i.recipient is distinct from lower(btrim(u.email)) or i.recipient is distinct from lower(btrim(s.email))
     or a.status not in ('draft', 'action_required') or (a.status = 'draft' and a.submitted_at is not null) or s.status <> 'Active'
     or not public.tenant_scope(a.tenant_id)
     or public.cms_is_admin()
     or not exists (select 1 from public.agencies g where g.id = a.agency_id and public.agency_effective_status(g) = 'Active')
     or coalesce(skyline_private.handoff_state(a.id), 'with_student') <> 'with_student' then
    raise exception 'This invitation is invalid, expired, or no longer available' using errcode = '42501';
  end if;
  -- A portal account: a password, or Google with the invited email.
  if coalesce(u.encrypted_password, '') = '' and not exists(select 1 from auth.identities d where d.user_id = u.id and d.provider = 'google'
       and lower(btrim(coalesce(d.identity_data->>'email', ''))) = i.recipient) then
    raise exception 'Create your password (or sign in with Google) before opening the application' using errcode = '42501';
  end if;
  select * into p from public.portal_profiles where auth_user_id = u.id for update;
  if p.id is null then
    insert into public.portal_profiles(auth_user_id, email, full_name, status)
    values (u.id, i.recipient, coalesce(nullif(s.full_name, ''), split_part(i.recipient, '@', 1)), 'Active') returning * into p;
  end if;
  select * into m from public.agency_memberships where user_id = p.id for update;
  if p.status <> 'Active' or (m.user_id is not null and
    (m.role <> 'student' or m.student_id is distinct from s.id or m.agency_id is distinct from a.agency_id or m.status <> 'Active')) then
    raise exception 'This invitation is unavailable for the signed-in account' using errcode = '42501';
  end if;
  if m.user_id is null then
    insert into public.agency_memberships(user_id, agency_id, role, status, student_id)
      values (p.id, a.agency_id, 'student', 'Active', s.id);
  end if;
  first_open := i.state = 'sent';
  if first_open then
    update skyline_private.student_application_invites set state = 'accepted', accepted_at = clock_timestamp() where id = i.id;
    update skyline_private.application_handoffs set opened_at = coalesce(opened_at, clock_timestamp()), updated_at = clock_timestamp()
      where application_id = a.id;
    if found then
      perform skyline_private.handoff_log(a.id, 'accepted', jsonb_build_object('recipient', i.recipient), 'student', coalesce(nullif(p.full_name, ''), i.recipient));
      perform skyline_private.handoff_notify(a.id, 'handoff_accepted', 'agent', 'Opened by the student: ' || skyline_private.application_label(a),
        'The student accepted your invitation and opened the application ' || skyline_private.application_label(a) || ' to review and sign.');
    end if;
  end if;
  return a.id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Take back, request a change, timeline, diff, declarations
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.portal_application_take_back(p_application uuid)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare a public.enrollment_applications; h skyline_private.application_handoffs;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or a.id is null or not public.portal_can_access_application(a.id) or skyline_private.is_application_student(a.id)
     or public.portal_student_id() is not null then
    raise exception 'You cannot take this application back' using errcode = '42501';
  end if;
  select * into h from skyline_private.application_handoffs where application_id = a.id for update;
  if h.state is null or h.state not in ('with_student', 'waiting_guardian') then
    raise exception 'The application is not with the student' using errcode = '22023';
  end if;
  update skyline_private.student_application_invites set state = 'revoked' where application_id = a.id and state in ('sent', 'sending');
  update skyline_private.application_guardian_requests set state = 'revoked' where application_id = a.id and state in ('sent', 'sending');
  update skyline_private.application_handoffs set state = 'with_agent', taken_back_at = clock_timestamp(), signed_at = null, signed_by = null,
    signed_by_name = null, finalize_kind = null, request_key = null, updated_at = clock_timestamp() where application_id = a.id;
  perform skyline_private.handoff_log(a.id, 'taken_back', jsonb_build_object('from', h.state));
  perform skyline_private.handoff_notify(a.id, 'handoff_taken_back', 'student', 'Your agent has taken your application back',
    'Your agent has taken the application ' || skyline_private.application_label(a) || ' back to make changes. '
    || 'You do not need to do anything now: you will get an email when it is ready for you again. Anything you had not saved is kept on your device as a draft.');
  return jsonb_build_object('state', 'with_agent');
end $function$;

create or replace function public.portal_application_request_change(p_application uuid, p_note text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare a public.enrollment_applications; v_note text := btrim(coalesce(p_note, ''));
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if a.id is null or not skyline_private.is_application_student(a.id) then
    raise exception 'Only the student can request a change' using errcode = '42501';
  end if;
  if skyline_private.handoff_state(a.id) is distinct from 'with_student' then
    raise exception 'This application is not with you at the moment' using errcode = '22023';
  end if;
  if length(v_note) < 3 or length(v_note) > 2000 then
    raise exception 'Write what should change (up to 2000 characters)' using errcode = '22023';
  end if;
  update skyline_private.student_application_invites set state = 'revoked' where application_id = a.id and state in ('sent', 'sending');
  update skyline_private.application_handoffs set state = 'change_requested', change_note = v_note, change_requested_at = clock_timestamp(),
    updated_at = clock_timestamp() where application_id = a.id;
  perform skyline_private.handoff_log(a.id, 'change_requested', jsonb_build_object('note', v_note));
  perform skyline_private.handoff_notify(a.id, 'handoff_change_requested', 'agent', 'Change requested: ' || skyline_private.application_label(a),
    'The student asked for a change to the application ' || skyline_private.application_label(a) || E':\n\n' || v_note
    || E'\n\nMake the change, then send it to the student again.');
  return jsonb_build_object('state', 'change_requested');
end $function$;

create or replace function public.portal_application_declarations()
 returns jsonb language sql stable security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'title', t.title, 'body', t.body, 'version', t.version, 'hash', t.hash) order by t.sort), '[]'::jsonb)
  from public.application_declaration_texts t where t.active;
$function$;

create or replace function public.portal_application_handoff(p_application uuid)
 returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'state', h.state, 'role', case when skyline_private.is_application_student(a.id) then 'student' else 'agent' end,
    'sentAt', h.sent_at, 'openedAt', h.opened_at, 'lastSavedAt', h.last_saved_at, 'changeNote', h.change_note,
    'changeRequestedAt', h.change_requested_at, 'signedAt', h.signed_at, 'submittedAt', h.submitted_at, 'takenBackAt', h.taken_back_at,
    'viewOnlyFields', to_jsonb(skyline_private.handoff_view_only_fields()),
    'invite', (select jsonb_build_object('state', case when x.state in ('sent', 'sending') and x.expires_at <= statement_timestamp() then 'expired' else x.state end,
        'recipient', x.recipient, 'expiresAt', x.expires_at, 'sentAt', x.sent_at)
      from skyline_private.student_application_invites x where x.application_id = a.id order by x.created_at desc, x.id desc limit 1),
    'guardian', (select jsonb_build_object('state', case when g.state in ('sent', 'sending') and g.expires_at <= statement_timestamp() then 'expired' else g.state end,
        'name', g.name, 'relationship', g.relationship, 'email', g.email, 'sentAt', g.sent_at, 'signedAt', g.signed_at, 'expiresAt', g.expires_at)
      from skyline_private.application_guardian_requests g where g.application_id = a.id order by g.created_at desc limit 1),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.created_at, 'actorRole', e.actor_role, 'actorName', e.actor_name,
        'detail', e.detail) order by e.created_at), '[]'::jsonb) from skyline_private.application_handoff_events e where e.application_id = a.id))
  from public.enrollment_applications a
  left join skyline_private.application_handoffs h on h.application_id = a.id
  where a.id = p_application and auth.uid() is not null and public.portal_can_access_application(a.id);
$function$;

-- Field-level changes the student made: what the agent sent vs what was submitted (or the current draft before submission).
create or replace function public.portal_application_handoff_diff(p_application uuid)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare h skyline_private.application_handoffs; v_after jsonb; v_source text;
begin
  if auth.uid() is null or not public.portal_can_access_application(p_application) or skyline_private.is_application_student(p_application) then
    raise exception 'Application not found' using errcode = '42501';
  end if;
  select * into h from skyline_private.application_handoffs where application_id = p_application;
  if h.sent_snapshot is null then return jsonb_build_object('source', null, 'changes', '[]'::jsonb); end if;
  if h.state = 'submitted' then
    select v.snapshot into v_after from public.enrollment_application_versions v where v.application_id = p_application order by v.version desc limit 1;
    v_source := 'submitted';
  else
    v_after := skyline_private.application_snapshot(p_application); v_source := 'current';
  end if;
  return jsonb_build_object('source', v_source, 'sentAt', h.sent_at, 'submittedAt', h.submitted_at, 'changes', coalesce((
    select jsonb_agg(jsonb_build_object('field', k, 'before', b, 'after', f, 'by', 'student') order by k)
    from (select k, h.sent_snapshot->'values'->k b, v_after->'values'->k f
          from (select jsonb_object_keys(coalesce(h.sent_snapshot->'values', '{}'::jsonb)) k
                union select jsonb_object_keys(coalesce(v_after->'values', '{}'::jsonb))) keys) x
    where coalesce(nullif(b, '""'::jsonb), 'null'::jsonb) is distinct from coalesce(nullif(f, '""'::jsonb), 'null'::jsonb)), '[]'::jsonb));
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Parent / guardian (student under 18)
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.portal_guardian_request_begin(p_application uuid, p_name text, p_relationship text, p_email text,
  p_mobile text, p_hash text) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare a public.enrollment_applications; v_email text := lower(btrim(coalesce(p_email, ''))); v_id uuid; expiry int; send_limit int;
  sender text; template jsonb;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if a.id is null or not skyline_private.is_application_student(a.id) then
    raise exception 'Only the student can ask their parent or guardian to sign' using errcode = '42501';
  end if;
  if skyline_private.handoff_state(a.id) is distinct from 'waiting_guardian' then
    raise exception 'Sign the application first' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(p_name) > 120 then raise exception 'Enter the parent or guardian''s full name' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_relationship, ''))) < 2 or length(p_relationship) > 60 then raise exception 'Enter how they are related to you' using errcode = '22023'; end if;
  if not skyline_private.student_application_email_valid(v_email) then raise exception 'Enter a valid email address for the parent or guardian' using errcode = '22023'; end if;
  if v_email = lower(btrim(coalesce((select s.email from public.enrollment_students s where s.id = a.student_id), ''))) then
    raise exception 'The parent or guardian needs their own email address, not yours' using errcode = '22023';
  end if;
  if coalesce(p_mobile, '') !~ '^\+?[0-9 ()-]{6,20}$' then raise exception 'Enter a valid mobile number for the parent or guardian' using errcode = '22023'; end if;
  if coalesce(p_hash, '') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request' using errcode = '22023'; end if;
  select
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_hours', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_hours', '{}')) #>> '{}')::int,
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_resend_limit', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_resend_limit', '{}')) #>> '{}')::int,
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_sender', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_sender', '{}')) #>> '{}',
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_template', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_template', '{}'))
  into expiry, send_limit, sender, template;
  if expiry is null or send_limit is null or expiry not between 1 and 720 or send_limit not between 1 and 30
     or not skyline_private.student_application_email_valid(sender) or coalesce(jsonb_typeof(template) <> 'object', true) then
    raise exception 'Publish the student invitation settings in Business Rules & Policies before sending' using errcode = '22023';
  end if;
  update skyline_private.application_guardian_requests set state = 'failed'
    where application_id = a.id and state = 'sending' and created_at < statement_timestamp() - interval '2 minutes';
  if exists(select 1 from skyline_private.application_guardian_requests where application_id = a.id and state = 'sending') then
    raise exception 'The email to your parent or guardian is already sending' using errcode = '22023';
  end if;
  if (select count(*) from skyline_private.application_guardian_requests where application_id = a.id
       and created_at >= statement_timestamp() - interval '1 day') >= send_limit then
    raise exception 'The configured daily resend limit has been reached' using errcode = '22023';
  end if;
  insert into skyline_private.application_guardian_requests(application_id, name, relationship, email, mobile, token_hash, state, created_by, expires_at)
  values (a.id, btrim(p_name), btrim(p_relationship), v_email, btrim(p_mobile), p_hash, 'sending', auth.uid(), statement_timestamp() + make_interval(hours => expiry))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'recipient', v_email, 'sender', sender, 'template', template, 'guardianName', btrim(p_name),
    'studentName', coalesce(nullif(btrim(a.student_name), ''), 'the student'), 'reference', a.reference);
end $function$;

create or replace function public.portal_guardian_request_delivered(p_request uuid, p_accepted boolean)
 returns boolean language plpgsql security definer set search_path to '' as $function$
declare g skyline_private.application_guardian_requests;
begin
  update skyline_private.application_guardian_requests set state = case when p_accepted then 'sent' else 'failed' end,
    sent_at = case when p_accepted then clock_timestamp() end
    where id = p_request and state = 'sending' returning * into g;
  if not found then return false; end if;
  if p_accepted then
    update skyline_private.application_guardian_requests set state = 'revoked' where application_id = g.application_id and id <> g.id and state = 'sent';
    perform skyline_private.handoff_log(g.application_id, 'guardian_sent',
      jsonb_build_object('name', g.name, 'relationship', g.relationship, 'email', g.email, 'expiresAt', g.expires_at), 'student', null);
  end if;
  return true;
end $function$;

create or replace function skyline_private.guardian_request_open(p_hash text) returns skyline_private.application_guardian_requests
language plpgsql security definer set search_path to '' as $$
declare g skyline_private.application_guardian_requests;
begin
  select * into g from skyline_private.application_guardian_requests where token_hash = coalesce(p_hash, '') for update;
  if g.id is null or g.state <> 'sent' or g.expires_at <= statement_timestamp()
     or skyline_private.handoff_state(g.application_id) is distinct from 'waiting_guardian' then
    raise exception 'This link is invalid, expired, or no longer available' using errcode = '42501';
  end if;
  return g;
end $$;

create or replace function public.portal_guardian_open(p_hash text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare g skyline_private.application_guardian_requests; a public.enrollment_applications;
begin
  g := skyline_private.guardian_request_open(p_hash);
  select * into a from public.enrollment_applications where id = g.application_id;
  return jsonb_build_object('studentName', coalesce(nullif(btrim(a.student_name), ''), 'the student'), 'reference', a.reference,
    'guardianName', g.name, 'relationship', g.relationship,
    'email', regexp_replace(g.email, '^(.)[^@]*(@.*)$', '\1•••\2'),
    'verified', coalesce(g.verified_until > clock_timestamp(), false), 'expiresAt', g.expires_at,
    'declarations', public.portal_application_declarations());
end $function$;

create or replace function public.portal_guardian_code_issue(p_hash text, p_code text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare g skyline_private.application_guardian_requests; a public.enrollment_applications; sender text; template jsonb;
begin
  g := skyline_private.guardian_request_open(p_hash);
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then raise exception 'Invalid code' using errcode = '22023'; end if;
  if exists(select 1 from skyline_private.application_guardian_codes c where c.request_id = g.id and c.created_at > clock_timestamp() - interval '1 minute') then
    raise exception 'A code was just sent. Wait a minute before asking for another' using errcode = '22023';
  end if;
  if (select count(*) from skyline_private.application_guardian_codes c where c.request_id = g.id and c.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception 'Too many codes were asked for. Try again in an hour' using errcode = '22023';
  end if;
  insert into skyline_private.application_guardian_codes(request_id, code_hash, expires_at)
  values (g.id, encode(sha256(convert_to(g.id::text || ':' || p_code, 'UTF8')), 'hex'), clock_timestamp() + interval '10 minutes');
  select * into a from public.enrollment_applications where id = g.application_id;
  select coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_sender', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_sender', '{}')) #>> '{}',
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_template', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_template', '{}'))
    into sender, template;
  return jsonb_build_object('recipient', g.email, 'sender', sender, 'template', template, 'guardianName', g.name,
    'studentName', coalesce(nullif(btrim(a.student_name), ''), 'the student'));
end $function$;

-- Wrong codes are counted (5 tries per code), so this returns {ok:false} instead of raising (a raise would undo the count).
create or replace function public.portal_guardian_code_verify(p_hash text, p_code text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare g skyline_private.application_guardian_requests; c skyline_private.application_guardian_codes;
begin
  g := skyline_private.guardian_request_open(p_hash);
  select * into c from skyline_private.application_guardian_codes x where x.request_id = g.id and x.used_at is null
    order by x.created_at desc limit 1 for update;
  if c.id is null or c.expires_at <= clock_timestamp() then return jsonb_build_object('ok', false, 'error', 'The code has expired. Ask for a new code'); end if;
  if c.attempts >= 5 then return jsonb_build_object('ok', false, 'error', 'Too many wrong tries. Ask for a new code'); end if;
  if c.code_hash is distinct from encode(sha256(convert_to(g.id::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex') then
    update skyline_private.application_guardian_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'error', 'That code is not right. Check the email and try again');
  end if;
  update skyline_private.application_guardian_codes set used_at = clock_timestamp() where id = c.id;
  update skyline_private.application_guardian_requests set verified_until = clock_timestamp() + interval '30 minutes' where id = g.id;
  perform skyline_private.handoff_log(g.application_id, 'guardian_verified', jsonb_build_object('email', g.email), 'guardian', g.name);
  return jsonb_build_object('ok', true);
end $function$;

-- The guardian signs (after the code): recorded like the student's consent, then the application is submitted.
create or replace function public.portal_guardian_sign(p_hash text, p_declarations jsonb, p_ip text, p_user_agent text)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare g skyline_private.application_guardian_requests; h skyline_private.application_handoffs; v_ids jsonb; v_result jsonb;
begin
  g := skyline_private.guardian_request_open(p_hash);
  if g.verified_until is null or g.verified_until <= clock_timestamp() then
    raise exception 'Enter the code from your email first' using errcode = '42501';
  end if;
  select * into h from skyline_private.application_handoffs where application_id = g.application_id for update;
  v_ids := skyline_private.record_declarations(g.application_id, p_declarations, 'guardian', null, g.name, left(coalesce(p_ip, ''), 64),
    left(coalesce(p_user_agent, ''), 500), jsonb_build_object('name', g.name, 'relationship', g.relationship, 'email', g.email));
  update skyline_private.application_guardian_requests set state = 'signed', signed_at = clock_timestamp() where id = g.id;
  perform skyline_private.handoff_log(g.application_id, 'guardian_signed', jsonb_build_object('name', g.name, 'relationship', g.relationship,
    'email', g.email, 'consentIds', v_ids), 'guardian', g.name);
  v_result := skyline_private.application_finalize(g.application_id, h.signed_by, h.signed_by_name, coalesce(h.finalize_kind, 'submit'),
    coalesce(h.request_key, 'guardian-' || g.id::text), v_ids, h.finalize_note);
  return jsonb_build_object('ok', true, 'result', v_result);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------------------
revoke all on function public.portal_application_take_back(uuid), public.portal_application_request_change(uuid, text),
  public.portal_application_declarations(), public.portal_application_handoff(uuid), public.portal_application_handoff_diff(uuid),
  public.portal_guardian_request_begin(uuid, text, text, text, text, text), public.portal_guardian_request_delivered(uuid, boolean),
  public.portal_guardian_open(text), public.portal_guardian_code_issue(text, text), public.portal_guardian_code_verify(text, text),
  public.portal_guardian_sign(text, jsonb, text, text) from public, anon;
grant execute on function public.portal_application_take_back(uuid), public.portal_application_request_change(uuid, text),
  public.portal_application_declarations(), public.portal_application_handoff(uuid), public.portal_application_handoff_diff(uuid),
  public.portal_guardian_request_begin(uuid, text, text, text, text, text) to authenticated;
revoke execute on function public.portal_guardian_request_delivered(uuid, boolean), public.portal_guardian_open(text),
  public.portal_guardian_code_issue(text, text), public.portal_guardian_code_verify(text, text),
  public.portal_guardian_sign(text, jsonb, text, text) from authenticated;
grant execute on function public.portal_guardian_request_delivered(uuid, boolean), public.portal_guardian_open(text),
  public.portal_guardian_code_issue(text, text), public.portal_guardian_code_verify(text, text),
  public.portal_guardian_sign(text, jsonb, text, text) to service_role;
revoke all on function skyline_private.handoff_view_only_fields(), skyline_private.is_application_student(uuid), skyline_private.handoff_state(uuid),
  skyline_private.handoff_blocks_edit(uuid), skyline_private.handoff_actor_role(uuid), skyline_private.handoff_actor_name(),
  skyline_private.handoff_log(uuid, text, jsonb, text, text), skyline_private.handoff_notify(uuid, text, text, text, text),
  skyline_private.application_snapshot(uuid), skyline_private.application_age(uuid),
  skyline_private.record_declarations(uuid, jsonb, text, uuid, text, text, text, jsonb),
  skyline_private.application_finalize(uuid, uuid, text, text, text, jsonb, text),
  skyline_private.student_sign(public.enrollment_applications, text, text, jsonb, text),
  skyline_private.guardian_request_open(text) from public, anon, authenticated;
