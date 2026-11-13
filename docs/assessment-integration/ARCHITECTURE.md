# Assessment Management: architecture

Skyline ERP's assessment module (ASM-01), built 2026-11-14 per the owner's brief. It reuses Skyline's logins, master data, batches, storage patterns, notification outbox and audit shape (AUDIT.md Part M) and adds one data-driven form engine. Decisions and their evidence are in DECISIONS.md; this file describes what exists.

## 1. Data model (migration `20261113430000_assessment_management.sql`)

All new tables are `public.asm_*`, carry `tenant_id` copied from the course (trigger `asm_bind_tenant`, D-03), have RLS with SELECT policies only (no client write policy on any table, D-17) and are written solely by the RPCs of `20261113440000_assessment_rpcs.sql`.

```
cms_courses ──< cms_course_units ──< asm_unit_elements (elements, PCs, PE, KE, AC, FS)
      │                 │
      └──< asm_assessments ──< asm_versions (draft | published | retired; definition jsonb, immutable once published)
                                   ├──< asm_question_keys   (assessor-only: model answer, answer key, guidance, rubric descriptors)
                                   ├──< asm_unit_mappings   (question / criterion -> asm_unit_elements)
                                   └──< asm_assignments ──> batches (+ asm_assignment_students overrides, asm_assignment_trainers extra assessors)
                                             ├──< asm_schedule_events (due, practical, observation, other; room; trainer)
                                             └──< asm_attempts ──> enrollment_students
                                                       ├──< asm_evidence_files  (storage bucket assessment-evidence, path <attempt>/<question>/<file>)
                                                       ├──< asm_results         (per question / criterion: suggested_outcome, outcome, score, rubric level, feedback)
                                                       ├──< asm_task_results    (per task: rollup_suggested, outcome, feedback, signed)
                                                       ├──< asm_feedback        (append-only thread)
                                                       └──< asm_reassessments   (requested | opened | declined; next_attempt_id)
asm_unit_outcomes (C | NYC, signed_by, signed_role, signed_name, evidence_attempt_ids, supersedes_id; insert-only)
asm_settings (per tenant: max_attempts, reassessment_days, late_submission, rollup_rule, due_soon_days, declaration_text, instructions, evidence limits)
asm_question_bank / asm_question_bank_versions (reusable versioned questions; staff only)
asm_notifications (in-app, per login) + notification_deliveries.assessment_event_id (email through the existing outbox)
asm_audit_log (append-only: actor, role, action, target, detail)
```

Guards (triggers): `asm_versions_guard` (a published definition, checksum and number never change; status only moves forward), `asm_attempts_guard` (identity immutable; responses, declaration, hash, receipt frozen after submission; state machine draft → submitted → marking → returned | final, any → void; `row_version` increments on every update), `asm_results_guard` (results of a returned / final attempt frozen), `asm_refuse_change` on unit outcomes, feedback, bank versions and the audit log.

Storage: bucket `assessment-evidence` (private, 200 MB cap, allowed MIME list). Policies call `asm_evidence_path_writable` (a student under their own DRAFT attempt, or an assessor under `<attempt>/assessor/` while marking) and `asm_evidence_path_readable` (owner student, assessors of the assignment, admins). Clients get 60-second signed URLs.

## 2. The form engine and the question-type registry

A published version stores one JSON `definition`:

```
{ instructions, tasks: [ { id, title, instructions, sections: [ { id, title, description, showIf, questions: [ Q ] } ] } ] }
Q = { id, type, label, helpText, required, assessorOnly, markingMode, config, responseSchema, criteria[], rubric{levels[]}, showIf, children[] }
```

- Ids are stable: responses are keyed by question id, so renaming and reordering never break an attempt. A repeating group's response is an array of objects keyed by its children's ids; a case study's an object.
- `responseSchema` (a JSON-schema subset: type, enum, items, min/maxItems, uniqueItems, min/maxLength, min/maxWords, minimum/maximum, format, properties, requiredKeys, min/maxFiles) is written by the registry from the type and config. The database validates with it (`asm_validate_responses` → `asm_schema_check`), so **adding a type is a code change only** (D-07).
- `showIf` conditions (`eq, neq, in, notIn, gt, gte, lt, lte, contains, empty, notEmpty`, grouped by `all` / `any`) are evaluated identically by `asm_condition_met` (SQL) and `src/lib/assessment/conditions.ts`.
- Assessor-only data never enters a definition: `asm_jsonb_forbidden_key` rejects `key`, `answerKey`, `modelAnswer`, `assessorGuidance`, `assessorNotes`, `rubricAssessor` (check constraint on `asm_versions` and in `draft_save`); it lives in `asm_question_keys`.

Registry (two halves, one entry per type in each):

| File | Holds |
|---|---|
| `src/lib/assessment/registry.ts` | id, label, icon, group, marking modes, default marking mode, key kind, `defaultConfig`, `responseSchema(config)`; `newQuestion`, `withSchema` |
| `src/components/assessment/registry.tsx` | `Input` (student), `View` (read-only answer), `Config` (builder settings), `Key` (answer-key editor for auto-checked types) |

Types: instruction / content, short_answer, long_answer, single_choice (optional Other), multi_choice, true_false, matching, ordering, fill_blanks, table_grid, likert, number, date, file_upload, url, case_study (children), repeating_group (children), observation_checklist (assessor), third_party_report (assessor), declaration.

Marking modes: `none`, `auto` (objective types; `asm_autocheck` writes `suggested_outcome` only, D-08), `criteria` (S / NYS per criterion and per question), `rubric` (level + score), `observation` (assessor fills the question). Task rollup (`asm_rollup`) suggests S / NYS from the question outcomes under the tenant's `rollup_rule`; the assessor records the task outcome and the decision.

Other engine files: `src/lib/assessment/validate.ts` (client mirror of the SQL validation, used for live feedback and by `scripts/test-assessment-registry.ts`), `definition.ts` (tree helpers, numbering, clone with fresh ids), `api.ts` (RPC wrappers, evidence upload / signed URLs, Melbourne date helpers), `AssessmentRenderer.tsx` (student / preview / review), `MarkingView.tsx` (assessor), `CalendarView.tsx`, `ProgressList.tsx`.

## 3. RLS and RPC design

| Actor | Predicate | Entry point |
|---|---|---|
| Admin | `asm_is_admin()` = `cms_is_admin() or cms_is_rto_manager()` | `asm_admin(action, data)` |
| Trainer / assessor | `asm_trainer_profile()` (active `hr.staff_profiles` for `auth.uid()`) on `batch_trainers` of the assignment's batch or in `asm_assignment_trainers` (`asm_trainer_on_assignment`) | `asm_trainer(action, data)` |
| Student | `asm_student_id()` = `portal_student_id()`, eligible through `asm_assignment_eligible` (active `batch_enrolments` minus exclusions plus manual additions) | `asm_student(action, data)` |
| Any of the three | `asm_calendar(from, to, batch)` merges assessment events with the batch's weekly classes (`batch_sessions` over `rto_batch_span`, working days only) |

Every SELECT policy uses these `security definer` helpers rather than joining staff-only tables (D-19). Students read results and task results only once the attempt is returned or final; the student payloads never include keys (`asm_attempt_json(…, 'student')` also hides suggestions and unreturned assessor responses). Tenant: a restrictive `tenant_scope(tenant_id)` policy on every tenant-carrying table; `asm_bind_tenant` refuses a client-supplied tenant that differs from the parent's.

Concurrency: `asm_attempts.row_version` (checked by `draft_save`, `submit`, `mark_save`, `mark_return` → SQLSTATE 40001), `asm_versions.updated_at` (checked by `draft_save` as `expectedUpdatedAt`).

Audit: every RPC write calls `asm_log(role, action, target_type, target_id, detail)`; the trigger `asm_batch_enrolment_change` logs `reassign_leave` / `reassign_join` as `system`.

Notifications: `asm_notify` writes `asm_notifications` and, when the recipient has an email, a `notification_deliveries` row (`event = assessment_<event>`, `assessment_event_id`). The existing `email-sender` worker sends it under the institution's existing activation (D-20). Events: published, due_soon, overdue (daily `asm_due_sweep`, cron `asm-due-sweep` 21:00 UTC), submitted (receipt to the student, alert to assessors), marked, reassessment, outcome, reassigned, extended.

## 4. Workflows

**Admin (CMS › Master Data › Assessments; `/admin/assessments`)**: library → new assessment (blank, clone, template, JSON import) → builder (drag-and-drop tasks / sections / questions, palette of every type, question editor with criteria, rubric, conditions, assessor-only keys; question bank save / insert; preview) → autosaved draft (`draft_save`) → publish (`version_publish`: checksum, frozen) → unit mapping matrix with coverage gaps (`coverage`) → assign to batches (`assignment_create`: dates, extra assessors, practical sessions) → submissions overview, pending marking, reassessment requests, attempt viewer with authorised overrides (`attempt_reopen`, `attempt_void`, per-student due date, exclusion) → outcomes, reports (cohort / assessment, CSV), settings, audit. Course wizard › Assessments and Batch › Assessments & Results open the same records.

**Trainer (`/staff/assessments`)**: pending marking → `/staff/assessments/attempts/:id` (student answers beside model answer, guidance, key, auto-check suggestion; per criterion / rubric / question outcomes; observation checklist and third-party report inputs; assessor evidence upload; task outcomes with rollup suggestion; overall feedback; decision S → final, NYS → reassessment attempt with a due date or final NYS on the last attempt) → messages with the student → record the unit outcome with the sign-off declaration (`unit_outcome_record`). Also My assessments (students per assignment), My students (competency progress), calendar, notifications.

**Student (`/agency/assessments`)**: My assessments (resolved through enrolment → batch → assignment) → open (attempt 1 created) → task by task with autosave (`draft_save`, row version), evidence upload (`assessment-evidence` bucket then `evidence_register`), live required / rule feedback → submit with the institution's declaration and typed signature (`submit`: server validation, sha-256 of responses and of the declaration text, receipt `ASM-YYYY-NNNNNN`) → results, feedback, task outcomes, reassessment attempts, reassessment request on a final NYS, messages → Results & progress (unit outcomes), calendar, notifications.

**Batch membership (`follow_batch`)**: leaving voids open drafts (kept as history); joining notifies the student of open assessments; eligibility is always computed live.

## 5. Tests

- `supabase/tests/assessment_management.sql` (pgTAP, 152 checks): the whole journey with every question type, conditional logic, repeating group, case study, criteria, rubric, mapping and observation checklist; tenant isolation, ownership, trainer scope, tampered ids, storage paths, key leakage, locked attempts, frozen results, append-only outcomes and audit, concurrency, versioning (v2 published while attempts stay on v1), calendar scope, batch reassignment, no client writes. This is the automated flexibility acceptance test of the brief (section 8): the assessment is created, completed, marked, reassessed, signed off and re-versioned with no code change and no migration at runtime.
- `scripts/test-assessment-registry.ts` (51 checks): the registry, the client mirrors of validation and conditions, definition helpers.
- `e2e/assessments.spec.ts` (Playwright, local lab only): admin builds and assigns in the browser, the student submits, the trainer marks and signs off.
