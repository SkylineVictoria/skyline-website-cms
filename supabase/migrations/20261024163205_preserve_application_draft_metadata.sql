-- Atomic merge preserves document review/wizard metadata when the form saves.
-- SECURITY INVOKER retains table RLS and existing editability rules.
create or replace function public.portal_save_application_draft(
  p_application_id uuid, p_data jsonb, p_student_name text,
  p_student_email text, p_intake text, p_completion integer
) returns void language plpgsql security invoker set search_path=public as $$
begin
  if auth.uid() is null or not public.portal_can_edit_application(p_application_id) then
    raise exception 'Application is not editable.' using errcode='42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or p_data - array['values','courses','savedAt','preparedBy'] <> '{}'::jsonb then
    raise exception 'Invalid draft fields.' using errcode='22023';
  end if;
  update public.enrollment_applications set
    data=coalesce(data,'{}'::jsonb)||p_data,
    student_name=p_student_name, student_email=p_student_email,
    intake=p_intake, completion=p_completion, updated_at=clock_timestamp()
  where id=p_application_id;
  if not found then raise exception 'Application is not editable.' using errcode='42501'; end if;
end;
$$;
revoke all on function public.portal_save_application_draft(uuid,jsonb,text,text,text,integer) from public,anon;
grant execute on function public.portal_save_application_draft(uuid,jsonb,text,text,text,integer) to authenticated;
