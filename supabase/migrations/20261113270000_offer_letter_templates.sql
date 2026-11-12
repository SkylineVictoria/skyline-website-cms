-- Offer letter (LOO) templates (owner brief 2026-11-12). LOCAL ONLY until the owner releases it.
--
--  * template-assets: a public Storage bucket for pictures in templates (logos, signatures), one folder per organisation
--    (default/ for the main site, <tenant id>/ for a tenant). Uploaded by CMS admins; never updated or deleted, so a letter issued
--    with an old version still prints its pictures. hr.rich_html_problem accepts these URLs (and still refuses any other linked picture).
--  * letter_variables: the one registry of {{group.key}} variables (key -> label -> source -> format), read by the editor's picker,
--    the save checks, the issue drawer and portal_offer_letter_issue_template.
--  * course_fee_setups: the fees of a course (all intakes) or of one intake: tuition, enrolment, material, OSHC, deposit, payment
--    plan, campus. cms_settings gains abn, website, offer_validity_days and letter_date_format.
--  * application_letter_values: every variable of an application, formatted, with its source and whether it is missing.
--  * portal_letter_save_to_source: staff fill a missing detail and save it where it belongs (only for variables marked editable).
--  * Student offer letter templates (category student_offer_letter, hr.sign_templates with versions): a template with unmapped
--    tokens ({{unknown}}, $[field], {field:inline}, an old [Variable]) is saved inactive and cannot be made active.
--  * portal_offer_letter_issue_template: the letter made from a template; required variables must be filled (from the record or
--    by hand), optional ones left blank only when ticked; template name / version, the values and the manual fills are kept on the
--    letter, and the manual fills are written in the status history.

/* ------------------------------------------------------------------ pictures in templates */
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('template-assets', 'template-assets', true, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

/** May the caller add this picture? default/<uuid>.png for the main site's CMS admins; <tenant>/<uuid>.png for a tenant's admins and editors. */
create function public.template_asset_access(p_name text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_folder text;
begin
 if p_name !~ '^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$' then return false; end if;
 v_folder := split_part(p_name, '/', 1);
 if v_folder = 'default' then return public.cms_is_admin() and public.tenant_scope(null); end if;
 return public.tenant_scope(v_folder::uuid) and public.tenant_has_role(v_folder::uuid, array['tenant_admin', 'editor']);
end $$;
revoke all on function public.template_asset_access(text) from public, anon;
grant execute on function public.template_asset_access(text) to authenticated;

create policy template_assets_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'template-assets' and public.template_asset_access(name));
-- Reading goes through the public URL; nothing updates or deletes a picture (issued letters keep theirs).

/** The template HTML rules (TPL-02) with pictures from template-assets allowed next to embedded PNG / JPEG. */
create or replace function hr.rich_html_problem(p_html text) returns text language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
 select case
  when p_html is null then null
  when p_html ~* '<\s*/?\s*(script|style|iframe|frame|frameset|object|embed|form|input|button|textarea|select|link|meta|base|svg|math)\y' then 'The template contains content that is not allowed (scripts, frames, forms or embedded objects).'
  when p_html ~* '<[^>]*\son[a-z]+\s*=' then 'The template contains content that is not allowed (event handlers).'
  when p_html ~* '(javascript|vbscript)\s*:' then 'The template contains a link that is not allowed.'
  when p_html ~* '<\s*img\y[^>]*\ssrc\s*=(?![\s"'']*(data:image/(png|jpeg);base64,|https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/template-assets/|http://(127\.0\.0\.1|localhost):[0-9]{2,5}/storage/v1/object/public/template-assets/))'
   then 'Pictures must be uploaded into the template (PNG or JPEG), not linked from another site.'
 end;
$$;

/* ------------------------------------------------------------------ institute details and fees */
alter table public.cms_settings
 add column if not exists abn text,
 add column if not exists website text,
 add column if not exists offer_validity_days integer not null default 30,
 add column if not exists letter_date_format text not null default 'DD/MM/YYYY';
alter table public.cms_settings add constraint cms_settings_offer_validity_days_check check (offer_validity_days between 1 and 365);
alter table public.cms_settings add constraint cms_settings_letter_date_format_check check (letter_date_format in ('DD/MM/YYYY', 'D Month YYYY', 'DD Mon YYYY'));
alter table public.cms_settings add constraint cms_settings_abn_check check (abn is null or abn ~ '^[0-9 ]{9,14}$');
alter table public.cms_settings add constraint cms_settings_website_check check (website is null or website ~* '^https?://[^\s<>"]{3,200}$');

create table public.course_fee_setups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  course_id text not null references public.cms_courses(id) on delete cascade,
  -- null: the course's fees for every intake; set: the fees of that intake (each one set overrides the course's).
  intake_id uuid references public.course_intakes(id) on delete cascade,
  tuition_fee numeric(12, 2) check (tuition_fee >= 0),
  enrolment_fee numeric(12, 2) check (enrolment_fee >= 0),
  material_fee numeric(12, 2) check (material_fee >= 0),
  oshc_fee numeric(12, 2) check (oshc_fee >= 0),
  deposit numeric(12, 2) check (deposit >= 0),
  payment_plan text check (payment_plan is null or char_length(payment_plan) <= 2000),
  campus text check (campus is null or char_length(campus) <= 300),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique nulls not distinct (course_id, intake_id)
);
alter table public.course_fee_setups enable row level security;
revoke all on public.course_fee_setups from anon, authenticated;
comment on table public.course_fee_setups is 'Fees of a course (intake_id null: every intake) or of one intake; what offer letters print.';

/** CMS > Courses > Intakes: the fee setup of a course (all intakes and each intake). */
create function public.cms_course_fees(p_course text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'intakeId', f.intake_id, 'tuition', f.tuition_fee, 'enrolment', f.enrolment_fee, 'material', f.material_fee,
   'oshc', f.oshc_fee, 'deposit', f.deposit, 'paymentPlan', f.payment_plan, 'campus', f.campus, 'updatedAt', f.updated_at) order by f.intake_id nulls first)
   from public.course_fee_setups f where f.course_id = p_course), '[]'::jsonb);
end $$;
revoke all on function public.cms_course_fees(text) from public;
grant execute on function public.cms_course_fees(text) to authenticated;

create function public.cms_course_fee_save(p_course text, p_intake uuid, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cms_courses; f public.course_fee_setups;
 num constant text := '^\s*[0-9]{1,9}(\.[0-9]{1,2})?\s*$';
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 select * into c from public.cms_courses where id = p_course;
 if not found then raise exception 'Course not found' using errcode = '22023'; end if;
 if p_intake is not null and not exists (select 1 from public.course_intakes i where i.id = p_intake and i.course_id = p_course) then raise exception 'The intake is not one of this course''s' using errcode = '22023'; end if;
 if exists (select 1 from jsonb_each_text(coalesce(p_data, '{}'::jsonb) - 'paymentPlan' - 'campus') e where nullif(btrim(e.value), '') is not null and e.value !~ num) then
  raise exception 'Enter fees as amounts, for example 14500 or 14500.00' using errcode = '22023';
 end if;
 insert into public.course_fee_setups as x(tenant_id, course_id, intake_id, tuition_fee, enrolment_fee, material_fee, oshc_fee, deposit, payment_plan, campus, updated_by)
 values (c.tenant_id, p_course, p_intake, nullif(btrim(p_data->>'tuition'), '')::numeric, nullif(btrim(p_data->>'enrolment'), '')::numeric, nullif(btrim(p_data->>'material'), '')::numeric,
   nullif(btrim(p_data->>'oshc'), '')::numeric, nullif(btrim(p_data->>'deposit'), '')::numeric, nullif(btrim(p_data->>'paymentPlan'), ''), nullif(btrim(p_data->>'campus'), ''), auth.uid())
 on conflict (course_id, intake_id) do update set tuition_fee = excluded.tuition_fee, enrolment_fee = excluded.enrolment_fee, material_fee = excluded.material_fee,
   oshc_fee = excluded.oshc_fee, deposit = excluded.deposit, payment_plan = excluded.payment_plan, campus = excluded.campus, updated_at = now(), updated_by = auth.uid()
 returning * into f;
 return to_jsonb(f);
end $$;
revoke all on function public.cms_course_fee_save(text, uuid, jsonb) from public;
grant execute on function public.cms_course_fee_save(text, uuid, jsonb) to authenticated;

/* ------------------------------------------------------------------ the registry */
create table public.letter_variables (
  key text primary key check (key ~ '^[a-z]+\.[a-z_]+$'),
  grp text not null check (grp in ('Student', 'Course', 'Fees', 'Agent / Agency', 'Application', 'Institute', 'Page')),
  label text not null check (char_length(label) between 1 and 80),
  description text not null default '',
  -- application: an answer on the form (source_ref = its key); record: a column of the application; computed: made from several;
  -- course / intake / fee / agent / agency / institute: that setup; entered: typed when the letter is issued; render: filled per page.
  source_kind text not null check (source_kind in ('application', 'record', 'computed', 'course', 'intake', 'fee', 'agent', 'agency', 'institute', 'entered', 'render')),
  source_ref text not null default '',
  source_label text not null,
  format text not null default 'text' check (format in ('text', 'name', 'date', 'money', 'list', 'multiline')),
  input_type text not null default 'text' check (input_type in ('text', 'date', 'money', 'textarea', 'email', 'tel')),
  required boolean not null default false,
  editable_source boolean not null default false,
  aliases text[] not null default '{}',
  sample text not null default '',
  sort integer not null
);
alter table public.letter_variables enable row level security;
revoke all on public.letter_variables from anon, authenticated;
comment on table public.letter_variables is 'The {{group.key}} variables of offer letter templates: label, source, format, required, whether staff may save a value to the source, and the old names it replaces.';

insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort) values
 ('student.title', 'Student', 'Title', 'Mr, Ms, Mrs, Miss, Dr', 'application', 'title', 'Application form › Title', 'name', 'text', false, true, '{title,salutation}', 'Ms', 10),
 ('student.given_name', 'Student', 'Given name', 'First name, Title Case', 'application', 'first_name', 'Application form › Given name', 'name', 'text', true, true, '{first name,firstname,given name,student first name,givenname}', 'Asha', 20),
 ('student.middle_name', 'Student', 'Middle name', 'Middle name(s), Title Case; empty when there is none', 'application', 'middle_name', 'Application form › Middle name', 'name', 'text', false, true, '{middle name,middlename,student middle name}', 'Rani', 30),
 ('student.family_name', 'Student', 'Family name', 'Surname, Title Case', 'application', 'last_name', 'Application form › Family name', 'name', 'text', true, true, '{last name,lastname,surname,family name,student last name,student surname}', 'Patel', 40),
 ('student.full_name', 'Student', 'Full name', 'Title, given, middle and family name (the empty parts left out)', 'computed', 'title,first_name,middle_name,last_name', 'Application form › Title + given + middle + family name', 'name', 'text', true, false,
  '{student name,studentname,full name,fullname,name,student full name}', 'Ms Asha Rani Patel', 50),
 ('student.dob', 'Student', 'Date of birth', 'Formatted with the institute''s date format', 'application', 'dob', 'Application form › Date of birth', 'date', 'date', true, true, '{dob,date of birth,birth date,birthdate,student dob}', '12/04/2001', 60),
 ('student.gender', 'Student', 'Gender', '', 'application', 'gender', 'Application form › Gender', 'text', 'text', false, true, '{gender,sex}', 'Female', 70),
 ('student.email', 'Student', 'Email', '', 'application', 'email', 'Application form › Email', 'text', 'email', false, false, '{email,student email,email address}', 'asha.patel@example.com', 80),
 ('student.mobile', 'Student', 'Mobile', '', 'application', 'mobile', 'Application form › Mobile', 'text', 'tel', false, true, '{mobile,phone,student phone,mobile number,telephone}', '+61 412 345 678', 90),
 ('student.nationality', 'Student', 'Nationality', 'Nationality (citizenship when it is empty)', 'application', 'nationality', 'Application form › Nationality', 'text', 'text', true, true, '{nationality,citizenship,country of citizenship}', 'India', 100),
 ('student.country_of_birth', 'Student', 'Country of birth', '', 'application', 'birth_country', 'Application form › Country of birth', 'text', 'text', false, true, '{country of birth,birth country}', 'India', 110),
 ('student.passport_number', 'Student', 'Passport number', '', 'application', 'passport_number', 'Application form › Passport number', 'text', 'text', true, true, '{passport,passport number,passport no,passportnumber}', 'N1234567', 120),
 ('student.passport_expiry', 'Student', 'Passport expiry', '', 'application', 'passport_expiry', 'Application form › Passport expiry', 'date', 'date', false, true, '{passport expiry,passport expiry date}', '30/06/2031', 130),
 ('student.address', 'Student', 'Address', 'Street, line 2, suburb, state and postcode (the empty parts left out)', 'computed', 'au_street,au_line2,au_suburb,au_state,au_zip', 'Application form › Address', 'text', 'textarea', false, false,
  '{address,student address,home address,residential address}', '1 Example Street, Melbourne VIC 3000', 140),
 ('student.usi', 'Student', 'USI', 'Unique Student Identifier', 'application', 'usi_number', 'Application form › USI', 'text', 'text', false, true, '{usi,usi number}', 'ABC234DEF5', 150),
 ('student.initial_line', 'Student', 'Initials line', 'A line for the student''s initials, printed on every page it is in (put it in the footer)', 'render', 'initials', 'Printed on every page', 'text', 'text', false, false,
  '{student initial,student initials,initials}', 'Student initials: ________', 160),
 ('course.name', 'Course', 'Course name', 'From the course setup', 'course', 'name', 'Course setup › Name', 'text', 'text', true, false, '{course,course name,coursename,program,programme}', 'Diploma of Business', 200),
 ('course.code', 'Course', 'Course code', 'National course code', 'course', 'code', 'Course setup › Code', 'text', 'text', true, false, '{course code,coursecode,national code}', 'BSB50120', 210),
 ('course.cricos', 'Course', 'CRICOS course code', '', 'course', 'cricos', 'Course setup › CRICOS code', 'text', 'text', true, true, '{cricos code,cricos course code,cricos}', '0101234', 220),
 ('course.duration', 'Course', 'Duration', '', 'course', 'duration', 'Course setup › Duration', 'text', 'text', false, true, '{duration,course duration}', '52 weeks', 230),
 ('course.mode', 'Course', 'Delivery mode', '', 'course', 'mode', 'Course setup › Mode', 'text', 'text', false, true, '{mode,delivery mode,study mode}', 'Face to face', 240),
 ('course.intake', 'Course', 'Intake', 'The intake chosen on the application', 'intake', 'label', 'Course setup › Intakes (the one chosen on the application)', 'text', 'text', true, false, '{intake,course intake}', 'February 2027', 250),
 ('course.start_date', 'Course', 'Start date', 'Start date of the chosen intake', 'intake', 'start_date', 'Course setup › Intakes › Start date', 'date', 'date', true, false, '{start date,course start date,commencement date}', '03/02/2027', 260),
 ('course.end_date', 'Course', 'End date', 'End date of the chosen intake', 'intake', 'end_date', 'Course setup › Intakes › End date', 'date', 'date', false, false, '{end date,course end date,completion date}', '02/02/2028', 270),
 ('course.campus', 'Course', 'Campus', 'From the fee setup', 'fee', 'campus', 'Course setup › Fees › Campus', 'text', 'text', false, true, '{campus,location,study location}', 'Melbourne CBD', 280),
 ('fees.tuition', 'Fees', 'Tuition fee', '', 'fee', 'tuition_fee', 'Course setup › Fees › Tuition', 'money', 'money', true, true, '{tuition,tuition fee,tuition fees,course fees,course fee}', 'AUD$14,000.00', 300),
 ('fees.enrolment', 'Fees', 'Enrolment fee', '', 'fee', 'enrolment_fee', 'Course setup › Fees › Enrolment', 'money', 'money', false, true, '{enrolment fee,enrollment fee,application fee}', 'AUD$250.00', 310),
 ('fees.material', 'Fees', 'Material fee', '', 'fee', 'material_fee', 'Course setup › Fees › Material', 'money', 'money', false, true, '{material fee,materials fee,material fees}', 'AUD$500.00', 320),
 ('fees.oshc', 'Fees', 'OSHC', 'Overseas Student Health Cover', 'fee', 'oshc_fee', 'Course setup › Fees › OSHC', 'money', 'money', false, true, '{oshc,oshc fee,health cover}', 'AUD$650.00', 330),
 ('fees.total', 'Fees', 'Total fees', 'Tuition + enrolment + material + OSHC', 'computed', 'tuition_fee,enrolment_fee,material_fee,oshc_fee', 'Course setup › Fees (sum)', 'money', 'money', true, false, '{total,total fee,total fees,total cost}', 'AUD$15,400.00', 340),
 ('fees.deposit', 'Fees', 'Initial deposit', '', 'fee', 'deposit', 'Course setup › Fees › Deposit', 'money', 'money', false, true, '{deposit,initial deposit,initial payment}', 'AUD$3,500.00', 350),
 ('fees.payment_plan', 'Fees', 'Payment plan', '', 'fee', 'payment_plan', 'Course setup › Fees › Payment plan', 'multiline', 'textarea', false, true, '{payment plan,payment schedule,instalments}', '4 instalments of AUD$2,875.00', 360),
 ('agent.name', 'Agent / Agency', 'Agent name', 'The assigned agent (or the agent who started the application)', 'agent', 'full_name', 'Agent profile › Name', 'name', 'text', false, false, '{agent,agent name}', 'Ravi Kumar', 400),
 ('agent.email', 'Agent / Agency', 'Agent email', '', 'agent', 'email', 'Agent profile › Email', 'text', 'email', false, false, '{agent email}', 'ravi@example.com', 410),
 ('agent.phone', 'Agent / Agency', 'Agent phone', '', 'agent', 'phone', 'Agent profile › Phone', 'text', 'tel', false, false, '{agent phone}', '+61 400 000 000', 420),
 ('agency.name', 'Agent / Agency', 'Agency name', '', 'agency', 'name', 'Agency › Name', 'text', 'text', false, false, '{agency,agency name}', 'Example Education Services', 430),
 ('agency.email', 'Agent / Agency', 'Agency email', '', 'agency', 'business_email', 'Agency › Business email', 'text', 'email', false, false, '{agency email}', 'office@example.com', 440),
 ('agency.phone', 'Agent / Agency', 'Agency phone', '', 'agency', 'phone', 'Agency › Phone', 'text', 'tel', false, false, '{agency phone}', '+61 3 9000 0000', 450),
 ('agency.address', 'Agent / Agency', 'Agency address', '', 'agency', 'address', 'Agency › Address', 'text', 'text', false, false, '{agency address}', '10 Example Road, Sydney NSW 2000', 460),
 ('application.reference', 'Application', 'Application reference', '', 'record', 'reference', 'Application › Reference', 'text', 'text', true, false, '{reference,application reference,student id,application id,ref}', 'SLIT-2026-0080', 500),
 ('application.submitted_date', 'Application', 'Date submitted', '', 'record', 'submitted_at', 'Application › Submitted', 'date', 'date', false, false, '{submitted date,application date,date submitted}', '05/11/2026', 510),
 ('offer.date', 'Application', 'Offer date', 'The day the letter is issued', 'computed', 'today', 'Today (Melbourne)', 'date', 'date', true, false, '{date,offer date,letter date,today,current date}', '12/11/2026', 520),
 ('offer.expiry_date', 'Application', 'Offer valid until', 'Offer date + the institute''s offer validity (days)', 'computed', 'offer_validity_days', 'Today + Settings › Offer validity', 'date', 'date', false, false, '{expiry date,offer expiry,valid until,offer valid until}', '12/12/2026', 530),
 ('offer.conditions', 'Application', 'Offer conditions', 'Typed when the letter is issued, one per line; "Nil" when there are none', 'entered', 'conditions', 'Entered when issuing', 'list', 'textarea', false, false, '{conditions,offer conditions,conditions of offer}', 'Nil', 540),
 ('institute.name', 'Institute', 'Institute name', '', 'institute', 'name', 'Settings › Institute name', 'text', 'text', true, true, '{institute,institute name,college name,provider name}', 'Skyline Institute of Technology', 600),
 ('institute.short_name', 'Institute', 'Short name', '', 'institute', 'short_name', 'Settings › Short name', 'text', 'text', false, true, '{short name,institute short name}', 'SLIT', 610),
 ('institute.address', 'Institute', 'Address', '', 'institute', 'address', 'Settings › Address', 'text', 'text', false, true, '{institute address,office address,campus address}', 'Level 1, 123 Example Street, Melbourne VIC 3000', 620),
 ('institute.phone', 'Institute', 'Phone', '', 'institute', 'phone', 'Settings › Phone', 'text', 'tel', false, true, '{institute phone,office phone}', '+61 3 9000 0000', 630),
 ('institute.email', 'Institute', 'Email', '', 'institute', 'email', 'Settings › Email', 'text', 'email', false, true, '{institute email,office email}', 'info@example.edu.au', 640),
 ('institute.admissions_email', 'Institute', 'Admissions email', '', 'institute', 'admissions_email', 'Settings › Admissions email', 'text', 'email', false, true, '{admissions email}', 'admissions@example.edu.au', 650),
 ('institute.rto', 'Institute', 'RTO code', '', 'institute', 'rto', 'Settings › RTO', 'text', 'text', false, true, '{rto,rto code,rto number}', '45678', 660),
 ('institute.cricos', 'Institute', 'CRICOS provider code', '', 'institute', 'cricos', 'Settings › CRICOS', 'text', 'text', false, true, '{cricos provider,cricos provider code,provider code}', '04321K', 670),
 ('institute.abn', 'Institute', 'ABN', '', 'institute', 'abn', 'Settings › ABN', 'text', 'text', false, true, '{abn}', '12 345 678 901', 680),
 ('institute.website', 'Institute', 'Website', '', 'institute', 'website', 'Settings › Website', 'text', 'text', false, true, '{website,web,url}', 'https://example.edu.au', 690),
 ('page.number', 'Page', 'Page number', 'The number of the page it is printed on', 'render', 'page', 'Filled per page', 'text', 'text', false, false, '{page number,page,pageno,page no}', '1', 700),
 ('page.total', 'Page', 'Total pages', 'How many pages the letter has', 'render', 'total', 'Filled per page', 'text', 'text', false, false, '{total pages,page count,pages,number of pages}', '3', 710);

/** The registry, for the editor and the issue drawer (CMS staff). */
create function public.letter_variable_registry() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', v.key, 'group', v.grp, 'label', v.label, 'description', v.description, 'sourceKind', v.source_kind, 'source', v.source_label,
    'format', v.format, 'inputType', v.input_type, 'required', v.required, 'editableSource', v.editable_source, 'aliases', to_jsonb(v.aliases), 'sample', v.sample) order by v.sort), '[]'::jsonb)
  from public.letter_variables v where public.cms_is_admin() or public.portal_is_slit_admin();
$$;
revoke all on function public.letter_variable_registry() from public, anon;
grant execute on function public.letter_variable_registry() to authenticated;

/* ------------------------------------------------------------------ formatting */
/** Letters and digits only, lower case: how an old placeholder name is compared with the aliases ("Student Name" = "studentName"). */
create function public.letter_norm(p text) returns text language sql immutable parallel safe set search_path = pg_catalog as $$
  select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', '', 'g'));
$$;

create function public.letter_format_date(p_value text, p_format text) returns text language plpgsql immutable set search_path = pg_catalog as $$
declare d date;
begin
 if nullif(btrim(coalesce(p_value, '')), '') is null then return ''; end if;
 if btrim(p_value) ~ '^\d{4}-\d{2}-\d{2}' then d := left(btrim(p_value), 10)::date;
 elsif btrim(p_value) ~ '^\d{1,2}/\d{1,2}/\d{4}$' then d := to_date(btrim(p_value), 'DD/MM/YYYY');
 else return btrim(p_value); end if;
 return case p_format when 'D Month YYYY' then to_char(d, 'FMDD FMMonth YYYY') when 'DD Mon YYYY' then to_char(d, 'DD Mon YYYY') else to_char(d, 'DD/MM/YYYY') end;
exception when others then return btrim(p_value);
end $$;

create function public.letter_format_money(p numeric) returns text language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when p is null then '' else 'AUD$' || to_char(p, 'FM999,999,999,990.00') end;
$$;

/** Title Case for names typed in any case ("ASHA o'neil-smith" -> "Asha O'Neil-Smith"), spaces tidied. */
create function public.letter_format_name(p text) returns text language sql immutable parallel safe set search_path = pg_catalog as $$
  select array_to_string(array(select initcap(part) from unnest(string_to_array(lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))), '''')) with ordinality as t(part, n) order by n), '''');
$$;

/* ------------------------------------------------------------------ the values of one application */
/**
 * Every registry variable for an application: { key: { value, raw, source, missing } } plus the context (course, intake, fee setup).
 * value is formatted (dates with the institute's format, names in Title Case, money as AUD$1,234.00); raw is what the source holds.
 * Course, intake and fees come from the course chosen on the application and its setup, never from free text, except the intake label
 * when no intake was chosen (then the form's preferred intake, and the start date stays missing).
 */
create function public.application_letter_values(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; v jsonb; st public.cms_settings; ac public.enrollment_application_courses; c public.cms_courses; i public.course_intakes;
 fc public.course_fee_setups; fi public.course_fee_setups; ag public.portal_profiles; agy public.agencies; fmt text; today date := (now() at time zone 'Australia/Melbourne')::date;
 v_out jsonb := '{}'::jsonb; r public.letter_variables; raw text; val text; src text; fee_src text; n numeric; tuition numeric; enrol numeric; mat numeric; oshc numeric;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v := coalesce(public.application_values(a.id), '{}'::jsonb);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 fmt := coalesce(st.letter_date_format, 'DD/MM/YYYY');
 select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
 if found then
  select * into c from public.cms_courses x where x.id = ac.course_id;
  select * into i from public.course_intakes x where x.id = ac.intake_id;
  select * into fc from public.course_fee_setups x where x.course_id = ac.course_id and x.intake_id is null;
  if ac.intake_id is not null then select * into fi from public.course_fee_setups x where x.course_id = ac.course_id and x.intake_id = ac.intake_id; end if;
 end if;
 select * into ag from public.portal_profiles x where x.id = a.assigned_agent_id;
 if not found and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin')) then
  select * into ag from public.portal_profiles x where x.id = a.created_by;
 end if;
 select * into agy from public.agencies x where x.id = a.agency_id and not coalesce(x.is_direct, false);
 fee_src := case when fi.id is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;

 for r in select * from public.letter_variables order by sort loop
  raw := ''; val := ''; src := r.source_label;
  case r.source_kind
   when 'application' then
    raw := btrim(coalesce(case when jsonb_typeof(v -> r.source_ref) = 'array' then (select string_agg(x, ', ') from jsonb_array_elements_text(v -> r.source_ref) x) else v ->> r.source_ref end, ''));
    if r.key = 'student.email' and raw = '' then raw := lower(btrim(coalesce(a.student_email, ''))); src := 'Application › Student email'; end if;
    if r.key = 'student.nationality' and raw = '' then raw := btrim(coalesce(v ->> 'citizenship', '')); src := 'Application form › Citizenship'; end if;
   when 'record' then
    raw := case r.source_ref when 'reference' then coalesce(a.reference, '') when 'submitted_at' then coalesce(to_char(a.submitted_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD'), '') else '' end;
   when 'computed' then
    if r.key = 'student.full_name' then
     raw := btrim(regexp_replace(concat_ws(' ', nullif(public.letter_format_name(v ->> 'title'), ''), nullif(public.letter_format_name(v ->> 'first_name'), ''), nullif(public.letter_format_name(v ->> 'middle_name'), ''),
       nullif(public.letter_format_name(v ->> 'last_name'), '')), '\s+', ' ', 'g'));
     if coalesce(nullif(btrim(v ->> 'first_name'), ''), nullif(btrim(v ->> 'last_name'), '')) is null then raw := ''; end if;
    elsif r.key = 'student.address' then
     raw := concat_ws(', ', nullif(btrim(v ->> 'au_street'), ''), nullif(btrim(v ->> 'au_line2'), ''),
       nullif(btrim(concat_ws(' ', nullif(btrim(v ->> 'au_suburb'), ''), nullif(btrim(v ->> 'au_state'), ''), nullif(btrim(v ->> 'au_zip'), ''))), ''));
    elsif r.key = 'fees.total' then
     tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
     raw := case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end;
     src := 'Course setup › Fees (sum, ' || fee_src || ')';
    elsif r.key = 'offer.date' then raw := today::text;
    elsif r.key = 'offer.expiry_date' then raw := (today + coalesce(st.offer_validity_days, 30))::text; src := 'Today + ' || coalesce(st.offer_validity_days, 30) || ' days (Settings › Offer validity)';
    end if;
   when 'course' then raw := coalesce(btrim(case r.source_ref when 'name' then coalesce(nullif(c.name, ''), ac.course_title) when 'code' then coalesce(nullif(c.code, ''), ac.course_code)
     when 'cricos' then c.cricos when 'duration' then c.duration when 'mode' then c.mode end), '');
   when 'intake' then
    raw := coalesce(case r.source_ref when 'label' then coalesce(nullif(btrim(i.label), ''), to_char(i.start_date, 'FMMonth YYYY')) when 'start_date' then i.start_date::text when 'end_date' then i.end_date::text end, '');
    if r.key = 'course.intake' and raw = '' then raw := coalesce(nullif(btrim(a.intake), ''), btrim(coalesce(v ->> 'preferred_intake', ''))); src := 'Application form › Preferred intake (no intake chosen)'; end if;
   when 'fee' then
    raw := coalesce(case r.source_ref when 'tuition_fee' then coalesce(fi.tuition_fee, fc.tuition_fee)::text when 'enrolment_fee' then coalesce(fi.enrolment_fee, fc.enrolment_fee)::text
      when 'material_fee' then coalesce(fi.material_fee, fc.material_fee)::text when 'oshc_fee' then coalesce(fi.oshc_fee, fc.oshc_fee)::text when 'deposit' then coalesce(fi.deposit, fc.deposit)::text
      when 'payment_plan' then coalesce(fi.payment_plan, fc.payment_plan) when 'campus' then coalesce(fi.campus, fc.campus) end, '');
    src := r.source_label || ' (' || fee_src || ')';
   when 'agent' then raw := coalesce(btrim(case r.source_ref when 'full_name' then ag.full_name when 'email' then ag.email when 'phone' then ag.phone end), '');
   when 'agency' then raw := coalesce(btrim(case r.source_ref when 'name' then agy.name when 'business_email' then agy.business_email when 'phone' then agy.phone when 'address' then agy.address end), '');
   when 'institute' then raw := coalesce(btrim(to_jsonb(st) ->> r.source_ref), '');
   when 'entered' then raw := 'Nil';
   else raw := '';
  end case;
  val := case r.format
   when 'date' then public.letter_format_date(raw, fmt)
   when 'name' then case when r.key = 'student.full_name' then raw else public.letter_format_name(raw) end
   when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end
   else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src,
    'missing', r.source_kind not in ('render', 'entered') and coalesce(btrim(val), '') = ''));
 end loop;
 return jsonb_build_object('values', v_out, 'context', jsonb_build_object('courseId', ac.course_id, 'intakeId', ac.intake_id, 'feeSetup', coalesce(fi.id, fc.id),
   'courseTitle', coalesce(nullif(c.name, ''), ac.course_title), 'dateFormat', fmt));
end $$;
revoke all on function public.application_letter_values(uuid) from public, anon, authenticated;

/** The issue drawer's values (staff reviewers of the application). */
create function public.portal_letter_values(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.portal_is_slit_admin() or not public.portal_can_access_application(p_application) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 return public.application_letter_values(p_application);
end $$;
revoke all on function public.portal_letter_values(uuid) from public;
grant execute on function public.portal_letter_values(uuid) to authenticated;

/** "Test with application" in the template editor: recent applications to try a template on (CMS admins). */
create function public.letter_test_applications(p_search text default '') returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(x order by x->>'updatedAt' desc) from (
   select jsonb_build_object('id', a.id, 'reference', a.reference, 'studentName', a.student_name, 'status', a.status, 'updatedAt', a.updated_at) x
   from public.enrollment_applications a
   where a.status <> 'draft'
     and (coalesce(btrim(p_search), '') = '' or a.reference ilike '%' || btrim(p_search) || '%' or a.student_name ilike '%' || btrim(p_search) || '%')
     and public.portal_can_access_application(a.id)
   order by a.updated_at desc limit 20) s), '[]'::jsonb);
end $$;
revoke all on function public.letter_test_applications(text) from public;
grant execute on function public.letter_test_applications(text) to authenticated;

/** "Test with application": the values of any application the admin can see. */
create function public.letter_test_values(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() or not public.portal_can_access_application(p_application) then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return public.application_letter_values(p_application);
end $$;
revoke all on function public.letter_test_values(uuid) from public;
grant execute on function public.letter_test_values(uuid) to authenticated;

/* ------------------------------------------------------------------ save a detail to its source */
/**
 * "Fill and save to source": the value is written where the variable comes from (the application's answer, the course, the fee setup
 * or the institute settings), only for variables marked editable_source, and recorded in the audit log. Answers need the reviewer's
 * access to the application; course, fee and institute details need a CMS admin. Returns the application's values again.
 */
create function public.portal_letter_save_to_source(p_application uuid, p_key text, p_value text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.letter_variables; a public.enrollment_applications; ac public.enrollment_application_courses; v text := btrim(coalesce(p_value, '')); n numeric; v_fee jsonb;
 v_row public.course_fee_setups;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into r from public.letter_variables where key = p_key;
 if not found then raise exception 'Unknown variable %', p_key using errcode = '22023'; end if;
 if not r.editable_source then raise exception '% cannot be saved to its source from here; change it in %', r.label, r.source_label using errcode = '42501'; end if;
 if v = '' then raise exception 'Enter a value for %', r.label using errcode = '22023'; end if;
 if char_length(v) > 2000 then raise exception '% is too long', r.label using errcode = '22023'; end if;
 if r.input_type = 'date' then
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter % as a date', r.label using errcode = '22023'; end if;
  perform v::date;
 end if;
 if r.input_type = 'money' then
  v := regexp_replace(v, '^(AUD)?\$?\s*|,', '', 'g');
  if v !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then raise exception 'Enter % as an amount, for example 14500.00', r.label using errcode = '22023'; end if;
 end if;
 if r.source_kind = 'application' then
  if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
  update public.enrollment_applications set data = jsonb_set(coalesce(data, '{}'::jsonb), array['values', r.source_ref], to_jsonb(v), true)
   where id = a.id;
  -- An answer kept on the student's record (identity fields) is updated there too, so the application shows the same value.
  update public.enrollment_students s set details = jsonb_set(coalesce(s.details, '{}'::jsonb), array[r.source_ref], to_jsonb(v), true)
   where s.id = a.student_id and coalesce(s.details, '{}'::jsonb) ? r.source_ref;
 else
  if not public.cms_is_admin() then raise exception 'Only an administrator can change % in %', r.label, r.source_label using errcode = '42501'; end if;
  if r.source_kind = 'institute' then
   if r.source_ref not in ('name', 'short_name', 'address', 'phone', 'email', 'admissions_email', 'rto', 'cricos', 'abn', 'website') then raise exception 'Not editable' using errcode = '42501'; end if;
   execute format('update public.cms_settings set %I = $1, updated_at = now() where id = (select s.id from public.cms_settings s where s.tenant_id is not distinct from $2 order by s.id limit 1)', r.source_ref) using v, a.tenant_id;
  elsif r.source_kind = 'course' then
   if r.source_ref not in ('cricos', 'duration', 'mode') then raise exception 'Not editable' using errcode = '42501'; end if;
   select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
   if ac.course_id is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   execute format('update public.cms_courses set %I = $1, updated_at = now() where id = $2', r.source_ref) using v, ac.course_id;
  elsif r.source_kind = 'fee' then
   select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
   if ac.course_id is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   -- Saved on the intake's fees when the intake has its own, otherwise on the course's fees for every intake.
   select * into v_row from public.course_fee_setups x where x.course_id = ac.course_id and x.intake_id = ac.intake_id;
   if not found then select * into v_row from public.course_fee_setups x where x.course_id = ac.course_id and x.intake_id is null; end if;
   v_fee := jsonb_build_object('tuition', v_row.tuition_fee, 'enrolment', v_row.enrolment_fee, 'material', v_row.material_fee, 'oshc', v_row.oshc_fee, 'deposit', v_row.deposit,
     'paymentPlan', v_row.payment_plan, 'campus', v_row.campus);
   v_fee := v_fee || jsonb_build_object(case r.source_ref when 'tuition_fee' then 'tuition' when 'enrolment_fee' then 'enrolment' when 'material_fee' then 'material' when 'oshc_fee' then 'oshc'
     when 'deposit' then 'deposit' when 'payment_plan' then 'paymentPlan' when 'campus' then 'campus' end, v);
   perform public.cms_course_fee_save(ac.course_id, case when v_row.id is null then null else v_row.intake_id end, jsonb_strip_nulls(v_fee));
  else
   raise exception '% cannot be saved to its source from here', r.label using errcode = '42501';
  end if;
 end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'letter_value_saved_to_source', 'application', a.id::text, a.id,
   jsonb_build_object('key', r.key, 'source', r.source_label, 'value', left(v, 500)));
 return public.application_letter_values(a.id);
end $$;
revoke all on function public.portal_letter_save_to_source(uuid, text, text) from public;
grant execute on function public.portal_letter_save_to_source(uuid, text, text) to authenticated;

/* ------------------------------------------------------------------ student offer letter templates */
alter table hr.sign_templates drop constraint sign_templates_category_check;
alter table hr.sign_templates add constraint sign_templates_category_check check (category = any (array['enrolment_agreement', 'consent_form', 'fee_agreement', 'employment_contract',
  'offer_letter', 'hr_declaration', 'agency_agreement', 'commission_agreement', 'other', 'offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection', 'student_offer_letter']));

/** The {{key}} tokens a template uses (modifiers removed), in order of first use. */
create function public.letter_template_keys(p_html text) returns text[] language sql immutable parallel safe set search_path = pg_catalog as $$
  select coalesce(array_agg(k order by first), '{}') from (
    select lower(btrim(split_part(m[1], '|', 1))) k, min(n) first
    from regexp_matches(regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g'), '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') with ordinality as t(m, n) group by 1) s;
$$;

/**
 * Tokens of a template that do not map to the registry: {{unknown}} (or an unknown |modifier), the old $[field] and {field:inline}
 * placeholders, and an old [Variable] whose name is one of the registry's aliases ([Page Number], [Student Name]...). Other text in
 * square brackets stays text.
 */
create function public.letter_template_unmapped(p_html text) returns text[] language sql stable security definer set search_path = public as $$
  with src as (select regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g') as t),
  found as (
    select '{{' || btrim(m[1]) || '}}' tok, 'curly' kind, btrim(m[1]) raw from src, regexp_matches(src.t, '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') m
    union all select '$[' || m[1] || ']', 'old', m[1] from src, regexp_matches(src.t, '\$\[([^\[\]]{1,80})\]', 'g') m
    union all select '{' || m[1] || ':inline}', 'old', m[1] from src, regexp_matches(src.t, '\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}', 'g') m
    union all select '[' || m[1] || ']', 'bracket', m[1] from src, regexp_matches(src.t, '(?:^|[^$])\[([^\[\]\n]{1,80})\]', 'g') m
  )
  select coalesce(array_agg(distinct tok order by tok), '{}') from found f
  where (f.kind = 'curly' and (not exists (select 1 from public.letter_variables v where v.key = lower(btrim(split_part(f.raw, '|', 1))))
          or (position('|' in f.raw) > 0 and lower(btrim(split_part(f.raw, '|', 2))) not in ('upper', 'lower', 'raw', 'title'))))
     or f.kind = 'old'
     or (f.kind = 'bracket' and exists (select 1 from public.letter_variables v, unnest(v.aliases) al where public.letter_norm(al) = public.letter_norm(f.raw)));
$$;
revoke all on function public.letter_template_unmapped(text) from public, anon;
grant execute on function public.letter_template_unmapped(text) to authenticated;

/** A student offer letter with unmapped tokens is kept inactive; making it active is refused. */
create function hr.letter_template_guard() returns trigger language plpgsql security definer set search_path = public, hr, pg_temp as $$
declare v text[];
begin
 if new.category <> 'student_offer_letter' then return new; end if;
 new.audience := 'student';
 v := public.letter_template_unmapped(concat_ws(' ', new.title, new.header_html, new.body_html, new.footer_html));
 if cardinality(v) > 0 and new.status = 'active' then
  if tg_op = 'UPDATE' and old.status = 'archived' then
   raise exception 'Map every variable before making the template active: %', array_to_string(v, ', ') using errcode = '22023';
  end if;
  new.status := 'archived';
 end if;
 return new;
end $$;
create trigger letter_template_guard before insert or update on hr.sign_templates for each row execute function hr.letter_template_guard();

/** Student offer letter templates for the list and the issue drawer: name, version, last updated, active, unmapped tokens. */
create function public.letter_templates() returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not (public.cms_is_admin() or public.portal_is_slit_admin()) then raise exception 'Only staff can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'title', t.title, 'version', t.version, 'updatedAt', t.updated_at, 'active', t.status = 'active',
   'isDefault', t.is_default, 'headerHtml', t.header_html, 'bodyHtml', t.body_html, 'footerHtml', t.footer_html,
   'unmapped', to_jsonb(public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html)))) order by t.status = 'active' desc, t.is_default desc, lower(t.name))
   from hr.sign_templates t where t.category = 'student_offer_letter' and t.deleted_at is null), '[]'::jsonb);
end $$;
revoke all on function public.letter_templates() from public;
grant execute on function public.letter_templates() to authenticated;

/** Active / inactive from the template list. Activation is refused while a token is unmapped. */
create function public.letter_template_set_active(p_id uuid, p_active boolean) returns jsonb language plpgsql security definer set search_path = public, hr as $$
declare t hr.sign_templates;
begin
 perform hr.require_admin();
 select * into t from hr.sign_templates where id = p_id and category = 'student_offer_letter' and deleted_at is null for update;
 if not found then raise exception 'Template not found' using errcode = '22023'; end if;
 update hr.sign_templates set status = case when p_active then 'active' else 'archived' end, updated_at = now() where id = t.id returning * into t;
 return jsonb_build_object('id', t.id, 'active', t.status = 'active');
end $$;
revoke all on function public.letter_template_set_active(uuid, boolean) from public;
grant execute on function public.letter_template_set_active(uuid, boolean) to authenticated;

/* ------------------------------------------------------------------ issuing a letter from a template */
alter table public.enrollment_offer_letters
 add column template_name text not null default '',
 add column template_version integer,
 add column variable_values jsonb not null default '{}'::jsonb,
 add column manual_values jsonb not null default '[]'::jsonb;
comment on column public.enrollment_offer_letters.manual_values is 'Details staff filled by hand: [{key, label, value, mode: letter | source | blank, by, at}].';

/**
 * Send offer letter (template): the template must be an active student offer letter at the version the preview was made from. Every
 * variable the template uses must have a value: from the record, or filled by hand (for this letter, or saved to the source first);
 * an optional variable may be left blank only when that was ticked. The PDF (made by the drawer from the same values, checked as a
 * PDF here), the template name and version, the values used and the manual fills are kept on the letter; the manual fills are listed
 * in the status history note with who sent it and when.
 */
create function public.portal_offer_letter_issue_template(p_application uuid, p_template uuid, p_template_version integer, p_file_name text, p_content_base64 text,
  p_manual jsonb default '[]'::jsonb, p_conditions text default '', p_message text default '', p_override_note text default '') returns jsonb
 language plpgsql security definer set search_path = public, hr as $$
declare a public.enrollment_applications; t hr.sign_templates; v_unmapped text[]; v_keys text[]; v_vals jsonb; k text; r public.letter_variables; m jsonb;
 v_missing text[] := '{}'; v_manual jsonb := '[]'::jsonb; v_used jsonb := '{}'::jsonb; v_bytes bytea; v_route jsonb; v_id uuid; v_name text; v_mismatch boolean;
 v_notes text[] := '{}'; v_conditions text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'offer_letter') then
  raise exception 'An offer letter cannot be issued while the application is %', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 select * into t from hr.sign_templates where id = p_template and category = 'student_offer_letter' and deleted_at is null;
 if not found then raise exception 'Choose an offer letter template' using errcode = '22023'; end if;
 if t.status <> 'active' then raise exception 'The template "%" is inactive', t.name using errcode = '22023'; end if;
 if t.version is distinct from p_template_version then raise exception 'The template "%" changed since the preview was made. Refresh the preview', t.name using errcode = '40001'; end if;
 v_unmapped := public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html));
 if cardinality(v_unmapped) > 0 then raise exception 'The template has unmapped variables: %', array_to_string(v_unmapped, ', ') using errcode = '22023'; end if;

 v_keys := public.letter_template_keys(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html));
 v_vals := public.application_letter_values(a.id) -> 'values';
 v_conditions := coalesce(nullif(btrim(coalesce(p_conditions, '')), ''), 'Nil');
 foreach k in array v_keys loop
  select * into r from public.letter_variables where key = k;
  if r.source_kind = 'render' then continue; end if;
  if r.source_kind = 'entered' then v_used := v_used || jsonb_build_object(k, v_conditions); continue; end if;
  select x into m from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) x where x->>'key' = k limit 1;
  if not coalesce((v_vals -> k ->> 'missing')::boolean, true) and coalesce(m->>'mode', '') <> 'letter' then
   v_used := v_used || jsonb_build_object(k, v_vals -> k ->> 'value');
   if m->>'mode' = 'source' then
    v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(v_vals -> k ->> 'value', 500), 'mode', 'source', 'by', auth.uid(), 'at', now()));
    v_notes := v_notes || (r.label || ' (saved to ' || r.source_label || ')');
   end if;
   continue;
  end if;
  if m is not null and m->>'mode' in ('letter', 'source') and nullif(btrim(coalesce(m->>'value', '')), '') is not null then
   v_used := v_used || jsonb_build_object(k, left(btrim(m->>'value'), 2000));
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(btrim(m->>'value'), 500), 'mode', 'letter', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (this letter only)');
  elsif m is not null and m->>'mode' = 'blank' and not r.required then
   v_used := v_used || jsonb_build_object(k, '');
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', '', 'mode', 'blank', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (left blank)');
  else
   v_missing := v_missing || r.label;
  end if;
 end loop;
 if cardinality(v_missing) > 0 then
  raise exception '% detail(s) missing: %', cardinality(v_missing), array_to_string(v_missing, ', ') using errcode = '22023';
 end if;

 begin v_bytes := decode(coalesce(p_content_base64, ''), 'base64'); exception when others then raise exception 'The letter is not a PDF' using errcode = '22023'; end;
 if v_bytes is null or length(v_bytes) < 5 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then raise exception 'The letter is not a PDF' using errcode = '22023'; end if;
 if length(v_bytes) > 3145728 then raise exception 'The letter is larger than 3 MB' using errcode = '22023'; end if;
 v_mismatch := public.application_declaration_mismatch(a.id);
 if v_mismatch and nullif(btrim(coalesce(p_override_note, '')), '') is null then
  raise exception 'The declarant name and digital signature do not match. Add a note to issue the offer letter anyway' using errcode = '22023';
 end if;
 v_route := public.application_offer_recipient(a.id);
 if coalesce(v_route->>'email', '') = '' then raise exception 'There is no email address to send the offer letter to' using errcode = '22023'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 insert into public.enrollment_offer_letters(application_id, tenant_id, source, template_id, file_name, size_bytes, sha256, content, message, override_note,
   recipient_kind, recipient_name, recipient_email, issued_by, issued_by_name, template_name, template_version, variable_values, manual_values)
 values (a.id, a.tenant_id, 'template', t.id, left(coalesce(nullif(btrim(p_file_name), ''), 'Offer letter.pdf'), 200), length(v_bytes), encode(extensions.digest(v_bytes, 'sha256'), 'hex'), v_bytes,
   left(coalesce(p_message, ''), 2000), left(coalesce(p_override_note, ''), 500), v_route->>'kind', coalesce(v_route->>'name', ''), v_route->>'email', auth.uid(), coalesce(v_name, ''),
   t.name, t.version, v_used, v_manual)
 returning id into v_id;
 perform set_config('portal.offer_command', a.id::text, true);
 perform public.portal_set_application_status(a.id, 'offer_issued',
   left(concat_ws(' · ', 'Offer letter sent to ' || (v_route->>'kind') || ' ' || (v_route->>'email') || ' (template "' || t.name || '" v' || t.version || ')', nullif(btrim(p_message), ''),
     case when cardinality(v_notes) > 0 then 'Filled by hand: ' || array_to_string(v_notes, '; ') end,
     case when v_mismatch then 'Declaration mismatch accepted: ' || btrim(p_override_note) end), 1000));
 perform set_config('portal.offer_command', '', true);
 return jsonb_build_object('id', v_id, 'recipient', v_route, 'manual', v_manual);
end $$;
revoke all on function public.portal_offer_letter_issue_template(uuid, uuid, integer, text, text, jsonb, text, text, text) from public;
grant execute on function public.portal_offer_letter_issue_template(uuid, uuid, integer, text, text, jsonb, text, text, text) to authenticated;

/** The current letter, now with its template name / version and the details filled by hand. */
create or replace function public.portal_offer_letter_current(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.enrollment_offer_letters;
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 select * into l from public.enrollment_offer_letters where application_id = p_application order by issued_at desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'source', l.source, 'message', l.message, 'recipientKind', l.recipient_kind,
   'recipientName', l.recipient_name, 'recipientEmail', l.recipient_email, 'issuedAt', l.issued_at, 'issuedByName', l.issued_by_name, 'resentAt', l.resent_at,
   'acceptedAt', l.accepted_at, 'acceptedByName', l.accepted_by_name, 'acceptedVia', l.accepted_via, 'templateName', l.template_name, 'templateVersion', l.template_version)
   || case when public.portal_is_slit_admin() then jsonb_build_object('manualValues', l.manual_values) else '{}'::jsonb end;
end $$;

create or replace function public.portal_offer_letter_list(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'issuedAt', l.issued_at, 'acceptedAt', l.accepted_at,
   'recipientKind', l.recipient_kind, 'recipientEmail', l.recipient_email, 'templateName', l.template_name, 'templateVersion', l.template_version) order by l.issued_at desc)
   from public.enrollment_offer_letters l where l.application_id = p_application), '[]'::jsonb);
end $$;
