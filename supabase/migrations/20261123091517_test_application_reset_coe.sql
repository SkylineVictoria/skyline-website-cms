-- TEST-RESET-COE (2026-11-23, owner): put a TEST application (enrollment_applications.is_test) back from Enrolled to CoE / VoE issued so the
-- enrol -> student mailbox dialog can be tried again. revert_application_status only undoes a reasoned move by the same admin within 15
-- seconds, so this is its own admin-only command. It refuses any application not marked TEST.
--  * Status: the admissions status command flags (portal.status_command / status_note) as every status change; no student / agent email
--    (portal.status_notify off); the history row gets action_key test_reset. The student profile link is kept.
--  * Mailbox markers: the application's student_mailbox_skipped / _failed audit rows (what Email Management > Enrolled, no mailbox yet
--    shows) are removed, copied into the reset's own audit row. A Skyline mailbox record without a Microsoft 365 user is removed; one
--    with a Microsoft 365 user is kept and reported (a real account is never orphaned).
--  * Logged in portal_audit_log as test_application_reset.
-- Run as a SLIT admin (supabase.rpc('admin_test_application_reset_coe', { p_application })) or from the SQL editor / CLI as postgres.

create or replace function public.admin_test_application_reset_coe(p_application uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $f$
declare a public.enrollment_applications; m public.student_office365_accounts; v_markers jsonb; v_mailbox text := 'none'; v_hist uuid;
 v_actor text;
begin
 if auth.uid() is not null then
  if not public.portal_is_slit_admin() then raise exception 'SLIT admin access required' using errcode = '42501'; end if;
 elsif session_user not in ('postgres', 'supabase_admin') and coalesce(auth.role(), '') <> 'service_role' then
  raise exception 'SLIT admin access required' using errcode = '42501';
 end if;
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found then raise exception 'Application not found' using errcode = 'P0002'; end if;
 if auth.uid() is not null and not public.portal_can_access_application(a.id) then raise exception 'SLIT admin access required' using errcode = '42501'; end if;
 if not coalesce(a.is_test, false) then
  raise exception 'Only an application marked TEST can be reset (this one is a real application)' using errcode = '42501';
 end if;
 if a.status = 'coe_issued' then
  return jsonb_build_object('status', 'coe_issued', 'label', public.portal_status_label('coe_issued'), 'changed', false);
 end if;
 if a.status <> 'enrolled' then
  raise exception 'Only an Enrolled test application goes back to CoE / VoE issued (it is %)', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 v_actor := coalesce((select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email',
  case when auth.uid() is null then 'Test reset (SQL)' else 'Authorized reviewer' end);

 -- Mailbox markers of this application.
 with gone as (
  delete from public.portal_audit_log g where g.application_id = a.id and g.action in ('student_mailbox_skipped', 'student_mailbox_failed')
  returning g.action, g.created_at, g.actor_name, g.detail)
 select coalesce(jsonb_agg(jsonb_build_object('action', action, 'at', created_at, 'by', actor_name, 'detail', detail)), '[]'::jsonb) into v_markers from gone;
 select * into m from public.student_office365_accounts where student_id = a.student_id for update;
 if found then
  if m.ms_user_id is null then
   delete from public.student_office365_accounts where student_id = a.student_id;
   v_mailbox := 'removed';
  else
   v_mailbox := 'kept: Microsoft 365 account ' || coalesce(m.upn, m.ms_user_id::text);
  end if;
 end if;

 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', 'Test reset: back to ' || public.portal_status_label('coe_issued') || coalesce(' — ' || nullif(left(btrim(p_note), 300), ''), ''), true);
 perform set_config('portal.status_notify', 'off', true);
 update public.enrollment_applications set status = 'coe_issued' where id = a.id;
 perform set_config('portal.status_command', '', true);
 perform set_config('portal.status_note', '', true);
 perform set_config('portal.status_notify', '', true);
 select h.id into v_hist from public.enrollment_application_status_history h
  where h.application_id = a.id and h.previous_status = 'enrolled' and h.new_status = 'coe_issued' order by h.created_at desc limit 1;
 update public.enrollment_application_status_history set action_key = 'test_reset', payload = jsonb_build_object('test_reset', true)
  where id = v_hist;

 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
 values (auth.uid(), v_actor, case when auth.uid() is null then 'system' else 'slit_admin' end, 'test_application_reset', 'application', a.id::text,
  a.id, a.agency_id, a.tenant_id, jsonb_build_object('from', a.status, 'to', 'coe_issued', 'student', a.student_id, 'mailbox', v_mailbox,
   'markersRemoved', v_markers, 'note', nullif(left(btrim(coalesce(p_note, '')), 300), '')));
 return jsonb_build_object('status', 'coe_issued', 'label', public.portal_status_label('coe_issued'), 'changed', true,
  'mailbox', v_mailbox, 'markersRemoved', jsonb_array_length(v_markers));
end $f$;
revoke all on function public.admin_test_application_reset_coe(uuid, text) from public, anon;
grant execute on function public.admin_test_application_reset_coe(uuid, text) to authenticated, service_role;
