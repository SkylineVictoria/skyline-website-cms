-- The hourly clean-up of hidden wizard intakes is no longer needed: intakes are created only when the course wizard is finished (a repeated Finish discards leftovers).
do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname = 'intake-wizard-cleanup';
 end if;
end $$;
drop function if exists public.intake_wizard_cleanup();
