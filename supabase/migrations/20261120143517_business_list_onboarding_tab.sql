-- Businesses list tabs (owner 2026-11-20): the Onboarding tab failed ("Invalid status": admin_business_list accepted only Active /
-- Inactive) and had no count. Now every business is in exactly one tab, so the tabs add up to All:
--   Active (the page splits off Invited) + Onboarding (Not sent yet, Application sent, Awaiting referees ... Ready to activate)
--   + Inactive + Pending review (registered itself, not reviewed yet: counted only there).
-- admin_business_list accepts Onboarding, returns counts.onboarding and counts.pending, and Active / Onboarding / Inactive leave out the
-- businesses waiting for review. Patched in place (single-line anchors).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

select pg_temp.patch('public.admin_business_list(text, text, integer, integer)',
 $a$ if coalesce(p_status, '') not in ('', 'Active', 'Inactive') then raise exception 'Invalid status' using errcode = '22023'; end if;$a$,
 $a$ if coalesce(p_status, '') not in ('', 'Active', 'Inactive', 'Onboarding') then raise exception 'Invalid status' using errcode = '22023'; end if;$a$);
select pg_temp.patch('public.admin_business_list(text, text, integer, integer)',
 $a$  select a.id, a.name, a.code, a.status, a.registration_number, a.business_email, a.primary_contact, a.phone, a.address, a.country, a.created_at$a$,
 $a$  select a.id, a.name, a.code, a.status, a.registration_number, a.business_email, a.primary_contact, a.phone, a.address, a.country, a.created_at,
   (a.registration_requested_at is not null and a.registration_reviewed_at is null) as pending_review$a$);
select pg_temp.patch('public.admin_business_list(text, text, integer, integer)',
 $a$  select * from searched where coalesce(p_status, '') = '' or status = p_status$a$,
 $a$  select * from searched where coalesce(p_status, '') = '' or (status = p_status and not pending_review)$a$);
select pg_temp.patch('public.admin_business_list(text, text, integer, integer)',
 $a$  'counts', jsonb_build_object('all', (select count(*) from searched), 'active', (select count(*) from searched where status = 'Active'),$a$,
 $a$  'counts', jsonb_build_object('all', (select count(*) from searched), 'active', (select count(*) from searched where status = 'Active' and not pending_review),
   'onboarding', (select count(*) from searched where status = 'Onboarding' and not pending_review), 'pending', (select count(*) from searched where pending_review),$a$);
select pg_temp.patch('public.admin_business_list(text, text, integer, integer)',
 $a$   'inactive', (select count(*) from searched where status = 'Inactive')),$a$,
 $a$   'inactive', (select count(*) from searched where status = 'Inactive' and not pending_review)),$a$);
