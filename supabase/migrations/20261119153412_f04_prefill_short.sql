-- F04 prefill that cannot come up empty, and a shorter wizard (owner brief 2026-11-19).
--   * public.abr_businesses (the ABR mirror table, empty on hosted) caches the register's answer per ABN: abr_business_cache_get /
--     abr_business_cache_put (service role). A send or an open within 30 days reads the cache instead of asking the register again.
--   * agency_onboarding_wizard_get also returns the business record's values (agent_onboarding_values of the contact: website, title,
--     office address, suburb from the sign-up or the profile), the ABR answer kept on the business and the wizard's uploaded attachments.
--   * agency_onboarding_prefill_blanks: when the signing page opens an F04 still waiting for its signature, the function fills ONLY the
--     fields that are blank (text, or a Yes / No pair with no box ticked); a value already there is never overwritten.
--   * agent_onboarding_values: the sign-up's "STATE postcode" address puts the postcode in the Suburb box (office_suburb), never in
--     Province (office_province); a postcode kept in the profile's Province moves to Suburb too.
--   * agency_onboarding_attachments: the organisation chart and the business profile uploaded from the wizard by the link holder
--     (PDF / PNG / JPEG, 5 MB), listed and opened by administrators on the business page.
-- Rollback (manual): drop function public.abr_business_cache_get(text), public.abr_business_cache_put(jsonb),
--   public.agency_onboarding_prefill_blanks(uuid, jsonb), public.agency_onboarding_attachment_save(uuid, uuid, text, jsonb),
--   public.agency_onboarding_attachment_remove(uuid, uuid, text), public.agency_onboarding_attachments_list(uuid),
--   public.agency_onboarding_attachment_file(uuid, text); drop table public.agency_onboarding_attachments; re-run agent_onboarding_values
--   from 20261117120000 and agency_onboarding_wizard_get from 20261119141725.
begin;

-- ------------------------------------------------------------------ the register's answer, cached by ABN
create function public.abr_business_cache_get(p_abn text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select jsonb_build_object('abn', b.abn, 'acn', coalesce(b.acn, ''), 'abnStatus', b.abn_status, 'active', b.abn_status ~* '^(active|act)$',
  'statusFrom', coalesce(b.abn_status_from::text, ''), 'entityName', coalesce(b.main_name, ''), 'entityType', coalesce(b.entity_type, ''),
  'businessNames', to_jsonb(coalesce(b.other_names, '{}'::text[])), 'gstRegistered', coalesce(b.gst_status, '') ~* '^(registered|act)',
  'gstFrom', coalesce(b.gst_status_from::text, ''), 'state', coalesce(b.state, ''), 'postcode', coalesce(b.postcode, ''),
  'sourceUrl', 'https://abr.business.gov.au/ABN/View?abn=' || b.abn, 'fetchedAt', b.synced_at)
 from public.abr_businesses b
 where b.abn = regexp_replace(coalesce(p_abn, ''), '\D', '', 'g') and b.synced_at > now() - interval '30 days' and coalesce(b.main_name, '') <> '';
$f$;
revoke all on function public.abr_business_cache_get(text) from public, anon, authenticated;
grant execute on function public.abr_business_cache_get(text) to service_role;

create function public.abr_business_cache_put(p_details jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare d jsonb := case when jsonb_typeof(p_details) = 'object' then p_details else '{}'::jsonb end; v_abn text; v_names text[];
begin
 v_abn := regexp_replace(coalesce(d->>'abn', ''), '\D', '', 'g');
 if v_abn !~ '^\d{11}$' or btrim(coalesce(d->>'entityName', '')) = '' then return; end if;
 select coalesce(array_agg(n) filter (where n <> ''), '{}'::text[]) into v_names
  from (select left(btrim(regexp_replace(x, '[[:cntrl:]]', ' ', 'g')), 200) as n
        from jsonb_array_elements_text(case when jsonb_typeof(d->'businessNames') = 'array' then d->'businessNames' else '[]'::jsonb end) x limit 20) s;
 insert into public.abr_businesses(abn, abn_status, abn_status_from, record_last_updated, entity_type, main_name, other_names, acn, gst_status, gst_status_from, state, postcode, synced_at)
 values (v_abn, left(coalesce(nullif(btrim(regexp_replace(coalesce(d->>'abnStatus', ''), '[[:cntrl:]]', ' ', 'g')), ''), 'Unknown'), 40),
  case when coalesce(d->>'statusFrom', '') ~ '^\d{4}-\d{2}-\d{2}$' then (d->>'statusFrom')::date end, current_date,
  nullif(left(btrim(regexp_replace(coalesce(d->>'entityType', ''), '[[:cntrl:]]', ' ', 'g')), 120), ''),
  left(btrim(regexp_replace(d->>'entityName', '[[:cntrl:]]', ' ', 'g')), 200), v_names,
  nullif(regexp_replace(coalesce(d->>'acn', ''), '\D', '', 'g'), ''),
  case when (d->>'gstRegistered') = 'true' then 'Registered' else 'Not registered' end,
  case when coalesce(d->>'gstFrom', '') ~ '^\d{4}-\d{2}-\d{2}$' then (d->>'gstFrom')::date end,
  nullif(left(upper(regexp_replace(coalesce(d->>'state', ''), '[^A-Za-z]', '', 'g')), 3), ''),
  nullif(left(regexp_replace(coalesce(d->>'postcode', ''), '\D', '', 'g'), 4), ''), now())
 on conflict (abn) do update set abn_status = excluded.abn_status, abn_status_from = excluded.abn_status_from, record_last_updated = excluded.record_last_updated,
  entity_type = excluded.entity_type, main_name = excluded.main_name, other_names = excluded.other_names, acn = excluded.acn, gst_status = excluded.gst_status,
  gst_status_from = excluded.gst_status_from, state = excluded.state, postcode = excluded.postcode, synced_at = excluded.synced_at;
end $f$;
revoke all on function public.abr_business_cache_put(jsonb) from public, anon, authenticated;
grant execute on function public.abr_business_cache_put(jsonb) to service_role;

-- ------------------------------------------------------------------ the business record's values: the postcode is the Suburb box's
create or replace function public.agent_onboarding_values(p_agent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare g public.agents; a public.agencies; p jsonb; pp public.portal_profiles; v jsonb; v_given text; v_family text; v_parts text[]; v_state text; v_post text; v_position text; v_prov text;
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
 -- A postcode kept as the Province (forms signed before 2026-11-19) belongs to the Suburb box.
 v_prov := btrim(coalesce(p->>'office_province', ''));
 if v_prov ~ '^\d{4}$' then v_post := coalesce(v_post, v_prov); p := p - 'office_province'; v_prov := ''; end if;
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
  'office_province', nullif(v_prov, ''),
  'office_suburb', nullif(coalesce(nullif(btrim(coalesce(p->>'office_suburb', '')), ''), v_post), ''),
  'office_country', nullif(coalesce(nullif(btrim(coalesce(p->>'office_country', '')), ''), nullif(btrim(coalesce(a.country, '')), '')), ''),
  'agent_signatory_name', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_name', '')), ''), nullif(btrim(coalesce(g.full_name, '')), '')), ''),
  'agent_signatory_position', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_position', '')), ''), v_position), '')));
 v := v || jsonb_build_object('declarant_name', coalesce(nullif(btrim(concat_ws(' ', v->>'contact_given_name', v->>'contact_family_name')), ''), ''), 'declarant_role', coalesce(v->>'contact_position', ''));
 return (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(p) e where jsonb_typeof(e.value) = 'string' and e.key ~ '^[a-z][a-z0-9_]{0,60}$' and length(e.value #>> '{}') <= 500)
  || jsonb_strip_nulls(v);
end $f$;
revoke all on function public.agent_onboarding_values(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ the wizard's uploads (organisation chart, business profile)
create table public.agency_onboarding_attachments(
 request_id uuid not null references hr.sign_requests(id) on delete cascade,
 kind text not null check (kind in ('org_chart', 'business_profile')),
 file_name text not null check (length(file_name) between 1 and 160),
 content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
 size_bytes integer not null check (size_bytes between 1 and 5242880),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 content bytea not null,
 uploaded_at timestamptz not null default now(),
 primary key (request_id, kind));
alter table public.agency_onboarding_attachments enable row level security;
revoke all on public.agency_onboarding_attachments from public, anon, authenticated;
comment on table public.agency_onboarding_attachments is 'Organisation chart / business profile uploaded with the Agent Application Form (F04 wizard); administrators open them on the business page.';

-- The function, for a link holder whose token it checked: only while the form waits for this signer.
create function public.agency_onboarding_attachment_save(p_request uuid, p_recipient uuid, p_kind text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; c hr.sign_recipients; v_bytes bytea; v_name text; v_type text;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null or o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 select * into c from hr.sign_recipients where id = p_recipient and request_id = p_request;
 if not found or c.state in ('signed', 'declined', 'skipped') then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 if p_kind not in ('org_chart', 'business_profile') then raise exception 'Choose what the file is' using errcode = '22023'; end if;
 v_type := coalesce(p_data->>'contentType', '');
 if v_type not in ('application/pdf', 'image/png', 'image/jpeg') then raise exception 'Upload a PDF, PNG or JPEG file.' using errcode = '22023'; end if;
 v_bytes := decode(coalesce(p_data->>'base64', ''), 'base64');
 if length(v_bytes) = 0 or length(v_bytes) > 5242880 then raise exception 'The file must be smaller than 5 MB.' using errcode = '22023'; end if;
 v_name := left(btrim(regexp_replace(coalesce(p_data->>'name', ''), '[[:cntrl:]/\\]', ' ', 'g')), 160);
 if v_name = '' then v_name := p_kind; end if;
 insert into public.agency_onboarding_attachments(request_id, kind, file_name, content_type, size_bytes, sha256, content, uploaded_at)
 values (p_request, p_kind, v_name, v_type, length(v_bytes), encode(extensions.digest(v_bytes, 'sha256'), 'hex'), v_bytes, now())
 on conflict (request_id, kind) do update set file_name = excluded.file_name, content_type = excluded.content_type, size_bytes = excluded.size_bytes,
  sha256 = excluded.sha256, content = excluded.content, uploaded_at = excluded.uploaded_at;
 return jsonb_build_object('kind', p_kind, 'name', v_name, 'size', length(v_bytes), 'at', now());
end $f$;
revoke all on function public.agency_onboarding_attachment_save(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_attachment_save(uuid, uuid, text, jsonb) to service_role;

create function public.agency_onboarding_attachment_remove(p_request uuid, p_recipient uuid, p_kind text) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; c hr.sign_recipients;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null or o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 select * into c from hr.sign_recipients where id = p_recipient and request_id = p_request;
 if not found or c.state in ('signed', 'declined', 'skipped') then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 delete from public.agency_onboarding_attachments where request_id = p_request and kind = p_kind;
end $f$;
revoke all on function public.agency_onboarding_attachment_remove(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_attachment_remove(uuid, uuid, text) to service_role;

-- Administrators: the files of an onboarding's application form.
create function public.agency_onboarding_attachments_list(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
begin
 if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'You cannot open these files' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'name', x.file_name, 'contentType', x.content_type, 'size', x.size_bytes, 'at', x.uploaded_at) order by x.kind)
  from public.agency_onboarding o join public.agency_onboarding_attachments x on x.request_id = o.application_request_id where o.id = p_onboarding), '[]'::jsonb);
end $f$;
revoke all on function public.agency_onboarding_attachments_list(uuid) from public, anon;
grant execute on function public.agency_onboarding_attachments_list(uuid) to authenticated;

create function public.agency_onboarding_attachment_file(p_onboarding uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare x public.agency_onboarding_attachments;
begin
 if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'You cannot open this file' using errcode = '42501'; end if;
 select a.* into x from public.agency_onboarding o join public.agency_onboarding_attachments a on a.request_id = o.application_request_id where o.id = p_onboarding and a.kind = p_kind;
 if not found then raise exception 'File not found' using errcode = 'P0002'; end if;
 return jsonb_build_object('name', x.file_name, 'contentType', x.content_type, 'base64', encode(x.content, 'base64'));
end $f$;
revoke all on function public.agency_onboarding_attachment_file(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_attachment_file(uuid, text) to authenticated;

-- ------------------------------------------------------------------ the wizard's opening data
create or replace function public.agency_onboarding_wizard_get(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; d public.agency_onboarding_drafts;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null then return null; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into d from public.agency_onboarding_drafts where request_id = p_request;
 return jsonb_build_object('draft', d.draft, 'saved_at', d.saved_at, 'facts', a.profile->'abr_facts',
  'abn', nullif(regexp_replace(coalesce(a.registration_number, ''), '\D', '', 'g'), ''),
  'record', case when o.agent_id is null then '{}'::jsonb else public.agent_onboarding_values(o.agent_id) end,
  'abr', case when a.abr_details is null and a.abr_confirmed is null then null else jsonb_build_object('details', a.abr_details, 'confirmed', a.abr_confirmed, 'fetchedAt', a.abr_fetched_at) end,
  'attachments', coalesce((select jsonb_object_agg(x.kind, jsonb_build_object('name', x.file_name, 'size', x.size_bytes, 'at', x.uploaded_at))
   from public.agency_onboarding_attachments x where x.request_id = p_request), '{}'::jsonb));
end $f$;
revoke all on function public.agency_onboarding_wizard_get(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_wizard_get(uuid) to service_role;

-- ------------------------------------------------------------------ fill the blanks on open (never overwrite)
create function public.agency_onboarding_prefill_blanks(p_request uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; e record; v_n integer; v_filled jsonb := '{}'::jsonb;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null or o.stage <> 'application_sent' or jsonb_typeof(p_values) is distinct from 'object' then return '{}'::jsonb; end if;
 if not exists (select 1 from hr.sign_requests r where r.id = p_request and r.state in ('sent', 'viewed', 'email_failed')) then return '{}'::jsonb; end if;
 for e in select j.key, j.value #>> '{}' as val from jsonb_each(p_values) j
   where jsonb_typeof(j.value) = 'string' and j.key ~ '^[a-z][a-z0-9_]{0,60}$' and length(btrim(j.value #>> '{}')) between 1 and 500 and (j.value #>> '{}') !~ '[[:cntrl:]]' loop
  update hr.sign_fields f set value = btrim(e.val)
   where f.request_id = p_request and f.type = 'text' and f.key is not null and position(':' in f.key) = 0
     and regexp_replace(f.key, '_(form|referee)$', '') = e.key and coalesce(btrim(f.value), '') = '';
  get diagnostics v_n = row_count;
  -- A Yes / No pair with no box ticked: the box of the answer.
  if v_n = 0 and upper(btrim(e.val)) in ('YES', 'NO')
     and exists (select 1 from hr.sign_fields f where f.request_id = p_request and f.type = 'checkbox' and split_part(f.key, ':', 1) = e.key)
     and not exists (select 1 from hr.sign_fields f where f.request_id = p_request and f.type = 'checkbox' and split_part(f.key, ':', 1) = e.key and f.value = 'true') then
   update hr.sign_fields f set value = 'true' where f.request_id = p_request and f.type = 'checkbox' and f.key = e.key || ':' || upper(btrim(e.val));
   get diagnostics v_n = row_count;
  end if;
  if v_n > 0 then v_filled := v_filled || jsonb_build_object(e.key, btrim(e.val)); end if;
 end loop;
 if v_filled <> '{}'::jsonb then
  perform public.agency_onboarding_log(o.id, 'application_prefilled_on_open', jsonb_build_object('keys', (select jsonb_agg(k order by k) from jsonb_object_keys(v_filled) k)));
 end if;
 return v_filled;
end $f$;
revoke all on function public.agency_onboarding_prefill_blanks(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_prefill_blanks(uuid, jsonb) to service_role;

commit;
