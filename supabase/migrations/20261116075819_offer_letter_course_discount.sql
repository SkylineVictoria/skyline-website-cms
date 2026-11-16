-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116075819),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- A discount (percent of tuition) per offered course. Tuition after discount and the total follow it; the initial deposit does not.
alter table public.enrollment_application_courses
  add column if not exists discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100);

create or replace function public.application_course_discount_set(p_course uuid, p_percent numeric)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v public.enrollment_application_courses;
begin
  if not (public.cms_is_admin() or public.portal_is_slit_admin()) then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_percent is null or p_percent < 0 or p_percent > 100 then raise exception 'Enter a discount between 0 and 100 percent' using errcode = '22023'; end if;
  update public.enrollment_application_courses set discount_percent = round(p_percent, 2) where id = p_course returning * into v;
  if not found then raise exception 'Course on this application not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v.id, 'discount_percent', v.discount_percent);
end $$;
revoke all on function public.application_course_discount_set(uuid, numeric) from public, anon;
grant execute on function public.application_course_discount_set(uuid, numeric) to authenticated;

insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort)
values
 ('fees.discount_percent', 'Fees', 'Discount %', 'Discount on tuition for this course (0% when none)', 'fee', 'discount_percent', 'Offer › Course discount %', 'text', 'text', false, false, array['discount','discount percent','discount %'], '10%', 301),
 ('fees.discount_amount', 'Fees', 'Discount amount', 'Tuition × discount %', 'computed', 'discount_percent', 'Tuition × discount %', 'money', 'money', false, false, array['discount amount'], 'AUD$1,400.00', 302),
 ('fees.tuition_after_discount', 'Fees', 'Tuition after discount', 'Tuition less the discount', 'computed', 'tuition_fee,discount_percent', 'Tuition − discount', 'money', 'money', false, false, array['net tuition','tuition after discount','discounted tuition'], 'AUD$12,600.00', 303)
on conflict (key) do nothing;
update public.letter_variables set description = 'Tuition + enrolment + material + OSHC, less any discount' where key = 'fees.total';

-- Patch the per-course resolver (anchors must each match once, or nothing changes).
do $$
declare d text := pg_get_functiondef('public.application_letter_course(public.enrollment_application_courses,text,public.cms_settings,text)'::regprocedure);
  anchors text[] := array[
    'v_app_label text; v_reg_label text;',
    ' for r in select * from public.letter_variables x where x.key like ''course.%''',
    'else raw := '''';',
    'end case;',
    'else coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end) end);'];
  a text; n int;
begin
  foreach a in array anchors loop
    n := (length(d) - length(replace(d, a, ''))) / length(a);
    if n <> 1 then raise exception 'application_letter_course changed shape (% matches for %); not patched', n, a; end if;
  end loop;
  d := replace(d, anchors[1], 'v_app_label text; v_reg_label text; v_disc numeric := 0; v_disc_amt numeric := 0;');
  d := replace(d, anchors[2], ' v_disc := least(greatest(coalesce(p_ac.discount_percent, 0), 0), 100);
 v_disc_amt := case when tuition is null then 0 else round(tuition * v_disc / 100, 2) end;
 if v_items and v_total is not null then v_total := v_total - v_disc_amt; end if;
' || anchors[2]);
  d := replace(d, anchors[3], 'when ''fees.discount_percent'' then raw := trim_scale(v_disc)::text || ''%'';
   when ''fees.discount_amount'' then raw := v_disc_amt::text;
   when ''fees.tuition_after_discount'' then raw := case when tuition is null then '''' else (tuition - v_disc_amt)::text end; src := r.source_label || '' ('' || fee_src || '')'';
   else raw := '''';');
  d := replace(d, anchors[4], 'end case;
  if r.key = ''fees.total'' and v_disc_amt > 0 then
   if not v_items and raw ~ ''^-?[0-9]+(\.[0-9]+)?$'' then raw := (raw::numeric - v_disc_amt)::text; end if;
   src := src || '', less '' || trim_scale(v_disc) || ''% discount'';
  end if;');
  d := replace(d, anchors[5], 'else coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end) - v_disc_amt end);');
  execute d;
end $$;
