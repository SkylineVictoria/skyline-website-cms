-- Send-back correction (owner 2026-11-21): the agency admin's correction page loads every answer they signed, saves its progress and
-- takes the flagged upload.
-- 1. agency_onboarding_correction_of returns the reviewed answers too (answers): document-signing shows them read-only on the page and
--    signs the unflagged Yes / No questions from them (the request's tick boxes are stored without a value).
-- 2. Save and continue later, and the organisation chart / business profile upload, failed on every correction ("This application form is
--    no longer waiting for a signature"): agency_onboarding_draft_save, _attachment_save and _attachment_remove accepted the stage
--    application_sent only, while an open correction is at correction_requested. Both stages are accepted now (the recipient check that
--    refuses a signed, declined or skipped signer is unchanged). Patched in place from the live definitions (exact snippet, checked).
create or replace function public.agency_onboarding_correction_of(p_request uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'public', 'hr'
as $function$
 select jsonb_build_object('round', c.round, 'message', c.message, 'flags', c.flags, 'acn', coalesce(o.answers->>'agent_acn', ''), 'marn', coalesce(o.answers->>'agent_marn', ''),
   'answers', coalesce(o.answers, '{}'::jsonb))
 from public.agency_onboarding o join public.agency_onboarding_corrections c on c.onboarding_id = o.id and c.status = 'open' and c.request_id = p_request
 where o.application_request_id = p_request and o.stage = 'correction_requested';
$function$;
revoke all on function public.agency_onboarding_correction_of(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_correction_of(uuid) to service_role;

do $patch$
declare
  v_fn text;
  v_def text;
  v_old constant text := 'o.stage <> ''application_sent''';
  v_new constant text := 'o.stage not in (''application_sent'', ''correction_requested'')';
begin
  foreach v_fn in array array['public.agency_onboarding_draft_save(uuid,uuid,jsonb)', 'public.agency_onboarding_attachment_save(uuid,uuid,text,jsonb)',
    'public.agency_onboarding_attachment_remove(uuid,uuid,text)'] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    if position(v_new in v_def) > 0 then continue; end if;
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
      raise exception '%: the stage check was not found exactly once', v_fn;
    end if;
    execute replace(v_def, v_old, v_new);
  end loop;
end
$patch$;
