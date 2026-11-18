-- ALLOCATIONS-TEST-ONLY (owner, 2026-11-19): permanent student allocations (lms_intake_students) stay permanent for real students, but a
-- test account's allocation (an @blackhole.postmarkapp.com address: the View-as test student, zz-test students) can be deleted, so a test
-- intake can be removed. Deleting an intake that holds a real student's allocation is refused with a clear message (close it instead).
-- Patched in place: lms_allocation_private.preserve_allocation, rto_admin('intake_delete').
-- Rollback (manual): restore preserve_allocation to raise unconditionally; remove the added check in intake_delete.
create or replace function lms_allocation_private.preserve_allocation() returns trigger
language plpgsql set search_path to '' as $function$
begin
  if tg_op = 'DELETE' and exists (select 1 from public.enrollment_students s
      where s.id = old.student_id and lower(coalesce(s.email, '')) like '%@blackhole.postmarkapp.com') then
    return old;  -- test accounts only
  end if;
  raise exception 'Student allocations are permanent. Their original intake and dates must be retained.' using errcode='23514';
end $function$;

do $$
declare d text := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 a text := '  if exists(select 1 from public.course_completions cc join public.batches bb on bb.id = cc.batch_id where bb.intake_id = v_id) then';
 b text := '  if exists(select 1 from public.lms_intake_students ls join public.enrollment_students st on st.id = ls.student_id
     where ls.intake_id = v_id and lower(coalesce(st.email, '''')) not like ''%@blackhole.postmarkapp.com'') then
   raise exception ''Students are permanently allocated to this intake, so it cannot be deleted. Close it instead.'' using errcode = ''23503'';
  end if;
' || a;
begin
 if position('permanently allocated to this intake' in d) > 0 then return; end if;
 if position(a in d) = 0 then raise exception 'rto_admin intake_delete anchor not found'; end if;
 execute replace(d, a, b);
end $$;
