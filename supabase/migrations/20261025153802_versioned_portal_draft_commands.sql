alter table public.enrollment_applications add column draft_version bigint not null default 0;

create function public.portal_draft_revision() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.data is distinct from old.data or new.student_name is distinct from old.student_name or
  new.student_email is distinct from old.student_email or new.intake is distinct from old.intake or new.completion is distinct from old.completion then
  if new.tenant_id is not null and auth.uid() is not null and current_setting('portal.draft_command',true) is distinct from new.id::text then
   raise exception 'Use the versioned draft command' using errcode='42501'; end if;
  new.draft_version:=old.draft_version+1;
 else new.draft_version:=old.draft_version; end if;
 return new;
end; $$;
revoke all on function public.portal_draft_revision() from public;
create trigger portal_draft_revision before update on public.enrollment_applications for each row execute function public.portal_draft_revision();

create function public.portal_lock_draft(p_application_id uuid,p_expected_version bigint) returns public.enrollment_applications
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id) or a.status not in ('draft','action_required') then
  raise exception 'Application is not editable' using errcode='42501'; end if;
 if a.draft_version is distinct from p_expected_version then
  raise exception 'Another session changed this application. Reload before saving; your unsaved values remain on this page.' using errcode='PT409'; end if;
 perform set_config('portal.draft_command',a.id::text,true);
 return a;
end; $$;
revoke all on function public.portal_lock_draft(uuid,bigint) from public,anon,authenticated,service_role;

create function public.portal_save_draft_v2(p_application_id uuid,p_expected_version bigint,p_patch jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; d jsonb; v bigint; c jsonb; course public.cms_courses;
begin
 a:=public.portal_lock_draft(p_application_id,p_expected_version);
 if jsonb_typeof(p_patch) is distinct from 'object' or p_patch-array['values','courses','savedAt','preparedBy','progress','wizard','academicQualifications']<>'{}'::jsonb
 or octet_length(p_patch::text)>500000 or p_patch ? 'values' and jsonb_typeof(p_patch->'values')<>'object' then
  raise exception 'Invalid draft fields' using errcode='22023'; end if;
 d:=coalesce(a.data,'{}')|| (p_patch-'values'-'wizard');
 if p_patch ? 'values' then d:=jsonb_set(d,'{values}',coalesce(a.data->'values','{}')||(p_patch->'values')); end if;
 if p_patch ? 'wizard' then d:=jsonb_set(d,'{wizard}',coalesce(a.data->'wizard','{}')||(p_patch->'wizard')); end if;
 if p_patch ? 'courses' then
  if jsonb_typeof(p_patch->'courses')<>'array' or jsonb_array_length(p_patch->'courses')>30 then raise exception 'Invalid courses' using errcode='22023'; end if;
  delete from public.enrollment_application_courses where application_id=a.id;
  for c in select value from jsonb_array_elements(p_patch->'courses') loop
   if a.tenant_id is not null then
    select * into course from public.cms_courses where id=c->>'courseId' and tenant_id=a.tenant_id and status='Published' and code<>'BSB80120';
    if not found then raise exception 'Course is not published for this institution' using errcode='23503'; end if;
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant)
    values(a.id,course.id,course.code,course.name,coalesce(c->>'variant',''));
   else
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant)
    values(a.id,c->>'courseId',c->>'code',c->>'title',coalesce(c->>'variant',''));
   end if;
  end loop;
 end if;
 update public.enrollment_applications set data=d,
 student_name=coalesce(nullif(concat_ws(' ',d#>>'{values,first_name}',d#>>'{values,last_name}'),''),a.student_name),
 student_email=coalesce(d#>>'{values,email}',a.student_email),intake=coalesce(d#>>'{values,preferred_intake}',a.intake),
 completion=case when d#>>'{progress,overall}' ~ '^\d{1,3}$' then least(100,(d#>>'{progress,overall}')::integer) else a.completion end,
 updated_at=clock_timestamp() where id=a.id returning draft_version into v;
 return v;
end; $$;
revoke all on function public.portal_save_draft_v2(uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.portal_save_draft_v2(uuid,bigint,jsonb) to authenticated;

create function public.portal_review_draft_v2(p_application_id uuid,p_expected_version bigint,p_values jsonb,p_provenance jsonb default '{}',p_confirmed jsonb default '[]',p_resolutions jsonb default '[]',p_wizard jsonb default '{}',p_student_name text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; result jsonb; revision bigint;
begin
 a:=public.portal_lock_draft(p_application_id,p_expected_version);
 result:=public.portal_save_document_review(a.id,p_values,p_provenance,p_confirmed,p_resolutions,p_wizard,p_student_name);
 select draft_version into revision from public.enrollment_applications where id=a.id;
 return result||jsonb_build_object('draft_version',revision);
end; $$;
revoke all on function public.portal_review_draft_v2(uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.portal_review_draft_v2(uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb,text) to authenticated;

create function public.portal_course_options() returns jsonb language sql stable security definer set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('courseId',id,'code',code,'title',name,'variant','') order by name),'[]')
 from public.cms_courses where tenant_id=public.tenant_current() and status='Published' and code<>'BSB80120' and
 (public.tenant_has_role(tenant_id,array['tenant_admin','staff']) or public.tenant_agency_access(tenant_id,public.portal_agency_id()));
$$;
revoke all on function public.portal_course_options() from public,anon,authenticated,service_role;
grant execute on function public.portal_course_options() to authenticated;
