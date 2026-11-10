-- Staff onboarding flow, part 1 (owner's brief 2026-11-10): the nine onboarding stages, pay details before the offer, the document
-- link from the employee page, and a full audit trail. Additive; builds on 20261110090000 (HR-02) and 20261110220000.
--
-- Stages (derived from what exists; hr.staff_profiles.status and its guard are unchanged):
--   Applied > Shortlisted > Documents requested > Documents submitted > Documents approved > Pay details added > Offer sent >
--   Offer signed > Active
--   applied                         Applied, or Shortlisted when the open job application is shortlisted / interview / selected
--   invited                         Documents requested
--   documents_submitted             Documents submitted (a required document is still pending or rejected), Documents approved
--                                   (all approved, pay details missing) or Pay details added (ready for the offer)
--   offer_sent / offer_signed / active   Offer sent / Offer signed / Active
--
-- 1. hr.employment: employment type 'casual'; pay_details_at / pay_details_by (when the pay details were completed).
-- 2. hr.onboarding_pay_problem(profile): what is still missing before an offer can go out (null = complete).
--    Trigger staff_offer_needs_pay: documents_submitted > offer_sent is refused while that is not null (every path, also direct SQL).
-- 3. hr_admin_onboarding_pay_save(p_id, p_details): position, type, start date, basis, rate, schedule, hours, manager and the Xero
--    fields in one validated call, only once every required document is approved and before the offer is sent.
-- 4. hr_admin_onboarding_documents_invite(p_id, p_token_hash): "Send document link" from the employee page. A Careers applicant or
--    manual candidate is hired for their open job application (same as Candidates > Hire); anyone else gets the plain document link.
-- 5. hr.staff_audit + triggers: who did what and when for documents, links, offers, pay, bank details and roles (status changes are
--    already in hr.staff_status_events, job application and employment changes in hr.recruitment_events).
-- 6. hr_admin_onboarding(p_id): stage, the nine steps with their dates, pay details, last link date and the merged timeline.
--
-- Rollback (manual): drop trigger staff_offer_needs_pay and the staff_audit_* triggers; drop the functions of this file and table
-- hr.staff_audit; re-run hr_admin_staff_employment_save from 20261110090000; the two employment columns and 'casual' may stay.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ 1. employment
alter table hr.employment drop constraint if exists employment_employment_type_check;
alter table hr.employment add constraint employment_employment_type_check check (employment_type in ('full_time', 'part_time', 'casual'));
alter table hr.employment add column if not exists pay_details_at timestamptz, add column if not exists pay_details_by uuid;

-- The employment details dialog (20261110090000) with Casual allowed; nothing else changes.
create or replace function public.hr_admin_staff_employment_save(p_id uuid, p_employment jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; v_manager uuid := nullif(p_employment->>'managerId', '')::uuid;
 v_title text := left(btrim(coalesce(p_employment->>'jobTitle', '')), 150); v_type text := nullif(p_employment->>'employmentType', '');
 v_department text := left(btrim(coalesce(p_employment->>'department', '')), 120); v_location text := left(btrim(coalesce(p_employment->>'workLocation', '')), 150);
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff record not found.' using errcode = 'P0002'; end if;
 if v_type is not null and v_type not in ('full_time','part_time','casual') then raise exception 'Choose Full time, Part time or Casual.' using errcode = '22023'; end if;
 if v_manager is not null then
  if v_manager = p.id then raise exception 'A person cannot be their own manager.' using errcode = '23514'; end if;
  if not exists (select 1 from hr.employment e join hr.staff_profiles m on m.id = e.profile_id where e.profile_id = v_manager and m.status = 'active') then
   raise exception 'Choose an active employee as the manager.' using errcode = '22023'; end if;
  if exists (with recursive chain as (select e.profile_id, e.manager_id from hr.employment e where e.profile_id = v_manager
    union select e.profile_id, e.manager_id from hr.employment e join chain c on e.profile_id = c.manager_id) select 1 from chain where profile_id = p.id) then
   raise exception 'The manager assignment would create a reporting cycle.' using errcode = '23514'; end if;
 end if;
 insert into hr.employment(profile_id, department, job_title, employment_type, manager_id, work_location) values (p.id, v_department, v_title, v_type, v_manager, v_location)
 on conflict (profile_id) do update set department = excluded.department, job_title = excluded.job_title, employment_type = excluded.employment_type,
  manager_id = excluded.manager_id, work_location = excluded.work_location;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_employment_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_staff_employment_save(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ 2. pay details before the offer
create or replace function hr.onboarding_pay_problem(p_profile uuid) returns text
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare e hr.employment; ep hr.employee_pay;
begin
 select * into e from hr.employment where profile_id = p_profile;
 if not found or e.pay_details_at is null then return 'Add the pay details first.'; end if;
 select * into ep from hr.employee_pay where profile_id = p_profile;
 if btrim(e.job_title) = '' then return 'The pay details need a position (job title).'; end if;
 if e.employment_type is null then return 'The pay details need an employment type.'; end if;
 if e.joining_date is null then return 'The pay details need a start date.'; end if;
 if ep.profile_id is null or ep.pay_basis is null then return 'The pay details need a pay basis (hourly or annual).'; end if;
 if ep.rate is null or ep.rate <= 0 then return 'The pay details need a pay rate.'; end if;
 if ep.pay_schedule_id is null then return 'The pay details need a pay schedule.'; end if;
 if e.employment_type <> 'casual' and ep.ordinary_hours_week is null then return 'The pay details need the hours per week.'; end if;
 return null;
end $fn$;
revoke all on function hr.onboarding_pay_problem(uuid) from public, anon, authenticated;

create or replace function hr.staff_offer_needs_pay() returns trigger
language plpgsql set search_path = hr, pg_temp as $fn$
declare v_problem text;
begin
 if old.status = 'documents_submitted' and new.status = 'offer_sent' then
  v_problem := hr.onboarding_pay_problem(new.id);
  if v_problem is not null then raise exception 'An offer cannot be sent yet. %', v_problem using errcode = '23514'; end if;
 end if;
 return new;
end $fn$;
drop trigger if exists staff_offer_needs_pay on hr.staff_profiles;
create trigger staff_offer_needs_pay before update of status on hr.staff_profiles for each row execute function hr.staff_offer_needs_pay();

-- ------------------------------------------------------------------ 5. audit trail (defined before the functions that are audited)
create table if not exists hr.staff_audit (
 id bigint generated always as identity primary key,
 profile_id uuid not null references hr.staff_profiles(id) on delete cascade,
 actor_id uuid,
 actor_kind text not null check (actor_kind in ('admin', 'applicant', 'system')),
 action text not null check (char_length(action) between 1 and 60),
 detail jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists staff_audit_profile_idx on hr.staff_audit(profile_id, id desc);
alter table hr.staff_audit enable row level security;
revoke all on hr.staff_audit from public, anon, authenticated;

-- Append-only, like hr.staff_status_events (same guard function); rows go only when the person's record is deleted.
drop trigger if exists staff_audit_no_change on hr.staff_audit;
create trigger staff_audit_no_change before update on hr.staff_audit for each row execute function hr.staff_events_append_only();
drop trigger if exists staff_audit_no_truncate on hr.staff_audit;
create trigger staff_audit_no_truncate before truncate on hr.staff_audit for each statement execute function hr.staff_events_append_only();

-- Who is acting: an explicit hr.actor / hr.actor_kind (set by hr.staff_move and the applicant functions) wins; otherwise the signed-in
-- user (the person themselves = applicant, anyone else = admin; every writer is admin-checked); with no user, the service role is an
-- Edge Function acting for the person on their link, and anything else is the system (a job or a migration).
create or replace function hr.audit_log(p_profile uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = hr, public, pg_temp as $fn$
declare v_uid uuid := auth.uid(); v_actor uuid := coalesce(nullif(current_setting('hr.actor', true), '')::uuid, v_uid);
 v_set text := nullif(current_setting('hr.actor_kind', true), ''); v_kind text;
 v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role');
begin
 if p_profile is null then return; end if;
 v_kind := case
  when v_set in ('admin', 'applicant', 'system') then v_set
  when v_uid is not null and exists (select 1 from hr.staff_profiles s where s.id = p_profile and s.auth_user_id = v_uid) then 'applicant'
  when v_uid is not null then 'admin'
  when v_role = 'service_role' then 'applicant'
  else 'system' end;
 insert into hr.staff_audit(profile_id, actor_id, actor_kind, action, detail) values (p_profile, v_actor, v_kind, left(p_action, 60), coalesce(p_detail, '{}'::jsonb));
end $fn$;
revoke all on function hr.audit_log(uuid, text, jsonb) from public, anon, authenticated;

create or replace function hr.staff_audit_trigger() returns trigger
language plpgsql security definer set search_path = hr, public, pg_temp as $fn$
begin
 if tg_table_name = 'staff_documents' then
  if tg_op = 'INSERT' then
   perform hr.audit_log(new.profile_id, 'document_uploaded', jsonb_build_object('category', new.category, 'filename', new.filename));
  elsif new.status is distinct from old.status and new.status in ('approved', 'rejected') then
   perform hr.audit_log(new.profile_id, 'document_' || new.status, jsonb_build_object('category', new.category, 'filename', new.filename)
    || case when new.status = 'rejected' then jsonb_build_object('note', new.review_note) else '{}'::jsonb end);
  elsif old.is_current and not new.is_current then
   perform hr.audit_log(new.profile_id, 'document_replaced', jsonb_build_object('category', new.category, 'filename', new.filename));
  end if;
 elsif tg_table_name = 'staff_invites' then
  if tg_op = 'INSERT' then
   perform hr.audit_log(new.profile_id, 'link_created', jsonb_build_object('purpose', new.purpose, 'expiresAt', new.expires_at));
  elsif old.revoked_at is null and new.revoked_at is not null then
   perform hr.audit_log(new.profile_id, 'link_revoked', jsonb_build_object('purpose', new.purpose));
  elsif old.used_at is null and new.used_at is not null and new.purpose = 'account' then
   perform hr.audit_log(new.profile_id, 'password_set', '{}'::jsonb);
  end if;
 elsif tg_table_name = 'staff_offers' then
  if tg_op = 'INSERT' then
   perform hr.audit_log(new.profile_id, 'offer_prepared', jsonb_build_object('filename', new.filename));
  elsif old.sent_at is null and new.sent_at is not null then
   perform hr.audit_log(new.profile_id, 'offer_sent', jsonb_build_object('filename', new.filename));
  elsif old.sent_at is not null and new.sent_at is null then
   perform hr.audit_log(new.profile_id, 'offer_send_failed', jsonb_build_object('filename', new.filename));
  elsif old.withdrawn_at is null and new.withdrawn_at is not null then
   perform hr.audit_log(new.profile_id, case when old.sent_at is null then 'offer_replaced' else 'offer_withdrawn' end, jsonb_build_object('filename', new.filename));
  elsif old.signed_at is null and new.signed_at is not null then
   perform hr.audit_log(new.profile_id, 'offer_signed', jsonb_build_object('filename', new.filename, 'signerName', new.signer_name));
  end if;
 elsif tg_table_name = 'employee_pay' then
  if tg_op = 'INSERT' or (to_jsonb(new) - 'updated_at' - 'updated_by') is distinct from (to_jsonb(old) - 'updated_at' - 'updated_by') then
   perform hr.audit_log(new.profile_id, 'pay_saved', jsonb_build_object('payBasis', new.pay_basis, 'payScheduleId', new.pay_schedule_id));
  end if;
 elsif tg_table_name = 'employee_bank' then
  perform hr.audit_log(new.profile_id, 'bank_saved', '{}'::jsonb);
 elsif tg_table_name = 'staff_roles' then
  if tg_op = 'INSERT' then perform hr.audit_log(new.profile_id, 'role_granted', jsonb_build_object('role', new.role));
  elsif old.revoked_at is null and new.revoked_at is not null then perform hr.audit_log(new.profile_id, 'role_revoked', jsonb_build_object('role', new.role));
  end if;
 end if;
 return new;
end $fn$;
revoke all on function hr.staff_audit_trigger() from public, anon, authenticated;

drop trigger if exists staff_audit_documents on hr.staff_documents;
create trigger staff_audit_documents after insert or update on hr.staff_documents for each row execute function hr.staff_audit_trigger();
drop trigger if exists staff_audit_invites on hr.staff_invites;
create trigger staff_audit_invites after insert or update on hr.staff_invites for each row execute function hr.staff_audit_trigger();
drop trigger if exists staff_audit_offers on hr.staff_offers;
create trigger staff_audit_offers after insert or update on hr.staff_offers for each row execute function hr.staff_audit_trigger();
drop trigger if exists staff_audit_pay on hr.employee_pay;
create trigger staff_audit_pay after insert or update on hr.employee_pay for each row execute function hr.staff_audit_trigger();
drop trigger if exists staff_audit_bank on hr.employee_bank;
create trigger staff_audit_bank after insert or update on hr.employee_bank for each row execute function hr.staff_audit_trigger();
drop trigger if exists staff_audit_roles on hr.staff_roles;
create trigger staff_audit_roles after insert or update on hr.staff_roles for each row execute function hr.staff_audit_trigger();

-- ------------------------------------------------------------------ 6. stages
create or replace function hr.onboarding_stage(p_profile uuid) returns jsonb
language plpgsql stable security definer set search_path = hr, public, pg_temp as $fn$
declare p hr.staff_profiles; e hr.employment; j hr.job_applications; v_cycle timestamptz; v_status text; v_closed text; v_idx integer;
 v_docs text; v_pay text; v_at timestamptz[] := array_fill(null::timestamptz, array[9]); v_steps jsonb := '[]'::jsonb; i integer; v_state text;
 keys constant text[] := array['applied','shortlisted','documents_requested','documents_submitted','documents_approved','pay_details','offer_sent','offer_signed','active'];
 labels constant text[] := array['Applied','Shortlisted','Documents requested','Documents submitted','Documents approved','Pay details added','Offer sent','Offer signed','Active'];
begin
 select * into p from hr.staff_profiles where id = p_profile;
 if not found then return null; end if;
 select * into e from hr.employment where profile_id = p.id;
 -- The current application: from the latest move to Applied (first application, re-application or reopen).
 select coalesce(max(created_at), p.created_at) into v_cycle from hr.staff_status_events where profile_id = p.id and to_status = 'applied';
 select * into j from hr.job_applications x where x.profile_id = p.id and x.status in ('applied', 'hired') order by (x.status = 'applied') desc, x.created_at desc limit 1;
 v_status := p.status;
 if p.status in ('rejected', 'inactive') then
  v_closed := p.status;
  select coalesce(from_status, 'applied') into v_status from hr.staff_status_events where profile_id = p.id and to_status = p.status order by id desc limit 1;
  v_status := coalesce(v_status, 'applied');
 end if;
 v_docs := hr.staff_documents_problem(p.id);
 v_pay := hr.onboarding_pay_problem(p.id);
 v_idx := case v_status
  when 'applied' then case when j.id is not null and j.status = 'applied' and j.stage in ('shortlisted', 'interview', 'selected') then 1 else 0 end
  when 'invited' then 2
  when 'documents_submitted' then case when v_docs is not null then 3 when v_pay is not null then 4 else 5 end
  when 'offer_sent' then 6 when 'offer_signed' then 7 when 'active' then 8 else 0 end;

 v_at[1] := v_cycle;
 v_at[3] := (select min(created_at) from hr.staff_status_events where profile_id = p.id and to_status = 'invited' and created_at >= v_cycle);
 v_at[2] := (select min(r.created_at) from hr.recruitment_events r where r.profile_id = p.id and r.created_at >= v_cycle
  and r.action like 'Application %' and r.details->>'stage' in ('shortlisted', 'interview', 'selected'));
 -- No recorded shortlisting (a direct applicant, or a stage set before this was logged): the step counts from when they moved on.
 if v_at[2] is null and v_idx >= 1 then v_at[2] := case when v_idx = 1 then j.updated_at else v_at[3] end; end if;
 v_at[4] := (select max(created_at) from hr.staff_status_events where profile_id = p.id and to_status = 'documents_submitted' and from_status = 'invited' and created_at >= v_cycle);
 v_at[5] := (select max(d.reviewed_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'approved'
  and d.category = any(hr.staff_required_categories(p.is_australian_citizen)));
 v_at[6] := e.pay_details_at;
 v_at[7] := (select max(o.sent_at) from hr.staff_offers o where o.profile_id = p.id and o.withdrawn_at is null and o.sent_at >= v_cycle);
 v_at[8] := (select max(o.signed_at) from hr.staff_offers o where o.profile_id = p.id and o.signed_at >= v_cycle);
 v_at[9] := (select max(created_at) from hr.staff_status_events where profile_id = p.id and to_status = 'active' and created_at >= v_cycle);

 for i in 0..8 loop
  v_state := case
   when v_closed is not null then case when i <= v_idx then 'done' else 'todo' end
   when i < v_idx or v_idx = 8 then 'done' when i = v_idx then 'current' else 'todo' end;
  v_steps := v_steps || jsonb_build_object('key', keys[i + 1], 'label', labels[i + 1], 'state', v_state, 'at', case when v_state = 'todo' then null else v_at[i + 1] end);
 end loop;
 return jsonb_build_object('stage', keys[v_idx + 1], 'index', v_idx, 'closed', v_closed, 'steps', v_steps,
  'documentsApproved', v_docs is null and v_status not in ('applied', 'invited'), 'documentsProblem', v_docs,
  'payComplete', v_pay is null, 'payProblem', v_pay);
end $fn$;
revoke all on function hr.onboarding_stage(uuid) from public, anon, authenticated;

-- The history of one person, newest first: status changes, job application and employment changes, the audited actions and emails.
create or replace function hr.onboarding_timeline(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, public, pg_temp as $fn$
 with person as (select auth_user_id from hr.staff_profiles where id = p_profile),
 entries as (
  select e.created_at as at, e.actor_id, e.actor_kind, 'status'::text as type, e.to_status as action,
   jsonb_build_object('from', e.from_status, 'to', e.to_status, 'note', e.note) as detail, e.id as seq
  from hr.staff_status_events e where e.profile_id = p_profile
  union all
  select a.created_at, a.actor_id, a.actor_kind, 'action', a.action, a.detail, a.id from hr.staff_audit a where a.profile_id = p_profile
  union all
  select r.created_at, r.actor_id, case when r.actor_id is null then 'system' when r.actor_id = (select auth_user_id from person) then 'applicant' else 'admin' end,
   'recruitment', r.action, jsonb_strip_nulls(jsonb_build_object('stage', r.details->>'stage', 'status', r.details->>'status', 'fields', r.details->'fields',
    'jobTitle', nullif(r.details->>'job_title', ''), 'employmentType', r.details->>'employment_type')), r.id
  from hr.recruitment_events r where r.profile_id = p_profile
  union all
  select coalesce(m.sent_at, m.created_at), null::uuid, 'system', 'email', m.kind, jsonb_build_object('state', m.state, 'audience', m.audience), m.id
  from hr.staff_emails m where m.profile_id = p_profile and m.state in ('sent', 'failed', 'skipped'))
 select coalesce(jsonb_agg(jsonb_build_object('at', x.at, 'type', x.type, 'action', x.action, 'detail', x.detail, 'actorKind', x.actor_kind,
   'actorName', case when x.actor_kind = 'admin' then coalesce((select nullif(btrim(c.name), '') from public.cms_users c where c.auth_user_id = x.actor_id limit 1), 'An administrator')
    when x.actor_kind = 'applicant' then 'The applicant' else 'System' end)
  order by x.at desc, x.type, x.seq desc), '[]'::jsonb)
 from entries x;
$fn$;
revoke all on function hr.onboarding_timeline(uuid) from public, anon, authenticated;

create or replace function hr.onboarding_pay_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('employment', hr.employment_json(p_profile), 'pay', hr.employee_pay_json(p_profile),
  'completedAt', (select e.pay_details_at from hr.employment e where e.profile_id = p_profile),
  'schedules', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'frequency', s.frequency) order by s.name) from hr.pay_schedules s where s.is_active), '[]'::jsonb));
$fn$;
revoke all on function hr.onboarding_pay_json(uuid) from public, anon, authenticated;

create or replace function public.hr_admin_onboarding(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 return hr.onboarding_stage(p.id) || jsonb_build_object(
  'payDetails', hr.onboarding_pay_json(p.id),
  'documentLinkSentAt', (select max(i.created_at) from hr.staff_invites i where i.profile_id = p.id and i.purpose in ('documents', 'reupload')),
  'timeline', hr.onboarding_timeline(p.id));
end $fn$;
revoke all on function public.hr_admin_onboarding(uuid) from public, anon;
grant execute on function public.hr_admin_onboarding(uuid) to authenticated;

-- ------------------------------------------------------------------ 3. pay details
create or replace function public.hr_admin_onboarding_pay_save(p_id uuid, p_details jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_problem text;
 v_title text := btrim(coalesce(p_details->>'jobTitle', '')); v_type text := nullif(p_details->>'employmentType', '');
 v_start_raw text := btrim(coalesce(p_details->>'startDate', '')); v_start date;
 v_basis text := nullif(p_details->>'payBasis', ''); v_rate_raw text := btrim(coalesce(p_details->>'rate', '')); v_rate numeric;
 v_hours_raw text := btrim(coalesce(p_details->>'hoursPerWeek', '')); v_hours numeric;
 v_schedule_raw text := btrim(coalesce(p_details->>'payScheduleId', '')); v_schedule uuid;
begin
 if jsonb_typeof(p_details) is distinct from 'object' then raise exception 'Enter the pay details.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status in ('offer_sent', 'offer_signed') then raise exception 'The offer has already gone out with these pay details. Withdraw the offer to change them.' using errcode = '23514'; end if;
 if p.status <> 'documents_submitted' then raise exception 'Pay details are added once the documents are submitted and approved.' using errcode = '23514'; end if;
 v_problem := hr.staff_documents_problem(p.id);
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;

 if v_title = '' or char_length(v_title) > 150 then raise exception 'Enter the position (job title).' using errcode = '22023'; end if;
 if v_type is null or v_type not in ('full_time', 'part_time', 'casual') then raise exception 'Choose the employment type.' using errcode = '22023'; end if;
 if v_start_raw !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter the start date.' using errcode = '22023'; end if;
 begin v_start := v_start_raw::date; exception when others then raise exception 'Enter a valid start date.' using errcode = '22023'; end;
 if v_start < current_date - 365 or v_start > current_date + 730 then raise exception 'The start date must be within the last year or the next two years.' using errcode = '22023'; end if;
 if v_basis is null or v_basis not in ('hourly', 'salary') then raise exception 'Choose the pay basis (hourly or annual).' using errcode = '22023'; end if;
 if v_rate_raw !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Enter the pay rate as a number, for example 38.50.' using errcode = '22023'; end if;
 v_rate := v_rate_raw::numeric;
 if v_rate <= 0 then raise exception 'The pay rate must be more than zero.' using errcode = '22023'; end if;
 if v_basis = 'hourly' and v_rate > 1000 then raise exception 'That hourly rate looks too high. Check the pay basis.' using errcode = '22023'; end if;
 if v_basis = 'salary' and v_rate < 1000 then raise exception 'That annual salary looks too low. Check the pay basis.' using errcode = '22023'; end if;
 if v_schedule_raw !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Choose the pay schedule.' using errcode = '22023'; end if;
 v_schedule := v_schedule_raw::uuid;
 if not exists (select 1 from hr.pay_schedules s where s.id = v_schedule and s.is_active) then raise exception 'Choose an active pay schedule.' using errcode = '22023'; end if;
 if v_hours_raw = '' then
  if v_type <> 'casual' then raise exception 'Enter the hours per week.' using errcode = '22023'; end if;
 else
  if v_hours_raw !~ '^\d{1,2}(\.\d{1,2})?$' then raise exception 'Enter the hours per week as a number, for example 38.' using errcode = '22023'; end if;
  v_hours := v_hours_raw::numeric;
  if v_hours <= 0 or v_hours > 80 then raise exception 'The hours per week must be between 1 and 80.' using errcode = '22023'; end if;
 end if;

 -- The employment record and the pay setup are written by their own functions (manager and schedule rules live there).
 perform public.hr_admin_staff_employment_save(p.id, jsonb_build_object('jobTitle', v_title, 'employmentType', v_type,
  'department', coalesce(p_details->>'department', ''), 'workLocation', coalesce(p_details->>'workLocation', ''), 'managerId', coalesce(p_details->>'managerId', '')));
 update hr.employment set joining_date = v_start, pay_details_at = now(), pay_details_by = v_admin where profile_id = p.id;
 perform public.hr_admin_employee_pay_save(p.id, jsonb_build_object('payScheduleId', v_schedule, 'payBasis', v_basis, 'rate', v_rate,
  'ordinaryHoursWeek', coalesce(v_hours::text, ''), 'award', coalesce(p_details->>'award', ''), 'xeroEmployeeId', coalesce(p_details->>'xeroEmployeeId', ''))
  || case when jsonb_typeof(p_details->'usualWorkDays') = 'array' and jsonb_array_length(p_details->'usualWorkDays') > 0 then jsonb_build_object('usualWorkDays', p_details->'usualWorkDays') else '{}'::jsonb end);
 perform hr.audit_log(p.id, 'pay_details_added', jsonb_build_object('jobTitle', v_title, 'employmentType', v_type, 'startDate', v_start, 'payBasis', v_basis));
 return public.hr_admin_onboarding(p.id);
end $fn$;
revoke all on function public.hr_admin_onboarding_pay_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_onboarding_pay_save(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ 4. the document link from the employee page
create or replace function public.hr_admin_onboarding_documents_invite(p_id uuid, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; a hr.job_applications;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status = 'applied' then
  select * into a from hr.job_applications x where x.profile_id = p.id and x.status = 'applied' order by x.created_at desc limit 1 for update;
  if found then
   -- Same as Candidates > "Hire and send document link": the job application is hired and the employment record comes from the job.
   if a.stage <> 'selected' then update hr.job_applications set stage = 'selected' where id = a.id; end if;
   return public.hr_admin_candidate_hire(a.id, p_token_hash);
  end if;
 end if;
 return public.hr_admin_staff_invite(p.id, 'documents', p_token_hash) || jsonb_build_object('profileId', p.id);
end $fn$;
revoke all on function public.hr_admin_onboarding_documents_invite(uuid, text) from public, anon;
grant execute on function public.hr_admin_onboarding_documents_invite(uuid, text) to authenticated;
