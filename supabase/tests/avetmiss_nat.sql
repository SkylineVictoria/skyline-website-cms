begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- AVETMISS-NAT (20261127060517): the NAT files build from the database's own data and a valid set passes the checker; every kind of
-- break (code, required field, cross-file link, outcome date) is reported. Rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(18);

-- The NAT files build from this database (every file present, JSON arrays).
select ok((select bool_and(public.avetmiss_nat_build() ? f) from unnest(array['NAT00010','NAT00020','NAT00030','NAT00060','NAT00080',
  'NAT00085','NAT00090','NAT00100','NAT00120','NAT00130']) f), 'every NAT file is built');
select lives_ok($$select count(*) from public.avetmiss_nat_problems(public.avetmiss_nat_build())$$, 'the built files can be checked');

-- A small valid collection: one RTO, location, program, subject, client, activity, completion.
create temp table v as select jsonb_build_object(
  'NAT00010', jsonb_build_array(jsonb_build_object('toid','45989','name','RTO','org_type','91','address1','1 St','suburb','Melbourne','postcode','3000','state','02','contact_name','A Person')),
  'NAT00020', jsonb_build_array(jsonb_build_object('location_id','MEL CBD','name','Campus','suburb','Melbourne','postcode','3000','state','02','country','1101')),
  'NAT00030', jsonb_build_array(jsonb_build_object('program_id','AUR30620','level','514','recognition','11','foe','0305','anzsco','321211','nominal_hours',960)),
  'NAT00060', jsonb_build_array(jsonb_build_object('subject_id','AURAEA002','foe','030500','vet_flag','Y','nominal_hours',20)),
  'NAT00080', jsonb_build_array(jsonb_build_object('client_id','S0001','missing','[]'::jsonb)),
  'NAT00085', jsonb_build_array(jsonb_build_object('client_id','S0001')),
  'NAT00090', '[]'::jsonb, 'NAT00100', '[]'::jsonb,
  'NAT00120', jsonb_build_array(jsonb_build_object('location_id','MEL CBD','client_id','S0001','subject_id','AURAEA002','program_id','AUR30620',
     'start','2026-02-02','end','2026-03-01','actual_end','2026-03-01','outcome','20','delivery_mode','YNN','predominant_delivery_mode','I',
     'funding','31','study_reason','01','commencing','3')),
  'NAT00130', jsonb_build_array(jsonb_build_object('program_id','AUR30620','client_id','S0001','year',2026))) n;

create function pg_temp.probs(p jsonb) returns text language sql as $$
  select coalesce(string_agg(nat || ': ' || problem, ' | ' order by nat, problem), '') from public.avetmiss_nat_problems(p) $$;
create function pg_temp.with120(k text, val jsonb) returns jsonb language sql as $$
  select jsonb_set(n, '{NAT00120,0}', (n #> '{NAT00120,0}') || jsonb_build_object(k, val)) from v $$;

select is(pg_temp.probs((select n from v)), '', 'a valid collection has no problems');
select ok(pg_temp.probs(pg_temp.with120('client_id', '"S9999"')) like '%NAT00120: client not in NAT00080%', 'activity for a client not in NAT00080');
select ok(pg_temp.probs(pg_temp.with120('subject_id', '"XYZ"')) like '%NAT00120: subject not in NAT00060%', 'activity for a subject not in NAT00060');
select ok(pg_temp.probs(pg_temp.with120('program_id', '"XYZ"')) like '%NAT00120: program not in NAT00030%', 'activity for a program not in NAT00030');
select ok(pg_temp.probs(pg_temp.with120('location_id', '"NOWHERE"')) like '%NAT00120: delivery location not in NAT00020%', 'activity at a location not in NAT00020');
select ok(pg_temp.probs(pg_temp.with120('outcome', '"99"')) like '%outcome identifier not a code%', 'an outcome that is not a code');
select ok(pg_temp.probs(pg_temp.with120('actual_end', 'null')) like '%final outcome 20 needs its actual end date%', 'a final outcome without its actual end date');
select is(pg_temp.probs(pg_temp.with120('outcome', '"70"') #- '{NAT00120,0,actual_end}'), '', 'continuing (70) reports the planned end date');
select ok(pg_temp.probs(pg_temp.with120('delivery_mode', '"Y"')) like '%three Y/N flags%', 'a malformed delivery mode');
select ok(pg_temp.probs(pg_temp.with120('commencing', 'null')) like '%commencing program identifier missing%', 'a missing commencing program identifier');
select ok(pg_temp.probs(jsonb_set((select n from v), '{NAT00060,0,foe}', '"0305"')) like '%NAT00060: subject field of education identifier must be 6 digits%', 'a 4-digit subject field of education');
select ok(pg_temp.probs(jsonb_set((select n from v), '{NAT00030,0,level}', 'null')) like '%program level of education identifier missing%', 'a program without its level of education');
select ok(pg_temp.probs(jsonb_set((select n from v), '{NAT00080,0,missing}', '["USI"]')) like '%NAT00080: USI missing%', 'a client record missing its USI');
select ok(pg_temp.probs(jsonb_set((select n from v), '{NAT00130,0,client_id}', '"S9999"')) like '%NAT00130: client not in NAT00080%', 'a completion for a client not in NAT00080');

-- QUALIFICATION (2026-11-27): a Cancelled Qualification closes its started units as withdrawn (40) on the withdrawal date
select is(pg_temp.probs(pg_temp.with120('outcome', '"40"')), '', 'a unit withdrawn with its Qualification (40) reports the withdrawal date as its actual end');
select ok(pg_temp.probs(pg_temp.with120('outcome', '"40"') #- '{NAT00120,0,actual_end}') like '%final outcome 40 needs its actual end date%', 'a withdrawn unit (40) without the withdrawal date is a problem');
select * from finish();
rollback;
