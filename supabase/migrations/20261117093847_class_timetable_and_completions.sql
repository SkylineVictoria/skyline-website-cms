-- MY-TIMETABLE + COURSE-COMPLETION. Additive.
-- 1. my_class_schedule(from, to): the signed-in student's classes (their active / deferred batches) or the signed-in trainer's classes
--    (batches they train, or units they train in a batch) from class_sessions, with unit, room and trainer. At most 120 days at a time.
-- 2. course_completions: one record per issued Certificate (every unit of the batch's intake has a current Competent outcome; the
--    enrolment becomes completed) or Statement of Attainment (at least one Competent unit). Numbered SLIT-<kind>-<year>-<seq>, with
--    a snapshot of the units and outcomes at issue. RTO Managers issue and revoke (with a reason); staff read; a student reads their own.
--    course_completion_list(batch) shows each enrolment's progress and whether a certificate can be issued.
-- Rollback (manual): drop the functions below; drop table public.course_completions; drop sequence public.course_completion_seq.
begin;

create function public.my_class_schedule(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then raise exception 'Student or staff access required' using errcode = '42501'; end if;
  return jsonb_build_object('role', case when v_student is not null then 'student' else 'trainer' end, 'sessions', coalesce((
    select jsonb_agg(jsonb_build_object('id', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
      'type', cs.session_type, 'status', cs.status, 'batchName', b.name, 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus,
      'trainers', coalesce((select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from hr.staff_profiles p where p.id in (
          select ut.staff_id from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id
          where ut.batch_id = b.id and iu.unit_id = cs.unit_id)), (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from public.batch_trainers bt join hr.staff_profiles p on p.id = bt.staff_id where bt.batch_id = b.id), ''))
      order by cs.session_date, cs.start_time)
    from public.class_sessions cs
    join public.batches b on b.id = cs.batch_id
    join public.course_intakes ci on ci.id = b.intake_id
    join public.cms_courses c on c.id = ci.course_id
    left join public.cms_course_units u on u.id = cs.unit_id
    left join public.classrooms r on r.id = cs.room_id
    where cs.session_date between p_from and p_to
      and (case when v_student is not null then exists (select 1 from public.batch_enrolments e where e.batch_id = b.id and e.student_id = v_student and e.status in ('active', 'deferred'))
        else exists (select 1 from public.batch_trainers bt where bt.batch_id = b.id and bt.staff_id = v_staff)
          or exists (select 1 from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id
            where ut.batch_id = b.id and ut.staff_id = v_staff and iu.unit_id = cs.unit_id) end)), '[]'::jsonb));
end;
$$;

create sequence public.course_completion_seq;
create table public.course_completions(
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.batch_enrolments(id) on delete restrict,
  student_id uuid not null references public.enrollment_students(id) on delete restrict,
  batch_id uuid not null references public.batches(id) on delete restrict,
  course_id text not null references public.cms_courses(id) on delete restrict,
  kind text not null check (kind in ('certificate', 'statement')),
  certificate_no text not null unique,
  student_name text not null,
  course_code text not null default '',
  course_name text not null default '',
  units jsonb not null default '[]' check (jsonb_typeof(units) = 'array'),
  issued_at timestamptz not null default now(),
  issued_by uuid default auth.uid(),
  issued_by_name text not null default '',
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 3 and 500)
);
create unique index course_completions_one_current on public.course_completions(enrolment_id, kind) where revoked_at is null;
create index course_completions_student on public.course_completions(student_id, issued_at desc);
alter table public.course_completions enable row level security;
revoke all on public.course_completions from public, anon, authenticated, service_role;
grant select on public.course_completions to service_role;

-- Units of the enrolment's intake with each one's current outcome (the latest outcome not superseded).
create function public.course_completion_units(p_enrolment uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'outcome', o.outcome, 'date', o.signed_at::date) order by iu.sort, iu.start_date, u.sort), '[]'::jsonb)
  from public.batch_enrolments e
  join public.batches b on b.id = e.batch_id
  join public.intake_units iu on iu.intake_id = b.intake_id
  join public.cms_course_units u on u.id = iu.unit_id
  left join lateral (select x.outcome, x.signed_at from public.asm_unit_outcomes x
    where x.student_id = e.student_id and x.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = x.id)
    order by x.signed_at desc limit 1) o on true
  where e.id = p_enrolment;
$$;

create function public.course_completion_json(c public.course_completions) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', c.id, 'enrolmentId', c.enrolment_id, 'studentId', c.student_id, 'kind', c.kind, 'certificateNo', c.certificate_no,
    'studentName', c.student_name, 'courseCode', c.course_code, 'courseName', c.course_name, 'units', c.units, 'issuedAt', c.issued_at,
    'issuedByName', c.issued_by_name, 'revokedAt', c.revoked_at, 'revokeReason', c.revoke_reason);
$$;

create function public.course_completion_list(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x->>'studentName') from (
    select jsonb_build_object('enrolmentId', e.id, 'studentId', s.id, 'studentName', s.full_name, 'enrolmentStatus', e.status,
      'units', public.course_completion_units(e.id),
      'completions', coalesce((select jsonb_agg(public.course_completion_json(cc) order by cc.issued_at desc) from public.course_completions cc
        where cc.enrolment_id = e.id and cc.revoked_at is null), '[]'::jsonb)) as x
    from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
    where e.batch_id = p_batch) t), '[]'::jsonb);
end;
$$;

create function public.course_completion_issue(p_enrolment uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.batch_enrolments; s public.enrollment_students; c public.cms_courses; v_course text; v_units jsonb; v_total int; v_c int;
  v_name text; r public.course_completions;
begin
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if p_kind not in ('certificate', 'statement') then raise exception 'Unknown document' using errcode = '22023'; end if;
  select * into e from public.batch_enrolments where id = p_enrolment for update;
  if not found then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  if e.status = 'withdrawn' then raise exception 'This student has withdrawn from the batch' using errcode = '22023'; end if;
  if exists (select 1 from public.course_completions where enrolment_id = e.id and kind = p_kind and revoked_at is null) then
    raise exception 'Already issued. Revoke the current one first to issue again.' using errcode = '23505';
  end if;
  select * into s from public.enrollment_students where id = e.student_id;
  select ci.course_id into v_course from public.batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = e.batch_id;
  select * into c from public.cms_courses where id = v_course;
  v_units := public.course_completion_units(e.id);
  v_total := jsonb_array_length(v_units);
  select count(*) into v_c from jsonb_array_elements(v_units) u where u->>'outcome' = 'C';
  if v_total = 0 then raise exception 'This batch has no units' using errcode = '22023'; end if;
  if p_kind = 'certificate' and v_c < v_total then
    raise exception 'A certificate needs every unit marked Competent (% of % so far)', v_c, v_total using errcode = '22023';
  end if;
  if p_kind = 'statement' and v_c = 0 then raise exception 'A statement of attainment needs at least one Competent unit' using errcode = '22023'; end if;
  if p_kind = 'statement' then
    select coalesce(jsonb_agg(u), '[]'::jsonb) into v_units from jsonb_array_elements(v_units) u where u->>'outcome' = 'C';
  end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid() limit 1;
  insert into public.course_completions(enrolment_id, student_id, batch_id, course_id, kind, certificate_no, student_name, course_code, course_name, units, issued_by_name)
  values (e.id, e.student_id, e.batch_id, v_course, p_kind,
    'SLIT-' || case p_kind when 'certificate' then 'C' else 'SOA' end || '-' || to_char(now() at time zone 'Australia/Melbourne', 'YYYY') || '-' || lpad(nextval('public.course_completion_seq')::text, 6, '0'),
    s.full_name, coalesce(c.code, ''), coalesce(c.name, ''), v_units, coalesce(v_name, ''))
  returning * into r;
  if p_kind = 'certificate' then update public.batch_enrolments set status = 'completed' where id = e.id; end if;
  return public.course_completion_json(r);
end;
$$;

create function public.course_completion_revoke(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.course_completions;
begin
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason' using errcode = '22023'; end if;
  update public.course_completions set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason)
  where id = p_id and revoked_at is null returning * into r;
  if not found then raise exception 'Not found or already revoked' using errcode = 'P0002'; end if;
  if r.kind = 'certificate' then update public.batch_enrolments set status = 'active' where id = r.enrolment_id and status = 'completed'; end if;
  return public.course_completion_json(r);
end;
$$;

-- One document for printing: staff, or the student it belongs to.
create function public.course_completion_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.course_completions;
begin
  select * into r from public.course_completions where id = p_id;
  if not found then return null; end if;
  if not (coalesce(public.cms_is_staff(), false) or r.student_id = public.portal_student_id()) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return public.course_completion_json(r);
end;
$$;

create function public.my_course_completions() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.course_completion_json(c) order by c.issued_at desc), '[]'::jsonb)
  from public.course_completions c where c.student_id = public.portal_student_id() and c.revoked_at is null;
$$;

revoke all on function public.my_class_schedule(date, date), public.course_completion_units(uuid), public.course_completion_json(public.course_completions),
  public.course_completion_list(uuid), public.course_completion_issue(uuid, text), public.course_completion_revoke(uuid, text),
  public.course_completion_get(uuid), public.my_course_completions() from public, anon;
revoke all on function public.course_completion_units(uuid), public.course_completion_json(public.course_completions) from authenticated;
grant execute on function public.my_class_schedule(date, date), public.course_completion_list(uuid), public.course_completion_issue(uuid, text),
  public.course_completion_revoke(uuid, text), public.course_completion_get(uuid), public.my_course_completions() to authenticated;
revoke all on sequence public.course_completion_seq from public, anon, authenticated;

commit;
