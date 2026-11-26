-- STUDENT-CHANGES-COURSE (owner, 2026-11-26): on an application the agent sent for review and signature, the student may change the
-- course and the intake themselves (dropdowns), instead of "Request a change". The agency / agent details and the fees stay the
-- agent's (fees follow the chosen course's fee setup). The usual checks still apply to what the student picks (an offered course,
-- an open intake of that course); the agent sees the change in "What the student changed" (the handoff diff).
-- Down: re-run skyline_private.handoff_view_only_fields from 20261125190517 and patch "if false and v_now" back to "if v_now".
begin;

create or replace function skyline_private.handoff_view_only_fields() returns text[]
language sql immutable set search_path to '' as $$
  select array['via_agent', 'agent_agency', 'agent_contact_name', 'agent_email', 'agent_phone', 'tuition_fee', 'fees']::text[];
$$;

-- The course rows may change too (the comparison that refused any change is switched off).
select public.business_rule_patch_function('public.portal_save_draft_v2(uuid, bigint, jsonb)'::regprocedure,
$old$if v_now is distinct from v_before then$old$,
$new$if false and v_now is distinct from v_before then$new$);

commit;
