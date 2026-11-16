-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261114065318),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
create table if not exists public.lms_attendance_register (
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.batches(id) on delete cascade,
 intake_unit_id uuid not null references public.intake_units(id) on delete cascade,
 class_date date not null,
 state text not null default 'draft' check (state in ('draft','final')),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 unique(batch_id,intake_unit_id,class_date)
);
create table if not exists public.lms_attendance_marks (
 register_id uuid not null references public.lms_attendance_register(id) on delete cascade,
 enrolment_id uuid not null references public.batch_enrolments(id),
 status text not null check(status in ('present','absent','late','excused')),
 primary key(register_id,enrolment_id)
);
alter table public.lms_attendance_register enable row level security;
alter table public.lms_attendance_marks enable row level security;
revoke all on public.lms_attendance_register,public.lms_attendance_marks from anon,authenticated;
create or replace function public.lms_attendance(p_action text,p_batch_id uuid,p_unit_id uuid default null,p_class_date date default null,p_marks jsonb default '[]'::jsonb,p_state text default 'draft')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_register uuid; v_entry jsonb; v_enrolment uuid; v_status text;
begin
 if not public.cms_is_staff() then raise exception 'CMS staff access required' using errcode='42501'; end if;
 if not exists(select 1 from public.batches where id=p_batch_id) then raise exception 'Batch not found'; end if;
 if p_action='history' then
 return coalesce((select jsonb_agg(jsonb_build_object('date',class_date,'unitId',intake_unit_id,'state',state) order by class_date desc) from (select * from public.lms_attendance_register where batch_id=p_batch_id order by class_date desc limit 60) t),'[]'::jsonb);
 end if;
 if p_unit_id is null or p_class_date is null then raise exception 'Unit and class date required'; end if;
 if not exists(select 1 from public.intake_units u join public.batches b on b.intake_id=u.intake_id where b.id=p_batch_id and u.id=p_unit_id) then raise exception 'Unit does not belong to batch'; end if;
 select id into v_register from public.lms_attendance_register where batch_id=p_batch_id and intake_unit_id=p_unit_id and class_date=p_class_date;
 if p_action='get' then
 return jsonb_build_object('state',coalesce((select state from public.lms_attendance_register where id=v_register),'new'),'marks',coalesce((select jsonb_object_agg(enrolment_id::text,status) from public.lms_attendance_marks where register_id=v_register),'{}'::jsonb));
 elsif p_action='save' then
 if not public.cms_is_rto_manager() then raise exception 'RTO Manager permission required' using errcode='42501'; end if;
 if p_state not in ('draft','final') then raise exception 'Invalid state'; end if;
 insert into public.lms_attendance_register(batch_id,intake_unit_id,class_date,state,updated_by)
 values(p_batch_id,p_unit_id,p_class_date,p_state,auth.uid())
 on conflict(batch_id,intake_unit_id,class_date) do update set state=excluded.state,updated_at=now(),updated_by=excluded.updated_by returning id into v_register;
 delete from public.lms_attendance_marks where register_id=v_register;
 for v_entry in select value from jsonb_array_elements(p_marks) loop
 v_enrolment := (v_entry->>'enrolmentId')::uuid; v_status:=v_entry->>'status';
 if v_status not in ('present','absent','late','excused') then raise exception 'Invalid attendance status'; end if;
 if not exists(select 1 from public.batch_enrolments where id=v_enrolment and batch_id=p_batch_id and status in ('active','deferred')) then raise exception 'Student is not enrolled in this batch'; end if;
 insert into public.lms_attendance_marks(register_id,enrolment_id,status) values(v_register,v_enrolment,v_status);
 end loop;
 return jsonb_build_object('saved',true,'state',p_state);
 end if;
 raise exception 'Unknown action';
end $$;
revoke all on function public.lms_attendance(text,uuid,uuid,date,jsonb,text) from public;
grant execute on function public.lms_attendance(text,uuid,uuid,date,jsonb,text) to authenticated;
