create table public.admission_submission_receipts(
 id uuid primary key default gen_random_uuid(), application_id uuid not null references public.enrollment_applications(id),
 tenant_id uuid, version integer not null, request_key text not null, reference text not null, actor uuid not null,
 submitted_at timestamptz not null default now(), unique(application_id,version),unique(application_id,request_key),
 foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id)
);
create table public.admission_event_outbox(
 id uuid primary key default gen_random_uuid(),receipt_id uuid unique references public.admission_submission_receipts(id),
 application_id uuid not null references public.enrollment_applications(id),tenant_id uuid,event text not null,
 payload jsonb not null,created_at timestamptz not null default now(),delivered_at timestamptz,
 foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id)
);
alter table public.admission_submission_receipts enable row level security;
alter table public.admission_event_outbox enable row level security;
revoke all on public.admission_submission_receipts,public.admission_event_outbox from public,anon,authenticated,service_role;
grant select on public.admission_submission_receipts to authenticated,service_role;
grant select on public.admission_event_outbox to service_role;
create policy submission_receipt_read on public.admission_submission_receipts for select to authenticated using(public.portal_can_access_application(application_id));

create function public.portal_condition_met(p_condition jsonb,p_values jsonb) returns boolean language sql immutable set search_path=public as $$
 select p_condition is null or p_condition='null'::jsonb or coalesce(p_condition->'equals' ? (p_values->>(p_condition->>'field')),false);
$$;
revoke all on function public.portal_condition_met(jsonb,jsonb) from public;

-- The generated required-field schema below comes from the preserved enrolSections.
create function public.portal_required_schema() returns jsonb language sql immutable set search_path=public as $$ select $schema$[{"fields":[{"name":"passport_copy","type":"file"},{"name":"title","type":"select","options":["Mr","Mrs","Ms","Miss","Mx","Dr","Prof","Rev","Hon","Other"]},{"name":"first_name","type":"text"},{"name":"last_name","type":"text"},{"name":"dob","type":"date"},{"name":"gender","type":"radio","options":["Male","Female","Prefer not to say"]},{"name":"mobile","type":"tel"},{"name":"email","type":"email"},{"name":"confirm_email","type":"email"},{"name":"citizenship","type":"select","options":["Australia","Afghanistan","Bangladesh","Bhutan","Brazil","Cambodia","Canada","China","Colombia","Fiji","France","Germany","Hong Kong","India","Indonesia","Ireland","Italy","Japan","Kenya","Korea, Republic of","Kuwait","Malaysia","Maldives","Mauritius","Mexico","Myanmar","Nepal","Netherlands","New Zealand","Nigeria","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Russian Federation","Saudi Arabia","Singapore","South Africa","Spain","Sri Lanka","Sweden","Switzerland","Taiwan","Tanzania, the United Republic of","Thailand","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Viet Nam","Zimbabwe"]},{"name":"nationality","type":"select","options":["Australia","Afghanistan","Bangladesh","Bhutan","Brazil","Cambodia","Canada","China","Colombia","Fiji","France","Germany","Hong Kong","India","Indonesia","Ireland","Italy","Japan","Kenya","Korea, Republic of","Kuwait","Malaysia","Maldives","Mauritius","Mexico","Myanmar","Nepal","Netherlands","New Zealand","Nigeria","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Russian Federation","Saudi Arabia","Singapore","South Africa","Spain","Sri Lanka","Sweden","Switzerland","Taiwan","Tanzania, the United Republic of","Thailand","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Viet Nam","Zimbabwe"]},{"name":"birth_country","type":"select","options":["Australia","Afghanistan","Bangladesh","Bhutan","Brazil","Cambodia","Canada","China","Colombia","Fiji","France","Germany","Hong Kong","India","Indonesia","Ireland","Italy","Japan","Kenya","Korea, Republic of","Kuwait","Malaysia","Maldives","Mauritius","Mexico","Myanmar","Nepal","Netherlands","New Zealand","Nigeria","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Russian Federation","Saudi Arabia","Singapore","South Africa","Spain","Sri Lanka","Sweden","Switzerland","Taiwan","Tanzania, the United Republic of","Thailand","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Viet Nam","Zimbabwe"]},{"name":"passport_number","type":"text"},{"name":"passport_expiry","type":"date"}]},{"fields":[{"name":"address_type","type":"radio","options":["Australian Address","Overseas Address"]},{"name":"au_street","type":"text","showIf":{"field":"address_type","equals":["Australian Address"]}},{"name":"au_suburb","type":"text","showIf":{"field":"address_type","equals":["Australian Address"]}},{"name":"au_state","type":"text","showIf":{"field":"address_type","equals":["Australian Address"]}},{"name":"au_zip","type":"text","showIf":{"field":"address_type","equals":["Australian Address"]}},{"name":"au_country","type":"select","showIf":{"field":"address_type","equals":["Australian Address"]},"options":["Australia","Afghanistan","Bangladesh","Bhutan","Brazil","Cambodia","Canada","China","Colombia","Fiji","France","Germany","Hong Kong","India","Indonesia","Ireland","Italy","Japan","Kenya","Korea, Republic of","Kuwait","Malaysia","Maldives","Mauritius","Mexico","Myanmar","Nepal","Netherlands","New Zealand","Nigeria","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Russian Federation","Saudi Arabia","Singapore","South Africa","Spain","Sri Lanka","Sweden","Switzerland","Taiwan","Tanzania, the United Republic of","Thailand","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Viet Nam","Zimbabwe"]},{"name":"ov_street","type":"text","showIf":{"field":"address_type","equals":["Overseas Address"]}},{"name":"ov_suburb","type":"text","showIf":{"field":"address_type","equals":["Overseas Address"]}},{"name":"ov_state","type":"text","showIf":{"field":"address_type","equals":["Overseas Address"]}},{"name":"ov_zip","type":"text","showIf":{"field":"address_type","equals":["Overseas Address"]}},{"name":"ov_country","type":"select","showIf":{"field":"address_type","equals":["Overseas Address"]},"options":["Australia","Afghanistan","Bangladesh","Bhutan","Brazil","Cambodia","Canada","China","Colombia","Fiji","France","Germany","Hong Kong","India","Indonesia","Ireland","Italy","Japan","Kenya","Korea, Republic of","Kuwait","Malaysia","Maldives","Mauritius","Mexico","Myanmar","Nepal","Netherlands","New Zealand","Nigeria","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Russian Federation","Saudi Arabia","Singapore","South Africa","Spain","Sri Lanka","Sweden","Switzerland","Taiwan","Tanzania, the United Republic of","Thailand","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Viet Nam","Zimbabwe"]}]},{"fields":[{"name":"holds_visa","type":"radio","options":["Yes","No"]},{"name":"via_agent","type":"radio","options":["Yes","No"]},{"name":"agent_agency","type":"select","showIf":{"field":"via_agent","equals":["Yes"]},"options":["AGGARWAL IMMIGRATION CONSULTANTS","ASIA PACIFIC GROUP","AUSSIZZ GROUP-BRISBANE","AUSSIZZ GROUP-CANBERRA","AUSSIZZ GROUP-CLAYTON","AUSSIZZ GROUP-COLLINS ST","AUSSIZZ GROUP-CRANBOURNE","AUSSIZZ GROUP-DANDENONG","AUSSIZZ GROUP-ELIZABETH ST","AUSSIZZ GROUP-FOOTSCRAY","AUSSIZZ GROUP-GEELONG","AUSSIZZ GROUP-GLENROY","AUSSIZZ GROUP-ADELAIDE","AUSSIZZ GROUP-PAKENHAM","AUSSIZZ GROUP-PERTH","AUSSIZZ GROUP-SYDNEY","AUSSIZZ GROUP-THOMASTOWN","AUSSIZZ GROUP-TRUGANINA","AUSSIZZ GROUP-WERRIBEE","BANSAL EDUCATION GROUP","EPA GLOBAL","GAMBA MIGRATION","GRACE MIGRATION & EDUCATION SERVICES","HARI FAMILY TRUST","JAG’S MIGRATION (JAGDISH PATEL)","KNOWBAL EDUCATION","MAHI EDUCATION SERVICES","BLISS STAR EDUCATION CONSULTANCY","OPTIMISTIC CONSULTANTS","OZWISE EDUCATION SERVICES","PSM GLOBAL CONSULTANT","RS GLOBAL IMMIGRATION","NEWEDUCATION WORLD (AMIT MALIK)","NEW PAGE INTERNATIONAL","SANGUINE MIGRATION","STUDENT GUIDE AUSTRALIA","TILSAV MIGRATION & EDUCATION","WALES OVERSEAS CONSULTANTS","Other"]}]},{"fields":[{"name":"atsi","type":"radio","options":["No","Yes, Aboriginal","Yes, Torres Strait Islander","Yes, Aboriginal and Torres Strait Islander"]},{"name":"employment","type":"select","options":["Full-Time Employee - 01","Part-Time Employee - 02","Self-Employment Not Employing Others - 03","Self employed - employing others - 04","Employed - Unpaid Worker in Family Business - 05","Unemployed - Seeking Full-Time Work - 06","Unemployed - Seeking Part-Time Work - 07","Not Employed - Not Seeking Employment - 08"]},{"name":"language_home","type":"select","options":["No, English only - 1201","Yes, language other than English"]},{"name":"secondary_enrolled","type":"radio","options":["Yes","No"]},{"name":"school_level","type":"select","options":["Year 12 or equivalent - 12","Year 11 or equivalent - 11","Year 10 or equivalent - 10","Year 9 or equivalent - 09","Year 8 or below - 08","Never attended school - 02"]},{"name":"prior_ed","type":"radio","options":["Yes","No","Not specified"]},{"name":"disability","type":"radio","options":["Yes","No","Not specified"]}]},{"fields":[]},{"fields":[{"name":"has_usi","type":"radio","options":["Yes","No"]},{"name":"usi_number","type":"text","showIf":{"field":"has_usi","equals":["Yes"]}}]},{"fields":[{"name":"ec_name","type":"text"},{"name":"ec_phone","type":"tel"},{"name":"ec_in_au","type":"radio","options":["Yes","No"]}]},{"fields":[{"name":"courses_of_interest","type":"checkbox","options":["RII60520_104 - Advanced Diploma of Civil Construction Design (104 weeks)","RII60520 - Advanced Diploma of Civil Construction Design (52 Weeks)","ICT60220 - Advanced Diploma of Information Technology","MSF30322 - Certificate III in Cabinet Making and Timber Technology","CPC30220 - Certificate III in Carpentry","MSF30422 - Certificate III in Glass and Glazing","AUR30620 - Certificate III in Light Vehicle Mechanical Technology","CPC30620 - Certificate III in Painting and Decorating","AUR40216 - Certificate IV in Automotive Mechanical Diagnosis","CPC50220 - Diploma of Building and Construction (Building)","BSB50120 - Diploma of Business","RII50520 - Diploma of Civil Construction Design","BSB80120 - Graduate Diploma of Management (Learning)"]},{"name":"preferred_intake","type":"text"}]},{"fields":[{"name":"study_reason","type":"radio","options":["To get a job - 01","To develop my existing business - 02","To start my own business - 03","To try for a different career - 04","To get a better job or promotion - 05","It was a requirement of my job - 06","I wanted extra skills for my job - 07","To get into another course of study - 08","For personal interest or self-development - 09","To get skills for community/voluntary work - 10","Other reasons - 11"]}]},{"fields":[{"name":"rpl","type":"radio","options":["No","Yes"]}]},{"fields":[{"name":"oshc_require","type":"select","options":["Yes","No","Already Have"]}]},{"fields":[{"name":"hear_about","type":"select","options":["SLIT Website","Agent","SLIT Student","SLIT Staff Member","Family/Friend/Member","Others"]}]},{"fields":[{"name":"checklist","type":"checkbox","options":["Complete all sections of the application form","Provide details if you already have a student visa and/or OSHC"]}]},{"fields":[{"name":"declaration_name","type":"text"},{"name":"digital_signature","type":"text"},{"name":"declaration_date","type":"date"}]}]$schema$::jsonb; $$;
revoke all on function public.portal_required_schema() from public;

create function public.portal_validate_submission(p_application_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; value jsonb; category text; label text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=coalesce(a.data->'values','{}');
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) then continue; end if;
   label:=f->>'name';value:=vals->label;
   if f->>'type'='file' then
    category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.application_id=a.id and d.category=category and d.is_current) then
     raise exception 'Required document missing: %',label using errcode='22023'; end if;
   elsif f->>'type'='checkbox' then
    if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value)=0 then raise exception 'Required selection missing: %',label using errcode='22023'; end if;
    if label='courses_of_interest' then
     if not exists(select 1 from public.enrollment_application_courses where application_id=a.id) then raise exception 'Select an institution course' using errcode='22023'; end if;
    elsif f ? 'options' then
     if exists(select 1 from jsonb_array_elements_text(value) v where not (f->'options' ? v)) then raise exception 'Invalid selection: %',label using errcode='22023'; end if;
    end if;
   elsif nullif(btrim(value#>>'{}'),'') is null then raise exception 'Required field missing: %',label using errcode='22023';
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (value#>>'{}')) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and cc.status='Published'
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
end; $$;
revoke all on function public.portal_validate_submission(uuid) from public,anon,authenticated,service_role;

create function public.portal_submit_v2(p_application_id uuid,p_expected_version bigint,p_request_key text,p_consent jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; r public.admission_submission_receipts; snap jsonb; v integer; signed_path text;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) then raise exception 'Submission not authorized' using errcode='42501'; end if;
 if nullif(btrim(p_request_key),'') is null or length(p_request_key)>200 then raise exception 'Submission request key required' using errcode='22023'; end if;
 select * into r from public.admission_submission_receipts where application_id=a.id and request_key=p_request_key;
 if found then return to_jsonb(r); end if;
 if a.status not in ('draft','action_required') then
  select * into r from public.admission_submission_receipts where application_id=a.id order by version desc limit 1;
  if found then return to_jsonb(r); end if;
  raise exception 'Application is not awaiting submission' using errcode='PT409';
 end if;
 perform public.portal_lock_draft(a.id,p_expected_version);
 perform public.portal_validate_submission(a.id);
 if p_consent->'confirmed' is distinct from 'true'::jsonb or p_consent->'authorised' is distinct from 'true'::jsonb
  or p_consent->>'method' not in ('electronic','document') or p_consent->>'declarationVersion' is distinct from '1.0' then
  raise exception 'Student consent and agent authorization are required' using errcode='22023'; end if;
 signed_path:=coalesce(p_consent->>'signedDocumentRef','');
 if p_consent->>'method'='document' and not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
  where d.application_id=a.id and d.category='Consent' and d.is_current and d.storage_path=signed_path) then
  raise exception 'A signed consent document from this application is required' using errcode='22023'; end if;
 select coalesce(max(version),0)+1 into v from public.enrollment_application_versions where application_id=a.id;
 snap:=a.data||jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.enrollment_application_courses c where application_id=a.id),
  'submission',jsonb_build_object('actor',auth.uid(),'declarationVersion','1.0','consent',p_consent,'draftVersion',a.draft_version));
 perform set_config('portal.status_command',a.id::text,true);
 update public.enrollment_applications set status='submitted',submitted_at=now(),submitted_by=auth.uid(),
  reference=coalesce(nullif(a.reference,''),public.portal_next_application_reference()),version=v where id=a.id returning * into a;
 insert into public.enrollment_application_consents(application_id,method,signed_document_ref,declaration_version,recorded_by_name)
 values(a.id,p_consent->>'method',signed_path,'1.0',coalesce(auth.jwt()->>'email','Authenticated agent'));
 insert into public.enrollment_application_versions(application_id,version,snapshot,created_by,created_by_name)
 values(a.id,v,snap,auth.uid(),coalesce(auth.jwt()->>'email','Authenticated agent'));
 insert into public.admission_submission_receipts(application_id,tenant_id,version,request_key,reference,actor)
 values(a.id,a.tenant_id,v,p_request_key,a.reference,auth.uid()) returning * into r;
 insert into public.admission_event_outbox(receipt_id,application_id,tenant_id,event,payload)
 values(r.id,a.id,a.tenant_id,'application_submitted',jsonb_build_object('receiptId',r.id,'reference',a.reference,'version',v));
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authenticated user'),case when public.portal_is_agency_admin() then 'agency_admin' when public.portal_is_slit_admin() then 'slit_admin' else 'agent' end,
  'application_submitted','application',a.id::text,a.id,jsonb_build_object('receiptId',r.id,'version',v));
 return to_jsonb(r);
end; $$;
revoke all on function public.portal_submit_v2(uuid,bigint,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.portal_submit_v2(uuid,bigint,text,jsonb) to authenticated;

-- Compatibility name validates persisted data; client snapshots cannot replace it.
create or replace function public.portal_submit_application(p_application_id uuid,p_snapshot jsonb) returns text
language plpgsql security definer set search_path=public as $$
declare receipt jsonb;
begin
 receipt:=public.portal_submit_v2(p_application_id,(p_snapshot->>'draftVersion')::bigint,p_snapshot->>'requestKey',p_snapshot->'consent');
 return receipt->>'reference';
end; $$;

create or replace function public.portal_set_application_status(p_application_id uuid,p_status text,p_note text default '') returns void
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; allowed boolean;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode='42501'; end if;
 if a.status=p_status then return; end if;
 allowed:=case a.status
 when 'submitted' then p_status in ('under_review','action_required','rejected','withdrawn')
 when 'under_review' then p_status in ('action_required','offer_issued','rejected','withdrawn')
 when 'action_required' then p_status in ('under_review','rejected','withdrawn')
 when 'offer_issued' then p_status in ('offer_accepted','action_required','rejected','withdrawn')
 when 'offer_accepted' then p_status in ('coe_issued','withdrawn')
 when 'coe_issued' then p_status in ('enrolled','withdrawn')
 else false end;
 if not allowed then raise exception 'Invalid admissions transition: % to %',a.status,p_status using errcode='22023'; end if;
 if p_status='action_required' and nullif(btrim(p_note),'') is null then raise exception 'A correction reason is required' using errcode='22023'; end if;
 perform set_config('portal.status_command',a.id::text,true);
 perform set_config('portal.status_note',coalesce(p_note,''),true);
 update public.enrollment_applications set status=p_status where id=a.id;
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authorized reviewer'),'slit_admin','status_change','application',a.id::text,a.id,jsonb_build_object('from',a.status,'to',p_status,'note',p_note));
 insert into public.admission_event_outbox(application_id,tenant_id,event,payload)
 values(a.id,a.tenant_id,'application_status_changed',jsonb_build_object('from',a.status,'to',p_status,'actor',auth.uid()));
end; $$;

create function public.portal_protect_admission_state() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null then
  if tg_op='INSERT' then
   if new.status<>'draft' then raise exception 'New applications must start as drafts' using errcode='42501'; end if;
  elsif new.status is distinct from old.status or new.submitted_by is distinct from old.submitted_by or new.submitted_at is distinct from old.submitted_at or new.version is distinct from old.version then
   if current_setting('portal.status_command',true) is distinct from new.id::text then raise exception 'Use the admissions status command' using errcode='42501'; end if;
  end if;
 end if;
 return new;
end; $$;
revoke all on function public.portal_protect_admission_state() from public;
create trigger a_portal_admission_state before insert or update on public.enrollment_applications for each row execute function public.portal_protect_admission_state();

-- Serialise repeated create keys before the existing authorization and reference logic.
alter function public.portal_create_application(text,uuid,uuid) rename to portal_create_application_internal;
revoke all on function public.portal_create_application_internal(text,uuid,uuid) from public,anon,authenticated,service_role;
create function public.portal_create_application(p_client_key text,p_assigned_agent_id uuid default null,p_agency_id uuid default null)
returns table(application_id uuid,application_reference text) language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or nullif(btrim(p_client_key),'') is null or length(p_client_key)>200 then raise exception 'Creation request key required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_client_key,8304));
 return query select * from public.portal_create_application_internal(p_client_key,p_assigned_agent_id,p_agency_id);
end; $$;
revoke all on function public.portal_create_application(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.portal_create_application(text,uuid,uuid) to authenticated;
