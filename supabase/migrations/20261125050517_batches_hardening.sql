-- LMS-BATCHES hardening (2026-11-25, get_advisors after the batch migrations): the new trigger functions and internal helpers are not
-- callable through the API (they run inside security-definer functions and triggers); only asm_master_window (assignment screen) and
-- rto_batches (checks Admin / RTO Manager itself) stay callable by signed-in users. lms_gen_batch_ok gets a fixed search_path.
-- Down: grant execute on the listed functions to authenticated (and anon as before); alter function public.lms_gen_batch_ok(uuid) reset search_path.
begin;
alter function public.lms_gen_batch_ok(uuid) set search_path to 'public';
revoke all on function
  public.intake_batch_fill(), public.class_sessions_batch_defaults(),
  public.intake_first_batch(uuid), public.course_master_kind_for(text, text), public.course_master_cycle_for(text, text),
  public.course_master_rows(text, text, integer), public.intake_master_unit(uuid, text), public.enrolment_unit_batch(uuid, text),
  public.enrolment_in_session(uuid, uuid, text), public.batch_for_allocation(uuid, uuid, text), public.session_trainer_ids_b(uuid, uuid, text),
  public.lms_gen_batch_ok(uuid)
  from public, anon, authenticated;
revoke all on function public.asm_master_window(uuid, uuid), public.rto_batches(text, jsonb) from public, anon;
grant execute on function public.asm_master_window(uuid, uuid), public.rto_batches(text, jsonb) to authenticated;
commit;
