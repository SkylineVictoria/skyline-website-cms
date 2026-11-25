-- AVETMISS-LOCATION-FROM-TIMETABLE, screen side (2026-11-25): LMS › Results labels a unit enrolment's location "From timetable"
-- when it was set automatically (lms_unit_students.location_is_auto, see 20261125153850). The only change to
-- avetmiss_unit_results is the extra key 'locationIsAuto'; the body is otherwise the live definition (pg_get_functiondef,
-- 2026-11-25). No column, no other behaviour changed: picking a location still makes it manual (lms_unit_students_avetmiss),
-- clearing it lets the timetable rule fill it again.

CREATE OR REPLACE FUNCTION public.avetmiss_unit_results(p_intake uuid, p_unit text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
  raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('intakeId', l.intake_id, 'unitId', l.unit_id, 'studentId', l.student_id, 'name', s.full_name, 'email', s.email,
    'studentNumber', s.student_number, 'assignedStart', l.assigned_start_date, 'assignedEnd', l.assigned_end_date,
    'actualStart', l.actual_start_date, 'actualEnd', l.actual_end_date, 'outcome', l.outcome_code,
    'deliveryMode', l.predominant_delivery_mode, 'deliveryIdentifier', l.delivery_mode_identifier, 'locationId', l.location_id,
    'locationIsAuto', coalesce(l.location_is_auto, false),
    'evidenceNote', l.outcome_evidence_note, 'evidencePath', l.outcome_evidence_path, 'recordedAt', l.outcome_recorded_at,
    'recordedBy', (select u.name from public.cms_users u where u.auth_user_id = l.outcome_recorded_by limit 1))
    order by lower(s.full_name))
  from public.lms_unit_students l join public.enrollment_students s on s.id = l.student_id
  where l.intake_id = p_intake and l.unit_id = p_unit), '[]'::jsonb);
end $function$;
