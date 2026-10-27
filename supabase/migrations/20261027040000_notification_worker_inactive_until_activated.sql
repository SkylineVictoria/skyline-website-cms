-- Migration 90: the notification-delivery-worker cron job (migration 88) is inactive until the owner activates it.
-- The owner turns it on with cron.alter_job(jobid, active := true) together with approving sending, storing the Vault key and deploying the function:
--   select cron.alter_job((select jobid from cron.job where jobname = 'notification-delivery-worker'), active := true);
-- Migration 88 stays as applied; this only flips the flag. Idempotent, and a no-op when the job does not exist. Schedule and command are untouched.
-- Rollback: select cron.alter_job((select jobid from cron.job where jobname = 'notification-delivery-worker'), active := true);
begin;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'notification-delivery-worker' order by jobid limit 1;
  if v_job_id is not null then
    perform cron.alter_job(v_job_id, active := false);
  end if;
end;
$$;

commit;
