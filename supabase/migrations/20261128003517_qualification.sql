-- QUALIFICATION (owner, 2026-11-27): the student's course enrolment record (public.intake_enrolments) is the "Qualification".
-- No new record table and no renamed status values (about 75 functions read them). This migration adds:
--  1. two statuses: tentative (placed, course not started) and suspended; screens label them (qualification_label):
--     tentative Tentative, active In Progress, deferred Deferred, suspended Suspended, withdrawn Cancelled, completed Completed.
--  2. the allowed moves, enforced by trigger a1_qualification_status (qualification_move_allowed):
--     tentative -> active (automatic on course_start_date), deferred, withdrawn; active -> deferred, suspended, withdrawn, completed;
--     deferred / suspended -> active, withdrawn; completed / withdrawn are final (Admin undo with a reason: qualification_undo).
--     The placement path (rto_auto_placing: Re-add to intake, enrol from an application) may bring a row back to active / tentative,
--     carry-over planning keeps its own moves, a revoked certificate goes back to active as an undo. The withdrawal trigger stays.
--  3. status_reason, status_note, resume_date (required for deferred / suspended), status_changed_at; the append-only history
--     public.intake_enrolment_status_history (from, to, reason, note, evidence document, effective date, who, when);
--     reasons in public.qualification_status_reasons (status_reasons is tied to application statuses by a foreign key).
--  4. application_id, coe_number / voe_number and coe_document_id (enrollment_coe_documents).
--  5. an application moved to Enrolled creates its Qualification through the placement path (rto_place_core, the body of
--     rto_staff_place without the staff checks: seats, groups, master timetable and the clash rule apply) as tentative; when that
--     fails a "Place student manually" task is created instead and the status change goes through. Qualification In Progress sets
--     the application to Active (application_active_guard refuses Active by hand from now on). Re-add to intake keeps working.
--  6. on creation: study reason from the application answers; the student's empty personal fields filled from the application's
--     answers (filled and differing fields written to the Qualification history note); the application is not changed.
--  7. documents on the Qualification (public.intake_enrolment_documents, file content stored in the row like CoE / offer PDFs):
--     a copy of the CoE / VoE and of the signed offer, copies of the application's documents (copied by staff screens from storage:
--     copy_state pending until then), later evidence and certificates.
--  8. tasks (public.qualification_tasks): "Report in PRISMS within 14 days" for CoE students who are deferred, suspended, cancelled or
--     did not show by course start, closed with the PRISMS reference; "Check for a refund" on cancellation; "Place student manually".
--  9. Completed only when every unit of the intake has a result (assessment sign-off in asm_unit_outcomes or a final AVETMISS outcome
--     in lms_unit_students).
-- 10. deferred / suspended: no attendance or class lists (assessments already follow active only); cancelled ends study access.
-- 11. read / change functions for the screens (qualification_*), portal_qualifications for students and agents (no reasons or notes).
-- Daily: qualification_daily() (cron qualification-daily) starts tentative Qualifications on their start date and raises no-show tasks.

-- ---------------------------------------------------------------- 1. statuses
alter table public.intake_enrolments drop constraint if exists batch_enrolments_status_check;
alter table public.intake_enrolments drop constraint if exists intake_enrolments_status_check;
alter table public.intake_enrolments add constraint intake_enrolments_status_check
  check (status = any (array['tentative', 'active', 'deferred', 'suspended', 'withdrawn', 'completed']));

-- ---------------------------------------------------------------- 3 / 4. columns
alter table public.intake_enrolments
  add column if not exists status_reason text,
  add column if not exists status_note text,
  add column if not exists resume_date date,
  add column if not exists status_changed_at timestamptz not null default now(),
  add column if not exists application_id uuid references public.enrollment_applications(id) on delete set null,
  add column if not exists coe_number text,
  add column if not exists voe_number text,
  add column if not exists coe_document_id uuid references public.enrollment_coe_documents(id) on delete set null;
alter table public.intake_enrolments drop constraint if exists intake_enrolments_status_text_check;
alter table public.intake_enrolments add constraint intake_enrolments_status_text_check check (
  (status_reason is null or char_length(status_reason) between 1 and 200)
  and (status_note is null or char_length(status_note) <= 2000)
  and (coe_number is null or char_length(btrim(coe_number)) between 1 and 60)
  and (voe_number is null or char_length(btrim(voe_number)) between 1 and 60));
create index if not exists intake_enrolments_application_idx on public.intake_enrolments(application_id) where application_id is not null;
create index if not exists intake_enrolments_status_idx on public.intake_enrolments(status);
comment on column public.intake_enrolments.status is 'Qualification status: tentative, active (In Progress), deferred, suspended, withdrawn (Cancelled), completed. Moves: qualification_move_allowed.';
comment on column public.intake_enrolments.resume_date is 'Qualification: the day a deferred or suspended student is expected back (required for those statuses).';
comment on column public.intake_enrolments.application_id is 'Qualification: the application it was created from (Enrolled), null for a manual placement.';

-- Reasons for a Qualification status (staff choose one; "Other" needs the note).
create table if not exists public.qualification_status_reasons (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('deferred', 'suspended', 'withdrawn', 'undo')),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  sort integer not null default 0,
  is_other boolean not null default false,
  is_active boolean not null default true,
  unique (status, label)
);
insert into public.qualification_status_reasons(status, label, sort, is_other) values
  ('deferred', 'Student request', 1, false), ('deferred', 'Medical or compassionate', 2, false), ('deferred', 'Visa delay', 3, false), ('deferred', 'Other', 9, true),
  ('suspended', 'Compassionate or compelling circumstances', 1, false), ('suspended', 'Misconduct', 2, false), ('suspended', 'Unpaid fees', 3, false), ('suspended', 'Other', 9, true),
  ('withdrawn', 'Student request', 1, false), ('withdrawn', 'Visa refused or cancelled', 2, false), ('withdrawn', 'Did not start (no-show)', 3, false),
  ('withdrawn', 'Unsatisfactory progress or attendance', 4, false), ('withdrawn', 'Unpaid fees', 5, false), ('withdrawn', 'Transferred to another provider', 6, false), ('withdrawn', 'Other', 9, true),
  ('undo', 'Recorded by mistake', 1, false), ('undo', 'Other', 9, true)
on conflict (status, label) do nothing;

-- Documents of a Qualification (copies, never shared with the application).
create table if not exists public.intake_enrolment_documents (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.intake_enrolments(id) on delete cascade,
  kind text not null check (kind in ('coe', 'voe', 'signed_offer', 'application_document', 'evidence', 'certificate', 'other')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  file_name text check (file_name is null or char_length(file_name) <= 255),
  mime_type text,
  size_bytes integer,
  sha256 text,
  content bytea check (content is null or octet_length(content) <= 26214400),
  copy_state text not null default 'copied' check (copy_state in ('copied', 'pending', 'failed')),
  source_table text,
  source_id uuid,
  source_bucket text,
  source_path text,
  student_visible boolean not null default true,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (copy_state <> 'copied' or content is not null)
);
create index if not exists intake_enrolment_documents_enrolment_idx on public.intake_enrolment_documents(enrolment_id);
create unique index if not exists intake_enrolment_documents_source_key on public.intake_enrolment_documents(enrolment_id, source_table, source_id) where source_id is not null;

-- Append-only status history.
create table if not exists public.intake_enrolment_status_history (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.intake_enrolments(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  note text,
  evidence_document_id uuid references public.intake_enrolment_documents(id) on delete set null,
  effective_on date not null,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz not null default now()
);
create index if not exists intake_enrolment_status_history_enrolment_idx on public.intake_enrolment_status_history(enrolment_id, changed_at);

-- Staff tasks raised by Qualifications.
create table if not exists public.qualification_tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('place_manually', 'prisms_report', 'refund_check')),
  event text,
  enrolment_id uuid references public.intake_enrolments(id) on delete cascade,
  application_id uuid references public.enrollment_applications(id) on delete cascade,
  student_id uuid references public.enrollment_students(id) on delete cascade,
  title text not null,
  detail text,
  due_on date,
  status text not null default 'open' check (status in ('open', 'done')),
  prisms_reference text check (prisms_reference is null or char_length(btrim(prisms_reference)) between 1 and 60),
  closed_note text check (closed_note is null or char_length(closed_note) <= 1000),
  closed_by uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check (status = 'open' or closed_at is not null),
  check (kind <> 'prisms_report' or status = 'open' or prisms_reference is not null)
);
create unique index if not exists qualification_tasks_open_key on public.qualification_tasks(kind, coalesce(event, ''), coalesce(enrolment_id, application_id)) where status = 'open';
create index if not exists qualification_tasks_status_idx on public.qualification_tasks(status, due_on);

alter table public.qualification_status_reasons enable row level security;
alter table public.intake_enrolment_documents enable row level security;
alter table public.intake_enrolment_status_history enable row level security;
alter table public.qualification_tasks enable row level security;
drop policy if exists qualification_reasons_read on public.qualification_status_reasons;
create policy qualification_reasons_read on public.qualification_status_reasons for select to authenticated using (public.cms_is_staff());
drop policy if exists qualification_documents_staff_read on public.intake_enrolment_documents;
create policy qualification_documents_staff_read on public.intake_enrolment_documents for select to authenticated using (public.cms_is_staff());
drop policy if exists qualification_history_staff_read on public.intake_enrolment_status_history;
create policy qualification_history_staff_read on public.intake_enrolment_status_history for select to authenticated using (public.cms_is_staff());
drop policy if exists qualification_tasks_staff_read on public.qualification_tasks;
create policy qualification_tasks_staff_read on public.qualification_tasks for select to authenticated using (public.cms_is_staff());
revoke insert, update, delete on public.qualification_status_reasons, public.intake_enrolment_documents, public.intake_enrolment_status_history, public.qualification_tasks from anon, authenticated;
grant select on public.qualification_status_reasons, public.intake_enrolment_documents, public.intake_enrolment_status_history, public.qualification_tasks to authenticated;

-- History is append-only: no update; a delete only follows its Qualification being deleted (test data purge).
create or replace function public.intake_enrolment_history_append_only() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'UPDATE' then raise exception 'Qualification history cannot be changed.' using errcode = '42501'; end if;
  if exists (select 1 from public.intake_enrolments e where e.id = old.enrolment_id) then
    raise exception 'Qualification history cannot be deleted.' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists intake_enrolment_history_append_only on public.intake_enrolment_status_history;
create trigger intake_enrolment_history_append_only before update or delete on public.intake_enrolment_status_history
  for each row execute function public.intake_enrolment_history_append_only();

-- ---------------------------------------------------------------- 2. labels and moves
create or replace function public.qualification_label(p_status text) returns text language sql immutable as $$
  select case p_status when 'tentative' then 'Tentative' when 'active' then 'In Progress' when 'deferred' then 'Deferred'
    when 'suspended' then 'Suspended' when 'withdrawn' then 'Cancelled' when 'completed' then 'Completed' else coalesce(p_status, '') end;
$$;

create or replace function public.qualification_moves(p_from text) returns text[] language sql immutable as $$
  -- rule-policy: technical qualification-moves The Qualification status machine as the owner specified it (2026-11-27).
  select case p_from
    when 'tentative' then array['active', 'deferred', 'withdrawn']
    when 'active' then array['deferred', 'suspended', 'withdrawn', 'completed']
    when 'deferred' then array['active', 'withdrawn']
    when 'suspended' then array['active', 'withdrawn']
    else array[]::text[] end;
$$;

create or replace function public.qualification_move_allowed(p_from text, p_to text) returns boolean language sql immutable as $$
  select p_from is not distinct from p_to or p_to = any(public.qualification_moves(p_from));
$$;

-- Units of a Qualification with their result: the assessment sign-off (asm_unit_outcomes, latest not superseded) or the AVETMISS
-- outcome in lms_unit_students when it is final (not 70 continuing / 85 not yet started / 90 not known).
create or replace function public.qualification_units(p_enrolment uuid)
returns table(unit_id text, code text, name text, start_date date, end_date date, assessment text, assessment_on date, avetmiss_outcome text, has_result boolean)
language sql stable security definer set search_path to 'public' as $$
  select u.id, u.code, u.name, iu.start_date, iu.end_date, o.outcome, (o.signed_at at time zone public.institution_tz())::date, l.outcome_code,
    -- rule-policy: regulatory qualification-final-outcome AVETMISS outcome identifiers 70 / 85 / 90 are not final results (NCVER AVETMISS VET Provider Collection Specifications 8.0, https://www.ncver.edu.au/rto-hub/avetmiss-for-vet-providers)
    (o.outcome is not null or (l.outcome_code is not null and l.outcome_code not in ('70', '85', '90')))
  from public.intake_enrolments e
  join public.intake_units iu on iu.intake_id = e.intake_id
  join public.cms_course_units u on u.id = iu.unit_id
  left join lateral (select x.outcome, x.signed_at from public.asm_unit_outcomes x
    where x.student_id = e.student_id and x.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = x.id)
    order by x.signed_at desc limit 1) o on true
  left join lateral (select s.outcome_code from public.lms_unit_students s where s.student_id = e.student_id and s.unit_id = u.id
    order by (s.intake_id = e.intake_id) desc, s.outcome_recorded_at desc nulls last limit 1) l on true
  where e.id = p_enrolment
  order by iu.start_date nulls last, iu.sort, u.sort;
$$;

-- BEFORE INSERT / UPDATE: the allowed moves, the required fields of a status, the reason and note of this change.
create or replace function public.qualification_status_guard() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_new text := nullif(current_setting('qualification.new_status', true), '');
  v_system boolean := public.rto_auto_placing() or coalesce(current_setting('rto.carry_over_planning', true), '') = 'on'
    or coalesce(current_setting('qualification.system', true), '') = 'on';
  v_undo boolean := coalesce(current_setting('qualification.undo', true), '') = 'on';
  v_eff date := coalesce(nullif(current_setting('qualification.effective_on', true), '')::date, public.course_intake_today());
  v_missing integer;
begin
  -- rule-policy: technical qualification-new-status The enrol-from-application path creates the Qualification as tentative.
  if v_new is not null and public.rto_auto_placing() and (tg_op = 'INSERT' or new.status = 'active') then new.status := v_new; end if;
  if tg_op = 'INSERT' then
    -- rule-policy: technical qualification-first-status A Qualification starts as Tentative or In Progress.
    if new.status not in ('tentative', 'active') and not v_system then
      raise exception 'A Qualification starts as Tentative or In Progress, not %.', public.qualification_label(new.status) using errcode = '23514';
    end if;
    new.status_reason := nullif(btrim(coalesce(nullif(current_setting('qualification.reason', true), ''), new.status_reason, '')), '');
    new.status_changed_at := now();
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if not public.qualification_move_allowed(old.status, new.status) then
    -- Undo (Admin, with a reason), the placement path bringing a student back, and carry-over planning are the only other ways.
    if not (v_undo or (public.rto_auto_placing() and new.status in ('active', 'tentative'))
            or coalesce(current_setting('rto.carry_over_planning', true), '') = 'on') then
      raise exception 'A Qualification cannot move from % to %.', public.qualification_label(old.status), public.qualification_label(new.status)
        using errcode = '23514';
    end if;
  end if;
  -- rule-policy: technical qualification-resume-date Deferred and Suspended need the day the student is expected back.
  if new.status in ('deferred', 'suspended') then
    if new.resume_date is null then
      raise exception 'Enter the resume date: a % Qualification needs the day the student is expected back.', public.qualification_label(new.status) using errcode = '23514';
    end if;
  else
    new.resume_date := null;
  end if;
  -- rule-policy: technical qualification-complete-units Completed needs a result for every unit of the intake.
  if new.status = 'completed' then
    select count(*) filter (where not u.has_result) into v_missing from public.qualification_units(new.id) u;
    if v_missing is null or v_missing > 0 or not exists (select 1 from public.qualification_units(new.id)) then
      raise exception 'A Qualification is Completed only when every unit has a result (% without one).', coalesce(v_missing, 0) using errcode = '23514';
    end if;
  end if;
  -- System moves (placement, archive, application withdrawn) record the day they happen as the withdrawal date.
  if new.status = 'withdrawn' and new.withdrawn_on is null and (v_system or v_undo or coalesce(current_setting('qualification.effective_on', true), '') <> '') then
    new.withdrawn_on := v_eff;
  end if;
  new.status_reason := nullif(btrim(coalesce(nullif(current_setting('qualification.reason', true), ''), case when new.status_reason is distinct from old.status_reason then new.status_reason end, '')), '');
  new.status_note := nullif(btrim(coalesce(nullif(current_setting('qualification.note', true), ''), case when new.status_note is distinct from old.status_note then new.status_note end, '')), '');
  new.status_changed_at := now();
  return new;
end $$;
drop trigger if exists a1_qualification_status on public.intake_enrolments;
create trigger a1_qualification_status before insert or update of status on public.intake_enrolments
  for each row execute function public.qualification_status_guard();

-- Staff name for the history.
create or replace function public.qualification_actor_name() returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce((select u.name from public.cms_users u where u.auth_user_id = auth.uid() limit 1),
    case when auth.uid() is null then 'System' else '' end);
$$;

create or replace function public.qualification_open_task(p_kind text, p_event text, p_enrolment uuid, p_application uuid, p_student uuid, p_title text, p_detail text, p_due date)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  select t.id into v_id from public.qualification_tasks t where t.status = 'open' and t.kind = p_kind and coalesce(t.event, '') = coalesce(p_event, '')
    and coalesce(t.enrolment_id, t.application_id) is not distinct from coalesce(p_enrolment, p_application);
  if v_id is not null then return v_id; end if;
  insert into public.qualification_tasks(kind, event, enrolment_id, application_id, student_id, title, detail, due_on)
  values (p_kind, p_event, p_enrolment, p_application, p_student, p_title, left(p_detail, 2000), p_due) returning id into v_id;
  return v_id;
end $$;

-- AFTER INSERT / UPDATE OF status: history row, PRISMS and refund tasks, the application set to Active.
create or replace function public.qualification_status_after() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_eff date := coalesce(nullif(current_setting('qualification.effective_on', true), '')::date, public.course_intake_today());
  v_ev uuid := nullif(current_setting('qualification.evidence', true), '')::uuid;
  v_app public.enrollment_applications;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, note, evidence_document_id, effective_on, changed_by, changed_by_name)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.status_reason, new.status_note, v_ev,
    case when new.status = 'withdrawn' then coalesce(new.withdrawn_on, v_eff) else v_eff end, auth.uid(), public.qualification_actor_name());
  -- rule-policy: regulatory qualification-prisms-14-days A CoE student who defers, is suspended or cancelled is reported in PRISMS within 14 days (ESOS Act 2000 s19 / National Code 2018 Standard 9, https://www.legislation.gov.au/C2004A00757/latest/text)
  if tg_op = 'UPDATE' and new.enrolment_type = 'CoE' and new.status in ('deferred', 'suspended', 'withdrawn') then
    perform public.qualification_open_task('prisms_report', new.status, new.id, new.application_id, new.student_id,
      'Report in PRISMS within 14 days', 'Qualification ' || public.qualification_label(new.status) || coalesce(': ' || new.status_reason, '') || '.',
      v_eff + 14);
  end if;
  if tg_op = 'UPDATE' and new.status = 'withdrawn' then
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
drop trigger if exists qualification_status_after on public.intake_enrolments;
create trigger qualification_status_after after insert or update of status on public.intake_enrolments
  for each row execute function public.qualification_status_after();

-- ---------------------------------------------------------------- 5. placement core and the enrolled application
create or replace function public.rto_place_core(p_batch uuid, p_student uuid, p_type text, p_on date)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid; v_master boolean;
begin
 select * into i from public.course_intakes where id = p_batch;
 if i.id is null or not public.intake_has_group(i.id) then raise exception 'Choose an active intake.' using errcode = '22023'; end if;
 if public.rule_text('lms.intake_manual_join_window', 'Between intake start and end, inclusive') <> 'Any date' and v_on < i.start_date then raise exception 'The student cannot join before the intake starts (%).', i.start_date using errcode = '22023'; end if;
 if public.rule_text('lms.intake_manual_join_window', 'Between intake start and end, inclusive') <> 'Any date' and i.end_date is not null and v_on > i.end_date then raise exception 'The student cannot join after the intake ends (%).', i.end_date using errcode = '22023'; end if;
 if not public.rto_student_on_course(p_student, i.course_id) then perform public.rto_direct_application(p_student, i.id); end if;
 v_master := exists (select 1 from public.course_coe_timetables t where t.course_id = i.course_id);
 perform set_config('rto.auto_place', 'on', true);
 if v_master then
  v_enrol := public.rto_batch_assign(p_student, i.course_id, i.id, coalesce(nullif(p_type, ''), public.rule_text('lms.manual_placement_default_type', 'CoE')), v_on);
 else
  insert into public.intake_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on)
  values (i.id, p_student, coalesce(nullif(p_type, ''), public.rule_text('lms.manual_placement_default_type', 'CoE')), 'active', v_on)
  on conflict (intake_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type, enrolled_on = excluded.enrolled_on
  returning id into v_enrol;
 end if;
 perform set_config('rto.auto_place', 'off', true);
 return v_enrol;
end $function$;
revoke all on function public.rto_place_core(uuid, uuid, text, date) from public, anon, authenticated;

create or replace function public.rto_staff_place(p_batch uuid, p_student uuid, p_type text, p_on date, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can place a student by hand.' using errcode = '42501'; end if;
 if public.rule_bool('lms.intake_manual_placement_reason', true) and coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are placing this student by hand.' using errcode = '22023'; end if;
 perform set_config('qualification.reason', left(coalesce(nullif(btrim(p_reason), ''), 'Placed by hand'), 200), true);
 v_enrol := public.rto_place_core(p_batch, p_student, p_type, v_on);
 perform set_config('qualification.reason', '', true);
 select * into i from public.course_intakes where id = p_batch;
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason, detail)
 values (p_student, i.course_id, i.id, v_enrol, 'place', coalesce(nullif(btrim(p_reason), ''), 'No reason given'), jsonb_build_object('on', v_on, 'type', p_type));
 select * into i from public.course_intakes where id = (select intake_id from public.intake_enrolments where id = v_enrol);
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', i.id, 'batch', public.intake_group_name(i.id), 'intakeId', i.id, 'joinedOn', v_on);
end $function$;

-- Start the Qualifications whose course start date has come (tentative -> In Progress).
create or replace function public.qualification_start_due(p_enrolment uuid default null) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare r record; n integer := 0;
begin
  for r in select e.id from public.intake_enrolments e
            where e.status = 'tentative' and (p_enrolment is null or e.id = p_enrolment)
              and coalesce(e.course_start_date, e.enrolled_on) <= public.course_intake_today() loop
    perform set_config('qualification.system', 'on', true);
    perform set_config('qualification.reason', 'Course started', true);
    update public.intake_enrolments set status = 'active' where id = r.id;
    perform set_config('qualification.reason', '', true);
    perform set_config('qualification.system', '', true);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.qualification_start_due(uuid) from public, anon, authenticated;

-- Copies made in the database: the CoE / VoE and the signed offer (their content is stored in rows); the application's uploaded
-- files wait as pending copies that the staff screens copy from storage (qualification_document_store_copy).
create or replace function public.qualification_copy_documents(p_enrolment uuid) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; n integer := 0; c integer;
begin
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.application_id is null then return 0; end if;
  insert into public.intake_enrolment_documents(enrolment_id, kind, title, file_name, mime_type, size_bytes, sha256, content, source_table, source_id, student_visible, uploaded_by)
  select e.id, case when d.kind = 'voe' then 'voe' else 'coe' end, upper(coalesce(d.kind, 'coe')) || coalesce(' ' || d.document_number, ''),
    d.file_name, 'application/pdf', octet_length(d.content), encode(sha256(d.content), 'hex'), d.content, 'enrollment_coe_documents', d.id, true, d.uploaded_by
  from public.enrollment_coe_documents d
  where d.application_id = e.application_id and d.superseded_at is null and d.content is not null and d.kind in ('coe', 'voe')
  on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into public.intake_enrolment_documents(enrolment_id, kind, title, file_name, mime_type, size_bytes, sha256, content, source_table, source_id, student_visible, uploaded_by)
  select e.id, 'signed_offer', 'Signed letter of offer', coalesce(o.file_name, 'letter-of-offer.pdf'), 'application/pdf', octet_length(o.signed_content),
    encode(sha256(o.signed_content), 'hex'), o.signed_content, 'enrollment_offer_letters', o.id, true, o.issued_by
  from public.enrollment_offer_letters o
  where o.application_id = e.application_id and o.signed_content is not null
  on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into public.intake_enrolment_documents(enrolment_id, kind, title, file_name, mime_type, size_bytes, copy_state, source_table, source_id, source_bucket, source_path, student_visible)
  select e.id, 'application_document', coalesce(nullif(d.category, ''), 'Application document'), d.filename, d.mime_type, d.file_size::integer, 'pending',
    'enrollment_application_documents', d.id, d.bucket_name, d.storage_path, true
  from public.enrollment_application_documents d
  where (d.application_id = e.application_id or d.id in (select x from public.application_document_ids(e.application_id) x))
    and coalesce(d.is_current, true) and coalesce(d.review_state, '') <> 'rejected' and d.storage_path is not null
  on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  return n;
end $$;
revoke all on function public.qualification_copy_documents(uuid) from public, anon, authenticated;

-- The student's empty personal fields are filled from the application's answers; filled and differing fields are noted.
create or replace function public.qualification_fill_student(p_enrolment uuid) returns text
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; a public.enrollment_applications; s public.enrollment_students; sv jsonb; fill jsonb := '{}'; diff text[] := '{}'; k text; v jsonb;
begin
  select * into e from public.intake_enrolments where id = p_enrolment;
  select * into a from public.enrollment_applications where id = e.application_id;
  select * into s from public.enrollment_students where id = e.student_id;
  if a.id is null or s.id is null then return null; end if;
  sv := public.student_values(a.data -> 'values');
  for k, v in select key, value from jsonb_each(coalesce(sv, '{}'::jsonb)) loop
    if v is null or v = 'null'::jsonb or btrim(v #>> '{}') = '' then continue; end if;
    if coalesce(btrim(s.details ->> k), '') = '' then fill := fill || jsonb_build_object(k, v);
    elsif (s.details -> k) is distinct from v then diff := diff || k; end if;
  end loop;
  if fill <> '{}'::jsonb then perform public.student_apply_details(s.id, fill, null); end if;
  return nullif(concat_ws(' ', case when fill <> '{}'::jsonb then 'Filled on the student record from the application: ' || (select string_agg(x, ', ') from jsonb_object_keys(fill) x) || '.' end,
    case when cardinality(diff) > 0 then 'Different on the student record (kept): ' || array_to_string(diff, ', ') || '.' end), '');
end $$;
revoke all on function public.qualification_fill_student(uuid) from public, anon, authenticated;

-- An application moved to Enrolled: one Qualification per course, through the placement path, as Tentative.
create or replace function public.qualification_create_from_application(p_application uuid) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare a public.enrollment_applications; c record; i public.course_intakes; v_intake uuid; v_on date; v_enrol uuid; v_type text; v_doc public.enrollment_coe_documents;
  v_reason text; v_note text; v_date date := nullif(current_setting('qualification.enrolment_date', true), '')::date; n integer := 0; v_msg text;
  v_join date;
begin
  select * into a from public.enrollment_applications where id = p_application;
  if a.id is null or a.student_id is null then return 0; end if;
  select * into v_doc from public.enrollment_coe_documents d where d.application_id = a.id and d.superseded_at is null and d.kind in ('coe', 'voe')
   order by coalesce(d.issued_at, d.uploaded_at) desc nulls last limit 1;
  -- rule-policy: technical qualification-type A VoE makes a VoE Qualification, otherwise CoE (the enrolment default).
  v_type := case when v_doc.kind = 'voe' then 'VoE' else public.rule_text('lms.manual_placement_default_type', 'CoE') end;
  begin v_join := nullif(a.data #>> '{values,intake_join_date}', '')::date; exception when others then v_join := null; end;
  if not exists (select 1 from public.enrollment_application_courses x where x.application_id = a.id) then
    perform public.qualification_open_task('place_manually', null, null, a.id, a.student_id, 'Place student manually',
      coalesce(a.reference, 'The application') || ' is Enrolled but names no course: place the student in an intake by hand (Re-add to intake).', public.course_intake_today());
    return 0;
  end if;
  for c in select x.* from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at loop
    if exists (select 1 from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id
               where e.application_id = a.id and ci.course_id = c.course_id) then continue; end if;
    v_intake := c.intake_id;
    if v_intake is null then begin v_intake := nullif(a.data #>> '{values,intake_id}', '')::uuid; exception when others then v_intake := null; end; end if;
    select * into i from public.course_intakes where id = v_intake and course_id = c.course_id;
    begin
      if i.id is null then raise exception 'no intake of % is chosen on the application', coalesce(c.course_code, c.course_id) using errcode = '22023'; end if;
      v_on := greatest(coalesce(v_date, v_join, i.start_date), i.start_date);
      perform set_config('qualification.new_status', 'tentative', true);
      perform set_config('qualification.reason', 'Enrolled from application ' || coalesce(a.reference, ''), true);
      v_enrol := public.rto_place_core(i.id, a.student_id, v_type, v_on);
      perform set_config('qualification.new_status', '', true);
      perform set_config('qualification.reason', '', true);
      update public.intake_enrolments e set application_id = a.id, coe_document_id = v_doc.id,
        coe_number = case when v_doc.kind = 'coe' then nullif(btrim(v_doc.document_number), '') end,
        voe_number = case when v_doc.kind = 'voe' then nullif(btrim(v_doc.document_number), '') end,
        study_reason_code = coalesce(case when public.avetmiss_is_code('study_reason', a.data #>> '{values,study_reason}') then nullif(a.data #>> '{values,study_reason}', '') end, e.study_reason_code)
      where e.id = v_enrol;
      perform public.qualification_copy_documents(v_enrol);
      v_note := public.qualification_fill_student(v_enrol);
      if v_note is not null then
        insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, note, effective_on, changed_by, changed_by_name)
        select e.id, e.status, e.status, 'Student record checked against the application', v_note, public.course_intake_today(), auth.uid(), public.qualification_actor_name()
        from public.intake_enrolments e where e.id = v_enrol;
      end if;
      perform public.qualification_start_due(v_enrol);
      n := n + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      perform set_config('qualification.new_status', '', true);
      perform set_config('qualification.reason', '', true);
      perform set_config('rto.auto_place', 'off', true);
      perform public.qualification_open_task('place_manually', c.course_id, null, a.id, a.student_id, 'Place student manually',
        coalesce(a.reference, 'The application') || ' (' || coalesce(c.course_code, c.course_id) || ') is Enrolled but the student could not be placed: ' || v_msg
          || '. Place them by hand (Re-add to intake on the student page).', public.course_intake_today());
    end;
  end loop;
  return n;
end $$;
revoke all on function public.qualification_create_from_application(uuid) from public, anon, authenticated;

create or replace function public.qualification_on_application_enrolled() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'enrolled' and old.status is distinct from 'enrolled' then perform public.qualification_create_from_application(new.id); end if;
  return null;
end $$;
drop trigger if exists zz_qualification_on_enrolled on public.enrollment_applications;
create trigger zz_qualification_on_enrolled after update of status on public.enrollment_applications
  for each row execute function public.qualification_on_application_enrolled();

-- Active is set by the Qualification only; the placement check stays (an In Progress / Deferred / Suspended Qualification).
create or replace function public.application_active_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if coalesce(current_setting('qualification.sync', true), '') <> 'on' then
      raise exception 'An application becomes Active by itself when its Qualification moves to In Progress (course start date).' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id
       where e.student_id = new.student_id and e.status in ('active', 'deferred', 'suspended')
         and ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id)) then
      raise exception 'Choose an intake and a start date first: a student is Active only once placed in an intake of this course.' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- screens: read and change
create or replace function public.qualification_can_change() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false);
$$;

create or replace function public.qualification_row_json(e public.intake_enrolments) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('id', e.id, 'status', e.status, 'label', public.qualification_label(e.status), 'type', e.enrolment_type,
    'studentId', e.student_id, 'studentName', s.full_name, 'studentNumber', s.student_number,
    'courseId', ci.course_id, 'courseCode', c.code, 'courseName', c.name, 'intakeId', ci.id, 'intakeName', public.intake_group_name(ci.id),
    'startDate', coalesce(e.course_start_date, e.enrolled_on), 'endDate', e.course_end_date, 'enrolledOn', e.enrolled_on,
    'resumeDate', e.resume_date, 'withdrawnOn', e.withdrawn_on, 'statusChangedAt', e.status_changed_at, 'archived', e.archived_at is not null,
    'applicationId', e.application_id, 'applicationReference', a.reference, 'coeNumber', e.coe_number, 'voeNumber', e.voe_number,
    'openTasks', (select count(*) from public.qualification_tasks t where t.enrolment_id = e.id and t.status = 'open'))
  from public.course_intakes ci
  left join public.cms_courses c on c.id = ci.course_id
  left join public.enrollment_students s on s.id = e.student_id
  left join public.enrollment_applications a on a.id = e.application_id
  where ci.id = e.intake_id;
$$;

create or replace function public.qualification_list(p_status text[] default null, p_search text default null, p_student uuid default null, p_application uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.qualification_row_json(e) order by coalesce(e.course_start_date, e.enrolled_on) desc, e.id)
    from public.intake_enrolments e
    join public.course_intakes ci on ci.id = e.intake_id
    left join public.cms_courses c on c.id = ci.course_id
    left join public.enrollment_students s on s.id = e.student_id
    where (p_status is null or cardinality(p_status) = 0 or e.status = any(p_status))
      and (p_student is null or e.student_id = p_student)
      and (p_application is null or e.application_id = p_application)
      and (q is null or s.full_name ilike '%' || q || '%' or coalesce(s.student_number, '') ilike '%' || q || '%' or coalesce(c.code, '') ilike '%' || q || '%'
           or coalesce(c.name, '') ilike '%' || q || '%' or coalesce(e.coe_number, '') ilike '%' || q || '%')), '[]'::jsonb);
end $$;

create or replace function public.qualification_get(p_enrolment uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare e public.intake_enrolments;
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  return public.qualification_row_json(e) || jsonb_build_object(
    'reason', e.status_reason, 'note', e.status_note, 'studyReason', e.study_reason_code, 'fundingSource', e.funding_source_code,
    'canChange', public.qualification_can_change(), 'canUndo', coalesce(public.cms_is_admin(), false) and e.status in ('completed', 'withdrawn'),
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('status', m, 'label', public.qualification_label(m))), '[]'::jsonb)
              from unnest(public.qualification_moves(e.status)) m where m <> 'active' or e.status <> 'tentative'),
    'reasons', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'label', r.label, 'isOther', r.is_other) order by r.status, r.sort), '[]'::jsonb)
                from public.qualification_status_reasons r where r.is_active),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('unitId', u.unit_id, 'code', u.code, 'name', u.name, 'startDate', u.start_date, 'endDate', u.end_date,
                'assessment', u.assessment, 'assessmentOn', u.assessment_on, 'avetmissOutcome', u.avetmiss_outcome, 'hasResult', u.has_result)), '[]'::jsonb)
              from public.qualification_units(e.id) u),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'fileName', d.file_name, 'mimeType', d.mime_type,
                'size', d.size_bytes, 'copyState', d.copy_state, 'sourceBucket', d.source_bucket, 'sourcePath', d.source_path, 'studentVisible', d.student_visible,
                'createdAt', d.created_at) order by d.created_at), '[]'::jsonb)
              from public.intake_enrolment_documents d where d.enrolment_id = e.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'from', h.from_status, 'fromLabel', public.qualification_label(h.from_status), 'to', h.to_status,
                'toLabel', public.qualification_label(h.to_status), 'reason', h.reason, 'note', h.note, 'evidenceId', h.evidence_document_id, 'effectiveOn', h.effective_on,
                'by', h.changed_by_name, 'at', h.changed_at) order by h.changed_at desc, h.id), '[]'::jsonb)
              from public.intake_enrolment_status_history h where h.enrolment_id = e.id),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'event', t.event, 'title', t.title, 'detail', t.detail, 'dueOn', t.due_on,
                'status', t.status, 'prismsReference', t.prisms_reference, 'closedNote', t.closed_note, 'closedAt', t.closed_at) order by t.status desc, t.created_at), '[]'::jsonb)
              from public.qualification_tasks t where t.enrolment_id = e.id or (t.enrolment_id is null and t.application_id = e.application_id)));
end $$;

-- Change the status (Admin / RTO Manager): the trigger checks the move; deferred / suspended / cancelled need a reason.
create or replace function public.qualification_set_status(p_enrolment uuid, p_status text, p_reason text default null, p_note text default null,
  p_effective_on date default null, p_resume_date date default null, p_evidence uuid default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; v_eff date := coalesce(p_effective_on, public.course_intake_today());
begin
  if not public.qualification_can_change() then raise exception 'Only an Admin or an RTO Manager can change a Qualification.' using errcode = '42501'; end if;
  select * into e from public.intake_enrolments where id = p_enrolment for update;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  if p_status is not distinct from e.status then raise exception 'The Qualification is already %.', public.qualification_label(e.status) using errcode = '22023'; end if;
  -- rule-policy: technical qualification-reason-required A reason is required to defer, suspend or cancel a Qualification.
  if p_status in ('deferred', 'suspended', 'withdrawn') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Choose a reason.' using errcode = '22023';
  end if;
  if p_evidence is not null and not exists (select 1 from public.intake_enrolment_documents d where d.id = p_evidence and d.enrolment_id = e.id) then
    raise exception 'The evidence is not a document of this Qualification.' using errcode = '22023';
  end if;
  perform set_config('qualification.reason', left(coalesce(btrim(p_reason), ''), 200), true);
  perform set_config('qualification.note', left(coalesce(btrim(p_note), ''), 2000), true);
  perform set_config('qualification.effective_on', v_eff::text, true);
  perform set_config('qualification.evidence', coalesce(p_evidence::text, ''), true);
  update public.intake_enrolments set status = p_status, resume_date = p_resume_date,
    withdrawn_on = case when p_status = 'withdrawn' then v_eff else withdrawn_on end
  where id = e.id returning * into e;
  perform set_config('qualification.reason', '', true); perform set_config('qualification.note', '', true);
  perform set_config('qualification.effective_on', '', true); perform set_config('qualification.evidence', '', true);
  return public.qualification_row_json(e);
end $$;

-- Undo a final status (Completed / Cancelled): Admin only, with a reason; back to the status it had before.
create or replace function public.qualification_undo(p_enrolment uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; v_prev text;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only an Admin can undo a final Qualification status.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give the reason for the undo.' using errcode = '22023'; end if;
  select * into e from public.intake_enrolments where id = p_enrolment for update;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  if e.status not in ('completed', 'withdrawn') then raise exception 'Only Completed or Cancelled can be undone.' using errcode = '22023'; end if;
  select h.from_status into v_prev from public.intake_enrolment_status_history h where h.enrolment_id = e.id and h.to_status = e.status and h.from_status is not null
   order by h.changed_at desc limit 1;
  v_prev := coalesce(v_prev, 'active');
  if v_prev in ('deferred', 'suspended', 'completed', 'withdrawn') then v_prev := 'active'; end if;
  perform set_config('qualification.undo', 'on', true);
  perform set_config('qualification.reason', left('Undo: ' || btrim(p_reason), 200), true);
  update public.intake_enrolments set status = v_prev, withdrawn_on = null where id = e.id returning * into e;
  perform set_config('qualification.undo', '', true); perform set_config('qualification.reason', '', true);
  return public.qualification_row_json(e);
end $$;

-- Documents: add (evidence, certificate, other), read, and store the copy of an application document.
create or replace function public.qualification_document_add(p_enrolment uuid, p_kind text, p_title text, p_file_name text, p_mime text, p_content text, p_student_visible boolean default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_bytes bytea; v_id uuid;
begin
  if not public.qualification_can_change() then raise exception 'Only an Admin or an RTO Manager can add Qualification documents.' using errcode = '42501'; end if;
  if not exists (select 1 from public.intake_enrolments where id = p_enrolment) then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  if p_kind not in ('evidence', 'certificate', 'coe', 'voe', 'other') then raise exception 'Unknown document kind' using errcode = '22023'; end if;
  begin v_bytes := decode(p_content, 'base64'); exception when others then raise exception 'The file could not be read.' using errcode = '22023'; end;
  if v_bytes is null or octet_length(v_bytes) = 0 then raise exception 'The file is empty.' using errcode = '22023'; end if;
  insert into public.intake_enrolment_documents(enrolment_id, kind, title, file_name, mime_type, size_bytes, sha256, content, student_visible)
  values (p_enrolment, p_kind, left(coalesce(nullif(btrim(p_title), ''), p_file_name, 'Document'), 200), left(p_file_name, 255), p_mime, octet_length(v_bytes),
    encode(sha256(v_bytes), 'hex'), v_bytes, coalesce(p_student_visible, p_kind <> 'evidence'))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.qualification_document_store_copy(p_document uuid, p_content text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_bytes bytea;
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  begin v_bytes := decode(p_content, 'base64'); exception when others then v_bytes := null; end;
  if v_bytes is null or octet_length(v_bytes) = 0 then
    update public.intake_enrolment_documents set copy_state = 'failed' where id = p_document and copy_state = 'pending';
    return;
  end if;
  update public.intake_enrolment_documents set content = v_bytes, size_bytes = octet_length(v_bytes), sha256 = encode(sha256(v_bytes), 'hex'), copy_state = 'copied'
  where id = p_document and copy_state in ('pending', 'failed');
end $$;

create or replace function public.qualification_document_get(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare d public.intake_enrolment_documents; e public.intake_enrolments;
begin
  select * into d from public.intake_enrolment_documents where id = p_document;
  select * into e from public.intake_enrolments where id = d.enrolment_id;
  if d.id is null or not (public.cms_is_staff() or (d.student_visible and e.application_id is not null and public.portal_can_access_application(e.application_id))) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if d.content is null then raise exception 'This copy is not made yet.' using errcode = '22023'; end if;
  return jsonb_build_object('fileName', coalesce(d.file_name, d.title), 'mimeType', coalesce(d.mime_type, 'application/octet-stream'), 'content', encode(d.content, 'base64'));
end $$;

create or replace function public.qualification_task_close(p_task uuid, p_reference text default null, p_note text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare t public.qualification_tasks;
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  select * into t from public.qualification_tasks where id = p_task for update;
  if t.id is null or t.status <> 'open' then raise exception 'Task not found or already done' using errcode = 'P0002'; end if;
  if t.kind = 'prisms_report' and coalesce(btrim(p_reference), '') = '' then raise exception 'Enter the PRISMS reference.' using errcode = '22023'; end if;
  update public.qualification_tasks set status = 'done', prisms_reference = nullif(btrim(coalesce(p_reference, '')), ''), closed_note = nullif(btrim(coalesce(p_note, '')), ''),
    closed_by = auth.uid(), closed_at = now() where id = t.id;
end $$;

create or replace function public.qualification_tasks_open() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cms_is_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return jsonb_build_object('count', (select count(*) from public.qualification_tasks where status = 'open'),
    'items', (select coalesce(jsonb_agg(x.j order by x.due_on nulls last, x.created_at), '[]'::jsonb) from (
      select t.due_on, t.created_at, jsonb_build_object('id', t.id, 'title', t.title || coalesce(' · ' || s.full_name, ''), 'detail', coalesce(t.detail, ''),
        'at', t.created_at, 'to', case when t.enrolment_id is not null then '/admin/qualifications/' || t.enrolment_id
          when t.student_id is not null then '/admin/students/' || t.student_id else '/admin/qualifications' end) j
      from public.qualification_tasks t left join public.enrollment_students s on s.id = t.student_id
      where t.status = 'open' order by t.due_on nulls last, t.created_at limit 8) x));
end $$;

-- Students and agents: their Qualifications on an application (status, dates, their documents; no reasons or notes).
create or replace function public.portal_qualifications(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not (public.cms_is_staff() or public.portal_can_access_application(p_application)) then raise exception 'Application not found' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'label', public.qualification_label(e.status),
      'courseCode', c.code, 'courseName', c.name, 'intakeName', public.intake_group_name(ci.id),
      'startDate', coalesce(e.course_start_date, e.enrolled_on), 'endDate', e.course_end_date, 'resumeDate', e.resume_date,
      'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'fileName', d.file_name) order by d.created_at), '[]'::jsonb)
                    from public.intake_enrolment_documents d where d.enrolment_id = e.id and d.student_visible and d.copy_state = 'copied'))
      order by coalesce(e.course_start_date, e.enrolled_on))
    from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id left join public.cms_courses c on c.id = ci.course_id
    where e.application_id = p_application), '[]'::jsonb);
end $$;

-- Daily: start the tentative Qualifications whose start date has come; a CoE student with no attendance marked present or late
-- by the start date plus the grace days is a no-show (PRISMS task).
create or replace function public.qualification_daily() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_started integer; v_noshow integer := 0; r record;
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
  return jsonb_build_object('started', v_started, 'noShows', v_noshow);
end $$;
revoke all on function public.qualification_daily() from public, anon, authenticated;

grant execute on function public.qualification_label(text), public.qualification_moves(text), public.qualification_move_allowed(text, text) to authenticated;
grant execute on function public.qualification_list(text[], text, uuid, uuid), public.qualification_get(uuid),
  public.qualification_set_status(uuid, text, text, text, date, date, uuid), public.qualification_undo(uuid, text),
  public.qualification_document_add(uuid, text, text, text, text, text, boolean), public.qualification_document_store_copy(uuid, text),
  public.qualification_document_get(uuid), public.qualification_task_close(uuid, text, text), public.qualification_tasks_open(),
  public.portal_qualifications(uuid) to authenticated;
revoke all on function public.qualification_units(uuid), public.qualification_row_json(public.intake_enrolments), public.qualification_open_task(text, text, uuid, uuid, uuid, text, text, date),
  public.qualification_status_guard(), public.qualification_status_after(), public.qualification_on_application_enrolled() from public, anon, authenticated;

-- ---------------------------------------------------------------- existing functions, patched in place
create or replace function pg_temp.q_patch(p_fn text, p_from text, p_to text, p_all boolean default false) returns void language plpgsql as $$
declare f record; v_def text; v_hits integer := 0;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn loop
    v_def := pg_get_functiondef(f.oid);
    if position(p_from in v_def) > 0 then
      v_hits := v_hits + 1;
      if p_all then v_def := replace(v_def, p_from, p_to);
      else v_def := overlay(v_def placing p_to from position(p_from in v_def) for char_length(p_from)); end if;
      execute v_def;
    end if;
  end loop;
  if v_hits = 0 then raise exception 'QUALIFICATION patch: % does not contain %', p_fn, p_from; end if;
end $$;

-- The enrolment date chosen in "Mark as enrolled" is the day the Qualification starts from.
select pg_temp.q_patch('change_application_status', ' perform public.portal_set_application_status(a.id, t.to_status,',
  ' perform set_config(''qualification.enrolment_date'', case when t.kind = ''enrol'' then v_date::text else '''' end, true);
 perform public.portal_set_application_status(a.id, t.to_status,');

-- Seats, placement, intakes and carry-over: a tentative or suspended Qualification still holds its place.
select pg_temp.q_patch(fn, 'status in (''active'', ''deferred'')', 'status in (''tentative'', ''active'', ''deferred'', ''suspended'')', true)
from unnest(array['rto_batch_seat_guard', 'rto_batch_occupancy', 'rto_batches', 'rto_intake_json', 'rto_batch_assign', 'rto_staff_move', 'rto_course_flow',
  'rto_carry_over_on_outcome', 'rto_carry_over_run', 'rto_carry_over_plan', 'lms_batches_without_classes', 'admin_intakes_timeline', 'rto_admin']) fn;
select pg_temp.q_patch(fn, 'status in (''active'', ''deferred'', ''completed'')', 'status in (''tentative'', ''active'', ''deferred'', ''suspended'', ''completed'')', true)
from unnest(array['rto_batch_place', 'rto_carry_over_open_units', 'rto_carry_over_plan', 'rto_enrolment_path', 'rto_enrolment_units', 'rto_lms_place_student',
  'rto_placement_waiting', 'rto_admin']) fn;
select pg_temp.q_patch('rto_batch_seat_guard', 'if new.status not in (''active'', ''deferred'') then return new; end if;',
  'if new.status not in (''tentative'', ''active'', ''deferred'', ''suspended'') then return new; end if;');
-- Two intakes of one student may not overlap: a tentative Qualification counts too.
select pg_temp.q_patch('intake_enrolments_no_clash', 'if new.status <> ''active'' then return null; end if;', 'if new.status not in (''tentative'', ''active'') then return null; end if;');
select pg_temp.q_patch('intake_enrolments_no_clash', 'e.id <> new.id and e.status = ''active''', 'e.id <> new.id and e.status in (''tentative'', ''active'')');

-- Deferred / suspended pause attendance and classes: class lists, attendance and timetables show In Progress students only.
select pg_temp.q_patch(fn, 'status in (''active'', ''deferred'')', 'status = ''active''', true)
from unnest(array['admin_calendar_people', 'admin_class_calendar', 'admin_class_session_students', 'admin_student_schedule', 'my_class_schedule',
  'prereq_class_admin', 'prereq_class_sessions', 'trainer_session_attendance', 'trainer_session_attendance_save']) fn;
select pg_temp.q_patch('lms_attendance', 'status in (''active'',''deferred'')', 'status = ''active''', true);
-- Learning pages stay readable while deferred or suspended (nothing to attend or submit); cancelled ends access.
select pg_temp.q_patch(fn, 'status in (''active'', ''deferred'', ''completed'')', 'status in (''active'', ''deferred'', ''suspended'', ''completed'')', true)
from unnest(array['student_my_learning', 'student_enrolled_unit_ids', 'student_progress_core']) fn;

-- Cancellations made by the system record the day they happen (the withdrawal guard needs the date).
select pg_temp.q_patch('rto_staff_remove', 'update public.intake_enrolments set status = ''withdrawn'' where id = e.id;',
  'perform set_config(''qualification.reason'', left(coalesce(nullif(btrim(p_reason), ''''), ''Removed from the intake''), 200), true);
 update public.intake_enrolments set status = ''withdrawn'', withdrawn_on = coalesce(withdrawn_on, public.course_intake_today()) where id = e.id;
 perform set_config(''qualification.reason'', '''', true);');
select pg_temp.q_patch('lms_intake_archive', 'update public.intake_enrolments set status = ''withdrawn'', archived_at = now() where intake_id = p_intake and status in (''active'', ''deferred'');',
  'update public.intake_enrolments set status = ''withdrawn'', withdrawn_on = coalesce(withdrawn_on, public.course_intake_today()), archived_at = now() where intake_id = p_intake and status in (''tentative'', ''active'', ''deferred'', ''suspended'');');
select pg_temp.q_patch('lms_intake_archive', 'from public.intake_enrolments e where e.intake_id = p_intake and e.status in (''active'', ''deferred'');',
  'from public.intake_enrolments e where e.intake_id = p_intake and e.status in (''tentative'', ''active'', ''deferred'', ''suspended'');');
select pg_temp.q_patch('rto_application_placement', 'update public.intake_enrolments e set status = ''withdrawn''
  where e.student_id = new.student_id and e.status in (''active'', ''deferred'')',
  'perform set_config(''qualification.reason'', ''Application '' || public.portal_status_label(new.status), true);
  update public.intake_enrolments e set status = ''withdrawn'', withdrawn_on = coalesce(e.withdrawn_on, public.course_intake_today())
  where e.student_id = new.student_id and e.status in (''tentative'', ''active'', ''deferred'', ''suspended'')');
select pg_temp.q_patch('rto_course_flow', 'update public.intake_enrolments set status = d->>''status'' where id = nullif(d->>''enrolmentId'', '''')::uuid returning * into en;',
  'perform set_config(''qualification.undo'', ''on'', true);
  perform set_config(''qualification.reason'', case when d->>''status'' = ''withdrawn'' then ''Removed from the intake'' else ''Undo: brought back to the intake'' end, true);
  update public.intake_enrolments set status = d->>''status'', withdrawn_on = case when d->>''status'' = ''withdrawn'' then coalesce(withdrawn_on, public.course_intake_today()) end
   where id = nullif(d->>''enrolmentId'', '''')::uuid returning * into en;
  perform set_config(''qualification.undo'', '''', true); perform set_config(''qualification.reason'', '''', true);');
-- A revoked certificate takes the Qualification back to In Progress (an undo with the revoke reason).
select pg_temp.q_patch('course_completion_revoke', 'if r.kind = ''certificate'' then update public.intake_enrolments set status = ''active'' where id = r.enrolment_id and status = ''completed''; end if;',
  'if r.kind = ''certificate'' then
    perform set_config(''qualification.undo'', ''on'', true); perform set_config(''qualification.reason'', left(''Certificate revoked: '' || btrim(p_reason), 200), true);
    update public.intake_enrolments set status = ''active'' where id = r.enrolment_id and status = ''completed'';
    perform set_config(''qualification.undo'', '''', true); perform set_config(''qualification.reason'', '''', true);
  end if;');
select pg_temp.q_patch('course_completion_issue', 'if p_kind = ''certificate'' then update public.intake_enrolments set status = ''completed'' where id = e.id; end if;',
  'if p_kind = ''certificate'' then
    perform set_config(''qualification.reason'', ''Certificate issued'', true);
    update public.intake_enrolments set status = ''completed'' where id = e.id;
    perform set_config(''qualification.reason'', '''', true);
  end if;');

-- The existing rows get their first history entry (no status or date is changed).
insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, effective_on, changed_by, changed_by_name, changed_at)
select e.id, null, e.status, 'Recorded before Qualification history', coalesce(e.course_start_date, e.enrolled_on), e.created_by, 'System', now()
from public.intake_enrolments e
where not exists (select 1 from public.intake_enrolment_status_history h where h.enrolment_id = e.id);

-- Daily at 00:17 Melbourne (13:17 UTC in summer, 14:17 in winter; cron runs in UTC): 13:17 UTC covers the start date in both.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'qualification-daily';
    perform cron.schedule('qualification-daily', '17 13 * * *', 'select public.qualification_daily()');
  end if;
end $$;

-- Admissions › Qualifications (the staff list).
insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, open_in_new_tab, permission_key)
values ('qualifications', 'admissions', 'Qualifications', '/admin/qualifications', 'students', 15, true, false, 'cms.admin')
on conflict (id) do nothing;
