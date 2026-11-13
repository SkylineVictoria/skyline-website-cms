-- Assessment Management hardening, T5: Submissions feature parity (behaviour only, no data; HARDENING.md "T5").
--  * Student acknowledgment of a result: a returned or final attempt carries acknowledged_at once the student confirms they
--    have read the outcome and feedback (Submissions' acknowledgment gate); the portal lists results waiting for it and the
--    assessor / admin see when it happened. Audited (student, result_acknowledge).
--  * Idempotent final submit: the client sends a requestId with the submission; a retry of the same request after a lost
--    response returns the original receipt instead of "already submitted" (Submissions' request-id submit RPC).

alter table public.asm_attempts
 add column if not exists acknowledged_at timestamptz,
 add column if not exists submit_request_id text check (submit_request_id is null or char_length(submit_request_id) between 1 and 80);

do $mig$
declare d text; n text; cnt integer; fn text;
 patches text[][] := array[
  -- submit: the same request again returns the same receipt; the request id is kept with the submission
  array['public.asm_student(text, jsonb)',
   $o$if v_att.state <> 'draft' then raise exception 'This attempt has already been submitted' using errcode = '42501'; end if;$o$,
   $o$if v_att.state <> 'draft' and v_att.submit_request_id is not null and v_att.submit_request_id = public.asm_json_text(d, 'requestId') then
   return jsonb_build_object('ok', true, 'receiptNo', v_att.receipt_no, 'submittedAt', v_att.submitted_at, 'responsesSha256', v_att.responses_hash, 'idempotent', true);
  end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has already been submitted' using errcode = '42501'; end if;$o$, '1'],
  array['public.asm_student(text, jsonb)',
   $o$update public.asm_attempts set state = 'submitted', submitted_at = v_now, responses_hash = v_hash, declaration = v_decl, receipt_no = v_receipt where id = v_id;$o$,
   $o$update public.asm_attempts set state = 'submitted', submitted_at = v_now, responses_hash = v_hash, declaration = v_decl, receipt_no = v_receipt, submit_request_id = public.asm_json_text(d, 'requestId') where id = v_id;$o$, '1'],
  -- acknowledgment: the student confirms a returned or final result
  array['public.asm_student(text, jsonb)',
   $o$elsif p_action = 'results' then$o$,
   $o$elsif p_action = 'result_acknowledge' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) and state in ('returned', 'final');
  if v_att.id is null then raise exception 'There is no returned result to acknowledge' using errcode = 'P0002'; end if;
  if v_att.acknowledged_at is null then
   update public.asm_attempts set acknowledged_at = now() where id = v_id returning * into v_att;
   perform public.asm_log('student', 'result_acknowledge', 'attempt', v_id::text, jsonb_build_object('outcome', v_att.outcome, 'acknowledgedAt', v_att.acknowledged_at), v_att.tenant_id);
  end if;
  return jsonb_build_object('ok', true, 'acknowledgedAt', v_att.acknowledged_at);
 elsif p_action = 'results' then$o$, '1'],
  array['public.asm_student(text, jsonb)',
   $o$'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no) order by t.attempt_no)$o$,
   $o$'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no, 'acknowledgedAt', t.acknowledged_at) order by t.attempt_no)$o$, '1'],
  array['public.asm_attempt_json(uuid, text)',
   $o$'startedAt', t.started_at, 'submittedAt', t.submitted_at, 'returnedAt', t.returned_at, 'finalisedAt', t.finalised_at, 'rowVersion', t.row_version,$o$,
   $o$'startedAt', t.started_at, 'submittedAt', t.submitted_at, 'returnedAt', t.returned_at, 'finalisedAt', t.finalised_at, 'acknowledgedAt', t.acknowledged_at, 'rowVersion', t.row_version,$o$, '1']
 ];
begin
 for i in 1 .. array_length(patches, 1) loop
  fn := patches[i][1];
  d := pg_get_functiondef(fn::regprocedure);
  cnt := (length(d) - length(replace(d, patches[i][2], ''))) / length(patches[i][2]);
  if cnt <> patches[i][4]::integer then raise exception 'asm parity: anchor % in % found % times, expected %', patches[i][2], fn, cnt, patches[i][4]; end if;
  n := replace(d, patches[i][2], patches[i][3]);
  execute n;
 end loop;
end $mig$;
