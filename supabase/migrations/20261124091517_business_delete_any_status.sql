-- BUSINESS-DELETE-ANY-STATUS (owner, 2026-11-24: "Allow to delete business it's active or not just allow it"): a SLIT administrator
-- can delete a business whatever its status (Active, Inactive, Onboarding at any stage). Still refused, because the records or the
-- accounts live on elsewhere: system businesses, a business with students or applications (their records are kept), an uploaded
-- signed agreement copy, an agent's Microsoft 365 mailbox. admin_business_delete is unchanged (it asks admin_business_delete_block).
-- Additive. Rollback: re-create both functions from 20261124010517.
begin;

create or replace function public.admin_business_delete_block(p_business uuid)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public', 'hr'
as $function$
declare a public.agencies;
begin
 select * into a from public.agencies where id = p_business;
 if not found then return 'Business not found.'; end if;
 if upper(coalesce(a.code, '')) in ('SLIT-DIRECT', 'TEST-VIEW') or coalesce(a.is_permanent, false) or coalesce(a.is_direct, false) then
  return 'This is a system business: it cannot be deleted.'; end if;
 if exists (select 1 from public.enrollment_students s where s.agency_id = a.id or s.agent_id in (select g.id from public.agents g where g.business_id = a.id))
  or exists (select 1 from public.enrollment_applications p where p.agency_id = a.id
              or p.assigned_agent_id in (select g.id from public.agents g where g.business_id = a.id)
              or p.assigned_agent_id in (select g.profile_id from public.agents g where g.business_id = a.id and g.profile_id is not null)) then
  return 'This business has students or applications: their records are kept, so it cannot be deleted.'; end if;
 if exists (select 1 from public.business_documents d where d.business_id = a.id) then
  return 'A signed agreement copy was uploaded for this business: remove the uploaded copy first.'; end if;
 if exists (select 1 from public.agent_office365_accounts x join public.agents g on g.id = x.agent_id where g.business_id = a.id) then
  return 'An agent of this business has a Microsoft 365 mailbox: remove it in Create Email first.'; end if;
 -- BUSINESS-DELETE-ANY-STATUS: Active, Inactive or Onboarding at any stage.
 return null;
end $function$;

-- The guard's message for anyone trying to delete a business directly.
create or replace function public.agencies_status_guard()
 returns trigger
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
begin
 if tg_op = 'DELETE' then
  -- Only public.admin_business_delete (security definer, runs as the owner) deletes a business; the API roles cannot.
  if current_user in ('authenticated', 'anon') then
   raise exception 'Delete a business with Delete business.' using errcode = '42501';
  end if;
  return old;
 end if;
 if new.status = 'Onboarding' and old.status is distinct from 'Onboarding' and (old.status = 'Active' or old.onboarding_completed_at is not null) then
  raise exception 'An active business has already been onboarded: it can be Active or Inactive, never Onboarding again.' using errcode = '23514';
 end if;
 return new;
end $function$;

commit;
