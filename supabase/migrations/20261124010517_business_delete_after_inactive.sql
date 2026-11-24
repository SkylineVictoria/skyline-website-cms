-- BUSINESS-DELETE-INACTIVE (owner, 2026-11-24: "allow me to delete after deactivating it"): a SLIT administrator can delete a
-- business once it is Inactive, whatever its onboarding stage, as well as a business whose application is still at Application sent.
-- Still refused: system businesses, a business with students or applications (their records are kept: it stays Inactive), a business
-- with an uploaded signed agreement copy, and a business whose agent has a Microsoft 365 mailbox (both live outside the database).
-- An Active business must be made Inactive first. admin_business_delete itself is unchanged: it already removes every row of the
-- business (agents, sign-in accounts used only by them, onboarding, signing requests and their files) in one transaction.
begin;

create or replace function public.admin_business_delete_block(p_business uuid)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public', 'hr'
as $function$
declare a public.agencies; o public.agency_onboarding; r hr.sign_requests;
begin
 select * into a from public.agencies where id = p_business;
 if not found then return 'Business not found.'; end if;
 if upper(coalesce(a.code, '')) in ('SLIT-DIRECT', 'TEST-VIEW') or coalesce(a.is_permanent, false) or coalesce(a.is_direct, false) then
  return 'This is a system business: it cannot be deleted.'; end if;
 if exists (select 1 from public.enrollment_students s where s.agency_id = a.id or s.agent_id in (select g.id from public.agents g where g.business_id = a.id))
  or exists (select 1 from public.enrollment_applications p where p.agency_id = a.id
              or p.assigned_agent_id in (select g.id from public.agents g where g.business_id = a.id)
              or p.assigned_agent_id in (select g.profile_id from public.agents g where g.business_id = a.id and g.profile_id is not null)) then
  return 'This business has students or applications: their records are kept, so it stays Inactive.'; end if;
 if exists (select 1 from public.business_documents d where d.business_id = a.id) then
  return 'A signed agreement copy was uploaded for this business: remove the uploaded copy first.'; end if;
 if exists (select 1 from public.agent_office365_accounts x join public.agents g on g.id = x.agent_id where g.business_id = a.id) then
  return 'An agent of this business has a Microsoft 365 mailbox: remove it in Create Email first.'; end if;
 if a.status = 'Inactive' then return null; end if;
 if a.status = 'Active' then return 'Make this business Inactive first, then delete it.'; end if;
 -- Onboarding: deletable straight away only while the application is unsigned at Application sent.
 select * into o from public.agency_onboarding where agency_id = a.id and kind = 'business' and stage not in ('cancelled', 'expired', 'declined', 'legacy')
  order by created_at desc limit 1;
 if o.id is null or o.stage <> 'application_sent' then return 'Make this business Inactive first, then delete it.'; end if;
 select * into r from hr.sign_requests where id = o.application_request_id;
 if r.id is null or r.state not in ('sent', 'viewed') or r.signed_at is not null then
  return 'The application has been signed: make this business Inactive first, then delete it.'; end if;
 if exists (select 1 from public.agency_onboarding x where x.agency_id = a.id and x.stage in ('application_signed', 'references_pending', 'references_received', 'references_approved',
   'agreement_sent', 'agreement_signed', 'correction_requested', 'resubmitted')) then
  return 'The application has been signed: make this business Inactive first, then delete it.'; end if;
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
   raise exception 'Delete a business with Delete business (once it is Inactive, or while its application is at Application sent).' using errcode = '42501';
  end if;
  return old;
 end if;
 if new.status = 'Onboarding' and old.status is distinct from 'Onboarding' and (old.status = 'Active' or old.onboarding_completed_at is not null) then
  raise exception 'An active business has already been onboarded: it can be Active or Inactive, never Onboarding again.' using errcode = '23514';
 end if;
 return new;
end $function$;

commit;
