-- AXCELERATE-REIMPORT-DELETED (owner 2026-11-28: "after deleting a student allow me to re-import it"). A student deleted in Skyline is
-- put on the aXcelerate skipped list so "Import all students" does not bring them back. Importing that ONE student on purpose (the
-- import run's scope is 'one' for this aXcelerate contact: Students page "Import one student" or Refresh) now takes them off the skipped
-- list (audited as axcelerate_skip_undone, reason 'imported again') and imports them again. "Import all" still skips them; the Import
-- centre's "Allow import again" is unchanged.
begin;

do $$
declare d text := pg_get_functiondef('public.axcelerate_import_student(uuid, uuid, uuid, jsonb, uuid, boolean)'::regprocedure); a text;
begin
  a := 'if public.axcelerate_is_skipped(p_connection, ''student'', v_ax) then';
  if position(a in d) = 0 then raise exception 'axcelerate_import_student: anchor not found'; end if;
  d := replace(d, a, '-- Imported again on purpose (this one student): off the skipped list.
  if public.axcelerate_is_skipped(p_connection, ''student'', v_ax)
     and exists (select 1 from public.axcelerate_import_runs r where r.id = p_run and r.connection_id = p_connection
                  and r.cursor->>''scope'' = ''one'' and r.cursor->>''contactId'' = v_ax) then
    delete from public.axcelerate_skipped where connection_id = p_connection and entity = ''student'' and axcelerate_id = v_ax;
    perform public.axcelerate_audit(p_connection, p_actor, ''axcelerate_skip_undone'',
      jsonb_build_object(''entity'', ''student'', ''axcelerateId'', v_ax, ''reason'', ''imported again''));
  end if;
  ' || a);
  execute d;
end $$;

commit;
