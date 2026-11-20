-- Students (owner 2026-11-21).
-- (1) A student's email edited in Students > Edit student reaches every outgoing email. Before: the application kept its own copy
--     (enrollment_applications.student_email) and the offer recipient / student contact preferred that copy, so the offer letter and its
--     signing / payment links went to the old address. Now:
--     - application_offer_recipient / application_student_contact use the student record first (its current email at send time);
--     - when enrollment_students.email changes, every copy still waiting to be used follows it: the student's applications, offer letters
--       not yet signed or accepted, signing recipients still to sign (draft / sent / viewed requests; a signed or declined recipient keeps
--       the address it signed under, as the audit record) with a sign event "recipient_email_changed", queued (pending) notification
--       emails, pending sign-in invitations and the student's conversation;
--     - a confirmed change of a portal login's email (Auth change-email flow, started by portal-admin-users student_email_change) is
--       copied to portal_profiles.email.
-- (2) Students list: "Portal access" (Not invited / Invited / Active / Disabled) and "Enrolment" derived from the student's applications
--     (Applicant -> Offer issued -> Offer accepted -> Deposit paid -> Enrolled (CoE issued) / Withdrawn; the most advanced application and
--     its course), both filterable with counts. admin_students_list is replaced (two new optional filters); nothing is stored by hand.

-- ------------------------------------------------------------------ (1) email at send time
CREATE OR REPLACE FUNCTION public.application_offer_recipient(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v_agent boolean; p public.portal_profiles; v_name text; v_email text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v_agent := public.rule_text('admissions.offer_letter_recipient', 'Agent when an agent started the application') <> 'Always the student' and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin'));
 if v_agent then
  select * into p from public.portal_profiles x where x.id = a.assigned_agent_id and x.status = 'Active' and coalesce(btrim(x.email), '') <> '';
  if not found then select * into p from public.portal_profiles x where x.id = a.created_by; end if;
  return jsonb_build_object('kind', 'agent', 'name', coalesce(p.full_name, ''), 'email', lower(btrim(coalesce(p.email, ''))), 'user', p.auth_user_id,
    'reason', 'An agent started this application, so the letter goes to the agent');
 end if;
 -- STUDENT-EMAIL: the student record's current email first; the application's copy only when no student is linked.
 select coalesce(nullif(btrim(s.full_name), ''), a.student_name), coalesce(nullif(lower(btrim(s.email)), ''), lower(btrim(coalesce(a.student_email, ''))))
   into v_name, v_email from (select 1) one left join public.enrollment_students s on s.id = a.student_id;
 return jsonb_build_object('kind', 'student', 'name', coalesce(v_name, ''), 'email', coalesce(v_email, ''), 'user', null,
   'reason', case when public.rule_text('admissions.offer_letter_recipient', 'Agent when an agent started the application') = 'Always the student' and a.created_by is not null then 'Offer letters always go to the student' when a.created_by is null then 'Staff created this application for the student, so the letter goes to the student'
     else 'The student applied directly, so the letter goes to the student' end);
end $function$;

CREATE OR REPLACE FUNCTION public.application_student_contact(p_application uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 -- STUDENT-EMAIL: the student record's current email first.
 select jsonb_build_object('name', coalesce(nullif(btrim(s.full_name), ''), nullif(btrim(a.student_name), ''), 'Student'),
   'email', coalesce(nullif(lower(btrim(s.email)), ''), lower(btrim(coalesce(a.student_email, '')))), 'studentId', a.student_id)
 from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id where a.id = p_application;
$function$;

/** Moves every copy of a student's email still waiting to be used from p_old to p_new (the trigger below, and the backfill). Counts. */
create or replace function public.student_email_apply(p_student uuid, p_old text, p_new text)
 returns jsonb language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare v_old text := lower(btrim(coalesce(p_old, ''))); v_new text := lower(btrim(coalesce(p_new, ''))); k record; n_apps int := 0; n_letters int := 0; n_recipients int := 0; n_mail int := 0; n_invites int := 0; n_conv int := 0;
 st public.enrollment_students;
begin
 select * into st from public.enrollment_students where id = p_student;
 if st.id is null or v_new = '' or v_new = v_old then return jsonb_build_object('changed', false); end if;
 -- The student's applications: their contact email is the student's.
 update public.enrollment_applications e set student_email = v_new where e.student_id = st.id and lower(btrim(coalesce(e.student_email, ''))) is distinct from v_new;
 get diagnostics n_apps = row_count;
 if v_old = '' then return jsonb_build_object('changed', true, 'applications', n_apps); end if;
 -- Offer letters not signed or accepted yet that were addressed to the student (an agent-addressed letter is left alone).
 update public.enrollment_offer_letters o set recipient_email = v_new
  where o.application_id in (select e.id from public.enrollment_applications e where e.student_id = st.id)
   and lower(btrim(coalesce(o.recipient_email, ''))) = v_old and o.signed_at is null and o.accepted_at is null;
 get diagnostics n_letters = row_count;
 -- Signing recipients still to sign: Resend and reminders go to the new address. Signed / declined recipients keep their address.
 for k in select x.id, x.request_id from hr.sign_recipients x join hr.sign_requests r on r.id = x.request_id
   where r.state in ('draft', 'sent', 'viewed') and x.state in ('pending', 'sent', 'viewed') and lower(btrim(coalesce(x.email, ''))) = v_old
    and (r.subject_id = st.id or r.subject_id in (select e.id from public.enrollment_applications e where e.student_id = st.id)) loop
  update hr.sign_recipients set email = v_new where id = k.id;
  update hr.sign_requests set recipient_email = v_new where id = k.request_id and lower(btrim(coalesce(recipient_email, ''))) = v_old;
  perform hr.sign_event(k.request_id, 'recipient_email_changed', k.id, auth.uid(), jsonb_build_object('from', v_old, 'to', v_new, 'reason', 'The student''s email was changed'));
  n_recipients := n_recipients + 1;
 end loop;
 -- Emails queued but not sent yet.
 update public.notification_deliveries d set recipient_email = v_new
  where d.state = 'pending' and lower(btrim(coalesce(d.recipient_email, ''))) = v_old
   and d.application_id in (select e.id from public.enrollment_applications e where e.student_id = st.id);
 get diagnostics n_mail = row_count;
 -- A sign-in invitation not accepted yet.
 update public.agency_invitations i set email = v_new where i.student_id = st.id and i.status = 'pending' and lower(btrim(coalesce(i.email, ''))) = v_old;
 get diagnostics n_invites = row_count;
 update public.comm_conversations c set email = v_new, updated_at = now() where c.person_kind = 'student' and c.person_ref::text = st.id::text and lower(btrim(coalesce(c.email, ''))) = v_old;
 get diagnostics n_conv = row_count;
 return jsonb_build_object('changed', true, 'applications', n_apps, 'offerLetters', n_letters, 'signingRecipients', n_recipients, 'queuedEmails', n_mail, 'invitations', n_invites, 'conversations', n_conv);
end $$;
revoke all on function public.student_email_apply(uuid, text, text) from public, anon, authenticated;

create or replace function public.enrollment_students_email_follow()
 returns trigger language plpgsql security definer set search_path to pg_catalog, public, hr
as $$
declare v jsonb;
begin
 v := public.student_email_apply(new.id, old.email, new.email);
 raise log 'student % email changed: %', new.id, v;
 return new;
end $$;
revoke all on function public.enrollment_students_email_follow() from public, anon, authenticated;
drop trigger if exists zz_student_email_follow on public.enrollment_students;
create trigger zz_student_email_follow after update of email on public.enrollment_students
 for each row when (lower(btrim(coalesce(new.email, ''))) is distinct from lower(btrim(coalesce(old.email, '')))) execute function public.enrollment_students_email_follow();

-- Backfill: a student whose email was changed before this release still has copies of the earlier address on their applications
-- (2026-11-21: one student); those copies, and everything pending that still uses them, move to the student's current email now.
do $$
declare r record; v jsonb;
begin
 for r in select distinct s.id, lower(btrim(a.student_email)) as old_email, lower(btrim(s.email)) as new_email
   from public.enrollment_applications a join public.enrollment_students s on s.id = a.student_id
   where btrim(coalesce(s.email, '')) <> '' and btrim(coalesce(a.student_email, '')) <> '' and lower(btrim(a.student_email)) <> lower(btrim(s.email)) loop
  v := public.student_email_apply(r.id, r.old_email, r.new_email);
  raise notice 'student % backfilled: %', r.id, v;
 end loop;
end $$;

-- A confirmed Auth email change (Supabase change-email flow) is the login's email from then on.
create or replace function public.portal_profile_email_follow_auth()
 returns trigger language plpgsql security definer set search_path to pg_catalog, public
as $$
begin
 if new.email is not null and lower(new.email) is distinct from lower(coalesce(old.email, '')) then
  update public.portal_profiles p set email = lower(new.email) where p.auth_user_id = new.id and lower(coalesce(p.email, '')) is distinct from lower(new.email);
 end if;
 return new;
end $$;
revoke all on function public.portal_profile_email_follow_auth() from public, anon, authenticated;
drop trigger if exists portal_profile_email_follow_auth on auth.users;
create trigger portal_profile_email_follow_auth after update of email on auth.users
 for each row when (new.email is distinct from old.email) execute function public.portal_profile_email_follow_auth();

-- ------------------------------------------------------------------ (2) portal access and enrolment, derived
/** Portal access: disabled (the student or the login is disabled), active, invited (an invitation, expired or not) or not_invited. */
create or replace function public.student_portal_access(p_student uuid)
 returns text language sql stable security definer set search_path to pg_catalog, public
as $$
 select case when s.status = 'Inactive' then 'disabled'
   else case public.student_login_state(s.id)->>'status' when 'active' then 'active' when 'disabled' then 'disabled' when 'invited' then 'invited' when 'expired' then 'invited' else 'not_invited' end end
 from public.enrollment_students s where s.id = p_student;
$$;
revoke all on function public.student_portal_access(uuid) from public, anon, authenticated;

/** Enrolment from the student's applications: the most advanced one (then the latest) and its course. */
create or replace function public.student_enrolment(p_student uuid)
 returns jsonb language sql stable security definer set search_path to pg_catalog, public
as $$
 with apps as (
  select e.id, e.reference, e.status, e.updated_at,
   case when e.status in ('coe_issued', 'enrolled') then 'enrolled'
    when e.status = 'offer_accepted' and exists (select 1 from public.enrollment_offer_letters o where o.application_id = e.id and o.deposit_paid_at is not null) then 'deposit_paid'
    when e.status = 'offer_accepted' then 'offer_accepted'
    when e.status = 'offer_issued' then 'offer_issued'
    when e.status in ('withdrawn', 'rejected') then 'withdrawn'
    else 'applicant' end as stage
  from public.enrollment_applications e where e.student_id = p_student
 ), ranked as (
  select a.*, case a.stage when 'enrolled' then 5 when 'deposit_paid' then 4 when 'offer_accepted' then 3 when 'offer_issued' then 2 when 'applicant' then 1 else 0 end as rank from apps a
 )
 select coalesce((select jsonb_build_object('stage', r.stage,
   'label', case r.stage when 'enrolled' then 'Enrolled (CoE issued)' when 'deposit_paid' then 'Deposit paid' when 'offer_accepted' then 'Offer accepted'
     when 'offer_issued' then 'Offer issued' when 'applicant' then 'Applicant' else case when r.status = 'rejected' then 'Rejected' else 'Withdrawn' end end,
   'applicationId', r.id, 'reference', r.reference, 'status', r.status,
   'course', (select string_agg(c.course_code, ', ' order by c.course_code) from public.enrollment_application_courses c where c.application_id = r.id))
  from ranked r order by r.rank desc, r.updated_at desc limit 1),
  jsonb_build_object('stage', 'none', 'label', 'No application', 'applicationId', null, 'reference', null, 'status', null, 'course', null));
$$;
revoke all on function public.student_enrolment(uuid) from public, anon, authenticated;

drop function if exists public.admin_students_list(text, text, uuid, uuid, integer, integer, text);
CREATE OR REPLACE FUNCTION public.admin_students_list(p_search text DEFAULT ''::text, p_status text DEFAULT ''::text, p_business uuid DEFAULT NULL::uuid, p_agent uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_student_status text DEFAULT ''::text,
  p_access text DEFAULT ''::text, p_enrolment text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 perform public.admin_business_require();
 if coalesce(p_student_status, '') not in ('', 'Active', 'Inactive') then raise exception 'Invalid student status' using errcode = '22023'; end if;
 if coalesce(p_access, '') not in ('', 'active', 'invited', 'not_invited', 'disabled') then raise exception 'Invalid portal access' using errcode = '22023'; end if;
 if coalesce(p_enrolment, '') not in ('', 'none', 'applicant', 'offer_issued', 'offer_accepted', 'deposit_paid', 'enrolled', 'withdrawn') then raise exception 'Invalid enrolment status' using errcode = '22023'; end if;
 with base as (
  select s.id,
   coalesce(nullif(btrim(s.full_name), ''), nullif(btrim(concat_ws(' ', s.details ->> 'first_name', s.details ->> 'middle_name', s.details ->> 'last_name')), ''), '') as full_name,
   coalesce(nullif(s.email, ''), s.details ->> 'email', '') as email,
   coalesce(nullif(s.phone, ''), s.details ->> 'mobile', '') as phone,
   coalesce(nullif(s.nationality, ''), s.details ->> 'nationality', '') as nationality,
   s.status as student_status, s.status_changed_at,
   s.created_at, s.date_of_birth, s.passport_number,
   a.id as business_id, a.name as business_name, a.status as business_status,
   case when a.status = 'Active' then 0 else 1 end as business_rank,
   g.id as agent_id, coalesce(g.full_name, '') as agent_name,
   (select max(e.updated_at) from public.enrollment_applications e where e.student_id = s.id) as last_updated,
   public.student_portal_access(s.id) as portal_access, public.student_enrolment(s.id) as enrolment
  from public.enrollment_students s
  join public.agencies a on a.id = s.agency_id
  left join public.agents g on g.id = s.agent_id
  where (p_business is null or a.id = p_business) and (p_agent is null or s.agent_id = p_agent)
   and (coalesce(p_status, '') = '' or exists (select 1 from public.enrollment_applications e where e.student_id = s.id and e.status = p_status))
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', s.full_name, s.details ->> 'first_name', s.details ->> 'last_name', s.email, s.phone,
     s.passport_number, a.name, g.full_name,
     (select string_agg(coalesce(e.reference, ''), ' ') from public.enrollment_applications e where e.student_id = s.id))), w) = 0)
 ), filtered as (
  select * from base where (coalesce(p_student_status, '') = '' or student_status = p_student_status)
   and (coalesce(p_access, '') = '' or portal_access = p_access) and (coalesce(p_enrolment, '') = '' or enrolment->>'stage' = p_enrolment)
 ), page as (
  select * from filtered order by business_rank, last_updated desc nulls last, lower(full_name), id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from base), 'active', (select count(*) from base where student_status = 'Active'),
   'inactive', (select count(*) from base where student_status = 'Inactive'),
   -- Portal access counts within the enrolment filter; enrolment counts within the access filter.
   'access', (select jsonb_build_object('all', count(*), 'active', count(*) filter (where portal_access = 'active'), 'invited', count(*) filter (where portal_access = 'invited'),
     'not_invited', count(*) filter (where portal_access = 'not_invited'), 'disabled', count(*) filter (where portal_access = 'disabled'))
     from base where coalesce(p_enrolment, '') = '' or enrolment->>'stage' = p_enrolment),
   'enrolment', (select coalesce(jsonb_object_agg(x.stage, x.n), '{}'::jsonb) from (select enrolment->>'stage' stage, count(*) n from base
     where coalesce(p_access, '') = '' or portal_access = p_access group by 1) x)),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
   'id', p.id, 'name', p.full_name, 'email', p.email, 'phone', p.phone, 'nationality', p.nationality,
   'status', p.student_status, 'statusChangedAt', p.status_changed_at,
   'dateOfBirth', p.date_of_birth, 'passportNumber', p.passport_number,
   'createdAt', p.created_at, 'lastUpdated', p.last_updated,
   'agencyId', p.business_id, 'businessId', p.business_id, 'businessName', p.business_name, 'businessStatus', p.business_status,
   'agentId', p.agent_id, 'agentName', p.agent_name, 'portalAccess', p.portal_access, 'enrolment', p.enrolment,
   'applications', (select count(*) from public.enrollment_applications e where e.student_id = p.id),
   'statusCounts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) from
     (select e.status, count(*) n from public.enrollment_applications e where e.student_id = p.id group by e.status) x),
   'login', public.student_login_state(p.id), 'applicationRows', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'reference', coalesce(e.reference, ''), 'status', e.status, 'intake', coalesce(e.intake, ''), 'completion', public.application_completion(e.id),
      'updatedAt', e.updated_at, 'nextStatuses', public.application_next_statuses(e.id),
      'course', (select string_agg(c.course_code, ', ' order by c.course_code) from public.enrollment_application_courses c where c.application_id = e.id)
     ) order by e.updated_at desc), '[]'::jsonb)
     from (select * from public.enrollment_applications e2 where e2.student_id = p.id order by e2.updated_at desc limit 20) e)
  ) order by p.business_rank, p.last_updated desc nulls last, lower(p.full_name), p.id) from page p), '[]'::jsonb))
 into result;
 return result;
end $function$;
revoke all on function public.admin_students_list(text, text, uuid, uuid, integer, integer, text, text, text) from public, anon;
grant execute on function public.admin_students_list(text, text, uuid, uuid, integer, integer, text, text, text) to authenticated, service_role;
