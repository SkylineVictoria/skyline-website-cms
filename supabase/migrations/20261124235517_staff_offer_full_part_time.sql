-- STAFF-OFFER-FULL-PART-TIME (2026-11-24, owner: "use these as templates and store them in templates for employees; in Add employee ask the
-- admin the employee-specific questions like salary; metadata from our company info; the employee signs and accepts or declines and creates
-- their password so they can be onboarded").
-- Run AFTER 20261124001517_staff_offer_variables (it adds the company / offer-term placeholders and rewrites "SLIT Staff Offer Letter").
--   1. Two employee templates in HRMS › Templates, made from the owner's letters: "Staff Offer Letter - Full time" and "Staff Offer Letter -
--      Part time" (the placeholder letter with the full-time / part-time hours and leave wording written in, as in the owner's PDFs). Company
--      details come from Website settings, offer terms from HRMS settings, the person's details from their offer details. Send offer letter
--      picks the one matching the person's job type.
--   2. hr_admin_onboarding_pay_save: the offer details (position, job type, start date, pay, hours, pay cycle, location, manager, award) can be
--      saved as soon as the person is added (Add employee asks them straight after Start onboarding); documents are still checked before the
--      offer goes out (hr.staff_offer_needs_pay and staff-admin offer_send_login are unchanged). Otherwise the LIVE definition.
--   3. Decline: hr.staff_offers.declined_at / decline_reason; public.hr_svc_offer_decline (staff-onboarding offer_decline, by the offer link
--      or the signed-in person): the record moves to Rejected / Withdrawn with the note "Offer declined by the candidate: <reason>", the offer
--      link and any other waiting link stop working. hr.offer_json shows declinedAt / declineReason.
--   4. Offer first, documents after (owner, 2026-11-24: "ask documents after signing the offer; send the email with the offer, the employee
--      reads it and uploads all documents in the wizard"): an offer can go out from Applied / Invited (pay details complete; nothing about
--      documents yet), withdraw / a failed send puts the person back to Invited (or Documents submitted when they had sent them). After
--      signing, the person opens the document wizard from My HR (hr_svc_staff_documents_link, staff-onboarding documents_link) and
--      submits; their status stays Offer signed. Activation still needs every required document approved (unchanged).
-- Additive. Rollback: delete the two templates; re-create hr_admin_onboarding_pay_save and hr.offer_json from their previous definitions;
-- drop hr_svc_offer_decline (the two columns can stay).
begin;

-- 1. The two letters.
do $do$
declare base hr.sign_templates; v_new uuid; v record;
 v_probation_clause text := 'The first {{probation_months}} months of your employment are a probationary period, during which we will both assess whether the role is the right fit. During probation either party may end the employment by giving the notice required by the Award and the National Employment Standards (NES).';
 v_notice_clause text := 'After probation, either party may end the employment by written notice. We will give you at least the notice (or pay instead of notice) required by the Award and the National Employment Standards (NES) for your length of service, and you must give us {{notice_weeks}} weeks'' written notice, or the notice the Award requires if that is longer. We may end your employment without notice for serious misconduct.';
begin
 select * into base from hr.sign_templates where category = 'offer_letter' and name = 'SLIT Staff Offer Letter' and deleted_at is null order by updated_at desc limit 1;
 if not found or position('{{hours_clause}}' in coalesce(base.body_html, '')) = 0 then
  raise exception 'Run 20261124001517_staff_offer_variables first (the staff offer letter must use placeholders).' using errcode = '55000';
 end if;
 for v in select * from (values
   ('Staff Offer Letter - Full time', 'Full time',
    'You will work {{hours_per_week}} ordinary hours per week. You may be asked to work reasonable additional hours (for example enrolment periods, evening classes or audits), handled in line with the Award and the National Employment Standards (NES).',
    '{{annual_leave_weeks}} weeks'' paid annual leave and {{personal_leave_days}} days'' paid personal/carer''s leave each year, accruing progressively.'),
   ('Staff Offer Letter - Part time', 'Part time',
    'You are guaranteed {{hours_per_week}} ordinary hours per week, worked in a pattern of days and times agreed with your manager and confirmed in writing. The pattern can only be changed by agreement in writing, and any additional hours are paid in line with the Award and the National Employment Standards (NES).',
    'Paid annual leave and paid personal/carer''s leave pro rata to your ordinary hours (the full-time entitlement is {{annual_leave_weeks}} weeks and {{personal_leave_days}} days each year), accruing progressively.')
  ) as t(name, type_label, hours_clause, leave_clause)
 loop
  if exists (select 1 from hr.sign_templates s where s.name = v.name and s.category = 'offer_letter' and s.deleted_at is null) then continue; end if;
  insert into hr.sign_templates(name, title, body, created_by, kind, audience, category, status, version, roles, fields, signing_mode, expiry_days,
    reminder_days, body_html, subject, is_default, header_html, footer_html, bracket_variables)
  values (v.name, base.title, null, base.created_by, base.kind, base.audience, base.category, 'active', 1, base.roles, base.fields, base.signing_mode,
    base.expiry_days, base.reminder_days,
    replace(replace(replace(replace(replace(replace(base.body_html,
      '{{hours_clause}}', v.hours_clause), '{{leave_clause}}', v.leave_clause), '{{probation_period}}', '{{probation_months}} months'),
      '{{probation_clause}}', v_probation_clause), '{{notice_clause}}', v_notice_clause), '{{employment_type}}', v.type_label),
    base.subject, false, base.header_html, base.footer_html, base.bracket_variables)
  returning id into v_new;
  update hr.sign_templates set body = hr.html_to_text(body_html) where id = v_new;
  perform hr.sign_template_version(v_new, base.created_by);
 end loop;
end $do$;

-- 2. Offer details saved from Add employee onwards (documents still checked before the offer is sent).
CREATE OR REPLACE FUNCTION public.hr_admin_onboarding_pay_save(p_id uuid, p_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_problem text;
 v_title text := btrim(coalesce(p_details->>'jobTitle', '')); v_type text := nullif(p_details->>'employmentType', '');
 v_start_raw text := btrim(coalesce(p_details->>'startDate', '')); v_start date;
 v_basis text := nullif(p_details->>'payBasis', ''); v_rate_raw text := btrim(coalesce(p_details->>'rate', '')); v_rate numeric;
 v_hours_raw text := btrim(coalesce(p_details->>'hoursPerWeek', '')); v_hours numeric;
 v_schedule_raw text := btrim(coalesce(p_details->>'payScheduleId', '')); v_schedule uuid;
 v_location_raw text := btrim(coalesce(p_details->>'locationId', ''));
begin
 if jsonb_typeof(p_details) is distinct from 'object' then raise exception 'Enter the pay details.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status in ('offer_sent', 'offer_signed') then raise exception 'The offer has already gone out with these pay details. Withdraw the offer to change them.' using errcode = '23514'; end if;
 -- STAFF-OFFER-FULL-PART-TIME: from Add employee (applied / invited) as well; the documents are checked when the offer is sent.
 if p.status not in ('applied', 'invited', 'documents_submitted') then raise exception 'Offer details are added while the person is being onboarded.' using errcode = '23514'; end if;

 if v_title = '' or char_length(v_title) > 150 then raise exception 'Enter the position (job title).' using errcode = '22023'; end if;
 if v_type is null or v_type not in ('full_time', 'part_time', 'contract') or not hr.employment_type_allowed(v_type) then raise exception 'Choose the employment type.' using errcode = '22023'; end if;
 if v_location_raw = '' and btrim(coalesce(p_details->>'workLocation', '')) = '' then raise exception 'Choose the work location.' using errcode = '22023'; end if;
 if v_start_raw !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter the start date.' using errcode = '22023'; end if;
 begin v_start := v_start_raw::date; exception when others then raise exception 'Enter a valid start date.' using errcode = '22023'; end;
 if v_start < current_date - hr.staff_pay_start_days('pastDays') or v_start > current_date + hr.staff_pay_start_days('futureDays') then raise exception '%', hr.staff_pay_start_message() using errcode = '22023'; end if;
 if v_basis is null or v_basis not in ('hourly', 'salary') then raise exception 'Choose the pay basis (hourly or annual).' using errcode = '22023'; end if;
 if v_rate_raw !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Enter the pay rate as a number, for example 38.50.' using errcode = '22023'; end if;
 v_rate := v_rate_raw::numeric;
 if v_rate <= 0 then raise exception 'The pay rate must be more than zero.' using errcode = '22023'; end if;
 if v_basis = 'hourly' and v_rate > hr.staff_pay_bound('maximumHourly') then raise exception 'That hourly rate looks too high. Check the pay basis.' using errcode = '22023'; end if;
 if v_basis = 'salary' and v_rate < hr.staff_pay_bound('minimumAnnual') then raise exception 'That annual salary looks too low. Check the pay basis.' using errcode = '22023'; end if;
 if v_schedule_raw !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Choose the pay schedule.' using errcode = '22023'; end if;
 v_schedule := v_schedule_raw::uuid;
 if not exists (select 1 from hr.pay_schedules s where s.id = v_schedule and s.is_active) then raise exception 'Choose an active pay schedule.' using errcode = '22023'; end if;
 if v_hours_raw = '' then
  if hr.staff_weekly_hours_required(v_type) then raise exception 'Enter the hours per week.' using errcode = '22023'; end if;
 else
  if v_hours_raw !~ '^\d{1,2}(\.\d{1,2})?$' then raise exception 'Enter the hours per week as a number, for example 38.' using errcode = '22023'; end if;
  v_hours := v_hours_raw::numeric;
  if v_hours <= 0 or v_hours > public.rule_num('hrms.staff_weekly_hours_cap', 80) then raise exception 'The hours per week must be between 1 and %.', public.rule_num('hrms.staff_weekly_hours_cap', 80) using errcode = '22023'; end if;
 end if;

 -- The employment record and the pay setup are written by their own functions (location, manager and schedule rules live there).
 perform public.hr_admin_staff_employment_save(p.id, jsonb_build_object('jobTitle', v_title, 'employmentType', v_type, 'department', coalesce(p_details->>'department', ''),
  'locationId', v_location_raw, 'workLocation', coalesce(p_details->>'workLocation', ''), 'managerId', coalesce(p_details->>'managerId', '')));
 update hr.employment set joining_date = v_start, pay_details_at = now(), pay_details_by = v_admin where profile_id = p.id;
 perform public.hr_admin_employee_pay_save(p.id, jsonb_build_object('payScheduleId', v_schedule, 'payBasis', v_basis, 'rate', v_rate,
  'ordinaryHoursWeek', coalesce(v_hours::text, ''), 'award', coalesce(p_details->>'award', ''), 'xeroEmployeeId', coalesce(p_details->>'xeroEmployeeId', ''))
  || case when jsonb_typeof(p_details->'usualWorkDays') = 'array' and jsonb_array_length(p_details->'usualWorkDays') > 0 then jsonb_build_object('usualWorkDays', p_details->'usualWorkDays') else '{}'::jsonb end);
 perform hr.audit_log(p.id, 'pay_details_added', jsonb_build_object('jobTitle', v_title, 'employmentType', v_type, 'startDate', v_start, 'payBasis', v_basis));
 return public.hr_admin_onboarding(p.id);
end $function$;

-- 3. Decline.
alter table hr.staff_offers add column if not exists declined_at timestamptz;
alter table hr.staff_offers add column if not exists decline_reason text;
do $do$ begin
 if not exists (select 1 from pg_constraint where conname = 'staff_offers_decline_reason_check') then
  alter table hr.staff_offers add constraint staff_offers_decline_reason_check check (decline_reason is null or char_length(decline_reason) <= 1000);
 end if;
 if not exists (select 1 from pg_constraint where conname = 'staff_offers_signed_or_declined') then
  alter table hr.staff_offers add constraint staff_offers_signed_or_declined check (not (signed_at is not null and declined_at is not null));
 end if;
end $do$;

CREATE OR REPLACE FUNCTION hr.offer_json(o hr.staff_offers)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 select jsonb_build_object('id', o.id, 'filename', o.filename, 'fileSize', o.file_size, 'storagePath', o.storage_path, 'sha256', o.sha256,
  'uploadedAt', o.uploaded_at, 'sentAt', o.sent_at, 'withdrawnAt', o.withdrawn_at, 'signedAt', o.signed_at, 'signerName', o.signer_name,
  'signedPath', o.signed_path, 'signedSha256', o.signed_sha256, 'declinedAt', o.declined_at, 'declineReason', o.decline_reason);
$function$;

create or replace function public.hr_svc_offer_decline(p_token_hash text, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'hr', 'pg_temp'
as $function$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers; v_reason text := left(btrim(coalesce(p_reason, '')), 1000);
begin
 i := hr.invite_for_write(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null and declined_at is null
  order by sent_at desc limit 1 for update;
 if not found or p.status <> 'offer_sent' then raise exception 'This offer can no longer be declined.' using errcode = '23514'; end if;
 if v_reason ~ '[[:cntrl:]<>]' then v_reason := regexp_replace(v_reason, '[[:cntrl:]<>]', ' ', 'g'); end if;
 update hr.staff_offers set declined_at = now(), decline_reason = nullif(v_reason, '') where id = o.id;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', 'Offer declined by the candidate' || case when v_reason <> '' then ': ' || v_reason else '' end, true);
 update hr.staff_profiles set status = 'rejected' where id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id;
 update hr.staff_invites set revoked_at = now() where profile_id = p.id and id <> i.id and used_at is null and revoked_at is null and superseded_at is null;
 perform hr.audit_log(p.id, 'offer_declined', jsonb_build_object('offerId', o.id, 'reason', nullif(v_reason, '')));
 return jsonb_build_object('name', hr.staff_name(p), 'status', 'rejected', 'declined', true);
end $function$;
revoke all on function public.hr_svc_offer_decline(text, text) from public, anon, authenticated;
grant execute on function public.hr_svc_offer_decline(text, text) to service_role;

-- 4. Offer first, documents after.
create or replace function hr.staff_transition_allowed(p_from text, p_to text)
 returns boolean language sql stable set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select p_to in ('active', 'inactive') or exists (select 1 from hr.staff_workflow_moves() m where m.from_status = p_from and m.to_status = p_to)
   -- STAFF-OFFER-FULL-PART-TIME: the offer may go before the documents, and come back to Invited when withdrawn.
   or (p_from in ('applied', 'invited') and p_to = 'offer_sent') or (p_from = 'offer_sent' and p_to = 'invited');
$function$;

create or replace function hr.staff_offer_needs_pay()
 returns trigger language plpgsql set search_path to 'hr', 'pg_temp'
as $function$
declare v_problem text;
begin
 if old.status in ('applied', 'invited', 'documents_submitted') and new.status = 'offer_sent' then
  v_problem := hr.onboarding_pay_problem(new.id);
  if v_problem is not null then raise exception 'An offer cannot be sent yet. %', v_problem using errcode = '23514'; end if;
 end if;
 return new;
end $function$;

-- Where a person goes back to when their offer is withdrawn or a send is undone.
create or replace function hr.staff_before_offer(p_profile uuid)
 returns text language sql stable security definer set search_path to 'hr', 'pg_temp'
as $function$
 select case when exists (select 1 from hr.staff_applications a where a.profile_id = p_profile and a.submitted_at is not null) then 'documents_submitted' else 'invited' end;
$function$;
revoke all on function hr.staff_before_offer(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hr_admin_staff_offer_send(p_id uuid, p_token_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers; i hr.staff_invites; v_problem text; v_first boolean;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('applied', 'invited', 'documents_submitted', 'offer_sent') then raise exception 'An offer can be sent while the person is being onboarded.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot send yourself an offer.' using errcode = '42501'; end if;
 select * into o from hr.staff_offers where profile_id = p.id and withdrawn_at is null and signed_at is null and declined_at is null for update;
 if not found then raise exception 'Upload the offer letter first.' using errcode = '23514'; end if;
 v_first := p.status <> 'offer_sent';
 if p.status = 'documents_submitted' then
  v_problem := hr.staff_documents_problem(p.id);
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 end if;
 if v_first then update hr.staff_offers set sent_at = now(), sent_by = v_admin where id = o.id returning * into o; end if;
 i := hr.invite_create(p.id, 'offer', p_token_hash, v_admin);
 if v_first then
  -- A document link still waiting is closed: the documents come after the offer is signed.
  update hr.staff_invites set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and purpose in ('documents', 'reupload') and used_at is null and revoked_at is null and superseded_at is null;
  perform hr.staff_move(p.id, 'offer_sent', 'Offer sent', v_admin, false);
 end if;
 return jsonb_build_object('invite', hr.invite_json(i), 'offer', hr.offer_json(o), 'email', p.email, 'name', hr.staff_name(p));
end $function$;

CREATE OR REPLACE FUNCTION public.hr_admin_onboarding_offer_send(p_id uuid, p_auth_user_id uuid, p_account_hash text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'hr', 'auth', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; i hr.staff_invites; r jsonb; v_first boolean; v_needs boolean;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('applied', 'invited', 'documents_submitted', 'offer_sent') then raise exception 'An offer can be sent while the person is being onboarded.' using errcode = '23514'; end if;
 v_first := p.status <> 'offer_sent';
 if p_auth_user_id is null then raise exception 'A login is needed before the offer can be sent.' using errcode = '22023'; end if;
 if p_auth_user_id = v_admin then raise exception 'You cannot send yourself an offer.' using errcode = '42501'; end if;
 select * into u from auth.users where id = p_auth_user_id;
 if not found or lower(btrim(coalesce(u.email, ''))) <> p.email then raise exception 'That login does not belong to this person.' using errcode = '42501'; end if;
 if p.auth_user_id is not null and p.auth_user_id <> p_auth_user_id then raise exception 'This person is already linked to a different login.' using errcode = '23505'; end if;
 if exists (select 1 from hr.staff_profiles s where s.auth_user_id = p_auth_user_id and s.id <> p.id) then raise exception 'That login already belongs to another staff member.' using errcode = '23505'; end if;
 v_needs := u.email_confirmed_at is null;
 if v_needs and (p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$') then raise exception 'A sign-in link is needed for this person.' using errcode = '22023'; end if;
 r := public.hr_admin_staff_offer_send(p.id, hr.random_hash());
 update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id and auth_user_id is distinct from p_auth_user_id;
 if v_needs then i := hr.account_invite_create(p.id, p_account_hash, v_admin); end if;
 return jsonb_build_object('profileId', p.id, 'email', p.email, 'name', hr.staff_name(p), 'offer', r->'offer', 'firstSend', v_first, 'needsPassword', v_needs,
  'invite', case when v_needs then hr.invite_json(i) end, 'expiresAt', case when v_needs then i.expires_at end);
end $function$;

CREATE OR REPLACE FUNCTION public.hr_admin_onboarding_offer_unsend(p_id uuid, p_unlink boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'offer_sent' then raise exception 'There is no sent offer to undo.' using errcode = '23514'; end if;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null for update;
 if not found or o.sent_by is distinct from v_admin or o.sent_at < now() - interval '15 minutes' then
  raise exception 'Only a send that has just failed can be undone. Withdraw the offer instead.' using errcode = '23514'; end if;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin
  where profile_id = p.id and purpose in ('offer', 'account') and revoked_at is null and superseded_at is null and used_at is null;
 update hr.staff_offers set sent_at = null, sent_by = null where id = o.id;
 perform hr.staff_move(p.id, hr.staff_before_offer(p.id), 'The offer email could not be sent; nothing went out', v_admin, false);
 if coalesce(p_unlink, false) then update hr.staff_profiles set auth_user_id = null where id = p.id; end if;
 return public.hr_admin_staff_detail(p.id);
end $function$;

CREATE OR REPLACE FUNCTION public.hr_admin_staff_offer_withdraw(p_id uuid, p_note text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining why the offer is withdrawn.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'offer_sent' then raise exception 'Only a sent, unsigned offer can be withdrawn.' using errcode = '23514'; end if;
 update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and purpose = 'offer' and revoked_at is null and superseded_at is null and used_at is null;
 perform hr.staff_move(p.id, hr.staff_before_offer(p.id), btrim(p_note), v_admin, false);
 return public.hr_admin_staff_detail(p.id);
end $function$;

CREATE OR REPLACE FUNCTION public.hr_admin_offer_letter_context(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_letter record; v_status text;
begin
 perform hr.require_admin();
 select p.status into v_status from hr.staff_profiles p where p.id = p_id;
 if not found then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
 select l.template_name, l.title, l.edited, l.created_at into v_letter from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id
  where l.profile_id = p_id and o.withdrawn_at is null order by l.created_at desc limit 1;
 return jsonb_build_object(
  -- STAFF-OFFER-FULL-PART-TIME: before the documents (Applied / Invited) only the pay details are needed.
  'problem', case when v_status in ('applied', 'invited') then hr.onboarding_pay_problem(p_id) else coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id)) end,
  'values', hr.template_values(p_id),
  'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'type', t.category, 'name', t.name, 'subject', coalesce(t.subject, t.title),
    'bodyHtml', coalesce(t.body_html, hr.text_to_html(t.body), ''), 'isDefault', t.is_default) order by t.category, lower(t.name))
    from hr.sign_templates t where t.category in ('offer_letter', 'offer_email') and t.status = 'active' and t.deleted_at is null), '[]'::jsonb),
  'letter', case when v_letter.title is null then null else jsonb_build_object('templateName', v_letter.template_name, 'title', v_letter.title, 'edited', v_letter.edited, 'createdAt', v_letter.created_at) end);
end $function$;

-- The document wizard can be filled in after the offer is signed (status stays Offer signed).
CREATE OR REPLACE FUNCTION hr.invite_for_write(p_hash text, p_purposes text[])
 RETURNS hr.staff_invites LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'hr', 'pg_temp'
AS $function$
declare i hr.staff_invites; v_status text;
begin
 i := hr.invite_resolve(p_hash, p_purposes);
 select status into v_status from hr.staff_profiles where id = i.profile_id for update;
 if i.used_at is not null or not (case when i.purpose = 'offer' then v_status = 'offer_sent' else v_status in ('invited', 'offer_signed') end) then
  raise exception 'This has already been sent and can no longer be changed.' using errcode = '23514';
 end if;
 return i;
end $function$;

CREATE OR REPLACE FUNCTION hr.staff_applicant_view(i hr.staff_invites)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'hr', 'pg_temp'
AS $function$
declare p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = i.profile_id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id' - 'id' - 'status_changed_at' - 'created_at' - 'updated_at',
  'status', p.status, 'mode', i.purpose, 'readOnly', i.used_at is not null or p.status not in ('invited', 'offer_signed'),
  'expiresAt', i.expires_at,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id), 'bank', hr.bank_view(p.id, false),
  'employment', (select jsonb_build_object('jobTitle', e.job_title, 'workLocation', e.work_location, 'employmentType', e.employment_type, 'joiningDate', e.joining_date,
    'payType', (select s.frequency from hr.employee_pay ep join hr.pay_schedules s on s.id = ep.pay_schedule_id where ep.profile_id = e.profile_id))
    from hr.employment e where e.profile_id = p.id));
end $function$;

CREATE OR REPLACE FUNCTION public.hr_svc_onboarding_submit(p_token_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare i hr.staff_invites; p hr.staff_profiles; c text; v_problem jsonb;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.purpose = 'documents' then
  v_problem := hr.v_staff_problem(hr.staff_details_json(p), array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
   'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
   'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions'], true);
  if v_problem is not null then raise exception '%', v_problem->>'message' using errcode = '23514'; end if;
 elsif p.is_australian_citizen is null then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '23514';
 end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current) then
   raise exception '%', case c when 'Passport' then 'A passport is required before you can submit.' else 'Upload your ' || hr.staff_doc_label(c) || '.' end using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current and ((d.expiry_date is null and hr.staff_doc_needs_expiry(c)) or d.expiry_date < current_date)) then
   raise exception 'Enter a current expiry date for your %.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then
  raise exception 'Replace every document we asked you to upload again.' using errcode = '23514'; end if;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when i.purpose = 'reupload' then 'Documents uploaded again' else 'Documents submitted' end, true);
 -- STAFF-OFFER-FULL-PART-TIME: after a signed offer the status stays Offer signed (activation checks the documents).
 if p.status = 'invited' then update hr.staff_profiles set status = 'documents_submitted' where id = p.id;
 else perform hr.audit_log(p.id, case when i.purpose = 'reupload' then 'documents_uploaded_again' else 'documents_submitted' end, '{}'::jsonb); end if;
 update hr.staff_applications set submitted_at = now() where profile_id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 perform hr.queue_email(p.id, 'admin_documents_submitted', 'admin', jsonb_build_object('reupload', i.purpose = 'reupload'));
 return hr.staff_applicant_view(i);
end $function$;

-- The signed-in person (offer signed) opens the document wizard: a fresh private link for their documents, or for the ones HR asked
-- for again. The function makes the token and passes only its hash; nothing is emailed.
create or replace function public.hr_svc_staff_documents_link(p_user uuid, p_hash text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'hr', 'auth', 'pg_temp'
as $function$
declare p hr.staff_profiles; v_submitted boolean; v_purpose text; i hr.staff_invites;
begin
 select * into p from hr.staff_profiles where auth_user_id = p_user for update;
 if not found or p.status <> 'offer_signed' or not exists (select 1 from auth.users u where u.id = p_user and u.email_confirmed_at is not null) then
  raise exception 'There are no documents to add for this login.' using errcode = '28000'; end if;
 v_submitted := exists (select 1 from hr.staff_applications a where a.profile_id = p.id and a.submitted_at is not null);
 if not v_submitted then v_purpose := 'documents';
 elsif exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then v_purpose := 'reupload';
 else raise exception 'Your documents are with us. We will contact you if we need anything else.' using errcode = '23514'; end if;
 i := hr.invite_create(p.id, v_purpose, p_hash, p_user);
 return jsonb_build_object('purpose', v_purpose, 'expiresAt', i.expires_at);
end $function$;
revoke all on function public.hr_svc_staff_documents_link(uuid, text) from public, anon, authenticated;
grant execute on function public.hr_svc_staff_documents_link(uuid, text) to service_role;

commit;
