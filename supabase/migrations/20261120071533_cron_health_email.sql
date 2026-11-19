-- The daily scheduled-job health check also emails its flags (owner 2026-11-20): to gourav.gupta@slit.edu.au, at most once a day,
-- through the existing notification queue (public.notification_deliveries). No new cron: the daily check (cron-http-health) queues the
-- email; the existing every-minute support-ticket-mail job (support_mail_dispatch -> email-sender) sends it like a support reply
-- (no tenant, no portal user, default template; HTML from email_html_wrap).
--   * event 'ops_cron_health'; the queue's subject rule (notification_deliveries_subject_ref) now also admits 'ops_%' events.
--   * public.cron_health_mails holds one row per day: a second check on the same day (or a re-run) never queues another email.
-- To change the recipient: create or replace public.cron_health_mail_to().
set local lock_timeout = '5s';

alter table public.notification_deliveries drop constraint if exists notification_deliveries_subject_ref;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref check (application_id is not null or support_ticket_id is not null
 or booking_id is not null or assessment_event_id is not null or event like 'support_ticket%' or hub_message_id is not null or event like 'ops\_%') not valid;

create table if not exists public.cron_health_mails(
 day date primary key,
 delivery_id uuid references public.notification_deliveries(id) on delete set null,
 jobs integer not null,
 created_at timestamptz not null default now()
);
alter table public.cron_health_mails enable row level security;
revoke all on public.cron_health_mails from public, anon, authenticated;
comment on table public.cron_health_mails is 'One flag-summary email per day at most (cron_http_health_check).';

create or replace function public.cron_health_mail_to() returns text language sql immutable as $f$ select 'gourav.gupta@slit.edu.au'::text $f$;
revoke all on function public.cron_health_mail_to() from public, anon, authenticated;

-- Daily: jobs with p_min_failures or more failed calls in the last p_hours hours are flagged (one row per job per day) and, when any is
-- flagged, one summary email is queued for the day.
create or replace function public.cron_http_health_check(p_hours integer default 24, p_min_failures integer default 3) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_flags jsonb; v_n integer; v_body text; v_delivery uuid; v_mailed boolean := false;
begin
 perform public.cron_http_collect();
 insert into public.cron_health_flags(job, day, calls, failures, last_status, last_detail, first_failure_at, last_failure_at)
 select c.job, current_date, count(*), count(*) filter (where c.failed),
  (array_agg(c.status_code order by c.called_at desc) filter (where c.failed))[1], (array_agg(c.detail order by c.called_at desc) filter (where c.failed))[1],
  min(c.called_at) filter (where c.failed), max(c.called_at) filter (where c.failed)
 from public.cron_http_calls c where c.called_at >= now() - make_interval(hours => greatest(p_hours, 1)) and c.collected_at is not null
 group by c.job having count(*) filter (where c.failed) >= greatest(p_min_failures, 1)
 on conflict (job, day) do update set calls = excluded.calls, failures = excluded.failures, last_status = excluded.last_status, last_detail = excluded.last_detail,
  first_failure_at = excluded.first_failure_at, last_failure_at = excluded.last_failure_at, created_at = now();
 select count(*), coalesce(jsonb_agg(jsonb_build_object('job', f.job, 'calls', f.calls, 'failures', f.failures, 'lastStatus', f.last_status) order by f.job), '[]'::jsonb)
 into v_n, v_flags from public.cron_health_flags f where f.day = current_date;
 -- The email: at most once a day (the day's row is claimed first; a second run finds it and queues nothing).
 if v_n > 0 then
  insert into public.cron_health_mails(day, jobs) values (current_date, v_n) on conflict (day) do nothing;
  if found then
   select string_agg(format('- %s: %s of %s calls failed in the last %s hours (first %s UTC, last %s UTC), last answer %s%s', f.job, f.failures, f.calls, greatest(p_hours, 1),
     to_char(f.first_failure_at at time zone 'UTC', 'DD Mon HH24:MI'), to_char(f.last_failure_at at time zone 'UTC', 'DD Mon HH24:MI'),
     coalesce(f.last_status::text, 'none'), coalesce(': ' || nullif(left(regexp_replace(f.last_detail, '\s+', ' ', 'g'), 160), ''), '')), E'\n' order by f.job)
   into v_body from public.cron_health_flags f where f.day = current_date;
   insert into public.notification_deliveries(recipient_email, event, template_source, subject, body)
   values (public.cron_health_mail_to(), 'ops_cron_health', 'default',
    format('Scheduled jobs failing: %s (%s)', v_n, to_char(current_date, 'DD Mon YYYY')),
    'The daily check of the scheduled jobs that call Edge Functions found ' || v_n || ' job' || case when v_n = 1 then '' else 's' end
     || ' with ' || greatest(p_min_failures, 1) || ' or more calls without a normal (2xx) answer in the last ' || greatest(p_hours, 1) || E' hours:\n\n' || v_body
     || E'\n\nThe CMS dashboard shows them under Needs action today > Scheduled jobs failing. Each call and its answer is in public.cron_http_calls.'
     || E'\n\nThis is an automated message from the Skyline CMS (at most one a day).')
   returning id into v_delivery;
   update public.cron_health_mails set delivery_id = v_delivery where day = current_date;
   v_mailed := true;
  end if;
 end if;
 return jsonb_build_object('checkedAt', now(), 'flags', v_flags, 'emailQueued', v_mailed);
end $f$;
revoke all on function public.cron_http_health_check(integer, integer) from public, anon, authenticated;
