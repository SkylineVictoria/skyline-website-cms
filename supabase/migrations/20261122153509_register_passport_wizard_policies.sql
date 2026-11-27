do $$
declare base public.business_rule_versions; base_rule public.business_rules; item record; rid uuid; def jsonb; vid uuid;
begin
 select * into base_rule from public.business_rules where identifier='admissions.application_required_documents' and scope_key='' limit 1;
 select * into base from public.business_rule_versions where rule_id=base_rule.id and state='published' order by version desc limit 1;
 for item in select * from (values
 ('admissions.passport_reject_expired','Reject expired passport',true,'Reject expired passport as acceptable evidence'),
 ('admissions.passport_auto_delete_expired','Automatically delete expired passport',true,'Automatically delete expired passport uploads after extraction'),
 ('admissions.passport_require_expiry_date','Require extracted passport expiry date',false,'Require an extracted passport expiry date before continuing when passport is mandatory')
 ) as x(identifier,name,val,description)
 loop
   insert into public.business_rules(scope_key,identifier,registration) values ('',item.identifier,jsonb_build_object('scope','applications','entity','documents','handler','setting','value_type','boolean','schema_version',1))
   on conflict(scope_key,identifier) do nothing;
   select id into rid from public.business_rules where scope_key='' and identifier=item.identifier;
   if not exists(select 1 from public.business_rule_versions where rule_id=rid and state='published') then
    def := (base.definition - 'value' - 'name' - 'identifier' - 'description' - 'value_type') ||
      jsonb_build_object('identifier',item.identifier,'name',item.name,'description',item.description,'value_type','boolean','value',item.val,'options','[]'::jsonb);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,published_at)
    values(rid,1,'published','migration',def,current_date,now()) returning id into vid;
    perform public.business_rule_index_version(vid,def);
   end if;
 end loop;
end $$;