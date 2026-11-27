do $$
declare base public.business_rule_versions; item record; rid uuid; def jsonb; vid uuid;
begin
 select v.* into base from public.business_rules r join public.business_rule_versions v on v.rule_id=r.id where r.identifier='admissions.academic_passport_name_review' and r.scope_key='' and v.state='published' limit 1;
 for item in select * from (values
 ('admissions.visa_passport_name_review','Review visa name against passport','boolean','true'::jsonb,'Flag differing extracted visa and passport names for manual review'),
 ('admissions.visa_require_expiry_date','Require visa expiry date','boolean','false'::jsonb,'Require an extracted visa expiry date before advancing on a required visa step'),
 ('admissions.visa_reject_expired','Reject expired visa evidence','boolean','true'::jsonb,'Do not count an expired visa as acceptable evidence'),
 ('admissions.visa_require_subclass','Require extracted visa subclass','boolean','false'::jsonb,'Require visa subclass extraction before advancing on a required visa step'),
 ('admissions.visa_vevo_review','Require manual VEVO review','boolean','false'::jsonb,'Show a manual VEVO verification reminder; does not claim an API verification')
 ) as x(identifier,name,kind,val,description)
 loop
  insert into public.business_rules(scope_key,identifier,registration) values('',item.identifier,jsonb_build_object('scope','applications','entity','documents','handler','setting','value_type',item.kind,'schema_version',1)) on conflict(scope_key,identifier) do nothing;
  select id into rid from public.business_rules where scope_key='' and identifier=item.identifier;
  if not exists(select 1 from public.business_rule_versions where rule_id=rid and state='published') then
   def := (base.definition-'name'-'identifier'-'description'-'value') || jsonb_build_object('identifier',item.identifier,'name',item.name,'description',item.description,'value_type',item.kind,'value',item.val);
   insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,published_at) values(rid,1,'published','migration',def,current_date,now()) returning id into vid;
   perform public.business_rule_index_version(vid,def);
  end if;
 end loop;
end $$;