-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116080204),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- Each course's letter values carry _discount (true when the course has a discount above 0%), for {{#if discount}} blocks.
do $$
declare d text := pg_get_functiondef('public.application_letter_course(public.enrollment_application_courses,text,public.cms_settings,text)'::regprocedure);
  a text := 'return v_out || jsonb_build_object(''_courseId'', c.id,';
begin
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'application_letter_course changed shape; not patched'; end if;
  d := replace(d, a, 'return v_out || jsonb_build_object(''_discount'', v_disc > 0, ''_courseId'', c.id,');
  execute d;
end $$;
