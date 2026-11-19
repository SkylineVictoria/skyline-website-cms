-- BUSINESS-RULES-LIVE batch: Admissions, Agents and Microsoft 365. Every admissions.*, agents.* and office365.* reference entry in
-- Business Rules becomes a live setting at today's value (nothing changes on the day); SLIT changes it on Administration › Business Rules.
-- Database rules are read with public.rule_* (batch 1); screens through src/lib/businessRules.ts; Edge Functions through
-- supabase/functions/_shared/business-rules.ts (validated-document-upload, guest-documents, document-signing, student-office365).
-- Entries that described behaviour in words become choices (the first choice = today's behaviour) or lists:
--   admissions.application_delete_only_unsubmitted    drafts only, or no deletion at all
--   admissions.applications_choose_open_intake       intake needed when one is open, or always (no start-month fallback)
--   admissions.registration_coe_voe_issue_prerequisites  the three structural steps stay required; "Initial deposit paid" may be added
--   admissions.registration_verification_prerequisites   "Valid CoE number" stays required (a verified registration carries one)
--   agents.agent_application_yes_no_fallback         unanswered Yes / No questions start at No, or stay blank
--   office365.*_license_fallback                     a licence with a mailbox of the matching kind (faculty / students)
-- Ceilings kept (they are storage or table limits): application documents 10 MB and PDF / JPG / PNG, CoE / VoE PDF 3 MB
-- (enrollment_coe_documents check), F04 attachments 5 MB (agency_onboarding_attachments check).
begin;

-- A list setting can keep some entries fixed ("required" in the registration): they cannot be taken out.
select public.business_rule_patch_function('public.business_rule_validate(jsonb, jsonb)'::regprocedure,
  $o$      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$o$,
  $n$      if p_registration ? 'required' and jsonb_typeof(d->'value') = 'array' and not (d->'value') @> (p_registration->'required') then
        raise exception 'Keep these in the list: %.', (select string_agg(x, ', ') from jsonb_array_elements_text(p_registration->'required') x) using errcode = '22023';
      end if;
      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$n$);

-- 1. Applications: deleting, courses and intakes.
select public.business_rule_go_live('admissions.application_delete_only_unsubmitted',
  '{"allowed":["Delete an unsubmitted draft only","No deletion: keep every application"]}');
select public.business_rule_go_live('admissions.applications_require_published_course');
select public.business_rule_go_live('admissions.applications_choose_open_intake',
  '{"allowed":["Select an intake when the course has an open intake","Always select an intake (no start-month fallback)"]}');

select public.business_rule_patch_function('public.portal_delete_draft_prepare(uuid)'::regprocedure,
  $o$if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$o$,
  $n$if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$n$);
select public.business_rule_patch_function('public.portal_delete_draft_application(uuid, integer)'::regprocedure,
  $o$if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$o$,
  $n$if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$n$);
select public.business_rule_patch_function('public.application_intake_problem(uuid)'::regprocedure,
  $o$if not exists (select 1 from public.cms_courses x where x.id = k.course_id and x.status = 'Published') then$o$,
  $n$if not exists (select 1 from public.cms_courses x where x.id = k.course_id and x.status = 'Published')
     and (public.rule_bool('admissions.applications_require_published_course', true) or not public.course_has_open_intake(k.course_id)) then$n$);
select public.business_rule_patch_function('public.application_intake_problem(uuid)'::regprocedure,
  $o$if public.course_has_open_intake(k.course_id) then return 'Choose an intake for the course'; end if;$o$,
  $n$if public.course_has_open_intake(k.course_id) or public.rule_text('admissions.applications_choose_open_intake', 'Select an intake when the course has an open intake') = 'Always select an intake (no start-month fallback)' then return 'Choose an intake for the course'; end if;$n$);
select public.business_rule_patch_function('public.portal_course_options()'::regprocedure,
  $o$and c.status = 'Published';$o$,
  $n$and (c.status = 'Published' or (not public.rule_bool('admissions.applications_require_published_course', true) and public.course_has_open_intake(c.id)));$n$);

-- 2. Application form: which address and emergency contact details are required (a detail left out becomes optional);
-- application documents: size and types (never above the 10 MB, PDF / JPG / PNG ceiling the uploads and extraction take).
select public.business_rule_go_live('admissions.australian_address_required_fields', '{"allowed":["Suburb","State","ZIP / Postal Code"]}');
select public.business_rule_go_live('admissions.overseas_address_required_fields', '{"allowed":["Suburb","State / Territory","ZIP / Postal Code"]}');
select public.business_rule_go_live('admissions.emergency_contact_required_details',
  '{"allowed":["Full Name","Contact Number","Whether the contact is in Australia"]}');
select public.business_rule_go_live('admissions.application_document_limit_mib', '{"min":1,"max":10}');
select public.business_rule_go_live('admissions.application_document_types', '{"allowed":["JPEG","PNG","PDF"]}');

create or replace function public.admissions_field_optional(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_name in ('au_suburb', 'au_state', 'au_zip') then not coalesce(public.rule_json('admissions.australian_address_required_fields',
      '["Suburb","State","ZIP / Postal Code"]'::jsonb) ? (case p_name when 'au_suburb' then 'Suburb' when 'au_state' then 'State' else 'ZIP / Postal Code' end), true)
    when p_name in ('ov_suburb', 'ov_state', 'ov_zip') then not coalesce(public.rule_json('admissions.overseas_address_required_fields',
      '["Suburb","State / Territory","ZIP / Postal Code"]'::jsonb) ? (case p_name when 'ov_suburb' then 'Suburb' when 'ov_state' then 'State / Territory' else 'ZIP / Postal Code' end), true)
    when p_name in ('ec_name', 'ec_phone', 'ec_in_au') then not coalesce(public.rule_json('admissions.emergency_contact_required_details',
      '["Full Name","Contact Number","Whether the contact is in Australia"]'::jsonb) ? (case p_name when 'ec_name' then 'Full Name' when 'ec_phone' then 'Contact Number' else 'Whether the contact is in Australia' end), true)
    else false end;
$$;
revoke all on function public.admissions_field_optional(text) from public;
grant execute on function public.admissions_field_optional(text) to authenticated, service_role;

select public.business_rule_patch_function('public.portal_validate_submission(uuid)'::regprocedure,
  $o$cc.status='Published'$o$,
  $n$(cc.status='Published' or not public.rule_bool('admissions.applications_require_published_course', true))$n$);
select public.business_rule_patch_function('public.portal_validate_submission(uuid)'::regprocedure,
  $o$if not public.portal_condition_met(f->'showIf',vals) then continue; end if;$o$,
  $n$if not public.portal_condition_met(f->'showIf',vals) or public.admissions_field_optional(f->>'name') then continue; end if;$n$);
select public.business_rule_patch_function('public.application_completion(uuid)'::regprocedure,
  $o$if not public.portal_condition_met(f->'showIf', vals) then continue; end if;$o$,
  $n$if not public.portal_condition_met(f->'showIf', vals) or public.admissions_field_optional(f->>'name') then continue; end if;$n$);

-- 3. Registrations: the unverified alert, what verification needs, the CoE / VoE PDF size and what issuing needs.
select public.business_rule_go_live('admissions.registration_stale_lodgement_days', '{"min":1,"max":365}');
select public.business_rule_go_live('admissions.registration_verification_prerequisites',
  '{"allowed":["Registration lodged","Offer accepted or later","At least one evidence item","Valid CoE number"],"required":["Valid CoE number"]}');
select public.business_rule_go_live('admissions.registration_coe_voe_pdf_mib', '{"min":1,"max":3}');
select public.business_rule_go_live('admissions.registration_coe_voe_issue_prerequisites',
  '{"allowed":["Offer accepted","Verified registration","Uploaded PDF","Initial deposit paid"],"required":["Offer accepted","Verified registration","Uploaded PDF"]}');

create or replace function public.admissions_verification_requires(p_item text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.rule_json('admissions.registration_verification_prerequisites',
    '["Registration lodged","Offer accepted or later","At least one evidence item","Valid CoE number"]'::jsonb) ? p_item, true);
$$;
revoke all on function public.admissions_verification_requires(text) from public;
grant execute on function public.admissions_verification_requires(text) to authenticated, service_role;

select public.business_rule_patch_function('public.portal_registration_exception_kinds(uuid)'::regprocedure,
  $o$l.lodged_at < now() - interval '14 days'$o$,
  $n$l.lodged_at < now() - make_interval(days => public.rule_int('admissions.registration_stale_lodgement_days', 14))$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))) then$o$,
  $n$if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))
          or (r.state = 'draft' and p_to = 'verified' and not public.admissions_verification_requires('Registration lodged'))) then$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'The offer must be accepted before registration can be verified'$o$,
  $n$if public.admissions_verification_requires('Offer accepted or later') and a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'The offer must be accepted before registration can be verified'$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification'$o$,
  $n$if public.admissions_verification_requires('At least one evidence item') and not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification'$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$update public.enrollment_registrations set state = 'verified', coe_number = v_coe,$o$,
  $n$update public.enrollment_registrations set state = 'verified', lodged_at = coalesce(lodged_at, now()), lodged_by = coalesce(lodged_by, auth.uid()), coe_number = v_coe,$n$);
select public.business_rule_patch_function('public.portal_coe_document_upload(uuid, text, text, text)'::regprocedure,
  $o$length(p_content) > 4300000 then raise exception 'The PDF is too large (3 MB at most)'$o$,
  $n$length(p_content) > 4300000 * public.rule_num('admissions.registration_coe_voe_pdf_mib', 3) / 3 then raise exception 'The PDF is too large (% MB at most)', public.rule_num('admissions.registration_coe_voe_pdf_mib', 3)$n$);
select public.business_rule_patch_function('public.portal_coe_document_upload(uuid, text, text, text)'::regprocedure,
  $o$if length(v_bytes) not between 8 and 3145728 then raise exception 'The PDF must be between 8 bytes and 3 MB'$o$,
  $n$if length(v_bytes) not between 8 and (public.rule_num('admissions.registration_coe_voe_pdf_mib', 3) * 1048576)::bigint then raise exception 'The PDF must be between 8 bytes and % MB', public.rule_num('admissions.registration_coe_voe_pdf_mib', 3)$n$);
select public.business_rule_patch_function('public.portal_coe_voe_issue(uuid, text)'::regprocedure,
  $o$if not found then raise exception 'Upload the CoE / VoE PDF before issuing it' using errcode = '22023'; end if;$o$,
  $n$if not found then raise exception 'Upload the CoE / VoE PDF before issuing it' using errcode = '22023'; end if;
  if public.rule_json('admissions.registration_coe_voe_issue_prerequisites', '["Offer accepted","Verified registration","Uploaded PDF"]'::jsonb) ? 'Initial deposit paid'
     and coalesce((select o.deposit_paid_at is null and coalesce(o.payment_amount_cents, 0) > 0 from public.enrollment_offer_letters o
                    where o.application_id = a.id and o.accepted_at is not null order by o.accepted_at desc limit 1), false) then
    raise exception 'The initial deposit must be paid before the CoE / VoE is issued' using errcode = '22023'; end if;$n$);

-- 4. Agents: the F04 attachment cap (never above the 5 MB the table stores), and the onboarding values read by document-signing:
-- the template expiry / reminder fallbacks, the Yes / No starting answer and the questions that must be answered.
select public.business_rule_go_live('agents.agent_application_attachment_cap_mib', '{"min":1,"max":5}');
select public.business_rule_go_live('agents.onboarding_document_expiry_default', '{"min":1,"max":365}');
select public.business_rule_go_live('agents.onboarding_document_reminder_default', '{"min":0,"max":60}');
select public.business_rule_go_live('agents.agent_application_yes_no_fallback', '{"allowed":["No","Leave blank (the agent answers)"]}');
select public.business_rule_go_live('agents.onboarding_required_answer_groups', '{"allowed":["Litigation involved","EATC completed"]}');

select public.business_rule_patch_function('public.agency_onboarding_attachment_save(uuid, uuid, text, jsonb)'::regprocedure,
  $o$if length(v_bytes) = 0 or length(v_bytes) > 5242880 then raise exception 'The file must be smaller than 5 MB.' using errcode = '22023'; end if;$o$,
  $n$if length(v_bytes) = 0 or length(v_bytes) > least(5242880, (public.rule_num('agents.agent_application_attachment_cap_mib', 5) * 1048576)::bigint) then
  raise exception 'The file must be smaller than % MB.', least(5, public.rule_num('agents.agent_application_attachment_cap_mib', 5)) using errcode = '22023'; end if;$n$);

-- 5. Microsoft 365: the licence used when EF_MICROSOFT365_STAFF_SKU / EF_MICROSOFT365_STUDENT_SKU is not set (student-office365).
select public.business_rule_go_live('office365.staff_license_fallback',
  '{"allowed":["Office 365 A1 for faculty","Office 365 A1 Plus for faculty","Office 365 A3 for faculty","Office 365 A5 for faculty","Microsoft 365 A3 for faculty","Microsoft 365 A5 for faculty"]}');
select public.business_rule_go_live('office365.student_license_fallback',
  '{"allowed":["Office 365 A1 for students","Office 365 A1 Plus for students","Office 365 A3 for students","Office 365 A5 for students","Microsoft 365 A3 for students","Microsoft 365 A5 for students"]}');

-- Nothing must be left behind in Admissions, Agents or Microsoft 365.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and (identifier like 'admissions.%' or identifier like 'agents.%' or identifier like 'office365.%')
              and registration->>'handler' = 'inventory_only') then
    raise exception 'BUSINESS-RULES-LIVE: Admissions / Agents / Microsoft 365 reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and (identifier like 'admissions.%' or identifier like 'agents.%' or identifier like 'office365.%')
        and registration->>'handler' = 'inventory_only');
  end if;
end $$;

commit;
