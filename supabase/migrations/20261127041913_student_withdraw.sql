-- STUDENT-WITHDRAW (owner, 2026-11-26: "allow him to change status for his application"): the student changes their own application's
-- status the one way a student may: Withdraw, with a reason, while it has not reached CoE / VoE issued (draft, submitted, under review,
-- action required, offer letter issued, offer accepted). Staff moves (offer, CoE, enrol, reject) stay staff-only. The change goes
-- through the same status command as staff changes (history row with the reason, audit log, admission event to SLIT and the agent).

create or replace function public.portal_student_withdraw(p_application uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare a public.enrollment_applications; v_reason text := left(btrim(coalesce(p_reason, '')), 500); v_hist uuid;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if a.id is null or not skyline_private.is_application_student(a.id) then
    raise exception 'Only the student can withdraw their own application' using errcode = '42501';
  end if;
  if a.status not in ('draft', 'submitted', 'under_review', 'action_required', 'offer_issued', 'offer_accepted') then
    raise exception 'This application can no longer be withdrawn here (%). Contact SLIT admissions', public.portal_status_label(a.status) using errcode = '22023';
  end if;
  if length(v_reason) < 5 then raise exception 'Tell us briefly why you are withdrawing (at least 5 characters)' using errcode = '22023'; end if;
  perform set_config('portal.status_command', a.id::text, true);
  perform set_config('portal.status_note', 'Withdrawn by the student — ' || v_reason, true);
  update public.enrollment_applications set status = 'withdrawn' where id = a.id;
  select h.id into v_hist from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = 'withdrawn' order by h.created_at desc limit 1;
  update public.enrollment_application_status_history set action_key = 'student_withdraw', reason = 'Student request' where id = v_hist;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), coalesce(auth.jwt()->>'email', 'Student'), 'student', 'status_change', 'application', a.id::text, a.id,
    jsonb_build_object('from', a.status, 'to', 'withdrawn', 'note', v_reason, 'by', 'student'));
  insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
  values (a.id, a.tenant_id, 'application_status_changed', jsonb_build_object('from', a.status, 'to', 'withdrawn', 'actor', auth.uid(), 'by', 'student'));
  perform set_config('portal.status_command', '', true);
  return jsonb_build_object('status', 'withdrawn', 'label', public.portal_status_label('withdrawn'), 'from', a.status);
end $$;
revoke all on function public.portal_student_withdraw(uuid, text) from public, anon;
grant execute on function public.portal_student_withdraw(uuid, text) to authenticated;
