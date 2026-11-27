create or replace function public.rto_direct_application(p_student uuid, p_intake uuid) returns uuid
language plpgsql security definer set search_path = public as $function$
declare st public.enrollment_students; i public.course_intakes; c public.cms_courses; v_app uuid;
begin
 select * into st from public.enrollment_students where id = p_student;
 if st.id is null then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into i from public.course_intakes where id = p_intake;
 select * into c from public.cms_courses where id = i.course_id;
 insert into public.enrollment_applications(agency_id, student_id, student_name, student_email, tenant_id, status, source, data)
 values (st.agency_id, st.id, coalesce(st.full_name, ''), coalesce(st.email, ''), st.tenant_id, 'draft', 'direct enrolment', jsonb_build_object('source', 'direct enrolment'))
 returning id into v_app;
 perform set_config('portal.draft_command', v_app::text, true);
 insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, variant, intake_id)
 values (v_app, c.id, coalesce(c.code, ''), coalesce(c.name, ''), coalesce(btrim(c.variant_label), ''),
  case when i.id in (select public.course_intake_offered(c.id)) then i.id end);
 perform set_config('portal.draft_command', '', true);
 return v_app;
end $function$;