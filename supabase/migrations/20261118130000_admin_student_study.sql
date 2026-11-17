-- STUDENT-STUDY (2026-11-18): where a student studies, for the CMS student page: each placement (intake, batch, room, join day), the units they
-- take in it, and the path (continues from / continues in the next intake). Read only; staff only. Additive.
create function public.admin_student_study(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'enrolmentId', e.id, 'status', e.status, 'type', e.enrolment_type, 'enrolledOn', e.enrolled_on, 'carryOver', e.carry_over,
   'courseCode', c.code, 'courseName', c.name, 'intakeId', i.id, 'intake', public.course_intake_name(i), 'intakeStart', i.start_date,
   'batchId', b.id, 'batch', b.name, 'room', (select r.name from public.classrooms r where r.id = b.classroom_id),
   'units', coalesce((select jsonb_agg(jsonb_build_object('code', cu.code, 'name', cu.name, 'start', m.start_date, 'end', m.end_date) order by m.start_date, m.sort)
     from public.rto_enrolment_units(e.id) m join public.cms_course_units cu on cu.id = m.unit_id), '[]'::jsonb),
   'path', public.rto_enrolment_path(e)) order by i.start_date desc, e.enrolled_on desc)
  from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes i on i.id = b.intake_id
  join public.cms_courses c on c.id = i.course_id
  where e.student_id = p_student and e.status <> 'withdrawn'), '[]'::jsonb);
end $$;
revoke all on function public.admin_student_study(uuid) from public, anon;
grant execute on function public.admin_student_study(uuid) to authenticated;
