-- LMS-BATCHES (2026-11-25, found in the hosted probe): a batch without its own trainer was treated as taught by the intake's trainers,
-- so a second batch at the same time "clashed" with B1's trainer. The clash check now works out a class's trainers per batch: the class's
-- trainer, else the batch's default trainer, else the batch's trainers (intake_trainers.batch_id), else — for the intake's first batch
-- only — the intake unit's trainer.
-- Down: drop function public.session_trainer_ids_b(uuid, uuid, text); re-run class_session_clash_ex from 20261125031517.
begin;

create function public.session_trainer_ids_b(p_trainer uuid, p_batch uuid, p_unit text) returns uuid[]
language sql stable security definer set search_path to 'public' as $$
  select case when p_trainer is not null then array[p_trainer] else coalesce(
    (select array[b.default_trainer_id] from public.intake_batches b where b.id = p_batch and b.default_trainer_id is not null),
    (select array_agg(t.staff_id) from public.intake_trainers t where t.batch_id = p_batch),
    (select array[iu.trainer_id] from public.intake_batches b join public.intake_units iu on iu.intake_id = b.intake_id
      where b.id = p_batch and iu.unit_id = p_unit and iu.trainer_id is not null and public.intake_first_batch(b.intake_id) = b.id limit 1),
    '{}'::uuid[]) end;
$$;
grant execute on function public.session_trainer_ids_b(uuid, uuid, text) to authenticated;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.class_session_clash_ex(uuid, uuid, text, uuid, uuid, date, time, time, uuid)'::regprocedure);
  if position('public.session_trainer_ids(p_trainer, p_intake, p_unit)' in d) = 0 or position('public.session_trainer_ids(c.trainer_id, c.intake_id, c.unit_id)' in d) = 0 then
    raise exception 'class_session_clash_ex: trainer lookups not found';
  end if;
  d := replace(d, 'public.session_trainer_ids(p_trainer, p_intake, p_unit)', 'public.session_trainer_ids_b(p_trainer, v_batch, p_unit)');
  d := replace(d, 'public.session_trainer_ids(c.trainer_id, c.intake_id, c.unit_id)', 'public.session_trainer_ids_b(c.trainer_id, c.batch_id, c.unit_id)');
  execute d;
end $$;

commit;
