-- ABN prefill (owner brief 2026-11-19). Additive.
--   * Add business looks the ABN up on the ABR JSON service (document-signing agent_onboarding_abn_lookup, secret EF_ABR_GUID). Each answer is
--     cached by ABN in public.abr_lookups (service table, admins write through abr_lookup_save).
--   * When the business is saved, agency_abr_attach copies the cached answer onto the business (agencies.abr_raw / abr_details /
--     abr_fetched_at) with the values staff confirmed or edited (agencies.abr_confirmed: legal entity, trading name, GST, state, postcode,
--     the contact's given / family name, a reason when a cancelled ABN is added anyway). agency_abr_get gives them to the F04 prefill, so the
--     register is not called again when the form is resent or started again.
--   * The F04 prefill is recorded on the onboarding (agency_onboarding.prefill, history 'application_prefilled'); when the contact signs, a
--     trigger compares it with the signed answers and logs 'prefill_reviewed' (which prefilled values were kept, which were changed).
--   * Without EF_ABR_GUID nothing here is used: no lookup is cached, no business has abr_confirmed, the F04 is made as before.
-- Rollback (manual): drop trigger agency_onboarding_prefill_review on public.agency_onboarding; drop function public.agency_onboarding_prefill_review(),
--   public.agency_onboarding_prefill_record(uuid, jsonb), public.agency_abr_get(uuid), public.agency_abr_attach(uuid, jsonb),
--   public.abr_lookup_save(text, jsonb, jsonb); drop table public.abr_lookups; alter table public.agency_onboarding drop column prefill;
--   alter table public.agencies drop column abr_raw, drop column abr_details, drop column abr_fetched_at, drop column abr_confirmed.
begin;

create table public.abr_lookups(
  abn text primary key check (abn ~ '^\d{11}$'),
  raw jsonb not null,
  details jsonb not null,
  fetched_at timestamptz not null default now(),
  fetched_by uuid
);
alter table public.abr_lookups enable row level security;
revoke all on public.abr_lookups from public, anon, authenticated;
grant select on public.abr_lookups to service_role;
comment on table public.abr_lookups is 'ABR ABN Lookup answers by ABN (raw JSON and the parsed details), written by Add business lookups; read when the business is saved.';

alter table public.agencies add column abr_raw jsonb, add column abr_details jsonb, add column abr_fetched_at timestamptz, add column abr_confirmed jsonb;
comment on column public.agencies.abr_raw is 'The ABR ABN Lookup answer for this business when it was added (raw JSON).';
comment on column public.agencies.abr_details is 'The same answer, parsed (legal name, business names, GST, state, postcode, status).';
comment on column public.agencies.abr_fetched_at is 'When the ABR answer kept on this business was fetched.';
comment on column public.agencies.abr_confirmed is 'What staff confirmed on Add business (the register''s values, possibly edited); the F04 prefill reads it.';
alter table public.agency_onboarding add column prefill jsonb;
comment on column public.agency_onboarding.prefill is 'The F04 values prefilled from ABN Lookup and Add business (editable by the contact); compared with the signed answers.';

-- One ABR answer, cached by ABN. Administrators only (the Add business lookup runs as the staff member).
create function public.abr_lookup_save(p_abn text, p_raw jsonb, p_details jsonb) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_abn text := regexp_replace(coalesce(p_abn, ''), '\D', '', 'g'); v_at timestamptz;
begin
 perform public.admin_business_require();
 if v_abn !~ '^\d{11}$' then raise exception 'Enter the business''s 11-digit ABN.' using errcode = '22023'; end if;
 if jsonb_typeof(p_raw) is distinct from 'object' or jsonb_typeof(p_details) is distinct from 'object' or length(p_raw::text) > 20000 or length(p_details::text) > 20000 then
  raise exception 'The ABN Lookup answer could not be kept.' using errcode = '22023'; end if;
 if regexp_replace(coalesce(p_details->>'abn', ''), '\D', '', 'g') <> v_abn then raise exception 'The ABN Lookup answer is for another ABN.' using errcode = '22023'; end if;
 insert into public.abr_lookups(abn, raw, details, fetched_at, fetched_by) values (v_abn, p_raw, p_details, now(), auth.uid())
 on conflict (abn) do update set raw = excluded.raw, details = excluded.details, fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by
 returning fetched_at into v_at;
 return v_at;
end $f$;
revoke all on function public.abr_lookup_save(text, jsonb, jsonb) from public, anon;
grant execute on function public.abr_lookup_save(text, jsonb, jsonb) to authenticated;

-- The business just saved keeps the ABR answer looked up for its ABN (within a day) and the values staff confirmed.
create function public.agency_abr_attach(p_agency uuid, p_confirmed jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare a public.agencies; l public.abr_lookups; c jsonb := coalesce(p_confirmed, '{}'::jsonb); v jsonb; v_override text; v_gst jsonb;
 t text;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 select * into l from public.abr_lookups where abn = regexp_replace(coalesce(a.registration_number, ''), '\D', '', 'g') and fetched_at > now() - interval '1 day';
 if not found then raise exception 'Look the ABN up again before saving the business.' using errcode = '22023'; end if;
 if jsonb_typeof(c) <> 'object' then raise exception 'The confirmed ABN details could not be read.' using errcode = '22023'; end if;
 v_override := left(btrim(coalesce(c->>'cancelledOverride', '')), 500);
 if coalesce((l.details->>'active')::boolean, false) is false and v_override = '' then
  raise exception 'This ABN is % on the government register. Give a reason to add the business anyway.', coalesce(nullif(l.details->>'abnStatus', ''), 'not active') using errcode = '22023';
 end if;
 v_gst := case when jsonb_typeof(c->'gstRegistered') = 'boolean' then c->'gstRegistered' else 'null'::jsonb end;
 v := jsonb_build_object(
  'legalEntity', left(regexp_replace(btrim(coalesce(c->>'legalEntity', '')), '\s+', ' ', 'g'), 200),
  'tradingName', left(regexp_replace(btrim(coalesce(c->>'tradingName', '')), '\s+', ' ', 'g'), 200),
  'gstRegistered', v_gst,
  'state', case when upper(btrim(coalesce(c->>'state', ''))) ~ '^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$' then upper(btrim(c->>'state')) else '' end,
  'postcode', case when btrim(coalesce(c->>'postcode', '')) ~ '^\d{4}$' then btrim(c->>'postcode') else '' end,
  'givenName', left(regexp_replace(btrim(coalesce(c->>'givenName', '')), '\s+', ' ', 'g'), 100),
  'familyName', left(regexp_replace(btrim(coalesce(c->>'familyName', '')), '\s+', ' ', 'g'), 100),
  'cancelledOverride', v_override);
 foreach t in array array['legalEntity', 'tradingName', 'givenName', 'familyName', 'cancelledOverride'] loop
  if (v->>t) ~ '[[:cntrl:]]' then raise exception 'The confirmed ABN details contain characters that cannot be printed.' using errcode = '22023'; end if;
 end loop;
 update public.agencies set abr_raw = l.raw, abr_details = l.details, abr_fetched_at = l.fetched_at, abr_confirmed = v, updated_at = now() where id = a.id;
 perform public.admin_business_audit('abr_confirmed', a.id, a.id, jsonb_build_object('abn', l.abn, 'fetchedAt', l.fetched_at, 'status', l.details->>'abnStatus',
  'tradingName', v->>'tradingName', 'cancelledOverride', nullif(v_override, '')));
 return jsonb_build_object('agencyId', a.id, 'fetchedAt', l.fetched_at, 'confirmed', v);
end $f$;
revoke all on function public.agency_abr_attach(uuid, jsonb) from public, anon;
grant execute on function public.agency_abr_attach(uuid, jsonb) to authenticated;

-- What the F04 prefill reads (no call to the register): null when the business was not added with an ABN Lookup confirmation.
create function public.agency_abr_get(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare a public.agencies;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency;
 if not found or a.abr_confirmed is null then return null; end if;
 return jsonb_build_object('details', a.abr_details, 'confirmed', a.abr_confirmed, 'fetchedAt', a.abr_fetched_at);
end $f$;
revoke all on function public.agency_abr_get(uuid) from public, anon;
grant execute on function public.agency_abr_get(uuid) to authenticated;

-- The F04 values prefilled for the contact, kept once on the onboarding and written to its history.
create function public.agency_onboarding_prefill_record(p_onboarding uuid, p_prefill jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v jsonb;
begin
 perform hr.require_admin();
 if jsonb_typeof(p_prefill) is distinct from 'object' then raise exception 'The prefilled values could not be read.' using errcode = '22023'; end if;
 select coalesce(jsonb_object_agg(e.key, left(e.value #>> '{}', 500)), '{}'::jsonb) into v from jsonb_each(p_prefill) e
  where e.key ~ '^[a-z][a-z0-9_]{0,60}$' and jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '';
 update public.agency_onboarding set prefill = v where id = p_onboarding and prefill is null;
 if found then
  perform public.agency_onboarding_log(p_onboarding, 'application_prefilled', jsonb_build_object('source', 'abn_lookup',
   'fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(v) k)));
 end if;
end $f$;
revoke all on function public.agency_onboarding_prefill_record(uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_prefill_record(uuid, jsonb) to authenticated;

-- When the signed F04's answers arrive: which prefilled values the contact kept and which they changed (spaces ignored: "51 824 753 556"
-- is the ABN as printed). Once per onboarding.
create function public.agency_onboarding_prefill_review() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_changed jsonb; v_kept jsonb;
begin
 if new.prefill is null or new.prefill = '{}'::jsonb or coalesce(old.answers, '{}'::jsonb) <> '{}'::jsonb or coalesce(new.answers, '{}'::jsonb) = '{}'::jsonb then return new; end if;
 select coalesce(jsonb_agg(jsonb_build_object('field', p.key, 'prefilled', p.value #>> '{}', 'submitted', coalesce(new.answers->>p.key, '')) order by p.key)
   filter (where regexp_replace(p.value #>> '{}', '\s+', '', 'g') is distinct from regexp_replace(coalesce(new.answers->>p.key, ''), '\s+', '', 'g')), '[]'::jsonb),
  coalesce(jsonb_agg(p.key order by p.key) filter (where regexp_replace(p.value #>> '{}', '\s+', '', 'g') = regexp_replace(coalesce(new.answers->>p.key, ''), '\s+', '', 'g')), '[]'::jsonb)
  into v_changed, v_kept from jsonb_each(new.prefill) p;
 perform public.agency_onboarding_log(new.id, 'prefill_reviewed', jsonb_build_object('prefilled', (select count(*) from jsonb_object_keys(new.prefill)),
  'kept', v_kept, 'changed', v_changed));
 return new;
end $f$;
revoke all on function public.agency_onboarding_prefill_review() from public, anon, authenticated;
create trigger agency_onboarding_prefill_review after update of answers on public.agency_onboarding
 for each row execute function public.agency_onboarding_prefill_review();

commit;
