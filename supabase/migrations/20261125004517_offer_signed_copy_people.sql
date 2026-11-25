-- OFFER-SIGNATURES (2026-11-24, owner: "Admin and hardik all"): the signed offer letter is also emailed to the admin who sent
-- the offer and to the signatory (Business Rule hrms.offer_signatory_name, matched by name to an active CMS user), as well as
-- the HR addresses (EF_HR_ADMIN_NOTIFY_TO). Additive; service role only (read by the HR mail drain, _shared/hr-mail-drain.ts).
begin;
create or replace function public.hr_svc_offer_mail_people(p_offer uuid)
 returns text[] language sql stable security definer set search_path to 'public', 'hr', 'pg_temp'
as $function$
 select coalesce(array_agg(distinct lower(btrim(x.email))) filter (where x.email ~ '^[^@\s<>",]+@[^@\s<>",]+\.[^@\s<>",]+$'), '{}')
 from (
  select u.email from hr.staff_offers o join public.cms_users u on u.auth_user_id = o.sent_by where o.id = p_offer
  union all
  select u.email from public.cms_users u
   where lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(public.rule_text('hrms.offer_signatory_name', '')), '\s+', ' ', 'g'))
     and btrim(public.rule_text('hrms.offer_signatory_name', '')) <> '' and lower(coalesce(u.status, 'active')) = 'active'
 ) x;
$function$;
revoke all on function public.hr_svc_offer_mail_people(uuid) from public, anon, authenticated;
grant execute on function public.hr_svc_offer_mail_people(uuid) to service_role;
commit;
