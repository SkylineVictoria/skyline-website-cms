-- TGA-UNITS: training.gov.au details of each unit of competency, filled by the course Sync (tga-course-import).
-- Elements, performance criteria, evidence, assessment conditions and foundation skills go to asm_unit_elements
-- (only for units that have none yet). Additive only.
alter table public.cms_course_units
  add column if not exists tga_release_number text,
  add column if not exists tga_release_date date,
  add column if not exists tga_application text,
  add column if not exists tga_unit_sector text,
  add column if not exists tga_prerequisites text,
  add column if not exists tga_supersedes_code text,
  add column if not exists tga_supersedes_title text,
  add column if not exists tga_supersedes_equivalent boolean,
  add column if not exists tga_developer text,
  add column if not exists tga_companion_url text,
  add column if not exists tga_synced_at timestamptz;
