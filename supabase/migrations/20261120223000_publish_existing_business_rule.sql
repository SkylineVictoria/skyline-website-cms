-- The release publishes only the original, unchanged upload baseline.
-- Inventory entries document existing behavior and have no engine action.
begin;

alter table public.business_rule_versions
  drop constraint business_rule_versions_state_check,
  add check (state in ('draft', 'published', 'superseded', 'reference'));

update public.business_rule_versions v
set state = 'reference'
from public.business_rules r
where r.id = v.rule_id and r.scope_key = ''
  and r.registration->>'handler' = 'inventory_only'
  and v.state = 'draft' and v.origin = 'migration' and v.version = 1;

do $$
declare rule uuid; baseline public.business_rule_versions; ceiling bigint; published_definition jsonb;
begin
  -- rule-policy: business lms.unit_upload_max_bytes Targets the existing registered rule without introducing a value.
  select id into rule from public.business_rules
    where scope_key = '' and identifier = 'lms.unit_upload_max_bytes'
      and registration->>'handler' = 'upload_size'
    for update;
  if not found then return; end if;

  select * into baseline from public.business_rule_versions
    where rule_id = rule and version = 1 and state = 'draft' and origin = 'migration';
  if not found or exists (select 1 from public.business_rule_versions v where v.rule_id = rule and v.version > 1) then
    return;
  end if;

  -- rule-policy: technical storage-continuity Reads the existing technical ceiling and leaves the live upload limit unchanged.
  select file_size_limit into ceiling from storage.buckets where id = 'unit-content';
  -- rule-policy: security preserve-approval Only releases the exact migration version with its original approval configuration.
  if ceiling is null or baseline.definition->'value' is distinct from to_jsonb(ceiling)
    or baseline.definition->'enabled' is distinct from 'true'::jsonb
    -- rule-policy: security preserve-approval Stops publication if the migration baseline requires approval.
    or baseline.definition->'approval_required' is distinct from 'false'::jsonb
    or baseline.definition->'groups' is distinct from '[]'::jsonb
    or baseline.definition->>'then_action' is distinct from 'use_value'
    or baseline.starts_on > (statement_timestamp() at time zone 'Australia/Melbourne')::date
    or baseline.ends_on is not null then
    raise exception 'The upload baseline must match the current Storage ceiling before publication';
  end if;

  published_definition := baseline.definition || jsonb_build_object('notes',
    'Published at the existing Storage limit. The Storage ceiling continues to apply.');
  update public.business_rule_versions set state = 'published', published_at = clock_timestamp(), definition = published_definition
    where id = baseline.id;
  insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,before_data,after_data)
    values ('',rule,'publish','Published the existing upload limit at SLIT’s request. The limit is unchanged.',baseline.definition,published_definition);
end $$;

commit;
