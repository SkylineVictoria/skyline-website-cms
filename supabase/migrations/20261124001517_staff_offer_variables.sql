-- STAFF-OFFER-VARIABLES (2026-11-23, owner): one staff offer letter with nothing fixed in it. Every company detail, the
-- signatory and every offer term is a placeholder: company details from Website settings (cms_settings), work address from the
-- employee's location, employee address from the staff profile, the award from the pay details (else the default award
-- setting), and the offer terms from new HRMS settings on Settings & Policies. The template "SLIT Staff Offer Letter" is
-- rewritten to use only placeholders. Hours, leave, probation and notice wording is chosen by the employment type
-- (hours_clause, leave_clause, probation_period, probation_clause, notice_clause in _shared/hr-template.ts), so one letter
-- fits full time, part time and contract; probation lines drop out for contract.
begin;

-- 1. Offer terms as live HRMS settings (editable on Administration > Settings & Policies).
select public.business_rule_add_setting('hrms.offer_signatory_name', 'Offer letter signatory name', 'HRMS', 'staff', 'employee', 'text', '""'::jsonb,
  '{}'::jsonb, 'Name printed under "Yours sincerely" on staff offer letters ({{signatory_name}}). Empty: the admin who issues the letter.');
select public.business_rule_add_setting('hrms.offer_signatory_title', 'Offer letter signatory title', 'HRMS', 'staff', 'employee', 'text', '"Authorised Officer"'::jsonb,
  '{}'::jsonb, 'Title printed under the signatory name on staff offer letters ({{signatory_title}}).');
select public.business_rule_add_setting('hrms.offer_probation_months', 'Probation period (months)', 'HRMS', 'staff', 'employee', 'number', '6'::jsonb,
  '{"min":0,"max":24}'::jsonb, 'Probation printed on staff offer letters ({{probation_months}}).');
select public.business_rule_add_setting('hrms.offer_employee_notice_weeks', 'Employee notice of resignation (weeks)', 'HRMS', 'staff', 'employee', 'weeks', '4'::jsonb,
  '{"min":0,"max":52}'::jsonb, 'Notice an employee gives, printed on staff offer letters ({{notice_weeks}}).');
select public.business_rule_add_setting('hrms.offer_super_rate', 'Superannuation guarantee rate', 'HRMS', 'staff', 'employee', 'percentage', '12'::jsonb,
  '{"min":0,"max":100}'::jsonb, 'Super rate printed on staff offer letters ({{super_rate}}). Keep at or above the legal rate.');
select public.business_rule_add_setting('hrms.offer_annual_leave_weeks', 'Annual leave (weeks per year, full time)', 'HRMS', 'staff', 'employee', 'weeks', '4'::jsonb,
  '{"min":0,"max":52}'::jsonb, 'Printed on staff offer letters ({{annual_leave_weeks}}).');
select public.business_rule_add_setting('hrms.offer_personal_leave_days', 'Personal/carer''s leave (days per year, full time)', 'HRMS', 'staff', 'employee', 'days', '10'::jsonb,
  '{"min":0,"max":365}'::jsonb, 'Printed on staff offer letters ({{personal_leave_days}}).');
select public.business_rule_add_setting('hrms.offer_default_award', 'Default award for offer letters', 'HRMS', 'staff', 'employee', 'text',
  '"Educational Services (Post-Secondary Education) Award 2020"'::jsonb,
  '{}'::jsonb, 'Printed as {{award}} when the employee''s pay details name no award.');
select public.business_rule_add_setting('hrms.offer_long_service_leave_law', 'Long service leave law', 'HRMS', 'staff', 'employee', 'text',
  '"Long Service Leave Act 2018 (Vic)"'::jsonb, '{}'::jsonb, 'Printed on staff offer letters ({{long_service_leave_law}}).');

-- 2. The values a template can use (raw; formatted by templateValues in _shared/hr-template.ts).
create or replace function hr.template_values(p_profile uuid)
 returns jsonb language sql stable security definer set search_path to 'hr', 'public', 'pg_temp'
as $function$
 select jsonb_build_object('firstName', p.first_name, 'lastName', p.last_name, 'fullName', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email,
  'position', e.job_title, 'department', e.department, 'employmentType', e.employment_type, 'startDate', e.joining_date,
  'payRate', ep.rate, 'payBasis', ep.pay_basis, 'paySchedule', (select s.name from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'payType', (select s.frequency from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'hoursPerWeek', case when e.profile_id is not null then hr.employee_ordinary_hours_week(p.id) end,
  'managerName', (select hr.staff_name(m) from hr.staff_profiles m where m.id = e.manager_id), 'workLocation', e.work_location,
  'companyName', coalesce(nullif(btrim(c.name), ''), 'Skyline Institute of Technology'),
  'today', (now() at time zone coalesce((select s.timezone from hr.settings s limit 1), 'Australia/Melbourne'))::date)
  || jsonb_build_object(
  'employeeAddress', nullif(concat_ws(', ', nullif(btrim(p.address_street), ''), nullif(btrim(p.address_line2), ''),
     nullif(btrim(concat_ws(' ', nullif(btrim(p.address_suburb), ''), nullif(btrim(p.address_state), ''), nullif(btrim(p.address_postcode), ''))), '')), ''),
  'workLocationAddress', (select nullif(btrim(l.address), '') from public.locations l where l.id = e.location_id),
  'award', coalesce(nullif(btrim(ep.award), ''), nullif(btrim(public.rule_text('hrms.offer_default_award', '')), '')),
  'probationMonths', public.rule_num('hrms.offer_probation_months', 6),
  'noticeWeeks', public.rule_num('hrms.offer_employee_notice_weeks', 4),
  'superRate', public.rule_num('hrms.offer_super_rate', 12),
  'annualLeaveWeeks', public.rule_num('hrms.offer_annual_leave_weeks', 4),
  'personalLeaveDays', public.rule_num('hrms.offer_personal_leave_days', 10),
  'longServiceLeaveLaw', nullif(btrim(public.rule_text('hrms.offer_long_service_leave_law', '')), ''),
  'signatoryName', coalesce(nullif(btrim(public.rule_text('hrms.offer_signatory_name', '')), ''),
     (select nullif(btrim(u.name), '') from public.cms_users u where u.auth_user_id = auth.uid() limit 1)),
  'signatoryTitle', nullif(btrim(public.rule_text('hrms.offer_signatory_title', '')), ''),
  'companyLegalName', nullif(btrim(c.legal_name), ''), 'companyAbn', nullif(btrim(c.abn), ''), 'companyRto', nullif(btrim(c.rto), ''),
  'companyCricos', nullif(btrim(c.cricos), ''), 'companyAddress', nullif(btrim(c.address), ''), 'companyPhone', nullif(btrim(c.phone), ''),
  'companyEmail', nullif(btrim(c.email), ''), 'companyWebsite', nullif(btrim(c.website), ''),
  'companyState', (select nullif(btrim(s.state), '') from hr.settings s limit 1))
 from hr.staff_profiles p left join hr.employment e on e.profile_id = p.id left join hr.employee_pay ep on ep.profile_id = p.id
  left join lateral (select * from public.cms_settings limit 1) c on true
 where p.id = p_profile;
$function$;

-- 3. The placeholders a template may contain (same list as PLACEHOLDERS in _shared/hr-template.ts).
create or replace function hr.template_placeholders(p_type text)
 returns text[] language sql immutable parallel safe set search_path to 'pg_catalog', 'pg_temp'
as $function$
 select array['first_name','last_name','full_name','email','position','department','employment_type','start_date','pay_rate','pay_basis',
  'pay_schedule','hours_per_week','manager_name','work_location','company_name','today','login_url',
  'employee_full_name','employee_email','job_title','job_location','job_type','pay_type','today_date',
  'employee_address','work_location_address','award','probation_months','notice_weeks','super_rate','annual_leave_weeks',
  'personal_leave_days','long_service_leave_law','signatory_name','signatory_title','company_legal_name','company_abn','company_rto',
  'company_cricos','company_address','company_phone','company_email','company_website','company_state',
  'hours_clause','leave_clause','probation_period','probation_clause','notice_clause']
  || case when p_type in ('offer_email', 'welcome_login') then array['signing_link', 'link_expiry'] else array[]::text[] end
  || case when p_type in ('document_request', 'document_reupload') then array['document_link', 'link_expiry'] else array[]::text[] end
  || case when p_type = 'document_reupload' then array['rejected_documents'] else array[]::text[] end;
$function$;

-- 4. The staff offer letter: placeholders only.
update hr.sign_templates set title = 'Letter of Offer of Employment', subject = 'Letter of Offer of Employment', body_html = $tpl$<p><strong>PRIVATE AND CONFIDENTIAL</strong></p>
<p>{{today}}</p>
<p>{{full_name}}<br>{{email}}</p>
<p>{{employee_address}}</p>
<p>Dear {{first_name}},</p>
<p>On behalf of {{company_legal_name}}, ABN {{company_abn}} (<strong>{{company_name}}</strong>, <strong>we</strong>, <strong>us</strong>), I am pleased to offer you employment as <strong>{{position}}</strong> on a <strong>{{employment_type}}</strong> basis, on the terms set out in this letter.</p>

<h3>1. Key details</h3>
<ul>
<li><strong>Position:</strong> {{position}}</li>
<li><strong>Department:</strong> {{department}}</li>
<li><strong>Employment type:</strong> {{employment_type}}</li>
<li><strong>Reports to:</strong> {{manager_name}}</li>
<li><strong>Work location:</strong> {{work_location}}</li>
<li><strong>Work address:</strong> {{work_location_address}}</li>
<li><strong>Start date:</strong> {{start_date}}</li>
<li><strong>Ordinary hours:</strong> {{hours_per_week}} hours per week</li>
<li><strong>Pay:</strong> {{pay_rate}} {{pay_basis}} (gross), plus superannuation</li>
<li><strong>Pay cycle:</strong> {{pay_schedule}}, paid in arrears by direct deposit</li>
<li><strong>Award:</strong> {{award}}</li>
<li><strong>Probation:</strong> {{probation_period}}</li>
</ul>

<h3>2. Your role</h3>
<p>Your duties are set out in the position description for {{position}}, provided with this letter. We may reasonably change your duties from time to time to meet the needs of {{company_name}}, in line with your skills, experience and classification.</p>
<p>If your role includes training or assessment, you must hold and maintain the training and assessment credentials, vocational competencies and current industry skills required by the Standards for Registered Training Organisations for every unit you deliver, give us evidence of them on request, and tell us straight away if any of them lapse.</p>

<h3>3. Hours of work</h3>
<p>{{hours_clause}}</p>

<h3>4. Pay</h3>
<p>You will be paid {{pay_rate}} {{pay_basis}} (gross), {{pay_schedule}} in arrears. Your pay will never be less than the minimum required for your classification under the {{award}} and the NES. Where the Award requires overtime, penalty rates or allowances that your pay does not already cover, they will be paid. Pay is reviewed once a year; a review does not guarantee an increase.</p>

<h3>5. Superannuation</h3>
<p>In addition to your pay, we will contribute superannuation guarantee of {{super_rate}}% of your qualifying earnings (or the higher rate the law requires), paid with each pay cycle. You may choose your own complying fund using the Superannuation Standard Choice Form; if you do not, we will request your stapled fund from the ATO or pay into our default fund.</p>

<h3>6. Leave</h3>
<p>{{leave_clause}}</p>
<p>You are also entitled to compassionate leave, paid family and domestic violence leave, parental leave, community service leave and public holidays as provided by the NES and the {{award}}, and long service leave under the {{long_service_leave_law}}.</p>

<h3>7. Probation and ending employment</h3>
<p>{{probation_clause}}</p>
<p>{{notice_clause}}</p>

<h3>8. Conditions of this offer</h3>
<p>This offer depends on you providing the following to our reasonable satisfaction before you start, and keeping them current while employed:</p>
<ul>
<li>proof of identity and of your right to work in Australia;</li>
<li>a satisfactory National Police Check;</li>
<li>a valid {{company_state}} Working with Children Check (employee), where your role involves students under 18;</li>
<li>certified copies of your qualifications, including your training and assessment credentials if you train or assess;</li>
<li>satisfactory reference checks; and</li>
<li>the documents requested in your onboarding portal (tax file number declaration, bank and superannuation details).</li>
</ul>

<h3>9. Policies, confidentiality and intellectual property</h3>
<p>You must follow {{company_name}}'s policies and procedures as updated from time to time, including those on work health and safety, privacy, student welfare, IT use and the code of conduct, and you must support {{company_name}}'s compliance with the Standards for RTOs and, where it applies, the ESOS framework. Our policies do not form part of your contract.</p>
<p>You must keep {{company_name}}'s confidential information (including student records, learning and assessment resources, fees and business information) confidential during and after your employment. Material you create in the course of your employment, including training and assessment resources, belongs to {{company_name}}.</p>

<h3>10. Entire agreement</h3>
<p>This letter and your position description set out the terms of your employment and replace any earlier discussions. Where the NES or the {{award}} gives you a better entitlement than this letter, the better entitlement applies.</p>

<h3>11. Documents provided with this offer</h3>
<ul>
<li>Position description: {{position}}</li>
<li>Fair Work Information Statement</li>
<li>Superannuation Standard Choice Form</li>
<li>Tax File Number Declaration</li>
</ul>

<h3>12. Acceptance</h3>
<p>To accept this offer, please read the letter and sign it electronically in the {{company_name}} staff portal before the signing link expires. By signing, you confirm that you accept employment as {{position}} on a {{employment_type}} basis on these terms and that you have received the Fair Work Information Statement. If you have any questions, please contact us at {{company_email}} or {{company_phone}}.</p>
<p>We look forward to welcoming you to the team.</p>
<p>Yours sincerely,</p>
<p><strong>{{signatory_name}}</strong><br>{{signatory_title}}<br>For and on behalf of {{company_legal_name}}</p>
<p>{{company_address}}</p>
<p>{{company_website}}</p>
<p>RTO code: {{company_rto}}</p>
<p>CRICOS provider code: {{company_cricos}}</p>
$tpl$, version = version + 1, updated_at = now()
 where category = 'offer_letter' and name = 'SLIT Staff Offer Letter' and deleted_at is null;
update hr.sign_templates set body = hr.html_to_text(body_html)
 where category = 'offer_letter' and name = 'SLIT Staff Offer Letter' and deleted_at is null;
select hr.sign_template_version(t.id, t.created_by) from hr.sign_templates t
 where t.category = 'offer_letter' and t.name = 'SLIT Staff Offer Letter' and t.deleted_at is null;

commit;
