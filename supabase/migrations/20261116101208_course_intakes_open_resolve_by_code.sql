-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116101208),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- Resolve whatever the application form sends (course id, slug, national code,
-- "CODE - Name (52 Weeks)" option text, or a CODE_variant suffix) to one cms_courses.id.
create or replace function public.course_resolve_id(p_course text)
returns text language sql stable security definer
set search_path to 'pg_catalog','public','pg_temp'
as $$
 with v as (select btrim(coalesce(p_course,'')) raw),
 t as (select raw, upper(split_part(split_part(raw,' ',1),'_',1)) code_tok from v)
 select coalesce(
  (select c.id from public.cms_courses c, t where c.id = t.raw limit 1),
  (select c.id from public.cms_courses c, t where lower(c.slug) = lower(t.raw) limit 1),
  (select c.id from public.cms_courses c, t where upper(btrim(c.code)) = upper(t.raw) limit 1),
  (select c.id from public.cms_courses c, t where t.code_tok <> '' and upper(btrim(c.code)) = t.code_tok
     order by c.is_active desc, c.updated_at desc nulls last limit 1))
$$;

create or replace function public.course_intakes_open(p_course text)
returns jsonb language sql stable security definer
set search_path to 'pg_catalog','public','pg_temp'
as $$
 with r as (select public.course_resolve_id(p_course) cid),
 real as (
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object('fallback', false) order by i.start_date), '[]'::jsonb) list
  from public.course_intakes i, r
  where i.course_id = r.cid and i.is_active and i.start_date >= public.course_intake_today())
 select case when jsonb_array_length(real.list) > 0 then real.list
  when r.cid is not null and not exists (select 1 from public.course_intakes i where i.course_id = r.cid)
   then public.course_intake_fallback(r.cid)
  else '[]'::jsonb end
 from real, r;
$$;

create or replace function public.course_has_open_intake(p_course text)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','public','pg_temp'
as $$
 select exists (select 1 from public.course_intakes i
  where i.course_id = public.course_resolve_id(p_course) and i.is_active and i.start_date >= public.course_intake_today())
$$;

create or replace function public.course_intake_open_for(p_intake uuid, p_course text)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','public','pg_temp'
as $$
 select exists (select 1 from public.course_intakes i
  where i.id = p_intake and i.course_id = public.course_resolve_id(p_course) and i.is_active and i.start_date >= public.course_intake_today())
$$;

revoke all on function public.course_resolve_id(text) from public, anon;
grant execute on function public.course_resolve_id(text) to authenticated, service_role;
revoke all on function public.course_intakes_open(text) from public, anon;
grant execute on function public.course_intakes_open(text) to authenticated, service_role;
