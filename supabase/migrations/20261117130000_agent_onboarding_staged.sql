-- Agent onboarding in stages (owner brief 2026-11-17, second brief): the Agent Application Form (F04) goes first; when the agent has signed
-- it, an Agent Referee Check Form (F05) goes to each of the two referees named on it (external people: the emailed link of the Sign
-- module, no account); when both are back ("References received") staff send the Agent Agreement (P06), or earlier with a typed reason
-- (override, logged). Additive on 20261117120000: a stage on the onboarding, one row per referee (their request, their signed or
-- uploaded F05, their answers), a history log, kind-aware completion (the one signed PDF of each request is the document itself; only
-- the legacy merged requests are split). Existing rows keep stage 'legacy' and their merged request. Authorization as before: CMS Admin
-- through the RPCs below / the Edge Function; the service role for what runs on completion; agency members read their own onboarding
-- but never a referee's answers; a referee only holds the token of their own request.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ schema
alter table public.agency_onboarding
 add column if not exists stage text not null default 'legacy',
 add column if not exists application_request_id uuid references hr.sign_requests(id) on delete set null,
 add column if not exists agreement_request_id uuid references hr.sign_requests(id) on delete set null,
 add column if not exists application_certificate_content bytea,
 add column if not exists application_signed_at timestamptz,
 add column if not exists references_received_at timestamptz,
 add column if not exists override_reason text,
 add column if not exists override_by uuid,
 add column if not exists override_at timestamptz,
 add column if not exists message text;
alter table public.agency_onboarding drop constraint if exists agency_onboarding_stage_check;
alter table public.agency_onboarding add constraint agency_onboarding_stage_check
 check (stage in ('legacy','application_sent','application_signed','references_pending','references_received','agreement_sent','agreement_signed','cancelled','expired'));
alter table public.agency_onboarding alter column request_id drop not null;
alter table public.agency_onboarding alter column commencement_date drop not null;
alter table public.agency_onboarding alter column expiry_date drop not null;
create index if not exists agency_onboarding_application_request_idx on public.agency_onboarding(application_request_id) where application_request_id is not null;
create index if not exists agency_onboarding_agreement_request_idx on public.agency_onboarding(agreement_request_id) where agreement_request_id is not null;

create table if not exists public.agency_onboarding_referees (
 id uuid primary key default gen_random_uuid(),
 onboarding_id uuid not null references public.agency_onboarding(id) on delete cascade,
 position integer not null check (position in (1, 2)),
 contact_name text not null default '' check (length(contact_name) <= 150),
 organisation text not null default '' check (length(organisation) <= 200),
 position_title text not null default '' check (length(position_title) <= 150),
 email text not null check (length(email) <= 254),
 phone text not null default '' check (length(phone) <= 80),
 address text not null default '' check (length(address) <= 300),
 status text not null default 'pending' check (status in ('pending','sent','received','cancelled')),
 request_id uuid references hr.sign_requests(id) on delete set null,
 domain_warning boolean not null default false,
 received_at timestamptz,
 received_via text check (received_via is null or received_via in ('signed','upload')),
 form_content bytea,
 certificate_content bytea,
 answers jsonb not null default '{}'::jsonb,
 file_name text,
 uploaded_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (onboarding_id, position)
);
create index if not exists agency_onboarding_referees_request_idx on public.agency_onboarding_referees(request_id) where request_id is not null;
alter table public.agency_onboarding_referees enable row level security;
revoke all on table public.agency_onboarding_referees from public, anon, authenticated;

create table if not exists public.agency_onboarding_events (
 id bigserial primary key,
 onboarding_id uuid not null references public.agency_onboarding(id) on delete cascade,
 at timestamptz not null default now(),
 actor uuid,
 actor_name text not null default '',
 event text not null check (length(event) between 1 and 60),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists agency_onboarding_events_idx on public.agency_onboarding_events(onboarding_id, id);
alter table public.agency_onboarding_events enable row level security;
revoke all on table public.agency_onboarding_events from public, anon, authenticated;
revoke all on sequence public.agency_onboarding_events_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------------ helpers (internal)
create or replace function public.agency_onboarding_log(p_onboarding uuid, p_event text, p_detail jsonb default '{}'::jsonb, p_actor uuid default null) returns void
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_actor uuid := coalesce(p_actor, auth.uid()); v_name text;
begin
 if v_actor is not null then
  select name into v_name from public.cms_users where auth_user_id = v_actor limit 1;
  if v_name is null then select full_name into v_name from public.portal_profiles where auth_user_id = v_actor limit 1; end if;
 end if;
 insert into public.agency_onboarding_events(onboarding_id, actor, actor_name, event, detail) values (p_onboarding, v_actor, coalesce(v_name, case when v_actor is null then 'System' else '' end), p_event, coalesce(p_detail, '{}'::jsonb));
end $f$;
revoke all on function public.agency_onboarding_log(uuid, text, jsonb, uuid) from public, anon, authenticated;

/** Which document a request of an onboarding is: merged (legacy), application, referee or agreement. */
create or replace function public.agency_onboarding_request_kind(p_onboarding uuid, p_request uuid) returns text
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case when o.request_id = p_request then 'merged' when o.application_request_id = p_request then 'application' when o.agreement_request_id = p_request then 'agreement'
  when exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.request_id = p_request) then 'referee' end
 from public.agency_onboarding o where o.id = p_onboarding;
$f$;
revoke all on function public.agency_onboarding_request_kind(uuid, uuid) from public, anon, authenticated;

/** The host of an email address or a web address, without "www." (for the referee domain warning). */
create or replace function public.agency_onboarding_domain(p_value text) returns text
language sql immutable set search_path = pg_catalog as $f$
 select nullif(regexp_replace(lower(coalesce(
  case when p_value like '%@%' then split_part(p_value, '@', 2) else regexp_replace(regexp_replace(btrim(p_value), '^[a-z]+://', '', 'i'), '[/?#:].*$', '') end, '')), '^www\.', ''), '');
$f$;

/** The referees' stage from their rows: application_signed (none contacted), references_pending (some outstanding), references_received (both back). */
create or replace function public.agency_onboarding_recompute(p_onboarding uuid) returns text
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare o public.agency_onboarding; v_received integer; v_total integer; v_sent integer; v_stage text;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.stage not in ('application_signed', 'references_pending', 'references_received') then return o.stage; end if;
 select count(*), count(*) filter (where status = 'received'), count(*) filter (where status = 'sent') into v_total, v_received, v_sent from public.agency_onboarding_referees where onboarding_id = o.id;
 v_stage := case when v_total > 0 and v_received >= v_total then 'references_received' when v_sent > 0 or v_received > 0 then 'references_pending' else 'application_signed' end;
 if v_stage <> o.stage then
  update public.agency_onboarding set stage = v_stage, references_received_at = case when v_stage = 'references_received' then coalesce(references_received_at, now()) else references_received_at end where id = o.id;
  if v_stage = 'references_received' then perform public.agency_onboarding_log(o.id, 'references_received', jsonb_build_object('received', v_received, 'total', v_total)); end if;
 end if;
 return v_stage;
end $f$;
revoke all on function public.agency_onboarding_recompute(uuid) from public, anon, authenticated;

/** A request's summary for the business page and the portal. */
create or replace function public.agency_onboarding_request_json(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select case when p_request is null then null else (select jsonb_build_object('id', r.id, 'reference', r.reference, 'state', r.state, 'expiresAt', r.expires_at, 'sentAt', r.sent_at, 'viewedAt', r.viewed_at, 'signedAt', r.signed_at,
   'recipientId', c.id, 'recipientState', c.state, 'lastNotifiedAt', c.last_notified_at, 'reminderCount', c.reminder_count)
  from hr.sign_requests r left join lateral (select * from hr.sign_recipients k where k.request_id = r.id order by k.signing_order limit 1) c on true where r.id = p_request) end;
$f$;
revoke all on function public.agency_onboarding_request_json(uuid) from public, anon, authenticated;

-- What the signing page and the function learn about an onboarding request: the kind (only a merged legacy request is split), the page
-- split, the agency's name.
create or replace function public.agency_onboarding_plan(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case when p_id is null then null else (select jsonb_build_object('id', o.id, 'formPages', o.form_pages, 'agencyName', a.name, 'agencyId', a.id, 'stage', o.stage, 'kind', 'unknown')
  from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.id = p_id) end;
$f$;
/** The plan of one request: as agency_onboarding_plan, with the kind of document this request is. */
create or replace function public.agency_onboarding_request_plan(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select case when r.agency_onboarding_id is null then null else public.agency_onboarding_plan(r.agency_onboarding_id) || jsonb_build_object('kind', public.agency_onboarding_request_kind(r.agency_onboarding_id, r.id)) end
 from hr.sign_requests r where r.id = p_request;
$f$;
revoke all on function public.agency_onboarding_request_plan(uuid) from public, anon, authenticated;

-- public.signing_service: the plan carries the request's kind (anchored in-place patches of the two calls made on 2026-11-17).
do $$
declare d text; o text; n text; k integer;
begin
 d := pg_get_functiondef('public.signing_service(text, text, uuid, jsonb)'::regprocedure);
 o := $a$public.agency_onboarding_plan(r.agency_onboarding_id)$a$;
 n := $a$public.agency_onboarding_request_plan(r.id)$a$;
 k := (length(d) - length(replace(d, o, ''))) / length(o);
 if k <> 2 then raise exception 'public.signing_service: plan anchor found % times', k; end if;
 execute replace(d, o, n);
end $$;

-- ------------------------------------------------------------------ completion, by kind
-- A completed request of an onboarding: the merged legacy document is split by the function (form_base64 / agreement_base64); every
-- other request's signed PDF is the document itself. The application form validates the two referees and creates their rows; a
-- referee check marks its referee received; the agreement runs the agreement logic (status, two-year term, profile).
create or replace function public.agency_onboarding_accept_signed(p_onboarding uuid, p_request uuid, p_recipient uuid, p_signed bytea, p_certificate bytea, p_data jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; c hr.sign_recipients; a public.agencies; g public.agents; pp public.portal_profiles; f record; v_kind text;
 v_form bytea; v_agreement bytea; v_answers jsonb := '{}'::jsonb; v_group text; v_ticks jsonb := '{}'::jsonb; v_key text; v_n integer; v_email text; v_emails text[]; v_own text[];
 v_domains text[]; v_stage text; k_email constant text := '^[^[:space:]@<>,]+@[^[:space:]@<>,]+\.[^[:space:]@<>,]+$';
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found'; end if;
 select * into r from hr.sign_requests where id = p_request;
 select * into c from hr.sign_recipients where id = p_recipient;
 if r.id is null or c.request_id is distinct from r.id then raise exception 'The signing request does not belong to this onboarding'; end if;
 v_kind := public.agency_onboarding_request_kind(o.id, r.id);
 if v_kind is null then raise exception 'The signing request does not belong to this onboarding'; end if;
 if length(coalesce(p_signed, ''::bytea)) < 5 or length(coalesce(p_certificate, ''::bytea)) < 5 or substring(p_signed from 1 for 4) <> '\x25504446'::bytea then
  raise exception 'The signed documents could not be stored. Please select Sign again';
 end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 -- The answers: a question answered by tick boxes gives one word (YES / NO); everything else its text. Two boxes of one question is refused.
 for f in select q.key, q.type, q.value from hr.sign_fields q where q.request_id = r.id and q.key is not null order by q.page, q.y, q.x loop
  if position(':' in f.key) > 0 then
   v_group := split_part(f.key, ':', 1);
   if f.value = 'true' then
    if v_ticks ? v_group then raise exception 'Answer % with one tick only', replace(v_group, '_', ' '); end if;
    v_ticks := v_ticks || jsonb_build_object(v_group, true);
    v_answers := v_answers || jsonb_build_object(v_group, split_part(f.key, ':', 2));
   end if;
  elsif f.type in ('text', 'date') and nullif(btrim(coalesce(f.value, '')), '') is not null then
   v_key := regexp_replace(f.key, '_(form|referee)$', '');
   v_answers := v_answers || jsonb_build_object(v_key, btrim(f.value));
  end if;
 end loop;
 if v_kind in ('merged', 'application') then
  foreach v_key in array array['litigation_involved', 'eatc_completed'] loop
   if not (v_answers ? v_key) and exists (select 1 from hr.sign_fields q where q.request_id = r.id and q.key like v_key || ':%') then
    raise exception 'Answer Yes or No: %', replace(v_key, '_', ' ');
   end if;
  end loop;
 end if;

 if v_kind = 'merged' then
  begin v_form := decode(coalesce(p_data->>'form_base64', ''), 'base64'); v_agreement := decode(coalesce(p_data->>'agreement_base64', ''), 'base64');
  exception when others then raise exception 'The signed documents could not be stored. Please select Sign again'; end;
  if length(v_form) < 5 or length(v_agreement) < 5 or substring(v_form from 1 for 4) <> '\x25504446'::bytea or substring(v_agreement from 1 for 4) <> '\x25504446'::bytea then
   raise exception 'The signed documents could not be stored. Please select Sign again';
  end if;
  update public.agency_onboarding set status = 'signed', signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name, form_content = v_form, agreement_content = v_agreement,
   certificate_content = p_certificate, answers = v_answers where id = o.id returning * into o;
  update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date' - 'admin_signed_date'),
   agreement_status = 'signed', agreement_commencement_date = o.commencement_date, agreement_expiry_date = o.expiry_date, agreement_onboarding_id = o.id, updated_at = now()
   where id = o.agency_id;
  perform public.admin_business_audit('agent_agreement_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'signer', c.signer_name));
  return;
 end if;

 if v_kind = 'application' then
  if o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature'; end if;
  -- Two referees with well-formed, different email addresses, neither the agent's own (contact or login) address.
  if g.profile_id is not null then select * into pp from public.portal_profiles where id = g.profile_id; end if;
  v_own := array_remove(array[lower(btrim(coalesce(g.email, ''))), lower(btrim(coalesce(pp.email, ''))), lower(btrim(coalesce(v_answers->>'contact_email', '')))], '');
  v_emails := array[lower(btrim(coalesce(v_answers->>'ref1_email', ''))), lower(btrim(coalesce(v_answers->>'ref2_email', '')))];
  for v_n in 1..2 loop
   if v_emails[v_n] !~ k_email then raise exception 'Enter a valid email address for reference %', v_n; end if;
   if v_emails[v_n] = any(v_own) then raise exception 'Reference % cannot use your own email address', v_n; end if;
   if nullif(btrim(coalesce(v_answers->>('ref' || v_n || '_contact_name'), '')), '') is null then raise exception 'Give the contact name of reference %', v_n; end if;
  end loop;
  if v_emails[1] = v_emails[2] then raise exception 'The two references need different email addresses'; end if;
  v_domains := array_remove(array[public.agency_onboarding_domain(a.business_email), public.agency_onboarding_domain(coalesce(v_answers->>'agent_website', a.profile->>'agent_website')),
   public.agency_onboarding_domain(coalesce(v_answers->>'contact_email', g.email))], null);
  update public.agency_onboarding set form_content = p_signed, application_certificate_content = p_certificate, answers = coalesce(answers, '{}'::jsonb) || v_answers,
   application_signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name, stage = 'application_signed' where id = o.id returning * into o;
  update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date'), updated_at = now() where id = o.agency_id;
  delete from public.agency_onboarding_referees where onboarding_id = o.id and status = 'pending' and request_id is null;
  for v_n in 1..2 loop
   v_email := v_emails[v_n];
   insert into public.agency_onboarding_referees(onboarding_id, position, contact_name, organisation, position_title, email, phone, address, domain_warning)
   values (o.id, v_n, left(btrim(coalesce(v_answers->>('ref' || v_n || '_contact_name'), '')), 150), left(btrim(coalesce(v_answers->>('ref' || v_n || '_organisation'), '')), 200),
    left(btrim(coalesce(v_answers->>('ref' || v_n || '_position'), '')), 150), v_email, left(btrim(coalesce(v_answers->>('ref' || v_n || '_phone'), '')), 80),
    left(btrim(coalesce(v_answers->>('ref' || v_n || '_address'), '')), 300), public.agency_onboarding_domain(v_email) = any(v_domains));
  end loop;
  perform public.agency_onboarding_log(o.id, 'application_signed', jsonb_build_object('request', r.reference, 'signer', c.signer_name, 'referees', v_emails));
  perform public.admin_business_audit('agent_application_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'signer', c.signer_name));
  return;
 end if;

 if v_kind = 'referee' then
  update public.agency_onboarding_referees set status = 'received', received_via = 'signed', received_at = coalesce(r.signed_at, now()), form_content = p_signed, certificate_content = p_certificate,
   answers = v_answers, updated_at = now() where onboarding_id = o.id and request_id = r.id and status <> 'received' returning position into v_n;
  if v_n is null then raise exception 'This reference is already received'; end if;
  perform public.agency_onboarding_log(o.id, 'referee_received', jsonb_build_object('position', v_n, 'request', r.reference, 'signer', c.signer_name, 'via', 'signed'));
  v_stage := public.agency_onboarding_recompute(o.id);
  return;
 end if;

 if v_kind = 'agreement' then
  if o.stage <> 'agreement_sent' then raise exception 'This agreement is no longer waiting for a signature'; end if;
  update public.agency_onboarding set status = 'signed', stage = 'agreement_signed', signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name, agreement_content = p_signed,
   certificate_content = p_certificate, answers = coalesce(answers, '{}'::jsonb) || v_answers where id = o.id returning * into o;
  update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date' - 'admin_signed_date'),
   agreement_status = 'signed', agreement_commencement_date = o.commencement_date, agreement_expiry_date = o.expiry_date, agreement_onboarding_id = o.id, updated_at = now()
   where id = o.agency_id;
  perform public.agency_onboarding_log(o.id, 'agreement_signed', jsonb_build_object('request', r.reference, 'signer', c.signer_name, 'commencement', o.commencement_date, 'expiry', o.expiry_date));
  perform public.admin_business_audit('agent_agreement_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'signer', c.signer_name));
  return;
 end if;
end $f$;
revoke all on function public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb) from public, anon, authenticated;

-- A request that is declined, voided or expired: the merged legacy request closes the onboarding (as before); an application or
-- agreement request waiting for a signature cancels / expires the onboarding; a referee's request cancels that reference unless it was
-- already received (a changed email address or an uploaded form voids the old request on purpose).
create or replace function public.agency_onboarding_close() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $f$
declare o public.agency_onboarding; v_kind text; v_stage text; v_n integer;
begin
 if new.agency_onboarding_id is null or new.state not in ('declined', 'void', 'expired') or new.state is not distinct from old.state then return new; end if;
 select * into o from public.agency_onboarding where id = new.agency_onboarding_id;
 if not found then return new; end if;
 v_kind := public.agency_onboarding_request_kind(o.id, new.id);
 v_stage := case when new.state = 'expired' then 'expired' else 'cancelled' end;
 if v_kind = 'merged' then
  update public.agency_onboarding set status = 'closed', closed_reason = new.state, stage = case when stage = 'legacy' then stage else v_stage end where id = o.id and status <> 'signed';
  update public.agencies a set agreement_status = 'none', agreement_onboarding_id = null where a.agreement_onboarding_id = o.id and a.agreement_status = 'sent';
 elsif v_kind = 'referee' then
  update public.agency_onboarding_referees set status = 'cancelled', updated_at = now() where onboarding_id = o.id and request_id = new.id and status in ('pending', 'sent') returning position into v_n;
  if v_n is not null then
   perform public.agency_onboarding_log(o.id, 'referee_check_closed', jsonb_build_object('position', v_n, 'request', new.reference, 'state', new.state));
   perform public.agency_onboarding_recompute(o.id);
  end if;
 elsif v_kind = 'application' and o.stage = 'application_sent' then
  update public.agency_onboarding set status = 'closed', closed_reason = new.state, stage = v_stage where id = o.id;
  perform public.agency_onboarding_log(o.id, v_stage, jsonb_build_object('document', 'application', 'request', new.reference, 'state', new.state));
 elsif v_kind = 'agreement' and o.stage = 'agreement_sent' then
  update public.agency_onboarding set status = 'closed', closed_reason = new.state, stage = v_stage where id = o.id;
  update public.agencies a set agreement_status = 'none' where a.agreement_onboarding_id = o.id and a.agreement_status = 'sent';
  perform public.agency_onboarding_log(o.id, v_stage, jsonb_build_object('document', 'agreement', 'request', new.reference, 'state', new.state));
 end if;
 return new;
end $f$;

-- ------------------------------------------------------------------ what runs after a signature (service role: the Edge Function)
-- Everything the function needs after a completion or to send a referee check: the referees still to contact (with their prefill), who to
-- notify (the agent; the staff member who started the onboarding and the admissions contact) and whether that was done.
create or replace function public.agency_onboarding_followup(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; st public.cms_settings; v_staff text; v_staff_name text;
begin
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found then raise exception 'Onboarding record not found'; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 select * into st from public.cms_settings order by id limit 1;
 if o.sent_by is not null then select email, name into v_staff, v_staff_name from public.cms_users where auth_user_id = o.sent_by limit 1; end if;
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'status', o.status,
  'agency', jsonb_build_object('id', a.id, 'name', a.name),
  'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email),
  'sentBy', jsonb_build_object('email', v_staff, 'name', v_staff_name),
  'contacts', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(array_remove(array[lower(nullif(btrim(coalesce(st.admissions_email, '')), '')), lower(nullif(btrim(coalesce(st.email, '')), ''))], null)) x),
  'values', jsonb_build_object('agent_agency_name', a.name,
   'agent_office_address', array_to_string(array_remove(array[nullif(btrim(coalesce(o.answers->>'office_street_address', '')), ''), nullif(btrim(coalesce(o.answers->>'office_suburb', '')), ''),
    nullif(btrim(coalesce(o.answers->>'office_state', '')), ''), nullif(btrim(coalesce(o.answers->>'office_province', '')), ''), nullif(btrim(coalesce(o.answers->>'office_country', '')), '')], null), ', ')),
  'referees', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position, 'name', f.contact_name, 'organisation', f.organisation, 'positionTitle', f.position_title, 'email', f.email,
    'phone', f.phone, 'address', f.address, 'status', f.status, 'requestId', f.request_id, 'domainWarning', f.domain_warning) order by f.position) from public.agency_onboarding_referees f where f.onboarding_id = o.id), '[]'::jsonb),
  'received', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status = 'received'),
  'total', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id),
  'template', (select jsonb_build_object('id', t.id, 'systemKey', t.system_key, 'status', t.status, 'sourcePath', t.source_path, 'sourceHash', t.source_hash, 'sourcePages', t.source_pages, 'fields', t.fields,
    'expiryDays', t.expiry_days, 'reminderDays', t.reminder_days) from hr.sign_templates t where t.system_key = 'agent_referee_check_form' and t.status = 'active' and t.deleted_at is null limit 1),
  'notified', jsonb_build_object('agentReferees', exists (select 1 from public.agency_onboarding_events e where e.onboarding_id = o.id and e.event = 'agent_notified_referees'),
   'staffReferences', exists (select 1 from public.agency_onboarding_events e where e.onboarding_id = o.id and e.event = 'staff_notified_references')));
end $f$;
revoke all on function public.agency_onboarding_followup(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_followup(uuid) to service_role;

-- The referee's request, made and sent from the database as the offer letter's is (no administrator session: it runs when the agent has
-- signed). The function has stored the prefilled F05 as <id>/original.pdf; the invite email carries the request's message.
create or replace function public.agency_onboarding_referee_request_create(p_referee uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare f public.agency_onboarding_referees; o public.agency_onboarding; r hr.sign_requests; c hr.sign_recipients; v jsonb; v_id uuid; v_days integer; v_remind integer;
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into f from public.agency_onboarding_referees where id = p_referee for update;
 if not found then raise exception 'Referee not found'; end if;
 select * into o from public.agency_onboarding where id = f.onboarding_id for update;
 if f.status <> 'pending' or f.request_id is not null then raise exception 'This referee already has a request'; end if;
 if o.stage not in ('application_signed', 'references_pending') then raise exception 'The referee checks are sent once the application form is signed'; end if;
 if coalesce(p_data->>'original_hash', '') !~ '^[a-f0-9]{64}$' then raise exception 'The referee check document is missing'; end if;
 v_days := least(greatest(coalesce((p_data->>'expiry_days')::integer, 30), 1), 365); v_remind := least(greatest(coalesce((p_data->>'reminder_days')::integer, 3), 0), 60);
 v_id := coalesce((p_data->>'id')::uuid, gen_random_uuid());
 insert into hr.sign_requests(id, title, recipient_name, recipient_email, original_path, original_hash, state, created_by, reference, signing_mode, subject_type, subject_id, category,
   expiry_days, reminder_days, message, agency_onboarding_id, template_id, require_code, field_values)
 values (v_id, left(coalesce(nullif(btrim(coalesce(p_data->>'title', '')), ''), 'Agent referee check'), 200), left(f.contact_name, 150), f.email, v_id::text || '/original.pdf', p_data->>'original_hash', 'draft',
   coalesce(o.sent_by, '00000000-0000-0000-0000-000000000000'::uuid), 'SLIT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0'), 'sequential', 'agent', o.agent_id, 'other',
   v_days, v_remind, nullif(left(coalesce(p_data->>'message', ''), 2000), ''), o.id, (p_data->>'template_id')::uuid, false, coalesce(p_data->'values', '{}'::jsonb))
 returning * into r;
 insert into hr.sign_recipients(request_id, role_key, role_label, name, email, signing_order, required, state)
 values (r.id, 'referee', 'Referee', left(coalesce(nullif(btrim(f.contact_name), ''), 'Referee'), 150), f.email, 1, true, 'pending') returning * into c;
 for v in select * from jsonb_array_elements(coalesce(p_data->'fields', '[]'::jsonb)) loop
  insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label, key, value)
  values (r.id, c.id, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric, (v->>'w')::numeric, (v->>'h')::numeric, coalesce((v->>'required')::boolean, true),
   left(coalesce(v->>'label', ''), 120), nullif(left(coalesce(v->>'key', ''), 80), ''), case when v->>'type' = 'text' then nullif(left(coalesce(v->>'value', ''), 500), '') end);
 end loop;
 perform hr.sign_event(r.id, 'created', null, null, jsonb_build_object('onboarding', o.id, 'referee', f.position, 'original_hash', r.original_hash));
 update hr.sign_requests set state = 'sent', sent_at = now(), expires_at = now() + make_interval(days => v_days) where id = r.id returning * into r;
 perform hr.sign_event(r.id, 'sent', null, null, jsonb_build_object('mode', r.signing_mode, 'expires_at', r.expires_at));
 perform hr.sign_activate(r.id);
 update public.agency_onboarding_referees set request_id = r.id, status = 'sent', updated_at = now() where id = f.id;
 perform public.agency_onboarding_log(o.id, 'referee_check_sent', jsonb_build_object('position', f.position, 'email', f.email, 'request', r.reference));
 perform public.agency_onboarding_recompute(o.id);
 return jsonb_build_object('requestId', r.id, 'reference', r.reference, 'recipientId', c.id, 'expiresAt', r.expires_at);
end $f$;
revoke all on function public.agency_onboarding_referee_request_create(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_referee_request_create(uuid, jsonb) to service_role;

/** Records that a notification email went out (so it goes once): the agent told their referees were contacted, the staff told both are back. */
create or replace function public.agency_onboarding_mark_notified(p_onboarding uuid, p_kind text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if p_kind not in ('agent_notified_referees', 'staff_notified_references') then raise exception 'Unknown notification'; end if;
 if exists (select 1 from public.agency_onboarding_events e where e.onboarding_id = p_onboarding and e.event = p_kind) then return; end if;
 perform public.agency_onboarding_log(p_onboarding, p_kind, coalesce(p_detail, '{}'::jsonb));
end $f$;
revoke all on function public.agency_onboarding_mark_notified(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_mark_notified(uuid, text, jsonb) to service_role;

-- ------------------------------------------------------------------ administrator RPCs
-- Starts an onboarding: the application form's draft request (made by the function, subject: this business's agent) becomes stage
-- application_sent. Replaces the merged create of 20261117120000 (legacy rows keep their merged request).
create or replace function public.agency_onboarding_create(p_agency uuid, p_agent uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; g public.agents; r hr.sign_requests; o public.agency_onboarding;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into a from public.agencies where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 select * into g from public.agents where id = p_agent and business_id = a.id;
 if not found then raise exception 'Choose an agent of this business'; end if;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from g.id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this agent'; end if;
 if exists (select 1 from public.agency_onboarding x where x.agency_id = a.id and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'agreement_sent')) then
  raise exception 'This business already has an onboarding in progress. Cancel its open request first, or continue it.';
 end if;
 insert into public.agency_onboarding(agency_id, agent_id, request_id, application_request_id, stage, form_pages, sent_values, sent_by, message, admin_name)
 values (a.id, g.id, null, r.id, 'application_sent', greatest(coalesce((p_data->>'form_pages')::integer, 1), 1), coalesce(p_data->'values', '{}'::jsonb), auth.uid(),
  nullif(left(btrim(coalesce(p_data->>'message', '')), 2000), ''), left(btrim(coalesce(p_data->>'admin_name', '')), 150))
 returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_onboarding_id = o.id, updated_at = now() where id = a.id and agreement_status <> 'signed';
 perform public.agency_onboarding_log(o.id, 'application_sent', jsonb_build_object('request', r.reference, 'agent', g.id, 'email', g.email));
 perform public.admin_business_audit('agent_onboarding_sent', a.id, a.id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'agent', g.id, 'email', g.email, 'document', 'application'));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage);
end $f$;

-- Send agreement: allowed at References received; earlier only with a typed reason (the override is kept on the record and in its history).
create or replace function public.agency_onboarding_agreement_create(p_onboarding uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; v_start date; v_end date; v_pct numeric; v_reason text; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage not in ('application_signed', 'references_pending', 'references_received') then raise exception 'The agreement can be sent once the application form is signed and the referees are back'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if o.stage <> 'references_received' then
  v_reason := nullif(left(btrim(regexp_replace(coalesce(p_data->>'override_reason', ''), '[[:cntrl:]]', ' ', 'g')), 500), '');
  if v_reason is null or length(v_reason) < 5 then raise exception 'Give a reason for sending the agreement before both references are back'; end if;
 end if;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from o.agent_id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this agent'; end if;
 begin v_start := (p_data->>'commencement_date')::date; v_end := (p_data->>'expiry_date')::date; exception when others then raise exception 'Enter the commencement date'; end;
 if v_start is null or v_end is null or v_end <= v_start then raise exception 'Enter the commencement date'; end if;
 if nullif(btrim(coalesce(p_data->>'commission_percent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commission_percent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage'; end if;
 end if;
 if v_reason is not null then
  update public.agency_onboarding set override_reason = v_reason, override_by = auth.uid(), override_at = now() where id = o.id;
  perform public.agency_onboarding_log(o.id, 'override', jsonb_build_object('reason', v_reason, 'stage_before', o.stage, 'received', v_received, 'total', v_total));
 end if;
 update public.agency_onboarding set agreement_request_id = r.id, stage = 'agreement_sent', commencement_date = v_start, expiry_date = v_end, territory = left(btrim(coalesce(p_data->>'territory', '')), 200),
  commission_percent = v_pct, admin_name = left(btrim(coalesce(p_data->>'admin_name', '')), 150), admin_position = left(btrim(coalesce(p_data->>'admin_position', '')), 150),
  sent_values = coalesce(sent_values, '{}'::jsonb) || coalesce(p_data->'values', '{}'::jsonb) where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_status = 'sent', agreement_onboarding_id = o.id, updated_at = now() where id = o.agency_id and agreement_status <> 'signed';
 perform public.agency_onboarding_log(o.id, 'agreement_sent', jsonb_build_object('request', r.reference, 'commencement', v_start, 'expiry', v_end, 'territory', o.territory, 'commission', v_pct, 'override', v_reason is not null));
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'document', 'agreement', 'override', v_reason));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage, 'override', v_reason is not null);
end $f$;
revoke all on function public.agency_onboarding_agreement_create(uuid, uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_agreement_create(uuid, uuid, jsonb) to authenticated;

-- Change a referee's email address (and name): the reference goes back to pending so a new F05 is sent; the old request is voided by the
-- function. Logged with the old and new address.
create or replace function public.agency_onboarding_referee_change_email(p_referee uuid, p_email text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare f public.agency_onboarding_referees; o public.agency_onboarding; a public.agencies; g public.agents; v_email text; v_prev uuid; v_domains text[];
begin
 perform hr.require_admin();
 v_email := lower(btrim(coalesce(p_email, '')));
 if v_email !~ '^[^[:space:]@<>,]+@[^[:space:]@<>,]+\.[^[:space:]@<>,]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address for the referee'; end if;
 select * into f from public.agency_onboarding_referees where id = p_referee for update;
 if not found then raise exception 'Referee not found' using errcode = 'P0002'; end if;
 if f.status = 'received' then raise exception 'This reference is already received'; end if;
 select * into o from public.agency_onboarding where id = f.onboarding_id;
 if o.stage not in ('application_signed', 'references_pending') then raise exception 'The referees cannot be changed at this stage'; end if;
 select * into a from public.agencies where id = o.agency_id; select * into g from public.agents where id = o.agent_id;
 if v_email = any(array_remove(array[lower(btrim(coalesce(g.email, ''))), lower(btrim(coalesce(o.answers->>'contact_email', '')))], '')) then raise exception 'A referee cannot use the agent''s own email address'; end if;
 if exists (select 1 from public.agency_onboarding_referees x where x.onboarding_id = o.id and x.id <> f.id and x.email = v_email) then raise exception 'The two references need different email addresses'; end if;
 v_domains := array_remove(array[public.agency_onboarding_domain(a.business_email), public.agency_onboarding_domain(coalesce(o.answers->>'agent_website', a.profile->>'agent_website')),
  public.agency_onboarding_domain(coalesce(o.answers->>'contact_email', g.email))], null);
 v_prev := f.request_id;
 update public.agency_onboarding_referees set email = v_email, contact_name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 150), ''), contact_name), status = 'pending', request_id = null,
  domain_warning = public.agency_onboarding_domain(v_email) = any(v_domains), updated_at = now() where id = f.id;
 perform public.agency_onboarding_log(o.id, 'referee_email_changed', jsonb_build_object('position', f.position, 'from', f.email, 'to', v_email, 'name', coalesce(nullif(btrim(coalesce(p_name, '')), ''), f.contact_name), 'previous_request', v_prev));
 perform public.agency_onboarding_recompute(o.id);
 return jsonb_build_object('id', f.id, 'onboardingId', o.id, 'previousRequestId', v_prev, 'email', v_email);
end $f$;
revoke all on function public.agency_onboarding_referee_change_email(uuid, text, text) from public, anon;
grant execute on function public.agency_onboarding_referee_change_email(uuid, text, text) to authenticated;

-- A signed F05 received by email (the form tells referees to email marketing): staff upload it; it counts as received. The open request,
-- if any, is voided by the function.
create or replace function public.agency_onboarding_referee_upload(p_referee uuid, p_file_name text, p_base64 text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare f public.agency_onboarding_referees; o public.agency_onboarding; v bytea; v_prev uuid; v_stage text;
begin
 perform hr.require_admin();
 begin v := decode(coalesce(p_base64, ''), 'base64'); exception when others then raise exception 'The file could not be read'; end;
 if length(v) < 5 or length(v) > 15 * 1024 * 1024 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed referee check as a PDF (up to 15 MB)'; end if;
 select * into f from public.agency_onboarding_referees where id = p_referee for update;
 if not found then raise exception 'Referee not found' using errcode = 'P0002'; end if;
 if f.status = 'received' then raise exception 'This reference is already received'; end if;
 select * into o from public.agency_onboarding where id = f.onboarding_id;
 if o.stage not in ('application_signed', 'references_pending') then raise exception 'References cannot be added at this stage'; end if;
 v_prev := f.request_id;
 update public.agency_onboarding_referees set status = 'received', received_via = 'upload', received_at = now(), form_content = v, certificate_content = null, answers = '{}'::jsonb,
  file_name = left(coalesce(nullif(btrim(regexp_replace(coalesce(p_file_name, ''), '[[:cntrl:]]', '', 'g')), ''), 'referee-check.pdf'), 200), uploaded_by = auth.uid(), updated_at = now() where id = f.id;
 perform public.agency_onboarding_log(o.id, 'referee_uploaded', jsonb_build_object('position', f.position, 'email', f.email, 'file', p_file_name, 'previous_request', v_prev));
 v_stage := public.agency_onboarding_recompute(o.id);
 return jsonb_build_object('id', f.id, 'onboardingId', o.id, 'previousRequestId', v_prev, 'stage', v_stage);
end $f$;
revoke all on function public.agency_onboarding_referee_upload(uuid, text, text) from public, anon;
grant execute on function public.agency_onboarding_referee_upload(uuid, text, text) to authenticated;

-- A stored PDF: the application form, the agreement and their certificates for administrators and the agency's active members; a
-- referee's form or certificate ("referee:<id>", "referee_certificate:<id>") for administrators only.
create or replace function public.agency_onboarding_file(p_id uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare o public.agency_onboarding; a public.agencies; f public.agency_onboarding_referees; v bytea; v_name text; v_admin boolean; v_ref uuid; v_label text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into o from public.agency_onboarding where id = p_id;
 if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
 v_admin := public.portal_is_slit_admin();
 if not v_admin and not exists (select 1 from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
   where p.auth_user_id = auth.uid() and m.agency_id = o.agency_id and m.status = 'Active' and m.role in ('agent', 'agency_admin')) then
  raise exception 'You cannot open this document' using errcode = '42501';
 end if;
 select * into a from public.agencies where id = o.agency_id;
 v_name := left(btrim(regexp_replace(coalesce(a.name, 'agency'), '[^A-Za-z0-9 ._-]', '', 'g')), 60);
 if p_kind like 'referee:%' or p_kind like 'referee_certificate:%' then
  if not v_admin then raise exception 'You cannot open this document' using errcode = '42501'; end if;
  begin v_ref := split_part(p_kind, ':', 2)::uuid; exception when others then raise exception 'Document not found' using errcode = 'P0002'; end;
  select * into f from public.agency_onboarding_referees where id = v_ref and onboarding_id = o.id;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  v := case when p_kind like 'referee:%' then f.form_content else f.certificate_content end;
  if v is null then raise exception 'The document is not received yet' using errcode = 'P0002'; end if;
  v_label := case when p_kind like 'referee:%' then ' - Referee check ' || f.position || ' (' || coalesce(nullif(f.received_via, ''), 'received') || ').pdf' else ' - Referee check ' || f.position || ' certificate.pdf' end;
  return jsonb_build_object('name', v_name || v_label, 'base64', encode(v, 'base64'));
 end if;
 v := case p_kind when 'form' then o.form_content when 'agreement' then o.agreement_content when 'certificate' then o.certificate_content when 'application_certificate' then o.application_certificate_content end;
 if v is null then raise exception 'The document is not signed yet' using errcode = 'P0002'; end if;
 return jsonb_build_object('name', v_name || case p_kind when 'form' then ' - Agent Application Form (signed).pdf' when 'agreement' then ' - Agent Agreement (signed).pdf'
  when 'application_certificate' then ' - Application form certificate.pdf' else ' - Completion certificate.pdf' end, 'base64', encode(v, 'base64'));
end $f$;

-- The business page: every onboarding with its stage, each document's request, the referees and the history.
create or replace function public.agency_onboarding_list(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'stage', o.stage, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'signerName', o.signer_name, 'closedReason', o.closed_reason,
   'applicationSignedAt', o.application_signed_at, 'referencesReceivedAt', o.references_received_at, 'message', o.message,
   'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent, 'adminName', o.admin_name, 'adminPosition', o.admin_position,
   'override', case when o.override_reason is null then null else jsonb_build_object('reason', o.override_reason, 'at', o.override_at, 'by', (select name from public.cms_users u where u.auth_user_id = o.override_by limit 1)) end,
   'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email), 'answers', o.answers,
   'request', public.agency_onboarding_request_json(o.request_id),
   'application', public.agency_onboarding_request_json(o.application_request_id),
   'agreement', public.agency_onboarding_request_json(o.agreement_request_id),
   'referees', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position, 'name', f.contact_name, 'organisation', f.organisation, 'positionTitle', f.position_title, 'email', f.email,
     'phone', f.phone, 'status', f.status, 'domainWarning', f.domain_warning, 'receivedAt', f.received_at, 'receivedVia', f.received_via, 'fileName', f.file_name,
     'files', jsonb_build_object('form', f.form_content is not null, 'certificate', f.certificate_content is not null), 'answers', f.answers,
     'request', public.agency_onboarding_request_json(f.request_id)) order by f.position) from public.agency_onboarding_referees f where f.onboarding_id = o.id), '[]'::jsonb),
   'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', e.actor_name, 'event', e.event, 'detail', e.detail) order by e.id) from (select * from public.agency_onboarding_events x where x.onboarding_id = o.id order by x.id desc limit 80) e), '[]'::jsonb),
   'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null, 'application_certificate', o.application_certificate_content is not null)) order by o.created_at desc)
  from public.agency_onboarding o join public.agents g on g.id = o.agent_id where o.agency_id = p_agency), '[]'::jsonb);
end $f$;

-- The agency portal: the stage in plain words and the signed copies the agency may see (never a referee's answers or form).
create or replace function public.portal_agency_onboarding(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if not exists (select 1 from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
   where p.auth_user_id = auth.uid() and m.agency_id = p_agency and m.status = 'Active' and m.role in ('agent', 'agency_admin')) then
  raise exception 'You cannot see this agency' using errcode = '42501';
 end if;
 select * into a from public.agencies where id = p_agency;
 return jsonb_build_object('agreementStatus', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date,
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'stage', o.stage, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date,
    'referees', jsonb_build_object('received', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status = 'received'), 'total', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id)),
    'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null)) order by o.created_at desc)
   from public.agency_onboarding o where o.agency_id = a.id and o.status in ('sent', 'signed') and o.stage not in ('cancelled', 'expired')), '[]'::jsonb));
end $f$;
