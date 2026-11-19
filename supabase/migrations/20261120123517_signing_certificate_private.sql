-- The completion certificate is never sent or downloaded (owner 2026-11-20). It is the audit record (IP addresses, browsers, the history
-- with its hash chain, request references) and stays in storage / the database as evidence; staff open it only from the signing request
-- page (View audit record, document-signing admin_url). Sent and downloadable copies are the signed documents only.
--   * Agency onboarding: agency_onboarding_file refuses every certificate kind (completion, application form, referee check) for everyone,
--     staff and the agency's own users included; agency_onboarding_list and portal_agency_onboarding no longer offer them.
--   * Student offer letters: portal_offer_letter_file refuses the certificate (students, agents, staff); portal_offer_letter_list says none.
-- The stored copies (certificate_content, application_certificate_content) are kept, unread. Functions patched in place (single-line anchors).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

select pg_temp.patch('public.agency_onboarding_file(uuid, text)',
 $a$ if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;$a$,
 $a$ if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_kind in ('certificate', 'application_certificate') or p_kind like 'referee_certificate:%' then
  raise exception 'The audit record is not downloadable. Staff can view it on the signing request (View audit record).' using errcode = '42501';
 end if;$a$);

select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'files', jsonb_build_object('form', f.form_content is not null, 'certificate', f.certificate_content is not null)$a$,
 $a$'files', jsonb_build_object('form', f.form_content is not null, 'certificate', false)$a$);
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'certificate', o.certificate_content is not null, 'application_certificate', o.application_certificate_content is not null)$a$,
 $a$'certificate', false, 'application_certificate', false)$a$);
select pg_temp.patch('public.portal_agency_onboarding(uuid)',
 $a$'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null)$a$,
 $a$'agreement', o.agreement_content is not null, 'certificate', false)$a$);

select pg_temp.patch('public.portal_offer_letter_list(uuid)', $a$'hasCertificate', l.certificate_content is not null$a$, $a$'hasCertificate', false$a$);
select pg_temp.patch('public.portal_offer_letter_file(uuid, text)',
 $a$ elsif p_kind = 'certificate' and l.certificate_content is not null then$a$,
 $a$ elsif p_kind = 'certificate' then
  raise exception 'The audit record is not downloadable. Staff can view it on the signing request (View audit record).' using errcode = '42501';
 elsif false then$a$);
