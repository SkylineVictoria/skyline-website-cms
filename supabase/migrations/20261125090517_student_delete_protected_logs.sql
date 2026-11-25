-- STUDENT-DELETE-EVERYTHING fix (owner 2026-11-25): the full delete stopped at hr.sign_events ("Signing history cannot be
-- changed", 42501): append-only history tables refuse every delete through their own trigger. The business delete
-- (20261120133517) passes them with session_replication_role = replica; admin_purge_rows now does the same, only for a delete
-- that such a trigger refused (42501 / 23514), and then clears by hand the ON DELETE SET NULL links that replica mode skips.
-- Everything else is unchanged from 20261125070517.
-- Down: re-run admin_purge_rows from 20261125070517.
begin;

create or replace function public.admin_purge_rows(p_table regclass, p_col name, p_vals text[], p_depth int default 0) returns void
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
    if fk.confdeltype in ('n', 'd') then continue; end if;
    execute format('select array_agg(distinct %I::text) from %s where %I = any($1::%s[])', fk.ref_col, p_table, p_col, v_type)
       into v_refvals using p_vals;
    if v_refvals is null then continue; end if;
    v_nullable := fk.nullable;
    v_keep := fk.child::text ~ '(audit|_log$|_logs$|history)';
    if fk.child = p_table then
      if v_nullable then
        execute format('update %s set %I = null where %I::text = any($1)', fk.child, fk.child_col, fk.child_col) using v_refvals;
      end if;
    elsif v_keep and v_nullable then
      execute format('update %s set %I = null where %I::text = any($1)', fk.child, fk.child_col, fk.child_col) using v_refvals;
    else
      perform public.admin_purge_rows(fk.child, fk.child_col, v_refvals, p_depth + 1);
    end if;
  end loop;
  begin
    execute format('delete from %s where %I = any($1::%s[])', p_table, p_col, v_type) using p_vals;
  exception when insufficient_privilege or check_violation then
    -- An append-only history table (e.g. hr.sign_events) refuses deletes through its trigger: delete with triggers off,
    -- after clearing the SET NULL links that replica mode would skip.
    for fk in
      select c.conrelid::regclass as child,
             (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as child_col,
             (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) as ref_col
        from pg_constraint c
       where c.contype = 'f' and c.confrelid = p_table and cardinality(c.conkey) = 1 and c.confdeltype = 'n'
    loop
      execute format('select array_agg(distinct %I::text) from %s where %I = any($1::%s[])', fk.ref_col, p_table, p_col, v_type)
         into v_refvals using p_vals;
      if v_refvals is not null then
        execute format('update %s set %I = null where %I::text = any($1)', fk.child, fk.child_col, fk.child_col) using v_refvals;
      end if;
    end loop;
    set local session_replication_role = replica;
    execute format('delete from %s where %I = any($1::%s[])', p_table, p_col, v_type) using p_vals;
    set local session_replication_role = origin;
  end;
end $fn$;
revoke all on function public.admin_purge_rows(regclass, name, text[], int) from public, anon, authenticated;

commit;
