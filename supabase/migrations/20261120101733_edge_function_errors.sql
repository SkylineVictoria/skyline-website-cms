-- The daily health check also flags Edge Functions that answered 5xx (546 included) in the last 24 hours (owner 2026-11-20), in the same
-- dashboard item and email as the scheduled jobs.
--
--   * Calls people made: the browser (CMS, portal, /sign) reports each 5xx it receives through public.edge_function_error_report (the
--     only way in: insert-only, validated function name and status, error text cleaned and capped, rate-limited per user / IP, flood cap
--     per function and day). The platform's own function_edge_logs need an account-wide access token, which the owner declined.
--   * Calls the database queued (the eight scheduled dispatchers, the onboarding follow-ups: PDF split, referee checks): every one goes
--     through public.cron_http_post, which now records the function's name; their 5xx answers come from public.cron_http_calls.
--   * A function is flagged when a queued call or a signed-in staff member saw a 5xx, or when at least two different people / addresses
--     reported one (a single anonymous reporter cannot raise an alert). One row per function per day in cron_health_flags (kind 'function').
-- Additive: two tables, three columns, one constraint swapped for a wider one; cron_http_post, cron_http_health_check replaced;
-- admin_today patched in place (single-line anchors).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ the deployed Edge Functions (a report naming anything else is dropped)
create or replace function public.edge_function_names() returns text[] language sql immutable as $f$
 select array['address-search', 'admin-view-as', 'calendly-admin', 'cms-admin-users', 'cricos-lookup', 'document-signing', 'email-sender', 'guest-documents',
  'holiday-sync', 'integrations-admin', 'integrations-credentials', 'integrations-refresh', 'integrations-webhook', 'notification-delivery', 'omara-abr-enrich',
  'omara-ingest', 'payments', 'portal-admin-users', 'portal-application-delete', 'portal-document-delete', 'portal-document-extract', 'portal-invite-activate',
  'portal-self-register', 'public-assistant', 'public-assistant-index', 'staff-admin', 'staff-onboarding', 'staff-register', 'student-office365',
  'support-ticket-mail', 'tga-course-import', 'validated-document-upload', 'xero-push']::text[]
$f$;
comment on function public.edge_function_names() is 'Every Edge Function in supabase/functions: add a new function here or its error reports are dropped.';

-- ------------------------------------------------------------------ browser reports
create table if not exists public.edge_function_errors(
 id bigint generated always as identity primary key,
 function_name text not null check (function_name ~ '^[a-z0-9-]{2,48}$'),
 status integer not null check (status between 500 and 599),
 error text not null default '' check (char_length(error) <= 200),
 reporter text not null check (char_length(reporter) between 3 and 80),
 signed_in boolean not null default false,
 staff boolean not null default false,
 repeats integer not null default 1 check (repeats >= 1),
 first_at timestamptz not null default now(),
 last_at timestamptz not null default now()
);
create index if not exists edge_function_errors_reporter_idx on public.edge_function_errors(reporter, last_at);
create index if not exists edge_function_errors_function_idx on public.edge_function_errors(function_name, last_at);
alter table public.edge_function_errors enable row level security;
revoke all on public.edge_function_errors from public, anon, authenticated;
comment on table public.edge_function_errors is '5xx answers people''s browsers got from an Edge Function (edge_function_error_report); read by cron_http_health_check.';

-- The key for the reporter's address: an address is kept only as an HMAC with this key, never in clear.
create table if not exists public.edge_function_error_salt(id boolean primary key default true check (id), salt bytea not null);
alter table public.edge_function_error_salt enable row level security;
revoke all on public.edge_function_error_salt from public, anon, authenticated;
insert into public.edge_function_error_salt(salt) values (extensions.gen_random_bytes(32)) on conflict (id) do nothing;

-- Error text: whitespace collapsed, e-mail addresses, long numbers and long token-like strings removed, at most 200 characters.
create or replace function public.edge_function_error_clean(p_text text) returns text language sql immutable as $f$
 select left(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''),
  '[[:cntrl:]]+', ' ', 'g'),
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
  '[A-Za-z0-9_-]{24,}|[0-9][0-9 ]{7,}[0-9]', '[redacted]', 'g'),
  '\s+', ' ', 'g')), 200)
$f$;

create or replace function public.edge_function_error_report(p_function text, p_status integer, p_error text default '') returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $f$
declare v_uid uuid := auth.uid(); v_reporter text; v_ip text; v_staff boolean := false; v_id bigint; v_error text;
begin
 -- Anything not plausible is dropped without an answer (nothing to learn by probing).
 if p_function is null or not (p_function = any(public.edge_function_names())) or p_status is null or p_status not between 500 and 599 then return; end if;
 v_error := public.edge_function_error_clean(p_error);
 if v_uid is not null then
  v_reporter := 'user:' || v_uid::text;
  begin v_staff := coalesce(public.cms_is_staff(), false); exception when others then v_staff := false; end;
 else
  begin
   v_ip := nullif(btrim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'x-forwarded-for',
     nullif(current_setting('request.headers', true), '')::jsonb->>'cf-connecting-ip', ''), ',', 1)), '');
  exception when others then v_ip := null; end;
  v_reporter := 'ip:' || left(encode(extensions.hmac(convert_to(coalesce(v_ip, 'unknown'), 'UTF8'), (select salt from public.edge_function_error_salt), 'sha256'), 'hex'), 40);
 end if;
 -- The same reporter, function and status within a minute: one row, counted.
 update public.edge_function_errors set repeats = least(repeats + 1, 1000), last_at = now(), error = case when v_error <> '' then v_error else error end
 where id = (select e.id from public.edge_function_errors e where e.reporter = v_reporter and e.function_name = p_function and e.status = p_status
   and e.last_at > now() - interval '60 seconds' order by e.last_at desc limit 1)
 returning id into v_id;
 if v_id is not null then return; end if;
 -- At most 30 rows an hour from one reporter, and 300 a day for one function (a flood cannot fill the table).
 if (select count(*) from public.edge_function_errors e where e.reporter = v_reporter and e.last_at > now() - interval '1 hour') >= 30 then return; end if;
 if (select count(*) from public.edge_function_errors e where e.function_name = p_function and e.first_at > now() - interval '1 day') >= 300 then return; end if;
 insert into public.edge_function_errors(function_name, status, error, reporter, signed_in, staff) values (p_function, p_status, v_error, v_reporter, v_uid is not null, v_staff);
end $f$;
revoke all on function public.edge_function_error_report(text, integer, text) from public;
grant execute on function public.edge_function_error_report(text, integer, text) to anon, authenticated;
revoke all on function public.edge_function_error_clean(text) from public, anon, authenticated;
revoke all on function public.edge_function_names() from public, anon, authenticated;

-- ------------------------------------------------------------------ calls the database queued: the function they called
alter table public.cron_http_calls add column if not exists function_name text;
create or replace function public.cron_http_post(p_job text, url text, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, body jsonb default '{}'::jsonb,
 timeout_milliseconds integer default 5000) returns bigint
language plpgsql security definer set search_path = pg_catalog, public, net as $f$
declare v_id bigint;
begin
 v_id := net.http_post(url := url, headers := headers, body := body, timeout_milliseconds := timeout_milliseconds);
 insert into public.cron_http_calls(request_id, job, function_name) values (v_id, left(coalesce(nullif(btrim(p_job), ''), 'unknown'), 80), substring(url from '/functions/v1/([a-z0-9-]+)'))
 on conflict (request_id) do nothing;
 return v_id;
end $f$;
revoke all on function public.cron_http_post(text, text, jsonb, jsonb, integer) from public, anon, authenticated;
-- The calls already recorded (their URL was not kept): each job calls one function.
update public.cron_http_calls set function_name = case job when 'hr-holiday-sync' then 'holiday-sync' when 'hr-retention-purge' then 'staff-admin'
  when 'integration-token-refresh' then 'integrations-refresh' when 'notification-delivery-worker' then 'notification-delivery'
  when 'portal-document-extraction-worker' then 'portal-document-extract' when 'public-assistant-index-worker' then 'public-assistant-index'
  when 'signing-notifications' then 'document-signing' when 'support-ticket-mail' then 'email-sender' when 'onboarding-followup' then 'document-signing' end
where function_name is null;

-- ------------------------------------------------------------------ flags: jobs and functions in one table
alter table public.cron_health_flags add column if not exists kind text not null default 'job';
alter table public.cron_health_flags add column if not exists summary text;
do $c$
begin
 if not exists (select 1 from pg_constraint where conname = 'cron_health_flags_kind_check') then
  alter table public.cron_health_flags add constraint cron_health_flags_kind_check check (kind in ('job', 'function'));
 end if;
 if not exists (select 1 from pg_constraint where conname = 'cron_health_flags_kind_job_day_key') then
  alter table public.cron_health_flags add constraint cron_health_flags_kind_job_day_key unique (kind, job, day);
 end if;
 alter table public.cron_health_flags drop constraint if exists cron_health_flags_job_day_key;
end $c$;
comment on table public.cron_health_flags is 'Daily (cron_http_health_check): scheduled jobs with 3+ calls without a 2xx answer, and Edge Functions that answered 5xx / 546, in the last 24 hours.';

-- Daily: jobs with p_min_failures or more failed calls, and Edge Functions with a 5xx in the last p_hours hours, are flagged (one row
-- per job / function per day); when any is flagged, one summary email is queued for the day.
create or replace function public.cron_http_health_check(p_hours integer default 24, p_min_failures integer default 3) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_flags jsonb; v_n integer; v_jobs integer; v_functions integer; v_body text; v_delivery uuid; v_mailed boolean := false; v_since timestamptz;
begin
 v_since := now() - make_interval(hours => greatest(p_hours, 1));
 perform public.cron_http_collect();
 delete from public.edge_function_errors where last_at < now() - interval '30 days';
 insert into public.cron_health_flags(kind, job, day, calls, failures, last_status, last_detail, first_failure_at, last_failure_at)
 select 'job', c.job, current_date, count(*), count(*) filter (where c.failed),
  (array_agg(c.status_code order by c.called_at desc) filter (where c.failed))[1], (array_agg(c.detail order by c.called_at desc) filter (where c.failed))[1],
  min(c.called_at) filter (where c.failed), max(c.called_at) filter (where c.failed)
 from public.cron_http_calls c where c.called_at >= v_since and c.collected_at is not null
 group by c.job having count(*) filter (where c.failed) >= greatest(p_min_failures, 1)
 on conflict (kind, job, day) do update set calls = excluded.calls, failures = excluded.failures, last_status = excluded.last_status, last_detail = excluded.last_detail,
  first_failure_at = excluded.first_failure_at, last_failure_at = excluded.last_failure_at, created_at = now();
 -- Edge Functions: 5xx seen by people (browser reports) and by the calls the database queued.
 insert into public.cron_health_flags(kind, job, day, calls, failures, last_status, last_detail, first_failure_at, last_failure_at, summary)
 select 'function', s.fn, current_date, s.errors, s.errors, s.last_status, s.last_error, s.first_at, s.last_at,
  s.errors || ' error' || case when s.errors = 1 then '' else 's' end || ' (5xx / 546) in 24 h: '
   || concat_ws(', ', case when s.browser > 0 then s.browser || ' seen by people (' || s.reporters || ' reporter' || case when s.reporters = 1 then '' else 's' end || ')' end,
                      case when s.queued > 0 then s.queued || ' on queued calls' end)
   || '; last ' || s.last_status || coalesce(': ' || nullif(s.last_error, ''), '')
 from (
  select e.fn, sum(e.n)::integer errors, sum(e.n) filter (where e.src = 'browser')::integer browser, sum(e.n) filter (where e.src = 'queued')::integer queued,
   count(distinct e.reporter) filter (where e.src = 'browser')::integer reporters, bool_or(e.trusted) trusted,
   (array_agg(e.status order by e.at desc))[1] last_status, left((array_agg(e.error order by e.at desc))[1], 200) last_error, min(e.first_at) first_at, max(e.at) last_at
  from (
   select x.function_name fn, 'browser' src, x.repeats n, x.reporter, x.staff trusted, x.status, x.error, x.first_at, x.last_at at
   from public.edge_function_errors x where x.last_at >= v_since
   union all
   select c.function_name, 'queued', 1, 'queued:' || c.job, true, c.status_code, public.edge_function_error_clean(c.detail), c.called_at, c.called_at
   from public.cron_http_calls c where c.called_at >= v_since and c.function_name is not null and c.status_code between 500 and 599
  ) e group by e.fn
 ) s where s.trusted or s.reporters >= 2
 on conflict (kind, job, day) do update set calls = excluded.calls, failures = excluded.failures, last_status = excluded.last_status, last_detail = excluded.last_detail,
  first_failure_at = excluded.first_failure_at, last_failure_at = excluded.last_failure_at, summary = excluded.summary, created_at = now();
 select count(*), count(*) filter (where f.kind = 'job'), count(*) filter (where f.kind = 'function'),
  coalesce(jsonb_agg(jsonb_build_object('kind', f.kind, 'job', f.job, 'calls', f.calls, 'failures', f.failures, 'lastStatus', f.last_status) order by f.kind desc, f.job), '[]'::jsonb)
 into v_n, v_jobs, v_functions, v_flags from public.cron_health_flags f where f.day = current_date;
 -- The email: at most once a day (the day's row is claimed first; a second run finds it and queues nothing).
 if v_n > 0 then
  insert into public.cron_health_mails(day, jobs) values (current_date, v_n) on conflict (day) do nothing;
  if found then
   select concat_ws(E'\n\n',
    case when v_jobs > 0 then 'Scheduled jobs with ' || greatest(p_min_failures, 1) || ' or more calls without a normal (2xx) answer:' || E'\n' || string_agg(
     format('- %s: %s of %s calls failed in the last %s hours (first %s UTC, last %s UTC), last answer %s%s', f.job, f.failures, f.calls, greatest(p_hours, 1),
      to_char(f.first_failure_at at time zone 'UTC', 'DD Mon HH24:MI'), to_char(f.last_failure_at at time zone 'UTC', 'DD Mon HH24:MI'),
      coalesce(f.last_status::text, 'none'), coalesce(': ' || nullif(left(regexp_replace(f.last_detail, '\s+', ' ', 'g'), 160), ''), '')), E'\n' order by f.job) filter (where f.kind = 'job') end,
    case when v_functions > 0 then 'Edge Functions that answered 5xx / 546:' || E'\n' || string_agg(
     format('- %s: %s (last %s UTC)', f.job, f.summary, to_char(f.last_failure_at at time zone 'UTC', 'DD Mon HH24:MI')), E'\n' order by f.job) filter (where f.kind = 'function') end)
   into v_body from public.cron_health_flags f where f.day = current_date;
   insert into public.notification_deliveries(recipient_email, event, template_source, subject, body)
   values (public.cron_health_mail_to(), 'ops_cron_health', 'default',
    format('Scheduled jobs / Edge Functions failing: %s (%s)', v_n, to_char(current_date, 'DD Mon YYYY')),
    'The daily check of the scheduled jobs and the Edge Functions found ' || v_n || ' problem' || case when v_n = 1 then '' else 's' end
     || ' in the last ' || greatest(p_hours, 1) || E' hours.\n\n' || v_body
     || E'\n\nThe CMS dashboard shows them under Needs action today > Scheduled jobs or Edge Functions failing. Each scheduled call and its answer is in'
     || E' public.cron_http_calls; the errors people saw are in public.edge_function_errors.'
     || E'\n\nThis is an automated message from the Skyline CMS (at most one a day).')
   returning id into v_delivery;
   update public.cron_health_mails set delivery_id = v_delivery where day = current_date;
   v_mailed := true;
  end if;
 end if;
 return jsonb_build_object('checkedAt', now(), 'flags', v_flags, 'emailQueued', v_mailed);
end $f$;
revoke all on function public.cron_http_health_check(integer, integer) from public, anon, authenticated;

-- ------------------------------------------------------------------ Needs action today: the same item lists functions too
select pg_temp.patch('public.admin_today()', $a$'title', f.job, 'detail', f.failures || ' of ' || f.calls || ' calls failed in 24 h' || coalesce(', last answer ' || f.last_status, ', no answer'),$a$,
 $a$'title', case when f.kind = 'function' then 'Edge Function ' || f.job else f.job end, 'detail', coalesce(f.summary, f.failures || ' of ' || f.calls || ' calls failed in 24 h' || coalesce(', last answer ' || f.last_status, ', no answer')),$a$);
select pg_temp.patch('public.admin_today()', $a$distinct on (x.job) x.* from public.cron_health_flags x where x.day >= current_date - 1 order by x.job, x.day desc$a$,
 $a$distinct on (x.kind, x.job) x.* from public.cron_health_flags x where x.day >= current_date - 1 order by x.kind, x.job, x.day desc$a$);
