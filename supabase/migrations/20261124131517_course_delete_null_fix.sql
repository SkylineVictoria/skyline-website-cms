-- COURSE-DELETE-EVERYTHING fix (2026-11-24): clearing a nullable link failed ("column next_attempt_id is of type uuid but expression is
-- of type text") because the update set the columns from a row of untyped nulls; each column is now set to null on its own. The failed
-- delete rolled back, so nothing was removed. Only rto_course_purge changes; rto_course_delete_preview / rto_course_delete_all unchanged.
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
          -- "col = null" per column: a row-constructor of untyped nulls is read as text and fails on uuid columns.
          execute format('update %s set %s where %s', fk.child,
            (select string_agg(quote_ident(a.attname) || ' = null', ', ') from unnest(fk.conkey) x(attnum)
               join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = x.attnum), child_where);
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

commit;
