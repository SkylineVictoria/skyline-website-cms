-- STAFF-DOCS-PASSPORT-ONLY (2026-11-22, admin request). Additive.
-- Staff onboarding: only the passport is required. Visa (non-citizens), driving licence, void cheque and academic results are
-- still offered in the wizard, one screen each, but can be skipped. Business Rule hrms.applicant_document_checklist v3.
begin;
do $$
declare r public.business_rules; v1 public.business_rule_versions; d jsonb;
begin
 select * into r from public.business_rules where identifier = 'hrms.applicant_document_checklist';
 if r.id is null then return; end if;
 if exists (select 1 from public.business_rule_versions where rule_id = r.id and state = 'published'
            and definition #> '{value,citizen}' = '["Passport"]'::jsonb and definition #> '{value,other}' = '["Passport"]'::jsonb) then return; end if;
 -- rule-policy: technical rule-version Reads the current published version of hrms.applicant_document_checklist.
 select * into v1 from public.business_rule_versions where rule_id = r.id and state = 'published' order by version desc limit 1;
 d := coalesce(v1.definition, '{}'::jsonb) || jsonb_build_object(
   'value', jsonb_build_object('citizen', jsonb_build_array('Passport'), 'other', jsonb_build_array('Passport')),
   'starts_on', to_char(current_date, 'YYYY-MM-DD'),
   'notes', 'Only the passport is required; visa, driving licence, void cheque and academic results are optional (admin request 2026-11-22).',
   'description', 'Required staff onboarding documents.');
 update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'published';
 insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, published_at)
 -- rule-policy: technical rule-version Publishes the new version of hrms.applicant_document_checklist.
 values (r.id, coalesce((select max(version) from public.business_rule_versions where rule_id = r.id), 0) + 1, 'published', 'administrator', d, current_date, now());
end $$;
commit;
