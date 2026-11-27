do $$
declare base public.business_rule_versions; item record; rid uuid; def jsonb; vid uuid;
begin
 select v.* into base from public.business_rules r join public.business_rule_versions v on v.rule_id=r.id where r.identifier='admissions.application_required_documents' and r.scope_key='' and v.state='published' order by v.version desc limit 1;
 for item in select * from (values
 ('admissions.academic_minimum_documents','Minimum academic documents', 'number', '1'::jsonb,'Minimum academic files when academic evidence is required'),
 ('admissions.academic_reject_mismatched','Reject incorrectly classified academic documents','boolean','true'::jsonb,'Reject files positively identified as another document type')
 ) as x(identifier,name,kind,val,description)
 loop
  insert into public.business_rules(scope_key,identifier,registration) values('',item.identifier,jsonb_build_object('scope','applications','entity','documents','handler','setting','value_type',item.kind,'schema_version',1))
  on conflict(scope_key,identifier) do nothing;
  select id into rid from public.business_rules where scope_key='' and identifier=item.identifier;
  if not exists(select 1 from public.business_rule_versions where rule_id=rid and state='published') then
   def := (base.definition - 'value' - 'name' - 'identifier' - 'description' - 'value_type') || jsonb_build_object('identifier',item.identifier,'name',item.name,'description',item.description,'value_type',item.kind,'value',item.val,'options','[]'::jsonb);
   insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,published_at) values(rid,1,'published','migration',def,current_date,now()) returning id into vid;
   perform public.business_rule_index_version(vid,def);
  end if;
 end loop;
end $$;