-- INTAKE-REPLACES-BATCH stage 2a: a batch's id is its intake's id. Then every batch_id already in the data, and every batchId
-- the current screens send, is the intake id, so stage 2b can switch the database functions to the intake side without breaking
-- the screens, and stage 3 can rename the keys. The re-key ran on hosted 2026-11-19 through MCP (2 batches; 526 classes,
-- 12 class times, 1 trainer moved; checked: every batch id = its intake id, no orphan rows); it is idempotent here.
-- New batches made by the old functions before stage 2b take the intake id too, and a second one per intake is refused.
begin;

do $$ declare m record;
begin
  set local session_replication_role = replica;  -- FKs to batches have no ON UPDATE CASCADE; integrity checked below
  for m in select id old_id, intake_id new_id from public.batches where id <> intake_id loop
    update public.batches set id = m.new_id where id = m.old_id;
    update public.class_sessions set batch_id = m.new_id where batch_id = m.old_id;
    update public.batch_sessions set batch_id = m.new_id where batch_id = m.old_id;
    update public.batch_trainers set batch_id = m.new_id where batch_id = m.old_id;
    update public.batch_unit_trainers set batch_id = m.new_id where batch_id = m.old_id;
    update public.batch_unit_overrides set batch_id = m.new_id where batch_id = m.old_id;
    update public.batch_enrolments set batch_id = m.new_id where batch_id = m.old_id;
    update public.lms_attendance_register set batch_id = m.new_id where batch_id = m.old_id;
    update public.asm_assignments set batch_id = m.new_id where batch_id = m.old_id;
    update public.asm_unit_outcomes set batch_id = m.new_id where batch_id = m.old_id;
    update public.course_completions set batch_id = m.new_id where batch_id = m.old_id;
    update public.rto_placement_overrides set batch_id = m.new_id where batch_id = m.old_id;
    update public.sign_batch_sends set batch_id = m.new_id where batch_id = m.old_id;
  end loop;
  if exists (select 1 from public.batches where id <> intake_id)
     or exists (select 1 from public.class_sessions c where not exists (select 1 from public.batches b where b.id = c.batch_id)) then
    raise exception 're-key integrity check failed';
  end if;
end $$;

create or replace function public.intake_bridge_batch_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.batches where intake_id = new.intake_id) then
    raise exception 'An intake is one class group: it already has its room, trainer and class times.' using errcode = '23505';
  end if;
  new.id := new.intake_id;
  return new;
end $$;
drop trigger if exists aa_intake_bridge_batch_id on public.batches;
create trigger aa_intake_bridge_batch_id before insert on public.batches for each row execute function public.intake_bridge_batch_id();
revoke all on function public.intake_bridge_batch_id() from public, anon, authenticated;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261119211500', 'intake_replaces_batch_stage2a', array['see repo file']) on conflict do nothing;
commit;
