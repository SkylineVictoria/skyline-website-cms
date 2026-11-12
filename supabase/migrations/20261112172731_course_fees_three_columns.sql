-- Master Data > Courses: active courses with three fees (total, initial, enrolment) that offer letters use.
alter table public.course_fee_setups add column if not exists total_fee numeric(12,2);

-- Existing rows keep the total letters already printed (tuition + enrolment + material + OSHC).
update public.course_fee_setups
   set total_fee = tuition_fee + coalesce(enrolment_fee, 0) + coalesce(material_fee, 0) + coalesce(oshc_fee, 0)
 where total_fee is null and tuition_fee is not null;

-- Letters: {{fees.total}} prints the course's Total fee when set, otherwise the old sum.
do $mig$
declare d text; n text; m text;
begin
  d := pg_get_functiondef('public.application_letter_course(public.enrollment_application_courses,text,public.cms_settings,text)'::regprocedure);
  n := replace(d,
    $a$raw := case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end;$a$,
    $b$raw := coalesce(coalesce(fi.total_fee, fc.total_fee)::text, case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end);$b$);
  if n = d then raise exception 'application_letter_course: fees.total anchor not found'; end if;
  m := replace(n,
    $a$'_total', case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end);$a$,
    $b$'_total', coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end));$b$);
  if m = n then raise exception 'application_letter_course: _total anchor not found'; end if;
  n := replace(m, $a$src := 'Course setup › Fees (sum, ' || fee_src || ')';$a$,
    $b$src := case when coalesce(fi.total_fee, fc.total_fee) is not null then 'Master Data › Courses › Total fee (' || fee_src || ')' else 'Course setup › Fees (sum, ' || fee_src || ')' end;$b$);
  if n = m then raise exception 'application_letter_course: source anchor not found'; end if;
  execute n;
end $mig$;

-- The list: active (Published) courses only.
create or replace function public.cms_course_fee_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'courseId', c.id, 'slug', c.slug, 'code', c.code, 'cricos', c.cricos, 'name', c.name, 'duration', c.duration, 'category', c.category,
      'total', f.total_fee, 'initial', f.deposit, 'enrolment', f.enrolment_fee, 'updatedAt', f.updated_at
    ) order by c.display_order, c.name)
    from public.cms_courses c
    left join public.course_fee_setups f on f.course_id = c.id and f.intake_id is null
    where c.status = 'Published' and nullif(btrim(c.name), '') is not null
  ), '[]'::jsonb);
end $$;

-- Edit: saves only the three fees on the course's every-intake row; its other fee details stay as they are.
create or replace function public.cms_course_fee_save_main(p_course text, p_total text, p_initial text, p_enrolment text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare c public.cms_courses; f public.course_fee_setups;
 num constant text := '^\s*[0-9]{1,9}(\.[0-9]{1,2})?\s*$';
 v_total numeric; v_initial numeric; v_enrol numeric;
begin
  if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
  select * into c from public.cms_courses where id = p_course;
  if not found then raise exception 'Course not found' using errcode = '22023'; end if;
  if (nullif(btrim(p_total), '') is not null and p_total !~ num) or (nullif(btrim(p_initial), '') is not null and p_initial !~ num)
     or (nullif(btrim(p_enrolment), '') is not null and p_enrolment !~ num) then
    raise exception 'Enter fees as amounts, for example 14500 or 14500.00' using errcode = '22023';
  end if;
  v_total := nullif(btrim(p_total), '')::numeric; v_initial := nullif(btrim(p_initial), '')::numeric; v_enrol := nullif(btrim(p_enrolment), '')::numeric;
  if v_total is not null and (coalesce(v_initial, 0) > v_total or coalesce(v_enrol, 0) > v_total) then
    raise exception 'The initial and enrolment fees cannot be more than the total fee' using errcode = '22023';
  end if;
  update public.course_fee_setups set total_fee = v_total, deposit = v_initial, enrolment_fee = v_enrol, updated_at = now(), updated_by = auth.uid()
   where course_id = p_course and intake_id is null returning * into f;
  if not found then
    insert into public.course_fee_setups (tenant_id, course_id, intake_id, total_fee, deposit, enrolment_fee, updated_by)
    values (c.tenant_id, p_course, null, v_total, v_initial, v_enrol, auth.uid()) returning * into f;
  end if;
  return jsonb_build_object('courseId', p_course, 'total', f.total_fee, 'initial', f.deposit, 'enrolment', f.enrolment_fee);
end $$;

revoke all on function public.cms_course_fee_save_main(text, text, text, text) from public, anon;
grant execute on function public.cms_course_fee_save_main(text, text, text, text) to authenticated;

update public.admin_menu_items set label = 'Courses', icon_key = 'courses' where id = 'agency_course_fees';
