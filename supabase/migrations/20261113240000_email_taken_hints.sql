-- Email unique within a role (20261112042544): the functions that refuse a duplicate email themselves, before the identity
-- trigger runs, now say so the same way: SQLSTATE 23505 with hint 'email_taken', so the forms map the refusal to the email
-- field. Owner decision 2026-11-12: only the hint is added; messages, codes and every check stay as they are.
-- Where one message covers "email or mobile", the hint is set only when the email is the duplicate (a mobile duplicate keeps
-- no hint and stays a form error).
-- Guarded patch (as 20261113220000): each function is read as it is in this database, each fragment must occur exactly once,
-- and only that fragment changes. Hosted holds versions of some of these functions that differ from the repo files outside
-- these fragments; those differences are kept.

create or replace function pg_temp.email_patch(p_function regprocedure, p_pairs text[]) returns void language plpgsql as $fn$
declare body text := pg_get_functiondef(p_function); pair text[];
begin
  foreach pair slice 1 in array p_pairs loop
    if pair[1] = '' or (length(body) - length(replace(body, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'Unexpected definition of %: expected exactly one "%"', p_function, pair[1];
    end if;
    body := replace(body, pair[1], pair[2]);
  end loop;
  execute body;
end $fn$;

-- Admin CMS: Activate / add agent (20261104090000).
select pg_temp.email_patch('public.admin_agent_activate(uuid,uuid,text,text,text,text,text)', array[
  [$a$'An agent with this email is already in this business' using errcode = '23505'$a$,
   $b$'An agent with this email is already in this business' using errcode = '23505', hint = 'email_taken'$b$]
]);

-- Admin CMS: Edit student (20261104220000). Its unique_violation handler catches both its own email refusal and the identity
-- trigger (both 23505) and raises the combined message; the hint follows the email cases only.
select pg_temp.email_patch('public.admin_student_update(uuid,text,text,text,date,text,text,uuid)', array[
  [$a$'Another student already has this email' using errcode = '23505'$a$,
   $b$'Another student already has this email' using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'Another student already has this email or mobile' using errcode = '23505'$a$,
   $b$'Another student already has this email or mobile' using errcode = '23505', hint = case when sqlerrm in ('Another student already has this email', 'This email is already in use. Please use a different email address.') then 'email_taken' else '' end$b$]
]);

-- Portal invitations (20261104270000): an email that already signs in, or already has a pending invitation.
select pg_temp.email_patch('public.portal_invitation_create(uuid,uuid,text,text,text,uuid)', array[
  [$a$'This email already belongs to an active portal user.' using errcode = '23505'$a$,
   $b$'This email already belongs to an active portal user.' using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'An earlier invitation for this email has expired. Resend it instead of creating a new one.' using errcode = '23505'$a$,
   $b$'An earlier invitation for this email has expired. Resend it instead of creating a new one.' using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'This email has already been invited. Resend or revoke the pending invitation.' using errcode = '23505'$a$,
   $b$'This email has already been invited. Resend or revoke the pending invitation.' using errcode = '23505', hint = 'email_taken'$b$]
]);

-- HRMS: Employees > Add (20261110090000). One message for email or mobile.
select pg_temp.email_patch('public.hr_admin_staff_add(text,text,text,text)', array[
  [$a$'This email or mobile already has a staff record. Open it from Employees.' using errcode = '23505'$a$,
   $b$'This email or mobile already has a staff record. Open it from Employees.' using errcode = '23505', hint = case when exists (select 1 from hr.staff_profiles s where s.email = v_email) then 'email_taken' else '' end$b$]
]);

-- HRMS: Employees > Edit (20261110190000).
select pg_temp.email_patch('public.hr_admin_emp_save(uuid,jsonb)', array[
  [$a$'% is already an employee (%).', v_email, p.status using errcode = '23505'$a$,
   $b$'% is already an employee (%).', v_email, p.status using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'Another staff record already uses %.', v_email using errcode = '23505'$a$,
   $b$'Another staff record already uses %.', v_email using errcode = '23505', hint = 'email_taken'$b$]
]);

-- HRMS: Candidates add / edit (hr.admin_save_person, 20261110090000).
select pg_temp.email_patch('hr.admin_save_person(uuid,jsonb)', array[
  [$a$'This email belongs to a staff record with a different mobile number. Open it from Employees.' using errcode = '23505'$a$,
   $b$'This email belongs to a staff record with a different mobile number. Open it from Employees.' using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'This email belongs to an active admin console user.' using errcode = '23505'$a$,
   $b$'This email belongs to an active admin console user.' using errcode = '23505', hint = 'email_taken'$b$],
  [$a$'Another staff record already uses this email or mobile.' using errcode = '23505'$a$,
   $b$'Another staff record already uses this email or mobile.' using errcode = '23505', hint = case when exists (select 1 from hr.staff_profiles x where x.id <> p.id and x.email = v_email) then 'email_taken' else '' end$b$]
]);

-- Complete profile after a Google / phone sign-up (20261105100000). Its unique_violation handler re-raises the identity
-- trigger's own error (message not 'duplicate key value...'), which already carries the hint.
select pg_temp.email_patch('public.portal_self_enrol_complete(jsonb)', array[
  [$a$'A student with this email is already on record. Sign in with that email instead, or contact SLIT Administration.' using errcode = '23505'$a$,
   $b$'A student with this email is already on record. Sign in with that email instead, or contact SLIT Administration.' using errcode = '23505', hint = 'email_taken'$b$]
]);
