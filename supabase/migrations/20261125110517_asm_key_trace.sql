-- ASM-AI-IMPORT stage 2 (2026-11-25, owner): Upload -> Check -> Publish keeps the imported model answers traceable.
-- asm_question_keys gains the answer as imported (original_model_answer / original_guidance), where it came from (source: the AI
-- reader, the standard reader, a match by content, or typed in), and who last changed it and when (edited_by / edited_at).
-- The question text's own trace lives in the definition (importMeta.original / editedBy / editedAt, never assessor data).
-- asm_import_key_trace writes those columns on the assessment's draft version right after "assessment_create" (admins only).
-- Answers stay in asm_question_keys and never reach students (unchanged read policy).

alter table public.asm_question_keys
 add column if not exists original_model_answer text,
 add column if not exists original_guidance text,
 add column if not exists source text check (source is null or source in ('ai', 'parser', 'content_match', 'manual')),
 add column if not exists edited_by uuid,
 add column if not exists edited_at timestamptz;

create or replace function public.asm_import_key_trace(p_assessment uuid, p_traces jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_version uuid; x jsonb; n integer := 0;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_traces, '[]'::jsonb)) <> 'array' then raise exception 'Traces must be a list' using errcode = '22023'; end if;
 select id into v_version from public.asm_versions where assessment_id = p_assessment and status = 'draft';
 if v_version is null then raise exception 'There is no draft to trace' using errcode = 'P0002'; end if;
 for x in select * from jsonb_array_elements(coalesce(p_traces, '[]'::jsonb)) loop
  update public.asm_question_keys set
    original_model_answer = x->>'originalModelAnswer',
    original_guidance = x->>'originalGuidance',
    source = case when x->>'source' in ('ai', 'parser', 'content_match', 'manual') then x->>'source' end,
    edited_by = case when coalesce((x->>'edited')::boolean, false) then auth.uid() end,
    edited_at = case when coalesce((x->>'edited')::boolean, false) then now() end
  where version_id = v_version and question_id = x->>'questionId';
  if found then n := n + 1; end if;
 end loop;
 return jsonb_build_object('ok', true, 'traced', n);
end $$;
revoke all on function public.asm_import_key_trace(uuid, jsonb) from public, anon;
grant execute on function public.asm_import_key_trace(uuid, jsonb) to authenticated;
