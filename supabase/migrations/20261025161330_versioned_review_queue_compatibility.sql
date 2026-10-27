alter table public.enrollment_document_extraction_jobs add column review_only boolean not null default false;
create or replace function public.portal_enqueue_document_job(p_document_id uuid,p_reextract boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$
declare d public.enrollment_application_documents; j public.enrollment_document_extraction_jobs;
begin
 select * into d from public.enrollment_application_documents where id=p_document_id for update;
 if auth.uid() is null or not public.portal_can_edit_application(d.application_id) or not d.is_current or
  d.category not in ('Passport','Driving Licence','Visa','English Test','Academic') or not exists(
  select 1 from public.enrollment_applications a where a.id=d.application_id and a.status in ('draft','action_required')) then
  raise exception 'Editable document not authorized' using errcode='42501'; end if;
 if p_reextract then update public.enrollment_document_extraction_jobs set state='cancelled',lease_token=null,lease_expires_at=null,updated_at=now()
  where document_id=d.id and state in ('queued','processing'); end if;
 select * into j from public.enrollment_document_extraction_jobs where document_id=d.id and state in ('queued','processing') limit 1;
 if not found then
  insert into public.enrollment_document_extraction_jobs(document_id,application_id,content_sha256,state,next_attempt_at,review_only)
  values(d.id,d.application_id,d.metadata->>'contentSha256','queued',now(),true) returning * into j;
 end if;
 update public.enrollment_application_documents set metadata=jsonb_set(metadata,'{extraction}',
  coalesce(metadata->'extraction','{}')||jsonb_build_object('status',case when metadata#>>'{extraction,status}'='confirmed' then 'confirmed' else j.state end),true) where id=d.id;
 return jsonb_build_object('id',j.id,'state',j.state,'tenant_id',j.tenant_id);
end; $$;
revoke all on function public.portal_enqueue_document_job(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.portal_enqueue_document_job(uuid,boolean) to authenticated;


CREATE OR REPLACE FUNCTION public.portal_finish_document_extraction_job(p_job uuid, p_lease uuid, p_extraction jsonb, p_response_id text, p_usage jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_job public.enrollment_document_extraction_jobs; v_doc public.enrollment_application_documents;
 v_extraction jsonb; v_status text; candidate record; current_values jsonb;
begin
 select * into v_job from public.enrollment_document_extraction_jobs where id=p_job for update;
 if not found or v_job.tenant_id is not null or v_job.state<>'processing' or v_job.lease_token is distinct from p_lease or p_lease is null
   or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then return false; end if;
 -- Match manual-review lock ordering: application before document.
 select status into v_status from public.enrollment_applications where id=v_job.application_id for update;
 select * into v_doc from public.enrollment_application_documents where id=v_job.document_id for update;
 if not found or not v_doc.is_current or v_doc.application_id<>v_job.application_id then return false; end if;
 if jsonb_typeof(p_extraction->'extracted') is distinct from 'object' then raise exception 'invalid extraction fields'; end if;
 v_extraction:=coalesce(v_doc.metadata->'extraction','{}'::jsonb) || (p_extraction-'confirmed');
 v_extraction:=jsonb_set(v_extraction,'{confirmed}',coalesce(v_doc.metadata#>'{extraction,confirmed}','{}'::jsonb),true);
 if v_doc.metadata#>>'{extraction,status}'='confirmed' then
   v_extraction:=jsonb_set(v_extraction,'{status}','"confirmed"'::jsonb,true);
 end if;
 update public.enrollment_application_documents set metadata=v_doc.metadata || jsonb_build_object(
   'extraction',v_extraction,'extractedFields',(select coalesce(jsonb_agg(key),'[]'::jsonb) from jsonb_object_keys(p_extraction->'extracted') key))
 where id=v_doc.id;
 if v_status in ('draft','action_required') then
   if v_job.review_only then
    select data->'values' into current_values from public.enrollment_applications where id=v_job.application_id;
    for candidate in select key,value#>>'{}' val from jsonb_each(p_extraction->'extracted') loop
     insert into public.enrollment_document_field_reviews(application_id,document_id,field_identifier,candidate_value,existing_value,final_value,state,source)
     values(v_doc.application_id,v_doc.id,candidate.key,candidate.val,current_values->>candidate.key,current_values->>candidate.key,
      case when lower(coalesce(current_values->>candidate.key,''))=lower(candidate.val) then 'corroborated' else 'conflict' end,coalesce(p_extraction->'source','{}'));
    end loop;
   else perform public.portal_apply_document_candidates(v_doc.id,p_extraction->'extracted',coalesce(p_extraction->'source','{}'::jsonb)); end if;
 end if;
 update public.enrollment_document_extraction_jobs set state='succeeded',lease_expires_at=null,lease_token=null,
   provider_response_id=p_response_id,usage=coalesce(p_usage,'{}'::jsonb),completed_at=now(),updated_at=now()
 where id=v_job.id;
 insert into public.enrollment_document_extraction_attempts(job_id,attempt_number,state,provider_response_id,usage,completed_at)
 values(v_job.id,v_job.attempt_count,'succeeded',p_response_id,coalesce(p_usage,'{}'::jsonb),now());
 return true;
end;
$function$

;
