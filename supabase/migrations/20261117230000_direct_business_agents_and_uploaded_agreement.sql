-- SLIT's direct business and the uploaded signed agreement (owner decisions 2026-11-17, after the onboarding gate):
--   * SLIT-DIRECT (is_direct) never signs an agent agreement, so Add agent there (admin_agent_activate) and agent invitations into it
--     (portal_invitation_create) accept @slit.edu.au addresses only; an existing agent with another address is flagged on the business page
--     ("external account on SLIT-DIRECT", admin_agent_rows.externalOnDirect) and left as is.
--   * A signed agreement uploaded by staff makes a business operational without the online flow: only an administrator can record one
--     (admin_business_require), a reason is required and kept on the document, and the upload is written to the business audit and, when
--     the business has an onboarding, to its history (agency_onboarding_events 'agreement_uploaded').
alter table public.business_documents add column if not exists reason text check (reason is null or length(reason) <= 1000);

do $p$
declare v_src text; v_n integer; v_anchor text := 'if not public.agency_is_operational(a.id) then';
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_agent_activate';
 v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
 if v_n <> 1 then raise exception 'admin_agent_activate anchor found % times', v_n; end if;
 execute replace(v_src, v_anchor,
  'if coalesce(a.is_direct, false) and v_email !~ ''@slit\.edu\.au$'' then raise exception ''Only @slit.edu.au accounts can be agents on SLIT''''s direct business.'' using errcode = ''22023'', hint = ''direct_business_domain''; end if;' || E'\n ' || v_anchor);
end $p$;

do $p$
declare v_src text; v_n integer; v_anchor text := 'if exists (select 1 from public.cms_users u where lower(u.email) = v_email and u.role = ''Admin'') then';
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'portal_invitation_create';
 v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
 if v_n <> 1 then raise exception 'portal_invitation_create anchor found % times', v_n; end if;
 execute replace(v_src, v_anchor,
  'if p_role in (''agent'', ''agency_admin'') and exists (select 1 from public.agencies a where a.id = v_agency and coalesce(a.is_direct, false)) and v_email !~ ''@slit\.edu\.au$'' then'
  || ' raise exception ''Only @slit.edu.au accounts can be agents on SLIT''''s direct business.'' using errcode = ''22023'', hint = ''direct_business_domain''; end if;' || E'\n ' || v_anchor);
end $p$;

create or replace function public.admin_agent_rows(p_business uuid, p_search text, p_status text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 with rows as (
  select g.id as agent_id, g.profile_id, g.full_name as name, g.email, g.phone, g.marn, g.role, g.business_id, g.status_changed_at,
   case when g.status <> 'Active' then 'Inactive'
        when g.profile_id is null then 'Invited'
        when exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
          where m.user_id = g.profile_id and m.status = 'Active' and pp.status = 'Active') then 'Active'
        else 'Inactive' end as status,
   a.name as business_name, public.agency_effective_status(a) as business_status,
   coalesce(a.is_direct, false) and g.email !~ '@slit\.edu\.au$' as external_on_direct,
   (select i.id from public.agency_invitations i where i.agency_id = g.business_id and i.email = g.email and i.status = 'pending' and g.email <> '' limit 1) as invitation_id
  from public.agents g
  join public.agencies a on a.id = g.business_id
  where (p_business is null or g.business_id = p_business)
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', g.full_name, g.email, g.phone, g.marn, a.name)), w) = 0)
 ), filtered as (
  select *, case when business_status = 'Active' then 0 else 1 end as business_rank,
   case status when 'Active' then 0 when 'Invited' then 1 else 2 end as rank_key
  from rows where coalesce(p_status, '') = '' or status = p_status
 ), page as (
  select * from filtered order by business_rank, rank_key, lower(name), agent_id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from rows), 'active', (select count(*) from rows where status = 'Active'),
   'invited', (select count(*) from rows where status = 'Invited'), 'inactive', (select count(*) from rows where status = 'Inactive')),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
   'key', p.agent_id, 'agentId', p.agent_id, 'omaraId', null, 'profileId', p.profile_id, 'invitationId', p.invitation_id,
   'name', p.name, 'email', p.email, 'phone', p.phone, 'role', p.role, 'status', p.status, 'statusChangedAt', p.status_changed_at,
   'marn', p.marn, 'registered', null, 'externalOnDirect', p.external_on_direct,
   'businessId', p.business_id, 'businessName', p.business_name, 'businessStatus', p.business_status,
   'students', (select count(*) from public.enrollment_students s where s.agent_id = p.agent_id),
   'statusCounts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) from (select e.status, count(*) n from public.enrollment_applications e
     join public.enrollment_students s on s.id = e.student_id where s.agent_id = p.agent_id group by e.status) x)
  ) order by p.business_rank, p.rank_key, lower(p.name), p.agent_id) from page p), '[]'::jsonb))
 into result;
 return result;
end $f$;

-- An uploaded signed agreement: administrators only, with a reason, on the record.
drop function if exists public.admin_business_document_add(uuid, text, text, text, bigint);
create or replace function public.admin_business_document_add(p_business uuid, p_kind text, p_path text, p_name text, p_size bigint, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, storage as $f$
declare d public.business_documents; v_reason text; v_onb public.agency_onboarding;
begin
 perform public.admin_business_require();
 if not exists (select 1 from public.agencies where id = p_business) then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if coalesce(p_kind, '') not in ('agent_agreement', 'other') then raise exception 'Unknown document type' using errcode = '22023'; end if;
 v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 1000), '');
 if p_kind = 'agent_agreement' and (v_reason is null or length(v_reason) < 5) then
  raise exception 'Give the reason for recording a signed copy instead of the online agreement (kept on the record)' using errcode = '22023'; end if;
 if coalesce(p_path, '') not like p_business::text || '/%' or p_path like '%..%'
  or not exists (select 1 from storage.objects o where o.bucket_id = 'business-documents' and o.name = p_path) then
  raise exception 'Upload the file first' using errcode = '22023'; end if;
 insert into public.business_documents(business_id, kind, file_name, storage_path, size_bytes, uploaded_by, reason)
 values (p_business, p_kind, left(coalesce(nullif(btrim(regexp_replace(p_name, '[[:cntrl:]]', '', 'g')), ''), 'document'), 200), p_path, greatest(coalesce(p_size, 0), 0), auth.uid(), v_reason)
 returning * into d;
 perform public.admin_business_audit(case when d.kind = 'agent_agreement' then 'agent_agreement_uploaded' else 'business_document_added' end, p_business, p_business, jsonb_build_object('kind', d.kind, 'file', d.file_name, 'reason', v_reason));
 if d.kind = 'agent_agreement' then
  select * into v_onb from public.agency_onboarding x where x.agency_id = p_business order by x.created_at desc limit 1;
  if v_onb.id is not null then perform public.agency_onboarding_log(v_onb.id, 'agreement_uploaded', jsonb_build_object('file', d.file_name, 'reason', v_reason, 'document', d.id)); end if;
 end if;
 return jsonb_build_object('id', d.id, 'reason', v_reason);
end $f$;
revoke all on function public.admin_business_document_add(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.admin_business_document_add(uuid, text, text, text, bigint, text) to authenticated;

-- The document list shows the reason.
create or replace function public.admin_business_documents(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'fileName', d.file_name, 'path', d.storage_path, 'size', d.size_bytes, 'createdAt', d.created_at, 'reason', d.reason,
   'uploadedBy', coalesce((select u.name from public.cms_users u where u.auth_user_id = d.uploaded_by limit 1), '')) order by d.created_at desc)
  from public.business_documents d where d.business_id = p_business), '[]'::jsonb);
end $f$;
