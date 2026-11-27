-- QUALIFICATION-GATES (owner, 2026-11-27): no orphan statuses between an application and its Qualification (gates 1-4).
--  1. Once an application has a live Qualification (Tentative, In Progress, Deferred, Suspended), the application can only move to
--     Active (set by the Qualification), Withdrawn or Rejected; Enrolled only while every live Qualification is still Tentative.
--     Any other move (back to Draft, Submitted, Offer..., CoE issued) is refused: "cancel the Qualification first".
--  2. Undo of "Mark as enrolled" (portal.status_note 'Undone:%', Enrolled -> earlier status): the Tentative Qualification it made is
--     cancelled with reason "Enrolment undone" and without PRISMS / refund tasks (nothing was reported); refused once it has started.
--  3. Application Withdrawn or Rejected (from any status): its own Qualifications (application_id) are always cancelled; placements
--     without an application link keep the earlier rule (same student and course, admissions.withdrawal_class_removal).
--  4. Application Active needs a Qualification of this application (application_id) In Progress, Deferred or Suspended.

-- 2. A quiet cancellation (undone enrolment) raises no PRISMS or refund task.
create or replace function public.qualification_status_after() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_eff date := coalesce(nullif(current_setting('qualification.effective_on', true), '')::date, public.course_intake_today());
  v_ev uuid := nullif(current_setting('qualification.evidence', true), '')::uuid;
  v_quiet boolean := coalesce(current_setting('qualification.quiet', true), '') = 'on';
  v_app public.enrollment_applications;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, note, evidence_document_id, effective_on, changed_by, changed_by_name)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.status_reason, new.status_note, v_ev,
    case when new.status = 'withdrawn' then coalesce(new.withdrawn_on, v_eff) else v_eff end, auth.uid(), public.qualification_actor_name());
  -- rule-policy: regulatory qualification-prisms-14-days A CoE student who defers, is suspended or cancelled is reported in PRISMS within 14 days (ESOS Act 2000 s19 / National Code 2018 Standard 9, https://www.legislation.gov.au/C2004A00757/latest/text)
  if tg_op = 'UPDATE' and not v_quiet and new.enrolment_type = 'CoE' and new.status in ('deferred', 'suspended', 'withdrawn') then
    perform public.qualification_open_task('prisms_report', new.status, new.id, new.application_id, new.student_id,
      'Report in PRISMS within 14 days', 'Qualification ' || public.qualification_label(new.status) || coalesce(': ' || new.status_reason, '') || '.',
      v_eff + 14);
  end if;
  if tg_op = 'UPDATE' and not v_quiet and new.status = 'withdrawn' then
    perform public.qualification_open_task('refund_check', 'withdrawn', new.id, new.application_id, new.student_id,
      'Check for a refund', 'Qualification Cancelled' || coalesce(': ' || new.status_reason, '') || '. Check the fees paid and any refund owed.', v_eff + 14);
  end if;
  -- In Progress: the application moves to Active (only from Enrolled, the proper path).
  if new.status = 'active' and new.application_id is not null then
    select * into v_app from public.enrollment_applications where id = new.application_id;
    -- rule-policy: technical qualification-app-active The application becomes Active from Enrolled when its Qualification starts.
    if v_app.status = 'enrolled' then
      perform set_config('qualification.sync', 'on', true);
      update public.enrollment_applications set status = 'active' where id = v_app.id;
      perform set_config('qualification.sync', '', true);
    end if;
  end if;
  return null;
end $$;

-- 1 + 2. BEFORE UPDATE OF status on the application (named to run before the other a0_ guards).
create or replace function public.qualification_application_gate() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_live integer; v_started integer;
begin
  if new.status is not distinct from old.status then return new; end if;
  select count(*), count(*) filter (where e.status <> 'tentative') into v_live, v_started
    from public.intake_enrolments e where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended');
  if v_live = 0 then return new; end if;
  -- rule-policy: technical qualification-gate-moves With a live Qualification the application only goes on (Active) or ends (Withdrawn / Rejected).
  if new.status in ('active', 'withdrawn', 'rejected') then return new; end if;
  if new.status = 'enrolled' and v_started = 0 then return new; end if;
  -- 2. An undone "Mark as enrolled": cancel the Tentative Qualification it created, quietly.
  if old.status = 'enrolled' and coalesce(current_setting('portal.status_note', true), '') like 'Undone:%' and v_started = 0 then
    perform set_config('qualification.system', 'on', true);
    perform set_config('qualification.quiet', 'on', true);
    perform set_config('qualification.reason', 'Enrolment undone', true);
    update public.intake_enrolments set status = 'withdrawn', withdrawn_on = coalesce(withdrawn_on, public.course_intake_today())
     where application_id = new.id and status = 'tentative';
    perform set_config('qualification.reason', '', true);
    perform set_config('qualification.quiet', '', true);
    perform set_config('qualification.system', '', true);
    return new;
  end if;
  raise exception 'This application has a live Qualification (%): cancel the Qualification first, or withdraw the application.',
    (select string_agg(distinct public.qualification_label(e.status), ', ') from public.intake_enrolments e
      where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended'))
    using errcode = '23514';
end $$;
revoke all on function public.qualification_application_gate() from public, anon, authenticated;
drop trigger if exists a00_qualification_application_gate on public.enrollment_applications;
create trigger a00_qualification_application_gate before update of status on public.enrollment_applications
  for each row execute function public.qualification_application_gate();

-- 3. Withdrawn / Rejected: this application's Qualifications always; unlinked placements by the earlier rule.
create or replace function public.rto_application_placement() returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
 if new.status in ('withdrawn', 'rejected') and old.status is distinct from new.status then
  perform set_config('qualification.reason', 'Application ' || public.portal_status_label(new.status), true);
  update public.intake_enrolments e set status = 'withdrawn', withdrawn_on = coalesce(e.withdrawn_on, public.course_intake_today())
  where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended');
  -- rule-policy: technical qualification-unlinked-cascade Placements made before Qualifications (no application link) keep the earlier removal rule.
  if public.rule_text('admissions.withdrawal_class_removal', 'Remove from classes automatically') = 'Remove from classes automatically' and old.status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled'])) then
   update public.intake_enrolments e set status = 'withdrawn', withdrawn_on = coalesce(e.withdrawn_on, public.course_intake_today())
   where e.application_id is null and e.student_id = new.student_id and e.status in ('tentative', 'active', 'deferred', 'suspended')
    and e.intake_id in (select ci.id from public.course_intakes ci
     where ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id));
  end if;
  perform set_config('qualification.reason', '', true);
 end if;
 return new;
end $function$;

-- 4. Active only with this application's own Qualification In Progress, Deferred or Suspended.
create or replace function public.application_active_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if coalesce(current_setting('qualification.sync', true), '') <> 'on' then
      raise exception 'An application becomes Active by itself when its Qualification moves to In Progress (course start date).' using errcode = '22023';
    end if;
    -- rule-policy: technical qualification-gate-active Active needs this application's own Qualification (In Progress, Deferred or Suspended).
    if tg_op = 'INSERT' or not exists (select 1 from public.intake_enrolments e where e.application_id = new.id and e.status in ('active', 'deferred', 'suspended')) then
      raise exception 'This application has no Qualification In Progress: it becomes Active only when its own Qualification starts.' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
