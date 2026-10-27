CREATE OR REPLACE FUNCTION public.portal_on_application_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_note text := coalesce(current_setting('portal.status_note', true), '');
  v_name text;
  v_role text;
  v_app_ref text;
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is distinct from old.status then
    select coalesce(
             (select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1),
             (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1),
             auth.jwt()->>'email',
             'System'
           ) into v_name;

    v_role := case
      when public.portal_is_slit_admin() then 'slit_admin'
      when public.portal_is_agency_admin() then 'agency_admin'
      when public.portal_is_agent() then 'agent'
      else 'system'
    end;

    insert into public.enrollment_application_status_history
      (application_id, previous_status, new_status, actor, actor_name, actor_role, note)
    values (new.id, old.status, new.status, auth.uid(), v_name, v_role, v_note);

    -- Notify the assigned agent + the agency's admins.
    v_app_ref := coalesce(new.reference, left(new.id::text, 8));
    insert into public.portal_notifications (recipient, application_id, reference, event, title, message)
    select p.auth_user_id, new.id, v_app_ref, 'status_change',
           'Application ' || v_app_ref || ' is now ' || replace(new.status, '_', ' '),
           'Status changed from ' || replace(old.status, '_', ' ') || ' to ' || replace(new.status, '_', ' ') || '.'
    from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null
      and (
        p.id = new.assigned_agent_id
        or exists (
          select 1 from public.agency_memberships m
          where m.user_id = p.id and m.agency_id = new.agency_id
            and m.status = 'Active' and m.role = 'agency_admin'
        )
      );
  end if;

  return new;
end;
$function$

;

