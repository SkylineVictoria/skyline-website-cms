-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- AVETMISS 8.0 reference codes: forms show labels, tables store these codes.
create table public.avetmiss_codes (
  code_set text not null,
  code text not null,
  label text not null,
  sort integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (code_set, code)
);
comment on table public.avetmiss_codes is 'AVETMISS 8.0 code lists (outcome, funding_source, study_reason, sex, indigenous_status, school_level, labour_force, disability_type, prior_education, prior_education_recognition, english_proficiency, state, org_type, predominant_delivery_mode, commencing). Country (SACC) and language (ASCL) sets are loaded separately from the ABS classifications.';

create table public.avetmiss_code_aliases (
  code_set text not null,
  alias text not null,
  code text not null,
  primary key (code_set, alias),
  foreign key (code_set, code) references public.avetmiss_codes(code_set, code) on delete cascade
);
comment on table public.avetmiss_code_aliases is 'Form labels (lower-case) that map to an AVETMISS code, e.g. sex "male" -> M.';

alter table public.avetmiss_codes enable row level security;
alter table public.avetmiss_code_aliases enable row level security;
create policy avetmiss_codes_read on public.avetmiss_codes for select to authenticated using (true);
create policy avetmiss_codes_write on public.avetmiss_codes for all using (public.cms_is_admin()) with check (public.cms_is_admin());
create policy avetmiss_code_aliases_read on public.avetmiss_code_aliases for select to authenticated using (true);
create policy avetmiss_code_aliases_write on public.avetmiss_code_aliases for all using (public.cms_is_admin()) with check (public.cms_is_admin());

insert into public.avetmiss_codes (code_set, code, label, sort) values
('outcome','20','Competency achieved / pass',1),
('outcome','30','Competency not achieved / fail',2),
('outcome','40','Withdrawn / discontinued',3),
('outcome','41','Incomplete due to RTO closure',4),
('outcome','51','Recognition of prior learning granted',5),
('outcome','52','Recognition of prior learning not granted',6),
('outcome','60','Credit transfer / national recognition',7),
('outcome','70','Continuing enrolment',8),
('outcome','81','Non-assessable enrolment – satisfactorily completed',9),
('outcome','82','Non-assessable enrolment – withdrawn or not satisfactorily completed',10),
('outcome','85','Not yet started',11),
('funding_source','11','Commonwealth and state general purpose recurrent',1),
('funding_source','13','Commonwealth specific purpose programs',2),
('funding_source','15','State specific funding',3),
('funding_source','20','Domestic full fee-for-service',4),
('funding_source','31','International onshore client',5),
('funding_source','32','International offshore client',6),
('funding_source','80','Revenue earned from another RTO',7),
('study_reason','01','To get a job',1),
('study_reason','02','To develop my existing business',2),
('study_reason','03','To start my own business',3),
('study_reason','04','To try for a different career',4),
('study_reason','05','To get a better job or promotion',5),
('study_reason','06','It was a requirement of my job',6),
('study_reason','07','I wanted extra skills for my job',7),
('study_reason','08','To get into another course of study',8),
('study_reason','11','Other reasons',9),
('study_reason','12','For personal interest or self-development',10),
('study_reason','13','To get skills for community / voluntary work',11),
('study_reason','@@','Not specified',12),
('sex','F','Female',1),('sex','M','Male',2),('sex','X','Other',3),('sex','@','Not stated',4),
('indigenous_status','1','Yes, Aboriginal',1),
('indigenous_status','2','Yes, Torres Strait Islander',2),
('indigenous_status','3','Yes, Aboriginal and Torres Strait Islander',3),
('indigenous_status','4','No, neither Aboriginal nor Torres Strait Islander',4),
('indigenous_status','@','Not stated',5),
('school_level','02','Did not go to school',1),
('school_level','08','Year 8 or below',2),
('school_level','09','Year 9 or equivalent',3),
('school_level','10','Completed Year 10',4),
('school_level','11','Completed Year 11',5),
('school_level','12','Completed Year 12',6),
('school_level','@@','Not stated',7),
('labour_force','01','Full-time employee',1),
('labour_force','02','Part-time employee',2),
('labour_force','03','Self-employed – not employing others',3),
('labour_force','04','Employer',4),
('labour_force','05','Employed – unpaid worker in a family business',5),
('labour_force','06','Unemployed – seeking full-time work',6),
('labour_force','07','Unemployed – seeking part-time work',7),
('labour_force','08','Not employed – not seeking employment',8),
('labour_force','@@','Not stated',9),
('flag','Y','Yes',1),('flag','N','No',2),('flag','@','Not stated',3),
('disability_type','11','Hearing / deaf',1),
('disability_type','12','Physical',2),
('disability_type','13','Intellectual',3),
('disability_type','14','Learning',4),
('disability_type','15','Mental illness',5),
('disability_type','16','Acquired brain impairment',6),
('disability_type','17','Vision',7),
('disability_type','18','Medical condition',8),
('disability_type','19','Other',9),
('disability_type','99','Unspecified',10),
('prior_education','008','Bachelor degree or higher',1),
('prior_education','410','Advanced diploma or associate degree',2),
('prior_education','420','Diploma (or associate diploma)',3),
('prior_education','511','Certificate IV (or advanced certificate / technician)',4),
('prior_education','514','Certificate III (or trade certificate)',5),
('prior_education','521','Certificate II',6),
('prior_education','524','Certificate I',7),
('prior_education','990','Miscellaneous education',8),
('prior_education_recognition','A','Australian qualification',1),
('prior_education_recognition','E','Australian equivalent',2),
('prior_education_recognition','I','International',3),
('english_proficiency','1','Very well',1),
('english_proficiency','2','Well',2),
('english_proficiency','3','Not well',3),
('english_proficiency','4','Not at all',4),
('english_proficiency','@','Not stated',5),
('state','01','New South Wales',1),('state','02','Victoria',2),('state','03','Queensland',3),
('state','04','South Australia',4),('state','05','Western Australia',5),('state','06','Tasmania',6),
('state','07','Northern Territory',7),('state','08','Australian Capital Territory',8),
('state','09','Other Australian territories or dependencies',9),('state','99','Overseas',10),
('org_type','91','Privately operated registered training organisation',1),
('predominant_delivery_mode','I','Internal (classroom)',1),
('predominant_delivery_mode','E','External (online / remote)',2),
('predominant_delivery_mode','W','Workplace-based',3),
('predominant_delivery_mode','N','Not applicable (RPL or credit transfer)',4),
('commencing','3','Commencing enrolment',1),
('commencing','4','Continuing enrolment',2),
('commencing','8','Unit of competency or module enrolment only',3);

insert into public.avetmiss_code_aliases (code_set, alias, code) values
('sex','female','F'),('sex','male','M'),('sex','other','X'),
('indigenous_status','no','4'),
('flag','yes','Y'),('flag','no','N'),
('state','nsw','01'),('state','vic','02'),('state','qld','03'),('state','sa','04'),
('state','wa','05'),('state','tas','06'),('state','nt','07'),('state','act','08');

-- Turns a stored form label into a code: a trailing " - 07" style code wins
-- (the forms already print codes that way), then the alias table, then an exact code.
create or replace function public.avetmiss_code(p_set text, p_label text)
returns text language sql stable set search_path = public as $$
  with v as (select nullif(btrim(p_label), '') as l),
  s as (select substring(l from '-\s*([0-9@]{1,4})\s*$') as suffix, l from v)
  select coalesce(
    (select suffix from s where suffix is not null
       and (exists(select 1 from avetmiss_codes c where c.code_set = p_set and c.code = suffix)
            or not exists(select 1 from avetmiss_codes c where c.code_set = p_set))),
    (select a.code from avetmiss_code_aliases a, s where a.code_set = p_set and a.alias = lower(s.l)),
    (select c.code from avetmiss_codes c, s where c.code_set = p_set and c.code = s.l)
  );
$$;

create or replace function public.avetmiss_is_code(p_set text, p_code text)
returns boolean language sql stable set search_path = public as $$
  select p_code is null or exists(select 1 from avetmiss_codes where code_set = p_set and code = p_code);
$$;
