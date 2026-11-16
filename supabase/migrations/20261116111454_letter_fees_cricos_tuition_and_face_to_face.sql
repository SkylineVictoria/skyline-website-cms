-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116111454),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- Delivery mode: every course is Face to Face; new courses default to it.
update public.cms_courses set mode = 'Face to Face' where nullif(btrim(coalesce(mode, '')), '') is null;
alter table public.cms_courses alter column mode set default 'Face to Face';

-- Offer letter: when no tuition is set up in LMS fees, use the course's CRICOS tuition fee.
do $$
declare v_oid oid := 'public.application_letter_course(enrollment_application_courses,text,cms_settings,text)'::regprocedure;
 v_def text := pg_get_functiondef(v_oid);
 a1 text := 'v_disc numeric := 0; v_disc_amt numeric := 0;';
 a2 text := ' v_disc := least(greatest(coalesce(p_ac.discount_percent, 0), 0), 100);';
 a3 text := 'when ''fees.tuition'' then raw := coalesce(tuition::text, ''''); src := r.source_label || '' ('' || fee_src || '')'';';
begin
 if position('v_cricos_tuition' in v_def) > 0 then return; end if;
 if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 or position(a3 in v_def) = 0 then
  raise exception 'application_letter_course anchors not found';
 end if;
 v_def := replace(v_def, a1, a1 || ' v_cricos_tuition boolean := false;');
 v_def := replace(v_def, a2,
  ' if tuition is null and coalesce(c.cricos_tuition_fee, 0) > 0 then' || E'\n'
  || '  tuition := c.cricos_tuition_fee; v_cricos_tuition := true;' || E'\n'
  || '  if v_items and v_total is not null then v_total := v_total + tuition; end if;' || E'\n'
  || ' end if;' || E'\n' || a2);
 v_def := replace(v_def, a3,
  'when ''fees.tuition'' then raw := coalesce(tuition::text, ''''); src := case when v_cricos_tuition then ''Master Data › Courses › CRICOS › Tuition fee'' else r.source_label || '' ('' || fee_src || '')'' end;');
 execute v_def;
end $$;
