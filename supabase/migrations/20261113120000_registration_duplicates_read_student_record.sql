begin;

-- Since 20261104120000 a student's answers (date of birth among them) live on the student record, not in the application's
-- data->'values'. The possible-duplicate exception still compared the application's own values, so two verified registrations of
-- the same person were never flagged. It now compares the merged view (public.application_data), as every other reader does.
-- Additive: one function replaced, nothing else changes.
create or replace function public.portal_registration_exception_kinds(p_application uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_remove(array[
    case when a.status = 'enrolled' and not exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified') then 'enrolled_without_verified' end,
    case when exists (select 1 from public.enrollment_registrations l where l.application_id = a.id and l.state = 'lodged' and l.lodged_at < now() - interval '14 days') then 'lodged_stale' end,
    case when a.status in ('withdrawn', 'rejected') and exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified') then 'verified_application_closed' end,
    case when exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified')
      and nullif(lower(trim(a.student_name)), '') is not null and nullif(public.application_data(a.id) #>> '{values,dob}', '') is not null
      and exists (select 1 from public.enrollment_applications b join public.enrollment_registrations rb on rb.application_id = b.id and rb.state = 'verified'
        where b.id <> a.id and b.tenant_id is not distinct from a.tenant_id and lower(trim(b.student_name)) = lower(trim(a.student_name))
          and (public.application_data(b.id) #>> '{values,dob}') = (public.application_data(a.id) #>> '{values,dob}')) then 'possible_duplicate' end
  ], null), '{}'::text[])
  from public.enrollment_applications a where a.id = p_application;
$$;

commit;
