-- ENROL-MAILBOX (2026-11-21, owner): "Mark as enrolled" only from CoE / VoE issued, and the student mailbox offered after it.
--
--   * Guard on enrollment_applications: the status becomes Enrolled only from CoE / VoE issued, whatever writes it (the status
--     commands, a transition an administrator added, the SQL editor). An application is never inserted as Enrolled. The one other
--     way back to Enrolled is Undo (revert_application_status) of a change made from Enrolled, within Undo's own window.
--   * Guard on application_status_transitions (Settings > Application statuses): no "-> Enrolled" except from CoE / VoE issued.
--   * The Enrol action is labelled "Mark as enrolled" (only where it still has the seeded label "Enrol").
--   * The mailbox dialog after enrolment (Email Management's Create Email, student-office365) logs to the application's audit log:
--     student_mailbox_created / _failed (student-office365, with the application id) and _skipped (Skip for now), application_mailbox_log.
--   * Email Management > Email Accounts > "Enrolled, no mailbox yet": email_mgmt_enrolled_without_mailbox().
-- Additive: two triggers, one check constraint, two functions; one label updated.
set local lock_timeout = '5s';

/* ------------------------------------------------------------------ 1. Enrolled only from CoE / VoE issued */
create or replace function public.application_enrolled_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if new.status is distinct from 'enrolled' then return new; end if;
 if tg_op = 'INSERT' then
  raise exception 'Issue the CoE/VoE first: an application is marked enrolled only from CoE / VoE issued' using errcode = '22023';
 end if;
 if old.status = 'enrolled' or old.status = 'coe_issued' then return new; end if;
 -- Undo of a change made from Enrolled (revert_application_status sets this note and checks its own 15-second window).
 if coalesce(current_setting('portal.status_note', true), '') like 'Undone:%' then
  if exists (select 1 from public.enrollment_application_status_history x where x.application_id = new.id and x.previous_status = 'enrolled'
     and x.new_status = old.status and x.created_at > now() - interval '1 minute') then return new; end if;
 end if;
 raise exception 'Issue the CoE/VoE first: an application is marked enrolled only from CoE / VoE issued (it is %)', public.portal_status_label(old.status) using errcode = '22023';
end $f$;
revoke all on function public.application_enrolled_guard() from public, anon, authenticated;
drop trigger if exists a0_application_enrolled_guard on public.enrollment_applications;
create trigger a0_application_enrolled_guard before insert or update of status on public.enrollment_applications
 for each row execute function public.application_enrolled_guard();

do $$ begin
 if not exists (select 1 from pg_constraint where conname = 'application_status_transitions_enrolled_from_coe') then
  alter table public.application_status_transitions add constraint application_status_transitions_enrolled_from_coe
   check (to_status is distinct from 'enrolled' or from_status = 'coe_issued');
 end if;
end $$;

update public.application_status_transitions set label = 'Mark as enrolled' where kind = 'enrol' and from_status = 'coe_issued' and to_status = 'enrolled' and label = 'Enrol';

/* ------------------------------------------------------------------ 2. the application's audit log for the mailbox */
-- created: only when Skyline holds the student's Microsoft 365 account (student_office365_accounts with a Microsoft user); failed and
-- skipped: what the dialog reports. SLIT administrators with access to the application; the application's own student only.
create or replace function public.application_mailbox_log(p_application uuid, p_outcome text, p_detail jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare a public.enrollment_applications; m public.student_office365_accounts; v_detail jsonb;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if p_outcome not in ('created', 'failed', 'skipped') then raise exception 'Unknown mailbox outcome' using errcode = '22023'; end if;
 if a.student_id is null then raise exception 'This application has no student profile' using errcode = '22023'; end if;
 select * into m from public.student_office365_accounts where student_id = a.student_id;
 if p_outcome = 'created' and (m.student_id is null or m.ms_user_id is null) then raise exception 'No Microsoft 365 account is recorded for this student' using errcode = '22023'; end if;
 v_detail := jsonb_build_object('student', a.student_id, 'status', a.status)
  || case when m.student_id is not null then jsonb_build_object('mailbox', m.upn, 'mailboxStatus', m.status) else '{}'::jsonb end
  || jsonb_strip_nulls(jsonb_build_object('reason', left(nullif(btrim(coalesce(p_detail->>'reason', '')), ''), 300), 'code', left(nullif(btrim(coalesce(p_detail->>'code', '')), ''), 60)));
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
 values (auth.uid(), coalesce((select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin',
  'student_mailbox_' || p_outcome, 'application', a.id::text, a.id, a.agency_id, a.tenant_id, v_detail);
 return jsonb_build_object('logged', 'student_mailbox_' || p_outcome);
end $f$;
revoke all on function public.application_mailbox_log(uuid, text, jsonb) from public, anon;
grant execute on function public.application_mailbox_log(uuid, text, jsonb) to authenticated;

/* ------------------------------------------------------------------ 3. Enrolled, no mailbox yet */
-- Students with an Enrolled application and no active Microsoft 365 account Skyline holds, with the last skip / failure logged on the
-- application. Email Management's own access rule (admin_business_require, as email_mgmt_people).
create or replace function public.email_mgmt_enrolled_without_mailbox() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(row_to_json(t) order by t."enrolledAt" desc nulls last) from (
  select distinct on (s.id) s.id "studentId", s.full_name "name", s.email "email", a.id "applicationId", a.reference "reference",
   (select h.created_at from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = 'enrolled' order by h.created_at desc limit 1) "enrolledAt",
   m.status "mailboxStatus", m.upn "mailbox", m.last_error "mailboxError",
   (select jsonb_build_object('outcome', replace(g.action, 'student_mailbox_', ''), 'at', g.created_at, 'by', g.actor_name, 'reason', g.detail->>'reason', 'code', g.detail->>'code')
      from public.portal_audit_log g where g.application_id = a.id and g.action in ('student_mailbox_skipped', 'student_mailbox_failed') order by g.created_at desc limit 1) "last"
  from public.enrollment_applications a
  join public.enrollment_students s on s.id = a.student_id
  left join public.student_office365_accounts m on m.student_id = s.id
  where a.status = 'enrolled' and (m.student_id is null or m.status <> 'active')
  order by s.id, a.updated_at desc
  limit 500) t), '[]'::jsonb);
end $f$;
revoke all on function public.email_mgmt_enrolled_without_mailbox() from public, anon;
grant execute on function public.email_mgmt_enrolled_without_mailbox() to authenticated;
