begin;
alter table public.enrollment_document_extraction_jobs add column if not exists lease_token uuid;

create or replace function public.portal_claim_document_extraction_job()
returns setof public.enrollment_document_extraction_jobs
language plpgsql security definer set search_path=public as $$
declare v_job public.enrollment_document_extraction_jobs;
begin
 if not pg_try_advisory_xact_lock(9341,20261015) then return; end if;
 if exists(select 1 from public.enrollment_document_extraction_jobs where state='processing'
   and (lease_expires_at is null or lease_expires_at>=now())) then return; end if;
 select * into v_job from public.enrollment_document_extraction_jobs
 where (state='queued' and next_attempt_at<=now()) or (state='processing' and lease_expires_at<now())
 order by next_attempt_at,created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.enrollment_document_extraction_jobs set state='processing',attempt_count=attempt_count+1,
   started_at=now(),updated_at=now(),lease_expires_at=now()+interval '4 minutes',lease_token=gen_random_uuid()
 where id=v_job.id returning * into v_job;
 -- Read/merge current metadata in the same transaction as the claim.
 update public.enrollment_application_documents set metadata=jsonb_set(metadata,'{extraction}',
   coalesce(metadata->'extraction','{}'::jsonb) || jsonb_build_object('status',
     case when metadata#>>'{extraction,status}'='confirmed' then 'confirmed' else 'processing' end),true)
 where id=v_job.document_id and application_id=v_job.application_id and is_current;
 return next v_job;
end;
$$;

create or replace function public.portal_finish_document_extraction_job(p_job uuid,p_lease uuid,p_extraction jsonb,p_response_id text,p_usage jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_job public.enrollment_document_extraction_jobs; v_doc public.enrollment_application_documents;
 v_extraction jsonb; v_status text;
begin
 select * into v_job from public.enrollment_document_extraction_jobs where id=p_job for update;
 if not found or v_job.state<>'processing' or v_job.lease_token is distinct from p_lease or p_lease is null
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
   perform public.portal_apply_document_candidates(v_doc.id,p_extraction->'extracted',coalesce(p_extraction->'source','{}'::jsonb));
 end if;
 update public.enrollment_document_extraction_jobs set state='succeeded',lease_expires_at=null,lease_token=null,
   provider_response_id=p_response_id,usage=coalesce(p_usage,'{}'::jsonb),completed_at=now(),updated_at=now()
 where id=v_job.id;
 insert into public.enrollment_document_extraction_attempts(job_id,attempt_number,state,provider_response_id,usage,completed_at)
 values(v_job.id,v_job.attempt_count,'succeeded',p_response_id,coalesce(p_usage,'{}'::jsonb),now());
 return true;
end;
$$;

create or replace function public.portal_fail_document_extraction_job(p_job uuid,p_lease uuid,p_code text,p_message text,p_retry boolean,p_delay integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_job public.enrollment_document_extraction_jobs; v_retry boolean;
begin
 select * into v_job from public.enrollment_document_extraction_jobs where id=p_job for update;
 if not found or v_job.state<>'processing' or v_job.lease_token is distinct from p_lease or p_lease is null
   or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then return false; end if;
 v_retry:=coalesce(p_retry,false) and v_job.attempt_count<3;
 update public.enrollment_document_extraction_jobs set state=case when v_retry then 'queued' else 'failed' end,
   next_attempt_at=now()+make_interval(secs=>greatest(1,least(coalesce(p_delay,60),900))),
   lease_expires_at=null,lease_token=null,last_error_code=p_code,last_error=left(p_message,800),
   updated_at=now(),completed_at=case when v_retry then null else now() end where id=v_job.id;
 insert into public.enrollment_document_extraction_attempts(job_id,attempt_number,state,error_code,error,completed_at)
 values(v_job.id,v_job.attempt_count,'failed',p_code,left(p_message,800),now());
 update public.enrollment_application_documents set metadata=jsonb_set(metadata,'{extraction}',
   coalesce(metadata->'extraction','{}'::jsonb) || jsonb_build_object(
     'status',case when metadata#>>'{extraction,status}'='confirmed' then 'confirmed' when v_retry then 'queued' else 'failed' end,
     'error',jsonb_build_object('code',p_code,'message',left(p_message,240),'occurredAt',now())),true)
 where id=v_job.document_id and application_id=v_job.application_id and is_current;
 return true;
end;
$$;
revoke all on function public.portal_claim_document_extraction_job() from public,anon,authenticated;
revoke all on function public.portal_finish_document_extraction_job(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.portal_fail_document_extraction_job(uuid,uuid,text,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.portal_claim_document_extraction_job() to service_role;
grant execute on function public.portal_finish_document_extraction_job(uuid,uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.portal_fail_document_extraction_job(uuid,uuid,text,text,boolean,integer) to service_role;
commit;
