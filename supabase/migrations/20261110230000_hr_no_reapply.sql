-- No second application (owner's decision 2026-11-10): a person who already has an OPEN application (applied with a resume, invited,
-- documents_submitted, offer_sent, offer_signed) or is an ACTIVE employee cannot apply again, on the staff form or on a Careers job.
-- Before this, a Careers application from such a person added a new job application to their record; now nothing is recorded.
-- The public answer stays the same thank-you ({ok:false, reason:'exists'}), and the address itself is told at most once an hour
-- ("already applied"), on both forms. Unchanged: a rejected or inactive person, and an application still waiting for its resume,
-- may apply again; another person's mobile number and an active admin console user are refused.
-- Only hr_svc_apply changes (same signature and grants). Rollback (manual): re-run its body from 20261110090000.
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.hr_svc_apply(p_first_name text, p_last_name text, p_email text, p_phone text, p_job uuid default null, p_cover_letter text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_email text := hr.email_key(p_email); v_phone text := hr.phone_e164(p_phone); p hr.staff_profiles; a hr.staff_applications;
 v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, '')); v_letter text := btrim(coalesce(p_cover_letter, '')); v_job_app uuid;
begin
 if p_job is not null and not exists (select 1 from hr.jobs j where j.id = p_job and j.status = 'open') then return jsonb_build_object('ok', false, 'reason', 'job_closed'); end if;
 if char_length(v_letter) > 5000 then return jsonb_build_object('ok', false, 'reason', 'invalid_cover_letter'); end if;
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or char_length(v_email) > 254 then return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
 if v_phone is null then return jsonb_build_object('ok', false, 'reason', 'invalid_phone'); end if;
 if v_first = '' or v_last = '' or char_length(v_first) > 100 or char_length(v_last) > 100 or (v_first || v_last) ~ '[[:cntrl:]<>]' then
  return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
 -- An ACTIVE admin console user cannot apply; a deactivated former Admin (cms_users Inactive) can.
 if exists (select 1 from public.cms_users c where hr.email_key(c.email) = v_email and c.status = 'Active') then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
 select * into p from hr.staff_profiles where email = v_email for update;
 if found then
  select * into a from hr.staff_applications where profile_id = p.id;
  if not (p.status in ('rejected','inactive') or (p.status = 'applied' and a.resume_path is null)) then
   -- The address already has an open application or is an active employee: tell THAT address (never a different one), at most once an hour. The
   -- caller's answer stays the same thank-you; staff-register's per-email rate limit applies before this is reached.
   -- No second application, for a job or otherwise: nothing is recorded.
   if not exists (select 1 from hr.staff_emails e where e.profile_id = p.id and e.kind = 'already_applied' and e.created_at > now() - interval '1 hour') then
    perform hr.queue_email(p.id, 'already_applied', 'applicant');
   end if;
   return jsonb_build_object('ok', false, 'reason', 'exists');
  end if;
 end if;
 if exists (select 1 from hr.staff_profiles s where s.phone_e164 = v_phone and s.id is distinct from p.id) then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
 perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Applied', true);
 if p.id is null then
  insert into hr.staff_profiles(first_name, last_name, email, phone_e164) values (v_first, v_last, v_email, v_phone) returning * into p;
  insert into hr.staff_applications(profile_id) values (p.id);
 else
  update hr.staff_profiles set first_name = v_first, last_name = v_last, phone_e164 = v_phone, status = 'applied' where id = p.id returning * into p;
  update hr.staff_applications set resume_path = null, resume_filename = null, resume_mime = null, resume_size = null, resume_uploaded_at = null,
   submitted_at = null, reviewed_by = null, reviewed_at = null, review_note = '', account_invited_at = null where profile_id = p.id;
  update hr.staff_documents set is_current = false where profile_id = p.id and is_current;
  update hr.staff_roles set revoked_at = now() where profile_id = p.id and revoked_at is null;
 end if;
 if p_job is not null then
  -- A new application for this job (a decided one stays in the job's history), or the open one of an application still waiting for its
  -- resume, whose cover letter is replaced.
  select id into v_job_app from hr.job_applications x where x.job_id = p_job and x.profile_id = p.id and x.status = 'applied';
  if v_job_app is null then
   insert into hr.job_applications(job_id, profile_id, cover_letter) values (p_job, p.id, v_letter) returning id into v_job_app;
  else
   update hr.job_applications set cover_letter = v_letter, cover_letter_path = null, cover_letter_filename = null, cover_letter_mime = null, cover_letter_size = null, stage = 'screening' where id = v_job_app;
  end if;
 end if;
 return jsonb_build_object('ok', true, 'profileId', p.id, 'jobApplicationId', v_job_app);
end $fn$;
revoke all on function public.hr_svc_apply(text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.hr_svc_apply(text, text, text, text, uuid, text) to service_role;
