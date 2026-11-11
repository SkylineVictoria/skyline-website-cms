-- Drops the old HRMS template table (owner's approval 2026-11-11, step 6 of the release brief): since 20261113170000 every template
-- lives in hr.sign_templates (the six rows were copied there with the same ids, versioned), no function, view, policy or page reads
-- hr.templates, and hosted was checked for that before this file was written. The last object that named the table's row type,
-- hr.template_json(hr.templates), goes with it. A backup of the rows (SQL, JSON, CSV) is in the release backup folder.
-- Refuses to run if a row was not moved.
do $guard$
begin
 if to_regclass('hr.templates') is null then return; end if;
 if exists (select 1 from hr.templates t where not exists (select 1 from hr.sign_templates s where s.id = t.id)) then
  raise exception 'hr.templates holds a row that is not in hr.sign_templates; nothing was dropped';
 end if;
end $guard$;
drop function if exists hr.template_json(hr.templates);
drop table if exists hr.templates;
