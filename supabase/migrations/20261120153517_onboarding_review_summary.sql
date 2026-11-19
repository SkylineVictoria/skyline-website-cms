-- Review application summary (owner 2026-11-20): staff see the ACN on the Business card and an Agreement card with the agency admin's
-- signature. agency_onboarding_review_get adds the business's ACN (agencies.acn / acn_source) and the application request's signature
-- (signer name, typed / drawn, the drawn picture, signed time). The witnesses' pictures and the terms were already returned.
-- Read-only for SLIT admins (hr.require_admin, unchanged). Patched in place (single-line anchor).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

select pg_temp.patch('public.agency_onboarding_review_get(uuid)',
 $a$'signatureEvent', o.signature_event,$a$,
 $a$'signatureEvent', o.signature_event, 'acn', a.acn, 'acnSource', a.acn_source,
  'agencySignature', (select jsonb_build_object('name', r.signer_name, 'kind', r.signature_kind, 'image', r.signature_image, 'signedAt', r.signed_at)
   from hr.sign_recipients r where r.request_id = o.application_request_id and r.signed_at is not null order by (r.role_key = 'agent') desc, r.signed_at desc limit 1),$a$);
