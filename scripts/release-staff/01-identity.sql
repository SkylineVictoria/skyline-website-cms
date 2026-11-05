-- READ-ONLY identity check. Run in the SQL editor of project xcpydisstlvtvcsqnjob ONLY, before anything else.
-- Must return 7692130048193495360. If it differs, STOP.
select system_identifier::text as system_identifier,
       system_identifier = 7692130048193495360 as ok
from pg_control_system();
