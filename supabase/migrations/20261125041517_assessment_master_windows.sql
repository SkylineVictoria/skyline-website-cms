-- LMS-BATCHES step 8 (2026-11-25): assessment windows come from the Master unit dates, not class sessions. An assignment for an intake
-- is linked to the intake's unit (asm_assignments.intake_unit_id, from the assessment's unit); when no dates are given it opens at the
-- unit's Master start (00:00) and is due at its Master end (23:59), institution time zone. Dates stay editable (owner): an assignment
-- whose dates match the Master (window_from_master) follows later Master date changes; editing them by hand stops that.
-- reassign_rule 'follow_batch' becomes 'follow_master' (default; existing values moved).
-- Down: drop triggers a0_master_window / asm_assignments_window_edited / intake_units_asm_windows and their functions; drop function
--       public.asm_master_window(uuid, uuid); restore the check with 'follow_batch', default 'follow_batch', update the values back;
--       re-run asm_admin / asm_batch_enrolment_change with 'follow_batch' and the dueAt requirement; drop the two columns.
begin;

create or replace function pg_temp.fpatch(p_name text, p_lit text, p_new text, p_expect int default 1) returns void
language plpgsql as $$
declare v_oid oid; d text; pat text; n int;
begin
  select p.oid into strict v_oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_name;
  d := pg_get_functiondef(v_oid);
  pat := regexp_replace(regexp_replace(p_lit, '([.*+?^${}()|\[\]\\])', '\\\1', 'g'), ' ', '\s+', 'g');
  select count(*) into n from regexp_matches(d, pat, 'g');
  if n <> p_expect then raise exception 'fpatch %: expected % match(es) of [%], found %', p_name, p_expect, p_lit, n; end if;
  execute regexp_replace(d, pat, replace(p_new, '\', '\\'), 'g');
end $$;

alter table public.asm_assignments
  add column intake_unit_id uuid references public.intake_units(id),
  add column window_from_master boolean not null default false;
create index asm_assignments_intake_unit_idx on public.asm_assignments (intake_unit_id);

alter table public.asm_assignments drop constraint asm_assignments_reassign_rule_check;
update public.asm_assignments set reassign_rule = 'follow_master' where reassign_rule = 'follow_batch';
alter table public.asm_assignments add constraint asm_assignments_reassign_rule_check check (reassign_rule in ('follow_master', 'keep'));
alter table public.asm_assignments alter column reassign_rule set default 'follow_master';

-- The intake unit an assessment belongs to and its Master window.
create function public.asm_master_window(p_assessment uuid, p_intake uuid)
returns table (intake_unit_id uuid, opens_at timestamptz, closes_at timestamptz, master_kind text, master_cycle integer, start_date date, end_date date)
language sql stable security definer set search_path to 'public' as $$
  select iu.id,
         (iu.start_date::timestamp) at time zone public.institution_tz(),
         ((iu.end_date::timestamp) + interval '23 hours 59 minutes') at time zone public.institution_tz(),
         iu.master_kind, iu.master_cycle, iu.start_date, iu.end_date
    from public.asm_assessments a join public.intake_units iu on iu.unit_id = a.unit_id and iu.intake_id = p_intake
   where a.id = p_assessment
   limit 1;
$$;
grant execute on function public.asm_master_window(uuid, uuid) to authenticated;

create function public.asm_assignments_master_window() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare w record;
begin
  if new.intake_id is null then return new; end if;
  select * into w from public.asm_master_window(new.assessment_id, new.intake_id);
  if w.intake_unit_id is not null then
    new.intake_unit_id := coalesce(new.intake_unit_id, w.intake_unit_id);
    if tg_op = 'INSERT' then
      new.available_from := coalesce(new.available_from, w.opens_at);
      new.due_at := coalesce(new.due_at, w.closes_at);
      new.window_from_master := (new.available_from = w.opens_at and new.due_at = w.closes_at);
    end if;
  end if;
  if new.due_at is null then raise exception 'Choose a due date (this unit has no Master dates in the intake).' using errcode = '22023'; end if;
  if new.available_from is null then new.available_from := now(); end if;
  return new;
end $$;
create trigger a0_master_window before insert or update of intake_id, assessment_id on public.asm_assignments
  for each row execute function public.asm_assignments_master_window();

-- A hand edit of the dates stops following the Master.
create function public.asm_assignments_window_edited() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if coalesce(current_setting('lms.asm_master_sync', true), '') <> 'on'
     and (new.available_from is distinct from old.available_from or new.due_at is distinct from old.due_at) then
    new.window_from_master := false;
  end if;
  return new;
end $$;
create trigger asm_assignments_window_edited before update of available_from, due_at on public.asm_assignments
  for each row execute function public.asm_assignments_window_edited();

-- Master dates changed for an intake unit: open assignments still on the Master window move with it.
create function public.intake_units_asm_windows() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_open timestamptz; v_close timestamptz;
begin
  if new.start_date is not distinct from old.start_date and new.end_date is not distinct from old.end_date then return null; end if;
  v_open := (new.start_date::timestamp) at time zone public.institution_tz();
  v_close := ((new.end_date::timestamp) + interval '23 hours 59 minutes') at time zone public.institution_tz();
  perform set_config('lms.asm_master_sync', 'on', true);
  update public.asm_assignments a
     set available_from = v_open, due_at = v_close, late_until = case when a.late_until is not null and a.late_until < v_close then v_close else a.late_until end
   where a.intake_unit_id = new.id and a.window_from_master and a.reassign_rule = 'follow_master' and a.status = 'open';
  perform set_config('lms.asm_master_sync', '', true);
  return null;
end $$;
create trigger intake_units_asm_windows after update of start_date, end_date on public.intake_units
  for each row execute function public.intake_units_asm_windows();

revoke all on function public.asm_assignments_master_window(), public.asm_assignments_window_edited(), public.intake_units_asm_windows() from public, anon, authenticated;

-- Create from the CMS: no dates given = the Master window; default rule follow_master.
select pg_temp.fpatch('asm_admin', 'v_due := public.asm_json_ts(d, ''dueAt''); if v_due is null then raise exception ''dueAt is required'' using errcode = ''22023''; end if;',
  'v_due := public.asm_json_ts(d, ''dueAt'');');
select pg_temp.fpatch('asm_admin', 'values (v_as.id, v_ver.id, v_bid, coalesce(public.asm_json_ts(d, ''availableFrom''), now()), v_due,',
  'values (v_as.id, v_ver.id, v_bid, public.asm_json_ts(d, ''availableFrom''), v_due,');
select pg_temp.fpatch('asm_admin', 'coalesce(d->>''reassignRule'', ''follow_batch'')',
  'case when d->>''reassignRule'' = ''keep'' then ''keep'' else ''follow_master'' end');
select pg_temp.fpatch('asm_batch_enrolment_change', 'x.reassign_rule = ''follow_batch''', 'x.reassign_rule = ''follow_master''');

-- Link existing assignments (none on hosted today).
update public.asm_assignments a set intake_unit_id = (select w.intake_unit_id from public.asm_master_window(a.assessment_id, a.intake_id) w)
 where a.intake_unit_id is null and a.intake_id is not null;

commit;
