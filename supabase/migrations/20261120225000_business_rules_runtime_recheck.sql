-- Source inventory only. This migration neither rewrites nor activates any workflow.
begin;

do $$
declare item record; rule_id uuid; category uuid; version_id uuid; d jsonb;
  added_on date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
  source_base constant text := 'https://github.com/SkylineVictoria/skyline-website-cms/blob/7f93fd633ad445823e46255f4207bc75567252c5/';
begin
  for item in select * from (values
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('students.auto_placement_application_states','Application stages eligible for auto-placement','Student Management','agency_students','placement','list','["Offer accepted","CoE issued","Enrolled"]'::jsonb,'Verified against the hosted placement function. A student must be linked.','supabase/migrations/20261119223000_intake_replaces_batch_stage2b_functions.sql#L1272'),
    ('students.auto_placement_existing_enrolments','Existing enrolment states that prevent duplicate placement','Student Management','agency_students','placement','list','["Active","Deferred","Completed"]'::jsonb,'Auto-placement skips an existing course enrolment in one of these states.','supabase/migrations/20261119223000_intake_replaces_batch_stage2b_functions.sql#L1275'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('students.auto_placement_manual_removal_override','Manual removal blocks automatic replacement','Student Management','agency_students','placement','boolean','true'::jsonb,'The automatic placement routine respects a manual removal override.','supabase/migrations/20261119223000_intake_replaces_batch_stage2b_functions.sql#L1277'),
    ('lms.application_intake_fallback_months','Application fallback intake window (months)','Intakes & Scheduling','lms/intakes','intake','number','12'::jsonb,'When fallback dates apply, the hosted routine offers monthly choices for the next twelve months.','supabase/migrations/20261113210000_enrolment_requires_intake.sql#L20'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('lms.master_next_cycle_lead_months','Timetable next-cycle due lead time (months)','Intakes & Scheduling','lms/intakes','intake','number','3'::jsonb,'Flags a missing next timetable cycle as the current cycle approaches its end.','supabase/migrations/20261119130000_master_cycles_and_prerequisites_first.sql#L167'),
    ('lms.intake_trainer_before_unit_assignment','Trainer must be assigned to the intake before the unit','Intakes & Scheduling','lms/intakes','intake','boolean','true'::jsonb,'The backend requires intake membership before assigning that trainer to a unit in the intake.','supabase/migrations/20261119223000_intake_replaces_batch_stage2b_functions.sql#L184'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('lms.elective_automatic_selection_order','Default elective picker prioritization','Courses & Units','lms/courses','qualification_import','text','"Wait for prerequisite lookups, respect packaging and prefer units without prerequisites"'::jsonb,'Institutional selection behavior. The qualification’s authoritative packaging remains separate.','src/pages/admin/lms/AddUnitsFromTga.tsx#L222'),
    ('lms.reschedule_search_time_increment','Class rescheduling time-slot increment (minutes)','Intakes & Scheduling','lms/timetable-settings','class_rescheduling','number','30'::jsonb,'Verified in the hosted rescheduling routine for same-day and different-day suggestions.','supabase/migrations/20261120211741_class_rescheduling_rules.sql#L296'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('lms.reschedule_fallback_end_days','Class rescheduling fallback search end','Intakes & Scheduling','lms/timetable-settings','class_rescheduling','days','90'::jsonb,'Used as the ending date bound when the unit and intake dates are absent.','supabase/migrations/20261120211741_class_rescheduling_rules.sql#L190'),
    ('lms.reschedule_waiting_blocks_completion','Class rescheduling completion default','Intakes & Scheduling','lms/timetable-settings','class_rescheduling','text','"Wait for classes to be rescheduled before completing the course"'::jsonb,'The existing rescheduling editor can override the default for a course.','supabase/migrations/20261120211741_class_rescheduling_rules.sql#L26'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('lms.reschedule_cancellation_default','Class rescheduling cancellation default','Intakes & Scheduling','lms/timetable-settings','class_rescheduling','text','"No cancellation without a make-up"'::jsonb,'The existing rescheduling editor controls the operational value.','supabase/migrations/20261120211741_class_rescheduling_rules.sql#L26'),
    ('assessment.due_sweep_schedule','Assessment due and overdue notification schedule','Assessments','lms/assessments','assessment_reminders','text','"Daily at 21:00 UTC"'::jsonb,'Schedule confirmed in production. This is the notification sweep, separate from per-assessment due dates.','supabase/migrations/20261113440000_assessment_rpcs.sql#L1376'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('assessment.due_sweep_unsubmitted_only','Assessment reminder assignment eligibility','Assessments','lms/assessments','assessment_reminders','text','"Open assignment with no attempt outside Draft or Void"'::jsonb,'Hosted reminder sweep avoids notifications for already submitted assignments.','supabase/migrations/20261113440000_assessment_rpcs.sql#L1358'),
    ('assessment.due_sweep_duplicate_notifications','Assessment due and overdue notices sent once per assignment and recipient','Assessments','lms/assessments','assessment_reminders','boolean','true'::jsonb,'Hosted sweep looks up prior due-soon or overdue notifications before queuing the same notification.','supabase/migrations/20261113440000_assessment_rpcs.sql#L1360'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('admissions.registration_verification_prerequisites','Manual registration verification prerequisites','CRM & Admissions','registrations','registration','list','["Registration lodged","Offer accepted or later","At least one evidence item","Valid CoE number"]'::jsonb,'The application workbench checks these conditions before sending a verification request.','src/pages/agency/lib/registrationWorkbench.ts#L47'),
    ('admissions.registration_stale_lodgement_days','Unverified registration alert age','CRM & Admissions','registrations','registration','days','14'::jsonb,'Internal reconciliation alert. This is not an external reporting deadline.','src/pages/agency/lib/registrationWorkbench.ts#L83'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('admissions.registration_coe_voe_issue_prerequisites','CoE or VoE issue prerequisites','CRM & Admissions','registrations','registration','list','["Offer accepted","Verified registration","Uploaded PDF"]'::jsonb,'Existing system workflow for approving and issuing the document.','supabase/migrations/20261027080000_coe_voe_issue_flow.sql#L6'),
    ('admissions.registration_coe_voe_pdf_mib','CoE or VoE PDF size limit (MiB)','CRM & Admissions','registrations','registration','number','3'::jsonb,'Existing server-side upload ceiling for issue documents.','supabase/migrations/20261027080000_coe_voe_issue_flow.sql#L161'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('admissions.application_document_types','Validated application upload types','CRM & Admissions','applications','application_document','list','["JPEG","PNG","PDF"]'::jsonb,'The existing validator accepts these document formats.','supabase/functions/_shared/validation/person.ts#L153'),
    ('admissions.application_document_limit_mib','Validated application document limit (MiB)','CRM & Admissions','applications','application_document','number','10'::jsonb,'Existing shared document validator ceiling.','supabase/functions/_shared/validation/person.ts#L152'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('agents.agent_application_yes_no_fallback','Agent PDF yes/no unanswered default','Agents','agency_agents','agent_onboarding','text','"No"'::jsonb,'Existing form-prefill behavior. A rendered default does not establish what the agent actually answered.','supabase/functions/_shared/agent-onboarding.ts#L406'),
    ('agents.agent_application_attachment_cap_mib','Agent application attachment limit (MiB)','Agents','agency_agents','agent_onboarding','number','5'::jsonb,'Existing F04 attachment limit.','supabase/functions/_shared/agent-onboarding.ts#L279'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('hrms.pay_period_future_horizon_months','Pay-period generation horizon (months)','HRMS','staff_pay_schedules','pay_period','number','12'::jsonb,'Default forward coverage for generated pay periods.','supabase/migrations/20261110130000_hrms_pay_schedules.sql#L71'),
    ('hrms.pay_period_topup_schedule','Pay-period top-up schedule','HRMS','staff_pay_schedules','pay_period','text','"Daily at 02:30 UTC"'::jsonb,'Schedule confirmed in production.','supabase/migrations/20261110130000_hrms_pay_schedules.sql#L107'),
    -- rule-policy: technical audited-reference Copies source facts into reference records with no effect on workflow behavior.
    ('hrms.optional_holiday_unconfigured_allowance','Optional holiday allowance when no year setting exists','HRMS','staff_holidays','holiday','number','0'::jsonb,'Fallback for an unconfigured year, independent of statutory leave entitlements.','supabase/migrations/20261113150000_hr_holiday_sync_optional.sql#L233'),
    ('hrms.staff_retention_eligibility','Staff onboarding file purge eligibility','HRMS','staff_candidates','staff_retention','text','"Rejected application with files still present and rejection older than the configured retention period"'::jsonb,'Verified in the hosted retention eligibility routine. Existing retention configuration remains authoritative.','supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql#L1010')
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
      'notes','Source audit reference. The workflow continues to use its current implementation or stored configuration.');
    perform public.business_rule_validate(d, null);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
      values (rule_id,1,'reference','migration',d,added_on) returning id into version_id;
    perform public.business_rule_index_version(version_id,d);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values ('',rule_id,'migration','Catalogued existing behavior for SLIT review.',d);
  end loop;
end $$;

commit;
