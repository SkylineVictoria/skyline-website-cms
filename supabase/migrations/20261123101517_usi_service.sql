-- USI-SERVICE (2026-11-23, owner): USI Verify, Locate and Create on the application form through the Edge Function usi-service
-- (USI Web Services v5). This migration holds the state, the access rules, the limits, the audit and the automatic re-check.
--  * application_usi: one row per application: the USI last checked / found / created, the result (status and per-field match),
--    verified_at, the environment (test / production), who triggered it, the consent to locate / create (who and when), the identity
--    document TYPE of a Create (never its number) and the automatic re-check state. Read through usi_state; written only by
--    usi_record (service role) and usi_consent_set.
--  * usi_calls: every call (operation, application, who, automatic or not, outcome), no personal data; the limits count it.
--  * usi_access(application, op), called by usi-service with the caller's own JWT: who may run what, consent, limits; returns the
--    application's answers the call needs (never taken from the request, so the form cannot test a USI against made-up details).
--      verify: SLIT staff; the student or the agency (agent / agency admin) while they can edit the application.
--      locate: the same, and only with the student's consent.  create: SLIT staff only, with the student's consent.
--    Limits (user calls): verify 10 per application per day and 30 per person per hour; locate 3 per application per day and 10 per
--    person per day; create 2 per application ever and 20 per day for the organisation; 500 user calls per day in all.
--  * Automatic re-check: when the student's name or date of birth changes after a check (trigger on enrollment_students), the
--    result is marked stale and usi-service verifies again (pg_net now, and the 10-minute job usi-reverify). Automatic calls do not
--    count against the user limits: their own cap is 200 a day, and an application stops after 3 failed tries.
--  * portal_audit_log: usi_verify / usi_locate / usi_create / usi_consent_given / usi_consent_withdrawn / usi_create_requested, with
--    the outcome, environment and error code only.

create table if not exists public.application_usi (
  application_id uuid primary key references public.enrollment_applications(id) on delete cascade,
  usi text,
  status text check (status in ('valid', 'mismatch', 'not_found', 'deactivated', 'stale')),
  usi_status text,
  first_name_match text check (first_name_match in ('Match', 'NoMatch')),
  family_name_match text check (family_name_match in ('Match', 'NoMatch')),
  single_name_match text check (single_name_match in ('Match', 'NoMatch')),
  dob_match text check (dob_match in ('Match', 'NoMatch')),
  verified_at timestamptz,
  environment text check (environment in ('test', 'production')),
  verified_by uuid,
  verified_by_name text,
  verified_by_role text,
  person_hash text,
  locate_result text,
  located_at timestamptz,
  created_usi_at timestamptz,
  create_document_type text,
  create_request_id text,
  consent_at timestamptz,
  consent_by uuid,
  consent_by_name text,
  consent_role text,
  create_requested_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  reverify_attempts integer not null default 0,
  reverify_next_at timestamptz,
  reverify_last_error text,
  updated_at timestamptz not null default now()
);
alter table public.application_usi enable row level security;
revoke all on public.application_usi from public, anon, authenticated;
create index if not exists application_usi_reverify_idx on public.application_usi (reverify_next_at) where status = 'stale' and reverify_next_at is not null;

create table if not exists public.usi_calls (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  op text not null check (op in ('verify', 'locate', 'create')),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  actor uuid,
  actor_name text,
  actor_role text not null,
  automatic boolean not null default false,
  person_hash text,
  outcome text,
  finished_at timestamptz
);
alter table public.usi_calls enable row level security;
revoke all on public.usi_calls from public, anon, authenticated;
create index if not exists usi_calls_app_idx on public.usi_calls (application_id, op, created_at);
create index if not exists usi_calls_actor_idx on public.usi_calls (actor, op, created_at);
create index if not exists usi_calls_day_idx on public.usi_calls (created_at, automatic);

/* ---------------------------------------------------------------- helpers (internal) */
create or replace function public.usi_limits() returns jsonb language sql immutable as $f$
 select jsonb_build_object('verifyPerApplicationDay', 10, 'verifyPerUserHour', 30, 'locatePerApplicationDay', 3, 'locatePerUserDay', 10,
  'createPerApplication', 2, 'createPerOrganisationDay', 20, 'userCallsPerDay', 500, 'automaticPerDay', 200, 'automaticAttempts', 3);
$f$;

-- The application's answers: the student's details with the application's own values over them (as the form shows them).
create or replace function public.usi_values(p_application uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select coalesce(s.details, '{}'::jsonb) || coalesce(a.data -> 'values', '{}'::jsonb)
 from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id where a.id = p_application;
$f$;
revoke all on function public.usi_values(uuid) from public, anon, authenticated;

-- What Verify compares (name and date of birth), as one hash: a change after a check makes the result stale.
create or replace function public.usi_person_hash(p_values jsonb) returns text language sql immutable as $f$
 select encode(sha256(convert_to(lower(regexp_replace(concat_ws('|', btrim(coalesce(p_values ->> 'first_name', '')), btrim(coalesce(p_values ->> 'last_name', '')),
  btrim(coalesce(p_values ->> 'dob', ''))), '\s+', ' ', 'g')), 'UTF8')), 'hex');
$f$;

-- Only the answers a USI call needs.
create or replace function public.usi_call_values(p_values jsonb) returns jsonb language sql immutable as $f$
 select coalesce((select jsonb_object_agg(key, value) from jsonb_each(coalesce(p_values, '{}'::jsonb))
  where key in ('first_name', 'middle_name', 'last_name', 'dob', 'gender', 'email', 'mobile', 'place_of_birth', 'birth_country', 'address_type', 'usi_number')
   or key like 'au\_%' or key like 'ov\_%'), '{}'::jsonb);
$f$;

create or replace function public.usi_actor_name() returns text
language sql stable security definer set search_path = pg_catalog, public as $f$
 select coalesce((select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1),
  (select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), auth.jwt() ->> 'email', 'Signed-in user');
$f$;
revoke all on function public.usi_actor_name() from public, anon, authenticated;

-- Who the caller is for this application: staff, student, agent, or null (no USI access).
create or replace function public.usi_role(p_application uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare a public.enrollment_applications;
begin
 if auth.uid() is null then return null; end if;
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 if public.portal_is_slit_admin() and public.portal_can_access_application(a.id) then return 'staff'; end if;
 if public.portal_can_edit_application(a.id) then
  return case when a.student_id is not null and a.student_id = public.portal_student_id() then 'student' else 'agent' end;
 end if;
 return null;
end $f$;
revoke all on function public.usi_role(uuid) from public, anon, authenticated;

/* ---------------------------------------------------------------- access (as the caller) */
create or replace function public.usi_access(p_application uuid, p_op text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public as $f$
declare a public.enrollment_applications; u public.application_usi; v_role text; v_values jsonb; v_call bigint; lim jsonb := public.usi_limits();
 v_uid uuid := auth.uid(); n integer;
begin
 if p_op not in ('verify', 'locate', 'create') then raise exception 'Unknown USI operation' using errcode = '22023'; end if;
 v_role := public.usi_role(p_application);
 if v_role is null then raise exception 'You cannot use the USI service for this application' using errcode = '42501'; end if;
 if p_op = 'create' and v_role <> 'staff' then raise exception 'Only SLIT staff can create a USI' using errcode = '42501'; end if;
 select * into a from public.enrollment_applications where id = p_application;
 select * into u from public.application_usi where application_id = a.id;
 if p_op in ('locate', 'create') and u.consent_at is null then
  raise exception 'The student has not given permission for Skyline to find or create their USI' using errcode = 'US403';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('usi:' || a.id::text, 0));
 select count(*) into n from public.usi_calls c where not c.automatic and c.created_at > now() - interval '1 day';
 if n >= (lim ->> 'userCallsPerDay')::int then raise exception 'The USI service has reached today''s limit for Skyline. Try again tomorrow.' using errcode = 'US429'; end if;
 if p_op = 'verify' then
  select count(*) into n from public.usi_calls c where c.application_id = a.id and c.op = 'verify' and not c.automatic and c.created_at > now() - interval '1 day';
  if n >= (lim ->> 'verifyPerApplicationDay')::int then raise exception 'This USI has been checked % times today. Try again tomorrow.', n using errcode = 'US429'; end if;
  select count(*) into n from public.usi_calls c where c.actor = v_uid and c.op = 'verify' and c.created_at > now() - interval '1 hour';
  if n >= (lim ->> 'verifyPerUserHour')::int then raise exception 'You have checked % USIs in the last hour. Try again later.', n using errcode = 'US429'; end if;
 elsif p_op = 'locate' then
  select count(*) into n from public.usi_calls c where c.application_id = a.id and c.op = 'locate' and c.created_at > now() - interval '1 day';
  if n >= (lim ->> 'locatePerApplicationDay')::int then raise exception 'The USI has been searched for % times today for this application. Try again tomorrow.', n using errcode = 'US429'; end if;
  select count(*) into n from public.usi_calls c where c.actor = v_uid and c.op = 'locate' and c.created_at > now() - interval '1 day';
  if n >= (lim ->> 'locatePerUserDay')::int then raise exception 'You have searched for % USIs today. Try again tomorrow.', n using errcode = 'US429'; end if;
 else
  select count(*) into n from public.usi_calls c where c.application_id = a.id and c.op = 'create';
  if n >= (lim ->> 'createPerApplication')::int then raise exception 'A USI has already been requested % times for this application. Contact the USI Registry.', n using errcode = 'US429'; end if;
  select count(*) into n from public.usi_calls c where c.op = 'create' and c.created_at > now() - interval '1 day';
  if n >= (lim ->> 'createPerOrganisationDay')::int then raise exception 'Skyline has created % USIs today, the daily limit. Try again tomorrow.', n using errcode = 'US429'; end if;
 end if;
 v_values := public.usi_values(a.id);
 insert into public.usi_calls (op, application_id, actor, actor_name, actor_role, person_hash)
 values (p_op, a.id, v_uid, public.usi_actor_name(), v_role, public.usi_person_hash(v_values)) returning id into v_call;
 return jsonb_build_object('callId', v_call, 'role', v_role, 'values', public.usi_call_values(v_values), 'usi', u.usi, 'consent', u.consent_at is not null);
end $f$;
revoke all on function public.usi_access(uuid, text) from public, anon;
grant execute on function public.usi_access(uuid, text) to authenticated;

/* ---------------------------------------------------------------- record (service role only) */
create or replace function public.usi_record(p_call bigint, p_result jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public as $f$
declare c public.usi_calls; a public.enrollment_applications; v_outcome text := coalesce(p_result ->> 'outcome', 'error'); v_env text := p_result ->> 'environment';
 v_usi text := nullif(upper(btrim(coalesce(p_result ->> 'usi', ''))), ''); v_err text := left(nullif(btrim(coalesce(p_result ->> 'error', '')), ''), 400);
 lim jsonb := public.usi_limits(); u public.application_usi;
begin
 select * into c from public.usi_calls where id = p_call for update;
 if not found or c.finished_at is not null then raise exception 'Unknown or finished USI call' using errcode = '22023'; end if;
 if v_env not in ('test', 'production') then raise exception 'Unknown USI environment' using errcode = '22023'; end if;
 if v_usi is not null and v_usi !~ '^[A-HJ-NP-Z2-9]{10}$' then raise exception 'Not a USI' using errcode = '22023'; end if;
 select * into a from public.enrollment_applications where id = c.application_id;
 update public.usi_calls set outcome = v_outcome, finished_at = now() where id = c.id;
 insert into public.application_usi (application_id) values (c.application_id) on conflict (application_id) do nothing;
 select * into u from public.application_usi where application_id = c.application_id for update;

 if c.op = 'verify' and v_outcome in ('valid', 'mismatch', 'not_found', 'deactivated') then
  update public.application_usi set usi = coalesce(v_usi, usi), status = v_outcome, usi_status = left(p_result ->> 'usiStatus', 20),
   first_name_match = p_result -> 'matches' ->> 'firstName', family_name_match = p_result -> 'matches' ->> 'familyName',
   single_name_match = p_result -> 'matches' ->> 'singleName', dob_match = p_result -> 'matches' ->> 'dateOfBirth',
   verified_at = now(), environment = v_env, verified_by = c.actor, verified_by_name = c.actor_name, verified_by_role = c.actor_role,
   person_hash = c.person_hash, last_error = null, last_error_at = null, reverify_attempts = 0, reverify_next_at = null, reverify_last_error = null, updated_at = now()
  where application_id = c.application_id;
 elsif c.op = 'verify' then
  update public.application_usi set last_error = v_err, last_error_at = now(),
   reverify_last_error = case when c.automatic then coalesce(v_err, v_outcome) else reverify_last_error end,
   reverify_next_at = case when c.automatic and reverify_attempts >= (lim ->> 'automaticAttempts')::int then null else reverify_next_at end, updated_at = now()
  where application_id = c.application_id;
 elsif c.op = 'locate' then
  update public.application_usi set locate_result = left(p_result ->> 'locateResult', 40), located_at = now(), environment = v_env,
   usi = case when v_outcome = 'exact' then v_usi else usi end,
   last_error = case when v_outcome = 'error' then v_err end, last_error_at = case when v_outcome = 'error' then now() end, updated_at = now()
  where application_id = c.application_id;
 else
  update public.application_usi set environment = v_env,
   usi = case when v_outcome = 'created' then v_usi else usi end,
   created_usi_at = case when v_outcome = 'created' then now() else created_usi_at end,
   create_document_type = left(p_result ->> 'documentType', 40), create_request_id = left(p_result ->> 'requestId', 20),
   last_error = case when v_outcome = 'created' then null else v_err end, last_error_at = case when v_outcome = 'created' then null else now() end, updated_at = now()
  where application_id = c.application_id;
 end if;
 -- A USI found or created goes straight into the student's answers (as if typed into the form).
 if v_usi is not null and ((c.op = 'locate' and v_outcome = 'exact') or (c.op = 'create' and v_outcome = 'created')) and a.student_id is not null then
  update public.enrollment_students set details = coalesce(details, '{}'::jsonb) || jsonb_build_object('usi_number', v_usi, 'has_usi', 'Yes')
  where id = a.student_id;
 end if;

 insert into public.portal_audit_log (actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
 values (c.actor, coalesce(c.actor_name, 'Automatic re-check'), c.actor_role, 'usi_' || c.op, 'application', c.application_id::text, c.application_id, a.agency_id, a.tenant_id,
  jsonb_strip_nulls(jsonb_build_object('outcome', v_outcome, 'environment', v_env, 'automatic', c.automatic, 'call', c.id,
   'errorCode', left(p_result ->> 'errorCode', 40), 'documentType', case when c.op = 'create' then left(p_result ->> 'documentType', 40) end,
   'requestId', case when c.op = 'create' then left(p_result ->> 'requestId', 20) end)));
 return jsonb_build_object('recorded', true, 'outcome', v_outcome);
end $f$;
revoke all on function public.usi_record(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.usi_record(bigint, jsonb) to service_role;

/* ---------------------------------------------------------------- consent and state (as the caller) */
create or replace function public.usi_consent_set(p_application uuid, p_given boolean, p_request_create boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public as $f$
declare a public.enrollment_applications; v_role text := public.usi_role(p_application); u public.application_usi; v_action text;
begin
 if v_role is null then raise exception 'You cannot change this application' using errcode = '42501'; end if;
 select * into a from public.enrollment_applications where id = p_application;
 insert into public.application_usi (application_id) values (a.id) on conflict (application_id) do nothing;
 select * into u from public.application_usi where application_id = a.id for update;
 if p_given then
  update public.application_usi set consent_at = coalesce(consent_at, now()), consent_by = case when consent_at is null then auth.uid() else consent_by end,
   consent_by_name = case when consent_at is null then public.usi_actor_name() else consent_by_name end,
   consent_role = case when consent_at is null then v_role else consent_role end,
   create_requested_at = case when p_request_create then coalesce(create_requested_at, now()) else create_requested_at end, updated_at = now()
  where application_id = a.id;
  v_action := case when u.consent_at is null then 'usi_consent_given' when p_request_create and u.create_requested_at is null then 'usi_create_requested' end;
 else
  update public.application_usi set consent_at = null, consent_by = null, consent_by_name = null, consent_role = null, create_requested_at = null, updated_at = now()
  where application_id = a.id;
  v_action := case when u.consent_at is not null then 'usi_consent_withdrawn' end;
 end if;
 if v_action is not null then
  insert into public.portal_audit_log (actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), public.usi_actor_name(), v_role, v_action, 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
   jsonb_strip_nulls(jsonb_build_object('createRequested', case when p_given and p_request_create then true end)));
 end if;
 return public.usi_state(a.id);
end $f$;

create or replace function public.usi_state(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare v_role text := public.usi_role(p_application); u public.application_usi; v_values jsonb;
begin
 if v_role is null then
  if auth.uid() is not null and public.portal_can_access_application(p_application) then v_role := 'viewer';
  else raise exception 'You cannot view this application' using errcode = '42501'; end if;
 end if;
 select * into u from public.application_usi where application_id = p_application;
 v_values := public.usi_values(p_application);
 return jsonb_build_object(
  'role', v_role,
  'canVerify', v_role in ('staff', 'student', 'agent'),
  'canLocate', v_role in ('staff', 'student', 'agent') and u.consent_at is not null,
  'canCreate', v_role = 'staff' and u.consent_at is not null,
  'canConsent', v_role in ('staff', 'student', 'agent'),
  'usi', u.usi, 'status', u.status, 'usiStatus', u.usi_status,
  'matches', jsonb_build_object('firstName', u.first_name_match, 'familyName', u.family_name_match, 'singleName', u.single_name_match, 'dateOfBirth', u.dob_match),
  'verifiedAt', u.verified_at, 'environment', u.environment, 'verifiedByName', u.verified_by_name, 'verifiedByRole', u.verified_by_role,
  'detailsChanged', u.person_hash is not null and u.person_hash is distinct from public.usi_person_hash(v_values),
  'locateResult', u.locate_result, 'locatedAt', u.located_at, 'createdAt', u.created_usi_at, 'createDocumentType', u.create_document_type,
  'consentAt', u.consent_at, 'consentByName', u.consent_by_name, 'consentRole', u.consent_role, 'createRequestedAt', u.create_requested_at,
  'lastError', u.last_error, 'lastErrorAt', u.last_error_at,
  'reverifyPending', u.status = 'stale' and u.reverify_next_at is not null, 'reverifyStopped', u.status = 'stale' and u.reverify_next_at is null and u.reverify_attempts > 0,
  'reverifyLastError', u.reverify_last_error);
end $f$;
revoke all on function public.usi_consent_set(uuid, boolean, boolean) from public, anon;
grant execute on function public.usi_consent_set(uuid, boolean, boolean) to authenticated;
revoke all on function public.usi_state(uuid) from public, anon;
grant execute on function public.usi_state(uuid) to authenticated;

/* ---------------------------------------------------------------- automatic re-check */
create or replace function public.usi_reverify_dispatch() returns bigint
language plpgsql security definer set search_path = pg_catalog, public, vault, net as $f$
declare v_key text; v_url text;
begin
 if not pg_try_advisory_xact_lock(9342, 20261123) then return null; end if;
 if not exists (select 1 from public.application_usi u where u.status = 'stale' and u.reverify_next_at is not null and u.reverify_next_at <= now()) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
 select regexp_replace(decrypted_secret, '/staff-admin$', '/usi-service') into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/usi-service$' then return null; end if;
 return public.cron_http_post('usi-reverify', url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := '{"action":"reverify"}'::jsonb, timeout_milliseconds := 55000);
end $f$;
revoke all on function public.usi_reverify_dispatch() from public, anon, authenticated;

-- Stale results due now (at most p_limit, within today's automatic cap): each becomes an automatic verify call. A try uses up one of
-- the application's attempts; after the last one nothing is retried until a person verifies again.
create or replace function public.usi_reverify_claim(p_limit integer default 10) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public as $f$
declare lim jsonb := public.usi_limits(); n integer; r record; v_values jsonb; v_call bigint; v_usi text; out jsonb := '[]'::jsonb; v_max integer;
begin
 v_max := (lim ->> 'automaticAttempts')::int;
 select count(*) into n from public.usi_calls c where c.automatic and c.created_at > now() - interval '1 day';
 n := least(greatest(coalesce(p_limit, 10), 0), 50, (lim ->> 'automaticPerDay')::int - n);
 if n <= 0 then return out; end if;
 for r in select u.application_id, u.usi, u.reverify_attempts from public.application_usi u
   where u.status = 'stale' and u.reverify_next_at is not null and u.reverify_next_at <= now() and u.reverify_attempts < v_max
   order by u.reverify_next_at limit n for update of u skip locked loop
  v_values := public.usi_values(r.application_id);
  v_usi := nullif(upper(regexp_replace(coalesce(v_values ->> 'usi_number', ''), '[\s-]', '', 'g')), '');
  v_usi := coalesce(case when v_usi ~ '^[A-HJ-NP-Z2-9]{10}$' then v_usi end, r.usi);
  update public.application_usi set reverify_attempts = r.reverify_attempts + 1,
   reverify_next_at = case when r.reverify_attempts + 1 >= v_max then null else now() + interval '10 minutes' end, updated_at = now()
  where application_id = r.application_id;
  if v_usi is null then continue; end if;
  insert into public.usi_calls (op, application_id, actor, actor_name, actor_role, automatic, person_hash)
  values ('verify', r.application_id, null, 'Automatic re-check', 'automatic', true, public.usi_person_hash(v_values)) returning id into v_call;
  out := out || jsonb_build_array(jsonb_build_object('callId', v_call, 'applicationId', r.application_id, 'usi', v_usi, 'values', public.usi_call_values(v_values)));
 end loop;
 return out;
end $f$;
revoke all on function public.usi_reverify_claim(integer) from public, anon, authenticated;
grant execute on function public.usi_reverify_claim(integer) to service_role;

-- Name or date of birth changed after a check: the result is stale and is checked again automatically.
create or replace function public.usi_person_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if (old.details ->> 'first_name', old.details ->> 'last_name', old.details ->> 'dob') is not distinct from (new.details ->> 'first_name', new.details ->> 'last_name', new.details ->> 'dob') then
  return null;
 end if;
 update public.application_usi u set status = 'stale', reverify_attempts = 0, reverify_next_at = now(), reverify_last_error = null, updated_at = now()
 from public.enrollment_applications a
 where a.student_id = new.id and u.application_id = a.id and u.verified_at is not null and u.usi is not null
  and u.person_hash is distinct from public.usi_person_hash(coalesce(new.details, '{}'::jsonb) || coalesce(a.data -> 'values', '{}'::jsonb));
 if found then
  begin perform public.usi_reverify_dispatch(); exception when others then null; end;  -- the 10-minute job picks it up otherwise
 end if;
 return null;
end $f$;
drop trigger if exists zz_usi_person_changed on public.enrollment_students;
create trigger zz_usi_person_changed after update of details on public.enrollment_students
 for each row execute function public.usi_person_changed();

do $$ begin
 if exists (select 1 from cron.job where jobname = 'usi-reverify') then perform cron.unschedule('usi-reverify'); end if;
 perform cron.schedule('usi-reverify', '*/10 * * * *', 'select public.usi_reverify_dispatch();');
end $$;
