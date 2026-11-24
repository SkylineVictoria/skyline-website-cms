-- BUSINESS-DELETE-FRESH + ADMIN-MARN (owner, 2026-11-24):
--  1. "When we delete a business, delete all business related info from our database so next time we bring fresh business data":
--     admin_business_delete (live definition, patched in place by its exact snippet) now also removes, in the same transaction:
--       public.abr_lookups (the ABN Lookup answer kept for this ABN), public.google_place_lookups (the Google Maps answer for this ABN),
--       public.omara_agent_businesses (registered agents linked to the business; the delete runs with triggers off, so the FK cascade
--       does not fire), public.omara_agents read for this business and linked to no other business with their verifications, and
--       public.omara_discovery_runs for the business / ABN. Adding the business again looks everything up afresh.
--     Kept on purpose: public.business_deletions (who deleted what, name and ABN only) and public.abr_businesses (the bulk register copy).
--  2. "Fill all info for the business": the business admin agent picked on Add business from the registered agents found keeps their
--     MARN on the business (agencies.profile.admin_marn, public.agency_admin_marn_set), so Prepare the application starts with it.
-- Rollback: drop function public.agency_admin_marn_set(uuid, text); re-run the admin_business_delete definition from
--   20261120133517_business_status_guard_and_delete.sql (the added block starts at "-- Fresh data", just before triggers are switched back on).
begin;

-- One-line marker (the live text's line breaks can differ from the repo copy): the block goes just before triggers are switched back on,
-- after the agencies delete, still inside the triggers-off part.
select public.business_rule_patch_function('public.admin_business_delete(uuid, text)'::regprocedure,
$old$set local session_replication_role = origin;$old$,
$new$-- Fresh data (2026-11-24): the cached lookups and registered agents of this business, so adding it again looks everything up anew.
 create temp table _b_marn on commit drop as select marn from public.omara_agent_businesses where agency_id = a.id;
 delete from public.omara_agent_businesses where agency_id = a.id;
 delete from public.omara_agent_verifications where marn in (select marn from _b_marn)
  and not exists (select 1 from public.omara_agent_businesses x where x.marn = omara_agent_verifications.marn);
 delete from public.omara_agents where marn in (select marn from _b_marn)
  and not exists (select 1 from public.omara_agent_businesses x where x.marn = omara_agents.marn);
 delete from public.omara_discovery_runs where agency_id = a.id or (v_abn <> '' and abn = v_abn);
 if v_abn <> '' then
  delete from public.abr_lookups where abn = v_abn;
  delete from public.google_place_lookups where abn = v_abn;
 end if;
 set local session_replication_role = origin;$new$);

-- The admin's MARN on the business (digits; registered agents have 7). Blank clears it. SLIT administrators.
create or replace function public.agency_admin_marn_set(p_agency uuid, p_marn text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v text := regexp_replace(coalesce(p_marn, ''), '\s', '', 'g');
begin
 perform public.admin_business_require();
 if v <> '' and v !~ '^\d{1,10}$' then raise exception 'The MARN is a number: digits only.' using errcode = '22023'; end if;
 update public.agencies set profile = case when v = '' then coalesce(profile, '{}'::jsonb) - 'admin_marn'
   else coalesce(profile, '{}'::jsonb) || jsonb_build_object('admin_marn', v) end, updated_at = now()
 where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.agency_admin_marn_set(uuid, text) from public, anon;
grant execute on function public.agency_admin_marn_set(uuid, text) to authenticated;

commit;
