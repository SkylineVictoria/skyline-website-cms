-- ASM-UNIT-CHECK (2026-11-25, owner): the unit a workbook names against the unit selected in Add assessment.
--
-- The wizard compares the unit code and title the PDF prints (cover, headers) with the selected unit. A mismatch ("This workbook
-- looks like RIICWD525E but you selected BSBHRM613") blocks Publish until the admin either switches to the workbook's unit or keeps
-- the selected one with a reason. Right after assessment_create the wizard calls asm_import_unit_check with the decision: one
-- asm_audit_log row (action import_unit_mismatch, target the assessment) with the decision, the reason, both codes and titles; the
-- actor is the admin. "kept" without a reason (at least 5 characters) is refused, as on the screen. Admins / RTO Managers only.

create or replace function public.asm_import_unit_check(p_assessment uuid, p_decision jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_kind text := p_decision->>'kind'; v_reason text := btrim(coalesce(p_decision->>'reason', ''));
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_decision, 'null'::jsonb)) <> 'object' then raise exception 'The decision must be an object' using errcode = '22023'; end if;
 if coalesce(v_kind, '') not in ('switched', 'kept') then raise exception 'The decision is switched or kept' using errcode = '22023'; end if;
 if v_kind = 'kept' and char_length(v_reason) < 5 then raise exception 'A reason is needed to keep the selected unit' using errcode = '22023'; end if;
 select tenant_id into v_tenant from public.asm_assessments where id = p_assessment;
 if not found then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 perform public.asm_log('admin', 'import_unit_mismatch', 'assessment', p_assessment::text,
   jsonb_build_object('decision', v_kind, 'reason', nullif(left(v_reason, 600), ''),
     'foundCode', left(coalesce(p_decision->>'foundCode', ''), 20), 'foundTitle', left(coalesce(p_decision->>'foundTitle', ''), 200),
     'selectedCode', left(coalesce(p_decision->>'selectedCode', ''), 20), 'selectedTitle', left(coalesce(p_decision->>'selectedTitle', ''), 200)),
   v_tenant);
 return jsonb_build_object('ok', true, 'decision', v_kind);
end $$;
revoke all on function public.asm_import_unit_check(uuid, jsonb) from public, anon;
grant execute on function public.asm_import_unit_check(uuid, jsonb) to authenticated;
