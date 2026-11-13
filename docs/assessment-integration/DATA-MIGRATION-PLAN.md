# Data migration plan: Submissions → Skyline Assessment Management (plan only; nothing moved)

Scope rule (brief 1.1 and 4.7): Submissions and its Supabase project are read-only and no data was read or moved. This is the plan an operator would follow later, with the owner's approval, if historical assessment records are to be carried into Skyline. Everything below was derived from Submissions' source (AUDIT.md modules S-A, S-C) and Skyline's schema (ARCHITECTURE.md).

## 1. What there is to move

| Submissions | Rows (expected) | Skyline target | Decision |
|---|---|---|---|
| `skyline_forms` + `skyline_form_steps/sections/questions/options/rows` (one form per unit of competency) | tens of forms | `asm_assessments` + `asm_versions.definition` (one published version per form) | Convert structure to the JSON definition; the five fixed sections per task become one task with sections; Results / Summary sheets are not questions and are dropped (Skyline records results in `asm_results` / `asm_task_results`) |
| Written Evidence Checklist / Marking Checklist rows | per task | `observation_checklist` questions (assessor only) | Convert |
| `skyline_students` (bigint id, external `student_id`, email not unique) | hundreds | `enrollment_students` (uuid) | **Identity mapping, never creation**: match by external student id to an existing Skyline student; unmatched rows are listed for a human, never auto-created (Skyline's email-unique-within-role rule and the agency chain make a blind insert wrong) |
| `skyline_users` (trainers) | tens | `hr.staff_profiles` | Match by email; unmatched trainers are listed, not created |
| `skyline_batches`, `skyline_batch_trainers`, `skyline_students.batch_id` | tens | `batches`, `batch_trainers`, `batch_enrolments` | Match batch by course + name; create nothing automatically |
| `skyline_form_instances` (attempts: status, role_context, workflow_status, submission_count, dates, NYC dates, extension) | thousands | `asm_assignments` (one per form × batch) + `asm_attempts` (one row per attempt number 1..3) | Convert; every historical attempt lands in state `final` or `void`, never `draft` (no open work is migrated) |
| `skyline_form_answers` (value_text / number / json keyed by question + row) | tens of thousands | `asm_attempts.responses` jsonb keyed by the converted question id | Convert per attempt; grid rows become the `table_grid` object; likert rows become one likert question per row |
| `skyline_form_trainer_assessments`, `_row_assessments`, `skyline_form_results_data` (per task S/NS per attempt, feedback, signatures), `skyline_form_assessment_summary_data` (C/NYC per attempt) | thousands | `asm_results`, `asm_task_results`, `asm_unit_outcomes` | Convert; signatures stay as text in `detail` of an audit row (Skyline outcomes are signed by a login, which history cannot supply: `signed_role = 'admin'`, `signed_name` = the recorded trainer name, `notes = 'migrated from Submissions'`) |
| `skyline_submission_events`, `skyline_assessment_acknowledgments`, `skyline_learning_doc_activity` | thousands | `asm_audit_log` | Convert as `system` rows with the original timestamps in `detail` |
| Evidence images in the public `photomedia` bucket (`skyline/answers/{instance}/{question}/…`) | files | `assessment-evidence` (private) under `<new attempt id>/<question id>/` + `asm_evidence_files` | Copy files; re-point responses; sha-256 recorded on copy |
| `skyline_generated_pdfs` (SharePoint links) | per completed instance | not migrated | Keep the SharePoint PDFs where they are; record the URL in the attempt's audit detail |
| Notifications, OTPs, sessions, tokens, finance, inductions, enrolment applications | — | not migrated | Out of scope / replaced by Skyline's own |

## 2. Identity mapping

1. Build a mapping table (`migration_student_map(submissions_id, external_student_id, skyline_student_id, matched_by, confidence)`), populated only by exact matches on the external student id, then by exact email where the id is missing; everything else is `unmatched`.
2. Same for trainers (`migration_staff_map`) by email against `hr.staff_profiles`.
3. A human reviews the unmatched lists and either links records or marks them "history only". History-only students get no `enrollment_students` row; their attempts are exported to an archive file, not loaded.
4. Course and unit: by qualification code (`skyline_forms.qualification_code` → `cms_courses.code`) and unit code (`skyline_forms.unit_code` → `cms_course_units.code`), reviewed by a human.

## 3. Conversion rules (structure)

- Question ids: `s{submissions question id}` (and `s{question}_r{row}` for per-row answers), so every historical response keys to a stable id and the mapping is reversible.
- Types: `short_text` → short_answer; `long_text` → long_answer; `yes_no` → single_choice (yes / no); `single_choice` / `multi_choice` → same; `likert_5` → one likert per row (1-5); `grid_table` → table_grid (columns from `columnsMeta`, rows from `skyline_form_question_rows`); `date` → date; `image` → file_upload; `signature` → declaration; `instruction_block` / `page_break` → instruction; checklist questions (WEC, marking) → observation_checklist (assessor only).
- Role flags: `role_editability.student = false` → `assessorOnly = true`.
- Marking: `skyline_form_trainer_assessments.satisfactory` (yes / no) → `asm_results.outcome` S / NYS on the converted question; per task `first/second/third_attempt_satisfactory` → `asm_task_results` of attempt n; `final_attempt_n_result` → attempt n `outcome` (S when competent) and, for the last attempt, an `asm_unit_outcomes` row.
- Attempts: one Submissions instance with `submission_count = n` becomes n `asm_attempts` rows (1..n); only the last holds the full responses (earlier answers were overwritten in place in Submissions, so earlier attempts carry the same responses with a `detail` note); `did_not_attempt` instances become one `void` attempt with reason "did not attempt (migrated)".
- Declarations: the student declaration signature answer becomes `declaration = { signature, text: <Submissions declaration text>, migrated: true }` with no hash (none existed).

## 4. Validation

- Counts per table before and after; per student and per unit counts reconciled.
- Every converted definition passes `asm_validate_definition`; every converted response set passes `asm_validate_responses` for role `student` (failures are listed, not forced).
- Every `asm_attempts` row references an existing mapped student and assignment; no row in state `draft`.
- Spot check: 20 random instances compared field by field with the Submissions PDF on SharePoint.

## 5. Dry run and reconciliation

1. Export Submissions tables to CSV with the owner's approval (read-only `SELECT`, no app changes).
2. Load into the local lab (`scripts/lab/staff-lab.mjs up`), run the converter into a staging schema `migration.*`, then the validation of section 4.
3. Produce the reconciliation report (matched / unmatched / failed validation) for the owner.
4. Only after sign-off: load into hosted through the `asm_*` RPC-less path (a `security definer` loader function added by a migration, run once, then revoked), inside one transaction per batch.

## 6. Rollback

Loaded rows are tagged (`asm_audit_log.detail.migrationRun`, `asm_attempts.declaration.migrated`, `asm_assessments.code` prefixed `SUB-`). Rollback = delete the tagged rows in dependency order (attempts' children, attempts, assignments, versions, assessments, outcomes, audit) by the loader's own reverse function; no production table other than `asm_*` is written, so nothing else needs restoring. Evidence files copied into `assessment-evidence` are listed in `asm_evidence_files` and removed with the same tag.

## 7. Not in this plan

Live reads of Submissions, OTP or session data, finance, inductions, enrolment applications, SharePoint PDFs (left in place), and any automatic creation of students, trainers, courses, units or batches in Skyline.
