begin;

CREATE OR REPLACE FUNCTION public.portal_create_student_application(p_client_key text, p_student uuid)
 RETURNS TABLE(application_id uuid, application_reference text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.enrollment_students; g public.agents; v_agent uuid; v_id uuid; v_ref text; v_self boolean;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 select * into s from public.enrollment_students where id = p_student for update;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 if s.agent_id is not null then select * into g from public.agents where id = s.agent_id; end if;
 v_self := coalesce(public.portal_student_id() = s.id, false);
 if public.portal_student_id() is not null and not v_self then raise exception 'You can only start your own application' using errcode = '42501'; end if;
 if s.tenant_id is not null and not public.tenant_scope(s.tenant_id) then
  raise exception 'This student is outside your institution' using errcode = '42501';
 end if;
 if not v_self and not public.portal_is_slit_admin() then
  if s.agency_id is distinct from public.portal_agency_id() then raise exception 'This student belongs to another business' using errcode = '42501'; end if;
  if not public.portal_is_agency_admin() and g.profile_id is distinct from public.portal_profile_id() then
   raise exception 'Only the student''s agent or an agency administrator can start their application' using errcode = '42501'; end if;
 end if;
 -- Keep the existing unfinished application. A student may start another after submission.
 select e.id, e.reference into v_id, v_ref from public.enrollment_applications e
  where e.student_id = s.id and e.status = 'draft' and e.submitted_at is null
  order by e.updated_at desc, e.id limit 1;
 if found then
  if not public.portal_can_access_application(v_id) then raise exception 'This application is unavailable' using errcode = '42501'; end if;
  return query select v_id, v_ref;
  return;
 end if;
 if g.profile_id is not null and exists (select 1 from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
   where m.user_id = g.profile_id and m.agency_id = s.agency_id and m.status = 'Active' and p.status = 'Active' and m.role = 'agent') then
  v_agent := g.profile_id;
 end if;
 if v_self then
  if nullif(btrim(p_client_key), '') is null or length(p_client_key) > 200 then raise exception 'Creation request key required' using errcode = '22023'; end if;
  if public.tenant_request_domain() is null and not public.tenant_scope(null) then raise exception 'Legacy scope not authorized' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_key, 8304));
  select e.id into v_id from public.enrollment_applications e where e.client_key = p_client_key limit 1;
  if v_id is not null then
   if not public.portal_can_access_application(v_id) then raise exception 'This creation request is not available to this user.' using errcode = '42501'; end if;
   return query select e.id, e.reference from public.enrollment_applications e where e.id = v_id;
   return;
  end if;
  v_ref := public.portal_next_application_reference();
  perform set_config('skyline.student_id', s.id::text, true);
  insert into public.enrollment_applications(reference, agency_id, created_by, assigned_agent_id, status, client_key)
   values (v_ref, s.agency_id, public.portal_profile_id(), v_agent, 'draft', p_client_key) returning id into v_id;
  perform set_config('skyline.student_id', '', true);
  return query select v_id, v_ref;
 else
  perform set_config('skyline.student_id', s.id::text, true);
  return query select * from public.portal_create_application(p_client_key, v_agent, s.agency_id);
  perform set_config('skyline.student_id', '', true);
 end if;
 select e.id into v_id from public.enrollment_applications e
  where e.student_id = s.id and e.client_key = p_client_key and e.status = 'draft' and e.data -> 'values' is null;
 if v_id is not null then
  perform set_config('portal.draft_command', v_id::text, true);
  update public.enrollment_applications e set student_name = s.full_name, student_email = coalesce(s.email, ''),
   data = jsonb_set(e.data, '{values}', coalesce(e.data -> 'values', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'email', s.email, 'confirm_email', s.email, 'mobile', s.phone, 'passport_number', nullif(s.passport_number, ''), 'nationality', nullif(s.nationality, ''),
    'dob', case when s.date_of_birth is null then null else to_char(s.date_of_birth, 'YYYY-MM-DD') end)))
  where e.id = v_id;
  perform set_config('portal.draft_command', '', true);
 end if;
end $function$
;

create function skyline_private.student_application_email_valid(p_email text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_email) <= 254 and p_email ~ '^[^@[:space:]<>",]+@[^@[:space:]<>",]+\.[^@[:space:]<>",]+$', false);
$$;
revoke all on function skyline_private.student_application_email_valid(text) from public, anon, authenticated;

create function public.portal_start_student_draft(p_email text, p_agent uuid, p_client_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  g public.agents;
  s public.enrollment_students;
  email_address text := lower(btrim(p_email));
  draft_id uuid;
begin
  if auth.uid() is null or public.portal_student_id() is not null then
    raise exception 'Only authorised staff and agents can add students' using errcode = '42501';
  end if;
  if not skyline_private.student_application_email_valid(email_address) then
    raise exception 'Enter a valid student email address' using errcode = '22023';
  end if;
  select * into g from public.agents where id = p_agent;
  if g.id is null or (
    public.portal_is_slit_admin() or
    (g.business_id = public.portal_agency_id() and
      (public.portal_is_agency_admin() or g.profile_id = public.portal_profile_id()))
  ) is not true then
    raise exception 'You cannot add a student for this agent' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(email_address, 43182));
  select * into s from public.enrollment_students where lower(btrim(email)) = email_address;
  if found then
    if s.agent_id is distinct from g.id or s.agency_id is distinct from g.business_id then
      raise exception 'A student with this email already exists' using errcode = '23505', hint = 'email_taken';
    end if;
  else
    insert into public.enrollment_students(agency_id, tenant_id, agent_id, email, created_by, details)
    values(g.business_id, public.tenant_current(), g.id, email_address, public.portal_profile_id(),
      jsonb_build_object('email', email_address, 'confirm_email', email_address))
    returning * into s;
  end if;
  select application_id into strict draft_id from public.portal_create_student_application(p_client_key, s.id);
  return draft_id;
end;
$$;
revoke all on function public.portal_start_student_draft(text, uuid, text) from public, anon, authenticated;
grant execute on function public.portal_start_student_draft(text, uuid, text) to authenticated;

-- The wizard reads only the caller's authorised application. Other screens can read submitted applications normally.
create function public.portal_wizard_application(p_application uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'reference', a.reference, 'status', a.status, 'agency_id', a.agency_id,
    'created_by', a.created_by, 'assigned_agent_id', a.assigned_agent_id, 'student_id', a.student_id, 'student_name', a.student_name,
    'student_email', coalesce(nullif(a.student_email, ''), s.email, ''), 'intake', a.intake, 'completion', a.completion,
    'data', public.application_data(a.id), 'created_at', a.created_at, 'updated_at', a.updated_at, 'submitted_at', a.submitted_at,
    'submitted_by', a.submitted_by, 'version', a.version, 'draft_version', a.draft_version, 'tenant_id', a.tenant_id, 'is_test', a.is_test)
  from public.enrollment_applications a join public.enrollment_students s on s.id = a.student_id
  where a.id = p_application and auth.uid() is not null and public.portal_can_access_application(a.id);
$$;
revoke all on function public.portal_wizard_application(uuid) from public, anon, authenticated;
grant execute on function public.portal_wizard_application(uuid) to authenticated;

create function public.portal_submitted_application(p_application uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.enrollment_applications a where a.id = p_application
    and (a.status <> 'draft' or a.submitted_at is not null) and public.portal_can_access_application(a.id));
$$;
revoke all on function public.portal_submitted_application(uuid) from public, anon, authenticated;
grant execute on function public.portal_submitted_application(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.portal_save_draft_v2(p_application_id uuid, p_expected_version bigint, p_patch jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; d jsonb; v bigint; c jsonb; course public.cms_courses; v_intake public.course_intakes; v_intake_id uuid; v_intake_label text;
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
 return v;
end; $function$
;

create function public.portal_wizard_save(p_application_id uuid, p_expected_version bigint, p_patch jsonb, p_saved_at text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.enrollment_applications; revision bigint;
begin
  select * into a from public.enrollment_applications where id = p_application_id for update;
  if auth.uid() is null or not public.portal_can_access_application(a.id) then
    raise exception 'Application is not editable' using errcode = '42501';
  end if;
  -- Extraction can advance the row revision without any manual edits. Rebase only if the last save still matches.
  if a.draft_version is distinct from p_expected_version and a.data->>'savedAt' is distinct from p_saved_at then
    raise exception 'Another session saved changes. Reopen the application before editing further.' using errcode = 'PT409';
  end if;
  revision := public.portal_save_draft_v2(a.id, a.draft_version, p_patch);
  select * into a from public.enrollment_applications where id = a.id;
  return jsonb_build_object('draft_version', revision, 'saved_at', a.data->>'savedAt');
end;
$$;
revoke all on function public.portal_wizard_save(uuid, bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.portal_wizard_save(uuid, bigint, jsonb, text) to authenticated;

create table skyline_private.student_application_invites (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  recipient text not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('sending', 'sent', 'failed', 'accepted', 'revoked')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  accepted_at timestamptz
);
create index student_application_invites_application
  on skyline_private.student_application_invites(application_id, created_at desc);
alter table skyline_private.student_application_invites enable row level security;
revoke all on skyline_private.student_application_invites from public, anon, authenticated, service_role;

-- An invite belongs to a specific application. It never serves as a portal password.
create function skyline_private.wizard_application_progress(p_application uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  values_map jsonb := public.application_values(p_application);
  section jsonb;
  field jsonb;
  field_name text;
  field_value jsonb;
  category text;
  done int := 0;
  applicable int := 0;
  ready boolean := false;
begin
  for section in select value from jsonb_array_elements(public.portal_required_schema()) loop
    if not public.portal_condition_met(section->'showIf', values_map) then continue; end if;
    for field in select value from jsonb_array_elements(section->'fields') loop
      field_name := field->>'name';
      if not public.portal_condition_met(field->'showIf', values_map) or public.admissions_field_optional(field_name)
         or (field_name = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
      applicable := applicable + 1;
      field_value := values_map->field_name;
      if field->>'type' = 'file' then
        category := case field_name when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa'
          when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
        if exists(select 1 from public.enrollment_application_documents d join storage.objects o
          on o.bucket_id = d.bucket_name and o.name = d.storage_path where d.application_id = p_application
          and d.category = category and d.is_current) then done := done + 1; end if;
      elsif field_name = 'courses_of_interest' then
        if exists(select 1 from public.enrollment_application_courses c where c.application_id = p_application) then done := done + 1; end if;
      elsif jsonb_typeof(field_value) = 'array' then
        if jsonb_array_length(field_value) > 0 then done := done + 1; end if;
      elsif nullif(btrim(field_value #>> '{}'), '') is not null then
        done := done + 1;
      end if;
    end loop;
  end loop;
  begin
    perform public.portal_validate_submission(p_application);
    ready := true;
  exception when sqlstate '22023' then
    ready := false;
  end;
  return jsonb_build_object('completion', case when applicable = 0 then 0 else least(99, round(100.0 * done / applicable)) end, 'ready', ready);
end;
$$;
revoke all on function skyline_private.wizard_application_progress(uuid) from public, anon, authenticated;

create function public.portal_wizard_invitation_status(p_application uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('invitationStatus', coalesce(
    case when i.state in ('sent','sending') and i.expires_at <= statement_timestamp() then 'Expired'
      when i.state = 'sent' and exists(select 1 from skyline_private.student_application_invites old
       where old.application_id = a.id and old.id <> i.id and old.sent_at is not null) then 'Resent'
      when i.state = 'revoked' then 'Expired'
      else initcap(i.state) end, 'Not Sent'),
    'updatedBy', coalesce(nullif(p.full_name, ''), u.email, ''),
    'lastStep', a.data#>>'{wizard,activeStep}', 'lastSaved', coalesce(a.data->>'savedAt', a.updated_at::text),
    'completion', case when a.submitted_at is not null then to_jsonb(100) else progress.result->'completion' end,
    'status', case when a.submitted_at is not null then 'Submitted'
      when progress.result->'ready' = 'true' then 'Ready for Submission'
      when a.data ? 'savedAt' then 'In Progress' else 'Draft' end)
  from public.enrollment_applications a
  left join lateral (select * from skyline_private.student_application_invites x
    where x.application_id = a.id order by x.created_at desc, x.id desc limit 1) i on true
  left join auth.users u on u.id::text = a.data->>'preparedBy'
  left join public.portal_profiles p on p.auth_user_id = u.id
  cross join lateral (select skyline_private.wizard_application_progress(a.id) result
    where auth.uid() is not null and public.portal_can_access_application(a.id)) progress
  where a.id = p_application and auth.uid() is not null and public.portal_can_access_application(a.id);
$$;
revoke all on function public.portal_wizard_invitation_status(uuid) from public, anon, authenticated;
grant execute on function public.portal_wizard_invitation_status(uuid) to authenticated;

do $rules$
declare
  setting record;
  category_id uuid;
  rule_id uuid;
  version_id uuid;
  registration jsonb;
  definition jsonb;
  today date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  insert into public.business_rule_categories(scope_key, name) values ('', 'Student Application Invitations') on conflict do nothing;
  select id into strict category_id from public.business_rule_categories where scope_key = '' and name = 'Student Application Invitations';
  for setting in select * from (values
    ('admissions.application_mobile_required','Require a mobile number at submission','boolean','true','{}'),
    ('admissions.application_invite_hours','Invitation validity in hours','number','168','{"min":1,"max":720}'),
    ('admissions.application_invite_resend_limit','Resends per application per day','number','3','{"min":1,"max":30}'),
    ('admissions.application_invite_sender','Office 365 sender mailbox','text','""','{}'),
    ('admissions.application_invite_template','Student application invitation email','json',
      '{"subject":"Invitation to Complete Your SLIT Student Application","greeting":"Hello,","body":"You have been invited to complete your student application with SLIT.\n\nPlease use the secure link below to access your application and provide the remaining required information and documents.","button":"Complete My Application","note":"If you have already started your application, your previously saved information will be available when you sign in.\n\nIf you were not expecting this invitation, you may safely ignore this email.","signature":"Kind regards,\nSLIT Admissions Team","brand":"SLIT","primary":"","logoUrl":"","contact":"","siteUrl":""}','{}')
  ) as settings(identifier, title, value_type, initial, limits)
  loop
    registration := jsonb_build_object('scope','agency_students','entity','student_application','value_type',setting.value_type,
      'schema_version',1,'handler','setting') || setting.limits::jsonb;
    rule_id := public.business_rule_register('', setting.identifier, registration);
    definition := jsonb_build_object('identifier',setting.identifier,'name',setting.title,'category_id',category_id,
      'scope','agency_students','entity','student_application','value_type',setting.value_type,'value',setting.initial::jsonb,
      'description',setting.title,'options','[]'::jsonb,'groups','[]'::jsonb,'match','all','then_action','use_value',
      'else_action','none','priority',0,'starts_on',today,'ends_on','','enabled',true,'approval_required',false,
      'source_url','','notes',case when setting.identifier = 'admissions.application_mobile_required'
        then 'The current requirement stays in place until SLIT publishes a setting.'
        else 'Complete and publish before sending invitations.' end);
    perform public.business_rule_validate(definition, registration);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
      values (rule_id,1,'draft','migration',definition,today) returning id into version_id;
    perform public.business_rule_index_version(version_id,definition);
  end loop;
end $rules$;

create function public.portal_wizard_invite_begin(p_application uuid, p_hash text, p_corrected_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.enrollment_applications;
  s public.enrollment_students;
  invitation uuid;
  expiry int;
  send_limit int;
  sender text;
  template jsonb;
  email_address text;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or public.portal_student_id() is not null or a.id is null or not public.portal_can_access_application(a.id)
     or not public.application_student_active(a.id) or a.status <> 'draft' or a.submitted_at is not null then
    raise exception 'You cannot invite a student for this application' using errcode = '42501';
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
    -- Change the student first so the existing email propagation trigger runs outside an application UPDATE.
    perform set_config('portal.draft_command', a.id::text, true);
    update public.enrollment_students set email = email_address,
      details = coalesce(details, '{}'::jsonb) || jsonb_build_object('email', email_address, 'confirm_email', email_address)
      where id = s.id;
    select * into a from public.enrollment_applications where id = p_application;
    perform public.portal_wizard_save(a.id, a.draft_version, '{}', a.data->>'savedAt');
  end if;
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
  if expiry not between 1 and 720 or send_limit not between 1 and 30 or expiry is null or send_limit is null or not skyline_private.student_application_email_valid(sender)
     or coalesce(jsonb_typeof(template) <> 'object', true) then
    raise exception 'Publish the student invitation settings in Business Rules & Policies before sending' using errcode = '22023';
  end if;
  -- A timed-out Edge request may have reached the provider. A short lease prevents concurrent sends.
  update skyline_private.student_application_invites set state = 'failed'
    where application_id = a.id and state = 'sending' and created_at < statement_timestamp() - interval '2 minutes';
  if exists(select 1 from skyline_private.student_application_invites where application_id = a.id and state = 'sending') then
    raise exception 'An invitation is already sending. Check its status before trying again' using errcode = '22023';
  end if;
  if (select count(*) from skyline_private.student_application_invites where application_id = a.id
       and created_at >= statement_timestamp() - interval '1 day') > send_limit then
    raise exception 'The configured daily resend limit has been reached' using errcode = '22023';
  end if;
  insert into skyline_private.student_application_invites(application_id, recipient, token_hash, state, created_by, expires_at)
    values (a.id, email_address, p_hash, 'sending', auth.uid(), statement_timestamp() + make_interval(hours => expiry))
    returning id into invitation;
  return jsonb_build_object('id', invitation, 'recipient', email_address, 'sender', sender, 'template', template);
end;
$$;
revoke all on function public.portal_wizard_invite_begin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.portal_wizard_invite_begin(uuid, text, text) to authenticated;

create function public.portal_wizard_invite_delivered(p_invitation uuid, p_accepted boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare app_id uuid;
begin
  select application_id into app_id from skyline_private.student_application_invites where id = p_invitation;
  perform 1 from public.enrollment_applications where id = app_id for update;
  update skyline_private.student_application_invites
    set state = case when p_accepted then 'sent' else 'failed' end,
    sent_at = case when p_accepted then clock_timestamp() else null end
    where id = p_invitation and state = 'sending';
  if not found then return false; end if;
  if p_accepted then
    update skyline_private.student_application_invites set state = 'revoked'
      where application_id = app_id and id <> p_invitation and state = 'sent';
  end if;
  return true;
end;
$$;
revoke all on function public.portal_wizard_invite_delivered(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.portal_wizard_invite_delivered(uuid, boolean) to service_role;

create function public.portal_wizard_invite_accept(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  a public.enrollment_applications;
  i skyline_private.student_application_invites;
  s public.enrollment_students;
  u auth.users;
  p public.portal_profiles;
  m public.agency_memberships;
  fingerprint text;
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
  if a.id is null or i.state <> 'sent' or i.expires_at <= statement_timestamp()
     or i.recipient is distinct from lower(btrim(u.email)) or i.recipient is distinct from lower(btrim(s.email))
     or a.status <> 'draft' or a.submitted_at is not null or s.status <> 'Active'
     or not public.tenant_scope(a.tenant_id)
     or public.cms_is_admin()
     or not exists (select 1 from public.agencies g where g.id = a.agency_id and public.agency_effective_status(g) = 'Active') then
    raise exception 'This invitation is invalid, expired, or no longer available' using errcode = '42501';
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
  update skyline_private.student_application_invites set state = 'accepted', accepted_at = clock_timestamp() where id = i.id;
  return a.id;
end;
$$;
revoke all on function public.portal_wizard_invite_accept(text) from public, anon, authenticated;
grant execute on function public.portal_wizard_invite_accept(text) to authenticated;

create function skyline_private.require_initial_application_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'draft' and old.submitted_at is null and new.status <> 'draft'
     and (new.status <> 'submitted' or new.submitted_at is null or new.submitted_by is null
          or current_setting('portal.status_command', true) is distinct from new.id::text) then
    raise exception 'Complete and submit the Student Application Wizard first' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function skyline_private.require_initial_application_submission() from public, anon, authenticated;
create trigger require_initial_application_submission before update of status on public.enrollment_applications
  for each row execute function skyline_private.require_initial_application_submission();

CREATE OR REPLACE FUNCTION public.portal_validate_submission(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) or public.admissions_field_optional(f->>'name')
      or (f->>'name' = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
   label:=f->>'name';field_value:=vals->label;
   if f->>'type'='file' then
    v_category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if v_category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.application_id=a.id and d.category=v_category and d.is_current) then
     raise exception 'Required document missing: %',label using errcode='22023'; end if;
   elsif f->>'type'='checkbox' then
    if jsonb_typeof(field_value) is distinct from 'array' or jsonb_array_length(field_value)=0 then raise exception 'Required selection missing: %',label using errcode='22023'; end if;
    if label='courses_of_interest' then
     if not exists(select 1 from public.enrollment_application_courses where application_id=a.id) then raise exception 'Select an institution course' using errcode='22023'; end if;
    elsif f ? 'options' then
     if exists(select 1 from jsonb_array_elements_text(field_value) v where not (f->'options' ? v)) then raise exception 'Invalid selection: %',label using errcode='22023'; end if;
    end if;
   elsif nullif(btrim(field_value#>>'{}'),'') is null then raise exception 'Required field missing: %',label using errcode='22023';
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (field_value#>>'{}')) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (field_value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (field_value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if nullif(btrim(vals->>'mobile'), '') is not null
    and regexp_replace(vals->>'mobile', '[[:space:]().-]', '', 'g') !~ '^(04[0-9]{8}|\+61[1-9][0-9]{8}|\+(?!61)[1-9][0-9]{6,14})$' then
   raise exception 'Enter a valid phone number: mobile' using errcode='22023';
 end if;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and (cc.status='Published' or not public.rule_bool('admissions.applications_require_published_course', true))
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
 -- INT-01: an open intake of the application's own course, and the label the server wrote for it.
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$
;

CREATE OR REPLACE FUNCTION public.portal_submit_v2(p_application_id uuid, p_expected_version bigint, p_request_key text, p_consent jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
 snap:=public.application_data(a.id)||jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.enrollment_application_courses c where application_id=a.id),
  'submission',jsonb_build_object('actor',auth.uid(),'declarationVersion','1.0','consent',p_consent,'draftVersion',a.draft_version));
 perform set_config('portal.status_command',a.id::text,true);
 update public.enrollment_applications set status='submitted',submitted_at=now(),submitted_by=auth.uid(),completion=100,
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
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authenticated user'),case when public.portal_student_id() is not null then 'student' when public.portal_is_agency_admin() then 'agency_admin' when public.portal_is_slit_admin() then 'slit_admin' else 'agent' end,
  'application_submitted','application',a.id::text,a.id,jsonb_build_object('receiptId',r.id,'version',v));
 return to_jsonb(r);
end; $function$
;

commit;
