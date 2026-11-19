-- Daily health check of the scheduled HTTP jobs (owner 2026-11-20, after the signing tick answered 403 for days unnoticed).
--
--   * Every pg_cron dispatcher that calls an Edge Function now posts through public.cron_http_post(job, ...): the same net.http_post,
--     plus one row in public.cron_http_calls (request id, job). pg_net keeps responses only about 6 hours and does not record which job
--     made a request, and cron.job_run_details says "succeeded" as soon as the request is queued, so neither shows a failing job.
--   * public.cron_http_collect() (every 10 minutes) copies each response's status (and a short body) into cron_http_calls; a call with
--     no response after an hour counts as failed. Rows older than 30 days are removed.
--   * public.cron_http_health_check() (daily, 21:30 UTC) flags any job with 3 or more failed calls (no 2xx answer) in the last 24 hours
--     into public.cron_health_flags (one row per job per day). Flags of today and yesterday show on the CMS dashboard (Needs action today
--     > Scheduled jobs failing, admin_today 'scheduledJobs').
-- Covered jobs: hr-holiday-sync, hr-retention-purge, integration-token-refresh, notification-delivery-worker, portal-document-extraction-
-- worker, public-assistant-index-worker, signing-notifications, support-ticket-mail. Jobs that only run SQL (no HTTP) are not covered.
-- Additive: two tables, three functions, two cron jobs; eight dispatchers and admin_today patched in place (single-line anchors, exact counts).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

create table if not exists public.cron_http_calls(
 request_id bigint primary key,
 job text not null check (char_length(job) between 1 and 80),
 called_at timestamptz not null default now(),
 status_code integer,
 failed boolean,
 detail text check (detail is null or length(detail) <= 300),
 collected_at timestamptz
);
create index if not exists cron_http_calls_open_idx on public.cron_http_calls(called_at) where collected_at is null;
create index if not exists cron_http_calls_job_idx on public.cron_http_calls(job, called_at desc);
alter table public.cron_http_calls enable row level security;
revoke all on public.cron_http_calls from public, anon, authenticated;
comment on table public.cron_http_calls is 'One row per HTTP call a scheduled job made (cron_http_post), with the answer collected by cron_http_collect.';

create table if not exists public.cron_health_flags(
 id bigint generated always as identity primary key,
 job text not null,
 day date not null default current_date,
 calls integer not null,
 failures integer not null,
 last_status integer,
 last_detail text,
 first_failure_at timestamptz,
 last_failure_at timestamptz,
 created_at timestamptz not null default now(),
 unique (job, day)
);
alter table public.cron_health_flags enable row level security;
revoke all on public.cron_health_flags from public, anon, authenticated;
comment on table public.cron_health_flags is 'Daily: scheduled jobs with 3+ calls without a 2xx answer in the last 24 hours (cron_http_health_check).';

-- The dispatchers' HTTP call, recorded. Same named arguments as net.http_post, so each dispatcher changes in one place.
create or replace function public.cron_http_post(p_job text, url text, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, body jsonb default '{}'::jsonb,
 timeout_milliseconds integer default 5000) returns bigint
language plpgsql security definer set search_path = pg_catalog, public, net as $f$
declare v_id bigint;
begin
 v_id := net.http_post(url := url, headers := headers, body := body, timeout_milliseconds := timeout_milliseconds);
 insert into public.cron_http_calls(request_id, job) values (v_id, left(coalesce(nullif(btrim(p_job), ''), 'unknown'), 80)) on conflict (request_id) do nothing;
 return v_id;
end $f$;
revoke all on function public.cron_http_post(text, text, jsonb, jsonb, integer) from public, anon, authenticated;

select pg_temp.patch('public.hr_holiday_sync_dispatch()', 'net.http_post(', 'public.cron_http_post(''hr-holiday-sync'', ');
select pg_temp.patch('public.hr_retention_dispatch()', 'net.http_post(', 'public.cron_http_post(''hr-retention-purge'', ');
select pg_temp.patch('public.integration_refresh_dispatch()', 'net.http_post(', 'public.cron_http_post(''integration-token-refresh'', ');
select pg_temp.patch('public.notification_dispatch_worker()', 'net.http_post(', 'public.cron_http_post(''notification-delivery-worker'', ');
select pg_temp.patch('public.portal_dispatch_document_extraction_worker()', 'net.http_post(', 'public.cron_http_post(''portal-document-extraction-worker'', ');
select pg_temp.patch('public.public_assistant_dispatch_index_worker()', 'net.http_post(', 'public.cron_http_post(''public-assistant-index-worker'', ');
select pg_temp.patch('public.signing_dispatch()', 'net.http_post(', 'public.cron_http_post(''signing-notifications'', ');
select pg_temp.patch('public.support_mail_dispatch()', 'net.http_post(', 'public.cron_http_post(''support-ticket-mail'', ');

-- Every 10 minutes: the answers pg_net still holds (about 6 hours) are copied; an hour without an answer counts as failed.
create or replace function public.cron_http_collect() returns integer
language plpgsql security definer set search_path = pg_catalog, public, net as $f$
declare v_n integer; v_lost integer;
begin
 update public.cron_http_calls c set status_code = r.status_code,
  failed = coalesce(r.timed_out, false) or r.error_msg is not null or r.status_code is null or r.status_code not between 200 and 299,
  detail = left(coalesce(nullif(r.error_msg, ''), case when r.status_code not between 200 and 299 then r.content end, ''), 300), collected_at = now()
 from net._http_response r where r.id = c.request_id and c.collected_at is null;
 get diagnostics v_n = row_count;
 update public.cron_http_calls set failed = true, detail = 'no response within an hour', collected_at = now()
 where collected_at is null and called_at < now() - interval '1 hour';
 get diagnostics v_lost = row_count;
 delete from public.cron_http_calls where called_at < now() - interval '30 days';
 delete from public.cron_health_flags where day < current_date - 90;
 return v_n + v_lost;
end $f$;
revoke all on function public.cron_http_collect() from public, anon, authenticated;

-- Daily: jobs with p_min_failures or more failed calls in the last p_hours hours are flagged (one row per job per day).
create or replace function public.cron_http_health_check(p_hours integer default 24, p_min_failures integer default 3) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_flags jsonb;
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
 select coalesce(jsonb_agg(jsonb_build_object('job', f.job, 'calls', f.calls, 'failures', f.failures, 'lastStatus', f.last_status) order by f.job), '[]'::jsonb) into v_flags
 from public.cron_health_flags f where f.day = current_date;
 return jsonb_build_object('checkedAt', now(), 'flags', v_flags);
end $f$;
revoke all on function public.cron_http_health_check(integer, integer) from public, anon, authenticated;

-- Needs action today: scheduled jobs flagged today or yesterday (latest flag per job).
select pg_temp.patch('public.admin_today()', E'\n  return r;\nend;',
 E'\n  r := r || jsonb_build_object(''scheduledJobs'', (select jsonb_build_object(''count'', count(*), ''items'', coalesce(jsonb_agg(jsonb_build_object(''id'', f.id, ''title'', f.job,'
 || E' ''detail'', f.failures || '' of '' || f.calls || '' calls failed in 24 h'' || coalesce('', last answer '' || f.last_status, '', no answer''), ''at'', f.last_failure_at, ''to'', ''/admin'') order by f.last_failure_at desc), ''[]''::jsonb))'
 || E' from (select distinct on (x.job) x.* from public.cron_health_flags x where x.day >= current_date - 1 order by x.job, x.day desc) f));\n  return r;\nend;');

-- The schedule (idempotent: an existing job of the same name is replaced).
do $c$
begin
 perform cron.unschedule(jobid) from cron.job where jobname in ('cron-http-collect', 'cron-http-health');
 perform cron.schedule('cron-http-collect', '*/10 * * * *', 'select public.cron_http_collect();');
 perform cron.schedule('cron-http-health', '30 21 * * *', 'select public.cron_http_health_check();');
end $c$;
