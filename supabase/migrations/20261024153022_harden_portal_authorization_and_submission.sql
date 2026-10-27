-- Phase 2 local-tested correction. No data/ID/ownership backfill.
begin;

create or replace function public.portal_agency_id()
returns uuid language sql stable security definer set search_path=public as $$
  select m.agency_id from public.agency_memberships m
  join public.agencies a on a.id=m.agency_id and a.status='Active'
  where m.user_id=public.portal_profile_id() and m.status='Active' limit 1;
$$;

create or replace function public.portal_can_edit_application(app_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and public.portal_can_access_application(app_id)
    and exists(select 1 from public.enrollment_applications a where a.id=app_id
      and (public.portal_is_slit_admin() or a.status in ('draft','action_required')));
$$;
revoke all on function public.portal_can_edit_application(uuid) from public,anon;
grant execute on function public.portal_can_edit_application(uuid) to authenticated,service_role;

drop policy if exists portal_agencies_read on public.agencies;
create policy portal_agencies_read on public.agencies for select to authenticated
using(public.portal_is_slit_admin() or id=public.portal_agency_id());

drop policy if exists portal_profiles_update on public.portal_profiles;
create policy portal_profiles_update on public.portal_profiles for update to authenticated
using(public.portal_is_slit_admin() or (auth_user_id=auth.uid() and status='Active'))
with check(public.portal_is_slit_admin() or (auth_user_id=auth.uid() and status='Active'));

create or replace function public.portal_guard_profile_update()
returns trigger language plpgsql set search_path=public as $$
begin
  if current_user='authenticated' and not public.portal_is_slit_admin()
     and (to_jsonb(new)-array['full_name','phone','job_title','updated_at'])
       is distinct from (to_jsonb(old)-array['full_name','phone','job_title','updated_at']) then
    raise exception 'profile security fields are immutable' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.portal_guard_profile_update() from public,anon,authenticated;
create trigger portal_guard_profile_update before update on public.portal_profiles
for each row execute function public.portal_guard_profile_update();

-- A FOR ALL write policy also grants SELECT. Replace it with actual commands.
drop policy if exists portal_app_messages_write on public.enrollment_application_messages;
create policy portal_app_messages_insert on public.enrollment_application_messages for insert to authenticated
with check(public.portal_can_access_application(application_id)
 and (visibility='agency' or public.portal_is_slit_admin()) and author=auth.uid());
-- History and snapshots are written only by trusted status/submit functions.
drop policy if exists portal_app_history_write on public.enrollment_application_status_history;
drop policy if exists portal_app_versions_write on public.enrollment_application_versions;

drop policy if exists portal_app_courses_write on public.enrollment_application_courses;
create policy portal_app_courses_insert on public.enrollment_application_courses for insert to authenticated
with check(public.portal_can_edit_application(application_id));
create policy portal_app_courses_update on public.enrollment_application_courses for update to authenticated
using(public.portal_can_edit_application(application_id)) with check(public.portal_can_edit_application(application_id));
create policy portal_app_courses_delete on public.enrollment_application_courses for delete to authenticated
using(public.portal_can_edit_application(application_id));

drop policy if exists portal_app_consents_write on public.enrollment_application_consents;
create policy portal_app_consents_insert on public.enrollment_application_consents for insert to authenticated
with check(public.portal_can_edit_application(application_id));
-- Recorded consents remain append-only; correction is a new record.

drop policy if exists portal_app_requests_write on public.enrollment_application_requests;
create policy portal_app_requests_insert on public.enrollment_application_requests for insert to authenticated
with check(public.portal_is_slit_admin());
create policy portal_app_requests_update on public.enrollment_application_requests for update to authenticated
using(public.portal_can_edit_application(application_id)) with check(public.portal_can_edit_application(application_id));

create or replace function public.portal_guard_request_update()
returns trigger language plpgsql set search_path=public as $$
begin
  if current_user='authenticated' and not public.portal_is_slit_admin()
    and (to_jsonb(new)-array['response','state','resolved_at'])
      is distinct from (to_jsonb(old)-array['response','state','resolved_at']) then
    raise exception 'request identity and staff fields are immutable' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.portal_guard_request_update() from public,anon,authenticated;
create trigger portal_guard_request_update before update on public.enrollment_application_requests
for each row execute function public.portal_guard_request_update();

create or replace function public.portal_guard_document_locator()
returns trigger language plpgsql set search_path=public as $$
begin
  if (new.id,new.application_id,new.bucket_name,new.storage_path,new.category,new.revision_of)
    is distinct from (old.id,old.application_id,old.bucket_name,old.storage_path,old.category,old.revision_of) then
    raise exception 'document target is immutable; upload a replacement' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.portal_guard_document_locator() from public,anon,authenticated;
create trigger portal_guard_document_locator before update on public.enrollment_application_documents
for each row execute function public.portal_guard_document_locator();

drop policy if exists portal_app_docs_write on public.enrollment_application_documents;
create policy portal_app_docs_insert on public.enrollment_application_documents for insert to authenticated
with check(public.portal_can_edit_application(application_id)
 and bucket_name='enrollment-documents'
 and split_part(storage_path,'/',1)=application_id::text
 and storage_path !~ '(^|/)(\.|\.\.)(/|$)' and position(chr(92) in storage_path)=0);
create policy portal_app_docs_update on public.enrollment_application_documents for update to authenticated
using(public.portal_can_edit_application(application_id)
 and (public.portal_is_slit_admin() or category not in ('Consent','Offer','CoE')))
with check(public.portal_can_edit_application(application_id)
 and (public.portal_is_slit_admin() or category not in ('Consent','Offer','CoE')));
-- Permanent deletion is coordinated by the existing authenticated Edge handler.
-- Direct client deletion cannot bypass retention or cancel/recovery bookkeeping.

create or replace function public.portal_guard_notification_update()
returns trigger language plpgsql set search_path=public as $$
begin
 if current_user='authenticated' and (to_jsonb(new)-'read') is distinct from (to_jsonb(old)-'read') then
   raise exception 'only notification read state is editable' using errcode='42501';
 end if;
 return new;
end;
$$;
revoke all on function public.portal_guard_notification_update() from public,anon,authenticated;
create trigger portal_guard_notification_update before update on public.portal_notifications
for each row execute function public.portal_guard_notification_update();

-- RPC definitions with locked status/parent validation follow below.

create or replace function public.portal_save_document_review(p_application_id uuid, p_values jsonb, p_provenance jsonb default '{}'::jsonb, p_confirmed jsonb default '[]'::jsonb, p_resolutions jsonb default '[]'::jsonb, p_wizard jsonb default '{}'::jsonb, p_student_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb; v_values jsonb; v_wizard jsonb; v_provenance jsonb; v_field text; v_value text;
  v_resolution jsonb; v_document_id uuid; v_candidate text; v_state text;
begin
  if auth.uid() is null or not public.portal_can_access_application(p_application_id) then raise exception 'not authorised' using errcode = '42501'; end if;
  select data into v_data from public.enrollment_applications where id = p_application_id for update;
  if not found then raise exception 'application not found' using errcode = 'P0002'; end if;
  if not public.portal_can_edit_application(p_application_id) then raise exception 'not authorised' using errcode='42501'; end if;
  -- Validate every document parent before accepting any field changes.
  for v_resolution in select value from jsonb_array_elements(coalesce(p_resolutions,'[]'::jsonb)) loop
    v_document_id := nullif(v_resolution->>'documentId','')::uuid;
    if v_document_id is not null and not exists(select 1 from public.enrollment_application_documents
       where id=v_document_id and application_id=p_application_id and is_current) then
      raise exception 'document does not belong to application' using errcode='42501';
    end if;
  end loop;
  v_values := coalesce(v_data->'values', '{}'::jsonb); v_wizard := coalesce(v_data->'wizard', '{}'::jsonb) || coalesce(p_wizard, '{}'::jsonb); v_provenance := coalesce(v_wizard->'provenance', '{}'::jsonb) || coalesce(p_provenance, '{}'::jsonb);
  for v_field, v_value in select key, value #>> '{}' from jsonb_each(coalesce(p_values, '{}'::jsonb)) loop v_values := jsonb_set(v_values, array[v_field], to_jsonb(coalesce(v_value, '')), true); end loop;
  v_wizard := jsonb_set(v_wizard, '{provenance}', v_provenance, true); v_wizard := jsonb_set(v_wizard, '{confirmed}', coalesce(p_confirmed, '[]'::jsonb), true); v_wizard := jsonb_set(v_wizard, '{updatedAt}', to_jsonb(now()), true);
  update public.enrollment_applications set data = jsonb_set(jsonb_set(v_data, '{values}', v_values, true), '{wizard}', v_wizard, true), student_name = coalesce(p_student_name, student_name), updated_at = now() where id = p_application_id;
  for v_resolution in select value from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) loop
    v_field := nullif(v_resolution->>'field', ''); if v_field is null then continue; end if;
    v_document_id := nullif(v_resolution->>'documentId', '')::uuid; v_candidate := nullif(v_resolution->>'candidateValue', ''); v_state := case when v_resolution->>'state' in ('confirmed','corrected','rejected') then v_resolution->>'state' else 'corrected' end;
    insert into public.enrollment_document_field_reviews(application_id, document_id, field_identifier, candidate_value, existing_value, final_value, state, source, reviewed_by, reviewed_at)
    values (p_application_id, v_document_id, v_field, v_candidate, null, v_values->>v_field, v_state, jsonb_build_object('kind', coalesce(v_provenance->>v_field, 'Manual entry')), public.portal_profile_id(), now());
  end loop;
  return jsonb_build_object('ok', true, 'values', v_values, 'wizard', v_wizard);
end;
$$;

create or replace function public.portal_submit_application(
  p_application_id uuid,
  p_snapshot jsonb
)
returns text
language plpgsql security definer set search_path = public
as $fn$
declare
  v_app     public.enrollment_applications;
  v_ref     text;
  v_uid     uuid := auth.uid();
  v_name    text;
  v_version integer;
begin
  select * into v_app
  from public.enrollment_applications
  where id = p_application_id for update;

  if v_app.id is null then
    raise exception 'Application not found.';
  end if;

  if not public.portal_can_access_application(p_application_id) then
    raise exception 'You are not authorised to submit this application.';
  end if;

  -- Idempotent: a second submit simply returns the same reference.
  if v_app.status not in ('draft', 'action_required') then
    return coalesce(v_app.reference, '');
  end if;

  v_ref := coalesce(nullif(v_app.reference, ''), public.portal_next_application_reference());
  v_version := greatest(coalesce(v_app.version, 1), 1);

  select coalesce(
           (select p.full_name from public.portal_profiles p where p.auth_user_id = v_uid limit 1),
           (select c.name from public.cms_users c where c.auth_user_id = v_uid limit 1),
           'System'
         ) into v_name;

  update public.enrollment_applications
    set status = 'submitted',
        submitted_at = now(),
        submitted_by = v_uid,
        reference = v_ref,
        version = v_version,
        data = coalesce(p_snapshot, data)
    where id = p_application_id;

  insert into public.enrollment_application_versions
    (application_id, version, snapshot, created_by, created_by_name)
  values
    (p_application_id, v_version, coalesce(p_snapshot, jsonb_build_object()), v_uid, v_name);

  return v_ref;
end;
$fn$;

commit;
