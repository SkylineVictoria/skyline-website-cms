-- Migration 93 (P08-06): submission PDF for the application_submitted email. Additive; local only until released.
-- The worker renders a PDF of the immutable submitted version at send time (in memory only). This migration adds the per-institution option
-- ("attach" the PDF, or include a secure link to the application, which needs a sign-in) and the lease-checked read the worker uses.
-- Default is "attach". The snapshot is released only to the service role, only for a delivery that is currently claimed (state sending,
-- matching lease) and only for the application_submitted event; delivery rows keep the reference-level subject and body, never the form content.
-- The link is https://<verified hostname>/agency/applications/<application id> (legacy scope: slit.edu.au) and is protected by the normal sign-in and RLS.
-- Rollback (manual): drop function public.notification_delivery_submission(uuid, uuid), public.notification_attachment_state(uuid),
--   public.notification_save_attachment_mode(uuid, text); drop table public.notification_attachment_settings.
begin;

create table public.notification_attachment_settings(
  tenant_id uuid references public.tenants(id),
  submission_pdf text not null check (submission_pdf in ('attach', 'link')),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index notification_attachment_settings_scope on public.notification_attachment_settings((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)));
alter table public.notification_attachment_settings enable row level security;
revoke all on public.notification_attachment_settings from public, anon, authenticated, service_role;
grant select on public.notification_attachment_settings to service_role;

create function public.notification_attachment_state(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.notification_sender_admin(p_tenant) then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  return jsonb_build_object('submissionPdf', coalesce((select s.submission_pdf from public.notification_attachment_settings s where s.tenant_id is not distinct from p_tenant), 'attach'));
end;
$$;

create function public.notification_save_attachment_mode(p_tenant uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.notification_sender_admin(p_tenant) then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('attach', 'link') then raise exception 'Choose to attach the PDF or to send a secure link' using errcode = '22023'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Organization not found' using errcode = 'P0002'; end if;
  insert into public.notification_attachment_settings(tenant_id, submission_pdf, updated_by) values (p_tenant, p_mode, auth.uid())
  on conflict ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))) do update set submission_pdf = excluded.submission_pdf, updated_by = excluded.updated_by, updated_at = now();
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'notification_attachment_mode', jsonb_build_object('submissionPdf', p_mode));
  return jsonb_build_object('submissionPdf', p_mode);
end;
$$;

create function public.notification_delivery_submission(p_id uuid, p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.notification_deliveries; o public.admission_event_outbox; a public.enrollment_applications; v_mode text; v_version integer; v_snapshot jsonb; v_created timestamptz; v_host text;
begin
  select * into d from public.notification_deliveries x where x.id = p_id and x.lease_token = p_lease and x.state = 'sending' and x.event = 'application_submitted';
  if not found then return null; end if;
  select * into o from public.admission_event_outbox where id = d.outbox_id;
  select * into a from public.enrollment_applications where id = d.application_id;
  v_mode := coalesce((select s.submission_pdf from public.notification_attachment_settings s where s.tenant_id is not distinct from d.tenant_id), 'attach');
  v_version := coalesce(case when (o.payload->>'version') ~ '^[0-9]{1,9}$' then (o.payload->>'version')::integer end,
    (select max(v.version) from public.enrollment_application_versions v where v.application_id = d.application_id));
  select v.snapshot, v.created_at into v_snapshot, v_created from public.enrollment_application_versions v where v.application_id = d.application_id and v.version = v_version;
  v_host := case when d.tenant_id is null then 'slit.edu.au'
    else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = d.tenant_id and t.verified_at is not null) end;
  return jsonb_build_object(
    'mode', v_mode,
    'link', case when v_host is null then '' else 'https://' || v_host || '/agency/applications/' || d.application_id::text end,
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'version', coalesce(v_version, 0),
    'institution', coalesce((select t.name from public.tenants t where t.id = d.tenant_id), 'Skyline Institute of Technology'),
    'submittedAt', v_created,
    'snapshot', case when v_mode = 'attach' then v_snapshot else null end);
end;
$$;

revoke all on function public.notification_attachment_state(uuid), public.notification_save_attachment_mode(uuid, text), public.notification_delivery_submission(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.notification_attachment_state(uuid), public.notification_save_attachment_mode(uuid, text) to authenticated;
grant execute on function public.notification_delivery_submission(uuid, uuid) to service_role;

commit;
