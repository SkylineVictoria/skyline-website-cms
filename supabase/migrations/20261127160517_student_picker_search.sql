-- STUDENT-PICKER (owner 2026-11-27): "New student application" picks the student from a searchable box instead of typing an email.
-- public.portal_student_search(query, limit): 2+ characters, matched against name, email, student ID, mobile (digits) and passport
-- number; returns name, email, student ID, mobile, date of birth, business, agent, application count and canStart.
-- Scope is enforced here (not only in the page):
--   * SLIT administrators / tenant staff (portal_is_slit_admin): every student of their institution (tenant_scope);
--   * agency admins and agents: only the students of their own agency (portal_agency_id);
--   * students and anyone else: nothing.
-- canStart mirrors portal_create_student_application: administrators and agency admins may start an application for any student they
-- see; an agent only for the students they look after (others of the agency are listed but cannot be picked).
-- Archived students are left out. Read-only. Down: drop function public.portal_student_search(text, integer).
begin;

create or replace function public.portal_student_search(p_query text, p_limit integer default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  q text := btrim(coalesce(p_query, ''));
  v_all boolean;
  v_agency uuid;
  v_agency_admin boolean;
  v_profile uuid;
  v_like text;
  v_digits text;
  v_passport text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if length(q) < 2 or length(q) > 200 or public.portal_student_id() is not null then return '[]'::jsonb; end if;
  v_all := public.portal_is_slit_admin();
  v_agency := public.portal_agency_id();
  v_agency_admin := public.portal_is_agency_admin();
  v_profile := public.portal_profile_id();
  if not v_all and v_agency is null then return '[]'::jsonb; end if;
  v_like := '%' || replace(replace(replace(lower(q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := ltrim(regexp_replace(q, '\D', '', 'g'), '0');  -- 0412 000 111 matches +61412000111
  v_passport := upper(regexp_replace(q, '\s', '', 'g'));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', coalesce(s.full_name, ''), 'email', coalesce(s.email, ''), 'studentNumber', coalesce(s.student_number, ''),
             'phone', coalesce(s.phone, ''), 'dateOfBirth', s.date_of_birth,
             'businessId', s.agency_id, 'businessName', coalesce(a.name, ''), 'agentId', s.agent_id, 'agentName', coalesce(g.full_name, ''),
             'applications', (select count(*) from public.enrollment_applications e where e.student_id = s.id),
             'canStart', coalesce(v_all or v_agency_admin or (v_profile is not null and g.profile_id = v_profile), false))
           order by s.rank, s.updated_at desc)
      from (
        select x.*,
               case when lower(coalesce(x.email, '')) = lower(q) or upper(coalesce(x.student_number, '')) = upper(q) then 0
                    when lower(coalesce(x.full_name, '')) like lower(q) || '%' then 1 else 2 end as rank
          from public.enrollment_students x
         where x.archived_at is null
           and (x.tenant_id is null or public.tenant_scope(x.tenant_id))
           and (v_all or x.agency_id = v_agency)
           and (lower(coalesce(x.full_name, '')) like v_like escape '\'
                or lower(coalesce(x.email, '')) like v_like escape '\'
                or lower(coalesce(x.student_number, '')) like v_like escape '\'
                or (length(v_passport) >= 3 and upper(regexp_replace(coalesce(x.passport_number, ''), '\s', '', 'g')) like '%' || v_passport || '%')
                or (length(v_digits) >= 4 and regexp_replace(coalesce(x.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
         order by rank, x.updated_at desc
         limit greatest(1, least(coalesce(p_limit, 12), 25))
      ) s
      left join public.agencies a on a.id = s.agency_id
      left join public.agents g on g.id = s.agent_id), '[]'::jsonb);
end $fn$;
revoke all on function public.portal_student_search(text, integer) from public, anon;
grant execute on function public.portal_student_search(text, integer) to authenticated;
comment on function public.portal_student_search(text, integer) is
  'STUDENT-PICKER: students the caller may pick for a new application (SLIT admins: all of the institution; agency users: their agency only).';

commit;
