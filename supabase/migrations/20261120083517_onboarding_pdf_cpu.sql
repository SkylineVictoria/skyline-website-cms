-- document-signing CPU budget (2026-11-20: "Send to point of contact" died with 546 WORKER_RESOURCE_LIMIT, CPU 2.6-3.1 s of 2 s).
--
--   * The F04 + P06 merged blank is built ONCE per pair of template versions and cached in storage (public.agency_onboarding_blank_cache);
--     a send only appends its marks to it (incremental update).
--   * The agency admin's signature no longer splits the 15-page signed PDF or sends the referee checks in the same request: the
--     signature commits the whole signed document (form_content, split_pending), then document-signing is called again through pg_net
--     (agency_onboarding_followup_queue, job 'onboarding-followup' in public.cron_http_calls) to split it (agency_onboarding_split_source /
--     _split_store) and, in another call, to send the referee checks and the staff emails. Each call has its own CPU budget.
--   * Approve needs the split agreement: until the split call has run (seconds) it says so.
-- Additive: one column, one table, six functions; accept_signed patched in place (single-line anchor), signed_once replaced.
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

alter table public.agency_onboarding add column if not exists split_pending boolean not null default false;
comment on column public.agency_onboarding.split_pending is 'The combined signed PDF waits to be split into the application form and the agreement (onboarding-followup call).';

-- ------------------------------------------------------------------ the merged blank cache (staff)
create table if not exists public.agency_onboarding_blank_cache(
 cache_key text primary key check (char_length(cache_key) between 10 and 300),
 path text not null check (path ~ '^templates/[0-9a-f-]{36}/combined-[A-Za-z0-9._-]+\.pdf$'),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 pages integer not null check (pages between 1 and 100),
 created_at timestamptz not null default now()
);
alter table public.agency_onboarding_blank_cache enable row level security;
revoke all on public.agency_onboarding_blank_cache from public, anon, authenticated;
comment on table public.agency_onboarding_blank_cache is 'The application form + agreement blanks merged once per pair of template versions (key: template ids and source hashes).';

create or replace function public.agency_onboarding_blank_cache_get(p_key text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare c public.agency_onboarding_blank_cache;
begin
 perform hr.require_admin();
 select * into c from public.agency_onboarding_blank_cache where cache_key = p_key;
 return case when c.cache_key is null then null else jsonb_build_object('path', c.path, 'sha256', c.sha256, 'pages', c.pages) end;
end $f$;
revoke all on function public.agency_onboarding_blank_cache_get(text) from public, anon;
grant execute on function public.agency_onboarding_blank_cache_get(text) to authenticated;

-- Two staff building it at once: the first row wins, the second is told which file to use (and removes its own copy).
create or replace function public.agency_onboarding_blank_cache_put(p_key text, p_path text, p_sha256 text, p_pages integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare c public.agency_onboarding_blank_cache;
begin
 perform hr.require_admin();
 insert into public.agency_onboarding_blank_cache(cache_key, path, sha256, pages) values (p_key, p_path, p_sha256, p_pages) on conflict (cache_key) do nothing;
 select * into c from public.agency_onboarding_blank_cache where cache_key = p_key;
 return jsonb_build_object('path', c.path, 'sha256', c.sha256, 'pages', c.pages, 'mine', c.path = p_path);
end $f$;
revoke all on function public.agency_onboarding_blank_cache_put(text, text, text, integer) from public, anon;
grant execute on function public.agency_onboarding_blank_cache_put(text, text, text, integer) to authenticated;

-- ------------------------------------------------------------------ the signature commits the whole signed document; the split follows
-- A combined request signed without form_base64 / agreement_base64 (document-signing v40+): the whole signed PDF is kept as the form for
-- now and the split is pending. With them (an older caller), the earlier behaviour.
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$   begin v_form := decode(coalesce(p_data->>'form_base64', ''), 'base64'); v_agreement := decode(coalesce(p_data->>'agreement_base64', ''), 'base64');$a$,
 $a$   begin if nullif(p_data->>'form_base64', '') is null then v_form := p_signed; v_agreement := null;
    else v_form := decode(coalesce(p_data->>'form_base64', ''), 'base64'); v_agreement := decode(coalesce(p_data->>'agreement_base64', ''), 'base64'); end if;$a$);

create or replace function public.agency_onboarding_signed_once(p_onboarding uuid, p_request uuid, p_recipient uuid, p_agreement bytea, p_data jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare r hr.sign_requests; c hr.sign_recipients; v_event jsonb;
begin
 select * into r from hr.sign_requests where id = p_request;
 select * into c from hr.sign_recipients where id = p_recipient;
 v_event := jsonb_strip_nulls(jsonb_build_object('at', coalesce(r.signed_at, now()), 'request', r.reference, 'requestId', r.id, 'recipientId', c.id, 'signer', c.signer_name,
  'signatureKind', c.signature_kind, 'signatureHash', p_data->>'signature_hash', 'ip', coalesce(nullif(p_data->>'ip', ''), c.ip::text), 'userAgent', left(p_data->>'user_agent', 300),
  'documentHash', r.signed_hash, 'documents', jsonb_build_array('Agent Application Form (F04)', 'Education Agent Agreement (P06)')));
 update public.agency_onboarding set agreement_content = p_agreement, split_pending = (p_agreement is null), signature_event = v_event, signed_at = coalesce(r.signed_at, now()),
  signer_name = c.signer_name where id = p_onboarding;
 perform public.agency_onboarding_log(p_onboarding, 'signed_once', v_event);
end $f$;
revoke all on function public.agency_onboarding_signed_once(uuid, uuid, uuid, bytea, jsonb) from public, anon, authenticated;

-- What the split call needs: the signed document of the current application request.
create or replace function public.agency_onboarding_split_source(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests;
begin
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 select * into r from hr.sign_requests where id = o.application_request_id;
 return jsonb_build_object('pending', o.split_pending and o.combined, 'requestId', r.id, 'state', r.state, 'path', r.signed_path, 'hash', r.signed_hash, 'formPages', o.form_pages);
end $f$;
revoke all on function public.agency_onboarding_split_source(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_split_source(uuid) to service_role;

create or replace function public.agency_onboarding_split_store(p_onboarding uuid, p_request uuid, p_form text, p_agreement text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v_form bytea; v_agreement bytea;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if not o.split_pending or o.application_request_id is distinct from p_request then return jsonb_build_object('stored', false); end if;
 begin v_form := decode(coalesce(p_form, ''), 'base64'); v_agreement := decode(coalesce(p_agreement, ''), 'base64');
 exception when others then raise exception 'The split documents could not be read' using errcode = '22023'; end;
 if length(v_form) < 5 or length(v_agreement) < 5 or substring(v_form from 1 for 4) <> '\x25504446'::bytea or substring(v_agreement from 1 for 4) <> '\x25504446'::bytea then
  raise exception 'The split documents could not be read' using errcode = '22023'; end if;
 update public.agency_onboarding set form_content = v_form, agreement_content = v_agreement, split_pending = false where id = o.id;
 perform public.agency_onboarding_log(o.id, 'documents_split', jsonb_build_object('formBytes', length(v_form), 'agreementBytes', length(v_agreement)));
 return jsonb_build_object('stored', true);
end $f$;
revoke all on function public.agency_onboarding_split_store(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_split_store(uuid, uuid, text, text) to service_role;

-- The follow-up call: document-signing with the scheduled jobs' service key (vault), logged as job 'onboarding-followup'.
create or replace function public.agency_onboarding_followup_queue(p_onboarding uuid, p_step text) returns bigint
language plpgsql security definer set search_path = pg_catalog, public, vault as $f$
declare v_key text; v_url text;
begin
 if p_step not in ('split', 'after_application') then raise exception 'Unknown follow-up step' using errcode = '22023'; end if;
 if not exists (select 1 from public.agency_onboarding where id = p_onboarding) then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'signing_service_role_key' limit 1;
 select decrypted_secret into v_url from vault.decrypted_secrets where name = 'signing_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/document-signing$' then raise exception 'The follow-up call is not configured'; end if;
 return public.cron_http_post('onboarding-followup', url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := jsonb_build_object('action', 'onboarding_followup', 'onboardingId', p_onboarding, 'step', p_step), timeout_milliseconds := 55000);
end $f$;
revoke all on function public.agency_onboarding_followup_queue(uuid, text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_followup_queue(uuid, text) to service_role;

-- Approve while the split is still pending: a plain message instead of "the signed agreement is missing".
create or replace function public.agency_onboarding_approve(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage = 'references_approved' then
  select * into a from public.agencies where id = o.agency_id;
  return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'already', true, 'combined', o.combined, 'slitWitness', o.slit_witness_png is not null); end if;
 if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted') then
  raise exception 'The application can be approved once it is signed (and a correction, if any, is resubmitted).' using errcode = '22023'; end if;
 if o.combined and o.split_pending then raise exception 'The signed documents are still being prepared. Try again in a minute.' using errcode = '22023'; end if;
 if o.combined and o.agreement_content is null then raise exception 'The signed agreement is missing: the application cannot be approved.' using errcode = '22023'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 update public.agency_onboarding set stage = 'references_approved', approved_by = auth.uid(), approved_at = now() where id = o.id returning * into o;
 update public.agencies set status = 'Active', updated_at = now() where id = o.agency_id and status = 'Onboarding' returning * into a;
 if a.id is null then select * into a from public.agencies where id = o.agency_id; end if;
 perform public.agency_onboarding_log(o.id, 'approved', jsonb_build_object('received', v_received, 'total', v_total, 'refereesPending', greatest(v_total - v_received, 0),
  'rounds', (select count(*) from public.agency_onboarding_corrections c where c.onboarding_id = o.id), 'combined', o.combined));
 perform public.admin_business_audit('business_approved', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'status', a.status, 'refereesReceived', v_received, 'refereesTotal', v_total));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'combined', o.combined, 'refereesPending', greatest(v_total - v_received, 0), 'slitWitness', o.slit_witness_png is not null);
end $f$;
revoke all on function public.agency_onboarding_approve(uuid) from public, anon;
grant execute on function public.agency_onboarding_approve(uuid) to authenticated;
