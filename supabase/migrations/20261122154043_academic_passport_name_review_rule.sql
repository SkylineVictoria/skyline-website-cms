do $$
declare b public.business_rule_versions; rid uuid; def jsonb; vid uuid;
begin
 select v.* into b from public.business_rules r join public.business_rule_versions v on v.rule_id=r.id where r.identifier='admissions.academic_reject_mismatched' and r.scope_key='' and v.state='published' limit 1;
 insert into public.business_rules(scope_key,identifier,registration) values('','admissions.academic_passport_name_review',jsonb_build_object('scope','applications','entity','documents','handler','setting','value_type','boolean','schema_version',1)) on conflict(scope_key,identifier) do nothing;
 select id into rid from public.business_rules where identifier='admissions.academic_passport_name_review' and scope_key='';
 if not exists(select 1 from public.business_rule_versions where rule_id=rid and state='published') then
 def := (b.definition-'name'-'identifier'-'description'-'value') || jsonb_build_object('identifier','admissions.academic_passport_name_review','name','Review academic name against passport','description','Flag academic and passport name mismatches for manual review without automatically rejecting evidence','value',true);
 insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,published_at) values(rid,1,'published','migration',def,current_date,now()) returning id into vid;
 perform public.business_rule_index_version(vid,def);
 end if;
end $$;