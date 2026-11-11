begin;

-- Since 20261104120000 an application's academic qualifications are routed to the student record (enrollment_students.qualifications).
-- Removing an Academic document still stripped only the application's own list, so the entries that document had added stayed on
-- the student. The removal now strips the student's list too (the same rule: an entry survives while another file still backs it;
-- entries a person typed are kept). Additive: one trigger function replaced.
create or replace function public.portal_remove_document_qualifications() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_data jsonb; v_student uuid;
begin
  select data, student_id into v_data, v_student from public.enrollment_applications where id = old.application_id for update;
  if found then
    if jsonb_typeof(v_data->'academicQualifications') = 'array' then
      update public.enrollment_applications
      set data = jsonb_set(data, '{academicQualifications}', public.portal_strip_document_qualifications(data->'academicQualifications', old.id), true)
      where id = old.application_id;
    end if;
    if v_student is not null then
      update public.enrollment_students s
      set qualifications = public.portal_strip_document_qualifications(s.qualifications, old.id)
      where s.id = v_student and jsonb_typeof(s.qualifications) = 'array'
        and s.qualifications <> public.portal_strip_document_qualifications(s.qualifications, old.id);
    end if;
  end if;
  return old;
end;
$$;

commit;
