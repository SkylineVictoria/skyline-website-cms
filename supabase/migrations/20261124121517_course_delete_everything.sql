-- COURSE-DELETE-EVERYTHING (owner, 2026-11-24: "when deleting a course allow me to delete any course; if it has sub records delete those
-- too, just ask one time are you sure"). LMS › Courses › Delete asks once (the dialog lists what goes) and then deletes the course with
-- everything under it: units, intakes, classes, placements, attendance, assessments and submissions, unit outcomes, certificates,
-- content, timetables. Students and applications themselves stay: an application only loses the course (its link rows go); a nullable
-- link anywhere else (for example a student's chosen intake) is cleared, never the row holding it.
--
-- How: public.rto_course_purge walks the foreign keys that point at the course (and, recursively, at every row it deletes) in the
-- application schemas, deepest first. A child row whose link column(s) are NOT NULL is deleted; one whose link is nullable is kept with
-- the link cleared. Triggers are off for the delete (session_replication_role = replica, as admin_business_delete does), so append-only
-- and guard triggers do not refuse and nothing is queued or emailed; FK actions are triggers too, which is why every child table is
-- handled explicitly. Files in Storage are left (no FK reaches them).
--   public.rto_course_delete_preview(text) -> what would go, per table (rows deleted / links cleared), nothing changed
--   public.rto_course_delete_all(text)     -> deletes; Admins and RTO Managers; one row in portal_audit_log with the counts
-- The earlier rto_course_delete(text) / (text, boolean) stay as they are.
-- Rollback: drop function public.rto_course_delete_all(text), public.rto_course_delete_preview(text), public.rto_course_purge(regclass, text, boolean, regclass[], jsonb).
begin;

create or replace function public.rto_course_purge(p_table regclass, p_where text, p_apply boolean, p_path regclass[], p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare fk record; child_cols text; parent_cols text; child_where text; v_n bigint; v_counts jsonb := coalesce(p_counts, '{}'::jsonb);
  v_key text; v_all_nullable boolean;
begin
  if cardinality(p_path) > 12 then raise exception 'The course has records nested too deeply to delete safely.' using errcode = '54001'; end if;
  for fk in
    select c.conrelid::regclass as child, c.conkey, c.confkey, c.conrelid
    from pg_constraint c join pg_class k on k.oid = c.conrelid join pg_namespace n on n.oid = k.relnamespace
    where c.contype = 'f' and c.confrelid = p_table
      and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations',
                            'extensions', 'cron', 'net', 'vault', 'pgsodium', 'graphql', 'graphql_public')
  loop
    select string_agg(quote_ident(a.attname), ', ' order by x.ord), bool_and(not a.attnotnull)
      into child_cols, v_all_nullable
      from unnest(fk.conkey) with ordinality x(attnum, ord) join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = x.attnum;
    select string_agg(quote_ident(a.attname), ', ' order by x.ord) into parent_cols
      from unnest(fk.confkey) with ordinality x(attnum, ord) join pg_attribute a on a.attrelid = p_table and a.attnum = x.attnum;
    child_where := format('(%s) in (select %s from %s where %s)', child_cols, parent_cols, p_table, p_where);
    v_key := fk.child::text;
    if v_all_nullable or fk.child = any(p_path) or fk.child = p_table then
      -- Keep the row, clear the link (a self / circular link cannot be deleted through, so it is cleared too).
      if v_all_nullable then
        if p_apply then
          execute format('update %s set (%s) = (select %s) where %s', fk.child, child_cols,
            (select string_agg('null', ', ') from unnest(fk.conkey)), child_where);
          get diagnostics v_n = row_count;
        else
          execute format('select count(*) from %s where %s', fk.child, child_where) into v_n;
        end if;
        if v_n > 0 then v_counts := jsonb_set(v_counts, array[v_key], coalesce(v_counts->v_key, '{}'::jsonb)
          || jsonb_build_object('cleared', coalesce((v_counts->v_key->>'cleared')::bigint, 0) + v_n)); end if;
      end if;
    else
      v_counts := public.rto_course_purge(fk.child, child_where, p_apply, p_path || p_table, v_counts);
    end if;
  end loop;
  v_key := p_table::text;
  if p_apply then
    execute format('delete from %s where %s', p_table, p_where);
    get diagnostics v_n = row_count;
  else
    execute format('select count(*) from %s where %s', p_table, p_where) into v_n;
  end if;
  if v_n > 0 then v_counts := jsonb_set(v_counts, array[v_key], coalesce(v_counts->v_key, '{}'::jsonb)
    || jsonb_build_object('deleted', coalesce((v_counts->v_key->>'deleted')::bigint, 0) + v_n)); end if;
  return v_counts;
end $$;
revoke all on function public.rto_course_purge(regclass, text, boolean, regclass[], jsonb) from public, anon, authenticated;

create or replace function public.rto_course_delete_preview(p_course_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.cms_courses;
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can delete courses.' using errcode = '42501';
  end if;
  select * into c from public.cms_courses where id = p_course_id;
  if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('courseId', c.id, 'code', c.code, 'name', c.name,
    'tables', public.rto_course_purge('public.cms_courses'::regclass, format('id = %L', c.id), false, '{}', '{}'::jsonb));
end $$;
revoke all on function public.rto_course_delete_preview(text) from public, anon;
grant execute on function public.rto_course_delete_preview(text) to authenticated;

create or replace function public.rto_course_delete_all(p_course_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.cms_courses; v_counts jsonb;
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can delete courses.' using errcode = '42501';
  end if;
  select * into c from public.cms_courses where id = p_course_id for update;
  if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;
  set local session_replication_role = replica;
  v_counts := public.rto_course_purge('public.cms_courses'::regclass, format('id = %L', c.id), true, '{}', '{}'::jsonb);
  set local session_replication_role = origin;
  if exists (select 1 from public.cms_courses where id = c.id) then
    raise exception 'The course could not be deleted completely; nothing was changed.';
  end if;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'rto_manager', 'course_deleted_with_everything', 'course', c.id,
          jsonb_build_object('courseCode', c.code, 'courseName', c.name, 'tables', v_counts));
  return jsonb_build_object('deleted', true, 'code', c.code, 'tables', v_counts);
end $$;
revoke all on function public.rto_course_delete_all(text) from public, anon;
grant execute on function public.rto_course_delete_all(text) to authenticated;

commit;
