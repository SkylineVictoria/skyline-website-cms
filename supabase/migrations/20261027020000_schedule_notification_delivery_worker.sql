-- Migration 88: run the notification-delivery worker every minute (pg_cron + pg_net), authenticated with the service-role key from Vault.
-- The key is never in this file, the job command or any log: the job only runs `select public.notification_dispatch_worker();`, which reads the
-- Vault secret named notification_service_role_key at run time and sends it as `Authorization: Bearer <key>`.
--
-- ONE-TIME SETUP (run once in the Supabase SQL editor of project xcpydisstlvtvcsqnjob, pasting the service_role key from Project Settings > API;
-- do not save that statement anywhere):
--   select vault.create_secret('<paste service_role key>', 'notification_service_role_key', 'notification-delivery worker');
-- Rotate:  select vault.update_secret((select id from vault.secrets where name = 'notification_service_role_key'), '<new key>');
-- Without the secret the job is a no-op (it returns before any HTTP call).
--
-- PAUSE / RESUME / STOP:
--   select cron.alter_job((select jobid from cron.job where jobname = 'notification-delivery-worker'), active := false);  -- pause (true = resume)
--   select cron.unschedule('notification-delivery-worker');                                                                -- remove
-- Sending itself is still governed by EF_NOTIFICATION_EMAIL_ENABLED = "true" and EF_POSTMARK_SERVER_TOKEN (the function answers 503 before claiming
-- anything otherwise) and by the migration 84 activation/suppression rules, which this migration does not touch.
--
-- Rollback: select cron.unschedule('notification-delivery-worker'); drop function public.notification_dispatch_worker(); drop table public.notification_dispatch_state;
begin;

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- One row: the last request this scheduler issued, so a slow run is not overlapped by the next minute's call.
create table public.notification_dispatch_state(
  id boolean primary key default true check (id),
  last_request_id bigint,
  last_dispatched_at timestamptz
);
alter table public.notification_dispatch_state enable row level security;
revoke all on public.notification_dispatch_state from public, anon, authenticated, service_role;

create function public.notification_dispatch_worker() returns bigint
language plpgsql security definer set search_path = public, vault, net as $$
declare v_key text; v_last public.notification_dispatch_state; v_id bigint;
begin
  -- Never two dispatchers at once.
  if not pg_try_advisory_xact_lock(9342, 20261027) then return null; end if;
  -- Only call when there is something the worker could claim (due pending deliveries, or an expired lease it recovers).
  if not exists (select 1 from public.notification_deliveries where state = 'pending' and next_attempt_at <= now())
     and not exists (select 1 from public.notification_deliveries where state = 'sending' and lease_expires_at < now()) then return null; end if;
  -- Skip while the previous request has no response yet (give up waiting after 5 minutes).
  select * into v_last from public.notification_dispatch_state;
  if v_last.last_request_id is not null and v_last.last_dispatched_at > now() - interval '5 minutes'
     and not exists (select 1 from net._http_response r where r.id = v_last.last_request_id) then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notification_service_role_key' limit 1;
  if nullif(v_key, '') is null then return null; end if;
  v_id := net.http_post(
    url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/notification-delivery',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
  insert into public.notification_dispatch_state(id, last_request_id, last_dispatched_at) values (true, v_id, now())
  on conflict (id) do update set last_request_id = excluded.last_request_id, last_dispatched_at = excluded.last_dispatched_at;
  return v_id;
end;
$$;
revoke all on function public.notification_dispatch_worker() from public, anon, authenticated, service_role;
grant execute on function public.notification_dispatch_worker() to postgres;

-- Idempotent: alter the named job when it exists, schedule it otherwise (never recreated or duplicated).
do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'notification-delivery-worker' order by jobid limit 1;
  if v_job_id is null then
    perform cron.schedule('notification-delivery-worker', '* * * * *', 'select public.notification_dispatch_worker();');
  else
    perform cron.alter_job(v_job_id, schedule := '* * * * *', command := 'select public.notification_dispatch_worker();');
  end if;
end;
$$;

commit;
