-- ASM-IMPORT-CLASSIFY (2026-11-25, owner): the differences the AI import resolved by a rule are written to the assessment's audit log.
--
-- The import now types every item (question | section_heading | instruction | response_label; supabase/functions/_shared/asm-import/
-- classify.ts) and resolves some differences by rule instead of listing them under "Needs a look": an answer box's label left out
-- of or read into the text ("Short answer"), a number printed beside the text, a section heading's number that matches a question's.
-- Each one is kept on the question (importMeta.autoResolved: rule, text, note, page) and shown under "Auto-resolved" with Reopen.
-- Right after assessment_create the Add assessment wizard calls asm_import_auto_resolved with those notes: one asm_audit_log row
-- per note (action import_auto_resolved, or import_auto_resolve_reopened when the admin reopened it), target the assessment.
-- Admins and RTO Managers only; at most 500 notes; each value trimmed.

create or replace function public.asm_import_auto_resolved(p_assessment uuid, p_notes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; x jsonb; n integer := 0;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_notes, '[]'::jsonb)) <> 'array' then raise exception 'Notes must be a list' using errcode = '22023'; end if;
 if jsonb_array_length(coalesce(p_notes, '[]'::jsonb)) > 500 then raise exception 'Too many notes' using errcode = '22023'; end if;
 select tenant_id into v_tenant from public.asm_assessments where id = p_assessment;
 if not found then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 for x in select * from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) loop
  if coalesce(x->>'rule', '') not in ('response_label', 'numbering', 'heading_number') then continue; end if;
  perform public.asm_log('admin',
    case when coalesce((x->>'reopened')::boolean, false) then 'import_auto_resolve_reopened' else 'import_auto_resolved' end,
    'assessment', p_assessment::text,
    jsonb_build_object('questionId', left(coalesce(x->>'questionId', ''), 80), 'rule', x->>'rule', 'text', left(coalesce(x->>'text', ''), 300),
      'note', left(coalesce(x->>'note', ''), 600), 'page', case when (x->>'page') ~ '^[0-9]{1,4}$' then (x->>'page')::integer end),
    v_tenant);
  n := n + 1;
 end loop;
 return jsonb_build_object('ok', true, 'logged', n);
end $$;
revoke all on function public.asm_import_auto_resolved(uuid, jsonb) from public, anon;
grant execute on function public.asm_import_auto_resolved(uuid, jsonb) to authenticated;
