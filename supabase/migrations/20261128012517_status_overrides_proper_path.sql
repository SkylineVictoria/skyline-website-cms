-- STATUS-OVERRIDES (owner, 2026-11-27): the Admin "Change status to" overrides (application_status_transitions, action_key set_*)
-- keep only corrections between the early statuses (Draft, Submitted, Action required, Offer issued, Offer accepted; Under review
-- as a source only, it is legacy) and the endings (Rejected, Withdrawn). Turned off (is_active = false, reversible in Settings ›
-- Application statuses): every override into CoE / VoE issued (skips Issue CoE / VoE: no document or number), Enrolled (skips Mark
-- as enrolled: no start date, no Qualification placement), Active (set by the Qualification; already refused) and Under review
-- (legacy), and every override out of CoE / VoE issued, Enrolled and Active (Withdraw / Reject stay as the proper actions).
-- The proper path: Offer accepted -> Issue CoE / VoE -> Mark as enrolled -> Active (automatic) -> Completed (automatic).
-- No application row is changed; the proper (non set_*) transitions are untouched.
do $$
declare v_off integer; v_keep integer;
begin
  update public.application_status_transitions
     set is_active = false
   where action_key like 'set\_%' and is_active
     and not (from_status in ('draft', 'submitted', 'under_review', 'action_required', 'offer_issued', 'offer_accepted', 'rejected', 'withdrawn')
              and to_status in ('draft', 'submitted', 'action_required', 'offer_issued', 'offer_accepted', 'rejected', 'withdrawn'));
  get diagnostics v_off = row_count;
  select count(*) into v_keep from public.application_status_transitions where action_key like 'set\_%' and is_active;
  raise notice 'STATUS-OVERRIDES: % overrides turned off, % kept', v_off, v_keep;
end $$;
