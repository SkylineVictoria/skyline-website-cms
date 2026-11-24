-- OFFER-DECLINED-EMAIL (2026-11-24, owner: "Email HR when an employee declines the offer").
--   hr.staff_emails gains the kind admin_offer_declined; public.hr_svc_offer_decline (20261124235517) queues it for the HR addresses
--   (EF_HR_ADMIN_NOTIFY_TO, as "offer signed"), with the person's name, email and reason; staff-onboarding sends it straight away.
-- Additive. Rollback: re-create hr_svc_offer_decline from 20261124235517 and restore the previous kind check.
begin;

alter table hr.staff_emails drop constraint if exists staff_emails_kind_check;
alter table hr.staff_emails add constraint staff_emails_kind_check check (kind = any (array['application_received', 'admin_new_application', 'document_invite',
 'reupload_invite', 'admin_documents_submitted', 'offer', 'signed_offer', 'admin_offer_signed', 'rejected', 'already_applied', 'access_ready', 'login_link',
 'admin_offer_declined']::text[]));

create or replace function public.hr_svc_offer_decline(p_token_hash text, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'hr', 'pg_temp'
as $function$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers; v_reason text := left(btrim(coalesce(p_reason, '')), 1000);
begin
 i := hr.invite_for_write(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null and declined_at is null
  order by sent_at desc limit 1 for update;
 if not found or p.status <> 'offer_sent' then raise exception 'This offer can no longer be declined.' using errcode = '23514'; end if;
 if v_reason ~ '[[:cntrl:]<>]' then v_reason := regexp_replace(v_reason, '[[:cntrl:]<>]', ' ', 'g'); end if;
 update hr.staff_offers set declined_at = now(), decline_reason = nullif(v_reason, '') where id = o.id;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', 'Offer declined by the candidate' || case when v_reason <> '' then ': ' || v_reason else '' end, true);
 update hr.staff_profiles set status = 'rejected' where id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id;
 update hr.staff_invites set revoked_at = now() where profile_id = p.id and id <> i.id and used_at is null and revoked_at is null and superseded_at is null;
 perform hr.audit_log(p.id, 'offer_declined', jsonb_build_object('offerId', o.id, 'reason', nullif(v_reason, '')));
 -- OFFER-DECLINED-EMAIL: HR is told (EF_HR_ADMIN_NOTIFY_TO), with the reason when one was given.
 perform hr.queue_email(p.id, 'admin_offer_declined', 'admin', jsonb_build_object('offerId', o.id, 'reason', nullif(v_reason, '')));
 return jsonb_build_object('name', hr.staff_name(p), 'status', 'rejected', 'declined', true);
end $function$;
revoke all on function public.hr_svc_offer_decline(text, text) from public, anon, authenticated;
grant execute on function public.hr_svc_offer_decline(text, text) to service_role;

commit;
