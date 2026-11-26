-- ASM-IMPORT-SIMPLE (owner, 2026-11-26): a task's result is automatic. The trainer marks each question Satisfactory Yes / No; a task is
-- Satisfactory (S) when every one of its marked questions is Yes, Not Satisfactory (NYS) when any is No, and undecided (null) while
-- a question is not marked yet. The trainer never sets a task's result: whatever a caller writes into asm_task_results.outcome is
-- replaced by the rule below (a BEFORE trigger), and asm_rollup (called by mark_save and submit after the results are written)
-- touches every task's row, so the rule runs whenever a question is marked. mark_return's existing check ("every assessable task
-- needs a recorded outcome") therefore holds exactly when every question is marked. The overall outcome (Competent / Not Yet
-- Competent) stays the trainer's choice in mark_return. No function of asm_trainer is changed.
--
-- The marked questions of a task are the ones the marking screen lists: top level (depth 0), marking mode not 'none', not a
-- declaration or a reasonable adjustment record.

create or replace function public.asm_task_outcome_auto(p_attempt uuid, p_task text) returns text
language sql stable security definer set search_path = '' as $$
 with qs as (
  select q.question_id
  from public.asm_attempts a
  join public.asm_versions v on v.id = a.version_id
  cross join lateral public.asm_definition_questions(v.definition) q
  where a.id = p_attempt and q.task_id = p_task and q.depth = 0 and q.marking_mode <> 'none'
    and q.question_type not in ('declaration', 'adjustment_record')
 ), marks as (
  select qs.question_id, r.outcome
  from qs
  left join public.asm_results r on r.attempt_id = p_attempt and r.question_id = qs.question_id and r.criterion_id is null
 )
 select case
  when not exists (select 1 from marks) then null
  when exists (select 1 from marks where outcome is null) then null
  when exists (select 1 from marks where outcome = 'NYS') then 'NYS'
  else 'S' end;
$$;
revoke all on function public.asm_task_outcome_auto(uuid, text) from public, anon, authenticated;

create or replace function public.asm_task_results_auto() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 new.outcome := public.asm_task_outcome_auto(new.attempt_id, new.task_id);
 return new;
end $$;
revoke all on function public.asm_task_results_auto() from public, anon, authenticated;

drop trigger if exists asm_task_results_auto on public.asm_task_results;
-- named to run before asm_task_results_frozen / _tenant / _touch (BEFORE triggers fire in name order)
create trigger asm_task_results_auto before insert or update on public.asm_task_results
 for each row execute function public.asm_task_results_auto();
