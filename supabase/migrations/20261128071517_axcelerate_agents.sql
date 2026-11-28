-- AXCELERATE-AGENTS (owner 2026-11-28: "import all the things we need with Himani, agent and all"). One way only, aXcelerate -> Skyline.
--   * Student extras: title, citizenship / nationality (residency becomes international through the existing trigger), visa,
--     alternative email, emergency contact, city of birth. USI goes to usi_number (the key the form and the AVETMISS checks read;
--     the 20261128051517 import wrote "usi", so the USI looked missing). No English proficiency in aXcelerate for a student who speaks
--     another language at home: stored as Not stated (@) with a warning (AVETMISS needs a value; @ is what a NAT file carries).
--   * Agents (owner: "Inactive until signed"): the student's aXcelerate agent becomes a Skyline agent, Inactive (no portal access) until
--     their agent agreement is signed or an admin records a signed copy (agents_require_agreement is not bypassed).
--   * Agencies (owner: "their own agency"): the agent's aXcelerate organisation becomes (or is matched to, by link, ABN or name) a Skyline
--     business; without an organisation, a business is made for the agent. An imported student moves from the direct-students business
--     to the agent's business while they have no applications (a student with applications keeps their business; the agent is linked
--     only when the business is the same).
--   * Links: entities agent, agency (and qualification, for the next stage); edits and deletes of agents and businesses are tracked.
begin;

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification'));

drop trigger if exists axcelerate_link_touch on public.agents;
create trigger axcelerate_link_touch after update or delete on public.agents for each row execute function public.axcelerate_link_touch();
drop trigger if exists axcelerate_link_touch on public.agencies;
create trigger axcelerate_link_touch after update or delete on public.agencies for each row execute function public.axcelerate_link_touch();

create or replace function public.axcelerate_student_values(p_rec jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  r jsonb := coalesce(p_rec, '{}'::jsonb); d jsonb := '{}'::jsonb; w text[] := '{}'; v text; a text; v_codes text[]; x text; v_rows jsonb := '[]'::jsonb;
  v_first text := left(public.axcelerate_text(r, 'GIVENNAME', 'FIRSTNAME'), 100);
  v_last text := left(public.axcelerate_text(r, 'SURNAME', 'LASTNAME'), 100);
  v_middle text := left(public.axcelerate_text(r, 'MIDDLENAME'), 100);
  v_email text := lower(public.axcelerate_text(r, 'EMAILADDRESS', 'EMAIL'));
  v_phone text := public.axcelerate_phone(public.axcelerate_text(r, 'MOBILEPHONE', 'MOBILE', 'PHONE'));
  v_dob date := public.axcelerate_date(public.axcelerate_text(r, 'DOB', 'DATEOFBIRTH'));
  v_street text; v_line2 text; v_suburb text; v_state text; v_post text; v_res boolean;
  v_cols jsonb; v_items text[]; v_names text[]; v_code text; v_recog text; i int;
begin
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$') then
    w := w || format('Email "%s" is not a valid address; left empty.', v_email); v_email := null;
  end if;
  if public.axcelerate_text(r, 'MOBILEPHONE', 'MOBILE', 'PHONE') is not null and v_phone is null then
    w := w || 'The mobile number is not a valid phone number; left empty.'::text;
  end if;
  if v_dob is not null and (v_dob > current_date or v_dob < current_date - interval '100 years') then
    w := w || format('Date of birth %s is not valid; left empty.', v_dob); v_dob := null;
  end if;
  if v_first is not null then d := d || jsonb_build_object('first_name', v_first); end if;
  if v_last is not null then d := d || jsonb_build_object('last_name', v_last); end if;
  if v_middle is not null then d := d || jsonb_build_object('middle_name', v_middle); end if;
  v := left(public.axcelerate_text(r, 'PREFERREDNAME'), 100); if v is not null then d := d || jsonb_build_object('preferred_name', v); end if;
  if v_email is not null then d := d || jsonb_build_object('email', v_email, 'confirm_email', v_email); end if;
  if v_phone is not null then d := d || jsonb_build_object('mobile', v_phone); end if;
  if v_dob is not null then d := d || jsonb_build_object('dob', to_char(v_dob, 'YYYY-MM-DD')); end if;

  -- AVETMISS answers (codes from aXcelerate; stored only when they are codes of the AVETMISS lists).
  v := public.axcelerate_text(r, 'SEX', 'GENDER');
  if v is not null then a := public.axcelerate_avetmiss_answer('sex', v, array['Male', 'Female', 'Prefer not to say']);
    if a is null then w := w || format('Sex "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('gender', a); end if; end if;
  v := public.axcelerate_text(r, 'INDIGENOUSSTATUSID', 'INDIGENOUSSTATUS', 'ATSI');
  if v is not null then a := public.axcelerate_avetmiss_answer('indigenous_status', v, array['No', 'Yes, Aboriginal', 'Yes, Torres Strait Islander', 'Yes, Aboriginal and Torres Strait Islander']);
    if a is null then w := w || format('Indigenous status "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('atsi', a); end if; end if;
  v := public.axcelerate_text(r, 'LABOURFORCEID', 'LABOURFORCESTATUSID', 'EMPLOYMENTSTATUSID');
  if v is not null then a := public.axcelerate_avetmiss_answer('labour_force', v, array['Full-Time Employee - 01', 'Part-Time Employee - 02',
      'Self-Employment Not Employing Others - 03', 'Self employed - employing others - 04', 'Employed - Unpaid Worker in Family Business - 05',
      'Unemployed - Seeking Full-Time Work - 06', 'Unemployed - Seeking Part-Time Work - 07', 'Not Employed - Not Seeking Employment - 08']);
    if a is null then w := w || format('Labour force status "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('employment', a); end if; end if;
  v := public.axcelerate_text(r, 'HIGHESTSCHOOLLEVELID', 'SCHOOLLEVELID', 'HIGHESTSCHOOLLEVEL');
  if v is not null then a := public.axcelerate_avetmiss_answer('school_level', v, array['Year 12 or equivalent - 12', 'Year 11 or equivalent - 11',
      'Year 10 or equivalent - 10', 'Year 9 or equivalent - 09', 'Year 8 or below - 08', 'Never attended school - 02']);
    if a is null then w := w || format('Highest school level "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('school_level', a); end if; end if;
  v := public.axcelerate_text(r, 'HIGHESTSCHOOLLEVELYEAR', 'YEARHIGHESTSCHOOLLEVELCOMPLETED', 'SCHOOLLEVELYEAR');
  if v is not null then
    if v ~ '^[0-9]{4}$' and v::int between 1920 and extract(year from current_date)::int then d := d || jsonb_build_object('year_completed', v);
    else w := w || format('Year school completed "%s" is not a 4-digit year; left empty.', v); end if;
  end if;
  v := public.axcelerate_text(r, 'ATSCHOOLFLAG', 'STILLATSCHOOL');
  if v is not null then a := public.axcelerate_yes_no(v);
    if a is null then w := w || format('Still at school "%s" is not Y or N; left empty.', v); else d := d || jsonb_build_object('secondary_enrolled', a); end if; end if;
  v := public.axcelerate_text(r, 'COUNTRYOFBIRTHID', 'COUNTRYOFBIRTH', 'BIRTHCOUNTRYID');
  if v is not null then a := public.axcelerate_avetmiss_answer('country', v);
    if a is null then w := w || format('Country of birth "%s" is not an AVETMISS (SACC) code; left empty.', v); else d := d || jsonb_build_object('birth_country', a); end if; end if;
  v := public.axcelerate_text(r, 'MAINLANGUAGEID', 'LANGUAGEID', 'HOMELANGUAGEID');
  if v is not null then a := public.avetmiss_code('language', v);
    if a is null and v ~ '^[0-9]{1,3}$' then a := public.avetmiss_code('language', lpad(v, 4, '0')); end if;
    if a is null then w := w || format('Language "%s" is not an AVETMISS (ASCL) code; left empty.', v);
    elsif a = '1201' then d := d || jsonb_build_object('language_home', 'No, English only - 1201');
    else d := d || jsonb_build_object('language_home', 'Yes, language other than English', 'language_other', public.axcelerate_avetmiss_answer('language', a)); end if;
  end if;
  v := public.axcelerate_text(r, 'SPOKENENGLISHPROFICIENCYID', 'ENGLISHPROFICIENCYID', 'ENGLISHPROFICIENCY');
  if v is not null then
    if public.avetmiss_is_code('english_proficiency', v) then d := d || jsonb_build_object('english_proficiency_code', v);
    else w := w || format('English proficiency "%s" is not an AVETMISS code; left empty.', v); end if;
  elsif d->>'language_home' is not null and d->>'language_home' not like 'No, English only%' then
    -- AXCELERATE-AGENTS: aXcelerate has no English proficiency for a student who speaks another language at home. AVETMISS needs one:
    -- stored as "Not stated" (@), the value a NAT file carries for a missing answer, and reported so staff can ask the student.
    d := d || jsonb_build_object('english_proficiency_code', '@');
    w := w || 'English proficiency is not recorded in aXcelerate: stored as Not stated (@). Ask the student and update it.'::text;
  end if;
  -- Disability: the flag, and the types (AVETMISS disability type codes). aXcelerate sends a JSON array (["11","12"]) or, in older
  -- records, comma-separated text; each item is checked on its own and a bad item is skipped with a warning.
  v_codes := '{}';
  foreach x in array public.axcelerate_list_items(r, 'DISABILITYTYPEIDS') loop
    if x ~ '^[0-9]{1,2}$' and public.avetmiss_code('disability_type', lpad(x, 2, '0')) is not null then
      v_codes := v_codes || public.avetmiss_code('disability_type', lpad(x, 2, '0'));
    else
      w := w || format('Disability type "%s" is not an AVETMISS code; skipped.', x);
    end if;
  end loop;
  x := array_to_string(array(select distinct c from unnest(v_codes) c order by c), ',');
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'DISABILITYFLAG', 'DISABILITY'));
  if v is null and x <> '' then v := 'Yes'; end if;
  if v is not null then d := d || jsonb_build_object('disability', v); end if;
  if x <> '' then d := d || jsonb_build_object('disability_types', x); end if;
  -- Prior education: each item is 3 digits plus the recognition letter A / E / I ("008I" = code 008, recognition I), from a JSON array
  -- or comma-separated text; PRIOREDUCATIONNAMES (same order) gives the qualification's name. A bad item is skipped with a warning.
  v_items := public.axcelerate_list_items(r, 'PRIOREDUCATIONIDS');
  v_names := public.axcelerate_list_items(r, 'PRIOREDUCATIONNAMES', true);
  for i in 1 .. coalesce(array_length(v_items, 1), 0) loop
    x := upper(v_items[i]);
    v_code := substring(x from '^([0-9]{3})[AEI]$');
    v_recog := substring(x from '^[0-9]{3}([AEI])$');
    if v_code is not null and v_recog is not null
       and public.avetmiss_is_code('prior_education', v_code) and public.avetmiss_is_code('prior_education_recognition', v_recog) then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('code', v_code, 'recognition', v_recog,
        'name', left(nullif(btrim(coalesce(v_names[i], '')), ''), 200))));
    else
      w := w || format('Prior education "%s" is not an AVETMISS code with a recognition letter (A / E / I), e.g. 008I; skipped.', v_items[i]);
    end if;
  end loop;
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'PRIOREDUCATIONFLAG', 'PRIOREDUCATIONSTATUS'));
  if v is null and jsonb_array_length(v_rows) > 0 then v := 'Yes'; end if;
  if v is not null then d := d || jsonb_build_object('prior_ed', v); end if;
  if jsonb_array_length(v_rows) > 0 then d := d || jsonb_build_object('prior_education', v_rows); end if;
  -- USI (format only; Skyline never asks aXcelerate or the USI registry from here).
  v := upper(public.axcelerate_text(r, 'USI'));
  if v is not null then
    if v ~ '^[A-HJ-NP-Z2-9]{10}$' then d := d || jsonb_build_object('usi_number', v); else w := w || format('USI "%s" is not in the USI format; left empty.', v); end if;
  end if;
  -- Address: the residential one (S...) first, else the postal one; Australian addresses only (state and postcode checked).
  v_res := public.axcelerate_text(r, 'SADDRESS1', 'SSTREETNAME', 'SCITY') is not null;
  if v_res then
    v_street := coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(r, 'SUNITNO'), public.axcelerate_text(r, 'SSTREETNO'), public.axcelerate_text(r, 'SSTREETNAME'))), ''), public.axcelerate_text(r, 'SADDRESS1'));
    v_line2 := public.axcelerate_text(r, 'SADDRESS2'); v_suburb := public.axcelerate_text(r, 'SCITY');
    v_state := upper(public.axcelerate_text(r, 'SSTATE')); v_post := public.axcelerate_text(r, 'SPOSTCODE');
  else
    v_street := coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(r, 'UNITNO'), public.axcelerate_text(r, 'STREETNO'), public.axcelerate_text(r, 'STREETNAME'))), ''), public.axcelerate_text(r, 'ADDRESS1'));
    v_line2 := public.axcelerate_text(r, 'ADDRESS2'); v_suburb := public.axcelerate_text(r, 'CITY');
    v_state := upper(public.axcelerate_text(r, 'STATE')); v_post := public.axcelerate_text(r, 'POSTCODE');
  end if;
  if v_street is not null or v_suburb is not null then
    if v_state is not null and public.avetmiss_code('state', v_state) is not null and (v_post is null or v_post ~ '^[0-9]{4}$') then
      d := d || jsonb_strip_nulls(jsonb_build_object('address_type', 'Australian Address', 'au_street', left(v_street, 200), 'au_line2', left(v_line2, 200),
                 'au_suburb', left(v_suburb, 100), 'au_state', v_state, 'au_zip', v_post));
    else
      w := w || format('The address (%s) is not a complete Australian address (state, 4-digit postcode); not stored.', concat_ws(', ', v_street, v_suburb, v_state, v_post));
    end if;
  end if;

  -- AXCELERATE-AGENTS: the rest of the contact the application form keeps (title, citizenship, visa, contacts, city of birth).
  v := public.axcelerate_text(r, 'TITLE');
  if v is not null then
    a := (select o from unnest(array['Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr', 'Prof', 'Rev', 'Hon']) o where lower(o) = lower(rtrim(btrim(v), '.')) limit 1);
    d := d || jsonb_build_object('title', coalesce(a, 'Other'));
  end if;
  v := public.axcelerate_text(r, 'COUNTRYOFCITIZENID', 'CITIZENSHIPCOUNTRYID');
  if v is not null then a := public.axcelerate_avetmiss_answer('country', v);
    if a is null then w := w || format('Country of citizenship "%s" is not an AVETMISS (SACC) code; left empty.', v);
    else d := d || jsonb_build_object('citizenship', a, 'nationality', a); end if;
  end if;
  v := public.axcelerate_text(r, 'CITIZENSTATUSNAME', 'FKRESIDENCYSTATUSNAME');
  if v is not null and lower(v) like '%visa%' then d := d || jsonb_build_object('holds_visa', 'Yes', 'visa_type', left(v, 100)); end if;
  v := lower(public.axcelerate_text(r, 'EMAILADDRESSALTERNATIVE'));
  if v is not null and v ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and v is distinct from v_email then d := d || jsonb_build_object('alternative_email', left(v, 254)); end if;
  v := public.axcelerate_text(r, 'EMERGENCYCONTACT');
  if v is not null then
    d := d || jsonb_strip_nulls(jsonb_build_object('ec_name', left(v, 200),
      'ec_relationship', initcap(lower(left(public.axcelerate_text(r, 'EMERGENCYCONTACTRELATION'), 60))),
      'ec_phone', coalesce(public.axcelerate_phone(public.axcelerate_text(r, 'EMERGENCYCONTACTPHONE')), left(public.axcelerate_text(r, 'EMERGENCYCONTACTPHONE'), 40))));
  end if;
  v := public.axcelerate_text(r, 'CITYOFBIRTH');
  if v is not null then d := d || jsonb_build_object('birth_city', left(v, 100)); end if;

  v_cols := jsonb_strip_nulls(jsonb_build_object(
    'full_name', nullif(btrim(concat_ws(' ', v_first, v_middle, v_last)), ''),
    'email', v_email, 'phone', v_phone, 'date_of_birth', to_char(v_dob, 'YYYY-MM-DD')));
  return jsonb_build_object('columns', v_cols, 'details', d, 'warnings', to_jsonb(w));
end $$;

/**
 * The agent's business: matched by link, ABN or name, else created (Active business, agreement none: the agent stays Inactive until
 * their agreement is signed). p_org is aXcelerate's organisation (may be empty); p_agent the agent's contact.
 */
create or replace function public.axcelerate_import_agency(p_connection uuid, p_run uuid, p_actor uuid, p_org jsonb, p_agent jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb := coalesce(p_org, '{}'::jsonb); g jsonb := coalesce(p_agent, '{}'::jsonb);
  v_ax text := coalesce(public.axcelerate_text(o, 'ORGID', 'ORGANISATIONID', 'ID'), public.axcelerate_text(g, 'ORGID', 'ORGANISATIONID'));
  v_key text; v_name text; v_abn text; v_email text; v_phone text; v_addr text; v_id uuid; v_code text; l public.axcelerate_links; n int := 0;
begin
  v_name := left(coalesce(public.axcelerate_text(o, 'NAME', 'ORGANISATION', 'LEGALNAME'), public.axcelerate_text(g, 'ORGANISATION', 'ORGANISATIONNAME')), 200);
  if v_name is null then
    v_name := left(coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(g, 'GIVENNAME'), public.axcelerate_text(g, 'SURNAME'))), ''),
                            public.axcelerate_text(g, 'NAME'), 'aXcelerate agent') || ' (aXcelerate agent)', 200);
  end if;
  -- An organisation is keyed by its aXcelerate ID; an agent without one gets their own business, keyed by the agent.
  v_key := coalesce('org:' || v_ax, 'agent:' || public.axcelerate_text(g, 'CONTACTID', 'AGENTID', 'ID'));
  if v_key is null then raise exception 'The agent has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'agency', v_key) then return public.axcelerate_outcome('skipped', null, jsonb_build_object('name', v_name)); end if;
  l := public.axcelerate_link_find(p_connection, 'agency', v_key);
  if l.id is not null and exists (select 1 from public.agencies where id = l.target_id::uuid) then
    perform public.axcelerate_link_save(p_connection, p_run, 'agency', v_key, 'public.agencies', l.target_id, o || jsonb_build_object('NAME', v_name));
    return public.axcelerate_outcome('unchanged', l.target_id, jsonb_build_object('name', v_name));
  end if;
  v_abn := regexp_replace(coalesce(public.axcelerate_text(o, 'ABN'), ''), '\s', '', 'g');
  if v_abn !~ '^[0-9]{11}$' then v_abn := null; end if;
  select id into v_id from public.agencies where (v_abn is not null and regexp_replace(coalesce(registration_number, ''), '\s', '', 'g') = v_abn)
     or lower(btrim(name)) = lower(btrim(v_name)) order by (v_abn is not null and regexp_replace(coalesce(registration_number, ''), '\s', '', 'g') = v_abn) desc limit 1;
  if v_id is not null then
    perform public.axcelerate_link_save(p_connection, p_run, 'agency', v_key, 'public.agencies', v_id::text, o || jsonb_build_object('NAME', v_name));
    return public.axcelerate_outcome('linked', v_id::text, jsonb_build_object('name', v_name));
  end if;
  v_email := lower(public.axcelerate_text(o, 'EMAILADDRESS', 'EMAIL'));
  if v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then v_email := null; end if;
  v_phone := coalesce(public.axcelerate_phone(public.axcelerate_text(o, 'PHONE', 'MOBILEPHONE', 'WORKPHONE')), left(public.axcelerate_text(o, 'PHONE', 'MOBILEPHONE'), 40));
  v_addr := nullif(btrim(concat_ws(', ', public.axcelerate_text(o, 'ADDRESS1', 'SADDRESS1'), public.axcelerate_text(o, 'CITY', 'SCITY'),
                   public.axcelerate_text(o, 'STATE', 'SSTATE'), public.axcelerate_text(o, 'POSTCODE', 'SPOSTCODE'))), '');
  loop
    v_code := 'AX' || coalesce(v_ax, public.axcelerate_text(g, 'CONTACTID', 'AGENTID', 'ID')) || case when n > 0 then '-' || n else '' end;
    exit when not exists (select 1 from public.agencies where lower(code) = lower(v_code));
    n := n + 1;
  end loop;
  insert into public.agencies(name, code, registration_number, business_email, phone, address, country, primary_contact, status, agreement_status)
  values (v_name, v_code, coalesce(v_abn, ''), coalesce(v_email, ''), coalesce(v_phone, ''), coalesce(v_addr, ''), coalesce(public.axcelerate_text(o, 'COUNTRY'), 'Australia'),
          coalesce(left(nullif(btrim(concat_ws(' ', public.axcelerate_text(g, 'GIVENNAME'), public.axcelerate_text(g, 'SURNAME'))), ''), 200), ''), 'Active', 'none')
  returning id into v_id;
  perform public.axcelerate_link_save(p_connection, p_run, 'agency', v_key, 'public.agencies', v_id::text, o || jsonb_build_object('NAME', v_name));
  return public.axcelerate_outcome('created', v_id::text, jsonb_build_object('name', v_name));
end $$;

/** The agent: matched by link or email, else created Inactive in their business (owner: Inactive until the agreement is signed). */
create or replace function public.axcelerate_import_agent(p_connection uuid, p_run uuid, p_actor uuid, p_agent jsonb, p_org jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g jsonb := coalesce(p_agent, '{}'::jsonb); v_ax text := public.axcelerate_text(g, 'CONTACTID', 'AGENTID', 'ID');
  v_name text; v_email text; v_phone text; v_biz jsonb; v_business uuid; v_id uuid; l public.axcelerate_links; v_warn jsonb := '[]'::jsonb; v_hint text;
begin
  if v_ax is null then raise exception 'The agent has no aXcelerate contact ID' using errcode = '22023'; end if;
  v_name := left(coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(g, 'GIVENNAME', 'FIRSTNAME'), public.axcelerate_text(g, 'SURNAME', 'LASTNAME'))), ''),
                          public.axcelerate_text(g, 'NAME', 'AGENTNAME'), 'aXcelerate agent ' || v_ax), 200);
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'agent', v_ax) then return public.axcelerate_outcome('skipped', null, jsonb_build_object('name', v_name)); end if;
  l := public.axcelerate_link_find(p_connection, 'agent', v_ax);
  if l.id is not null and exists (select 1 from public.agents where id = l.target_id::uuid) then
    select business_id into v_business from public.agents where id = l.target_id::uuid;
    perform public.axcelerate_link_save(p_connection, p_run, 'agent', v_ax, 'public.agents', l.target_id, g || jsonb_build_object('NAME', v_name));
    return public.axcelerate_outcome('unchanged', l.target_id, jsonb_build_object('name', v_name, 'business', v_business));
  end if;
  v_email := lower(public.axcelerate_text(g, 'EMAILADDRESS', 'EMAIL'));
  if v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then v_email := null; end if;
  v_phone := public.axcelerate_phone(public.axcelerate_text(g, 'MOBILEPHONE', 'PHONE', 'WORKPHONE'));
  if v_email is not null then
    select id, business_id into v_id, v_business from public.agents where lower(btrim(email)) = v_email limit 1;
    if v_id is not null then
      perform public.axcelerate_link_save(p_connection, p_run, 'agent', v_ax, 'public.agents', v_id::text, g || jsonb_build_object('NAME', v_name));
      return public.axcelerate_outcome('linked', v_id::text, jsonb_build_object('name', v_name, 'business', v_business));
    end if;
  end if;
  v_biz := public.axcelerate_import_agency(p_connection, p_run, p_actor, p_org, g);
  v_business := (v_biz->>'id')::uuid;
  if v_business is null then raise exception 'The agent''s business could not be imported (%).', coalesce(v_biz->>'action', 'unknown') using errcode = '22023'; end if;
  begin
    insert into public.agents(business_id, full_name, email, phone, role, status) values (v_business, v_name, coalesce(v_email, ''), coalesce(v_phone, ''), 'agent', 'Inactive') returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint is distinct from 'email_taken' then raise; end if;
    insert into public.agents(business_id, full_name, email, phone, role, status) values (v_business, v_name, '', coalesce(v_phone, ''), 'agent', 'Inactive') returning id into v_id;
    v_warn := v_warn || to_jsonb(format('The agent''s email %s is already used by another role in Skyline: the agent was created without an email.', v_email));
  end;
  perform public.axcelerate_link_save(p_connection, p_run, 'agent', v_ax, 'public.agents', v_id::text, g || jsonb_build_object('NAME', v_name));
  return public.axcelerate_outcome('created', v_id::text, jsonb_build_object('name', v_name, 'business', v_business, 'businessName', v_biz->>'name',
    'businessAction', v_biz->>'action', 'warnings', v_warn));
end $$;

/**
 * The student's agent: a student without applications moves to the agent's business with the agent; a student with applications keeps
 * their business (the agent is set only when it is the same business). Returns moved | linked | unchanged | kept.
 */
create or replace function public.axcelerate_student_agent(p_student uuid, p_agent uuid, p_actor uuid default null) returns text
language plpgsql security definer set search_path = public as $$
declare s public.enrollment_students; g public.agents;
begin
  select * into s from public.enrollment_students where id = p_student;
  select * into g from public.agents where id = p_agent;
  if s.id is null or g.id is null then return 'kept'; end if;
  if s.agent_id = g.id and s.agency_id = g.business_id then return 'unchanged'; end if;
  perform public.axcelerate_importing(p_actor);
  if s.agency_id = g.business_id then
    update public.enrollment_students set agent_id = g.id where id = s.id;
    return 'linked';
  end if;
  if exists (select 1 from public.enrollment_applications a where a.student_id = s.id) then return 'kept'; end if;
  -- The same marker portal_student_choose_agency uses: the identity guard lets this one row move business.
  perform set_config('skyline.student_move', s.id::text, true);
  update public.enrollment_students set agency_id = g.business_id, agent_id = g.id where id = s.id;
  perform set_config('skyline.student_move', '', true);
  return 'moved';
end $$;

revoke all on function public.axcelerate_import_agency(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_import_agent(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_student_agent(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.axcelerate_import_agency(uuid, uuid, uuid, jsonb, jsonb), public.axcelerate_import_agent(uuid, uuid, uuid, jsonb, jsonb),
  public.axcelerate_student_agent(uuid, uuid, uuid) to service_role;

commit;
