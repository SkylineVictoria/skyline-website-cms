-- INTAKE-REPLACES-BATCH follow-up: the last table named after batches, batch_enrolment_units (units an enrolment takes when it
-- is a prerequisites-first enrolment), becomes intake_enrolment_units; the 4 functions that name it are rewritten in place.
begin;
alter table public.batch_enrolment_units rename to intake_enrolment_units;
alter index if exists public.batch_enrolment_units_pkey rename to intake_enrolment_units_pkey;
do $$ declare f record;
begin
  for f in select pg_get_functiondef(p.oid) d from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '\mbatch_enrolment_units\M' loop
    execute regexp_replace(f.d, '\mbatch_enrolment_units\M', 'intake_enrolment_units', 'g');
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ~ '\mbatch_enrolment_units\M') then
    raise exception 'functions still name batch_enrolment_units';
  end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261119234500', 'intake_enrolment_units_rename', array['see repo file']) on conflict do nothing;
commit;
