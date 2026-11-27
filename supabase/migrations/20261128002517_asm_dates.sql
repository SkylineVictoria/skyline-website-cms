-- ASM-DATES (owner 2026-11-27): students never enter dates; every assessment date follows these rules, enforced here:
--  1. a student submits only inside the assignment's window: from available_from to the attempt's due date (its own due_at, else
--     the student's due date with any extension), or to late_until when the admin set a later one ("late allowed" without a
--     late_until no longer accepts work after the due date);
--  2. the attempt date is the actual submission date (submitted_at, set by the system); every student date field of the workbook
--     prints it (output.ts), so the student's date fields are neither asked for (asm_template_missing) nor kept (the snapshot drops
--     anything typed in them);
--  3. the trainer's marking / result date (asm_attempts.marked_on, institution time zone) is between the attempt date and today,
--     chosen in the marking view (mark_save / mark_return markedOn), set to the release day when none was chosen, fixed once the
--     result is released; every trainer date field prints it;
--  4. attempts 2 and 3: a resubmission is submitted on or after the day the previous attempt was marked;
--  5. the student's acknowledgement is dated when it is made, on or after the marking date;
--  6. when late work is allowed for the assessment (late_submission = allow), an assignment needs late_until: required on a new
--     assignment and when it is cleared (asm_assignments_late_until); asm_late_allowed(assessment) tells the assignment form.
-- Past rows are never re-checked: the trigger checks only values written from now on. Refusals are check_violation (23514).
-- Down: drop trigger asm_attempts_dates on asm_attempts, asm_attempt_signatures_ack_date on asm_attempt_signatures,
--       asm_assignments_late_until on asm_assignments and their functions, drop function asm_late_allowed(uuid); re-run asm_student / asm_trainer / asm_pdf_snapshot_take / asm_template_missing / asm_attempt_json /
--       asm_attempt_marking from their previous migrations; drop column asm_attempts.marked_on.

alter table public.asm_attempts add column if not exists marked_on date;
comment on column public.asm_attempts.marked_on is 'ASM-DATES: the trainer''s marking / result date (institution time zone), between the attempt''s submission date and the day it was set; printed on every trainer date field of the workbook';

create or replace function public.asm_attempts_dates() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text := public.institution_tz(); v_a public.asm_assignments; v_end timestamptz; v_prev date; v_day date; v_mark date;
begin
 -- 3. the result date: the release day when the trainer chose none; fixed once the result is released
 if new.state in ('returned', 'final') and old.state in ('submitted', 'marking') and new.marked_on is null then
  new.marked_on := (now() at time zone v_tz)::date;
 end if;
 if new.marked_on is distinct from old.marked_on then
  if old.state in ('returned', 'final') and new.state <> 'void' then
   raise exception 'A released result keeps its marking date' using errcode = '42501';
  end if;
  if new.marked_on is not null then
   if new.submitted_at is null then raise exception 'The marking date is set once the attempt is submitted' using errcode = '23514'; end if;
   v_day := (new.submitted_at at time zone v_tz)::date;
   if new.marked_on < v_day then
    raise exception 'The marking date cannot be before the student''s attempt date (%)', to_char(v_day, 'DD/MM/YYYY') using errcode = '23514';
   end if;
   if new.marked_on > (now() at time zone v_tz)::date then
    raise exception 'The marking date cannot be after today' using errcode = '23514';
   end if;
  end if;
 end if;
 -- 1 and 4: the submission
 if new.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
  select * into v_a from public.asm_assignments where id = new.assignment_id;
  if v_a.available_from is not null and new.submitted_at < v_a.available_from then
   raise exception 'This assessment opens on %', to_char(v_a.available_from at time zone v_tz, 'DD/MM/YYYY HH24:MI') using errcode = '23514';
  end if;
  v_end := coalesce(new.due_at, public.asm_due_for(new.assignment_id, new.student_id));
  if v_a.late_until is not null then v_end := greatest(v_end, v_a.late_until); end if;
  if v_end is not null and new.submitted_at > v_end then
   raise exception 'The submission window closed on %', to_char(v_end at time zone v_tz, 'DD/MM/YYYY HH24:MI') using errcode = '23514';
  end if;
  if new.attempt_no > 1 then
   select coalesce(p.marked_on, (p.returned_at at time zone v_tz)::date) into v_prev from public.asm_attempts p
    where p.assignment_id = new.assignment_id and p.student_id = new.student_id and p.attempt_no < new.attempt_no and p.state <> 'void'
    order by p.attempt_no desc limit 1;
   if v_prev is not null and (new.submitted_at at time zone v_tz)::date < v_prev then
    raise exception 'A resubmission is made on or after the day the previous attempt was marked (%)', to_char(v_prev, 'DD/MM/YYYY') using errcode = '23514';
   end if;
  end if;
 end if;
 -- 5. the acknowledgement
 if new.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at then
  v_mark := coalesce(new.marked_on, (new.returned_at at time zone v_tz)::date);
  if v_mark is not null and (new.acknowledged_at at time zone v_tz)::date < v_mark then
   raise exception 'The acknowledgement cannot be dated before the marking date (%)', to_char(v_mark, 'DD/MM/YYYY') using errcode = '23514';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists asm_attempts_dates on public.asm_attempts;
create trigger asm_attempts_dates before update on public.asm_attempts for each row execute function public.asm_attempts_dates();
revoke all on function public.asm_attempts_dates() from public, anon, authenticated;

-- 5. the signed acknowledgement too (asm_sign keeps acknowledged_at when result_acknowledge set it first)
create or replace function public.asm_attempt_signatures_ack_date() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text := public.institution_tz(); v_mark date;
begin
 if new.kind <> 'student_acknowledgement' then return new; end if;
 select coalesce(a.marked_on, (a.returned_at at time zone v_tz)::date) into v_mark from public.asm_attempts a where a.id = new.attempt_id;
 if v_mark is not null and (coalesce(new.signed_at, now()) at time zone v_tz)::date < v_mark then
  raise exception 'The acknowledgement cannot be dated before the marking date (%)', to_char(v_mark, 'DD/MM/YYYY') using errcode = '23514';
 end if;
 return new;
end $$;
drop trigger if exists asm_attempt_signatures_ack_date on public.asm_attempt_signatures;
create trigger asm_attempt_signatures_ack_date before insert on public.asm_attempt_signatures for each row execute function public.asm_attempt_signatures_ack_date();
revoke all on function public.asm_attempt_signatures_ack_date() from public, anon, authenticated;

-- in-place patches (one-line anchors, each found exactly once; a patch already applied is skipped)
create or replace function pg_temp.asm_patch(p_fn regprocedure, p_anchor text, p_new text, p_what text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n integer;
begin
 if position(p_new in d) > 0 then return; end if;
 n := (length(d) - length(replace(d, p_anchor, ''))) / length(p_anchor);
 if n <> 1 then raise exception '% anchor found % times', p_what, n; end if;
 execute replace(d, p_anchor, p_new);
end $$;

-- 1. submit: the same window as the trigger, answered as the usual 'late' error
select pg_temp.asm_patch('public.asm_student(text,jsonb)'::regprocedure,
 $a$if v_now > v_due and (((v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until)) or (v_a.late_until is not null and v_now > v_a.late_until)) then$a$,
 $b$if v_now > greatest(v_due, coalesce(v_a.late_until, v_due)) then$b$,
 'asm_student submit window');

-- 2. the student's date fields: not asked for before Submit, not kept in the snapshot (the PDF prints the submission date)
select pg_temp.asm_patch('public.asm_template_missing(jsonb,jsonb,text[])'::regprocedure,
 $a$  if f->>'kind' = 'signature' then$a$,
 $b$  if f->>'kind' = 'date' then continue; end if; -- ASM-DATES: filled with the submission date
  if f->>'kind' = 'signature' then$b$,
 'asm_template_missing date fields');
select pg_temp.asm_patch('public.asm_pdf_snapshot_take(uuid)'::regprocedure,
 $a$v_answers := jsonb_build_object('pdf', coalesce(t.responses->'pdf', '{}'::jsonb), 'pdfChoice'$a$,
 $b$v_answers := jsonb_build_object('pdf', coalesce(t.responses->'pdf', '{}'::jsonb) - coalesce(array(select f->>'id' from jsonb_array_elements(coalesce(v.template->'fields', '[]'::jsonb)) f where f->>'role' = 'student' and f->>'kind' = 'date'), '{}'::text[]), 'pdfChoice'$b$,
 'asm_pdf_snapshot_take student dates');

-- 3. the trainer's marking date: with the marks (mark_save) or with the decision (mark_return)
select pg_temp.asm_patch('public.asm_trainer(text,jsonb)'::regprocedure,
 $a$    overall_feedback = coalesce(d->>'overallFeedback', overall_feedback) where id = v_id;$a$,
 $b$    marked_on = case when d ? 'markedOn' then nullif(d->>'markedOn', '')::date else marked_on end,
    overall_feedback = coalesce(d->>'overallFeedback', overall_feedback) where id = v_id;$b$,
 'asm_trainer mark_save markedOn');
select pg_temp.asm_patch('public.asm_trainer(text,jsonb)'::regprocedure,
 $a$  v_set := public.asm_effective_settings(v_as.id); v_max := $a$,
 $b$  if nullif(d->>'markedOn', '') is not null then update public.asm_attempts set marked_on = (d->>'markedOn')::date where id = v_id; end if;
  v_set := public.asm_effective_settings(v_as.id); v_max := $b$,
 'asm_trainer mark_return markedOn');

-- the marking date travels with the attempt (the PDF bundle) and with the stored marking of a final PDF
select pg_temp.asm_patch('public.asm_attempt_json(uuid,text)'::regprocedure,
 $a$'acknowledgedAt', t.acknowledged_at,$a$,
 $b$'acknowledgedAt', t.acknowledged_at, 'markedOn', t.marked_on,$b$,
 'asm_attempt_json markedOn');
select pg_temp.asm_patch('public.asm_attempt_marking(uuid)'::regprocedure,
 $a$'outcome', t.outcome, 'overallFeedback', t.overall_feedback,$a$,
 $b$'markedOn', t.marked_on, 'outcome', t.outcome, 'overallFeedback', t.overall_feedback,$b$,
 'asm_attempt_marking markedOn');

-- 6. late submissions: "allowed" means a last moment for late work (late_until) is set on the assignment
create or replace function public.asm_late_allowed(p_assessment uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.asm_assessments a where a.id = p_assessment and public.tenant_scope(a.tenant_id))
   and coalesce(public.asm_effective_settings(p_assessment)->>'late_submission', 'block') = 'allow';
$$;
revoke all on function public.asm_late_allowed(uuid) from public, anon;
grant execute on function public.asm_late_allowed(uuid) to authenticated;

create or replace function public.asm_assignments_late_until() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 -- a new assignment, or late_until cleared (past rows are never re-checked)
 if new.late_until is null and (tg_op = 'INSERT' or old.late_until is not null)
    and coalesce(public.asm_effective_settings(new.assessment_id)->>'late_submission', 'block') = 'allow' then
  raise exception 'Late submissions are allowed for this assessment: set "Late until", the last moment late work is accepted.' using errcode = '23514';
 end if;
 return new;
end $$;
drop trigger if exists asm_assignments_late_until on public.asm_assignments;
create trigger asm_assignments_late_until before insert or update of late_until on public.asm_assignments for each row execute function public.asm_assignments_late_until();
revoke all on function public.asm_assignments_late_until() from public, anon, authenticated;
