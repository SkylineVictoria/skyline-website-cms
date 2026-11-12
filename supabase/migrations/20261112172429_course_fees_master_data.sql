-- Master Data > Course Fees: one row per course with its fees for every intake (intake_id null).
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
      'courseId', c.id, 'slug', c.slug, 'code', c.code, 'cricos', c.cricos, 'name', c.name, 'status', c.status, 'duration', c.duration,
      'tuition', f.tuition_fee, 'enrolment', f.enrolment_fee, 'material', f.material_fee, 'oshc', f.oshc_fee, 'deposit', f.deposit,
      'paymentPlan', f.payment_plan, 'campus', f.campus, 'orientation', f.orientation, 'hoursPerWeek', f.hours_per_week,
      'intakeOverrides', (select count(*) from public.course_fee_setups o where o.course_id = c.id and o.intake_id is not null),
      'updatedAt', f.updated_at
    ) order by c.display_order, c.name)
    from public.cms_courses c
    left join public.course_fee_setups f on f.course_id = c.id and f.intake_id is null
    where nullif(btrim(c.name), '') is not null
  ), '[]'::jsonb);
end $$;

revoke all on function public.cms_course_fee_list() from public, anon;
grant execute on function public.cms_course_fee_list() to authenticated;

insert into public.admin_menu_items (id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
values ('agency_course_fees', 'agencies', 'Course Fees', '/admin/course-fees', 'pay', 35, 'cms.admin', 'current', true)
on conflict (id) do nothing;
