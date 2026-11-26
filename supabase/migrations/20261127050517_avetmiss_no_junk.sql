-- AVETMISS-NO-JUNK (owner, 2026-11-26: "we can't change the past, but make sure we don't get any junk, and new code follows the
-- AVETMISS guidelines"). Past rows are never touched or re-checked; only values written from now on are refused.
--
-- 1. Application answers (enrollment_applications.data -> 'values') are checked on every write, not only at submit: a value that is
--    added or changed and is not valid for AVETMISS (public.avetmiss_field_errors: gender, Indigenous status, school level, year
--    completed, employment, disability, prior education, at school, country of birth, languages, date of birth, study reason,
--    Australian postcode / state) is refused with check_violation (23514) and the field's own message. Blank answers pass (drafts),
--    unchanged old answers pass (the past). The student record (enrollment_students) and enrolments were already guarded.
-- 2. public.avetmiss_guard_gaps(): the AVETMISS code columns that have no foreign key, check constraint or validating trigger.
--    supabase/tests/avetmiss_no_junk.sql fails while it returns any row, so a new AVETMISS column added without a guard is caught.

begin;

create or replace function public.enrollment_applications_avetmiss_values()
returns trigger language plpgsql set search_path to 'public' as $function$
declare
  v_new jsonb := coalesce(new.data->'values', '{}'::jsonb);
  v_old jsonb := case when tg_op = 'UPDATE' then coalesce(old.data->'values', '{}'::jsonb) else '{}'::jsonb end;
  v_errors jsonb; v_msg text;
begin
  if tg_op = 'UPDATE' and v_new = v_old then return new; end if;
  v_errors := avetmiss_field_errors(v_new);
  if v_errors = '{}'::jsonb then return new; end if;
  -- Only answers added or changed by this write (an old answer stays as it was; the address pair counts when either changed).
  select string_agg(value, ' ' order by key) into v_msg
    from jsonb_each_text(v_errors)
   where v_new->key is distinct from v_old->key
      or (key in ('au_zip', 'au_state') and v_new->'address_type' is distinct from v_old->'address_type');
  if v_msg is not null then
    raise exception 'These answers are not valid for AVETMISS reporting: %', v_msg using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists avetmiss_application_values on public.enrollment_applications;
create trigger avetmiss_application_values
  before insert or update of data on public.enrollment_applications
  for each row execute function public.enrollment_applications_avetmiss_values();

-- The AVETMISS columns (NAT00060 - NAT00130 sources) that nothing guards: a foreign key or check naming the column, or a trigger
-- function on the table that validates it (avetmiss_code / avetmiss_codes / raise exception). Columns a later migration adds to these
-- tables, or any column whose comment says AVETMISS, are included automatically.
create or replace function public.avetmiss_guard_gaps()
returns table(table_name text, column_name text)
language sql stable security definer set search_path to 'public' as $function$
  with cols as (
    select c.oid rel, c.relname::text tbl, a.attname::text col
      from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
       and format_type(a.atttypid, a.atttypmod) not in ('boolean', 'uuid', 'date', 'timestamp with time zone', 'integer', 'numeric')
       and ((c.relname in ('enrollment_students', 'student_disabilities', 'student_prior_education', 'intake_enrolments',
                           'lms_unit_students', 'locations') and (a.attname ~ '_(code|flag)$' or a.attname = 'school_level_year'))
            or coalesce(col_description(c.oid, a.attnum), '') ~* 'avetmiss'))
  select tbl, col from cols
   where not exists (select 1 from pg_constraint k where k.conrelid = cols.rel and k.contype in ('f', 'c')
                       and pg_get_constraintdef(k.oid) ~ ('\m' || cols.col || '\M'))
     and not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                      where t.tgrelid = cols.rel and not t.tgisinternal
                        and pg_get_functiondef(p.oid) ~ ('\m' || cols.col || '\M')
                        and pg_get_functiondef(p.oid) ~ 'avetmiss_codes|avetmiss_code\(|raise exception')
   order by 1, 2;
$function$;
revoke all on function public.avetmiss_guard_gaps() from public, anon, authenticated;
grant execute on function public.avetmiss_guard_gaps() to service_role;

commit;
