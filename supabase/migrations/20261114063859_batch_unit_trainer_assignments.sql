-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261114063859),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
create table if not exists public.batch_unit_trainers (
 batch_id uuid not null references public.batches(id) on delete cascade,
 intake_unit_id uuid not null references public.intake_units(id) on delete cascade,
 staff_id uuid not null,
 updated_at timestamptz not null default now(),
 primary key(batch_id,intake_unit_id)
);
create index if not exists batch_unit_trainers_staff_idx on public.batch_unit_trainers(staff_id);
alter table public.batch_unit_trainers enable row level security;
revoke all on public.batch_unit_trainers from anon,authenticated;
create or replace function public.rto_batch_unit_trainer(p_batch_id uuid,p_intake_unit_id uuid,p_staff_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
 if not public.cms_is_staff() then raise exception 'Sign in first' using errcode='42501'; end if;
 if not exists(select 1 from public.batches b join public.intake_units u on u.intake_id=b.intake_id where b.id=p_batch_id and u.id=p_intake_unit_id) then raise exception 'Unit is not part of batch intake'; end if;
 if p_staff_id is null then
  if not public.cms_is_rto_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  delete from public.batch_unit_trainers where batch_id=p_batch_id and intake_unit_id=p_intake_unit_id;
 else
  if not public.cms_is_rto_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if not exists(select 1 from public.batch_trainers where batch_id=p_batch_id and staff_id=p_staff_id) then raise exception 'Assign trainer to batch first' using errcode='22023'; end if;
  insert into public.batch_unit_trainers(batch_id,intake_unit_id,staff_id) values(p_batch_id,p_intake_unit_id,p_staff_id)
  on conflict(batch_id,intake_unit_id) do update set staff_id=excluded.staff_id,updated_at=now();
 end if;
 return jsonb_build_object('trainerId',p_staff_id);
end $$;
create or replace function public.rto_batch_unit_trainers_get(p_batch_id uuid)
returns jsonb language sql security definer set search_path=public as $$
 select case when public.cms_is_staff() then coalesce((select jsonb_object_agg(intake_unit_id::text,staff_id::text) from public.batch_unit_trainers where batch_id=p_batch_id),'{}'::jsonb) else '{}'::jsonb end
$$;
revoke all on function public.rto_batch_unit_trainer(uuid,uuid,uuid) from public;
revoke all on function public.rto_batch_unit_trainers_get(uuid) from public;
grant execute on function public.rto_batch_unit_trainer(uuid,uuid,uuid) to authenticated;
grant execute on function public.rto_batch_unit_trainers_get(uuid) to authenticated;
