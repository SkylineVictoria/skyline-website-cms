-- Copy verified legacy behavior as read-only review records. No workflow reads
-- these records. A later integration must explicitly bind and validate each rule.
begin;

do $$
declare item record; rule_id uuid; category uuid; version_id uuid; d jsonb;
  added_on date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
  source_base constant text := 'https://github.com/SkylineVictoria/skyline-website-cms/blob/7ec34be6b58bed81c5e7b1b34052831f043e3f00/';
begin
  for item in select * from (values
    -- rule-policy: technical legacy-inventory Records a verified existing value for review without registering a runtime evaluator.
    ('lms.attendance_alert_threshold','Attendance alert threshold','Academic & Attendance','lms/attendance','attendance','percentage','80'::jsonb,'The low-attendance alert also checks eligibility in SQL.','src/pages/admin/lms/attendanceRate.ts'),
    -- rule-policy: technical legacy-inventory Records a verified existing value for review without registering a runtime evaluator.
    ('lms.coe_weekly_study_hours','CoE weekly study hours','Intakes & Scheduling','lms/intakes','intake','hours','20'::jsonb,'Existing scheduling study-load assumption. Confirm its scope before migration.','src/pages/admin/lib/rto.ts#L347'),
    ('lms.voe_weekly_study_hours','VoE weekly study hours','Intakes & Scheduling','lms/intakes','intake','hours','40'::jsonb,'Existing scheduling study-load assumption. Confirm its scope before migration.','src/pages/admin/lib/rto.ts#L347'),
    -- rule-policy: technical legacy-inventory Records the existing suggestion without introducing a mandatory notice requirement.
    ('lms.intake_suggested_notice_days','Suggested intake notice','Intakes & Scheduling','lms/intakes','intake','days','7'::jsonb,'Used to suggest an intake start date.','src/pages/admin/components/rto/NewIntakeDrawer.tsx#L17'),
    ('lms.intake_suggested_start_day','Suggested intake start day','Intakes & Scheduling','lms/intakes','intake','text','"Monday"'::jsonb,'Day used for suggested intake starts.','src/pages/admin/components/rto/NewIntakeDrawer.tsx#L17'),
    -- rule-policy: technical legacy-inventory Records the existing scheduling checks for later review as a group.
    ('lms.unit_duration_ceiling','Unit scheduling duration ceiling','Courses & Units','lms/courses','course_unit','weeks','104'::jsonb,'Existing ceiling also appears in database constraints and save validation.','supabase/migrations/20261119100000_course_master_timetable.sql#L28'),
    -- rule-policy: technical legacy-inventory Records the observed file ceiling and leaves upload infrastructure configuration in place.
    ('hrms.employee_document_max_bytes','Employee document size limit (bytes)','HRMS','agency_staff','employee_document','number','10485760'::jsonb,'10 MiB in the existing employee file check. Reader and infrastructure limits are reviewed separately.','src/lib/employeeRules.ts#L33'),
    -- rule-policy: technical legacy-inventory Records existing CMS layout caps without changing validation or public rendering.
    ('cms.navigation_top_level_cap','Top-level website menu items','CMS Website','navigation','navigation','number','7'::jsonb,'Existing website editor limit.','src/config/cmsLimits.ts#L5'),
    ('cms.navigation_child_cap','Items per website dropdown','CMS Website','navigation','navigation','number','6'::jsonb,'Existing website editor limit per dropdown.','src/config/cmsLimits.ts#L5'),
    -- rule-policy: technical legacy-inventory Records the existing footer cap for review.
    ('cms.footer_links_per_column','Footer links per column','CMS Website','footer','footer','number','8'::jsonb,'Existing website editor limit per column.','src/config/cmsLimits.ts#L4'),
    -- rule-policy: technical legacy-inventory Records existing CMS layout caps without changing validation or public rendering.
    ('cms.homepage_course_cap','Homepage course display limit','CMS Website','course_catalogue','course','number','20'::jsonb,'Existing cap for display and featured courses.','src/config/cmsLimits.ts#L40'),
    -- rule-policy: technical legacy-inventory Records the observed assignment fallback without changing deadlines.
    ('lms.assessment_assignment_default_days','Assessment assignment due date fallback','Assessments','lms/assessments','assignment','days','7'::jsonb,'Existing fallback when no due date is supplied.','supabase/migrations/20261119223000_intake_replaces_batch_stage2b_functions.sql#L3492')
  ) as x(identifier, label, category, menu_id, entity, value_type, value, notes, source) loop
    insert into public.business_rules(scope_key,identifier,registration)
      values ('',item.identifier,jsonb_build_object('scope',item.menu_id,'entity',item.entity,'value_type',item.value_type,
        'schema_version',1,'handler','inventory_only')) on conflict (scope_key,identifier) do nothing returning id into rule_id;
    if rule_id is null then continue; end if;

    -- Labels may have been renamed. Reuse the matching category if present and
    -- otherwise use a category already owned by the same institution.
    -- rule-policy: technical category-lookup Chooses an existing category if the original category label was renamed.
    select c.id into category from public.business_rule_categories c where c.scope_key = ''
      order by (c.name = item.category) desc, (c.name = 'Other') desc, c.id limit 1;
    if category is null then raise exception 'Load Skyline Business Rules categories before importing the inventory'; end if;
    d := jsonb_build_object(
      'name',item.label,'identifier',item.identifier,'category_id',category,
      'scope',item.menu_id,'entity',item.entity,'description',item.notes,
      'value_type',item.value_type,'value',item.value,'options','[]'::jsonb,'groups','[]'::jsonb,'match','all',
      'then_action','use_value','else_action','none','priority',0,'starts_on',added_on,'ends_on','',
      'enabled',false,'approval_required',false,'source_url',source_base || item.source,
      'notes','Imported for review. The existing workflow remains the authority until this rule is connected.');
    perform public.business_rule_validate(d, null);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
      values (rule_id,1,'draft','migration',d,added_on) returning id into version_id;
    perform public.business_rule_index_version(version_id,d);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values ('',rule_id,'migration','Catalogued existing behavior for SLIT review.',d);
  end loop;
end $$;

commit;
