-- ASM-BUILDER (2026-11-25, owner): unit content from training.gov.au, cached per unit code, and AI-suggested mappings to confirm.
--
-- tga_unit_content: the training.gov.au content of a unit (elements, performance criteria, performance evidence, knowledge evidence,
-- assessment conditions, foundation skills) as tga-course-import's unitDetails() reads it, kept per unit code so opening the Unit
-- mapping tab costs no call; "Refresh from training.gov.au" fetches it again. Written by the Edge Function only (service role).
-- asm_mapping_suggestions: which question gives evidence for which criterion, as the AI reader suggests it (asm-import
-- suggest_mapping). A suggestion is never a mapping: the admin confirms it (the mapping then goes into the draft like a hand-made
-- tick) or dismisses it; who decided and when is kept. Question ids stay the same from version to version, so suggestions are
-- kept per assessment.

create table public.tga_unit_content (
 code text primary key check (code ~ '^[A-Z0-9]{4,20}$'),
 details jsonb not null,
 fetched_at timestamptz not null default now()
);
alter table public.tga_unit_content enable row level security;
revoke all on public.tga_unit_content from anon, authenticated;
grant select, insert, update on public.tga_unit_content to service_role;

create table public.asm_mapping_suggestions (
 id uuid primary key default gen_random_uuid(),
 assessment_id uuid not null references public.asm_assessments(id) on delete cascade,
 question_id text not null check (char_length(question_id) between 1 and 80),
 element_id uuid not null references public.asm_unit_elements(id) on delete cascade,
 confidence numeric not null default 0 check (confidence between 0 and 1),
 reason text not null default '' check (char_length(reason) <= 600),
 model text,
 state text not null default 'suggested' check (state in ('suggested', 'confirmed', 'dismissed')),
 suggested_at timestamptz not null default now(),
 decided_by uuid,
 decided_at timestamptz,
 unique (assessment_id, question_id, element_id)
);
create index asm_mapping_suggestions_assessment on public.asm_mapping_suggestions(assessment_id, state);
alter table public.asm_mapping_suggestions enable row level security;
revoke all on public.asm_mapping_suggestions from anon, authenticated;
grant select, insert, update, delete on public.asm_mapping_suggestions to service_role;

create or replace function public.asm_mapping_suggestion_json(s public.asm_mapping_suggestions) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', s.id, 'questionId', s.question_id, 'elementId', s.element_id, 'confidence', s.confidence, 'reason', s.reason,
  'model', s.model, 'state', s.state, 'suggestedAt', s.suggested_at, 'decidedAt', s.decided_at,
  'decidedBy', case when s.decided_by is null then null else coalesce(public.asm_person_name(s.decided_by), 'Staff') end);
$$;
revoke all on function public.asm_mapping_suggestion_json(public.asm_mapping_suggestions) from public, anon, authenticated;

create or replace function public.asm_mapping_suggestions_list(p_assessment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers map assessments' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(public.asm_mapping_suggestion_json(s) order by s.confidence desc, s.suggested_at)
   from public.asm_mapping_suggestions s where s.assessment_id = p_assessment), '[]'::jsonb);
end $$;

/** Confirms or dismisses suggestions (the confirmed mapping itself is saved with the draft, as a hand-made tick). */
create or replace function public.asm_mapping_decide(p_ids uuid[], p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_assessment uuid;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers map assessments' using errcode = '42501'; end if;
 if p_state not in ('confirmed', 'dismissed', 'suggested') then raise exception 'Unknown decision' using errcode = '22023'; end if;
 update public.asm_mapping_suggestions set state = p_state,
   decided_by = case when p_state = 'suggested' then null else auth.uid() end,
   decided_at = case when p_state = 'suggested' then null else now() end
 where id = any(coalesce(p_ids, '{}')) returning assessment_id into v_assessment;
 if v_assessment is null then return '[]'::jsonb; end if;
 perform public.asm_log('admin', 'mapping_' || p_state, 'assessment', v_assessment::text, jsonb_build_object('count', coalesce(array_length(p_ids, 1), 0)));
 return public.asm_mapping_suggestions_list(v_assessment);
end $$;

revoke all on function public.asm_mapping_suggestions_list(uuid), public.asm_mapping_decide(uuid[], text) from public, anon;
grant execute on function public.asm_mapping_suggestions_list(uuid), public.asm_mapping_decide(uuid[], text) to authenticated;

-- Fix (found by the Unit mapping walkthrough): asm_admin 'unit_elements_save' and 'overview' empty their session temp tables with
-- a bare "delete from asm_tmp_keep;" / "delete from asm_tmp_scope;", which the API's safe-update guard refuses ("DELETE requires a
-- WHERE clause"), so Edit unit elements and the monitoring overview failed from the browser. Patched in place (same function,
-- anchors checked: each exactly once).
do $patch$
declare v_def text; v_new text;
begin
 v_def := pg_get_functiondef('public.asm_admin(text,jsonb)'::regprocedure);
 if (length(v_def) - length(replace(v_def, 'delete from asm_tmp_keep;', ''))) <> length('delete from asm_tmp_keep;')
  or (length(v_def) - length(replace(v_def, 'delete from asm_tmp_scope;', ''))) <> length('delete from asm_tmp_scope;') then
  raise exception 'asm_admin: the temp-table anchors are not there exactly once';
 end if;
 v_new := replace(replace(v_def, 'delete from asm_tmp_keep;', 'delete from asm_tmp_keep where true;'), 'delete from asm_tmp_scope;', 'delete from asm_tmp_scope where true;');
 execute v_new;
end $patch$;
