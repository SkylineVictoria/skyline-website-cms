-- Restored 2026-11-26 from hosted supabase_migrations.schema_migrations (version 20261125122452, applied on hosted 2026-11-25 by
-- another session without a repo file). Statements verbatim: hosted md5 of the joined statements = d07905e1269a3c6d11d4bba5622fec27.
do $do$
declare d text := pg_get_functiondef('public.lms_unit_students_avetmiss()'::regprocedure);
begin
  d := replace(d, 'order by e.created_at desc limit 1;', 'order by (e.archived_at is null) desc, e.enrolled_on desc nulls last limit 1;');
  if position('e.created_at' in d) > 0 then raise exception 'patch failed'; end if;
  execute d;
end $do$;
