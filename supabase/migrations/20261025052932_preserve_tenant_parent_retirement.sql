-- Deleting a CMS parent must still retire its existing source/job. Do not
-- permit a missing parent to become a route for changing lineage or owner.
do $patch$
declare body text; needle text;
begin
 body:=pg_get_functiondef('public.tenant_bind_row()'::regprocedure);
 needle:='if tg_op=''UPDATE'' and tg_table_name=''public_assistant_sources'' and to_jsonb(new)->>''publication_status''=''unpublished'' then return new; end if;';
 if strpos(body,needle)=0 then raise exception 'Unexpected tenant binding predecessor'; end if;
 execute replace(body,needle,$replacement$
 if tg_op='UPDATE' and new.tenant_id is not distinct from old.tenant_id
  and to_jsonb(new)->>'source_type' is not distinct from to_jsonb(old)->>'source_type'
  and to_jsonb(new)->>'source_key' is not distinct from to_jsonb(old)->>'source_key'
  and ((tg_table_name='public_assistant_sources' and to_jsonb(new)->>'publication_status'='unpublished')
    or (tg_table_name='public_assistant_index_jobs' and to_jsonb(new)->>'state'='cancelled')) then return new; end if;
 $replacement$);
end; $patch$;
