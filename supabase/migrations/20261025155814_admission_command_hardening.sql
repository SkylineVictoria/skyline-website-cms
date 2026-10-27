create or replace function public.portal_submit_v2(p_application_id uuid,p_expected_version bigint,p_request_key text,p_consent jsonb) returns jsonb
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
  or coalesce(p_consent->>'method' not in ('electronic','document'),true) or p_consent->>'declarationVersion' is distinct from '1.0' then
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

create or replace function public.portal_create_application(p_client_key text,p_assigned_agent_id uuid default null,p_agency_id uuid default null)
returns table(application_id uuid,application_reference text) language plpgsql security definer set search_path=public as $$
declare t uuid:=public.tenant_current(); agency uuid:=public.portal_agency_id();
begin
 if auth.uid() is null or nullif(btrim(p_client_key),'') is null or length(p_client_key)>200 then raise exception 'Creation request key required' using errcode='22023'; end if;
 if public.tenant_request_domain() is not null then
  if t is null then raise exception 'Unknown or inactive institution' using errcode='42501'; end if;
  if public.portal_is_slit_admin() then agency:=p_agency_id;
  elsif not public.tenant_agency_access(t,agency) or p_agency_id is not null and p_agency_id is distinct from agency then
   raise exception 'Institution agency access required' using errcode='42501'; end if;
  if not exists(select 1 from public.agency_tenants at join public.agencies a on a.id=at.agency_id where at.tenant_id=t and at.agency_id=agency and at.active and a.status='Active') then
   raise exception 'Active institution agency relationship required' using errcode='42501'; end if;
 elsif not public.tenant_scope(null) then raise exception 'Legacy scope not authorized' using errcode='42501'; end if;
 if public.portal_is_agent() and not public.portal_is_agency_admin() and not public.portal_is_slit_admin() and p_assigned_agent_id is not null and p_assigned_agent_id is distinct from public.portal_profile_id() then
  raise exception 'Agents can create only their own applications' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_client_key,8304));
 return query select * from public.portal_create_application_internal(p_client_key,p_assigned_agent_id,p_agency_id);
end; $$;

create or replace function public.portal_assign_agent(p_application_id uuid,p_agent_profile_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) or not(public.portal_is_slit_admin() or public.portal_is_agency_admin()) then
  raise exception 'Authorized application administration required' using errcode='42501'; end if;
 if p_agent_profile_id is not null and not exists(select 1 from public.agency_memberships m join public.portal_profiles p on p.id=m.user_id
 where m.user_id=p_agent_profile_id and m.agency_id=a.agency_id and m.status='Active' and p.status='Active' and m.role='agent') then
  raise exception 'Active agency agent required' using errcode='42501'; end if;
 update public.enrollment_applications set assigned_agent_id=p_agent_profile_id where id=a.id;
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Administrator'),'administrator','agent_assignment','application',a.id::text,a.id,jsonb_build_object('agent',p_agent_profile_id));
end; $$;

create function public.portal_protect_reference() returns trigger language plpgsql set search_path=public as $$
begin
 if current_user='authenticated' and (new.reference,new.agency_id,new.created_by,new.id) is distinct from (old.reference,old.agency_id,old.created_by,old.id) then
  raise exception 'Application identity is immutable' using errcode='42501'; end if;
 return new;
end; $$;
revoke all on function public.portal_protect_reference() from public;
create trigger a_portal_reference before update on public.enrollment_applications for each row execute function public.portal_protect_reference();

create function public.portal_message_actor() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null then
  if not public.portal_can_access_application(new.application_id) or new.author is distinct from auth.uid() or
    (new.visibility='internal' and not public.portal_is_slit_admin()) or nullif(btrim(new.body),'') is null or length(new.body)>8000 then
   raise exception 'Message not authorized' using errcode='42501'; end if;
  new.author_name:=coalesce((select full_name from public.portal_profiles where auth_user_id=auth.uid()),auth.jwt()->>'email','Authenticated user');
  insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
  values(auth.uid(),new.author_name,case when public.portal_is_slit_admin() then 'slit_admin' else 'agency' end,'message_created','message',new.id::text,new.application_id,jsonb_build_object('visibility',new.visibility));
 end if;
 return new;
end; $$;
revoke all on function public.portal_message_actor() from public;
create trigger portal_message_actor before insert on public.enrollment_application_messages for each row execute function public.portal_message_actor();
