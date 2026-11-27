-- Wizard answers that had no AVETMISS code (they would have blocked enrolment)
insert into public.avetmiss_code_aliases (code_set, alias, code) values
('sex','prefer not to say','@'),('sex','not stated','@'),
('flag','not specified','@'),('flag','prefer not to say','@'),('flag','not stated','@'),
('indigenous_status','prefer not to say','@'),('indigenous_status','not stated','@'),
('school_level','prefer not to say','@@'),('school_level','not stated','@@'),
('labour_force','prefer not to say','@@'),('labour_force','not stated','@@'),
('country','viet nam','5105'),('country','korea, republic of','6203'),
('country','tanzania, the united republic of','9227'),('country','tanzania','9227')
on conflict do nothing;