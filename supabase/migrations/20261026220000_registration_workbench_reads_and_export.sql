-- P08-02: reads, minimized export and audit for the manual registration workbench.
-- Everything here is reviewer-only (portal_is_slit_admin + portal_can_access_application, the same authority as the writes of
-- P08-01) and follows the caller's tenant scope. No automated government interaction exists or is added.
-- The workbench list flags every application that reads coe_issued/enrolled without a verified registration (a warning, never a block,
-- per the owner decision), and the same condition can later feed reconciliation (P08-03).
-- Export minimization: portal_registration_export returns a fixed set of columns (reference, student name, intake, course codes,
-- application status, registration state, CoE number, lodged/verified dates) for explicitly named applications only; it never returns
-- contact details, identity documents, passport data, evidence text or internal ids, and every export is audited.
-- Confirmation is audited: creating a registration and every transition (lodged, verified with the CoE number, cancelled) also write
-- portal_audit_log entries visible on the Audit Log page, in addition to the registration's own append-only history.
--
-- Rollback / compensation (additive; run manually):
--   drop function if exists public.portal_registration_workbench(), public.portal_registration_detail(uuid), public.portal_registration_export(uuid[]);
--   re-create portal_registration_create / portal_registration_transition as in 20261026210000 (without the audit insert).
-- Never applied to the hosted project without release approval.
begin;

create or replace function public.portal_registration_create(p_application uuid, p_note text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_id uuid; v_name text;
begin
  a := public.portal_registration_authority(p_application);
  if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'Registration starts after the offer is accepted' using errcode = '22023'; end if;
  if exists (select 1 from public.enrollment_registrations where application_id = a.id and state <> 'cancelled') then raise exception 'This application already has an active registration' using errcode = '23505'; end if;
  insert into public.enrollment_registrations(application_id, tenant_id, created_by) values (a.id, a.tenant_id, auth.uid()) returning id into v_id;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (v_id, a.tenant_id, null, 'draft', auth.uid(), v_name, left(coalesce(p_note, ''), 500));
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_name, 'slit_admin', 'registration_created', 'registration', v_id::text, a.id, jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
  return v_id;
end;
$$;

create or replace function public.portal_registration_transition(p_registration uuid, p_to text, p_coe_number text default null, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_coe text; v_name text; v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))) then
    raise exception 'Invalid registration transition: % to %', r.state, p_to using errcode = '22023';
  end if;
  if p_to = 'lodged' then
    update public.enrollment_registrations set state = 'lodged', lodged_at = now(), lodged_by = auth.uid(), updated_at = now() where id = r.id;
  elsif p_to = 'verified' then
    if a.status not in ('coe_issued', 'enrolled') then raise exception 'The application must show coe_issued before registration can be verified' using errcode = '22023'; end if;
    v_coe := upper(trim(coalesce(p_coe_number, '')));
    if v_coe !~ '^[A-Z0-9-]{6,20}$' then raise exception 'A CoE number of 6-20 letters, digits or hyphens is required' using errcode = '22023'; end if;
    if not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'verified', coe_number = v_coe, verified_at = now(), verified_by = auth.uid(), updated_at = now() where id = r.id;
  else
    if v_note = '' then raise exception 'A reason is required to cancel' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_note, updated_at = now() where id = r.id;
  end if;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (r.id, r.tenant_id, r.state, p_to, auth.uid(), v_name, v_note);
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_name, 'slit_admin', 'registration_' || p_to, 'registration', r.id::text, a.id,
    jsonb_build_object('from', r.state, 'to', p_to, 'note', v_note) || case when p_to = 'verified' then jsonb_build_object('coeNumber', v_coe) else '{}'::jsonb end);
end;
$$;

create function public.portal_registration_workbench() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.portal_is_slit_admin() then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x.row order by x.warn desc, x.reference) from (
    select
      (a.status in ('coe_issued', 'enrolled') and not exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified')) as warn,
      coalesce(nullif(a.reference, ''), left(a.id::text, 8)) as reference,
      jsonb_build_object(
        'applicationId', a.id, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', a.student_name, 'status', a.status, 'intake', a.intake,
        'warning', (a.status in ('coe_issued', 'enrolled') and not exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified')),
        'registration', (select jsonb_build_object('id', r.id, 'state', r.state, 'coeNumber', r.coe_number, 'lodgedAt', r.lodged_at, 'verifiedAt', r.verified_at, 'cancelledAt', r.cancelled_at,
            'evidenceCount', (select count(*) from public.enrollment_registration_evidence e where e.registration_id = r.id))
          from public.enrollment_registrations r where r.application_id = a.id order by (r.state <> 'cancelled') desc, r.created_at desc limit 1)) as row
    from public.enrollment_applications a
    where a.status in ('offer_accepted', 'coe_issued', 'enrolled') and public.portal_can_access_application(a.id)
    order by a.created_at desc limit 200) x), '[]'::jsonb);
end;
$$;

create function public.portal_registration_detail(p_registration uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications;
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  select * into a from public.enrollment_applications where id = r.application_id;
  if not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'application', jsonb_build_object('id', a.id, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', a.student_name, 'status', a.status),
    'registration', jsonb_build_object('id', r.id, 'state', r.state, 'coeNumber', r.coe_number, 'lodgedAt', r.lodged_at, 'verifiedAt', r.verified_at, 'cancelledAt', r.cancelled_at, 'cancelReason', r.cancel_reason),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'description', e.description, 'documentId', e.document_id, 'recordedAt', e.recorded_at,
        'recordedBy', coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = e.recorded_by limit 1), (select c.name from public.cms_users c where c.auth_user_id = e.recorded_by limit 1), 'Reviewer')) order by e.recorded_at, e.id)
      from public.enrollment_registration_evidence e where e.registration_id = r.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('from', h.from_state, 'to', h.to_state, 'actor', h.actor_name, 'note', h.note, 'at', h.created_at) order by h.id)
      from public.enrollment_registration_history h where h.registration_id = r.id), '[]'::jsonb));
end;
$$;

create function public.portal_registration_export(p_applications uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.portal_is_slit_admin() then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  if p_applications is null or cardinality(p_applications) = 0 or cardinality(p_applications) > 500 then raise exception 'Name between 1 and 500 applications to export' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', a.student_name, 'intake', a.intake,
      'courses', coalesce((select string_agg(c.course_code, '; ' order by c.course_code) from public.enrollment_application_courses c where c.application_id = a.id), ''),
      'applicationStatus', a.status,
      'registrationState', coalesce(r.state, 'none'), 'coeNumber', r.coe_number, 'lodgedAt', r.lodged_at, 'verifiedAt', r.verified_at) order by a.reference nulls last, a.id), '[]'::jsonb)
  into v_rows
  from public.enrollment_applications a
  left join lateral (select * from public.enrollment_registrations x where x.application_id = a.id order by (x.state <> 'cancelled') desc, x.created_at desc limit 1) r on true
  where a.id = any (p_applications) and public.portal_can_access_application(a.id);
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, detail)
  values (auth.uid(), coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer'),
    'slit_admin', 'registration_exported', 'registration', 'export', jsonb_build_object('requested', cardinality(p_applications), 'exported', jsonb_array_length(v_rows)));
  return v_rows;
end;
$$;

revoke all on function public.portal_registration_workbench(), public.portal_registration_detail(uuid), public.portal_registration_export(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.portal_registration_workbench(), public.portal_registration_detail(uuid), public.portal_registration_export(uuid[]) to authenticated;

commit;
