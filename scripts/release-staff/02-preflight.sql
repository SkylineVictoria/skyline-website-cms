-- READ-ONLY pre-release check for staff self-registration. One statement, no writes. Run in the hosted SQL editor BEFORE the three
-- migrations. Every row must show ok = true. Rows are sorted so any problem is at the top ("ok = false" first).
-- kind: column | function | constraint | trigger | menu | absent (must NOT exist yet) | info (shown for reading, always ok)
with cols(tbl, col, typ) as (values
 ('public.enrollment_students','id','uuid'), ('public.enrollment_students','email','text'), ('public.enrollment_students','phone','text'), ('public.enrollment_students','details','jsonb'),
 ('public.agents','id','uuid'), ('public.agents','business_id','uuid'), ('public.agents','full_name','text'), ('public.agents','email','text'), ('public.agents','phone','text'), ('public.agents','profile_id','uuid'),
 ('public.portal_profiles','id','uuid'), ('public.portal_profiles','auth_user_id','uuid'), ('public.portal_profiles','email','text'), ('public.portal_profiles','phone','text'),
 ('public.agency_memberships','user_id','uuid'), ('public.agency_memberships','agency_id','uuid'), ('public.agency_memberships','role','text'), ('public.agency_memberships','student_id','uuid'),
 ('public.agency_invitations','email','text'), ('public.agency_invitations','status','text'),
 ('public.cms_users','id','text'), ('public.cms_users','name','text'), ('public.cms_users','email','text'), ('public.cms_users','role','text'), ('public.cms_users','status','text'),
 ('public.cms_users','auth_user_id','uuid'), ('public.cms_users','must_change_password','boolean'),
 ('public.admin_menu_items','id','text'), ('public.admin_menu_items','parent_id','text'), ('public.admin_menu_items','label','text'), ('public.admin_menu_items','route','text'),
 ('public.admin_menu_items','icon_key','text'), ('public.admin_menu_items','sort_order','integer'), ('public.admin_menu_items','is_enabled','boolean'),
 ('public.admin_menu_items','permission_key','text'), ('public.admin_menu_items','permission_scope','text'), ('public.admin_menu_items','is_system','boolean'),
 ('public.public_assistant_rate_limits','bucket','text'), ('public.public_assistant_rate_limits','window_started_at','timestamp with time zone'), ('public.public_assistant_rate_limits','request_count','integer'),
 ('auth.users','id','uuid'), ('auth.users','email','character varying'), ('auth.users','email_confirmed_at','timestamp with time zone'), ('auth.users','raw_user_meta_data','jsonb'),
 ('storage.objects','bucket_id','text'), ('storage.objects','name','text'),
 ('storage.buckets','id','text'), ('storage.buckets','public','boolean'), ('storage.buckets','file_size_limit','bigint'), ('storage.buckets','allowed_mime_types','ARRAY')
), checks as (
 select 'column' as kind, c.tbl || '.' || c.col as item, c.typ as expected,
  coalesce((select i.data_type from information_schema.columns i where i.table_schema = split_part(c.tbl, '.', 1) and i.table_name = split_part(c.tbl, '.', 2) and i.column_name = c.col), 'MISSING') as found
 from cols c
 union all
 select 'function', f.sig, 'present', case when to_regprocedure(f.sig) is not null then 'present' else 'MISSING' end
 from (values ('public.cms_is_admin()'), ('public.public_assistant_take_rate_limit(text,integer,integer)'), ('storage.foldername(text)')) as f(sig)
 union all
 select 'constraint', 'cms_users.role allows Admin', 'present',
  case when exists (select 1 from pg_constraint where conrelid = 'public.cms_users'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''Admin''%') then 'present' else 'MISSING' end
 union all
 select 'constraint', 'cms_users.email is unique', 'present',
  case when exists (select 1 from pg_constraint where conrelid = 'public.cms_users'::regclass and contype = 'u' and pg_get_constraintdef(oid) like '%(email)%') or
   exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'cms_users' and indexdef like 'CREATE UNIQUE%(email)%') then 'present' else 'MISSING' end
 union all
 select 'constraint', 'admin_menu_items.permission_key allows cms.admin', 'present',
  case when exists (select 1 from pg_constraint where conrelid = 'public.admin_menu_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%cms.admin%') then 'present' else 'MISSING' end
 union all
 select 'trigger', 'protect_admin_menu on admin_menu_items', 'present',
  case when exists (select 1 from pg_trigger where tgrelid = 'public.admin_menu_items'::regclass and tgname = 'protect_admin_menu' and not tgisinternal) then 'present' else 'MISSING' end
 union all
 select 'menu', 'parent group "agencies" exists, enabled, cms.admin', 'present',
  case when exists (select 1 from public.admin_menu_items where id = 'agencies' and is_enabled and permission_key = 'cms.admin') then 'present' else 'MISSING OR DIFFERENT' end
 union all
 select 'menu', 'sibling ' || s.id || ' under agencies', 'present',
  case when exists (select 1 from public.admin_menu_items where id = s.id and parent_id = 'agencies') then 'present' else 'MISSING' end
 from (values ('agency_businesses'), ('agency_agents'), ('agency_students')) as s(id)
 union all
 select 'constraint', 'agents.business_id references public.agencies (the business chain of migration 102)', 'present',
  case when exists (select 1 from pg_constraint where conrelid = 'public.agents'::regclass and contype = 'f' and confrelid = 'public.agencies'::regclass) then 'present' else 'MISSING OR POINTS ELSEWHERE' end
 union all
 select 'info', 'public.businesses (migration 102 drops it; the staff code never reads it)', 'listed', case when to_regclass('public.businesses') is not null then 'EXISTS' else 'absent' end
 union all
 select 'info', 'public.agencies business_email / phone (business contacts; NOT read by the staff duplicate check)', 'listed',
  (select count(*)::text || ' of 2 columns present' from information_schema.columns where table_schema = 'public' and table_name = 'agencies' and column_name in ('business_email', 'phone'))
 union all
 select 'absent', 'schema hr', 'absent', case when exists (select 1 from pg_namespace where nspname = 'hr') then 'EXISTS' else 'absent' end
 union all
 select 'absent', 'functions public.hr_*', 'absent', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'hr\_%') then 'EXISTS' else 'absent' end
 union all
 select 'absent', 'bucket staff-documents', 'absent', case when exists (select 1 from storage.buckets where id = 'staff-documents') then 'EXISTS' else 'absent' end
 union all
 select 'absent', 'storage policies staff_documents_*', 'absent', case when exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'staff\_documents\_%') then 'EXISTS' else 'absent' end
 union all
 select 'absent', 'menu item agency_staff', 'absent', case when exists (select 1 from public.admin_menu_items where id = 'agency_staff') then 'EXISTS' else 'absent' end
 union all
 select 'info', 'menu row ' || m.id, 'listed', 'parent=' || coalesce(m.parent_id, '-') || ' label=' || m.label || ' route=' || coalesce(m.route, '-') || ' perm=' || m.permission_key || ' enabled=' || m.is_enabled || ' order=' || m.sort_order
 from public.admin_menu_items m where m.id = 'agencies' or m.parent_id = 'agencies'
)
select kind, item, expected, found, (kind = 'info' or found = expected or (kind = 'column' and expected = 'character varying' and found in ('text', 'character varying', 'citext'))) as ok
from checks
order by 5, 1, 2;
