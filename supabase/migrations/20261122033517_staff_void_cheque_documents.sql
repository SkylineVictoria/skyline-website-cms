-- STAFF-DOCS-ONE-AT-A-TIME (2026-11-22, admin request). Additive.
-- The employee onboarding wizard collects, one screen each: Passport, Visa (non-citizens), Driving licence (optional), Void cheque and
-- Academic results. English test result and Health insurance are no longer asked (rows already uploaded stay valid and visible).
-- 1. New document type 'Void Cheque' (no expiry) accepted by the table, the rule-list reader, the onboarding upload paths and the
--    admin upload on the employee page.
-- 2. Business Rule hrms.applicant_document_checklist v2 (published; v1 superseded): citizen = Passport, Academic, Void Cheque;
--    other = Passport, Visa, Academic, Void Cheque. hr.staff_required_categories falls back to the same lists.
-- Rollback (manual): republish v1 of the rule, restore the four functions from their previous definitions, put the old category check back.
begin;

alter table hr.staff_documents drop constraint if exists staff_documents_category_check;
alter table hr.staff_documents add constraint staff_documents_category_check
 check (category = any (array['Passport','Visa','English','Academic','Driving Licence','Health Insurance','Void Cheque']));

create or replace function hr.staff_doc_rule_list(p_rule text, p_part text, p_default text[]) returns text[]
language sql stable set search_path = pg_catalog, pg_temp as $function$
  select case when jsonb_typeof(v) = 'array'
      and not exists (select 1 from jsonb_array_elements(v) e
                       where jsonb_typeof(e) <> 'string' or (e #>> '{}') not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance','Void Cheque'))
    then array(select e from jsonb_array_elements_text(v) with ordinality t(e, i) group by e order by min(i))
    else p_default end
    from (select public.rule_json(p_rule, '{}'::jsonb) -> p_part v) x;
$function$;

create or replace function hr.staff_required_categories(p_citizen boolean) returns text[]
language sql stable set search_path = pg_catalog, pg_temp as $function$
  select case when p_citizen is true
    then hr.staff_doc_rule_list('hrms.applicant_document_checklist', 'citizen', array['Passport','Academic','Void Cheque'])
    else hr.staff_doc_rule_list('hrms.applicant_document_checklist', 'other', array['Passport','Visa','Academic','Void Cheque']) end;
$function$;

create or replace function hr.staff_doc_label(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $function$
 select case p_category when 'English' then 'English test result' when 'Academic' then 'academic results' when 'Void Cheque' then 'void cheque' else lower(p_category) end;
$function$;

-- The upload paths list the accepted types inline: add 'Void Cheque' to that exact list (refused if the list is not found as expected).
do $$
declare f regprocedure; def text; old text; new text;
begin
 foreach f in array array['public.hr_svc_upload_target(text,text,uuid)'::regprocedure, 'public.hr_svc_document_add(text,text,text,text,text,integer,date,uuid)'::regprocedure] loop
  def := pg_get_functiondef(f);
  old := 'in (''Passport'',''Visa'',''English'',''Academic'',''Driving Licence'',''Health Insurance'')';
  new := 'in (''Passport'',''Visa'',''English'',''Academic'',''Driving Licence'',''Health Insurance'',''Void Cheque'')';
  if position(new in def) > 0 then continue; end if;
  if position(old in def) = 0 then raise exception 'Category list not found in %', f; end if;
  execute replace(def, old, new);
 end loop;
 -- rule-policy: technical category-list Adds the new type to the admin upload's accepted list.
 f := 'public.hr_admin_emp_doc_add(uuid,text,text,text,text,integer)'::regprocedure;
 def := pg_get_functiondef(f);
 old := 'in (''Passport'',''Visa'',''Academic'',''Health Insurance'',''Driving Licence'',''PTE'',''English Certificate'',''Resume'')';
 new := 'in (''Passport'',''Visa'',''Academic'',''Health Insurance'',''Driving Licence'',''PTE'',''English Certificate'',''Resume'',''Void Cheque'')';
 if position(new in def) = 0 then
  if position(old in def) = 0 then raise exception 'Category list not found in %', f; end if;
  execute replace(def, old, new);
 end if;
end $$;

-- Business Rule v2 (the value the onboarding wizard and Submit use).
do $$
declare r public.business_rules; v1 public.business_rule_versions; d jsonb;
begin
 select * into r from public.business_rules where identifier = 'hrms.applicant_document_checklist';
 if r.id is null then return; end if;
 if exists (select 1 from public.business_rule_versions where rule_id = r.id and state = 'published'
            and definition #> '{value,citizen}' = '["Passport","Academic","Void Cheque"]'::jsonb) then return; end if;
 -- rule-policy: technical rule-version Reads the current published version of hrms.applicant_document_checklist.
 select * into v1 from public.business_rule_versions where rule_id = r.id and state = 'published' order by version desc limit 1;
 d := coalesce(v1.definition, '{}'::jsonb) || jsonb_build_object(
   'value', jsonb_build_object('citizen', jsonb_build_array('Passport','Academic','Void Cheque'), 'other', jsonb_build_array('Passport','Visa','Academic','Void Cheque')),
   'starts_on', to_char(current_date, 'YYYY-MM-DD'),
   'notes', 'Onboarding asks for passport, visa (non-citizens), driving licence (optional), void cheque and academic results, one screen each (admin request 2026-11-22).',
   'description', 'English test result and health insurance are no longer asked of new staff.');
 update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'published';
 insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, published_at)
 -- rule-policy: technical rule-version Publishes the new version of hrms.applicant_document_checklist.
 values (r.id, coalesce((select max(version) from public.business_rule_versions where rule_id = r.id), 0) + 1, 'published', 'administrator', d, current_date, now());
end $$;

commit;
