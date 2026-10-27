-- P05-03: durable provider operation receipt for asynchronous extraction providers (Azure).
-- A leased worker records the accepted operation id so a retry, lease takeover or crash
-- after acceptance polls the same operation instead of submitting the document again.
-- Kept in its own table, not on the job row: the jobs table is readable by authenticated
-- users, and this receipt is worker-only (RLS on, no policies, service_role only).
--
-- Fencing: the record function only writes while the caller holds the live lease of a
-- 'processing' job, so a stale or cancelled worker cannot plant or clear a receipt.
-- A trigger removes the receipt on every terminal state (succeeded, failed = dead letter,
-- cancelled), so no code path has to remember to clear it and it never outlives the job.
--
-- Rollback / compensation (additive, nothing else depends on it; run manually if needed):
--   drop trigger if exists enrollment_document_job_clear_operation on public.enrollment_document_extraction_jobs;
--   drop function if exists public.portal_clear_document_job_operation();
--   drop function if exists public.portal_record_document_job_operation(uuid, uuid, text, text);
--   drop table if exists public.enrollment_document_extraction_operations;
-- Without the table the worker treats an absent receipt as "none" and resubmits, which only
-- costs one repeat analysis. Never applied to the hosted project without release approval.
begin;

create table if not exists public.enrollment_document_extraction_operations (
  job_id uuid primary key references public.enrollment_document_extraction_jobs(id) on delete cascade,
  provider_engine text not null check (provider_engine ~ '^[a-z][a-z0-9_-]{0,63}$'),
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  recorded_at timestamptz not null default now()
);
alter table public.enrollment_document_extraction_operations enable row level security;
revoke all on public.enrollment_document_extraction_operations from public, anon, authenticated;
grant select on public.enrollment_document_extraction_operations to service_role;

create or replace function public.portal_record_document_job_operation(p_job uuid, p_lease uuid, p_engine text, p_operation text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_job public.enrollment_document_extraction_jobs;
begin
  select * into v_job from public.enrollment_document_extraction_jobs where id = p_job for update;
  if not found or v_job.state <> 'processing' or p_lease is null or v_job.lease_token is distinct from p_lease
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then return false; end if;
  if p_operation is null then
    delete from public.enrollment_document_extraction_operations where job_id = p_job;
  else
    insert into public.enrollment_document_extraction_operations(job_id, provider_engine, operation_id)
    values (p_job, p_engine, p_operation)
    on conflict (job_id) do update set provider_engine = excluded.provider_engine, operation_id = excluded.operation_id, recorded_at = now();
  end if;
  return true;
end;
$$;
revoke all on function public.portal_record_document_job_operation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.portal_record_document_job_operation(uuid, uuid, text, text) to service_role;

create or replace function public.portal_clear_document_job_operation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.enrollment_document_extraction_operations where job_id = new.id;
  return new;
end;
$$;
revoke all on function public.portal_clear_document_job_operation() from public, anon, authenticated;

drop trigger if exists enrollment_document_job_clear_operation on public.enrollment_document_extraction_jobs;
create trigger enrollment_document_job_clear_operation
  after update of state on public.enrollment_document_extraction_jobs
  for each row when (new.state in ('succeeded', 'failed', 'cancelled') and old.state is distinct from new.state)
  execute function public.portal_clear_document_job_operation();

commit;
