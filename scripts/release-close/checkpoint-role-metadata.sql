begin read only;
select jsonb_build_object('system_identifier',(select system_identifier::text from pg_control_system()),
 'database_locale',(select jsonb_build_object('collate',datcollate,'ctype',datctype) from pg_database where datname=current_database()),
 'supautils',(select jsonb_object_agg(name,setting) from pg_settings where name in ('supautils.privileged_role','supautils.superuser','supautils.policy_grants','supautils.drop_trigger_grants','supautils.reserved_roles','supautils.privileged_extensions')),
 'cron_usage',has_schema_privilege('postgres','cron','USAGE'),
 'cron_functions',(select jsonb_agg(format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cron' and has_function_privilege('postgres',p.oid,'EXECUTE')),
 'cron_read_tables',(select jsonb_agg(format('%I.%I',n.nspname,c.relname)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cron' and c.relkind='r' and has_table_privilege('postgres',c.oid,'SELECT')),
 'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypass_rls',rolbypassrls)) from pg_roles)
) as recovery_roles;
commit;
