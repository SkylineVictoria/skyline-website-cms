-- BUSINESS-RULES-LIVE batch 4 (owner, 2026-11-20: "implement all rules"): the decisions that were still fixed in the
-- code become new Business Rules. Each rule is added live at the value the system uses today, so nothing changes on the
-- day; SLIT changes them on Administration › Business Rules. Where the system disagreed with itself, the rule starts at
-- the stricter value already in force and its notes say so ("Choose a value").
begin;

-- ===== helper =====
-- Adds a new live setting (handler 'setting', published version 1) unless the identifier already exists.
-- p_kind: number | percentage | days | hours | weeks | text | boolean | dropdown | multiple selection | list | json
-- p_options: the choices for dropdown / multiple selection ('[]' otherwise).
-- p_limits: registration limits checked on every later publish (min / max / allowed / keys).
create or replace function public.business_rule_add_setting(
  p_id text, p_name text, p_category text, p_scope text, p_entity text, p_kind text, p_value jsonb,
  p_limits jsonb default '{}'::jsonb, p_description text default '', p_options jsonb default '[]'::jsonb,
  p_choose boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare rid uuid; vid uuid; cat uuid; d jsonb; reg jsonb;
  today date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  if exists (select 1 from public.business_rules where scope_key = '' and identifier = p_id) then return; end if;
  select c.id into cat from public.business_rule_categories c where c.scope_key = ''
    order by (c.name = p_category) desc, (c.name = 'Other') desc, c.id limit 1;
  if cat is null then raise exception 'BUSINESS-RULES-LIVE: no Business Rules categories.'; end if;
  reg := jsonb_build_object('scope', p_scope, 'entity', p_entity, 'value_type', p_kind, 'schema_version', 1, 'handler', 'setting')
    || coalesce(p_limits, '{}'::jsonb);
  d := jsonb_build_object(
    'name', p_name, 'identifier', p_id, 'category_id', cat, 'scope', p_scope, 'entity', p_entity,
    'description', p_description, 'value_type', p_kind, 'value', p_value, 'options', coalesce(p_options, '[]'::jsonb),
    'groups', '[]'::jsonb, 'match', 'all', 'then_action', 'use_value', 'else_action', 'none', 'priority', 0,
    'starts_on', today, 'ends_on', '', 'enabled', true, 'approval_required', false, 'source_url', '',
    'notes', case when p_choose
      then 'Choose a value: the system used two different values before; this rule started at the one already enforced.'
      else 'Live setting: the system uses this value. It started at the value the system already used.' end);
  perform public.business_rule_validate(d, reg);
  insert into public.business_rules(scope_key, identifier, registration) values ('', p_id, reg) returning id into rid;
  insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, published_at)
    values (rid, 1, 'published', 'migration', d, today, clock_timestamp()) returning id into vid;
  perform public.business_rule_index_version(vid, d);
  insert into public.business_rule_audit_logs(scope_key, rule_id, action, reason, after_data)
    values ('', rid, 'publish', 'Added live at the value the system already used.', d);
end $$;
revoke all on function public.business_rule_add_setting(text, text, text, text, text, text, jsonb, jsonb, text, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- ===== A =====
-- Part A: admissions, offers and finance. Every rule starts at the value the system uses today.
-- Functions patched (hosted bodies, md5-verified): portal_self_register, portal_self_enrol_complete, admin_today,
-- portal_offer_letter_issue, portal_registration_create / _transition / _workbench / _exceptions, application_offer_recipient,
-- portal_offer_accept, rto_application_placement, application_course_discount_set, guest_declare_missing,
-- application_letter_course, agency_onboarding_presend_save, agency_onboarding_agreement_create (commission line only;
-- part B patches other snippets of these two).

-- 1. How long an English test result counts from its test date (application wizard, form and the submitted-application PDF).
select public.business_rule_add_setting('admissions.english_result_valid_years', 'English test result valid for', 'CRM & Admissions',
  'applications', 'documents', 'number', '2'::jsonb, '{"min":1,"max":10}'::jsonb,
  'Years an English test result counts from the date of the test (a valid-until date printed on the result wins). After that the application shows it as expired.');

-- 2. When a passport or visa shows "expiring soon".
select public.business_rule_add_setting('admissions.document_expiry_warning_months', 'Passport and visa "expiring soon" warning', 'CRM & Admissions',
  'applications', 'documents', 'number', '6'::jsonb, '{"min":1,"max":24}'::jsonb,
  'Months before a passport or visa expires that the application shows it as expiring soon.');

-- 3. What is accepted instead of an English test result (application wizard, English step).
select public.business_rule_add_setting('admissions.english_test_alternatives', 'Accepted instead of an English test', 'CRM & Admissions',
  'applications', 'english', 'list', '["At least 2 years of study in Australia","Cambridge English course with Skyline"]'::jsonb,
  '{"allowed":["At least 2 years of study in Australia","Cambridge English course with Skyline"]}'::jsonb,
  'The ways a student without an IELTS, PTE or TOEFL result may still meet the English requirement. Remove both to require a test result.');

-- 4a. Minimum overall English scores printed in the form's English requirements table.
select public.business_rule_add_setting('admissions.english_minimum_scores', 'Minimum English scores (overall)', 'CRM & Admissions',
  'applications', 'english', 'json', '{"IELTS":6,"PTE":50,"TOEFL":60}'::jsonb, '{"keys":["IELTS","PTE","TOEFL"]}'::jsonb,
  'The minimum overall score shown to applicants for each English test.');

-- 4b. Applicant age range on sign-up (Enroll now and the student profile completion).
select public.business_rule_add_setting('admissions.applicant_age_range', 'Applicant age range', 'CRM & Admissions',
  'applications', 'applicant', 'json', '{"minimum":10,"maximum":100}'::jsonb, '{"keys":["minimum","maximum"]}'::jsonb,
  'Youngest and oldest age, in years, a student may give as their date of birth when they sign up.');

create or replace function public.admissions_dob_outside_range(p_dob date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_json('admissions.applicant_age_range', '{"minimum":10,"maximum":100}'::jsonb); lo integer; hi integer;
begin
  lo := case when jsonb_typeof(v->'minimum') = 'number' then greatest(0, least(130, round((v->>'minimum')::numeric)::integer)) else 10 end;
  hi := case when jsonb_typeof(v->'maximum') = 'number' then greatest(0, least(130, round((v->>'maximum')::numeric)::integer)) else 100 end;
  if lo > hi then lo := 10; hi := 100; end if;
  return p_dob is null or p_dob > current_date - make_interval(years => lo) or p_dob < current_date - make_interval(years => hi);
end $$;
revoke all on function public.admissions_dob_outside_range(date) from public, anon;
grant execute on function public.admissions_dob_outside_range(date) to authenticated, service_role;

select public.business_rule_patch_function('public.portal_self_register(text,jsonb)'::regprocedure,
  $o$(v_dob is null or v_dob > current_date - interval '10 years' or v_dob < current_date - interval '100 years')$o$,
  $n$public.admissions_dob_outside_range(v_dob)$n$, 1);
select public.business_rule_patch_function('public.portal_self_enrol_complete(jsonb)'::regprocedure,
  $o$if v_dob is null or v_dob > current_date - interval '10 years' or v_dob < current_date - interval '100 years' then$o$,
  $n$if public.admissions_dob_outside_range(v_dob) then$n$, 1);

-- 5. Documents the application wizard does not let the agent skip (the passport always: the server needs it to submit).
select public.business_rule_add_setting('admissions.application_required_documents', 'Required application documents', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Passport","English test","Academic results","Visa"]'::jsonb,
  '{"allowed":["Passport","English test","Academic results","Visa","Driving licence"],"required":["Passport"]}'::jsonb,
  'Documents the application wizard asks for before the agent can continue. The others can be skipped. The passport is always required.');

-- 6. USI required on the application.
select public.business_rule_add_setting('admissions.usi_required', 'USI on the application', 'CRM & Admissions',
  'applications', 'applicant', 'dropdown', '"Required"'::jsonb, '{"allowed":["Required","Optional"]}'::jsonb,
  'Required: the application cannot go further without the student''s USI. Optional: the agent may answer that the student has no USI yet.',
  '["Required","Optional"]'::jsonb);

-- 7. The student document link sent by an agent (guest-documents Edge Function and guest_declare_missing).
select public.business_rule_add_setting('admissions.guest_link_required_documents', 'Student document link: required documents', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Passport"]'::jsonb,
  '{"allowed":["Passport","Visa","English test","Academic results","Driving licence","Health insurance"],"required":["Passport"]}'::jsonb,
  'Documents a student must upload before they can finish the upload link their agent sent them.');
select public.business_rule_add_setting('admissions.guest_link_skippable_documents', 'Student document link: "I don''t have this" allowed', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Visa","English test","Academic results"]'::jsonb,
  '{"allowed":["Visa","English test","Academic results","Driving licence","Health insurance"]}'::jsonb,
  'Documents the student may answer with "I don''t have this" on the upload link (the agent sees it).');
select public.business_rule_add_setting('admissions.guest_link_multiple_files', 'Student document link: several files allowed', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Academic results"]'::jsonb,
  '{"allowed":["Passport","Visa","English test","Academic results","Driving licence","Health insurance"]}'::jsonb,
  'Documents for which the student may upload several files. For every other document a new upload replaces the previous file.');
select public.business_rule_add_setting('admissions.guest_link_upload_cap', 'Student document link: most uploads', 'CRM & Admissions',
  'applications', 'documents', 'number', '30'::jsonb, '{"min":1,"max":100}'::jsonb,
  'The most files one upload link may hold.');

-- The category names the link stores for the labels above.
create or replace function public.admissions_guest_categories(p_id text, p_default text[]) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when jsonb_typeof(s.v) = 'array' then array(
    select case x when 'English test' then 'English Test' when 'Academic results' then 'Academic' when 'Driving licence' then 'Driving Licence'
      when 'Health insurance' then 'Health Insurance' else x end from jsonb_array_elements_text(s.v) x)
    else p_default end
  from (select public.rule_value(p_id, null) v) s;
$$;
revoke all on function public.admissions_guest_categories(text, text[]) from public, anon;
grant execute on function public.admissions_guest_categories(text, text[]) to authenticated, service_role;

select public.business_rule_patch_function('public.guest_declare_missing(uuid,text,boolean)'::regprocedure,
  $o$if p_category not in ('Visa', 'English Test', 'Academic') then$o$,
  $n$if not (p_category = any(public.admissions_guest_categories('admissions.guest_link_skippable_documents', array['Visa', 'English Test', 'Academic']))) then$n$, 1);

-- 8. Offer letter PDF staff upload (never above the 3 MB the database and the email attachment take).
select public.business_rule_add_setting('admissions.offer_letter_upload_mib', 'Offer letter upload limit', 'CRM & Admissions',
  'applications', 'offer', 'number', '3'::jsonb, '{"min":1,"max":3}'::jsonb,
  'Largest offer letter PDF, in MB, staff may upload. At most 3 MB.');
select public.business_rule_patch_function('public.portal_offer_letter_issue(uuid,text,text,text,uuid,text,text)'::regprocedure,
  $o$if length(v_bytes) > 3145728 then raise exception 'The letter is larger than 3 MB' using errcode = '22023'; end if;$o$,
  $n$if length(v_bytes) > least(3145728, (public.rule_num('admissions.offer_letter_upload_mib', 3) * 1048576)::bigint) then raise exception 'The letter is larger than % MB', least(3, public.rule_num('admissions.offer_letter_upload_mib', 3)) using errcode = '22023'; end if;$n$, 1);

-- 9. Statuses that count as "offer accepted or later" for CoE / VoE registration.
select public.business_rule_add_setting('admissions.offer_accepted_or_later_states', 'Statuses that count as "offer accepted or later"', 'CRM & Admissions',
  'applications', 'registration', 'list', '["Offer accepted","CoE issued","Enrolled"]'::jsonb,
  '{"allowed":["Offer issued","Offer accepted","CoE issued","Enrolled"]}'::jsonb,
  'Application statuses at which a CoE / VoE registration can be started, verified and listed on the registration workbench.');
create or replace function public.admissions_offer_accepted_states() returns text[]
language sql stable security definer set search_path = '' as $$
  select public.students_rule_keys('admissions.offer_accepted_or_later_states', array['offer_accepted', 'coe_issued', 'enrolled']);
$$;
revoke all on function public.admissions_offer_accepted_states() from public, anon;
grant execute on function public.admissions_offer_accepted_states() to authenticated, service_role;
select public.business_rule_patch_function('public.portal_registration_create(uuid,text)'::regprocedure,
  $o$if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then$o$,
  $n$if not (a.status = any(public.admissions_offer_accepted_states())) then$n$, 1);
select public.business_rule_patch_function('public.portal_registration_transition(uuid,text,text,text)'::regprocedure,
  $o$and a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then$o$,
  $n$and not (a.status = any(public.admissions_offer_accepted_states())) then$n$, 1);
select public.business_rule_patch_function('public.portal_registration_workbench()'::regprocedure,
  $o$where a.status in ('offer_accepted', 'coe_issued', 'enrolled') and$o$,
  $n$where a.status = any(public.admissions_offer_accepted_states()) and$n$, 1);
select public.business_rule_patch_function('public.portal_registration_exceptions()'::regprocedure,
  $o$where a.status in ('offer_accepted', 'coe_issued', 'enrolled', 'withdrawn', 'rejected') and$o$,
  $n$where (a.status = any(public.admissions_offer_accepted_states()) or a.status in ('withdrawn', 'rejected')) and$n$, 1);

-- 11. Offer discount range (the letter takes it off tuition; "applies to" and approval are not rules: see the report).
select public.business_rule_add_setting('finance.offer_discount_range', 'Offer discount range', 'Finance & Payments',
  'applications', 'offer', 'json', '{"minimum":0,"maximum":100}'::jsonb, '{"keys":["minimum","maximum"]}'::jsonb,
  'Lowest and highest discount, in percent of tuition, staff may give on an offer letter (always within 0 to 100).');
create or replace function public.finance_offer_discount_problem(p_percent numeric) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_json('finance.offer_discount_range', '{"minimum":0,"maximum":100}'::jsonb); lo numeric; hi numeric;
begin
  lo := case when jsonb_typeof(v->'minimum') = 'number' then greatest(0, least(100, (v->>'minimum')::numeric)) else 0 end;
  hi := case when jsonb_typeof(v->'maximum') = 'number' then greatest(0, least(100, (v->>'maximum')::numeric)) else 100 end;
  if lo > hi then lo := 0; hi := 100; end if;
  if p_percent is null or p_percent < lo or p_percent > hi then
    return 'Enter a discount between ' || trim_scale(lo)::text || ' and ' || trim_scale(hi)::text || ' percent';
  end if;
  return null;
end $$;
revoke all on function public.finance_offer_discount_problem(numeric) from public, anon;
grant execute on function public.finance_offer_discount_problem(numeric) to authenticated, service_role;
select public.business_rule_patch_function('public.application_course_discount_set(uuid,numeric)'::regprocedure,
  $o$if p_percent is null or p_percent < 0 or p_percent > 100 then raise exception 'Enter a discount between 0 and 100 percent' using errcode = '22023'; end if;$o$,
  $n$if public.finance_offer_discount_problem(p_percent) is not null then raise exception '%', public.finance_offer_discount_problem(p_percent) using errcode = '22023'; end if;$n$, 1);

-- 12. Agent commission (agency agreement Item 4).
select public.business_rule_add_setting('agents.commission_range', 'Agent commission range', 'Agents',
  'agency_agents', 'agreement', 'json', '{"minimum":0,"maximum":100}'::jsonb, '{"keys":["minimum","maximum"]}'::jsonb,
  'Lowest and highest commission, in percent, an agency agreement may carry (always within 0 to 100).');
select public.business_rule_add_setting('agents.commission_suggested', 'Suggested agent commission', 'Agents',
  'agency_agents', 'agreement', 'percentage', '25'::jsonb, '{"min":0,"max":100}'::jsonb,
  'The commission shown as the example on the agreement forms.');
create or replace function public.agents_commission_check(p_pct numeric) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_json('agents.commission_range', '{"minimum":0,"maximum":100}'::jsonb); lo numeric; hi numeric;
begin
  lo := case when jsonb_typeof(v->'minimum') = 'number' then greatest(0, least(100, (v->>'minimum')::numeric)) else 0 end;
  hi := case when jsonb_typeof(v->'maximum') = 'number' then greatest(0, least(100, (v->>'maximum')::numeric)) else 100 end;
  if lo > hi then lo := 0; hi := 100; end if;
  if p_pct is not null and (p_pct < lo or p_pct > hi) then
    raise exception 'The commission must be between % and % percent', trim_scale(lo), trim_scale(hi) using errcode = '22023';
  end if;
end $$;
revoke all on function public.agents_commission_check(numeric) from public, anon;
grant execute on function public.agents_commission_check(numeric) to authenticated, service_role;
select public.business_rule_patch_function('public.agency_onboarding_presend_save(uuid,jsonb)'::regprocedure,
  $o$if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end if;$o$,
  $n$if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end if;
  perform public.agents_commission_check(v_pct);$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_agreement_create(uuid,uuid,jsonb)'::regprocedure,
  $o$if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage'; end if;$o$,
  $n$if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage'; end if;
  perform public.agents_commission_check(v_pct);$n$, 1);

-- 40. Who the offer letter goes to.
select public.business_rule_add_setting('admissions.offer_letter_recipient', 'Offer letter goes to', 'CRM & Admissions',
  'applications', 'offer', 'dropdown', '"Agent when an agent started the application"'::jsonb,
  '{"allowed":["Agent when an agent started the application","Always the student"]}'::jsonb,
  'Who receives the offer letter (and signs it). Applications staff or the student started always go to the student.',
  '["Agent when an agent started the application","Always the student"]'::jsonb);
select public.business_rule_patch_function('public.application_offer_recipient(uuid)'::regprocedure,
  $o$v_agent := a.created_by is not null and exists ($o$,
  $n$v_agent := public.rule_text('admissions.offer_letter_recipient', 'Agent when an agent started the application') <> 'Always the student' and a.created_by is not null and exists ($n$, 1);
select public.business_rule_patch_function('public.application_offer_recipient(uuid)'::regprocedure,
  $o$'reason', case when a.created_by is null then$o$,
  $n$'reason', case when public.rule_text('admissions.offer_letter_recipient', 'Agent when an agent started the application') = 'Always the student' and a.created_by is not null then 'Offer letters always go to the student' when a.created_by is null then$n$, 1);

-- 41 + 42. Accepting an offer in the portal (signing the letter accepts it in every case; the deposit follows).
select public.business_rule_add_setting('admissions.offer_accept_in_portal', 'Accept offer button in the portal', 'CRM & Admissions',
  'applications', 'offer', 'dropdown', '"Allowed"'::jsonb, '{"allowed":["Allowed","Not allowed (signing only)"]}'::jsonb,
  'Allowed: the student or agent may accept the offer with the Accept offer button. Not allowed: the offer is accepted only by signing the letter.',
  '["Allowed","Not allowed (signing only)"]'::jsonb);
select public.business_rule_add_setting('admissions.offer_accept_portal_roles', 'Who may accept an offer in the portal', 'CRM & Admissions',
  'applications', 'offer', 'list', '["Student","Agent","Agency admin"]'::jsonb, '{"allowed":["Student","Agent","Agency admin"]}'::jsonb,
  'Portal users who may press Accept offer. SLIT staff never accept for the student.');
select public.business_rule_patch_function('public.portal_offer_accept(uuid)'::regprocedure,
  $o$ if public.portal_is_slit_admin() then raise exception 'Only the student or agent the letter went to accepts an offer' using errcode = '42501'; end if;$o$,
  $n$ if public.portal_is_slit_admin() then raise exception 'Only the student or agent the letter went to accepts an offer' using errcode = '42501'; end if;
 if public.rule_text('admissions.offer_accept_in_portal', 'Allowed') <> 'Allowed'
    or not (public.rule_json('admissions.offer_accept_portal_roles', '["Student","Agent","Agency admin"]'::jsonb)
      ? (case when public.portal_student_id() is not null then 'Student' when public.portal_is_agency_admin() then 'Agency admin' else 'Agent' end)) then
  raise exception 'The offer is accepted by signing the letter from the email' using errcode = '42501';
 end if;$n$, 1);

-- 43. When an unsigned offer shows on the dashboard.
select public.business_rule_add_setting('admissions.offer_unanswered_days', 'Offer flagged as unanswered after', 'CRM & Admissions',
  'applications', 'offer', 'days', '3'::jsonb, '{"min":1,"max":60}'::jsonb,
  'Days after an offer letter is sent, unsigned and not accepted, before it shows under Needs action today.');
select public.business_rule_patch_function('public.admin_today()'::regprocedure,
  $o$l.issued_at < now() - interval '3 days'$o$,
  $n$l.issued_at < now() - make_interval(days => public.rule_int('admissions.offer_unanswered_days', 3))$n$, 1);

-- 44. Withdrawn / rejected after acceptance.
select public.business_rule_add_setting('admissions.withdrawal_class_removal', 'Withdrawn or rejected after acceptance', 'CRM & Admissions',
  'applications', 'placement', 'dropdown', '"Remove from classes automatically"'::jsonb,
  '{"allowed":["Remove from classes automatically","Leave in classes for staff to remove"]}'::jsonb,
  'What happens to the student''s class places when an accepted application is withdrawn or rejected.',
  '["Remove from classes automatically","Leave in classes for staff to remove"]'::jsonb);
select public.business_rule_patch_function('public.rto_application_placement()'::regprocedure,
  $o$elsif new.status in ('withdrawn', 'rejected') and old.status = any($o$,
  $n$elsif new.status in ('withdrawn', 'rejected') and public.rule_text('admissions.withdrawal_class_removal', 'Remove from classes automatically') = 'Remove from classes automatically' and old.status = any($n$, 1);

-- Extra (from part C): the offer letter's hours a week follow the live CoE / VoE study-hours rules (20 / 40 today).
select public.business_rule_patch_function('public.application_letter_course(enrollment_application_courses,text,cms_settings,text)'::regprocedure,
  $o$raw := case i.study_load when 'coe' then '20' else '40' end;$o$,
  $n$raw := trim_scale(case i.study_load when 'coe' then public.rule_num('lms.coe_weekly_study_hours', 20) else public.rule_num('lms.voe_weekly_study_hours', 40) end)::text;$n$, 1);

do $$
declare id text; missing text[] := '{}';
begin
  foreach id in array array['admissions.english_result_valid_years', 'admissions.document_expiry_warning_months', 'admissions.english_test_alternatives',
    'admissions.english_minimum_scores', 'admissions.applicant_age_range', 'admissions.application_required_documents', 'admissions.usi_required',
    'admissions.guest_link_required_documents', 'admissions.guest_link_skippable_documents', 'admissions.guest_link_multiple_files',
    'admissions.guest_link_upload_cap', 'admissions.offer_letter_upload_mib', 'admissions.offer_accepted_or_later_states', 'finance.offer_discount_range',
    'agents.commission_range', 'agents.commission_suggested', 'admissions.offer_letter_recipient', 'admissions.offer_accept_in_portal',
    'admissions.offer_accept_portal_roles', 'admissions.offer_unanswered_days', 'admissions.withdrawal_class_removal'] loop
    if not exists (select 1 from public.business_rules r join public.business_rule_versions v on v.rule_id = r.id
                   where r.scope_key = '' and r.identifier = id and v.state = 'published')
       or public.rule_value(id, null) is null then
      missing := missing || id;
    end if;
  end loop;
  if cardinality(missing) > 0 then raise exception 'BUSINESS-RULES-LIVE A: not live: %', missing; end if;
end $$;

-- ===== B =====
-- Agents and agency onboarding. Every rule starts at what the system does today (hosted, 2026-11-20).
-- Functions patched here (hosted bodies, verified by md5 against the repo replay): agency_onboarding_presend_save,
-- agency_onboarding_agreement_create, agency_onboarding_approve, agency_onboarding_correction_request,
-- agency_onboarding_accept_signed, agency_onboarding_resubmitted, agency_onboarding_referee_change_email,
-- agency_onboarding_agreement_issue, admin_business_create, agency_abr_attach, admin_business_document_add.

-- agents.agreement_term_years: how long the agent agreement runs (Item 5). Today 2 years: the expiry is the day before
-- the anniversary. The database now works the expiry out itself from the commencement date (the date the Edge Function
-- sends is ignored), so the rule is in force without a function deploy.
select public.business_rule_add_setting('agents.agreement_term_years', 'Agent agreement length (years)', 'Agents', 'agency_agents', 'agent_agreement', 'number',
  '2'::jsonb, '{"min":1,"max":5}'::jsonb,
  'How many years an agent agreement runs from its commencement date. The expiry date is the day before that anniversary; when it passes, the business''s agents can no longer work until the agreement is renewed. The printed agreement (P06, Item 5) says "2 year": change its wording in the agreement template as well if you change this.');

-- agents.business_approval_waits_for_referees: today (2026-11-20 sign-once flow) Approve and Send back do not wait for the
-- referees. "Wait for every referee" makes both refuse while a referee check is still out.
select public.business_rule_add_setting('agents.business_approval_waits_for_referees', 'Approve a business before its referees reply', 'Agents', 'agency_agents', 'agent_onboarding', 'dropdown',
  '"Approve without waiting"'::jsonb, '{"allowed":["Approve without waiting","Wait for every referee"]}'::jsonb,
  'Whether staff can approve a business application, or send it back for correction, before both referees have replied. "Approve without waiting": replies that arrive later are kept on the business record. "Wait for every referee": Approve and Send back are refused until every referee check is back (signed or uploaded).',
  '["Approve without waiting","Wait for every referee"]'::jsonb, true);

-- agents.referee_emails_must_differ: the two referees on the application form need different email addresses (today: yes).
select public.business_rule_add_setting('agents.referee_emails_must_differ', 'Referees need different email addresses', 'Agents', 'agency_agents', 'agent_onboarding', 'dropdown',
  '"Must be different"'::jsonb, '{"allowed":["Must be different","May be the same"]}'::jsonb,
  'Whether the two referees on the Agent Application Form must have different email addresses. With "May be the same", both referee checks go to the same address (each with its own link). A referee can never use the applicant''s own email address.',
  '["Must be different","May be the same"]'::jsonb);

-- agents.agency_witness_on_agreement: the agency admin's witness on the agreement (today: required, typed name + drawn signature).
select public.business_rule_add_setting('agents.agency_witness_on_agreement', 'Agency''s witness on the agent agreement', 'Agents', 'agency_agents', 'agent_agreement', 'dropdown',
  '"Required"'::jsonb, '{"allowed":["Required","Optional"]}'::jsonb,
  'Whether the agency admin must have a witness when signing the agent agreement (the witness types their name and draws their signature on the signing page). With "Optional" the witness may be left empty; if a witness is given, both the name and the drawn signature are needed.',
  '["Required","Optional"]'::jsonb);

-- agents.slit_witness_on_agreement: SLIT's witness on the agreement (today: optional; given before sending or when approving).
select public.business_rule_add_setting('agents.slit_witness_on_agreement', 'SLIT witness on the agent agreement', 'Agents', 'agency_agents', 'agent_agreement', 'dropdown',
  '"Optional"'::jsonb, '{"allowed":["Optional","Required"]}'::jsonb,
  'Whether a SLIT witness must sign the agent agreement. It can be added when preparing the application or when approving it. With "Required", the agreement is not countersigned and issued without a SLIT witness.',
  '["Optional","Required"]'::jsonb);

-- agents.cancelled_abn_business: a business whose ABN is cancelled on the register can be added with a reason (today: yes).
select public.business_rule_add_setting('agents.cancelled_abn_business', 'Add a business whose ABN is cancelled', 'Agents', 'agency_agents', 'business', 'dropdown',
  '"Allowed with a reason"'::jsonb, '{"allowed":["Allowed with a reason","Not allowed"]}'::jsonb,
  'Whether staff can add a business whose ABN the government register (ABN Lookup) shows as cancelled. "Allowed with a reason": staff tick Add it anyway and give a reason, kept on the business''s history. "Not allowed": such a business cannot be added.',
  '["Allowed with a reason","Not allowed"]'::jsonb);

-- agents.review_email_recipients: who is emailed when a business application needs staff (signed and ready for review,
-- referees replied, resubmitted after a correction). Today: all three.
select public.business_rule_add_setting('agents.review_email_recipients', 'Who is emailed when an application is ready for review', 'Agents', 'agency_agents', 'agent_onboarding', 'multiple selection',
  '["Staff member who started it","Active CMS administrators","Admissions and office contacts"]'::jsonb,
  '{"allowed":["Staff member who started it","Active CMS administrators","Admissions and office contacts"]}'::jsonb,
  'Who receives the staff emails about a business application: when it is signed and ready for review, when the referees have replied and when it is resubmitted after a correction. "Admissions and office contacts" are the admissions and general email addresses in Website settings. If the staff member or the administrators are selected but give no email address (or nothing is selected), the emails go to the configured administrators'' inbox.',
  '["Staff member who started it","Active CMS administrators","Admissions and office contacts"]'::jsonb);

-- agents.signed_copy_upload_max_mb: a signed agreement / paper copy uploaded on the business page (today 15 MB, which is also
-- the storage ceiling of the business-documents bucket, so 15 is the maximum).
select public.business_rule_add_setting('agents.signed_copy_upload_max_mb', 'Signed agreement upload size limit (MB)', 'Agents', 'agency_agents', 'business_document', 'number',
  '15'::jsonb, '{"min":1,"max":15}'::jsonb,
  'The largest file (in MB) staff can upload on a business page as a signed agent agreement or other business document. 15 MB is the most the document store accepts.');

-- ------------------------------------------------------------------ helpers
-- The agreement's expiry: commencement plus the rule's years, the day before the anniversary (JavaScript Date.UTC overflow, as before:
-- 29 Feb + 2 years = 1 Mar, then the day before).
create or replace function public.agent_agreement_expiry(p_start date) returns date
language sql stable set search_path = '' as $f$
  select case when p_start is null then null else
    (make_date(extract(year from p_start)::integer + greatest(1, public.rule_int('agents.agreement_term_years', 2)), extract(month from p_start)::integer, 1)
      + (extract(day from p_start)::integer - 1)) - 1 end
$f$;
revoke all on function public.agent_agreement_expiry(date) from public, anon;
grant execute on function public.agent_agreement_expiry(date) to authenticated, service_role;

-- True while the rule says to wait for the referees and one of this onboarding's referee checks is not back.
create or replace function public.agency_onboarding_referees_block(p_onboarding uuid) returns boolean
language sql stable security definer set search_path = '' as $f$
  select public.rule_text('agents.business_approval_waits_for_referees', 'Approve without waiting') = 'Wait for every referee'
    and exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = p_onboarding and f.status <> 'received')
$f$;
revoke all on function public.agency_onboarding_referees_block(uuid) from public, anon, authenticated;

create or replace function public.agent_referee_emails_distinct() returns boolean
language sql stable set search_path = '' as $f$
  select public.rule_text('agents.referee_emails_must_differ', 'Must be different') <> 'May be the same'
$f$;
grant execute on function public.agent_referee_emails_distinct() to authenticated, service_role;

-- For the Edge Function before Approve: true when the rule requires a SLIT witness and none was given before sending.
create or replace function public.agency_onboarding_slit_witness_needed(p_onboarding uuid) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
begin
 perform hr.require_admin();
 return public.rule_text('agents.slit_witness_on_agreement', 'Optional') = 'Required'
   and exists (select 1 from public.agency_onboarding o where o.id = p_onboarding and o.slit_witness_png is null);
end $f$;
revoke all on function public.agency_onboarding_slit_witness_needed(uuid) from public, anon;
grant execute on function public.agency_onboarding_slit_witness_needed(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ 13: agreement length
select public.business_rule_patch_function('public.agency_onboarding_presend_save(uuid,jsonb)'::regprocedure,
  $o$v_end := (p_data->>'expiryDate')::date;$o$,
  $n$v_end := public.agent_agreement_expiry(v_start);$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_agreement_create(uuid,uuid,jsonb)'::regprocedure,
  $o$v_end := (p_data->>'expiry_date')::date;$o$,
  $n$v_end := public.agent_agreement_expiry(v_start);$n$, 1);

-- ------------------------------------------------------------------ 15/58: approval / send back wait for the referees (rule)
select public.business_rule_patch_function('public.agency_onboarding_approve(uuid)'::regprocedure,
  $o$ select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;$o$,
  $n$ select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if public.agency_onboarding_referees_block(o.id) then
  raise exception 'The application can be approved once every referee has replied (% of % back).', v_received, v_total using errcode = '22023', hint = 'references_outstanding'; end if;$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_correction_request(uuid,uuid,jsonb)'::regprocedure,
  $o$ -- 2026-11-20: referees no longer block a correction.$o$,
  $n$ -- 2026-11-20: referees no longer block a correction, unless Business Rules say to wait for them.
 if public.agency_onboarding_referees_block(o.id) then
  raise exception 'The application can be sent back once every referee has replied.' using errcode = '22023', hint = 'references_outstanding'; end if;$n$, 1);

-- ------------------------------------------------------------------ 14: referee emails different (rule)
select public.business_rule_patch_function('public.agency_onboarding_accept_signed(uuid,uuid,uuid,bytea,bytea,jsonb)'::regprocedure,
  $o$if v_emails[1] = v_emails[2] then raise exception$o$,
  $n$if v_emails[1] = v_emails[2] and public.agent_referee_emails_distinct() then raise exception$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_resubmitted(uuid,uuid,uuid,bytea,bytea,jsonb)'::regprocedure,
  $o$if v_emails[1] = v_emails[2] then raise exception$o$,
  $n$if v_emails[1] = v_emails[2] and public.agent_referee_emails_distinct() then raise exception$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_referee_change_email(uuid,text,text)'::regprocedure,
  $o$and x.id <> f.id and x.email = v_email) then raise exception$o$,
  $n$and x.id <> f.id and x.email = v_email) and public.agent_referee_emails_distinct() then raise exception$n$, 1);

-- ------------------------------------------------------------------ 16: SLIT witness required (rule); the agency witness is checked by document-signing
select public.business_rule_patch_function('public.agency_onboarding_agreement_issue(uuid,text,jsonb)'::regprocedure,
  $o$ if o.stage <> 'references_approved' then raise exception 'Approve the application first.' using errcode = '22023'; end if;$o$,
  $n$ if o.stage <> 'references_approved' then raise exception 'Approve the application first.' using errcode = '22023'; end if;
 if public.rule_text('agents.slit_witness_on_agreement', 'Optional') = 'Required' and o.slit_witness_name is null
   and nullif(public.agency_onboarding_clean(p_data->>'admin_witness_name', 150), '') is null then
  raise exception 'A SLIT witness is required on the agreement: the witness types their name and draws their signature, then approve again.' using errcode = '22023', hint = 'slit_witness_required'; end if;$n$, 1);

-- ------------------------------------------------------------------ 17: cancelled ABN (rule)
select public.business_rule_patch_function('public.admin_business_create(jsonb,text,text)'::regprocedure,
  $o$ if v_abn !~ '^\d{11}$' then raise exception 'Enter the business''s 11-digit ABN.' using errcode = '22023'; end if;$o$,
  $n$ if v_abn !~ '^\d{11}$' then raise exception 'Enter the business''s 11-digit ABN.' using errcode = '22023'; end if;
 if public.rule_text('agents.cancelled_abn_business', 'Allowed with a reason') = 'Not allowed' and exists (select 1 from public.abr_lookups l
   where l.abn = v_abn and l.fetched_at > now() - interval '1 day' and coalesce((l.details->>'active')::boolean, true) is false) then
  raise exception 'This ABN is not active on the government register, and a business with a cancelled ABN cannot be added.' using errcode = '22023', hint = 'abn_cancelled'; end if;$n$, 1);
select public.business_rule_patch_function('public.agency_abr_attach(uuid,jsonb)'::regprocedure,
  $o$ if coalesce((l.details->>'active')::boolean, false) is false and v_override = '' then$o$,
  $n$ if coalesce((l.details->>'active')::boolean, false) is false and public.rule_text('agents.cancelled_abn_business', 'Allowed with a reason') = 'Not allowed' then
  raise exception 'This ABN is % on the government register, and a business with a cancelled ABN cannot be added.', coalesce(nullif(l.details->>'abnStatus', ''), 'not active') using errcode = '22023', hint = 'abn_cancelled';
 end if;
 if coalesce((l.details->>'active')::boolean, false) is false and v_override = '' then$n$, 1);

-- ------------------------------------------------------------------ 39: signed agreement / document upload size (rule)
select public.business_rule_patch_function('public.admin_business_document_add(uuid,text,text,text,bigint,text)'::regprocedure,
  $o$  raise exception 'Upload the file first' using errcode = '22023'; end if;$o$,
  $n$  raise exception 'Upload the file first' using errcode = '22023'; end if;
 if coalesce((select (o.metadata->>'size')::bigint from storage.objects o where o.bucket_id = 'business-documents' and o.name = p_path), p_size, 0)
   > least(15, greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15)))::bigint * 1048576 then
  raise exception 'The file is larger than % MB.', least(15, greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15))) using errcode = '22023'; end if;$n$, 1);

-- ------------------------------------------------------------------ check
do $$
declare v text; n integer;
begin
  foreach v in array array['agents.agreement_term_years', 'agents.business_approval_waits_for_referees', 'agents.referee_emails_must_differ',
    'agents.agency_witness_on_agreement', 'agents.slit_witness_on_agreement', 'agents.cancelled_abn_business', 'agents.review_email_recipients',
    'agents.signed_copy_upload_max_mb'] loop
    select count(*) into n from public.business_rules r join public.business_rule_versions x on x.rule_id = r.id and x.state = 'published'
     where r.scope_key = '' and r.identifier = v and r.registration->>'handler' = 'setting';
    if n <> 1 then raise exception 'BUSINESS-RULES-LIVE B: rule % is not published (% versions)', v, n; end if;
  end loop;
  if public.agent_agreement_expiry('2026-11-17') <> '2028-11-16' or public.agent_agreement_expiry('2028-02-29') <> '2030-02-28' then
    raise exception 'BUSINESS-RULES-LIVE B: agreement expiry is not today''s value'; end if;
  if not public.agent_referee_emails_distinct() then raise exception 'BUSINESS-RULES-LIVE B: referee emails rule is not today''s value'; end if;
end $$;

-- ===== C =====
-- Part C: LMS, intakes, courses, study progress, completions, bookings. Every rule starts at today's value.
-- Functions patched here (hosted bodies of 2026-11-20): rto_is_working_day, rto_is_teaching_day, intake_generate_schedule,
-- intake_schedule_preview, course_intakes_open, course_intake_offered, course_join_options, application_intake_problem,
-- course_go_live_after_classes, cms_course_ready_problem, rto_intake_rolling_sweep, rto_intake_auto_next,
-- rto_carry_over_plan, course_completion_issue, booking_free_slots, rto_staff_place.
-- VoE pace (item 53) gets no rule of its own: intake_generate_schedule now derives it from lms.voe_weekly_study_hours /
-- lms.coe_weekly_study_hours (40 / 20 = 2 today).

-- ----- helpers -----
-- The weekdays (ISO 1 = Monday ... 7 = Sunday) that count when unit and intake dates are laid out (lms.course_working_days).
-- Read once per transaction (rto_is_working_day runs for every day of a course's calendar).
create or replace function public.lms_working_isodows() returns integer[]
language plpgsql stable security definer set search_path = '' as $$
declare v text := current_setting('rto.rule_working_days', true); a integer[];
begin
  if coalesce(v, '') <> '' then return v::integer[]; end if;
  a := array(select distinct x from (
      select case lower(btrim(d)) when 'monday' then 1 when 'tuesday' then 2 when 'wednesday' then 3 when 'thursday' then 4
        when 'friday' then 5 when 'saturday' then 6 when 'sunday' then 7 end as x
      from jsonb_array_elements_text(case when jsonb_typeof(public.rule_json('lms.course_working_days', '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb)) = 'array'
        then public.rule_json('lms.course_working_days', '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb)
        else '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb end) d) z
    where x is not null order by x);
  if cardinality(a) = 0 then a := '{1,2,3,4,5}'::integer[]; end if;
  perform set_config('rto.rule_working_days', a::text, true);
  return a;
end $$;
grant execute on function public.lms_working_isodows() to authenticated, service_role;

-- A certificate / statement number pattern: letters, digits, - _ / . and the placeholders {yyyy}, {yy}, {mm} and exactly
-- one {###...} (1 to 12 #) for the running number.
create or replace function public.lms_number_format_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and length(p) between 3 and 60
    and (select count(*) from regexp_matches(p, '\{#+\}', 'g')) = 1
    and length(substring(p from '\{(#+)\}')) between 1 and 12
    and regexp_replace(p, '\{(yyyy|yy|mm|#+)\}', '', 'g') ~ '^[A-Za-z0-9/_.-]*$';
$$;
grant execute on function public.lms_number_format_ok(text) to authenticated, service_role;

-- The next certificate (or statement of attainment) number from its rule (one shared sequence, as before).
create or replace function public.course_completion_number(p_kind text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_def text := case p_kind when 'certificate' then 'SLIT-C-{yyyy}-{######}' else 'SLIT-SOA-{yyyy}-{######}' end;
  v_pat text; v_at timestamp := now() at time zone 'Australia/Melbourne'; v_seq text; v_w integer;
begin
  v_pat := public.rule_text(case p_kind when 'certificate' then 'lms.certificate_number_format' else 'lms.statement_number_format' end, v_def);
  if not public.lms_number_format_ok(v_pat) then v_pat := v_def; end if;
  v_seq := nextval('public.course_completion_seq')::text;
  v_w := length(substring(v_pat from '\{(#+)\}'));
  return regexp_replace(replace(replace(replace(v_pat, '{yyyy}', to_char(v_at, 'YYYY')), '{yy}', to_char(v_at, 'YY')), '{mm}', to_char(v_at, 'MM')),
    '\{#+\}', lpad(v_seq, greatest(v_w, length(v_seq)), '0'));
end $$;
revoke all on function public.course_completion_number(text) from public, anon, authenticated, service_role;

-- Values the registration limits cannot check (number patterns, a non-empty day list, clock times) are refused on save.
create or replace function public.business_rule_versions_lms_check() returns trigger
language plpgsql set search_path = '' as $$
declare v jsonb := new.definition->'value'; v_id text := new.definition->>'identifier';
begin
  if v_id in ('lms.certificate_number_format', 'lms.statement_number_format') then
    if jsonb_typeof(v) is distinct from 'string' or not public.lms_number_format_ok(v #>> '{}') then
      raise exception 'Use letters, digits, - _ / . and the placeholders {yyyy}, {yy}, {mm}, with one {######} for the running number (for example SLIT-C-{yyyy}-{######}).' using errcode = '22023';
    end if;
  elsif v_id = 'lms.course_working_days' then
    if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v) = 0 then
      raise exception 'Choose at least one day.' using errcode = '22023';
    end if;
  elsif v_id = 'lms.class_suggestion_hours' then
    if jsonb_typeof(v) is distinct from 'object' or coalesce(v->>'earliest', '') !~ '^([01][0-9]|2[0-3]):(00|30)$'
       or coalesce(v->>'latest', '') !~ '^(([01][0-9]|2[0-3]):(00|30)|24:00)$' or v->>'earliest' >= v->>'latest' then
      raise exception 'Enter the earliest and latest times as HH:MM on the hour or half hour, the earliest before the latest.' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists business_rule_versions_lms_check on public.business_rule_versions;
create trigger business_rule_versions_lms_check before insert or update on public.business_rule_versions
  for each row execute function public.business_rule_versions_lms_check();

-- ----- rules -----
-- 20. A master timetable above this many class hours a week is taken for VoE (new course wizard).
select public.business_rule_add_setting('lms.voe_threshold_weekly_hours', 'Class hours a week that count as VoE', 'Intakes & Scheduling',
  'lms/courses', 'course', 'hours', '30'::jsonb, '{"min":1,"max":80}'::jsonb,
  'When a course''s saved master timetable gives more class hours a week than this, the new course wizard picks VoE for it; otherwise CoE.');
-- 21. Automatic class suggestions (Create timetable / Class setup): the day count tried first, and the earliest and latest times.
select public.business_rule_add_setting('lms.class_suggestion_preferred_days', 'Suggested class days a week', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '5'::jsonb, '{"min":1,"max":7}'::jsonb,
  'When the timetable form suggests class times for a room or trainer, it tries this many days a week first (Monday onwards).');
select public.business_rule_add_setting('lms.class_suggestion_hours', 'Earliest and latest class times', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'json', '{"earliest":"07:00","latest":"22:00"}'::jsonb, '{"keys":["earliest","latest"]}'::jsonb,
  'The timetable form offers class times from the earliest time and never suggests or shows classes after the latest time (HH:MM, on the hour or half hour).');
-- 22. Enrolment type when staff place a student by hand without choosing one.
select public.business_rule_add_setting('lms.manual_placement_default_type', 'Enrolment type when placing a student by hand', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'dropdown', '"CoE"'::jsonb, '{"allowed":["CoE","VoE","Domestic"]}'::jsonb,
  'Preselected on Override: place a student, and used when no type is given.', '["CoE","VoE","Domestic"]'::jsonb);
-- 45. The automatic intake made when a course on offer has none.
select public.business_rule_add_setting('lms.auto_intake_create', 'Create an intake automatically when none is on offer', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'boolean', 'true'::jsonb, '{}'::jsonb,
  'Yes: when a published course has no running or upcoming intake, one is created on the first working day of a coming month. No: staff create every intake.');
select public.business_rule_add_setting('lms.auto_intake_months_ahead', 'Automatic intake starts this many months ahead', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '1'::jsonb, '{"min":1,"max":12}'::jsonb,
  'An automatic intake starts on the first working day of the month this many months after the current month (1 = next month).');
-- 46. Upcoming intakes offered to applicants.
select public.business_rule_add_setting('lms.intake_upcoming_per_load', 'Upcoming intakes offered per study load', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '1'::jsonb, '{"min":1,"max":12}'::jsonb,
  'The application form offers the intakes running today plus this many upcoming intakes for CoE and for VoE (courses without a master timetable).');
-- 47. Start dates an applicant may choose.
select public.business_rule_add_setting('lms.join_dates', 'Start dates applicants may choose', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'dropdown', '"Any unit start date"'::jsonb, '{"allowed":["Any unit start date","Intake day one only"]}'::jsonb,
  'Any unit start date: the application form lists day one of an intake and every upcoming unit start. Intake day one only: only the first day of intakes that have not started.',
  '["Any unit start date","Intake day one only"]'::jsonb);
-- 48. When the next automatic intake is created.
select public.business_rule_add_setting('lms.intake_next_at_percent', 'Create the next intake when an automatic intake is this far through', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'percentage', '50'::jsonb, '{"min":0,"max":100}'::jsonb,
  'The 15-minute job creates the next intake once an automatically created intake has run this share of its length. An intake made by staff gets its next one at once.');
-- 49. Gap between intakes.
select public.business_rule_add_setting('lms.intake_gap_days', 'Days between one intake and the next', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'days', '0'::jsonb, '{"min":0,"max":365}'::jsonb,
  'An automatic next intake starts on the first working day after the previous intake ends plus this many days.');
-- 50. A course goes live by itself once set up.
select public.business_rule_add_setting('lms.course_auto_go_live', 'Publish a course automatically once it is set up', 'Courses & Units',
  'lms/courses', 'course', 'boolean', 'true'::jsonb, '{}'::jsonb,
  'Yes: a course becomes Published and active when it has active units, a master timetable and an intake with classes. No: staff publish it by hand.');
-- 51. Publishing needs an open intake.
select public.business_rule_add_setting('lms.course_publish_needs_intake', 'Publishing a course needs an open intake', 'Courses & Units',
  'lms/courses', 'course', 'boolean', 'true'::jsonb, '{}'::jsonb,
  'Yes: a course can be Published or made active only with active units and an open intake. No: active units are enough.');
-- 52. Days that count for course dates, and optional public holidays.
select public.business_rule_add_setting('lms.course_working_days', 'Days that count for unit and intake dates', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'multiple selection', '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb,
  '{"allowed":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]}'::jsonb,
  'Unit and intake start and end dates fall on these days (public holidays and term breaks are always left out). A unit''s weeks are counted in these days.',
  '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]'::jsonb);
select public.business_rule_add_setting('lms.optional_holidays_stop_classes', 'Optional public holidays stop classes', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'boolean', 'false'::jsonb, '{}'::jsonb,
  'No: only confirmed public holidays stop classes and course dates. Yes: confirmed optional holidays stop them too.');
-- 55. Carry-over of units not yet Competent.
select public.business_rule_add_setting('lms.carry_over_rounds', 'Rounds of later intakes searched for carried-over units', 'Student Management',
  'lms/intakes', 'intake', 'number', '5'::jsonb, '{"min":1,"max":20}'::jsonb,
  'A student''s units not yet Competent are placed in later intakes; when they do not fit, a new intake is created and searched again, up to this many rounds.');
-- 57. Certificate and statement of attainment numbers.
select public.business_rule_add_setting('lms.certificate_number_format', 'Certificate number format', 'Academic & Attendance',
  'lms/completion', 'completion', 'text', '"SLIT-C-{yyyy}-{######}"'::jsonb, '{}'::jsonb,
  'Placeholders: {yyyy} year, {yy} short year, {mm} month, {######} the running number padded to that many digits (exactly one).');
select public.business_rule_add_setting('lms.statement_number_format', 'Statement of attainment number format', 'Academic & Attendance',
  'lms/completion', 'completion', 'text', '"SLIT-SOA-{yyyy}-{######}"'::jsonb, '{}'::jsonb,
  'Placeholders: {yyyy} year, {yy} short year, {mm} month, {######} the running number padded to that many digits (exactly one).');
-- 63. Booking start times.
select public.business_rule_add_setting('booking.slot_interval_minutes', 'Minutes between booking start times', 'Other',
  'bookings', 'booking', 'number', '30'::jsonb, '{"min":5,"max":240}'::jsonb,
  'Bookable times start every this many minutes (or every meeting length, when the meeting is shorter).');

-- ----- functions follow the rules -----
-- 52. Working days and optional holidays.
select public.business_rule_patch_function('public.rto_is_working_day(date)'::regprocedure,
  $o$select extract(isodow from p_day) < 6$o$,
  $n$select extract(isodow from p_day)::integer = any(public.lms_working_isodows())$n$);
select public.business_rule_patch_function('public.rto_is_working_day(date)'::regprocedure,
  $o$h.status = 'confirmed' and not h.is_optional)$o$,
  $n$h.status = 'confirmed' and (not h.is_optional or public.rule_bool('lms.optional_holidays_stop_classes', false)))$n$);
select public.business_rule_patch_function('public.rto_is_teaching_day(date)'::regprocedure,
  $o$h.status = 'confirmed' and not h.is_optional)$o$,
  $n$h.status = 'confirmed' and (not h.is_optional or public.rule_bool('lms.optional_holidays_stop_classes', false)))$n$);
select public.business_rule_patch_function('public.intake_schedule_preview(uuid, date, text)'::regprocedure,
  $o$where extract(isodow from d) < 6 and not public.rto_is_working_day(d::date);$o$,
  $n$where extract(isodow from d)::integer = any(public.lms_working_isodows()) and not public.rto_is_working_day(d::date);$n$);
-- 53 + 52. VoE pace from the CoE / VoE weekly hours (40 / 20 = 2 today); a unit's weeks counted in working days a week.
select public.business_rule_patch_function('public.intake_generate_schedule(uuid, date, text[], date)'::regprocedure,
  $o$v_rate := case when i.study_load = 'voe' then 2 else 1 end;$o$,
  $n$v_rate := case when i.study_load = 'voe' then coalesce(public.rule_num('lms.voe_weekly_study_hours', 40) / nullif(public.rule_num('lms.coe_weekly_study_hours', 20), 0), 2) else 1 end;$n$);
select public.business_rule_patch_function('public.intake_generate_schedule(uuid, date, text[], date)'::regprocedure,
  $o$coalesce(u.duration_weeks, u.default_weeks) * 5 / v_rate$o$,
  $n$coalesce(u.duration_weeks, u.default_weeks) * cardinality(public.lms_working_isodows()) / v_rate$n$);
-- 45. Automatic intake when none is on offer.
select public.business_rule_patch_function('public.course_intakes_open(text)'::regprocedure,
  $o$if v_cid is not null and not exists (select 1 from public.course_intake_offered(v_cid))$o$,
  $n$if v_cid is not null and public.rule_bool('lms.auto_intake_create', true) and not exists (select 1 from public.course_intake_offered(v_cid))$n$);
select public.business_rule_patch_function('public.course_intakes_open(text)'::regprocedure,
  $o$+ interval '1 month')::date)$o$,
  $n$+ make_interval(months => public.rule_int('lms.auto_intake_months_ahead', 1)))::date)$n$);
-- 46. Upcoming intakes per study load.
select public.business_rule_patch_function('public.course_intake_offered(text)'::regprocedure,
  $o$select distinct on (l.study_load) l.id from live l, t, m where not m.on_master and l.start_date > t.d order by l.study_load, l.start_date, l.id) n;$o$,
  $n$select l.id, row_number() over (partition by l.study_load order by l.start_date, l.id) as rn from live l, t, m where not m.on_master and l.start_date > t.d) n where n.rn <= public.rule_int('lms.intake_upcoming_per_load', 1);$n$);
-- 47. Start dates applicants may choose (list and submit check).
select public.business_rule_patch_function('public.course_join_options(text)'::regprocedure,
  $o$select u.start_date from public.intake_units u where u.intake_id = i.id) z$o$,
  $n$select u.start_date from public.intake_units u where u.intake_id = i.id and public.rule_text('lms.join_dates', 'Any unit start date') <> 'Intake day one only') z$n$);
select public.business_rule_patch_function('public.course_join_options(text)'::regprocedure,
  $o$
  return v_old;
end$o$,
  $n$
  if public.rule_text('lms.join_dates', 'Any unit start date') = 'Intake day one only' then
    return coalesce((select jsonb_agg(x.v order by x.n) from jsonb_array_elements(v_old) with ordinality x(v, n)
      where not coalesce((x.v->>'running')::boolean, false)), '[]'::jsonb);
  end if;
  return v_old;
end$n$);
select public.business_rule_patch_function('public.application_intake_problem(uuid)'::regprocedure,
  $o$and not exists (select 1 from public.intake_units u where u.intake_id = v_first.intake_id and u.start_date = v_join) then$o$,
  $n$and (public.rule_text('lms.join_dates', 'Any unit start date') = 'Intake day one only' or not exists (select 1 from public.intake_units u where u.intake_id = v_first.intake_id and u.start_date = v_join)) then$n$);
-- 50. Course goes live by itself.
select public.business_rule_patch_function('public.course_go_live_after_classes()'::regprocedure,
  $o$     and public.course_setup_complete(c.id);$o$,
  $n$     and public.course_setup_complete(c.id)
     and public.rule_bool('lms.course_auto_go_live', true);$n$);
-- 51. Publishing needs an open intake (trigger cms_courses_needs_intake reads cms_course_ready_problem).
select public.business_rule_patch_function('public.cms_course_ready_problem(text)'::regprocedure,
  $o$when not exists (select 1 from public.course_intakes i where i.course_id = p_course and i.is_active$o$,
  $n$when public.rule_bool('lms.course_publish_needs_intake', true) and not exists (select 1 from public.course_intakes i where i.course_id = p_course and i.is_active$n$);
-- 48. Next automatic intake at a share of the current one.
select public.business_rule_patch_function('public.rto_intake_rolling_sweep()'::regprocedure,
  $o$and v_today < l.start_date + ((v_end - l.start_date) / 2);$o$,
  $n$and v_today < l.start_date + trunc((v_end - l.start_date) * public.rule_num('lms.intake_next_at_percent', 50) / 100)::integer;$n$);
-- 49. Gap between intakes.
select public.business_rule_patch_function('public.rto_intake_auto_next(uuid)'::regprocedure,
  $o$greatest(v_last, coalesce(src.end_date, v_last)) + 1);$o$,
  $n$greatest(v_last, coalesce(src.end_date, v_last)) + 1 + public.rule_int('lms.intake_gap_days', 0));$n$);
-- 55. Carry-over rounds.
select public.business_rule_patch_function('public.rto_carry_over_plan(uuid, text)'::regprocedure,
  $o$for v_round in 1..5 loop$o$, $n$for v_round in 1..public.rule_int('lms.carry_over_rounds', 5) loop$n$);
select public.business_rule_patch_function('public.rto_carry_over_plan(uuid, text)'::regprocedure,
  $o$or v_round = 5;$o$, $n$or v_round >= public.rule_int('lms.carry_over_rounds', 5);$n$);
-- 57. Certificate / statement numbers.
select public.business_rule_patch_function('public.course_completion_issue(uuid, text)'::regprocedure,
  $o$'SLIT-' || case p_kind when 'certificate' then 'C' else 'SOA' end || '-' || to_char(now() at time zone 'Australia/Melbourne', 'YYYY') || '-' || lpad(nextval('public.course_completion_seq')::text, 6, '0'),$o$,
  $n$public.course_completion_number(p_kind),$n$);
-- 63. Booking start times.
select public.business_rule_patch_function('public.booking_free_slots(public.booking_types, public.booking_hosts, date, date, uuid)'::regprocedure,
  $o$make_interval(mins => case when t.duration_min <= 30 then t.duration_min else 30 end)$o$,
  $n$make_interval(mins => least(t.duration_min, public.rule_int('booking.slot_interval_minutes', 30)))$n$);
-- 22. Enrolment type when placing by hand.
select public.business_rule_patch_function('public.rto_staff_place(uuid, uuid, text, date, text)'::regprocedure,
  $o$coalesce(nullif(p_type, ''), 'CoE')$o$,
  $n$coalesce(nullif(p_type, ''), public.rule_text('lms.manual_placement_default_type', 'CoE'))$n$, 2);

-- Every rule of part C exists and is published.
do $$
declare v_missing text;
begin
  select string_agg(x, ', ') into v_missing from unnest(array[
    'lms.voe_threshold_weekly_hours', 'lms.class_suggestion_preferred_days', 'lms.class_suggestion_hours',
    'lms.manual_placement_default_type', 'lms.auto_intake_create', 'lms.auto_intake_months_ahead', 'lms.intake_upcoming_per_load',
    'lms.join_dates', 'lms.intake_next_at_percent', 'lms.intake_gap_days', 'lms.course_auto_go_live', 'lms.course_publish_needs_intake',
    'lms.course_working_days', 'lms.optional_holidays_stop_classes', 'lms.carry_over_rounds', 'lms.certificate_number_format',
    'lms.statement_number_format', 'booking.slot_interval_minutes']) x
  where not exists (select 1 from public.business_rules r join public.business_rule_versions v on v.rule_id = r.id
    where r.scope_key = '' and r.identifier = x and r.registration->>'handler' = 'setting' and v.state = 'published');
  if v_missing is not null then raise exception 'BUSINESS-RULES-LIVE part C: rules missing or unpublished: %', v_missing; end if;
  -- Today's values are unchanged.
  if public.lms_working_isodows() <> '{1,2,3,4,5}'::integer[] or public.rule_int('lms.intake_upcoming_per_load', 0) <> 1
     or public.rule_text('lms.certificate_number_format', '') <> 'SLIT-C-{yyyy}-{######}' then
    raise exception 'BUSINESS-RULES-LIVE part C: a rule does not read back at today''s value.';
  end if;
end $$;

-- ===== D =====
-- PART D: HR, Office 365, support, messages, sign-in, other. Every rule starts at the value the system used on 2026-11-20.
-- Functions patched here (no other batch-4 part patches them): hr.invite_create, hr.account_invite_create, hr.staff_doc_summary,
-- hr.v_dob_parse, hr.v_dob_problem, public.hr_admin_job_save, public.hr_admin_staff_employment_save, public.hr_admin_onboarding_pay_save,
-- public.hr_admin_schedule_save, public.hr_svc_apply, public.support_ticket_create, public.support_ticket_update,
-- public.notification_claim_sms_delivery, public.notification_event_check.
-- Table changes: hr.pay_schedules check pay_schedules_pay_date_offset_days_check and hr.staff_profiles check
-- staff_profiles_date_of_birth_check become triggers reading their rules; hr.jobs.vacancies default reads the new-job rule.

-- ---------- the rules ----------
-- 25. Employment types offered on staff records (job ads offer the Full time / Part time ones of this list).
select public.business_rule_add_setting('hrms.employment_types', 'Employment types', 'HRMS', 'staff', 'employee', 'list',
  '["Full time","Part time","Contract"]'::jsonb, '{"allowed":["Full time","Part time","Contract"]}'::jsonb,
  'The employment types staff can choose on an employee''s record and pay details. Job ads offer only Full time and Part time from this list. A record that already has a type keeps it.');
-- 26. Pay frequencies a new or changed pay schedule may use.
select public.business_rule_add_setting('hrms.pay_frequencies', 'Pay frequencies', 'HRMS', 'staff_pay_schedules', 'pay_schedule', 'list',
  '["Fortnightly","Monthly"]'::jsonb, '{"allowed":["Fortnightly","Monthly"]}'::jsonb,
  'How often staff can be paid. A new pay schedule, or a schedule whose frequency is changed, must use one of these. Existing schedules keep theirs.');
-- 26. Pay date window: how many days before or after a pay period ends the pay date may fall.
select public.business_rule_add_setting('hrms.pay_date_window', 'Pay date window', 'HRMS', 'staff_pay_schedules', 'pay_schedule', 'json',
  '{"daysBefore":14,"daysAfter":31}'::jsonb, '{"keys":["daysBefore","daysAfter"]}'::jsonb,
  'A pay schedule''s pay date may be at most this many days before (daysBefore) or after (daysAfter) the end of each pay period.');
-- 27. How long staff links stay valid.
select public.business_rule_add_setting('hrms.staff_offer_link_days', 'Staff offer link valid for', 'HRMS', 'staff', 'employee', 'days',
  '30'::jsonb, '{"min":1,"max":90}'::jsonb, 'Days a staff member''s private link to read and sign their offer letter keeps working.');
select public.business_rule_add_setting('hrms.staff_document_link_days', 'Staff document link valid for', 'HRMS', 'staff', 'employee', 'days',
  '14'::jsonb, '{"min":1,"max":90}'::jsonb, 'Days a private link to add personal details and documents keeps working.');
select public.business_rule_add_setting('hrms.staff_account_link_days', 'Staff sign-in set-up link valid for', 'HRMS', 'staff', 'employee', 'days',
  '7'::jsonb, '{"min":1,"max":30}'::jsonb, 'Days the one-time link to choose a password for a staff account keeps working.');
-- 28. Choose a value: admin screens and the database said 30 days, the staff home page 60. Started at 30.
select public.business_rule_add_setting('hrms.document_expiring_soon_days', 'Staff document expiring soon', 'HRMS', 'staff', 'staff_document', 'days',
  '30'::jsonb, '{"min":1,"max":365}'::jsonb,
  'A staff document is shown as expiring soon this many days before its expiry date (staff pages, the staff member''s own home page and the expiry warning).',
  '[]'::jsonb, true);
-- 29. What a new job ad starts with.
select public.business_rule_add_setting('hrms.new_job_defaults', 'New job defaults', 'HRMS', 'staff_jobs', 'job', 'json',
  '{"employmentType":"Full time","status":"Draft","vacancies":1}'::jsonb, '{"keys":["employmentType","status","vacancies"]}'::jsonb,
  'What a new job ad starts with: employmentType (Full time or Part time), status (Draft, Open or Closed) and vacancies (1 or more).');
-- 61. Waiting time before a rejected applicant can apply again.
select public.business_rule_add_setting('hrms.rejected_reapply_days', 'Rejected applicant can apply again after', 'HRMS', 'staff_candidates', 'applicant', 'days',
  '0'::jsonb, '{"min":0,"max":730}'::jsonb,
  'Days after an application was rejected before the same email can apply again. 0 = straight away. During the wait the applicant sees the usual thank-you and nothing is recorded.');
-- 62. Choose a value: staff enrolment and the database check said 14, the onboarding wizard 10. Started at 14.
select public.business_rule_add_setting('hrms.staff_minimum_age', 'Staff minimum age', 'HRMS', 'staff', 'employee', 'number',
  '14'::jsonb, '{"min":10,"max":25}'::jsonb,
  'The youngest age (in years) a staff member''s date of birth may give, on every staff form and in the database.', '[]'::jsonb, true);
-- 31. Mailbox for agents on Email Management › Create Email.
select public.business_rule_add_setting('office365.agent_mailbox', 'Mailbox for agents', 'Other', 'email_management/create', 'mailbox', 'dropdown',
  '"Staff mailbox at slit.edu.au"'::jsonb, '{"allowed":["Staff mailbox at slit.edu.au","No mailbox"]}'::jsonb,
  'Staff mailbox at slit.edu.au: agents can get a SLIT mailbox with the staff licence. No mailbox: agents are not offered on Create Email and none can be made for them.',
  '["Staff mailbox at slit.edu.au","No mailbox"]'::jsonb);
-- 32. Email address format for new Office 365 accounts (a clash adds a number: jane.smith2@).
select public.business_rule_add_setting('office365.email_address_format', 'Email address format', 'Other', 'email_management/create', 'mailbox', 'dropdown',
  '"first.last"'::jsonb, '{"allowed":["first.last","firstlast","f.last","first_last","last.first"]}'::jsonb,
  'How a new Office 365 address is made from the name (Jane Smith): first.last = jane.smith, firstlast = janesmith, f.last = j.smith, first_last = jane_smith, last.first = smith.jane. If the address is taken a number is added (jane.smith2).',
  '["first.last","firstlast","f.last","first_last","last.first"]'::jsonb);
-- 33. Support ticket categories and whether the requester may close their own ticket.
select public.business_rule_add_setting('support.ticket_categories', 'Support ticket categories', 'Communications', 'support_tickets', 'ticket', 'list',
  '["Enrolment & documents","Fees & payments","Course & training","Other"]'::jsonb,
  '{"allowed":["Enrolment & documents","Fees & payments","Course & training","Other"]}'::jsonb,
  'The categories students and agents can choose when they raise a support ticket. Existing tickets keep their category.');
select public.business_rule_add_setting('support.requester_can_close', 'Requester can close their own ticket', 'Communications', 'support_tickets', 'ticket', 'boolean',
  'true'::jsonb, '{}'::jsonb, 'Yes: students and agents can mark their own ticket resolved. No: only SLIT staff change a ticket''s status.');
-- 34. Text messages.
select public.business_rule_add_setting('comms.sms_unsent_expiry_hours', 'Unsent text messages dropped after', 'Communications', 'notifications', 'sms', 'hours',
  '24'::jsonb, '{"min":1,"max":168}'::jsonb, 'A text message that could not be sent within this many hours of being queued is never sent.');
select public.business_rule_add_setting('comms.sms_max_characters', 'Longest text message', 'Communications', 'notifications', 'sms', 'number',
  '612'::jsonb, '{"min":160,"max":918}'::jsonb, 'Text messages longer than this many characters are cut (612 = four standard text segments).');
-- 38. Extra recipients per notification.
select public.business_rule_add_setting('comms.notification_extra_recipients_max', 'Extra recipients per notification', 'Communications', 'notifications', 'notification', 'number',
  '20'::jsonb, '{"min":1,"max":100}'::jsonb, 'The most internal email addresses that can be added to one automatic notification.');
-- 35. Website assistant.
select public.business_rule_add_setting('website.assistant_daily_answers', 'Website assistant AI answers per day', 'CMS Website', 'public_assistant', 'assistant', 'number',
  '200'::jsonb, '{"min":0,"max":100000}'::jsonb, 'The most AI-written answers the website assistant gives in one day; after that it still answers, with links to the matching website pages, but without AI-written text.');
-- 36. Password length.
select public.business_rule_add_setting('auth.password_min_students_agents', 'Shortest password: students and agents', 'Other', 'settings', 'account', 'number',
  '10'::jsonb, '{"min":10,"max":64}'::jsonb, 'The fewest characters a password may have for students, agents and other portal accounts.');
select public.business_rule_add_setting('auth.password_min_staff', 'Shortest password: staff', 'HRMS', 'staff', 'account', 'number',
  '12'::jsonb, '{"min":12,"max":64}'::jsonb, 'The fewest characters a staff member''s password may have when they set up their staff account.');
-- 37. Admin "view as".
select public.business_rule_add_setting('admin.view_as_hours', 'Switch view lasts', 'Other', 'settings', 'view_as', 'hours',
  '12'::jsonb, '{"min":1,"max":24}'::jsonb, 'Hours an administrator''s Switch view (seeing the Student, Agent or Staff workspace) lasts before the kept admin session is dropped.');

-- ---------- helpers ----------
-- Employment type keys (full_time, part_time, contract) allowed by hrms.employment_types; a job ad also needs full_time / part_time.
create or replace function hr.employment_types_allowed(p_job_ad boolean default false) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(array(
    select k from (select lower(replace(btrim(x), ' ', '_')) k
      from jsonb_array_elements_text(case when jsonb_typeof(public.rule_json('hrms.employment_types', null)) = 'array'
        then public.rule_json('hrms.employment_types', null) else '["Full time","Part time","Contract"]'::jsonb end) x) t
    where k in ('full_time', 'part_time', 'contract') and (not p_job_ad or k in ('full_time', 'part_time'))), '{}'),
    case when p_job_ad then array['full_time', 'part_time'] else array['full_time', 'part_time', 'contract'] end);
$$;
create or replace function hr.employment_type_allowed(p_key text, p_job_ad boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$ select p_key = any (hr.employment_types_allowed(p_job_ad)); $$;
-- "Choose Full time, Part time or Contract." from the allowed types.
create or replace function hr.employment_type_message(p_job_ad boolean default false) returns text
language sql stable security definer set search_path = '' as $$
  with l as (select array(select initcap(replace(k, '_', ' ')) from unnest(hr.employment_types_allowed(p_job_ad)) k) a)
  select 'Choose ' || case when cardinality(a) = 1 then replace(a[1], ' Time', ' time')
    else replace(array_to_string(a[1:cardinality(a) - 1], ', ') || ' or ' || a[cardinality(a)], ' Time', ' time') end || '.' from l;
$$;
-- Pay frequencies allowed by hrms.pay_frequencies (fortnightly / monthly).
create or replace function hr.pay_frequencies_allowed() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(array(select k from (select lower(btrim(x)) k from jsonb_array_elements_text(
      case when jsonb_typeof(public.rule_json('hrms.pay_frequencies', null)) = 'array' then public.rule_json('hrms.pay_frequencies', null)
      else '["Fortnightly","Monthly"]'::jsonb end) x) t where k in ('fortnightly', 'monthly')), '{}'), array['fortnightly', 'monthly']);
$$;
create or replace function hr.pay_frequency_message() returns text
language sql stable security definer set search_path = '' as $$
  select 'Frequency must be ' || array_to_string(hr.pay_frequencies_allowed(), ' or ') || '.';
$$;
-- The pay date window (days before / after the period end).
create or replace function hr.pay_date_window(p_key text) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(case when jsonb_typeof(w->p_key) = 'number' then round((w->>p_key)::numeric)::integer end, case p_key when 'daysBefore' then 14 else 31 end)
    from (select public.rule_json('hrms.pay_date_window', '{"daysBefore":14,"daysAfter":31}'::jsonb) w) s;
$$;
create or replace function hr.pay_schedules_offset_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.pay_date_offset_days < -hr.pay_date_window('daysBefore') or new.pay_date_offset_days > hr.pay_date_window('daysAfter') then
    raise exception 'The pay date must be between % days before and % days after the end of the period.', hr.pay_date_window('daysBefore'), hr.pay_date_window('daysAfter')
      using errcode = '23514';
  end if;
  return new;
end $$;
alter table hr.pay_schedules drop constraint if exists pay_schedules_pay_date_offset_days_check;
drop trigger if exists pay_schedules_offset_guard on hr.pay_schedules;
create trigger pay_schedules_offset_guard before insert or update of pay_date_offset_days on hr.pay_schedules
  for each row execute function hr.pay_schedules_offset_guard();
-- New job defaults: 'employmentType' -> full_time / part_time, 'status' -> draft / open / closed, 'vacancies' -> a number as text.
create or replace function hr.job_default(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select case p_key
    when 'employmentType' then coalesce(nullif(lower(replace(btrim(coalesce(d->>'employmentType', '')), ' ', '_')), ''), 'full_time')
    when 'status' then coalesce(nullif(lower(btrim(coalesce(d->>'status', ''))), ''), 'draft')
    when 'vacancies' then case when jsonb_typeof(d->'vacancies') = 'number' and (d->>'vacancies')::numeric between 1 and 10000
      then round((d->>'vacancies')::numeric)::integer::text else '1' end
  end from (select public.rule_json('hrms.new_job_defaults', '{"employmentType":"Full time","status":"Draft","vacancies":1}'::jsonb) d) s;
$$;
alter table hr.jobs alter column vacancies set default (hr.job_default('vacancies'))::integer;
-- A rejected applicant may apply again once hrms.rejected_reapply_days have passed since the rejection.
create or replace function hr.staff_reapply_open(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.rule_int('hrms.rejected_reapply_days', 0) <= 0
    or coalesce((select max(e.created_at) from hr.staff_status_events e where e.profile_id = p_profile and e.to_status = 'rejected'), '-infinity'::timestamptz)
       <= now() - make_interval(days => public.rule_int('hrms.rejected_reapply_days', 0));
$$;
-- Staff date of birth: at least hrms.staff_minimum_age years ago, not before 1900 (replaces the check constraint that said 14).
create or replace function hr.staff_profiles_dob_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.date_of_birth is not null and (new.date_of_birth > (current_date - make_interval(years => public.rule_int('hrms.staff_minimum_age', 14)))::date
     or new.date_of_birth < date '1900-01-01') then
    raise exception 'The date of birth must be at least % years ago.', public.rule_int('hrms.staff_minimum_age', 14) using errcode = '23514';
  end if;
  return new;
end $$;
alter table hr.staff_profiles drop constraint if exists staff_profiles_date_of_birth_check;
drop trigger if exists staff_profiles_dob_guard on hr.staff_profiles;
create trigger staff_profiles_dob_guard before insert or update of date_of_birth on hr.staff_profiles
  for each row execute function hr.staff_profiles_dob_guard();
-- Support: category keys allowed by support.ticket_categories, and the default priority key.
create or replace function public.support_category_allowed(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_key = any (coalesce(nullif(array(select case lower(btrim(x)) when 'enrolment & documents' then 'enrolment_documents'
      when 'fees & payments' then 'fees_payments' when 'course & training' then 'course_training' when 'other' then 'other' end
    from jsonb_array_elements_text(case when jsonb_typeof(public.rule_json('support.ticket_categories', null)) = 'array'
      then public.rule_json('support.ticket_categories', null) else '[]'::jsonb end) x), '{}'),
    array['enrolment_documents', 'fees_payments', 'course_training', 'other']));
$$;
create or replace function public.support_priority_default_key() returns text
language sql stable security definer set search_path = '' as $$
  select case when k in ('low', 'normal', 'high', 'urgent') then k else 'normal' end
    from (select lower(btrim(public.rule_text('support.ticket_priority_default', 'Normal'))) k) s;
$$;
do $$ declare f text; begin
  foreach f in array array['hr.employment_types_allowed(boolean)', 'hr.employment_type_allowed(text, boolean)', 'hr.employment_type_message(boolean)',
    'hr.pay_frequencies_allowed()', 'hr.pay_frequency_message()', 'hr.pay_date_window(text)', 'hr.job_default(text)', 'hr.staff_reapply_open(uuid)',
    'public.support_category_allowed(text)', 'public.support_priority_default_key()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------- 27. link validity ----------
select public.business_rule_patch_function('hr.invite_create(uuid, text, text, uuid)'::regprocedure,
$o$case when p_purpose = 'offer' then interval '30 days' else interval '14 days' end$o$,
$n$case when p_purpose = 'offer' then make_interval(days => public.rule_int('hrms.staff_offer_link_days', 30)) else make_interval(days => public.rule_int('hrms.staff_document_link_days', 14)) end$n$, 1);
select public.business_rule_patch_function('hr.account_invite_create(uuid, text, uuid)'::regprocedure,
$o$now() + interval '7 days'$o$, $n$now() + make_interval(days => public.rule_int('hrms.staff_account_link_days', 7))$n$, 1);

-- ---------- 28. expiring soon ----------
select public.business_rule_patch_function('hr.staff_doc_summary(uuid)'::regprocedure,
$o$d.expiry_date <= current_date + 30$o$, $n$d.expiry_date <= current_date + public.rule_int('hrms.document_expiring_soon_days', 30)$n$, 1);

-- ---------- 25 + 29. job ads ----------
select public.business_rule_patch_function('public.hr_admin_job_save(uuid, jsonb)'::regprocedure,
$o$v_type := coalesce(p_job->>'employmentType', j.employment_type, '');$o$,
$n$v_type := coalesce(p_job->>'employmentType', j.employment_type, hr.job_default('employmentType'));$n$, 1);
select public.business_rule_patch_function('public.hr_admin_job_save(uuid, jsonb)'::regprocedure,
$o$v_status := coalesce(p_job->>'status', j.status, 'open');$o$,
$n$v_status := coalesce(p_job->>'status', j.status, hr.job_default('status'));$n$, 1);
select public.business_rule_patch_function('public.hr_admin_job_save(uuid, jsonb)'::regprocedure,
$o$if v_type not in ('full_time','part_time') then raise exception 'Choose Full time or Part time.' using errcode = '22023'; end if;$o$,
$n$if v_type not in ('full_time','part_time') or (not hr.employment_type_allowed(v_type, true) and v_type is distinct from j.employment_type) then raise exception '%', hr.employment_type_message(true) using errcode = '22023'; end if;$n$, 1);
select public.business_rule_patch_function('public.hr_admin_job_save(uuid, jsonb)'::regprocedure,
$o$v_vacancies := coalesce((p_job->>'vacancies')::integer, j.vacancies, 1);$o$,
$n$v_vacancies := coalesce((p_job->>'vacancies')::integer, j.vacancies, hr.job_default('vacancies')::integer);$n$, 1);

-- ---------- 25. staff records ----------
select public.business_rule_patch_function('public.hr_admin_staff_employment_save(uuid, jsonb)'::regprocedure,
$o$if v_type is not null and v_type not in ('full_time', 'part_time', 'contract') then raise exception 'Choose Full time, Part time or Contract.' using errcode = '22023'; end if;$o$,
$n$if v_type is not null and (v_type not in ('full_time', 'part_time', 'contract') or (not hr.employment_type_allowed(v_type)
   and v_type is distinct from (select e.employment_type from hr.employment e where e.profile_id = p.id))) then
  raise exception '%', hr.employment_type_message(false) using errcode = '22023'; end if;$n$, 1);
select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
$o$if v_type is null or v_type not in ('full_time', 'part_time', 'contract') then raise exception 'Choose the employment type.'$o$,
$n$if v_type is null or v_type not in ('full_time', 'part_time', 'contract') or not hr.employment_type_allowed(v_type) then raise exception 'Choose the employment type.'$n$, 1);

-- ---------- 26. pay schedules ----------
select public.business_rule_patch_function('public.hr_admin_schedule_save(uuid, jsonb)'::regprocedure,
$o$if v_freq not in ('fortnightly', 'monthly') then raise exception 'Frequency must be fortnightly or monthly.' using errcode = '22023'; end if;$o$,
$n$if v_freq not in ('fortnightly', 'monthly') or not (v_freq = any (hr.pay_frequencies_allowed())) then raise exception '%', hr.pay_frequency_message() using errcode = '22023'; end if;$n$, 1);
select public.business_rule_patch_function('public.hr_admin_schedule_save(uuid, jsonb)'::regprocedure,
$o$  if (v_freq is not null and v_freq <> s.frequency) or (v_anchor is not null and v_anchor <> s.anchor_date) then$o$,
$n$  if v_freq is not null and v_freq <> s.frequency and not (v_freq = any (hr.pay_frequencies_allowed())) then
   raise exception '%', hr.pay_frequency_message() using errcode = '22023'; end if;
  if (v_freq is not null and v_freq <> s.frequency) or (v_anchor is not null and v_anchor <> s.anchor_date) then$n$, 1);

-- ---------- 61. rejected applicant applies again ----------
select public.business_rule_patch_function('public.hr_svc_apply(text, text, text, text, uuid, text)'::regprocedure,
$o$  select * into a from hr.staff_applications where profile_id = p.id;
$o$,
$n$  select * into a from hr.staff_applications where profile_id = p.id;
  -- hrms.rejected_reapply_days: a rejected applicant waits before applying again (the caller shows the usual thank-you; nothing is recorded).
  if p.status = 'rejected' and not hr.staff_reapply_open(p.id) then return jsonb_build_object('ok', false, 'reason', 'reapply_wait', 'field', 'email'); end if;
$n$, 1);

-- ---------- 62. staff minimum age ----------
select public.business_rule_patch_function('hr.v_dob_parse(text, date)'::regprocedure,
$o$ IMMUTABLE PARALLEL SAFE$o$, $n$ STABLE$n$, 1);
select public.business_rule_patch_function('hr.v_dob_parse(text, date)'::regprocedure,
$o$extract(year from p_today)::integer - 10,$o$, $n$extract(year from p_today)::integer - public.rule_int('hrms.staff_minimum_age', 14),$n$, 1);
select public.business_rule_patch_function('hr.v_dob_problem(text, date)'::regprocedure,
$o$'You must be between 10 and 100 years old.'$o$,
$n$'You must be between ' || public.rule_int('hrms.staff_minimum_age', 14) || ' and 100 years old.'$n$, 1);

-- ---------- 33 + default priority. support ----------
select public.business_rule_patch_function('public.support_ticket_create(text, text, text, text, jsonb, uuid)'::regprocedure,
$o$if p_category not in ('enrolment_documents','fees_payments','course_training','other') then$o$,
$n$if p_category not in ('enrolment_documents','fees_payments','course_training','other') or not public.support_category_allowed(p_category) then$n$, 1);
select public.business_rule_patch_function('public.support_ticket_create(text, text, text, text, jsonb, uuid)'::regprocedure,
$o$coalesce(p_priority, 'normal')$o$, $n$coalesce(p_priority, public.support_priority_default_key())$n$, 2);
select public.business_rule_patch_function('public.support_ticket_update(uuid, text, text, text)'::regprocedure,
$o$p_status not in ('resolved','closed') or p_priority is not null$o$,
$n$p_status not in ('resolved','closed') or not public.rule_bool('support.requester_can_close', true) or p_priority is not null$n$, 1);

-- ---------- 34. text messages ----------
select public.business_rule_patch_function('public.notification_claim_sms_delivery()'::regprocedure,
$o$x.created_at < now() - interval '24 hours'$o$, $n$x.created_at < now() - make_interval(hours => public.rule_int('comms.sms_unsent_expiry_hours', 24))$n$, 1);
select public.business_rule_patch_function('public.notification_claim_sms_delivery()'::regprocedure,
$o$|| d.subject, 600);$o$, $n$|| d.subject, greatest(public.rule_int('comms.sms_max_characters', 612) - 12, 100));$n$, 1);

-- ---------- 38. extra recipients ----------
select public.business_rule_patch_function('public.notification_event_check(jsonb)'::regprocedure,
$o$ LANGUAGE plpgsql
 IMMUTABLE
$o$, $n$ LANGUAGE plpgsql
 STABLE
$n$, 1);
select public.business_rule_patch_function('public.notification_event_check(jsonb)'::regprocedure,
$o$> 20 then raise exception 'At most 20 internal recipients per event' using errcode = '22023';$o$,
$n$> public.rule_int('comms.notification_extra_recipients_max', 20) then raise exception 'At most % internal recipients per event', public.rule_int('comms.notification_extra_recipients_max', 20) using errcode = '22023';$n$, 1);

-- ---------- check ----------
do $$ declare r text; begin
  foreach r in array array['hrms.employment_types', 'hrms.pay_frequencies', 'hrms.pay_date_window', 'hrms.staff_offer_link_days',
    'hrms.staff_document_link_days', 'hrms.staff_account_link_days', 'hrms.document_expiring_soon_days', 'hrms.new_job_defaults',
    'hrms.rejected_reapply_days', 'hrms.staff_minimum_age', 'office365.agent_mailbox', 'office365.email_address_format',
    'support.ticket_categories', 'support.requester_can_close', 'comms.sms_unsent_expiry_hours', 'comms.sms_max_characters',
    'comms.notification_extra_recipients_max', 'website.assistant_daily_answers', 'auth.password_min_students_agents',
    'auth.password_min_staff', 'admin.view_as_hours'] loop
    if not exists (select 1 from public.business_rules b join public.business_rule_versions v on v.rule_id = b.id and v.state = 'published'
                    where b.scope_key = '' and b.identifier = r) then
      raise exception 'BUSINESS-RULES-LIVE D: rule % is missing or not published', r;
    end if;
  end loop;
  if public.rule_int('hrms.staff_offer_link_days', -1) <> 30 or public.rule_int('hrms.staff_minimum_age', -1) <> 14
     or public.rule_int('comms.sms_max_characters', -1) <> 612 or hr.job_default('status') <> 'draft' or hr.job_default('vacancies') <> '1'
     or hr.employment_types_allowed(false) <> array['full_time', 'part_time', 'contract'] or hr.employment_types_allowed(true) <> array['full_time', 'part_time']
     or hr.employment_type_message(false) <> 'Choose Full time, Part time or Contract.' or hr.employment_type_message(true) <> 'Choose Full time or Part time.'
     or hr.pay_frequency_message() <> 'Frequency must be fortnightly or monthly.' or hr.pay_date_window('daysBefore') <> 14 or hr.pay_date_window('daysAfter') <> 31
     or not public.support_category_allowed('other') or public.support_priority_default_key() <> 'normal' then
    raise exception 'BUSINESS-RULES-LIVE D: a rule does not read back at today''s value';
  end if;
end $$;

commit;
