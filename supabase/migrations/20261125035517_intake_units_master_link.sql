-- LMS-BATCHES step 6 (2026-11-25): an intake's units point at the Master unit they inherit — CoE Master for CoE intakes, VoE Master for
-- VoE intakes (falls back to the CoE Master while the course has no VoE calendar). intake_units.master_kind / master_cycle /
-- master_unit_id (course_coe_units.id or course_voe_units.id; checked by the lock trigger, no foreign key so a Master can be rebuilt).
-- Fixes: VoE intakes used to take CoE dates. Unit dates, sort and the intake's start / end stay locked to their Master; saving the VoE
-- calendar re-applies it to the course's open VoE intakes at the end of the save.
-- Down: drop the trigger course_voe_units_apply and function course_voe_units_apply(); restore course_master_lock_unit,
--       course_master_lock_intake and course_master_apply_intake from 20261125034517; drop the helper functions and the three columns.
begin;

alter table public.intake_units
  add column master_kind text check (master_kind is null or master_kind in ('coe', 'voe')),
  add column master_cycle integer check (master_cycle is null or master_cycle >= 1),
  add column master_unit_id uuid;
create index intake_units_master_unit_idx on public.intake_units (master_unit_id);

-- Which Master an intake follows.
create function public.course_master_kind_for(p_course text, p_study_load text) returns text
language sql stable security definer set search_path to 'public' as $$
  select case when lower(coalesce(p_study_load, 'coe')) = 'voe'
               and exists (select 1 from public.course_voe_units v where v.course_id = p_course) then 'voe' else 'coe' end;
$$;

-- The running cycle of a Master: the earliest not ended, else the last.
create function public.course_master_cycle_for(p_course text, p_kind text) returns integer
language sql stable security definer set search_path to 'public' as $$
  with c as (
    select cycle, max(end_date) as last_day from public.course_coe_units where p_kind = 'coe' and course_id = p_course group by cycle
    union all
    select cycle, max(end_date) from public.course_voe_units where p_kind = 'voe' and course_id = p_course group by cycle)
  select coalesce((select min(cycle) from c where last_day >= public.course_intake_today()), (select max(cycle) from c), 1);
$$;

-- One Master's unit rows for a cycle.
create function public.course_master_rows(p_course text, p_kind text, p_cycle integer)
returns table (id uuid, unit_id text, start_date date, end_date date, sort integer, cycle integer)
language sql stable security definer set search_path to 'public' as $$
  select m.id, m.unit_id, m.start_date, m.end_date, m.sort, m.cycle from public.course_coe_units m
   where p_kind = 'coe' and m.course_id = p_course and m.cycle = p_cycle
  union all
  select v.id, v.unit_id, v.start_date, v.end_date, v.sort, v.cycle from public.course_voe_units v
   where p_kind = 'voe' and v.course_id = p_course and v.cycle = p_cycle and v.start_date is not null and v.end_date is not null;
$$;

-- The Master unit an intake's unit inherits.
create function public.intake_master_unit(p_intake uuid, p_unit text)
returns table (kind text, cycle integer, id uuid, start_date date, end_date date, sort integer)
language sql stable security definer set search_path to 'public' as $$
  with i as (select ci.course_id, public.course_master_kind_for(ci.course_id, ci.study_load) as kind from public.course_intakes ci where ci.id = p_intake)
  select i.kind, r.cycle, r.id, r.start_date, r.end_date, r.sort
    from i cross join lateral public.course_master_rows(i.course_id, i.kind, public.course_master_cycle_for(i.course_id, i.kind)) r
   where r.unit_id = p_unit;
$$;

create or replace function public.course_master_lock_unit() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare m record;
begin
  if exists (select 1 from public.course_intakes ci where ci.id = new.intake_id and coalesce(ci.status, 'open') = 'closed') then return new; end if;
  select * into m from public.intake_master_unit(new.intake_id, new.unit_id) limit 1;
  if m.id is not null then
    new.start_date := m.start_date; new.end_date := m.end_date; new.sort := m.sort;
    new.master_kind := m.kind; new.master_cycle := m.cycle; new.master_unit_id := m.id;
  end if;
  return new;
end $$;

create or replace function public.course_master_lock_intake() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_first date; v_last date; v_kind text;
begin
  if coalesce(new.status, 'open') = 'closed' then return new; end if;
  v_kind := public.course_master_kind_for(new.course_id, new.study_load);
  select min(r.start_date), max(r.end_date) into v_first, v_last
    from public.course_master_rows(new.course_id, v_kind, public.course_master_cycle_for(new.course_id, v_kind)) r;
  if v_first is not null then new.start_date := v_first; new.end_date := v_last; end if;
  return new;
end $$;

create or replace function public.course_master_apply_intake(p_intake uuid) returns date
language plpgsql security definer set search_path to 'public' as $$
declare i public.course_intakes; v_first date; v_last date; v_kind text; v_cycle integer;
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_kind := public.course_master_kind_for(i.course_id, i.study_load);
  v_cycle := public.course_master_cycle_for(i.course_id, v_kind);
  select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_rows(i.course_id, v_kind, v_cycle) m;
  if v_first is null then return null; end if;
  delete from public.intake_units iu where iu.intake_id = p_intake
    and not exists (select 1 from public.course_master_rows(i.course_id, v_kind, v_cycle) m where m.unit_id = iu.unit_id);
  update public.intake_units iu
     set start_date = m.start_date, end_date = m.end_date, sort = m.sort, master_kind = v_kind, master_cycle = m.cycle, master_unit_id = m.id
    from public.course_master_rows(i.course_id, v_kind, v_cycle) m
   where m.unit_id = iu.unit_id and iu.intake_id = p_intake
     and (iu.start_date <> m.start_date or iu.end_date <> m.end_date or iu.sort <> m.sort or iu.master_unit_id is distinct from m.id);
  insert into public.intake_units (intake_id, unit_id, start_date, end_date, hours, sort, master_kind, master_cycle, master_unit_id)
  select p_intake, m.unit_id, m.start_date, m.end_date, u.nominal_hours, m.sort, v_kind, m.cycle, m.id
    from public.course_master_rows(i.course_id, v_kind, v_cycle) m join public.cms_course_units u on u.id = m.unit_id
   where not exists (select 1 from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = m.unit_id);
  update public.course_intakes set start_date = v_first, end_date = v_last, updated_at = now()
   where id = p_intake and (start_date <> v_first or end_date is distinct from v_last);
  return v_last;
end $$;

-- Saving the VoE calendar re-applies it to the course's open VoE intakes (once the whole save is in).
create function public.course_voe_units_apply() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare r record; v_course text := case when tg_op = 'DELETE' then old.course_id else new.course_id end;
begin
  for r in select ci.id from public.course_intakes ci
            where ci.course_id = v_course and lower(coalesce(ci.study_load, '')) = 'voe' and coalesce(ci.status, 'open') <> 'closed' loop
    perform public.course_master_apply_intake(r.id);
  end loop;
  return null;
end $$;
create constraint trigger course_voe_units_apply after insert or update or delete on public.course_voe_units
  deferrable initially deferred for each row execute function public.course_voe_units_apply();

revoke all on function public.course_voe_units_apply() from public, anon, authenticated;
grant execute on function public.course_master_kind_for(text, text), public.course_master_cycle_for(text, text),
  public.course_master_rows(text, text, integer), public.intake_master_unit(uuid, text) to authenticated;

-- Link and re-date every open intake from its own Master.
select public.course_master_apply_intake(ci.id) from public.course_intakes ci where coalesce(ci.status, 'open') <> 'closed';

commit;
