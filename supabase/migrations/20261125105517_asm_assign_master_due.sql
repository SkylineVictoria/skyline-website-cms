-- ASM-AI-IMPORT stage 2 (2026-11-25): "Assign to intakes" with "Use the Master unit dates" (the default since 20261125041517)
-- failed with: null value in column "starts_at" of relation "asm_schedule_events". The assignment's due date then comes from the
-- a0_master_window trigger, but the calendar's "due" event was still written from the request's dueAt (now empty). The event takes
-- the assignment's own due date (as stored) instead. One anchored in-place patch of asm_admin (either line ending); nothing else.

do $do$
declare d text; pat text; n int;
begin
 d := pg_get_functiondef('public.asm_admin(text,jsonb)'::regprocedure);
 pat := 'values \(v_a\.id, ''due'', v_as\.title \|\| '': due'', v_due\);';
 select count(*) into n from regexp_matches(d, pat, 'g');
 if n = 0 and position('coalesce(v_a.due_at, v_due)' in d) > 0 then return; end if; -- already patched
 if n <> 1 then raise exception 'asm_admin: expected one due-event insert, found %', n; end if;
 execute regexp_replace(d, pat, 'values (v_a.id, ''due'', v_as.title || '': due'', coalesce(v_a.due_at, v_due));');
end $do$;
