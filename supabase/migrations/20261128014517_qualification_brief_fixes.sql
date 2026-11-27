-- QUALIFICATION-BRIEF (owner 2026-11-27): the released Qualification brought in line with the brief (owner decisions of 2026-11-27).
--  1. reasons: a reason from public.qualification_status_reasons for Deferred, Suspended, Cancelled and the manual start of a Tentative
--     one (new list status 'active'); "Other" needs a note; resuming (Deferred / Suspended -> In Progress) and Completed need no reason;
--     an undo takes a reason from the 'undo' list (Other with a note). Enforced in qualification_set_status / qualification_undo.
--  2. intake_enrolments.actual_completion_date (set on Completed / Cancelled, cleared by an undo) and award_issued_date (from the course
--     certificate: issued sets it, revoked clears it); existing rows filled.
--  3. qualification_set_dates: an Admin edits commencement (course_start_date) and expected completion (course_end_date); logged in the
--     Qualification's history.
--  4. lms_unit_students.qualification_id and asm_attempts.qualification_id: the Qualification (the first row of a carry-over chain) of
--     the unit enrolment / attempt, set on insert and filled for existing rows.
--  5. documents: personal documents (passport, visa, English test, academic, driving licence: student_document_category) are linked from
--     the student record (qualification_get personalDocuments, earlier versions kept and shown) and no longer copied; copies stay for the
--     study documents (CoE / VoE, signed offer, RPL / credit evidence and the other application documents, later uploads). Copies of
--     personal documents still waiting (copy_state pending, no file) are removed; copies already made stay.
--  6. one step: recording the CoE / VoE (issue_coe_voe) makes the application Enrolled, which creates the Qualification; the separate
--     "Mark as enrolled" action is now automatic (application_status_transitions coe_issued / enrol is_automatic), so nobody chooses it.
-- Down: drop qualification_set_dates, the triggers qualification_unit_link / qualification_attempt_link / course_completions_award_on,
--       their functions and qualification_root_enrolment; drop the four columns; set the enrol transition is_automatic = false;
--       re-run qualification_set_status, qualification_undo(uuid, text), qualification_get, qualification_copy_documents,
--       qualification_status_guard, issue_coe_voe and change_application_status from their previous migrations.

-- ------------------------------------------------------------------ 1. reasons
alter table public.qualification_status_reasons drop constraint if exists qualification_status_reasons_status_check;
alter table public.qualification_status_reasons add constraint qualification_status_reasons_status_check
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  check (status in ('active', 'deferred', 'suspended', 'withdrawn', 'undo'));
insert into public.qualification_status_reasons(status, label, sort, is_other) values
 ('active', 'Started before the commencement date', 10, false), ('active', 'Other', 99, true)
on conflict (status, label) do nothing;

create or replace function public.qualification_set_status(p_enrolment uuid, p_status text, p_reason text default null, p_note text default null,
  p_effective_on date default null, p_resume_date date default null, p_evidence uuid default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; v_eff date := coalesce(p_effective_on, public.course_intake_today()); v_list text; r public.qualification_status_reasons;
begin
  if not public.qualification_can_change() then raise exception 'Only an Admin or an RTO Manager can change a Qualification.' using errcode = '42501'; end if;
  select * into e from public.intake_enrolments where id = p_enrolment for update;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  if p_status is not distinct from e.status then raise exception 'The Qualification is already %.', public.qualification_label(e.status) using errcode = '22023'; end if;
  -- rule-policy: technical qualification-reason-list The owner's reason rule (2026-11-27): which moves take a reason from the list.
  v_list := case when p_status in ('deferred', 'suspended', 'withdrawn') then p_status when p_status = 'active' and e.status = 'tentative' then 'active' end;
  if v_list is not null then
    select * into r from public.qualification_status_reasons x where x.status = v_list and x.label = btrim(coalesce(p_reason, '')) and x.is_active;
    if r.id is null then raise exception 'Choose a reason from the list.' using errcode = '22023'; end if;
    if r.is_other and coalesce(btrim(p_note), '') = '' then raise exception 'Say what the other reason is in the note.' using errcode = '22023'; end if;
  end if;
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  if p_evidence is not null and not exists (select 1 from public.intake_enrolment_documents d where d.id = p_evidence and d.enrolment_id = e.id) then
    raise exception 'The evidence is not a document of this Qualification.' using errcode = '22023';
  end if;
  perform set_config('qualification.reason', left(coalesce(btrim(p_reason), ''), 200), true);
  perform set_config('qualification.note', left(coalesce(btrim(p_note), ''), 2000), true);
  perform set_config('qualification.effective_on', v_eff::text, true);
  perform set_config('qualification.evidence', coalesce(p_evidence::text, ''), true);
  update public.intake_enrolments set status = p_status, resume_date = p_resume_date,
    -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
    withdrawn_on = case when p_status = 'withdrawn' then v_eff else withdrawn_on end
  where id = e.id returning * into e;
  perform set_config('qualification.reason', '', true); perform set_config('qualification.note', '', true);
  perform set_config('qualification.effective_on', '', true); perform set_config('qualification.evidence', '', true);
  return public.qualification_row_json(e);
end $$;

drop function if exists public.qualification_undo(uuid, text);
create or replace function public.qualification_undo(p_enrolment uuid, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; v_prev text; r public.qualification_status_reasons;
begin
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only an Admin can undo a final Qualification status.' using errcode = '42501'; end if;
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  select * into r from public.qualification_status_reasons x where x.status = 'undo' and x.label = btrim(coalesce(p_reason, '')) and x.is_active;
  if r.id is null then raise exception 'Choose a reason from the list.' using errcode = '22023'; end if;
  if r.is_other and coalesce(btrim(p_note), '') = '' then raise exception 'Say what the other reason is in the note.' using errcode = '22023'; end if;
  select * into e from public.intake_enrolments where id = p_enrolment for update;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  if e.status not in ('completed', 'withdrawn') then raise exception 'Only Completed or Cancelled can be undone.' using errcode = '22023'; end if;
  select h.from_status into v_prev from public.intake_enrolment_status_history h where h.enrolment_id = e.id and h.to_status = e.status and h.from_status is not null
   order by h.changed_at desc limit 1;
  v_prev := coalesce(v_prev, 'active');
  if v_prev in ('deferred', 'suspended', 'completed', 'withdrawn') then v_prev := 'active'; end if;
  perform set_config('qualification.undo', 'on', true);
  perform set_config('qualification.reason', left('Undo: ' || btrim(p_reason), 200), true);
  perform set_config('qualification.note', left(coalesce(btrim(p_note), ''), 2000), true);
  update public.intake_enrolments set status = v_prev, withdrawn_on = null where id = e.id returning * into e;
  perform set_config('qualification.undo', '', true); perform set_config('qualification.reason', '', true); perform set_config('qualification.note', '', true);
  return public.qualification_row_json(e);
end $$;
revoke all on function public.qualification_undo(uuid, text, text) from public, anon;
grant execute on function public.qualification_undo(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ 2. actual completion and award dates
alter table public.intake_enrolments add column if not exists actual_completion_date date, add column if not exists award_issued_date date;
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
comment on column public.intake_enrolments.actual_completion_date is 'Qualification: the day it was Completed or Cancelled (cleared by an undo)';
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
comment on column public.intake_enrolments.award_issued_date is 'Qualification: the day the course certificate was issued (cleared when it is revoked)';

create or replace function pg_temp.qbpatch(p_fn regprocedure, p_anchor text, p_new text, p_what text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n integer;
begin
 if position(p_new in d) > 0 then return; end if;
 n := (length(d) - length(replace(d, p_anchor, ''))) / length(p_anchor);
 if n <> 1 then raise exception '% anchor found % times', p_what, n; end if;
 execute replace(d, p_anchor, p_new);
end $$;
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
select pg_temp.qbpatch('public.qualification_status_guard()'::regprocedure,
 $a$  new.status_note := nullif(btrim(coalesce(nullif(current_setting('qualification.note', true), ''), case when new.status_note is distinct from old.status_note then new.status_note end, '')), '');$a$,
 $b$-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
   new.status_note := nullif(btrim(coalesce(nullif(current_setting('qualification.note', true), ''), case when new.status_note is distinct from old.status_note then new.status_note end, '')), '');
  -- QUALIFICATION-BRIEF: the actual completion date follows the final status
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  new.actual_completion_date := case when new.status = 'completed' then v_eff when new.status = 'withdrawn' then coalesce(new.withdrawn_on, v_eff) end;$b$,
 'qualification_status_guard actual completion');
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
update public.intake_enrolments e set actual_completion_date = e.withdrawn_on where e.status = 'withdrawn' and e.actual_completion_date is null and e.withdrawn_on is not null;
update public.intake_enrolments e set actual_completion_date = coalesce(
   -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
   (select h.effective_on from public.intake_enrolment_status_history h where h.enrolment_id = e.id and h.to_status = 'completed' order by h.changed_at desc limit 1),
   (e.status_changed_at at time zone public.institution_tz())::date)
 -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 where e.status = 'completed' and e.actual_completion_date is null;

create or replace function public.course_completions_award_on() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  if new.kind = 'certificate' and new.enrolment_id is not null then
    update public.intake_enrolments set award_issued_date = case when new.revoked_at is null then (new.issued_at at time zone public.institution_tz())::date end
     where id = new.enrolment_id;
  end if;
  return null;
end $$;
drop trigger if exists course_completions_award_on on public.course_completions;
create trigger course_completions_award_on after insert or update of revoked_at on public.course_completions for each row execute function public.course_completions_award_on();
revoke all on function public.course_completions_award_on() from public, anon, authenticated;
update public.intake_enrolments e set award_issued_date = (c.issued_at at time zone public.institution_tz())::date
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  from public.course_completions c where c.enrolment_id = e.id and c.kind = 'certificate' and c.revoked_at is null and e.award_issued_date is null;

-- ------------------------------------------------------------------ 3. an Admin edits commencement and expected completion (logged)
create or replace function public.qualification_set_dates(p_enrolment uuid, p_commencement date, p_expected date, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only an Admin can change the Qualification''s dates.' using errcode = '42501'; end if;
  if p_commencement is null or p_expected is null or p_expected < p_commencement then
    raise exception 'The expected completion date must be on or after the commencement date.' using errcode = '22023';
  end if;
  select * into e from public.intake_enrolments where id = p_enrolment for update;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  if p_commencement is not distinct from e.course_start_date and p_expected is not distinct from e.course_end_date then return public.qualification_get(e.id); end if;
  update public.intake_enrolments set course_start_date = p_commencement, course_end_date = p_expected where id = e.id;
  insert into public.intake_enrolment_status_history(enrolment_id, from_status, to_status, reason, note, effective_on, changed_by, changed_by_name)
  values (e.id, e.status, e.status, 'Dates changed',
    left(concat_ws(' · ', 'Commencement ' || coalesce(to_char(e.course_start_date, 'DD/MM/YYYY'), 'not set') || ' → ' || to_char(p_commencement, 'DD/MM/YYYY'),
      'expected completion ' || coalesce(to_char(e.course_end_date, 'DD/MM/YYYY'), 'not set') || ' → ' || to_char(p_expected, 'DD/MM/YYYY'), nullif(btrim(coalesce(p_note, '')), '')), 2000),
    public.course_intake_today(), auth.uid(), public.qualification_actor_name());
  return public.qualification_get(e.id);
end $$;
revoke all on function public.qualification_set_dates(uuid, date, date, text) from public, anon;
grant execute on function public.qualification_set_dates(uuid, date, date, text) to authenticated;

-- ------------------------------------------------------------------ 4. unit enrolments and assessment attempts carry the Qualification's id
create or replace function public.qualification_root_enrolment(p_enrolment uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
 with recursive up(id, parent, depth) as (
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  select e.id, e.continues_enrolment_id, 0 from public.intake_enrolments e where e.id = p_enrolment
  union all
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  select e.id, e.continues_enrolment_id, up.depth + 1 from up join public.intake_enrolments e on e.id = up.parent where up.depth < 20)
 select id from up order by depth desc limit 1;
$$;
revoke all on function public.qualification_root_enrolment(uuid) from public, anon;
grant execute on function public.qualification_root_enrolment(uuid) to authenticated;
alter table public.lms_unit_students add column if not exists qualification_id uuid references public.intake_enrolments(id) on delete set null;
alter table public.asm_attempts add column if not exists qualification_id uuid references public.intake_enrolments(id) on delete set null;
create index if not exists lms_unit_students_qualification_idx on public.lms_unit_students(qualification_id);
create index if not exists asm_attempts_qualification_idx on public.asm_attempts(qualification_id);
create or replace function public.qualification_unit_link() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  new.qualification_id := public.qualification_root_enrolment((select e.id from public.intake_enrolments e where e.intake_id = new.intake_id and e.student_id = new.student_id));
  return new;
end $$;
drop trigger if exists qualification_unit_link on public.lms_unit_students;
create trigger qualification_unit_link before insert or update of intake_id, student_id on public.lms_unit_students for each row execute function public.qualification_unit_link();
revoke all on function public.qualification_unit_link() from public, anon, authenticated;
create or replace function public.qualification_attempt_link() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  new.qualification_id := public.qualification_root_enrolment((select e.id from public.asm_assignments g join public.intake_enrolments e on e.intake_id = g.intake_id and e.student_id = new.student_id
                                                               where g.id = new.assignment_id));
  return new;
end $$;
drop trigger if exists qualification_attempt_link on public.asm_attempts;
create trigger qualification_attempt_link before insert on public.asm_attempts for each row execute function public.qualification_attempt_link();
revoke all on function public.qualification_attempt_link() from public, anon, authenticated;
-- existing rows: only the new column is written (the tables' other update rules are not run again on old rows)
alter table public.lms_unit_students disable trigger user;
update public.lms_unit_students u set qualification_id = public.qualification_root_enrolment(e.id)
  from public.intake_enrolments e where e.intake_id = u.intake_id and e.student_id = u.student_id and u.qualification_id is null;
alter table public.lms_unit_students enable trigger user;
alter table public.asm_attempts disable trigger user;
update public.asm_attempts t set qualification_id = public.qualification_root_enrolment(e.id)
  from public.asm_assignments g join public.intake_enrolments e on e.intake_id = g.intake_id
 where g.id = t.assignment_id and e.student_id = t.student_id and t.qualification_id is null;
alter table public.asm_attempts enable trigger user;

-- ------------------------------------------------------------------ 5. personal documents linked, not copied
select pg_temp.qbpatch('public.qualification_copy_documents(uuid)'::regprocedure,
 $a$    and coalesce(d.is_current, true) and coalesce(d.review_state, '') <> 'rejected' and d.storage_path is not null$a$,
 $b$    and coalesce(d.is_current, true) and coalesce(d.review_state, '') <> 'rejected' and d.storage_path is not null
    and not public.student_document_category(d.category) -- QUALIFICATION-BRIEF: personal documents are linked from the student record$b$,
 'qualification_copy_documents personal');
delete from public.intake_enrolment_documents d using public.enrollment_application_documents a
 -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 where d.source_table = 'enrollment_application_documents' and d.source_id = a.id and d.kind = 'application_document' and d.copy_state = 'pending'
   and d.content is null and public.student_document_category(a.category);

-- qualification_get: the manual start among the moves (with its reason), the new dates, who may edit them, and the student's personal
-- documents (current and earlier versions) linked from the student record
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
select pg_temp.qbpatch('public.qualification_get(uuid)'::regprocedure,
 $a$              from unnest(public.qualification_moves(e.status)) m where m <> 'active' or e.status <> 'tentative'),$a$,
 $b$              from unnest(public.qualification_moves(e.status)) m),$b$,
 'qualification_get moves');
select pg_temp.qbpatch('public.qualification_get(uuid)'::regprocedure,
 $a$    'reason', e.status_reason, 'note', e.status_note, 'studyReason', e.study_reason_code, 'fundingSource', e.funding_source_code,$a$,
 $b$    'reason', e.status_reason, 'note', e.status_note, 'studyReason', e.study_reason_code, 'fundingSource', e.funding_source_code,
    'actualCompletionDate', e.actual_completion_date, 'awardIssuedDate', e.award_issued_date, 'canEditDates', coalesce(public.cms_is_admin(), false),
    'personalDocuments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'fileName', d.filename, 'mimeType', d.mime_type,
                'bucket', d.bucket_name, 'path', d.storage_path, 'isCurrent', coalesce(d.is_current, true), 'createdAt', d.created_at)
                order by coalesce(d.is_current, true) desc, d.category, d.created_at desc), '[]'::jsonb)
              from public.enrollment_application_documents d
              where public.student_document_category(d.category) and d.storage_path is not null and coalesce(d.review_state, '') <> 'rejected'
                and (d.student_id = e.student_id or (e.application_id is not null and d.application_id = e.application_id))),$b$,
 'qualification_get fields');

-- ------------------------------------------------------------------ 6. the CoE / VoE makes the application Enrolled in one step
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
update public.application_status_transitions set is_automatic = true where from_status = 'coe_issued' and action_key = 'enrol' and kind = 'enrol';
-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
select pg_temp.qbpatch('public.change_application_status(uuid,text,jsonb)'::regprocedure,
 $a$case t.kind when 'accept_offer' then 'when the student or agent accepts the offer' else 'when the application is resubmitted' end$a$,
 $b$-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 case t.kind when 'accept_offer' then 'when the student or agent accepts the offer' when 'enrol' then 'when the CoE / VoE is recorded' else 'when the application is resubmitted' end$b$,
 'change_application_status enrol automatic');
select pg_temp.qbpatch('public.issue_coe_voe(uuid,text,text,date,text,text,text,boolean)'::regprocedure,
 $a$ return v_out || jsonb_build_object('status', 'coe_issued', 'label', public.portal_status_label('coe_issued'), 'from', a.status);$a$,
 $b$-- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  -- QUALIFICATION-BRIEF (owner 2026-11-27): recording the CoE / VoE makes the application Enrolled (its Qualification is created by the
 -- Enrolled trigger); the enrolment date is the issue date
 -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 perform set_config('qualification.enrolment_date', p_issue_date::text, true);
 perform set_config('portal.status_notify', 'off', true);
 -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 perform public.portal_set_application_status(a.id, 'enrolled', left('Enrolled when the ' || case when p_kind = 'voe' then 'VoE' else 'CoE' end || ' was recorded — Enrolment date ' || to_char(p_issue_date, 'DD/MM/YYYY'), 1000));
 perform set_config('portal.status_notify', '', true);
 -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
 update public.enrollment_application_status_history set action_key = 'enrol', payload = jsonb_build_object('enrolment_date', p_issue_date, 'automatic', true)
  -- rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value.
  where id = (select h.id from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = 'enrolled' order by h.created_at desc limit 1);
 return v_out || jsonb_build_object('status', 'enrolled', 'label', public.portal_status_label('enrolled'), 'from', a.status);$b$,
 'issue_coe_voe one step');
