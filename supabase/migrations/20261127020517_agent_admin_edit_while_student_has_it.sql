-- ONE-PAGE-EDIT-ALL (owner, 2026-11-26: "allow Agent and SLIT admin to EDIT also and sign and declaration can only be done by student"):
-- while the student has the application (with_student) the agent and SLIT admins may edit it too; only the student ticks the
-- declarations and signs (student_sign is unchanged). Once the student has signed and a parent / guardian is to sign
-- (waiting_guardian) nobody but the student side changes it. Concurrent saves are still caught by the draft version.
-- Down: put 'with_student' back in the non-student list.
begin;

create or replace function skyline_private.handoff_blocks_edit(p_application uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select case when skyline_private.is_application_student(p_application)
      then h.state in ('with_agent', 'change_requested', 'waiting_guardian')
      else h.state = 'waiting_guardian' end
    from skyline_private.application_handoffs h where h.application_id = p_application), false);
$$;

commit;
