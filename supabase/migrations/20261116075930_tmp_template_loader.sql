-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116075930),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
create or replace function public.tmp_load_student_offer_template(p_secret text, p_html text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','hr','public' as $$
declare t hr.sign_templates; v_problem text; v_admin uuid;
begin
  if p_secret is distinct from '688da2d571106e2d96f2b3008d64b6350bc54a4c6a3ffd19' then raise exception 'denied'; end if;
  if exists (select 1 from hr.sign_templates where name = 'Student Offer Letter' and deleted_at is null) then raise exception 'already exists'; end if;
  v_problem := hr.rich_html_problem(p_html);
  if v_problem is not null then raise exception '%', v_problem; end if;
  select auth_user_id into v_admin from public.cms_users where role = 'Admin' and status = 'Active' and auth_user_id is not null order by auth_user_id limit 1;
  insert into hr.sign_templates(name, title, body_html, body, kind, audience, category, header_html, footer_html, created_by, is_default, expiry_days, reminder_days)
  values ('Student Offer Letter', 'Letter of Offer and Written Agreement', p_html, hr.html_to_text(p_html), 'text', 'student', 'student_offer_letter',
    (select html from hr.sign_template_parts where id = '5fa3ce71-7b83-4be7-9121-85d588dd5765'),
    (select html from hr.sign_template_parts where id = '0906c521-47e9-4db6-b812-92758f730d6c'),
    v_admin, true, 30, 3)
  returning * into t;
  insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  return jsonb_build_object('id', t.id, 'chars', length(t.body_html));
end $$;
revoke all on function public.tmp_load_student_offer_template(text, text) from public;
grant execute on function public.tmp_load_student_offer_template(text, text) to anon;
