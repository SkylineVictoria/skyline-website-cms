-- APP-ACTIVE-STATUS (owner, 2026-11-23): "display all status of application and allow user to change manually, and have Active
-- there so we can allow the student to use his workspace". Not Submitted (the owner withdrew 20261123141517's published value).
-- 1. A new application status Active (after Enrolled).
-- 2. Manual moves: from every status to every other one, "Set to <label>" (action key set_<status>), CMS Admins only, optional
--    note. The menu groups them under "Change status to". The usual guards still apply (application_enrolled_guard: Enrolled
--    only after a CoE / VoE).
-- 3. Automatic placement: the Business Rule students.auto_placement_application_states may list Active, and its published value
--    becomes Active, Offer accepted, CoE issued, Enrolled (Submitted, Under review, Action required removed). The placement
--    trigger places the student in the intake on the application as soon as it moves to Active; leaving an intake still
--    happens only on Withdrawn / Rejected.
-- Rollback: delete from application_status_transitions where action_key like 'set\_%'; republish the rule without Active in
--   Manage Rules; delete the status 'active' once no application uses it.
begin;

-- 1. Active
insert into public.application_statuses(value, label, sort, tone, hint, editable, legacy, color, is_final, is_active)
select 'active', 'Active', coalesce(
    (select min(s) from generate_series(e.sort + 1, e.sort + 9) s where not exists (select 1 from public.application_statuses x where x.sort = s)),
    (select max(sort) + 10 from public.application_statuses)),
  'success', 'Studying: the student uses the workspace', false, false, '#16a34a', false, true
from public.application_statuses e where e.value = 'enrolled'
on conflict (value) do nothing;

-- 2. Manual moves between all statuses
insert into public.application_status_transitions(from_status, action_key, to_status, actor, label, kind, note, tone, sort,
  is_active, is_automatic, is_primary, requires_reason, allowed_roles, icon)
select f.value, 'set_' || t.value, t.value, 'staff', 'Set to ' || t.label, 'status', 'optional', 'neutral', 900 + t.sort,
  true, false, false, false, '{Admin}', 'ri-edit-line'
from public.application_statuses f cross join public.application_statuses t
where f.value <> t.value and coalesce(f.is_active, true) and coalesce(t.is_active, true)
  -- Enrolled only from CoE / VoE issued (check application_status_transitions_enrolled_from_coe, 20261121051517).
  and (t.value <> 'enrolled' or f.value = 'coe_issued')
on conflict (from_status, action_key) do nothing;

-- 3. Placement at Active
update public.business_rules
set registration = jsonb_set(registration, '{allowed}',
  '["Active","Submitted","Under review","Action required","Offer issued","Offer accepted","CoE issued","Enrolled"]'::jsonb)
where scope_key = '' and identifier = 'students.auto_placement_application_states';

do $$
declare r public.business_rules; cur public.business_rule_versions; d jsonb; vid uuid; nextv int;
begin
  select * into r from public.business_rules where scope_key = '' and identifier = 'students.auto_placement_application_states';
  select * into cur from public.business_rule_versions where rule_id = r.id and state = 'published' order by starts_on desc, version desc limit 1;
  d := cur.definition || jsonb_build_object('value', '["Active","Offer accepted","CoE issued","Enrolled"]'::jsonb,
    'starts_on', to_char(current_date, 'YYYY-MM-DD'), 'ends_on', '');
  perform public.business_rule_validate(d, r.registration);
  select coalesce(max(version), 0) + 1 into nextv from public.business_rule_versions where rule_id = r.id;
  update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'draft';
  update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'published' and starts_on = current_date;
  insert into public.business_rule_versions(rule_id, version, state, origin, definition, starts_on, ends_on, published_at)
    values (r.id, nextv, 'published', 'administrator', d, current_date, null, clock_timestamp()) returning id into vid;
  perform public.business_rule_index_version(vid, d);
  insert into public.business_rule_audit_logs(scope_key, rule_id, action, actor, reason, before_data, after_data)
    values ('', r.id, 'publish', null, 'Owner 2026-11-23: place students when the application is set to Active (not Submitted)', cur.definition, d);
end $$;

commit;
