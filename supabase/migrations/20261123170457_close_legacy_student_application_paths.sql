begin;

-- Browser writes go through checked commands. Internal callers retain execution as the function owner.
revoke insert, update on public.enrollment_applications from public, anon, authenticated;
revoke execute on function public.portal_create_application(text, uuid, uuid),
  public.portal_save_application_draft(uuid, jsonb, text, text, text, integer),
  public.portal_save_document_review(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, text),
  public.portal_submit_application(uuid, jsonb),
  public.portal_send_to_student(text, text, text, text, text, boolean),
  public.portal_create_guest_link(uuid, integer),
  public.portal_send_guest_link_email(uuid, text, text, text)
from public, anon, authenticated;

-- Existing correction links follow their prior workflow. Initial drafts require a verified student invitation.
-- rule-policy: security application-legacy-link-scope Require a previously submitted application in the correction workflow before resolving a legacy link.
CREATE OR REPLACE FUNCTION public.guest_link_resolve(p_hash bytea)
 RETURNS TABLE(link_id uuid, application_id uuid, tenant_id uuid, completed boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with hit as (
    update public.guest_document_links set last_used_at = now()
    where token_hash = p_hash and revoked_at is null and expires_at > now()
    -- rule-policy: security application-legacy-link-scope Return links only after the database verifies the correction workflow.
      and exists (select 1 from public.enrollment_applications a where a.id = guest_document_links.application_id
        and a.status = 'action_required')
    returning id, application_id, tenant_id, completed_at)
  select h.id, h.application_id, h.tenant_id, h.completed_at is not null from hit h;
$function$;

commit;
