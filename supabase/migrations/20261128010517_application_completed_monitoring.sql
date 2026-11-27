-- APPLICATION-FINISH + MONITORING (owner, 2026-11-27): an application finishes with its Qualification, and mismatches are watched.
--  1. New final application status "Completed" (application_statuses, sort 75, final). Set only by the Qualification: when the
--     application's last live Qualification is Completed, the application becomes Completed. A Completed application is locked
--     (no move by hand); an Admin undo of the Qualification takes it back to Active.
--  2. Gate 6: when an application has no live Qualification left after a cancellation, it becomes Withdrawn (note "Qualification
--     cancelled"). An Admin undo of the cancellation brings the application back (Active, or Enrolled for a Tentative one).
--  3. Gate 9: the daily job raises "Resume or extend" on the resume date of a Deferred / Suspended Qualification.
--  4. qualification_consistency_problems(): read-only list of every application / Qualification mismatch (dashboard card
--     "Applications out of step" via qualification_consistency()). No existing record is changed by this migration.

-- 1. The Completed application status.
insert into public.application_statuses(value, label, sort, tone, hint, editable, legacy, color, is_final, is_active)
values ('completed', 'Completed', 75, 'success', 'Finished: the Qualification is Completed', false, false, '#047857', true, true)
on conflict (value) do nothing;

-- Enrolled may be restored by the Qualification (undo of a cancelled Tentative Qualification).
create or replace function pg_temp.q_patch_finish(p_fn text, p_from text, p_to text) returns void language plpgsql as $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if position(p_from in coalesce(v_def, '')) = 0 then raise exception 'APPLICATION-FINISH patch: % does not contain %', p_fn, p_from; end if;
  execute overlay(v_def placing p_to from position(p_from in v_def) for char_length(p_from));
end $$;
select pg_temp.q_patch_finish('application_enrolled_guard', ' if new.status is distinct from ''enrolled'' then return new; end if;',
  ' if new.status is distinct from ''enrolled'' or coalesce(current_setting(''qualification.sync'', true), '''') = ''on'' then return new; end if;');

-- Moves of the application made by its Qualification (sync), with the note the application history shows.
create or replace function public.qualification_move_application(p_application uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_note text := current_setting('portal.status_note', true); v_cmd text := current_setting('portal.status_command', true);
begin
  perform set_config('qualification.sync', 'on', true);
  perform set_config('portal.status_note', left(p_note, 1000), true);
  -- the admissions guard (portal_protect_admission_state) accepts a status change made through a command for this application
  perform set_config('portal.status_command', p_application::text, true);
  update public.enrollment_applications set status = p_status where id = p_application and status is distinct from p_status;
  perform set_config('portal.status_command', coalesce(v_cmd, ''), true);
  perform set_config('portal.status_note', coalesce(v_note, ''), true);
  perform set_config('qualification.sync', '', true);
end $$;
revoke all on function public.qualification_move_application(uuid, text, text) from public, anon, authenticated;

-- The Enrolled -> Active sync (Re-add to intake, Mark as enrolled) goes through the same command.
create or replace function public.qualification_sync_application(p_application uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.enrollment_applications a where a.id = p_application and a.status = 'enrolled')
     and exists (select 1 from public.intake_enrolments e where e.application_id = p_application and e.status in ('active', 'deferred', 'suspended')) then
    perform public.qualification_move_application(p_application, 'active', 'Qualification In Progress');
  end if;
end $$;
revoke all on function public.qualification_sync_application(uuid) from public, anon, authenticated;

-- Gate 1 + the Completed lock: the Qualification's own moves (sync) pass; otherwise forward or end only, Completed only by the
-- Qualification and final.
create or replace function public.qualification_application_gate() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_live integer; v_started integer; v_from integer; v_to integer;
begin
  if new.status is not distinct from old.status then return new; end if;
  if coalesce(current_setting('qualification.sync', true), '') = 'on' then return new; end if;
  -- rule-policy: technical application-completed-final Completed is set by the Qualification and is final.
  if old.status = 'completed' then
    raise exception 'A Completed application is final: undo the Qualification''s Completed status instead (Admin).' using errcode = '23514';
  end if;
  if new.status = 'completed' then
    raise exception 'An application becomes Completed by itself when its Qualification is Completed.' using errcode = '23514';
  end if;
  select count(*), count(*) filter (where e.status <> 'tentative') into v_live, v_started
    from public.intake_enrolments e where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended');
  if v_live = 0 then return new; end if;
  -- rule-policy: technical qualification-gate-moves With a live Qualification the application only goes forward (application_statuses order) or ends (Withdrawn / Rejected).
  if new.status in ('withdrawn', 'rejected') then return new; end if;
  -- An undone "Mark as enrolled": cancel the Tentative Qualification it created, quietly.
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
  select coalesce((select s.sort from public.application_statuses s where s.value = old.status), 0),
         coalesce((select s.sort from public.application_statuses s where s.value = new.status), 0) into v_from, v_to;
  if v_to > v_from and new.status not in ('withdrawn', 'rejected') then return new; end if;
  raise exception 'This application has a live Qualification (%): cancel the Qualification first, or withdraw the application.',
    (select string_agg(distinct public.qualification_label(e.status), ', ') from public.intake_enrolments e
      where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended'))
    using errcode = '23514';
end $$;

-- AFTER INSERT / UPDATE OF status on the Qualification: history, tasks, and the application kept in step.
create or replace function public.qualification_status_after() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_eff date := coalesce(nullif(current_setting('qualification.effective_on', true), '')::date, public.course_intake_today());
  v_ev uuid := nullif(current_setting('qualification.evidence', true), '')::uuid;
  v_quiet boolean := coalesce(current_setting('qualification.quiet', true), '') = 'on';
  v_app public.enrollment_applications; v_other_live integer; v_other_open integer;
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
  if new.application_id is null or v_quiet then return null; end if;
  select * into v_app from public.enrollment_applications where id = new.application_id;
  if v_app.id is null then return null; end if;
  select count(*) filter (where e.status in ('tentative', 'active', 'deferred', 'suspended')),
         count(*) filter (where e.status in ('tentative', 'active', 'deferred', 'suspended', 'completed'))
    into v_other_live, v_other_open
    from public.intake_enrolments e where e.application_id = v_app.id and e.id <> new.id;
  -- rule-policy: technical application-follows-qualification The application follows its Qualification: started -> Active, finished -> Completed, all cancelled -> Withdrawn, undone -> back.
  if new.status = 'active' and v_app.status = 'enrolled' then
    perform public.qualification_move_application(v_app.id, 'active', 'Qualification In Progress');
  elsif new.status = 'completed' and v_other_live = 0 and v_app.status in ('enrolled', 'active') then
    perform public.qualification_move_application(v_app.id, 'completed', 'Qualification Completed');
  elsif new.status = 'withdrawn' and v_other_live = 0 and v_app.status not in ('withdrawn', 'rejected', 'completed') then
    if v_other_open > 0 then
      perform public.qualification_move_application(v_app.id, 'completed', 'Qualification cancelled; the other Qualification is Completed');
    else
      perform public.qualification_move_application(v_app.id, 'withdrawn', 'Qualification cancelled');
    end if;
  elsif tg_op = 'UPDATE' and old.status in ('withdrawn', 'completed') and new.status in ('tentative', 'active', 'deferred', 'suspended')
        and v_app.status in ('withdrawn', 'rejected', 'completed') then
    perform public.qualification_move_application(v_app.id, case when new.status = 'tentative' then 'enrolled' else 'active' end,
      'Qualification ' || public.qualification_label(old.status) || ' undone');
  end if;
  return null;
end $$;

-- 3. Gate 9: "Resume or extend" on the resume date.
alter table public.qualification_tasks drop constraint if exists qualification_tasks_kind_check;
alter table public.qualification_tasks add constraint qualification_tasks_kind_check check (kind in ('place_manually', 'prisms_report', 'refund_check', 'resume_check'));

create or replace function public.qualification_daily() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_started integer; v_noshow integer := 0; v_resume integer := 0; r record;
  -- rule-policy: technical qualification-no-show-days Days after the course start without attendance before a no-show is raised (owner to confirm).
  v_days integer := 7;
begin
  v_started := public.qualification_start_due(null);
  for r in select e.* from public.intake_enrolments e
            where e.status = 'active' and e.enrolment_type = 'CoE' and e.archived_at is null
              and coalesce(e.course_start_date, e.enrolled_on) + v_days <= public.course_intake_today()
              and coalesce(e.course_start_date, e.enrolled_on) > public.course_intake_today() - 60
              and not exists (select 1 from public.lms_attendance_marks m where m.enrolment_id = e.id and m.status in ('present', 'late'))
              and not exists (select 1 from public.qualification_tasks t where t.enrolment_id = e.id and t.kind = 'prisms_report' and t.event = 'no_show') loop
    perform public.qualification_open_task('prisms_report', 'no_show', r.id, r.application_id, r.student_id, 'Report in PRISMS within 14 days',
      'No-show: no attendance marked present or late by ' || to_char(coalesce(r.course_start_date, r.enrolled_on) + v_days, 'DD/MM/YYYY') || '.',
      public.course_intake_today() + 14);
    v_noshow := v_noshow + 1;
  end loop;
  -- Gate 9: the resume date has come for a Deferred / Suspended Qualification (one task per resume date).
  for r in select e.* from public.intake_enrolments e
            where e.status in ('deferred', 'suspended') and e.resume_date <= public.course_intake_today() and e.archived_at is null
              and not exists (select 1 from public.qualification_tasks t where t.enrolment_id = e.id and t.kind = 'resume_check' and t.event = 'resume:' || e.resume_date) loop
    perform public.qualification_open_task('resume_check', 'resume:' || r.resume_date, r.id, r.application_id, r.student_id, 'Resume or extend',
      'The Qualification is ' || public.qualification_label(r.status) || ' with resume date ' || to_char(r.resume_date, 'DD/MM/YYYY')
        || ': move it back to In Progress, or extend the resume date.', public.course_intake_today());
    v_resume := v_resume + 1;
  end loop;
  return jsonb_build_object('started', v_started, 'noShows', v_noshow, 'resumeChecks', v_resume);
end $$;
revoke all on function public.qualification_daily() from public, anon, authenticated;

-- 4. Read-only consistency check: every application / Qualification mismatch.
create or replace function public.qualification_consistency_problems()
returns table(code text, title text, detail text, application_id uuid, enrolment_id uuid, student_id uuid, since timestamptz)
language sql stable security definer set search_path to 'public' as $$
  with live as (select * from public.intake_enrolments where status in ('tentative', 'active', 'deferred', 'suspended')),
  apps as (select a.*, (select max(h.created_at) from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = a.status) as status_at
           from public.enrollment_applications a where coalesce(a.is_test, false) = false)
  select 'APP-ACTIVE-NO-QUAL', 'Application Active with no Qualification in progress', coalesce(a.reference, 'Application'), a.id, null::uuid, a.student_id, a.status_at
    from apps a where a.status = 'active' and not exists (select 1 from public.intake_enrolments e where e.application_id = a.id and e.status in ('active', 'deferred', 'suspended'))
  union all
  select 'APP-ENROLLED-STARTED', 'Application Enrolled but its Qualification has started', coalesce(a.reference, 'Application'), a.id, e.id, a.student_id, a.status_at
    from apps a join public.intake_enrolments e on e.application_id = a.id and e.status = 'active' where a.status = 'enrolled'
  union all
  -- rule-policy: technical consistency-enrolled-days An application Enrolled for 3 days with nothing placed is flagged (owner 2026-11-27).
  select 'APP-ENROLLED-NOT-PLACED', 'Application Enrolled for 3+ days with no Qualification', coalesce(a.reference, 'Application'), a.id, null, a.student_id, a.status_at
    from apps a where a.status = 'enrolled' and coalesce(a.status_at, a.updated_at) < now() - interval '3 days'
     and not exists (select 1 from live e where e.application_id = a.id)
  union all
  select 'APP-COMPLETED-NOT-DONE', 'Application Completed but its Qualification is not', coalesce(a.reference, 'Application'), a.id, null, a.student_id, a.status_at
    from apps a where a.status = 'completed' and not exists (select 1 from public.intake_enrolments e where e.application_id = a.id and e.status = 'completed')
  union all
  select 'QUAL-DONE-APP-OPEN', 'Qualification Completed but the application is still open', public.qualification_label(e.status) || ' · ' || coalesce(a.reference, 'Application'), a.id, e.id, e.student_id, e.status_changed_at
    from public.intake_enrolments e join apps a on a.id = e.application_id
   where e.status = 'completed' and a.status in ('enrolled', 'active') and not exists (select 1 from live x where x.application_id = a.id)
  union all
  select 'QUAL-LIVE-APP-CLOSED', 'Qualification live but its application is closed', public.qualification_label(e.status) || ' · ' || coalesce(a.reference, 'Application') || ' ' || public.portal_status_label(a.status), a.id, e.id, e.student_id, e.status_changed_at
    from live e join apps a on a.id = e.application_id where a.status in ('withdrawn', 'rejected', 'completed')
  union all
  select 'QUAL-NO-APP', 'Qualification live with no application', public.qualification_label(e.status) || ' · placed by hand', null, e.id, e.student_id, e.status_changed_at
    from live e where e.application_id is null and e.archived_at is null
  union all
  select 'QUAL-TENTATIVE-LATE', 'Qualification still Tentative after its start date', 'Start ' || to_char(coalesce(e.course_start_date, e.enrolled_on), 'DD/MM/YYYY'), e.application_id, e.id, e.student_id, e.status_changed_at
    from live e where e.status = 'tentative' and coalesce(e.course_start_date, e.enrolled_on) < public.course_intake_today()
  union all
  select 'QUAL-RESUME-PASSED', 'Resume date passed', public.qualification_label(e.status) || ' · resume ' || to_char(e.resume_date, 'DD/MM/YYYY'), e.application_id, e.id, e.student_id, e.status_changed_at
    from live e where e.status in ('deferred', 'suspended') and e.resume_date < public.course_intake_today();
$$;
revoke all on function public.qualification_consistency_problems() from public, anon, authenticated;

-- Dashboard card "Applications out of step" (staff).
create or replace function public.qualification_consistency() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return jsonb_build_object('count', (select count(*) from public.qualification_consistency_problems()),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', coalesce(p.enrolment_id, p.application_id)::text || ':' || p.code,
        'title', p.title || coalesce(' · ' || s.full_name, ''), 'detail', p.detail, 'at', p.since,
        'to', case when p.enrolment_id is not null then '/admin/qualifications/' || p.enrolment_id
                   when p.application_id is not null then '/admin/applications/' || p.application_id else '/admin/qualifications' end)
        order by p.since nulls last), '[]'::jsonb)
      from (select * from public.qualification_consistency_problems() limit 8) p left join public.enrollment_students s on s.id = p.student_id));
end $$;
grant execute on function public.qualification_consistency() to authenticated;
