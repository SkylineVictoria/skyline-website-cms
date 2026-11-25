-- OFFER-SIGNATURES (2026-11-24, owner): "From SLIT Hardik Amin CEO is signing officer, include his sign and date". Additive.
-- Staff offer letters are signed for the company by Hardik Amin, Chief Executive Officer: the Business Rules
-- hrms.offer_signatory_name / hrms.offer_signatory_title get a new published version (editable later on Settings & Policies).
-- staff-admin draws that person's saved CMS signature (cms_users.signature_png, matched by name) and the issue date under
-- "Yours sincerely"; the employee's drawn signature and the date are printed on the signed copy (staff-onboarding offer_sign).
begin;
do $$
declare v record; r public.business_rules; v1 public.business_rule_versions; d jsonb;
begin
 for v in select * from (values ('hrms.offer_signatory_name', 'Hardik Amin'), ('hrms.offer_signatory_title', 'Chief Executive Officer')) as t(id, val) loop
  select * into r from public.business_rules where identifier = v.id;
  if r.id is null then continue; end if;
  if exists (select 1 from public.business_rule_versions where rule_id = r.id and state = 'published' and definition -> 'value' = to_jsonb(v.val)) then continue; end if;
  -- rule-policy: technical rule-version Reads the current published version of the offer signatory rule.
  select * into v1 from public.business_rule_versions where rule_id = r.id and state = 'published' order by version desc limit 1;
  d := coalesce(v1.definition, '{}'::jsonb) || jsonb_build_object('value', to_jsonb(v.val), 'starts_on', to_char(current_date, 'YYYY-MM-DD'),
    'notes', 'Staff offer letters are signed by Hardik Amin, Chief Executive Officer (owner 2026-11-24).');
  update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'published';
  insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, published_at)
  -- rule-policy: technical rule-version Publishes the new version of the offer signatory rule.
  values (r.id, coalesce((select max(version) from public.business_rule_versions where rule_id = r.id), 0) + 1, 'published', 'administrator', d, current_date, now());
 end loop;
end $$;
commit;
