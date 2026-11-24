-- AUTO-PLACE-SUBMITTED (owner, 2026-11-23: "active status move to intake automatically"): the Business Rule
-- students.auto_placement_application_states may now also list the stages before an offer (Submitted, Under review, Action
-- required), so a student can join the intake chosen on the application as soon as it is submitted. This only widens the
-- choices; the rule's value (today Offer accepted, CoE issued, Enrolled) is changed and published by an administrator in
-- Settings › Business Rules (Manage Rules), with its usual history. rto_auto_place_one, rto_auto_place_sweep and the
-- placement trigger already read the rule (20261121000517); a student leaves the intake only when the application is
-- withdrawn or rejected, so moving on to later stages keeps the placement.
-- Rollback: set registration->'allowed' back to ["Offer issued","Offer accepted","CoE issued","Enrolled"] (first remove the
--   new stages from the published value in Manage Rules).
begin;

update public.business_rules
set registration = jsonb_set(registration, '{allowed}',
  '["Submitted","Under review","Action required","Offer issued","Offer accepted","CoE issued","Enrolled"]'::jsonb)
where scope_key = '' and identifier = 'students.auto_placement_application_states';

commit;
