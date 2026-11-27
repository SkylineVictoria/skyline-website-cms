-- PORTAL-MY-STUDENTS (owner 2026-11-27): the agency portal lists students by role.
--   * the business admin agent ("Our <business> Students"): every student of their business;
--   * an agent ("My students"): the students they look after (the record's agent) and any student with an application they can open;
--   * SLIT admins: every student (institution scope).
-- portal_my_students(query, limit, offset) -> { total, rows: [{ id, name, email, studentNumber, phone, agentId, agentName,
-- applications, latest: { id, reference, status, updatedAt } }] }. Read-only; archived students left out; never for students.
-- Down: drop function public.portal_my_students(text, integer, integer).
begin;

create or replace function public.portal_my_students(p_query text default '', p_limit integer default 25, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  q text := lower(btrim(coalesce(p_query, '')));
  v_all boolean;
  v_agency uuid;
  v_admin boolean;
  v_profile uuid;
  v_total integer;
  v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if public.portal_student_id() is not null then return jsonb_build_object('total', 0, 'rows', '[]'::jsonb); end if;
  v_all := public.portal_is_slit_admin();
  v_agency := public.portal_agency_id();
  v_admin := public.portal_is_agency_admin();
  v_profile := public.portal_profile_id();
  if not v_all and v_agency is null then return jsonb_build_object('total', 0, 'rows', '[]'::jsonb); end if;

  with visible as (
    select s.id, greatest(s.updated_at, coalesce((select max(e.updated_at) from public.enrollment_applications e where e.student_id = s.id), s.updated_at)) as touched
      from public.enrollment_students s
      left join public.agents g on g.id = s.agent_id
     where s.archived_at is null
       and (s.tenant_id is null or public.tenant_scope(s.tenant_id))
       and (v_all
            or (s.agency_id = v_agency and (v_admin
                 or (v_profile is not null and g.profile_id = v_profile)
                 or exists (select 1 from public.enrollment_applications e where e.student_id = s.id and public.portal_can_access_application(e.id)))))
       and (q = '' or position(q in lower(concat_ws(' ', s.full_name, s.email, s.student_number))) > 0
            or (length(regexp_replace(q, '\D', '', 'g')) >= 4
                and position(regexp_replace(q, '\D', '', 'g') in regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) > 0))
  ), page as (
    select * from visible order by touched desc, id
     limit greatest(1, least(coalesce(p_limit, 25), 100)) offset greatest(0, coalesce(p_offset, 0))
  )
  select (select count(*) from visible),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'name', coalesce(s.full_name, ''), 'email', coalesce(s.email, ''), 'studentNumber', coalesce(s.student_number, ''),
           'phone', coalesce(s.phone, ''), 'businessName', coalesce(a.name, ''), 'agentId', s.agent_id, 'agentName', coalesce(g.full_name, ''),
           'applications', (select count(*) from public.enrollment_applications e where e.student_id = s.id
                             and (v_all or v_admin or public.portal_can_access_application(e.id))),
           'latest', (select jsonb_build_object('id', e.id, 'reference', coalesce(e.reference, ''), 'status', e.status, 'updatedAt', e.updated_at)
                        from public.enrollment_applications e where e.student_id = s.id and (v_all or v_admin or public.portal_can_access_application(e.id))
                       order by e.updated_at desc limit 1))
           order by m.touched desc, s.id), '[]'::jsonb)
    into v_total, v_rows
    from page m
    join public.enrollment_students s on s.id = m.id
    left join public.agencies a on a.id = s.agency_id
    left join public.agents g on g.id = s.agent_id;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $fn$;
revoke all on function public.portal_my_students(text, integer, integer) from public, anon;
grant execute on function public.portal_my_students(text, integer, integer) to authenticated;
comment on function public.portal_my_students(text, integer, integer) is
  'PORTAL-MY-STUDENTS: business admin agent = every student of the business; agent = their own students and students whose applications they can open; SLIT admins = all.';

commit;
