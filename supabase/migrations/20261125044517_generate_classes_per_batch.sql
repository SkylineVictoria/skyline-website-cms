-- LMS-BATCHES (2026-11-25, found in the hosted end-to-end probe): class generation shared each unit's hours across the whole intake, so a
-- second batch took hours from B1 (B1 fell from 94 to 16 classes). Now each batch is planned on its own and gets the full unit hours:
-- with more than one batch with class times, rto_class_sessions_generate / course_master_classes run once per batch (setting
-- lms.gen_batch for the run) and every "this intake's class times / classes" read inside them is narrowed to that batch.
-- Down: re-run both functions from 20261125031517 (drop the lms_gen_batch_ok(...) filters and the per-batch loop); drop
--       function public.lms_gen_batch_ok(uuid).
begin;

create function public.lms_gen_batch_ok(p_batch uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('lms.gen_batch', true), '') = '' or p_batch::text = current_setting('lms.gen_batch', true);
$$;

do $$
declare f text; d text; n1 int; n2 int; loop_sql text;
begin
  foreach f in array array['rto_class_sessions_generate', 'course_master_classes'] loop
    d := pg_get_functiondef(('public.' || f || '(uuid)')::regprocedure);
    select count(*) into n1 from regexp_matches(d, '\mwhere intake_id = p_batch\M', 'g');
    select count(*) into n2 from regexp_matches(d, '\mc\.intake_id = p_batch\M', 'g');
    if n1 < 4 or n2 < 1 then raise exception '%: unexpected shape (% / %)', f, n1, n2; end if;
    d := regexp_replace(d, '\mwhere intake_id = p_batch\M', 'where intake_id = p_batch and public.lms_gen_batch_ok(batch_id)', 'g');
    d := regexp_replace(d, '\mc\.intake_id = p_batch\M', 'c.intake_id = p_batch and public.lms_gen_batch_ok(c.batch_id)', 'g');
    -- several batches with class times: plan each on its own
    loop_sql := format($l$
 if coalesce(current_setting('lms.gen_batch', true), '') = ''
    and (select count(*) from public.intake_batches gb where gb.intake_id = p_batch and gb.archived_at is null
          and exists (select 1 from public.intake_class_times gt where gt.batch_id = gb.id)) > 1 then
  declare gb record; v_one jsonb; v_all jsonb := '{}'::jsonb; v_n integer := 0;
  begin
   for gb in select b.id, b.code from public.intake_batches b where b.intake_id = p_batch and b.archived_at is null
              and exists (select 1 from public.intake_class_times t where t.batch_id = b.id) order by b.sort, b.code loop
    perform set_config('lms.gen_batch', gb.id::text, true);
    begin
     v_one := public.%s(p_batch);
    exception when others then
     perform set_config('lms.gen_batch', '', true);
     raise;
    end;
    v_all := v_all || jsonb_build_object(gb.code, v_one);
    v_n := v_n + coalesce((v_one->>'created')::integer, 0);
   end loop;
   perform set_config('lms.gen_batch', '', true);
   return jsonb_build_object('created', v_n, 'batches', v_all,
     'short', coalesce((select jsonb_agg(x.value) from jsonb_each(v_all) e cross join lateral jsonb_array_elements(coalesce(e.value->'short', '[]'::jsonb)) x), '[]'::jsonb),
     'clashes', public.rto_class_session_clashes(p_batch),
     'endDate', (select max(cs.session_date) from public.class_sessions cs where cs.intake_id = p_batch));
  end;
 end if;
$l$, f);
    if position('if not found then raise exception ''Intake not found.'' using errcode = ''P0002''; end if;' in d) = 0 then
      raise exception '%: intake check not found', f;
    end if;
    d := replace(d, 'if not found then raise exception ''Intake not found.'' using errcode = ''P0002''; end if;',
                    'if not found then raise exception ''Intake not found.'' using errcode = ''P0002''; end if;' || loop_sql);
    execute d;
  end loop;
end $$;

commit;
