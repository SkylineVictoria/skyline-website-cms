-- SLIT-WITNESS-DHAVAL (owner, 2026-11-24: "in place of Chanpreet Kaur change to Dhaval Patel"): the Business Rule agents.slit_witness_name
-- gets a new published version with the value "Dhaval Patel" (the earlier version is superseded and kept in the history, with an audit row).
-- The witness still draws their own signature on Prepare the application before sending; nothing signs for them.
begin;

do $$
declare rid uuid; cur public.business_rule_versions; d jsonb; vid uuid;
  today date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  select id into rid from public.business_rules where scope_key = '' and identifier = 'agents.slit_witness_name';
  if rid is null then raise exception 'Run 20261124151517_slit_signatory_defaults first (agents.slit_witness_name is missing).'; end if;
  select * into cur from public.business_rule_versions where rule_id = rid and state = 'published' order by version desc limit 1;
  if cur.id is null then raise exception 'agents.slit_witness_name has no published version.'; end if;
  if cur.definition->>'value' = 'Dhaval Patel' then return; end if;
  d := jsonb_set(cur.definition, '{value}', '"Dhaval Patel"'::jsonb) || jsonb_build_object('starts_on', today);
  update public.business_rule_versions set state = 'superseded' where id = cur.id;
  insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, published_at)
    values (rid, (select max(version) + 1 from public.business_rule_versions where rule_id = rid), 'published', 'migration', d, today, clock_timestamp())
    returning id into vid;
  perform public.business_rule_index_version(vid, d);
  insert into public.business_rule_audit_logs(scope_key, rule_id, action, reason, before_data, after_data)
    values ('', rid, 'publish', 'Owner: SLIT witness on agreements is Dhaval Patel.', cur.definition, d);
end $$;

commit;
