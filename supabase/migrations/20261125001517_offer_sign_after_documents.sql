-- OFFER-SIGN-LAST (2026-11-24, owner: "accepting the offer opens the wizard and asks for the documents; without the documents he can't sign;
-- move the signing to the last screen and allow sign and submit").
--   Order for the offer-first flow: read the offer › Accept and continue › the document wizard (details, passport, …) › last screen
--   "Sign the offer and submit" (the documents are submitted, then the offer is signed).
--   hr.invite_for_write / hr.staff_applicant_view  the wizard is writable while the offer waits (Offer sent) as well.
--   public.hr_svc_staff_documents_link             opens the wizard at Offer sent too; once the documents are in (none rejected) it
--                                                  answers {purpose: 'sign'} at Offer sent (the person signs on My HR).
--   public.hr_svc_offer_sign                       refuses until the details and documents are submitted (the documents-first flow
--                                                  already has them). Otherwise the LIVE definition.
-- hr_svc_onboarding_submit (20261124235517) already keeps the status after an offer (only Invited moves to Documents submitted).
-- Additive. Rollback: re-create the three functions from 20261124235517 and hr_svc_offer_sign from its previous definition.
begin;

CREATE OR REPLACE FUNCTION hr.invite_for_write(p_hash text, p_purposes text[])
 RETURNS hr.staff_invites LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'hr', 'pg_temp'
AS $function$
declare i hr.staff_invites; v_status text;
begin
 i := hr.invite_resolve(p_hash, p_purposes);
 select status into v_status from hr.staff_profiles where id = i.profile_id for update;
 if i.used_at is not null or not (case when i.purpose = 'offer' then v_status = 'offer_sent' else v_status in ('invited', 'offer_sent', 'offer_signed') end) then
  raise exception 'This has already been sent and can no longer be changed.' using errcode = '23514';
 end if;
 return i;
end $function$;

CREATE OR REPLACE FUNCTION hr.staff_applicant_view(i hr.staff_invites)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'hr', 'pg_temp'
AS $function$
declare p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = i.profile_id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id' - 'id' - 'status_changed_at' - 'created_at' - 'updated_at',
  'status', p.status, 'mode', i.purpose, 'readOnly', i.used_at is not null or p.status not in ('invited', 'offer_sent', 'offer_signed'),
  'expiresAt', i.expires_at,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id), 'bank', hr.bank_view(p.id, false),
  'employment', (select jsonb_build_object('jobTitle', e.job_title, 'workLocation', e.work_location, 'employmentType', e.employment_type, 'joiningDate', e.joining_date,
    'payType', (select s.frequency from hr.employee_pay ep join hr.pay_schedules s on s.id = ep.pay_schedule_id where ep.profile_id = e.profile_id))
    from hr.employment e where e.profile_id = p.id));
end $function$;

create or replace function public.hr_svc_staff_documents_link(p_user uuid, p_hash text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'hr', 'auth', 'pg_temp'
as $function$
declare p hr.staff_profiles; v_submitted boolean; v_purpose text; i hr.staff_invites;
begin
 select * into p from hr.staff_profiles where auth_user_id = p_user for update;
 if not found or p.status not in ('offer_sent', 'offer_signed') or not exists (select 1 from auth.users u where u.id = p_user and u.email_confirmed_at is not null) then
  raise exception 'There are no documents to add for this login.' using errcode = '28000'; end if;
 v_submitted := exists (select 1 from hr.staff_applications a where a.profile_id = p.id and a.submitted_at is not null);
 if not v_submitted then v_purpose := 'documents';
 elsif exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then v_purpose := 'reupload';
 elsif p.status = 'offer_sent' then return jsonb_build_object('purpose', 'sign');
 else raise exception 'Your documents are with us. We will contact you if we need anything else.' using errcode = '23514'; end if;
 i := hr.invite_create(p.id, v_purpose, p_hash, p_user);
 return jsonb_build_object('purpose', v_purpose, 'expiresAt', i.expires_at);
end $function$;
revoke all on function public.hr_svc_staff_documents_link(uuid, text) from public, anon, authenticated;
grant execute on function public.hr_svc_staff_documents_link(uuid, text) to service_role;

CREATE OR REPLACE FUNCTION public.hr_svc_offer_sign(p_token_hash text, p_offer uuid, p_signer_name text, p_consent_text text, p_ip text, p_user_agent text, p_signed_path text, p_signed_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers; v_name text := btrim(coalesce(p_signer_name, ''));
begin
 i := hr.invite_for_write(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 -- OFFER-SIGN-LAST: the details and documents come first; the offer is signed on the wizard's last screen.
 if not exists (select 1 from hr.staff_applications a where a.profile_id = p.id and a.submitted_at is not null) then
  raise exception 'Add your details and documents first; you sign the offer on the last screen.' using errcode = '23514'; end if;
 select * into o from hr.staff_offers where id = p_offer and profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null for update;
 if not found then raise exception 'This offer can no longer be signed.' using errcode = '23514'; end if;
 if v_name = '' or char_length(v_name) > 200 or v_name ~ '[[:cntrl:]<>]' then raise exception 'Type your full name to sign.' using errcode = '22023'; end if;
 if btrim(coalesce(p_consent_text, '')) = '' then raise exception 'Tick the box to agree.' using errcode = '22023'; end if;
 if not hr.staff_path_ok(p_signed_path, p.id, 'offer') or p_signed_path = o.storage_path then raise exception 'The signed file location is not valid.' using errcode = '22023'; end if;
 if p_signed_sha256 is null or p_signed_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'The signed file hash is not valid.' using errcode = '22023'; end if;
 if not hr.staff_object_exists(p_signed_path) then raise exception 'The signed file was not found.' using errcode = 'P0002'; end if;
 update hr.staff_offers set signed_at = now(), signer_name = v_name, consent_text = left(btrim(p_consent_text), 1000), signer_ip = left(p_ip, 64),
  signer_user_agent = left(p_user_agent, 500), signed_path = p_signed_path, signed_sha256 = p_signed_sha256 where id = o.id returning * into o;
 perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Offer signed', true);
 update hr.staff_profiles set status = 'offer_signed' where id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 perform hr.queue_email(p.id, 'signed_offer', 'applicant', jsonb_build_object('offerId', o.id));
 perform hr.queue_email(p.id, 'admin_offer_signed', 'admin', jsonb_build_object('offerId', o.id));
 return public.hr_svc_offer_open(p_token_hash);
end $function$;

commit;
