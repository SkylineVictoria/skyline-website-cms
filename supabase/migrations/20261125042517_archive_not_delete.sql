-- LMS-BATCHES step 9 (2026-11-25, owner: archive, never delete student / intake / batch / unit / course IDs; test zone):
-- * archived_at (+ archive_reason) on course_intakes, intake_enrolments, intake_units, cms_courses, cms_course_units, enrollment_students.
-- * The LMS links to an intake, course, student, batch or course unit that were ON DELETE CASCADE become RESTRICT (other modules'
--   links — agency, sign, practice, Office 365 — are unchanged).
-- * Delete becomes archive: intake (rto_admin intake_delete, course_intakes_admin delete) -> intake closed + archived, its batches and
--   memberships archived, active enrolments withdrawn and archived (students wait for staff to re-place them, as before), application
--   choices cleared; course (rto_course_delete) -> Draft, inactive, archived, units archived; a course unit removed from a course ->
--   inactive + archived; a student (admin_student_delete) -> Inactive + archived.
-- * Still truly deleted (owner): unfinished wizard intakes (lms_intake_purge) and test accounts (@blackhole.postmarkapp.com).
-- * Not changed, owner to decide: rto_course_delete_all ("delete the course with everything", 2026-11-24) still deletes everything.
-- Down: restore the FKs to ON DELETE CASCADE; re-run the patched functions from their previous definitions; drop lms_intake_purge /
--       lms_intake_archive and the archive columns.
begin;

create or replace function pg_temp.rpatch(p_name text, p_args text, p_pattern text, p_new text, p_expect int default 1) returns void
language plpgsql as $$
declare v_oid oid; d text; n int;
begin
  select p.oid into strict v_oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_name
     and (p_args is null or pg_get_function_identity_arguments(p.oid) = p_args);
  d := pg_get_functiondef(v_oid);
  select count(*) into n from regexp_matches(d, p_pattern, 'g');
  if n <> p_expect then raise exception 'rpatch %(%): expected % match(es) of [%], found %', p_name, p_args, p_expect, p_pattern, n; end if;
  execute regexp_replace(d, p_pattern, p_new, 'g');
end $$;
-- Literal snippet (single spaces = any whitespace) to a regex.
create or replace function pg_temp.lit(p text) returns text language sql as $$
  select regexp_replace(regexp_replace(p, '([.*+?^${}()|\[\]\\])', '\\\1', 'g'), ' ', '\s+', 'g');
$$;

alter table public.course_intakes add column archived_at timestamptz, add column archive_reason text check (archive_reason is null or char_length(archive_reason) <= 500);
alter table public.intake_enrolments add column archived_at timestamptz;
alter table public.intake_units add column archived_at timestamptz;
alter table public.cms_courses add column archived_at timestamptz;
alter table public.cms_course_units add column archived_at timestamptz;
alter table public.enrollment_students add column archived_at timestamptz;

-- CASCADE -> RESTRICT on the LMS links.
do $$
declare c record;
begin
  for c in
    select con.conname, con.conrelid::regclass as tbl, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
     where con.contype = 'f' and con.confdeltype = 'c'
       and con.confrelid in ('public.course_intakes'::regclass, 'public.cms_courses'::regclass, 'public.enrollment_students'::regclass,
                             'public.intake_batches'::regclass, 'public.cms_course_units'::regclass)
       and con.conrelid in ('public.course_intakes'::regclass, 'public.course_fee_setups'::regclass, 'public.course_fee_items'::regclass,
                            'public.intake_units'::regclass, 'public.intake_enrolments'::regclass, 'public.lms_attendance_register'::regclass,
                            'public.sign_batch_sends'::regclass, 'public.lms_intake_students'::regclass, 'public.intake_trainers'::regclass,
                            'public.class_sessions'::regclass, 'public.intake_class_times'::regclass, 'public.intake_groups'::regclass,
                            'public.lms_unit_students'::regclass, 'public.intake_batches'::regclass, 'public.course_coe_timetables'::regclass,
                            'public.course_voe_calendars'::regclass, 'public.course_coe_units'::regclass, 'public.course_voe_units'::regclass,
                            'public.intake_enrolment_units'::regclass, 'public.rto_placement_overrides'::regclass)
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
    execute format('alter table %s add constraint %I %s', c.tbl, c.conname, replace(c.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  end loop;
end $$;
alter table public.intake_batches drop constraint intake_batches_intake_id_fkey;
alter table public.intake_batches add constraint intake_batches_intake_id_fkey foreign key (intake_id) references public.course_intakes(id) on delete restrict;

-- Truly delete an intake that holds no student records (unfinished wizard intakes).
create function public.lms_intake_purge(p_intake uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.lms_intake_students ls join public.enrollment_students st on st.id = ls.student_id
              where ls.intake_id = p_intake and lower(coalesce(st.email, '')) not like '%@blackhole.postmarkapp.com')
     or exists (select 1 from public.course_completions where intake_id = p_intake)
     or exists (select 1 from public.asm_assignments where intake_id = p_intake)
     or exists (select 1 from public.enrollment_application_courses where intake_id = p_intake)
     or exists (select 1 from public.lms_unit_students where carried_from_intake_id = p_intake) then
    raise exception 'This intake holds student records, so it is archived instead of deleted.' using errcode = '23503';
  end if;
  perform set_config('rto.carry_over_planning', 'on', true);
  delete from public.lms_attendance_marks m using public.lms_attendance_register g where m.register_id = g.id and g.intake_id = p_intake;
  delete from public.lms_attendance_register where intake_id = p_intake;
  delete from public.class_sessions where intake_id = p_intake;
  delete from public.intake_class_times where intake_id = p_intake;
  delete from public.intake_trainers where intake_id = p_intake;
  delete from public.lms_unit_students where intake_id = p_intake;
  delete from public.lms_intake_students where intake_id = p_intake;
  update public.intake_enrolments set continues_enrolment_id = null where continues_enrolment_id in (select e.id from public.intake_enrolments e where e.intake_id = p_intake);
  delete from public.lms_attendance_marks where enrolment_id in (select e.id from public.intake_enrolments e where e.intake_id = p_intake);
  delete from public.intake_enrolments where intake_id = p_intake;
  delete from public.intake_units where intake_id = p_intake;
  delete from public.intake_groups where intake_id = p_intake;
  delete from public.course_fee_items where intake_id = p_intake;
  delete from public.course_fee_setups where intake_id = p_intake;
  delete from public.sign_batch_sends where intake_id = p_intake;
  delete from public.intake_batches where intake_id = p_intake;
  delete from public.course_intakes where id = p_intake;
  perform set_config('rto.carry_over_planning', '', true);
end $$;

-- Archive an intake: nothing is deleted.
create function public.lms_intake_archive(p_intake uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare i public.course_intakes; v_n integer := 0; x record;
begin
  select * into i from public.course_intakes where id = p_intake for update;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if i.archived_at is not null then return jsonb_build_object('deleted', true, 'archived', true, 'freed', 0); end if;
  perform set_config('rto.carry_over_planning', 'on', true);
  -- the students wait for staff to choose a new intake (not placed back automatically)
  insert into public.rto_placement_overrides (student_id, course_id, enrolment_id, action, reason, detail)
  select distinct on (e.student_id) e.student_id, i.course_id, e.id, 'remove', 'Intake archived: choose a new intake for this student',
         jsonb_build_object('intake', i.start_date, 'intakeName', i.name)
    from public.intake_enrolments e where e.intake_id = p_intake and e.status in ('active', 'deferred');
  get diagnostics v_n = row_count;
  update public.intake_enrolments set status = 'withdrawn', archived_at = now() where intake_id = p_intake and status in ('active', 'deferred');
  update public.batch_students bs set archived_at = now(), archive_reason = 'Intake archived'
   where bs.archived_at is null and bs.batch_id in (select b.id from public.intake_batches b where b.intake_id = p_intake);
  update public.intake_batches set archived_at = now() where intake_id = p_intake and archived_at is null;
  for x in select distinct ac.application_id from public.enrollment_application_courses ac where ac.intake_id = p_intake loop
    perform set_config('portal.draft_command', x.application_id::text, true);
    update public.enrollment_application_courses set intake_id = null where intake_id = p_intake and application_id = x.application_id;
  end loop;
  perform set_config('portal.draft_command', '', true);
  update public.course_intakes set archived_at = now(), archive_reason = left(p_reason, 500), status = 'closed', is_active = false, updated_at = now(), updated_by = auth.uid()
   where id = p_intake;
  perform set_config('rto.carry_over_planning', '', true);
  return jsonb_build_object('deleted', true, 'archived', true, 'freed', v_n);
end $$;
revoke all on function public.lms_intake_purge(uuid), public.lms_intake_archive(uuid, text) from public, anon, authenticated;

-- rto_admin intake_delete: unfinished wizard intake -> purge, otherwise archive.
select pg_temp.rpatch('rto_admin', null,
  '(p_action\s*=\s*''intake_delete''\s*then).*?(elsif\s+p_action\s*=\s*''batch_save'')',
  '\1 v_id := nullif(d->>''intakeId'', '''')::uuid; if coalesce((select wizard_pending from public.course_intakes where id = v_id), false) then perform public.lms_intake_purge(v_id); return jsonb_build_object(''deleted'', true, ''archived'', false, ''freed'', 0); end if; return public.lms_intake_archive(v_id, nullif(d->>''reason'', '''')); \2');
-- rto_admin: a unit taken off a course is archived, not deleted.
select pg_temp.rpatch('rto_admin', null,
  pg_temp.lit('delete from public.cms_course_units u where u.course_id = v_course and u.id <> all(v_keep) and not exists(select 1 from public.intake_units s where s.unit_id = u.id);'),
  'update public.cms_course_units u set is_active = false, archived_at = coalesce(u.archived_at, now()) where u.course_id = v_course and u.id <> all(v_keep) and not exists(select 1 from public.intake_units s where s.unit_id = u.id);');
select pg_temp.rpatch('course_intakes_admin', null, pg_temp.lit('delete from public.course_intakes where id = p_id;'), 'perform public.lms_intake_archive(p_id, null);');
select pg_temp.rpatch('intake_wizard_cleanup', null, pg_temp.lit('delete from public.course_intakes ci where ci.wizard_pending'),
  'perform public.lms_intake_purge(ci.id) from public.course_intakes ci where ci.wizard_pending');
select pg_temp.rpatch('rto_intake_wizard', null, pg_temp.lit('delete from public.course_intakes ci where ci.course_id = v_course and ci.wizard_pending'),
  'perform public.lms_intake_purge(ci.id) from public.course_intakes ci where ci.course_id = v_course and ci.wizard_pending');
-- rto_course_delete (both versions): the course and its units are archived.
select pg_temp.rpatch('rto_course_delete', p.args, pg_temp.lit('delete from public.cms_course_units where course_id = p_course_id;'),
  'update public.cms_course_units set is_active = false, archived_at = coalesce(archived_at, now()) where course_id = p_course_id;')
  from (values ('p_course_id text'), ('p_course_id text, p_force boolean')) p(args);
select pg_temp.rpatch('rto_course_delete', p.args, pg_temp.lit('delete from public.cms_courses where id = p_course_id;'),
  'update public.cms_courses set is_active = false, status = ''Draft'', archived_at = coalesce(archived_at, now()) where id = p_course_id;')
  from (values ('p_course_id text'), ('p_course_id text, p_force boolean')) p(args);
-- admin_student_delete: real students are archived; test accounts are deleted with their LMS rows.
select pg_temp.rpatch('admin_student_delete', null, pg_temp.lit('if not found then raise exception ''Student not found'' using errcode = ''P0002''; end if;'),
  'if not found then raise exception ''Student not found'' using errcode = ''P0002''; end if; if lower(coalesce(s.email, '''')) not like ''%@blackhole.postmarkapp.com'' then update public.enrollment_students set status = ''Inactive'', archived_at = coalesce(archived_at, now()) where id = s.id; return jsonb_build_object(''deleted'', true, ''archived'', true, ''applicationsDeleted'', 0, ''filesQueued'', 0); end if;');
select pg_temp.rpatch('admin_student_delete', null, pg_temp.lit('delete from public.enrollment_students where id = s.id;'),
  'delete from public.lms_unit_students where student_id = s.id; delete from public.lms_intake_students where student_id = s.id; delete from public.lms_attendance_marks where enrolment_id in (select e.id from public.intake_enrolments e where e.student_id = s.id); update public.intake_enrolments set continues_enrolment_id = null where continues_enrolment_id in (select e.id from public.intake_enrolments e where e.student_id = s.id); delete from public.intake_enrolments where student_id = s.id; delete from public.rto_placement_overrides where student_id = s.id; delete from public.enrollment_students where id = s.id;');

commit;
