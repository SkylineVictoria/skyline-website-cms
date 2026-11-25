-- LMS-BATCHES step 1 (2026-11-25, owner: "SLIT CRM/LMS Revised Batch Student Flow"; reverses INTAKE-REPLACES-BATCH of 2026-11-19 on the
-- owner's go): an intake (CoE or VoE, following its Master) holds one or more class batches B1 / B2 / B3. A batch carries its own room,
-- seats and default trainer and is archived, never deleted. Every intake gets B1 (backfilled here, made automatically for new intakes).
-- Read like intake_class_times (Admins / RTO Managers); written only through security-definer functions.
-- Down: drop trigger course_intakes_default_batch on public.course_intakes; drop function public.course_intakes_default_batch();
--       drop function public.intake_default_batch(uuid); drop function public.intake_first_batch(uuid); drop table public.intake_batches;
begin;

create table public.intake_batches (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.course_intakes(id) on delete restrict,
  code text not null check (code ~ '^[A-Za-z0-9-]{1,10}$'),
  name text check (name is null or char_length(name) <= 120),
  room_id uuid references public.classrooms(id) on delete set null,
  capacity integer check (capacity is null or capacity between 1 and 1000),
  default_trainer_id uuid,
  sort integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index intake_batches_code_key on public.intake_batches (intake_id, lower(code));
create index intake_batches_intake_idx on public.intake_batches (intake_id, sort) where archived_at is null;

alter table public.intake_batches enable row level security;
create policy intake_batches_staff_read on public.intake_batches for select using (public.cms_is_admin() or public.cms_is_rto_manager());
grant select on public.intake_batches to authenticated;

-- The intake's first live batch (read-only; null when it has none).
create function public.intake_first_batch(p_intake uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select b.id from public.intake_batches b where b.intake_id = p_intake and b.archived_at is null order by b.sort, b.code limit 1;
$$;

-- The intake's first live batch, made as B1 from the intake's room, seats and first trainer when it has none.
create function public.intake_default_batch(p_intake uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare v uuid; i public.course_intakes;
begin
  v := public.intake_first_batch(p_intake);
  if v is not null then return v; end if;
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  insert into public.intake_batches (intake_id, code, name, room_id, capacity, default_trainer_id, sort)
  values (i.id, 'B1', 'Batch 1', i.classroom_id, i.capacity,
          (select t.staff_id from public.intake_trainers t where t.intake_id = i.id order by t.staff_id limit 1), 1)
  on conflict (intake_id, (lower(code))) do nothing;
  return coalesce(public.intake_first_batch(p_intake),
                  (select b.id from public.intake_batches b where b.intake_id = p_intake and lower(b.code) = 'b1'));
end $$;

create function public.course_intakes_default_batch() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.intake_default_batch(new.id);
  return null;
end $$;
create trigger course_intakes_default_batch after insert on public.course_intakes
  for each row execute function public.course_intakes_default_batch();

revoke all on function public.intake_default_batch(uuid), public.course_intakes_default_batch() from public, anon, authenticated;
grant execute on function public.intake_first_batch(uuid) to authenticated;

select public.intake_default_batch(id) from public.course_intakes;

commit;
