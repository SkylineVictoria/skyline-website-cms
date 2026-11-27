alter table public.enrollment_students
  add column address_building text check (char_length(address_building) <= 50),
  add column address_flat text check (char_length(address_flat) <= 30),
  add column address_street_number text check (char_length(address_street_number) <= 15),
  add column address_street_name text check (char_length(address_street_name) <= 70),
  add column address_needs_review boolean not null default false;
comment on column public.enrollment_students.address_needs_review is 'true = the street address could not be split into number and name automatically; staff should check the address parts.';

create or replace function public.avetmiss_split_street(p_street text, p_line2 text default null)
returns table(building text, flat text, street_number text, street_name text, needs_review boolean)
language plpgsql immutable set search_path = public as $$
declare s text := btrim(regexp_replace(coalesce(p_street, ''), '\s+', ' ', 'g'));
        l2 text := nullif(btrim(regexp_replace(coalesce(p_line2, ''), '\s+', ' ', 'g')), '');
        num constant text := '([0-9]+[A-Za-z]?(?:\s*-\s*[0-9]+[A-Za-z]?)?)';
        m1 text[]; m2 text[]; m3 text[]; m4 text[];
begin
  building := null; flat := null; street_number := null; street_name := null; needs_review := false;
  if s = '' then
    needs_review := l2 is not null; street_name := l2; return next; return;
  end if;
  m1 := regexp_match(s, '^(?:(?:unit|u|flat|apt|apartment|suite|shop)\s*)?([0-9A-Za-z]{1,6})\s*/\s*' || num || '\s+(.+)$', 'i');
  m2 := regexp_match(s, '^((?:unit|u|flat|apt|apartment|suite|shop|level)\s*[0-9A-Za-z]{1,6})\s*,?\s+' || num || '\s+(.+)$', 'i');
  m3 := regexp_match(s, '^(lot\s*[0-9]+[A-Za-z]?)\s*,?\s+(.+)$', 'i');
  m4 := regexp_match(s, '^' || num || '\s*,?\s+(.+)$');
  if m1 is not null then
    flat := m1[1]; street_number := m1[2]; street_name := m1[3];
  elsif m2 is not null then
    flat := initcap(m2[1]); street_number := m2[2]; street_name := m2[3];
  elsif m3 is not null then
    street_number := initcap(m3[1]); street_name := m3[2];
  elsif m4 is not null then
    street_number := m4[1]; street_name := m4[2];
  else
    street_name := s; needs_review := true;
  end if;
  street_number := regexp_replace(street_number, '\s*-\s*', '-', 'g');
  if l2 is not null then
    if flat is null and l2 ~* '^(unit|u|flat|apt|apartment|suite|shop|level)\s*[0-9A-Za-z]' then flat := initcap(l2);
    else building := l2; end if;
  end if;
  if street_name ~* '^(po box|p\.o\. box|gpo box|locked bag)' then needs_review := true; end if;
  flat := left(flat, 30); street_number := left(street_number, 15); street_name := left(street_name, 70); building := left(building, 50);
  return next;
end $$;

create or replace function public.enrollment_students_address_split()
returns trigger language plpgsql set search_path = public as $$
declare d jsonb := coalesce(new.details, '{}'::jsonb); r record;
begin
  if tg_op = 'INSERT' or (new.details->>'au_street') is distinct from (old.details->>'au_street')
     or (new.details->>'au_line2') is distinct from (old.details->>'au_line2') then
    select * into r from avetmiss_split_street(d->>'au_street', d->>'au_line2');
    new.address_building := r.building;
    new.address_flat := r.flat;
    new.address_street_number := r.street_number;
    new.address_street_name := r.street_name;
    new.address_needs_review := r.needs_review;
  end if;
  return new;
end $$;
create trigger avetmiss_address_split
  before insert or update on public.enrollment_students
  for each row execute function public.enrollment_students_address_split();

update public.enrollment_students set
  (address_building, address_flat, address_street_number, address_street_name, address_needs_review) =
  (select building, flat, street_number, street_name, needs_review
     from public.avetmiss_split_street(details->>'au_street', details->>'au_line2'));