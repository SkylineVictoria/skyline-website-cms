-- Agent onboarding documents (owner brief 2026-11-17): the Agent Application Form (F04) and the Agent Agreement (P06) are sent to a
-- business's agent admin as ONE signing request of the Sign module (the same mechanism as the student offer letter: PDF template,
-- values printed from our records, emailed /sign link, placed fields, signed PDF and certificate). Additive:
--   * hr.sign_fields.key (the variable key behind a placed field) and a prefilled value; hr.sign_templates.system_key (the two blanks
--     are found by key, however staff rename them); hr.sign_template_fields lets the sender print a tick box, a signature and a date;
--   * public.agency_onboarding: one row per send (dates, territory, commission, the signatory, the signed PDFs split back into the two
--     documents, the certificate, the agent's answers); agencies.profile keeps the answers for the next send and the CMS; the agreement
--     status and dates on the agency; cms_users.signature_png: an administrator's saved signature;
--   * public.signing_service: a completed onboarding request stores both signed PDFs (anchored in-place patches of the hosted body);
--     hr.signing_admin_core keeps key and value of a request's fields; hr.sign_subject('agent') adds the form's variables.
-- Authorization is unchanged: CMS Admin through signing_admin / the Edge Function; agency members read their own agreement through
-- security-definer RPCs; no table is readable from a browser.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ keys on fields and templates
alter table hr.sign_fields add column if not exists key text check (key is null or key ~ '^[a-z][a-z0-9_]{0,60}(:[A-Z0-9]{1,10})?$');
alter table hr.sign_templates add column if not exists system_key text check (system_key is null or system_key ~ '^[a-z][a-z0-9_]{0,60}$');
create unique index if not exists sign_templates_system_key_idx on hr.sign_templates(system_key) where system_key is not null and deleted_at is null;

-- The sender may print a tick box (GST registered), a signature picture (the SLIT signatory) and a date on a PDF template; every field
-- may carry its variable key. Otherwise as 20261113140000.
create or replace function hr.sign_template_fields(p_fields jsonb, p_roles jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb; out jsonb := '[]'::jsonb; v_key text;
begin
 if p_fields is null or jsonb_typeof(p_fields) <> 'array' then return '[]'::jsonb; end if;
 if jsonb_array_length(p_fields) > 200 then raise exception 'Use no more than 200 fields'; end if;
 for v in select * from jsonb_array_elements(p_fields) loop
  if coalesce(v->>'type', '') not in ('signature','initials','date','name','text','checkbox') then raise exception 'Unknown field type'; end if;
  if coalesce(v->>'role', '') <> 'sender' and not exists (select 1 from jsonb_array_elements(p_roles) x where x->>'key' = v->>'role') then raise exception 'Every field must belong to a signer'; end if;
  if v->>'role' = 'sender' and v->>'type' not in ('text','checkbox','signature','date') then raise exception 'The sender can print text, a tick box, a signature or a date'; end if;
  if (v->>'page')::integer not between 1 and 200 or (v->>'x')::numeric < 0 or (v->>'y')::numeric < 0 or (v->>'w')::numeric <= 0 or (v->>'h')::numeric <= 0
   or (v->>'x')::numeric + (v->>'w')::numeric > 1.0001 or (v->>'y')::numeric + (v->>'h')::numeric > 1.0001 then raise exception 'A field is outside its page'; end if;
  v_key := nullif(btrim(coalesce(v->>'key', '')), '');
  if v_key is not null and v_key !~ '^[a-z][a-z0-9_]{0,60}(:[A-Z0-9]{1,10})?$' then raise exception 'A field key is lowercase letters, numbers and underscores'; end if;
  out := out || (jsonb_build_object('type', v->>'type', 'role', v->>'role', 'page', (v->>'page')::integer, 'x', (v->>'x')::numeric, 'y', (v->>'y')::numeric,
   'w', (v->>'w')::numeric, 'h', (v->>'h')::numeric, 'required', coalesce((v->>'required')::boolean, true), 'label', left(coalesce(v->>'label', ''), 120), 'value', left(coalesce(v->>'value', ''), 500))
   || case when v_key is null then '{}'::jsonb else jsonb_build_object('key', v_key) end);
 end loop;
 return out;
end $f$;

-- ------------------------------------------------------------------ the agency's agreement
alter table public.agencies
 add column if not exists profile jsonb not null default '{}'::jsonb,
 add column if not exists agreement_status text not null default 'none',
 add column if not exists agreement_commencement_date date,
 add column if not exists agreement_expiry_date date,
 add column if not exists agreement_onboarding_id uuid;
alter table public.agencies drop constraint if exists agencies_agreement_status_check;
alter table public.agencies add constraint agencies_agreement_status_check check (agreement_status in ('none','sent','signed'));
alter table public.cms_users
 add column if not exists signature_png text,
 add column if not exists signature_updated_at timestamptz;
alter table public.cms_users drop constraint if exists cms_users_signature_png_check;
alter table public.cms_users add constraint cms_users_signature_png_check check (signature_png is null or (length(signature_png) between 100 and 400000 and signature_png ~ '^[A-Za-z0-9+/]+=*$'));

create table if not exists public.agency_onboarding (
 id uuid primary key default gen_random_uuid(),
 agency_id uuid not null references public.agencies(id) on delete cascade,
 agent_id uuid not null references public.agents(id),
 request_id uuid not null unique references hr.sign_requests(id) on delete cascade,
 status text not null default 'sent' check (status in ('sent','signed','closed')),
 commencement_date date not null,
 expiry_date date not null,
 territory text not null default '' check (length(territory) <= 200),
 commission_percent numeric(6,2) check (commission_percent is null or (commission_percent >= 0 and commission_percent <= 100)),
 admin_name text not null default '' check (length(admin_name) <= 150),
 admin_position text not null default '' check (length(admin_position) <= 150),
 form_pages integer not null check (form_pages between 1 and 50),
 sent_values jsonb not null default '{}'::jsonb,
 answers jsonb not null default '{}'::jsonb,
 form_content bytea,
 agreement_content bytea,
 certificate_content bytea,
 signed_at timestamptz,
 signer_name text,
 closed_reason text,
 sent_by uuid,
 created_at timestamptz not null default now()
);
create index if not exists agency_onboarding_agency_idx on public.agency_onboarding(agency_id, created_at desc);
alter table public.agency_onboarding enable row level security;
revoke all on table public.agency_onboarding from public, anon, authenticated;
alter table public.agencies drop constraint if exists agencies_agreement_onboarding_fk;
alter table public.agencies add constraint agencies_agreement_onboarding_fk foreign key (agreement_onboarding_id) references public.agency_onboarding(id) on delete set null;
alter table hr.sign_requests add column if not exists agency_onboarding_id uuid references public.agency_onboarding(id) on delete set null;
create index if not exists sign_requests_agency_onboarding_idx on hr.sign_requests(agency_onboarding_id) where agency_onboarding_id is not null;

-- ------------------------------------------------------------------ the form's variables from our records
-- The values the two documents print for an agent (the agency record, the ABN as the sign-up kept it, the agent admin's name, email,
-- phone and position) under the form's own keys, plus the answers the agent gave last time (agencies.profile). Record values win over
-- the profile for what the record holds; the profile fills the rest. Internal (hr.sign_subject, agency_onboarding_prepare).
create or replace function public.agent_onboarding_values(p_agent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare g public.agents; a public.agencies; p jsonb; pp public.portal_profiles; v jsonb; v_given text; v_family text; v_parts text[]; v_state text; v_post text; v_position text;
begin
 select * into g from public.agents where id = p_agent;
 if not found then return '{}'::jsonb; end if;
 select * into a from public.agencies where id = g.business_id;
 p := coalesce(a.profile, '{}'::jsonb);
 if g.profile_id is not null then select * into pp from public.portal_profiles where id = g.profile_id; end if;
 v_parts := regexp_split_to_array(btrim(coalesce(g.full_name, '')), '\s+');
 if coalesce(array_length(v_parts, 1), 0) >= 2 then v_given := array_to_string(v_parts[1:array_length(v_parts, 1) - 1], ' '); v_family := v_parts[array_length(v_parts, 1)];
 else v_given := coalesce(v_parts[1], ''); v_family := ''; end if;
 -- The sign-up keeps "STATE postcode" as the address.
 v_state := nullif(substring(coalesce(a.address, '') from '^([A-Z]{2,3})\s+\d{4}$'), '');
 v_post := nullif(substring(coalesce(a.address, '') from '^[A-Z]{2,3}\s+(\d{4})$'), '');
 v_position := coalesce(nullif(btrim(coalesce(pp.job_title, '')), ''), nullif(btrim(coalesce(p->>'contact_position', '')), ''), '');
 v := jsonb_strip_nulls(jsonb_build_object(
  'agent_organisation_name', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_legal_entity', '')), ''), a.name), ''),
  'agent_abn', nullif(btrim(coalesce(a.registration_number, '')), ''),
  'agent_agency_name', nullif(btrim(coalesce(a.name, '')), ''),
  'contact_given_name', nullif(coalesce(nullif(btrim(coalesce(p->>'contact_given_name', '')), ''), v_given), ''),
  'contact_family_name', nullif(coalesce(nullif(btrim(coalesce(p->>'contact_family_name', '')), ''), v_family), ''),
  'contact_position', nullif(v_position, ''),
  'contact_email', nullif(lower(btrim(coalesce(g.email, ''))), ''),
  'contact_phone', nullif(coalesce(nullif(btrim(coalesce(g.phone, '')), ''), nullif(btrim(coalesce(a.phone, '')), '')), ''),
  'office_state', nullif(coalesce(nullif(btrim(coalesce(p->>'office_state', '')), ''), v_state), ''),
  'office_province', nullif(coalesce(nullif(btrim(coalesce(p->>'office_province', '')), ''), v_post), ''),
  'office_country', nullif(coalesce(nullif(btrim(coalesce(p->>'office_country', '')), ''), nullif(btrim(coalesce(a.country, '')), '')), ''),
  'agent_signatory_name', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_name', '')), ''), nullif(btrim(coalesce(g.full_name, '')), '')), ''),
  'agent_signatory_position', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_position', '')), ''), v_position), '')));
 v := v || jsonb_build_object('declarant_name', coalesce(nullif(btrim(concat_ws(' ', v->>'contact_given_name', v->>'contact_family_name')), ''), ''), 'declarant_role', coalesce(v->>'contact_position', ''));
 return (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(p) e where jsonb_typeof(e.value) = 'string' and e.key ~ '^[a-z][a-z0-9_]{0,60}$' and length(e.value #>> '{}') <= 500)
  || jsonb_strip_nulls(v);
end $f$;
revoke all on function public.agent_onboarding_values(uuid) from public, anon, authenticated;

-- hr.sign_subject('agent', id): the form's variables join agent.* / agency.* so any agent template can print them. In-place patch of the
-- hosted body (verified identical to 20261113210000 on 2026-11-17).
do $$
declare d text; o text; n text; k integer;
begin
 d := pg_get_functiondef('hr.sign_subject(text, uuid)'::regprocedure);
 o := $a$'agency.phone', coalesce(b->>'phone', '')));$a$;
 n := $a$'agency.phone', coalesce(b->>'phone', '')) || public.agent_onboarding_values((j->>'id')::uuid));$a$;
 k := (length(d) - length(replace(d, o, ''))) / length(o);
 if k <> 1 then raise exception 'hr.sign_subject: anchor found % times', k; end if;
 execute replace(d, o, n);
end $$;

-- hr.signing_admin_core('create'): a request's fields keep their variable key and a prefilled text (the agent sees it on the page and may
-- change it). In-place patch of the hosted body (LF line endings on hosted).
do $$
declare d text; o text; n text; k integer;
begin
 d := pg_get_functiondef('hr.signing_admin_core(text, uuid, jsonb)'::regprocedure);
 o := E'   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)\n    select k.request_id, k.id, v->>\'type\', (v->>\'page\')::integer, (v->>\'x\')::numeric, (v->>\'y\')::numeric,\n     (v->>\'w\')::numeric, (v->>\'h\')::numeric, coalesce((v->>\'required\')::boolean, true), left(coalesce(v->>\'label\', \'\'), 120)\n';
 n := E'   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label, key, value)\n    select k.request_id, k.id, v->>\'type\', (v->>\'page\')::integer, (v->>\'x\')::numeric, (v->>\'y\')::numeric,\n     (v->>\'w\')::numeric, (v->>\'h\')::numeric, coalesce((v->>\'required\')::boolean, true), left(coalesce(v->>\'label\', \'\'), 120),\n     nullif(left(coalesce(v->>\'key\', \'\'), 80), \'\'), case when v->>\'type\' = \'text\' then nullif(left(coalesce(v->>\'value\', \'\'), 500), \'\') end\n';
 k := (length(d) - length(replace(d, o, ''))) / length(o);
 -- A replay from a CRLF file (the lab) keeps CRLF in the body: the same anchor with those line endings.
 if k = 0 then o := replace(o, E'\n', E'\r\n'); n := replace(n, E'\n', E'\r\n'); k := (length(d) - length(replace(d, o, ''))) / length(o); end if;
 if k <> 1 then raise exception 'hr.signing_admin_core: anchor found % times', k; end if;
 execute replace(d, o, n);
end $$;

-- ------------------------------------------------------------------ the request plan and completion
-- What the signing page and the function learn about an onboarding request: nothing of the agency beyond its name and the page split.
create or replace function public.agency_onboarding_plan(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case when p_id is null then null else (select jsonb_build_object('id', o.id, 'formPages', o.form_pages, 'agencyName', a.name, 'agencyId', a.id)
  from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.id = p_id) end;
$f$;
revoke all on function public.agency_onboarding_plan(uuid) from public, anon, authenticated;

-- A required tick box that answers a question together with other boxes ("litigation_involved:YES" / ":NO") is satisfied when one box
-- of the question is ticked.
create or replace function hr.sign_group_ticked(p_request uuid, p_recipient uuid, p_key text, p_values jsonb) returns boolean
language sql stable set search_path = pg_catalog, hr as $f$
 select position(':' in coalesce(p_key, '')) > 0 and exists (select 1 from hr.sign_fields q where q.request_id = p_request and q.recipient_id = p_recipient and q.type = 'checkbox'
  and q.key like replace(split_part(p_key, ':', 1), '_', '\_') || ':%' and coalesce(p_values->>q.id::text, 'false') = 'true');
$f$;
revoke all on function hr.sign_group_ticked(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Completion: the signed document (both PDFs, split by the function from the one signed file whose hash the request records), the
-- certificate and the agent's answers go on the onboarding row; the agency gets the answers (profile), the status and the dates.
create or replace function public.agency_onboarding_accept_signed(p_onboarding uuid, p_request uuid, p_recipient uuid, p_signed bytea, p_certificate bytea, p_data jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; c hr.sign_recipients; v_form bytea; v_agreement bytea; f record; v_answers jsonb := '{}'::jsonb; v_group text; v_ticks jsonb := '{}'::jsonb; v_key text;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found'; end if;
 select * into r from hr.sign_requests where id = p_request;
 select * into c from hr.sign_recipients where id = p_recipient;
 if r.id is null or o.request_id <> r.id or c.request_id is distinct from r.id then raise exception 'The signing request does not belong to this onboarding'; end if;
 begin v_form := decode(coalesce(p_data->>'form_base64', ''), 'base64'); v_agreement := decode(coalesce(p_data->>'agreement_base64', ''), 'base64');
 exception when others then raise exception 'The signed documents could not be stored. Please select Sign again'; end;
 if length(v_form) < 5 or length(v_agreement) < 5 or substring(v_form from 1 for 4) <> '\x25504446'::bytea or substring(v_agreement from 1 for 4) <> '\x25504446'::bytea
  or length(coalesce(p_signed, ''::bytea)) < 5 or length(coalesce(p_certificate, ''::bytea)) < 5 then
  raise exception 'The signed documents could not be stored. Please select Sign again';
 end if;
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
   v_key := regexp_replace(f.key, '_form$', '');
   v_answers := v_answers || jsonb_build_object(v_key, btrim(f.value));
  end if;
 end loop;
 foreach v_key in array array['litigation_involved', 'eatc_completed'] loop
  if not (v_answers ? v_key) and exists (select 1 from hr.sign_fields q where q.request_id = r.id and q.key like v_key || ':%') then
   raise exception 'Answer Yes or No: %', replace(v_key, '_', ' ');
  end if;
 end loop;
 update public.agency_onboarding set status = 'signed', signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name, form_content = v_form, agreement_content = v_agreement,
  certificate_content = p_certificate, answers = v_answers where id = o.id returning * into o;
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date' - 'admin_signed_date'),
  agreement_status = 'signed', agreement_commencement_date = o.commencement_date, agreement_expiry_date = o.expiry_date, agreement_onboarding_id = o.id, updated_at = now()
  where id = o.agency_id;
 perform public.admin_business_audit('agent_agreement_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'signer', c.signer_name));
end $f$;
revoke all on function public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb) from public, anon, authenticated;

-- A request that is declined, voided or expired closes its onboarding; the agency goes back to "not sent" unless an earlier one is signed.
create or replace function public.agency_onboarding_close() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if new.agency_onboarding_id is not null and new.state in ('declined', 'void', 'expired') and new.state is distinct from old.state then
  update public.agency_onboarding set status = 'closed', closed_reason = new.state where id = new.agency_onboarding_id and status <> 'signed';
  update public.agencies a set agreement_status = 'none', agreement_onboarding_id = null where a.agreement_onboarding_id = new.agency_onboarding_id and a.agreement_status = 'sent';
 end if;
 return new;
end $f$;
drop trigger if exists agency_onboarding_close on hr.sign_requests;
create trigger agency_onboarding_close after update of state on hr.sign_requests for each row execute function public.agency_onboarding_close();

-- public.signing_service: in-place patches of the hosted body (CRLF line endings on hosted; each anchor occurs once, checked):
--   a. sign_plan carries the onboarding plan (the function splits the signed PDF by its form page count);
--   b. the signed bytes are decoded for an onboarding request as for an offer letter;
--   c. completion stores the documents through agency_onboarding_accept_signed;
--   d. the page learns each field's key (tick-box questions, prefilled values);
--   e. the page learns that the request is an onboarding (its heading and intro);
--   f. a required tick box of a question is satisfied by any ticked box of that question.
do $$
declare d text; o text; n text; k integer; i integer;
 olds text[] := array[
  $a$'offer', r.offer_letter_id is not null,$a$,
  $a$if r.offer_letter_id is not null and v_complete then$a$,
  E'perform public.offer_letter_accept_signed(r.offer_letter_id, r.id, c.signer_name, v_signed, r.signed_hash, v_certificate, r.certificate_hash, v_choice, c.ip);\r\n   end if;',
  $a$'required', q.required, 'label', q.label, 'value', q.value)$a$,
  $a$'require_code', r.require_code,$a$,
  $a$(f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') <> 'true')$a$];
 news text[] := array[
  $a$'offer', r.offer_letter_id is not null, 'onboarding', public.agency_onboarding_plan(r.agency_onboarding_id),$a$,
  $a$if (r.offer_letter_id is not null or r.agency_onboarding_id is not null) and v_complete then$a$,
  E'perform public.offer_letter_accept_signed(r.offer_letter_id, r.id, c.signer_name, v_signed, r.signed_hash, v_certificate, r.certificate_hash, v_choice, c.ip);\r\n   end if;\r\n   if r.agency_onboarding_id is not null then\r\n    perform public.agency_onboarding_accept_signed(r.agency_onboarding_id, r.id, c.id, v_signed, v_certificate, p_data);\r\n   end if;',
  $a$'required', q.required, 'label', q.label, 'value', q.value, 'key', q.key)$a$,
  $a$'require_code', r.require_code, 'onboarding', public.agency_onboarding_plan(r.agency_onboarding_id),$a$,
  $a$(f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') <> 'true' and not hr.sign_group_ticked(r.id, c.id, f.key, v_values))$a$];
begin
 d := pg_get_functiondef('public.signing_service(text, text, uuid, jsonb)'::regprocedure);
 for i in 1..array_length(olds, 1) loop
  o := olds[i]; n := news[i];
  k := (length(d) - length(replace(d, o, ''))) / length(o);
  -- A body with LF line endings (a replay from an LF file): the same anchor without the carriage returns.
  if k = 0 then o := replace(o, E'\r\n', E'\n'); n := replace(n, E'\r\n', E'\n'); k := (length(d) - length(replace(d, o, ''))) / length(o); end if;
  if k <> 1 then raise exception 'public.signing_service: anchor % found % times', i, k; end if;
  d := replace(d, o, n);
 end loop;
 execute d;
end $$;

-- ------------------------------------------------------------------ administrator RPCs (the Edge Function and the CMS)
-- The two blanks as installed templates (by system key), for the function that merges them into one request.
create or replace function public.agency_onboarding_templates() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, hr, public as $f$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'systemKey', t.system_key, 'name', t.name, 'title', t.title, 'status', t.status, 'sourcePath', t.source_path,
   'sourceHash', t.source_hash, 'sourcePages', t.source_pages, 'fields', t.fields, 'expiryDays', t.expiry_days, 'reminderDays', t.reminder_days, 'version', t.version) order by t.system_key)
  from hr.sign_templates t where t.system_key in ('agent_application_form', 'agent_agreement') and t.deleted_at is null), '[]'::jsonb);
end $f$;
revoke all on function public.agency_onboarding_templates() from public, anon;
grant execute on function public.agency_onboarding_templates() to authenticated;

-- Marks an installed template as one of the two blanks; an earlier template with the same key loses it (it stays as a normal template).
create or replace function public.agency_onboarding_template_register(p_template uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public as $f$
declare t hr.sign_templates;
begin
 perform hr.require_admin();
 if coalesce(p_key, '') not in ('agent_application_form', 'agent_agreement') then raise exception 'Unknown onboarding template'; end if;
 select * into t from hr.sign_templates where id = p_template and deleted_at is null and kind = 'pdf';
 if not found then raise exception 'Template not found'; end if;
 update hr.sign_templates set system_key = null where system_key = p_key and id <> p_template;
 update hr.sign_templates set system_key = p_key, audience = 'agent' where id = p_template;
 return jsonb_build_object('id', t.id, 'systemKey', p_key);
end $f$;
revoke all on function public.agency_onboarding_template_register(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_template_register(uuid, text) to authenticated;

-- The send dialog: the business, its agents (the business admin agent first), the sending administrator (name, position from the HR
-- record when there is one, saved signature) and the values the documents print for the chosen agent.
create or replace function public.agency_onboarding_prepare(p_agency uuid, p_agent uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; g public.agents; u public.cms_users; v_position text;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if p_agent is not null then select * into g from public.agents where id = p_agent and business_id = a.id;
 else select * into g from public.agents x where x.business_id = a.id and x.status = 'Active' order by (x.role = 'agency_admin') desc, x.created_at limit 1; end if;
 select * into u from public.cms_users where auth_user_id = auth.uid() and status = 'Active' limit 1;
 select e.job_title into v_position from hr.staff_profiles sp join hr.employment e on e.profile_id = sp.id where sp.auth_user_id = auth.uid() order by e.created_at desc limit 1;
 return jsonb_build_object(
  'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', a.registration_number, 'email', a.business_email, 'phone', a.phone, 'address', a.address, 'country', a.country,
   'status', a.status, 'agreementStatus', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date, 'profile', coalesce(a.profile, '{}'::jsonb)),
  'agents', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.full_name, 'email', x.email, 'role', x.role, 'status', x.status) order by (x.role = 'agency_admin') desc, x.full_name)
   from public.agents x where x.business_id = a.id and x.status = 'Active'), '[]'::jsonb),
  'agent', case when g.id is null then null else jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role) end,
  'admin', jsonb_build_object('name', coalesce(u.name, ''), 'position', coalesce(v_position, ''), 'signaturePng', u.signature_png),
  'values', case when g.id is null then '{}'::jsonb else public.agent_onboarding_values(g.id) end);
end $f$;
revoke all on function public.agency_onboarding_prepare(uuid, uuid) from public, anon;
grant execute on function public.agency_onboarding_prepare(uuid, uuid) to authenticated;

-- Records a send: the draft request the function just made (subject: this business's agent) becomes the onboarding of the agency.
create or replace function public.agency_onboarding_create(p_agency uuid, p_agent uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; g public.agents; r hr.sign_requests; o public.agency_onboarding; v_start date; v_end date; v_pct numeric;
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
 begin v_start := (p_data->>'commencement_date')::date; v_end := (p_data->>'expiry_date')::date; exception when others then raise exception 'Enter the commencement date'; end;
 if v_start is null or v_end is null or v_end <= v_start then raise exception 'Enter the commencement date'; end if;
 if nullif(btrim(coalesce(p_data->>'commission_percent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commission_percent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage'; end if;
 end if;
 insert into public.agency_onboarding(agency_id, agent_id, request_id, commencement_date, expiry_date, territory, commission_percent, admin_name, admin_position, form_pages, sent_values, sent_by)
 values (a.id, g.id, r.id, v_start, v_end, left(btrim(coalesce(p_data->>'territory', '')), 200), v_pct, left(btrim(coalesce(p_data->>'admin_name', '')), 150), left(btrim(coalesce(p_data->>'admin_position', '')), 150),
  greatest(coalesce((p_data->>'form_pages')::integer, 1), 1), coalesce(p_data->'values', '{}'::jsonb), auth.uid())
 returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_status = 'sent', agreement_onboarding_id = o.id, updated_at = now() where id = a.id and agreement_status <> 'signed';
 perform public.admin_business_audit('agent_onboarding_sent', a.id, a.id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'agent', g.id, 'email', g.email));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference);
end $f$;
revoke all on function public.agency_onboarding_create(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_create(uuid, uuid, uuid, jsonb) to authenticated;

-- The business page: every send with where it is up to, and what can be downloaded.
create or replace function public.agency_onboarding_list(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'signerName', o.signer_name, 'closedReason', o.closed_reason,
   'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent, 'adminName', o.admin_name, 'adminPosition', o.admin_position,
   'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email), 'answers', o.answers,
   'request', jsonb_build_object('id', r.id, 'reference', r.reference, 'state', r.state, 'expiresAt', r.expires_at, 'sentAt', r.sent_at, 'viewedAt', r.viewed_at,
    'recipientId', c.id, 'recipientState', c.state, 'lastNotifiedAt', c.last_notified_at, 'reminderCount', c.reminder_count),
   'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null)) order by o.created_at desc)
  from public.agency_onboarding o join public.agents g on g.id = o.agent_id join hr.sign_requests r on r.id = o.request_id
  left join lateral (select * from hr.sign_recipients k where k.request_id = r.id order by k.signing_order limit 1) c on true
  where o.agency_id = p_agency), '[]'::jsonb);
end $f$;
revoke all on function public.agency_onboarding_list(uuid) from public, anon;
grant execute on function public.agency_onboarding_list(uuid) to authenticated;

-- A signed PDF (the application form, the agreement) or the certificate: SLIT administrators, and the active members of that agency.
create or replace function public.agency_onboarding_file(p_id uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare o public.agency_onboarding; a public.agencies; v bytea; v_name text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into o from public.agency_onboarding where id = p_id;
 if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
 -- agency_memberships.user_id is the portal profile; the signed-in person is its auth user.
 if not public.portal_is_slit_admin() and not exists (select 1 from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
   where p.auth_user_id = auth.uid() and m.agency_id = o.agency_id and m.status = 'Active' and m.role in ('agent', 'agency_admin')) then
  raise exception 'You cannot open this document' using errcode = '42501';
 end if;
 select * into a from public.agencies where id = o.agency_id;
 v := case p_kind when 'form' then o.form_content when 'agreement' then o.agreement_content when 'certificate' then o.certificate_content end;
 if v is null then raise exception 'The document is not signed yet' using errcode = 'P0002'; end if;
 v_name := regexp_replace(coalesce(a.name, 'agency'), '[^A-Za-z0-9 ._-]', '', 'g');
 return jsonb_build_object('name', left(btrim(v_name), 60) || case p_kind when 'form' then ' - Agent Application Form (signed).pdf' when 'agreement' then ' - Agent Agreement (signed).pdf' else ' - Completion certificate.pdf' end,
  'base64', encode(v, 'base64'));
end $f$;
revoke all on function public.agency_onboarding_file(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_file(uuid, text) to authenticated;

-- The agency portal: the agency's agreement (status, dates, which signed copies exist). Members of the agency only.
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
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date,
    'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null)) order by o.created_at desc)
   from public.agency_onboarding o where o.agency_id = a.id and o.status in ('sent', 'signed')), '[]'::jsonb));
end $f$;
revoke all on function public.portal_agency_onboarding(uuid) from public, anon;
grant execute on function public.portal_agency_onboarding(uuid) to authenticated;

-- An administrator's saved signature (PNG, as the signing page draws it), used on the agreement; null clears it.
create or replace function public.cms_user_signature_save(p_png text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v text := nullif(regexp_replace(coalesce(p_png, ''), '^data:image/png;base64,', ''), '');
begin
 perform hr.require_admin();
 if v is not null and (v !~ '^[A-Za-z0-9+/]+=*$' or length(v) not between 100 and 400000 or v not like 'iVBORw0KGgo%') then raise exception 'Draw or upload a PNG signature first'; end if;
 update public.cms_users set signature_png = v, signature_updated_at = case when v is null then null else now() end where auth_user_id = auth.uid();
 if not found then raise exception 'CMS user not found'; end if;
 return jsonb_build_object('saved', v is not null);
end $f$;
revoke all on function public.cms_user_signature_save(text) from public, anon;
grant execute on function public.cms_user_signature_save(text) to authenticated;

-- The business page knows the agreement's status, dates and the agent profile (the answers). Otherwise as 20261113025808 (verified
-- identical on hosted 2026-11-17).
create or replace function public.admin_business_detail(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare a public.agencies; poc public.agents;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_business;
 if not found then return null; end if;
 select * into poc from public.agents g where g.business_id = a.id and g.role = 'agency_admin' order by g.created_at limit 1;
 return jsonb_build_object(
  'id', a.id, 'name', a.name, 'status', a.status, 'createdAt', a.created_at,
  'agency', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'status', a.status, 'email', a.business_email, 'phone', a.phone,
   'address', a.address, 'country', a.country, 'contact', a.primary_contact, 'registrationNumber', a.registration_number, 'createdAt', a.created_at),
  'onboarding', jsonb_build_object('completedAt', a.onboarding_completed_at, 'agreementReady', public.business_agreement_ready(a.id),
   'contact', case when poc.id is null then null else jsonb_build_object('agentId', poc.id, 'name', poc.full_name, 'email', poc.email, 'hasLogin', poc.profile_id is not null) end),
  'agreement', jsonb_build_object('status', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date, 'onboardingId', a.agreement_onboarding_id),
  'profile', coalesce(a.profile, '{}'::jsonb),
  'counts', jsonb_build_object(
   'admins', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agency_admin' and g.status = 'Active'),
   'agents', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agent' and g.status = 'Active'),
   'inactiveAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status <> 'Active'),
   'students', (select count(*) from public.enrollment_students s where s.agency_id = a.id),
   'applications', (select count(*) from public.enrollment_applications e where e.agency_id = a.id)),
  'statusCounts', public.admin_status_counts(a.id));
end $f$;
