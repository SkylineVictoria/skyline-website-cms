-- READ-ONLY post-release check for staff self-registration (hr schema). One statement, no writes.
-- Run in the SQL editor of project xcpydisstlvtvcsqnjob ONLY, after the three staff migrations. Every row must show ok = true.
select check_name, expected, actual, (actual = expected or actual like expected || ' (%') as ok
from (
 select 1 as n, 'hr tables (all with row level security)' as check_name, '5 tables, 5 with RLS' as expected,
  (select count(*) || ' tables, ' || count(*) filter (where rowsecurity) || ' with RLS' from pg_tables where schemaname = 'hr') as actual
 union all
 select 2, 'hr policies', '7', (select count(*)::text from pg_policies where schemaname = 'hr')
 union all
 select 3, 'public.hr_* functions that are SECURITY DEFINER', 'all (17 of 17)',
  (select case when count(*) > 0 and bool_and(prosecdef) then 'all (' || count(*) || ' of ' || count(*) || ')' else 'NOT ALL (' || count(*) filter (where prosecdef) || ' of ' || count(*) || ')' end
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'hr\_%')
 union all
 select 4, 'bucket staff-documents is private', 'public = false',
  coalesce((select 'public = ' || public::text from storage.buckets where id = 'staff-documents'), 'MISSING')
 union all
 select 5, 'storage policies staff_documents_*', '3', (select count(*)::text from pg_policies where schemaname = 'storage' and policyname like 'staff\_documents\_%')
 union all
 select 6, 'unique indexes staff_profiles_email_key and staff_profiles_phone_key', '2',
  (select count(*)::text from pg_indexes where schemaname = 'hr' and indexname in ('staff_profiles_email_key', 'staff_profiles_phone_key'))
 union all
 select 7, 'rows in hr.staff_profiles', '0', (select count(*)::text from hr.staff_profiles)
 union all
 select 8, 'admin menu row agency_staff', '1 row',
  (select count(*) || ' row' || case when count(*) = 1 then ' (route=' || max(route) || ', parent=' || coalesce(max(parent_id), '-') || ')' else 's' end from public.admin_menu_items where id = 'agency_staff')
 union all
 select 9, 'table grants on hr to anon / public', '0 rows',
  (select count(*) || ' rows' from information_schema.role_table_grants where table_schema = 'hr' and grantee in ('anon', 'public', 'PUBLIC'))
) c
order by n;
