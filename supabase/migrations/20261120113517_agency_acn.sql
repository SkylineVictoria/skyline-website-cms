-- The business's ACN (owner 2026-11-20: F04 / P06 showed no ACN, e.g. BHP GROUP LIMITED, ABN 49 004 028 077, ACN 004 028 077).
--
--   * public.agencies.acn (9 digits) and acn_source: 'register' (the ASIC number ABN Lookup gives), 'derived' (a company's ABN is two check
--     digits then its ACN: the last nine digits, only for a company and only when they pass ASIC's ACN check digit), 'manual' (typed by
--     the business on the application form when we had none).
--   * One rule (public.acn_resolve, the same as acnFromAbn / resolveAcn in _shared/validation/abr.ts): the register's ACN first; else, for an
--     Australian Private / Public Company (any entity type naming a company, never a trust, partnership, sole trader or individual), the
--     derived one; else none: sole traders, partnerships, trusts and other non-company types stay blank (editable on the form), never derived.
--   * Filled from the register's answer cached by ABN (public.abr_businesses), the details kept on the business (abr_details, abr_confirmed,
--     profile.abr_facts): when the business is saved or its ABN changes (trigger), and whenever a lookup for its ABN is cached (trigger on
--     abr_businesses). Existing businesses are backfilled by the same rule at the end. (The OMARA directory is gone: no ASIC data there.)
-- Additive: two columns, five functions, two triggers.
set local lock_timeout = '5s';

alter table public.agencies add column if not exists acn text;
alter table public.agencies add column if not exists acn_source text;
do $c$
begin
 if not exists (select 1 from pg_constraint where conname = 'agencies_acn_format') then
  alter table public.agencies add constraint agencies_acn_format check (acn is null or acn ~ '^[0-9]{9}$');
 end if;
 if not exists (select 1 from pg_constraint where conname = 'agencies_acn_source_check') then
  alter table public.agencies add constraint agencies_acn_source_check check ((acn is null and acn_source is null) or (acn is not null and acn_source in ('register', 'derived', 'manual')));
 end if;
end $c$;
comment on column public.agencies.acn is 'The business''s ACN (9 digits): from ABN Lookup (register), derived from a company''s ABN (derived), or typed by the business (manual); blank for non-companies.';

-- ASIC's ACN check digit: weights 8..1 on the first eight digits; the ninth is (10 - sum mod 10) mod 10.
create or replace function public.acn_valid(p_acn text) returns boolean language sql immutable as $f$
 select coalesce(p_acn ~ '^[0-9]{9}$' and (10 - (
   (substr(p_acn, 1, 1)::int * 8 + substr(p_acn, 2, 1)::int * 7 + substr(p_acn, 3, 1)::int * 6 + substr(p_acn, 4, 1)::int * 5
  + substr(p_acn, 5, 1)::int * 4 + substr(p_acn, 6, 1)::int * 3 + substr(p_acn, 7, 1)::int * 2 + substr(p_acn, 8, 1)::int * 1) % 10)) % 10 = substr(p_acn, 9, 1)::int, false)
$f$;

-- A company in the register's words: "Australian Private Company", "Australian Public Company" (and other "... Company" types), never a
-- trust, partnership, sole trader or individual.
create or replace function public.acn_company_entity(p_entity_type text) returns boolean language sql immutable as $f$
 select coalesce(p_entity_type ~* 'company' and p_entity_type !~* '(trust|partnership|sole\s*trader|individual)', false)
$f$;

-- The ACN for an ABN: {acn, source} or {} when there is none to give.
create or replace function public.acn_resolve(p_abn text, p_register_acn text, p_entity_type text) returns jsonb language plpgsql immutable as $f$
declare v_reg text := regexp_replace(coalesce(p_register_acn, ''), '\D', '', 'g'); v_abn text := regexp_replace(coalesce(p_abn, ''), '\D', '', 'g');
begin
 if public.acn_valid(v_reg) then return jsonb_build_object('acn', v_reg, 'source', 'register'); end if;
 if length(v_abn) = 11 and public.acn_company_entity(p_entity_type) and public.acn_valid(substr(v_abn, 3)) then
  return jsonb_build_object('acn', substr(v_abn, 3), 'source', 'derived');
 end if;
 return '{}'::jsonb;
end $f$;

-- What we hold about an ABN's register entry: the cache first, then the details kept on the business.
create or replace function public.agency_acn_candidate(p_abn text, p_abr_details jsonb, p_abr_confirmed jsonb, p_profile jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare v_abn text := regexp_replace(coalesce(p_abn, ''), '\D', '', 'g'); b public.abr_businesses; v jsonb;
begin
 if length(v_abn) <> 11 then return '{}'::jsonb; end if;
 select * into b from public.abr_businesses where abn = v_abn;
 if found then v := public.acn_resolve(v_abn, b.acn, b.entity_type); if v ? 'acn' then return v; end if; end if;
 v := public.acn_resolve(v_abn, p_abr_details->>'acn', coalesce(p_abr_details->>'entityType', p_abr_confirmed->>'entityType'));
 if v ? 'acn' then return v; end if;
 return public.acn_resolve(v_abn, p_profile->'abr_facts'->>'acn', p_profile->'abr_facts'->>'entityType');
end $f$;

-- Saving a business, or changing its ABN: its ACN by the rule (an ACN typed by the business stays while the ABN is the same).
create or replace function public.agencies_acn_fill() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v jsonb;
begin
 if tg_op = 'UPDATE' and regexp_replace(coalesce(new.registration_number, ''), '\D', '', 'g') is distinct from regexp_replace(coalesce(old.registration_number, ''), '\D', '', 'g') then
  new.acn := null; new.acn_source := null;
 end if;
 if new.acn is null then
  v := public.agency_acn_candidate(new.registration_number, new.abr_details, new.abr_confirmed, new.profile);
  if v ? 'acn' then new.acn := v->>'acn'; new.acn_source := v->>'source'; end if;
 end if;
 return new;
end $f$;
drop trigger if exists agencies_acn_fill on public.agencies;
create trigger agencies_acn_fill before insert or update of registration_number, abr_details, abr_confirmed, profile, acn on public.agencies
 for each row execute function public.agencies_acn_fill();

-- A lookup of an ABN cached (Add business, Prepare application, the form opened): businesses with that ABN and no ACN get it.
create or replace function public.abr_businesses_acn_to_agencies() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v jsonb := public.acn_resolve(new.abn, new.acn, new.entity_type);
begin
 if v ? 'acn' then
  update public.agencies set acn = v->>'acn', acn_source = v->>'source'
  where acn is null and regexp_replace(coalesce(registration_number, ''), '\D', '', 'g') = new.abn;
 end if;
 return null;
end $f$;
drop trigger if exists abr_businesses_acn_to_agencies on public.abr_businesses;
create trigger abr_businesses_acn_to_agencies after insert or update of acn, entity_type on public.abr_businesses
 for each row execute function public.abr_businesses_acn_to_agencies();

-- document-signing: the business's ACN for the F04 / P06 (filled by the rule first when it has none). Staff only.
create or replace function public.agency_acn_sync(p_agency uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $f$
declare a public.agencies;
begin
 perform public.admin_business_require();
 update public.agencies set acn = acn where id = p_agency and acn is null returning * into a; -- the trigger fills it when the rule gives one
 if a.id is null then select * into a from public.agencies where id = p_agency; end if;
 if a.id is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
 return jsonb_build_object('acn', a.acn, 'source', a.acn_source);
end $f$;

-- The ACN the business typed on its signed application form, kept when we had none (a non-company that has an ACN after all, or a
-- register that did not answer). Service only (document-signing after the signature).
create or replace function public.agency_acn_from_application(p_request uuid, p_acn text) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v_acn text := regexp_replace(coalesce(p_acn, ''), '\D', '', 'g'); v_agency uuid; a public.agencies;
begin
 if not public.acn_valid(v_acn) then return jsonb_build_object('kept', false); end if;
 select o.agency_id into v_agency from public.agency_onboarding o where o.application_request_id = p_request or o.request_id = p_request limit 1;
 if v_agency is null then return jsonb_build_object('kept', false); end if;
 update public.agencies set acn = v_acn, acn_source = 'manual' where id = v_agency and acn is null returning * into a;
 return jsonb_build_object('kept', a.id is not null);
end $f$;

revoke all on function public.acn_valid(text), public.acn_company_entity(text), public.acn_resolve(text, text, text) from public, anon;
grant execute on function public.acn_valid(text), public.acn_company_entity(text), public.acn_resolve(text, text, text) to authenticated, service_role;
revoke all on function public.agency_acn_candidate(text, jsonb, jsonb, jsonb), public.agencies_acn_fill(), public.abr_businesses_acn_to_agencies() from public, anon, authenticated;
revoke all on function public.agency_acn_sync(uuid) from public, anon;
grant execute on function public.agency_acn_sync(uuid) to authenticated;
revoke all on function public.agency_acn_from_application(uuid, text) from public, anon, authenticated;
grant execute on function public.agency_acn_from_application(uuid, text) to service_role;

-- Backfill: every business with an ABN and no ACN, by the same rule (the trigger fills it on this no-op update).
update public.agencies set acn = acn where acn is null and length(regexp_replace(coalesce(registration_number, ''), '\D', '', 'g')) = 11;
