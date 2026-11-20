do $$
declare
  k constant text := 'support.ticket_attachment_count';
  rid uuid;
  vid uuid;
  d jsonb;
begin
  select v.definition || jsonb_build_object('identifier', k, 'name', 'Maximum attachments per support message',
    'description', 'Applies to a new ticket and each reply.', 'value', 5, 'starts_on', current_date,
    'notes', 'Initial value preserves the existing five-file limit.', 'source_url','')
    into strict d from public.business_rule_versions v join public.business_rules r on r.id=v.rule_id
    where r.scope_key='' and r.identifier='support.ticket_attachment_limit_mib' and v.state='published'
    order by v.version desc limit 1;
  insert into public.business_rules(scope_key, identifier, registration)
    select '', k, (registration - 'max') || '{"min":0}'::jsonb from public.business_rules
    where scope_key='' and identifier='support.ticket_attachment_limit_mib'
    on conflict (scope_key,identifier) do nothing returning id into rid;
  if rid is not null then
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,published_at)
      values(rid,1,'published','migration',d,current_date,now()) returning id into vid;
    perform public.business_rule_index_version(vid,d);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values('',rid,'publish','Moved existing support attachment count into SLIT settings.',d);
  end if;
end $$;

alter table public.support_ticket_messages drop constraint support_ticket_messages_attachments_check;
alter table public.support_ticket_messages add constraint support_ticket_messages_attachments_check
  check (jsonb_typeof(attachments)='array');

select public.business_rule_patch_function('public.support_clean_attachments(jsonb)'::regprocedure,
  $old$if jsonb_array_length(p_items) > 5 then raise exception 'At most 5 attachments' using errcode = '22023'; end if;$old$,
  $new$if jsonb_array_length(p_items) > 0 then
    declare cap integer := public.rule_int('support.ticket_attachment_count', null);
    begin
      if cap is null then raise exception 'The support attachment count is unavailable'; end if;
      if jsonb_array_length(p_items) > cap then raise exception 'Attach at most % files.', cap using errcode = '22023'; end if;
    end;
  end if;$new$);
