# AVETMISS compliance register

Owner rule (2026-11-26): every change to SLIT follows AVETMISS so NCVER reporting never has gaps. The binding rules for developers and
AI agents are in `CLAUDE.md` ("AVETMISS compliance" and "AVETMISS rules"); this file is the traceability register.

## Specification in use
| Item | Value | Status |
|---|---|---|
| AVETMISS VET Provider Collection Specifications | Release 8.0 (training activity to 31 Dec 2026) | in use |
| Release 8.1 | published 27 Feb 2026, applies to activity from 1 Jan 2027 | NOT IMPLEMENTED (changes not yet verified: NCVER site returned 503 on 2026-11-26) |
| VET Information Standard | replaces AVETMISS; RTOs transition by 1 Jan 2029 | NOT IMPLEMENTED |
| NCVER AVETMISS Validation Software (AVS) | official check of the NAT files | NOT RUN (needs SLIT's NCVER login and the fixed-width export) |

Sources: ncver.edu.au release 8.1 page and VET Information Standard pages (checked 2026-11-26). Never invent a requirement:
mark anything not verified against the official text as "to verify".

## Register (requirement -> data -> enforcement -> test)
Status: DONE = enforced in the database and tested; PARTIAL = enforced but not against the full official list; OPEN = not yet.

| ID | NAT / element | Source rule | Table.column | Database enforcement | Entry points | Test | Status |
|---|---|---|---|---|---|---|---|
| AVM-ORG-01 | NAT00010 organisation identifier, name, type, address, contact | AVETMISS 8.0 NAT00010 | cms_settings.avetmiss_* | check constraints | Settings › AVETMISS | avetmiss_nat.sql | PARTIAL (contact name empty on live) |
| AVM-LOC-01 | NAT00020 location id, suburb, postcode, state, country | NAT00020 | locations.* | constraints + locations_avetmiss_fill | Locations | avetmiss_nat.sql | PARTIAL (postcode/suburb pairs not checked against an official list) |
| AVM-PRG-01 | NAT00030 program id, level of education, recognition, FOE, ANZSCO, hours | NAT00030 | cms_courses.avetmiss_level_code / _recognition_code, tga_* | codes in avetmiss_codes, trigger avetmiss_program_codes | course import / save | avetmiss_nat.sql | PARTIAL (FOE / ANZSCO format only; level / recognition lists partial, to verify) |
| AVM-SUB-01 | NAT00060 subject id, FOE (6 digits), VET flag, nominal hours | NAT00060 | cms_course_units.* | check (6 digits), boolean | unit onboarding | avetmiss_nat.sql | PARTIAL (ASCED list not loaded) |
| AVM-CLI-01 | NAT00080 client id, sex, DOB, school level / year, Indigenous status, language, labour force, country of birth, disability / prior education flags, at school, address, USI | NAT00080 | enrollment_students.* | constraints + enrollment_students_avetmiss_valid, avetmiss_student_missing | wizard, full form, student page | avetmiss_no_junk.sql, avetmiss_nat.sql | DONE for codes; DOB / school-year cross checks in audit |
| AVM-APP-01 | application answers stay valid while drafting | SLIT (no junk) | enrollment_applications.data values | trigger avetmiss_application_values | every save | avetmiss_no_junk.sql | DONE |
| AVM-DIS-01 | NAT00090 disability types only with indicator Y | NAT00090 | student_disabilities | FK to codes; audit AVM-XF-005/006 | wizard | avetmiss_audit.sql | PARTIAL (cross-check is audit, not a constraint) |
| AVM-PRI-01 | NAT00100 prior education + recognition only with indicator Y | NAT00100 | student_prior_education | codes; audit AVM-XF-007/008 | wizard | avetmiss_audit.sql | PARTIAL |
| AVM-ACT-01 | NAT00120 location, client, subject, program links | NAT00120 cross-file | lms_unit_students | FKs (location, unit, intake); audit AVM-REL-001..003 | LMS | avetmiss_nat.sql, avetmiss_audit.sql | PARTIAL (no FK to intake_enrolments yet) |
| AVM-ACT-02 | NAT00120 outcome codes and end dates | NAT00120 outcome identifier | lms_unit_students.outcome_code, actual_end_date | code check, withdrawal-date check, asm_outcome_to_avetmiss | trainer sign-off, LMS › Results, withdrawal | avetmiss_nat.sql, avetmiss_audit.sql | DONE (20 / 70 / 30 by attempts; one target only, else reconcile) |
| AVM-ACT-03 | NAT00120 delivery mode, predominant mode, funding, study reason, commencing | NAT00120 | lms_unit_students, intake_enrolments, cms_courses | code checks | course onboarding, enrolment | avetmiss_nat.sql | PARTIAL (funding derived from residency) |
| AVM-CMP-01 | NAT00130 program completed | NAT00130 | course_completions | FKs; audit AVM-REL-004 | LMS › Completion | avetmiss_audit.sql | PARTIAL |
| AVM-RET-01 | reportable history not removed by ordinary deletes | National VET Data Policy (retention) | 7 cascades listed by audit AVM-RET-001 | preserve_allocation on lms tables | admin deletes | avetmiss_audit.sql | OPEN (cascades to change to restrict / archive) |
| AVM-GATE-01 | changes cannot silently weaken guards | SLIT | migrations | scripts/check-avetmiss.mjs + avetmiss_guard_gaps | CI | avetmiss_no_junk.sql | DONE in CI; branch protection must be set by the owner |

## Open work (in order)
1. Load the official lists with their release dates: ASCED field of education, ANZSCO, ABS SACC countries and ASCL languages (check the
   existing sets against the current releases), Australia Post postcode / suburb / state pairs.
2. Link every unit enrolment to its course enrolment (intake_enrolments) and change the seven cascades to restrict / archive.
3. NAT fixed-width export with the official field lengths, then an AVS run by SLIT.
4. Release 8.1 changes for activity from 1 Jan 2027; VET Information Standard before 1 Jan 2029.
5. Register each government rule in Business Rules & Policies as protected (cannot be switched off); Health Check screen under
   Government Compliance (avetmiss_full_audit).

- 2026-11-26 AVETMISS-SUBMIT-FIX (20261127100517): English proficiency, year highest school level completed, prior education and
  disability types answered in the application are copied to the student record by the database (trigger avetmiss_answers_to_student),
  so the submit check (avetmiss_student_missing) sees them for every writer; the wizard asks the year completed. Status: DONE locally.
- 2026-11-26 AVETMISS-PAGE-CHECK (20261127110517): avetmiss_answers_missing applies the Submit rules to the answers so every wizard
  page's Next stops while that page's AVETMISS answers are incomplete. Status: DONE locally.
