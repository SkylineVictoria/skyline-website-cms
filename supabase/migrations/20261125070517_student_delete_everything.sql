-- STUDENT-DELETE-EVERYTHING (owner 2026-11-25): "allow delete with asking it has associated this, Do you really want to
-- delete, and if user says yes allow delete". Chosen: Yes permanently deletes ANY student (real or test, enrolled or not)
-- with everything linked to them. This replaces, for the Students list's Delete, today's archive rule (20261125042517) and
-- the CoE / VoE refusal (20261104240000); admin_student_delete itself is left as it is.
-- * admin_student_links(student): what the student is linked to (rows per table pointing at the student or one of their
--   applications), shown in the confirmation.
-- * admin_student_purge(student, 'DELETE'): queues the application files for removal, then deletes the applications one by
--   one and the student, following every foreign key down the tree (rows that need a deleted row are deleted first).
--   Audit / log rows whose link may be empty keep their row with the link cleared.
-- * admin_purge_rows: internal helper, never granted to users.
-- * lms_allocation_private.preserve_allocation (permanent intake / unit allocations) lets a delete through only for the student
--   being deleted by admin_student_purge (setting skyline.purging_student); otherwise unchanged from 20261125011517.
-- Down: re-run preserve_allocation from 20261125011517; drop function public.admin_student_purge(uuid, text), public.admin_student_links(uuid),
--       public.admin_purge_rows(regclass, name, text[], int).
begin;

create or replace function lms_allocation_private.preserve_allocation()
 returns trigger language plpgsql set search_path to ''
as $function$
begin
 if tg_op = 'DELETE' and exists (select 1 from public.enrollment_students s where s.id = old.student_id and lower(coalesce(s.email, '')) like '%@blackhole.postmarkapp.com') then
  return old;
 end if;
 -- STUDENT-DELETE-EVERYTHING: the confirmed delete of this one student (admin_student_purge).
 if tg_op = 'DELETE' and current_setting('skyline.purging_student', true) = old.student_id::text then
  return old;
 end if;
 -- Nested: lms_intake_students has no unit_id, and Postgres does not promise to stop evaluating an AND early.
 if tg_op = 'UPDATE' and tg_table_name = 'lms_unit_students' then
  if new.intake_id is not distinct from old.intake_id and new.unit_id is not distinct from old.unit_id
     and new.student_id is not distinct from old.student_id and new.course_id is not distinct from old.course_id
     and new.allocated_at is not distinct from old.allocated_at
     and new.assigned_start_date is not distinct from old.assigned_start_date and new.assigned_end_date is not distinct from old.assigned_end_date
     and new.carried_from_intake_id is not distinct from old.carried_from_intake_id then
   return new;
  end if;
 end if;
 raise exception 'Student allocations are permanent. Their original intake and dates must be retained.' using errcode='23514';
end $function$;

create function public.admin_purge_rows(p_table regclass, p_col name, p_vals text[], p_depth int default 0) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  fk record; v_type text; v_refvals text[]; v_nullable boolean; v_keep boolean;
begin
  if p_vals is null or cardinality(p_vals) = 0 then return; end if;
  if p_depth > 10 then raise exception 'Delete stopped: the records are linked too deeply (%).', p_table using errcode = '54001'; end if;
  select format_type(a.atttypid, a.atttypmod) into v_type from pg_attribute a where a.attrelid = p_table and a.attname = p_col;
  for fk in
    select c.conrelid::regclass as child, c.confdeltype,
           (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as child_col,
           (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) as ref_col,
           (select not attnotnull from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as nullable
      from pg_constraint c
     where c.contype = 'f' and c.confrelid = p_table and cardinality(c.conkey) = 1
  loop
    -- ON DELETE SET NULL / SET DEFAULT is done by the database itself.
    if fk.confdeltype in ('n', 'd') then continue; end if;
    execute format('select array_agg(distinct %I::text) from %s where %I = any($1::%s[])', fk.ref_col, p_table, p_col, v_type)
       into v_refvals using p_vals;
    if v_refvals is null then continue; end if;
    v_nullable := fk.nullable;
    v_keep := fk.child::text ~ '(audit|_log$|_logs$|history)';
    if fk.child = p_table then
      -- A row pointing at another row of the same table: clear the link (or delete with the rest).
      if v_nullable then
        execute format('update %s set %I = null where %I::text = any($1)', fk.child, fk.child_col, fk.child_col) using v_refvals;
      end if;
    elsif v_keep and v_nullable then
      execute format('update %s set %I = null where %I::text = any($1)', fk.child, fk.child_col, fk.child_col) using v_refvals;
    else
      perform public.admin_purge_rows(fk.child, fk.child_col, v_refvals, p_depth + 1);
    end if;
  end loop;
  execute format('delete from %s where %I = any($1::%s[])', p_table, p_col, v_type) using p_vals;
end $fn$;
revoke all on function public.admin_purge_rows(regclass, name, text[], int) from public, anon, authenticated;

create function public.admin_student_links(p_student uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare fk record; v_apps text[]; v_n bigint; v_out jsonb := '[]'::jsonb; v_target text;
begin
  perform public.admin_business_require();
  if not exists (select 1 from public.enrollment_students where id = p_student) then
    raise exception 'Student not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(id::text), '{}') into v_apps from public.enrollment_applications where student_id = p_student;
  for fk in
    select c.conrelid::regclass as child, c.confrelid::regclass as parent,
           (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as child_col
      from pg_constraint c
     where c.contype = 'f' and cardinality(c.conkey) = 1
       and c.confrelid in ('public.enrollment_students'::regclass, 'public.enrollment_applications'::regclass)
       and c.conrelid <> c.confrelid
  loop
    if fk.parent = 'public.enrollment_students'::regclass then
      execute format('select count(*) from %s where %I::text = $1', fk.child, fk.child_col) into v_n using p_student::text;
    elsif cardinality(v_apps) > 0 then
      execute format('select count(*) from %s where %I::text = any($1)', fk.child, fk.child_col) into v_n using v_apps;
    else v_n := 0; end if;
    if v_n > 0 then
      v_target := replace(fk.child::text, 'public.', '');
      v_out := v_out || jsonb_build_object('table', v_target, 'count', v_n);
    end if;
  end loop;
  return jsonb_build_object('applications', cardinality(v_apps), 'links', v_out);
end $fn$;
revoke all on function public.admin_student_links(uuid) from public, anon;
grant execute on function public.admin_student_links(uuid) to authenticated;

create function public.admin_student_purge(p_student uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare s public.enrollment_students; app record; v_apps int := 0; v_files int := 0; n int;
begin
  perform public.admin_business_require();
  if p_confirm is distinct from 'DELETE' then raise exception 'Confirm the delete first.' using errcode = '22023'; end if;
  select * into s from public.enrollment_students where id = p_student for update;
  if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
  perform set_config('skyline.deleting_student', s.id::text, true);
  perform set_config('skyline.purging_student', s.id::text, true);
  perform set_config('rto.carry_over_planning', 'on', true);
  for app in select e.id, e.reference from public.enrollment_applications e where e.student_id = s.id for update loop
    insert into public.storage_cleanup_queue(bucket_name, storage_path, reason, requested_by)
    select d.bucket_name, d.storage_path, 'student deleted: ' || coalesce(app.reference, app.id::text), auth.uid()
      from public.enrollment_application_documents d where d.application_id = app.id and coalesce(d.storage_path, '') <> '';
    get diagnostics n = row_count; v_files := v_files + n;
    perform set_config('portal.draft_command', app.id::text, true);
    perform public.admin_purge_rows('public.enrollment_applications'::regclass, 'id', array[app.id::text]);
    v_apps := v_apps + 1;
  end loop;
  perform set_config('portal.draft_command', '', true);
  perform public.admin_purge_rows('public.enrollment_students'::regclass, 'id', array[s.id::text]);
  perform set_config('skyline.deleting_student', '', true);
  perform set_config('skyline.purging_student', '', true);
  perform set_config('rto.carry_over_planning', '', true);
  perform public.admin_business_audit('student_deleted', s.agency_id, s.agency_id,
    jsonb_build_object('student', s.id, 'name', s.full_name, 'email', s.email, 'applicationsDeleted', v_apps, 'everything', true));
  return jsonb_build_object('studentId', s.id, 'deleted', true, 'applicationsDeleted', v_apps, 'filesQueued', v_files);
end $fn$;
revoke all on function public.admin_student_purge(uuid, text) from public, anon;
grant execute on function public.admin_student_purge(uuid, text) to authenticated;

commit;
