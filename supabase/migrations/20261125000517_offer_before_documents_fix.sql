-- OFFER-BEFORE-DOCUMENTS-FIX (2026-11-24, owner: "Approve every required document first (passport)" when sending an offer letter).
-- 20261124235517 let the offer go before the documents, but making the letter still required them:
--   public.hr_admin_offer_letter_add  (the letter made from a template) checked the documents for everyone;
--   public.hr_admin_staff_offer_add   (the offer file behind it, also the uploaded-PDF route) accepted Documents submitted only.
-- Now, as for sending: from Applied / Invited only the offer details are needed; at Documents submitted the documents are still
-- checked. Otherwise the LIVE definitions. Additive. Rollback: re-create both from their previous definitions.
begin;

CREATE OR REPLACE FUNCTION public.hr_admin_offer_letter_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text, p_template uuid, p_title text, p_html text, p_values jsonb, p_edited boolean DEFAULT false, p_template_html text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates; r jsonb; v_problem text; v_status text;
begin
 select * into t from hr.sign_templates where id = p_template and deleted_at is null;
 if not found or t.category <> 'offer_letter' or t.status <> 'active' then raise exception 'Choose an offer letter template.' using errcode = '22023'; end if;
 if p_html is null or btrim(p_html) = '' or char_length(p_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 if p_html ~ '\{\{\s*[A-Za-z0-9_]+\s*\}\}' then raise exception 'The letter still has placeholders that were not filled in.' using errcode = '23514'; end if;
 if coalesce(p_edited, false) and (p_template_html is null or btrim(p_template_html) = '') then raise exception 'An edited letter is recorded with what the template rendered.' using errcode = '22023'; end if;
 if p_template_html is not null and char_length(p_template_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 select p.status into v_status from hr.staff_profiles p where p.id = p_id;
 -- OFFER-BEFORE-DOCUMENTS-FIX: before the documents (Applied / Invited) only the offer details are needed.
 v_problem := case when v_status in ('applied', 'invited') then hr.onboarding_pay_problem(p_id)
   else coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id)) end;
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 r := public.hr_admin_staff_offer_add(p_id, p_path, p_filename, p_size, p_sha256);
 insert into hr.staff_offer_letters(offer_id, profile_id, template_id, template_name, title, body_html, field_values, created_by, edited, template_html)
  values ((r->'offer'->>'id')::uuid, p_id, t.id, t.name, left(btrim(coalesce(p_title, coalesce(t.subject, t.title))), 200), p_html, coalesce(p_values, '{}'::jsonb), v_admin,
   coalesce(p_edited, false), case when coalesce(p_edited, false) then p_template_html end);
 perform hr.audit_log(p_id, 'offer_letter_generated', jsonb_build_object('template', t.name, 'edited', coalesce(p_edited, false)));
 return r;
end $function$;

CREATE OR REPLACE FUNCTION public.hr_admin_staff_offer_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers; v_old text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 -- OFFER-BEFORE-DOCUMENTS-FIX: the offer may be prepared before the documents (Applied / Invited) too.
 if p.status not in ('applied', 'invited', 'documents_submitted') then raise exception 'Prepare an offer while the person is being onboarded (withdraw a sent offer first).' using errcode = '23514'; end if;
 if not hr.staff_path_ok(p_path, p.id, 'offer') then raise exception 'The offer location is not valid.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'The offer must be 10 MB or smaller.' using errcode = '22023'; end if;
 if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'The offer hash is not valid.' using errcode = '22023'; end if;
 if not hr.staff_object_exists(p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null and sent_at is null
  returning storage_path into v_old;
 insert into hr.staff_offers(profile_id, storage_path, filename, file_size, sha256, uploaded_by)
  values (p.id, p_path, left(btrim(coalesce(p_filename, 'offer.pdf')), 255), p_size, p_sha256, v_admin) returning * into o;
 return jsonb_build_object('offer', hr.offer_json(o), 'replacedPath', v_old);
end $function$;

commit;
