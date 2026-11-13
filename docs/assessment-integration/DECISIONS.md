# Assessment Management integration: autonomous decisions

Each entry: the decision, the alternatives considered, the evidence, and where it is applied. Dates are 2026-11-14 (overnight run started 2026-11-13 late evening, Asia/Kolkata).

## D-01 Build a new data-driven assessment form engine; do not extend the website form builder or the e-sign template engine
- **Decision:** a new question-type registry in `src/lib/assessment/` (one engine shared by the admin builder, the student renderer and the trainer marking view) with the structure stored as data (`asm_*` tables). The existing engines are reused only at their edges: the website Form Builder's flat field list stays for public enquiry forms; the e-sign module supplies the declaration pattern (typed signature, consent text, hash of the signed content) but not its envelope/PDF pipeline.
- **Alternatives:** (a) extend `src/lib/formFields.ts` / `FormBuilderPage.tsx` (14 flat field types, no tasks, sections, marking modes, assessor keys, conditional logic or versioning: `src/lib/formFields.ts:8-22`); (b) extend `hr.sign_templates` (text/PDF documents with signer fields, one recipient per envelope: SUPABASE.md "Documents & Signatures"); (c) port Submissions' `skyline_form_*` schema (hardcoded structure, no RLS, no versioning: AUDIT.md section S4).
- **Why:** none of the three models tasks → sections → questions with marking, assessor-only data, immutable versions or JSONB responses; retrofitting them would risk the live website forms and signed documents. A declaration question type records the typed signature, the declaration text version and a SHA-256 of the submitted responses, which is the same evidence the e-sign certificate records.

## D-02 Identity: existing Skyline logins only, no second OTP login
- **Decision:** admins = `cms_users` (`cms_is_staff()`, `cms_is_admin()`, `cms_is_rto_manager()`); trainers = `hr.staff_profiles` (`auth_user_id = auth.uid()`, status active) assigned through `batch_trainers` or a direct assessment assignment; students = `portal_student_id()` (an `enrollment_students` row with an active student membership).
- **Alternatives:** Submissions' OTP + localStorage user blob (no Supabase Auth, no RLS; AUDIT.md S2) was rejected: it cannot be enforced by RLS.
- **Evidence:** `supabase/migrations/20261104270000_student_portal_login.sql:48-57`, `20261105180000_hr_staff_schema.sql:38-63`, `20261113340000_course_management.sql:11-16`.

## D-03 Tenant scoping follows `cms_courses.tenant_id`
- **Decision:** every `asm_*` row carries `tenant_id` copied from its course (nullable for the legacy institution, like `cms_courses`); policies use `public.tenant_scope(tenant_id)` plus the role check. The RTO tables (`batches`, `course_intakes`, ...) have no tenant column (AUDIT.md K2), so the course is the tenant anchor.

## D-04 No new Edge Function; every command is a security-definer RPC
- **Decision:** `asm_admin(action, data)`, `asm_trainer(action, data)` and `asm_student(action, data)` (same pattern as `rto_admin` / `rto_course_flow`), plus RLS on every table. Evidence files go to a private bucket through Storage RLS; signed URLs are created client-side (60 s) and allowed only where the select policy allows the row.
- **Alternatives:** an `assessment-admin` Edge Function. Rejected: nothing here needs a provider key or a service role beyond what RLS and RPCs already give; fewer deployed artefacts means a smaller release surface during pre-release mode.
- **Consequence:** deployment step 5 (Edge Functions) has nothing to deploy for this feature.

## D-05 Assessor-only data lives in `asm_question_keys`, never in the version definition
- **Decision:** model answers, answer keys, assessor guidance and rubric level descriptors for assessors are rows in `asm_question_keys` (RLS: CMS staff and assigned trainers only). The student RPCs build the student view from `asm_versions.definition` which never contains these fields; a test asserts the student JSON has no `key`, `modelAnswer` or `assessorGuidance` keys.

## D-06 Versions are immutable JSON snapshots; drafts are edited in the same table
- **Decision:** `asm_versions` holds the whole structure (`definition` jsonb: tasks → sections → questions with stable question ids). A draft version is editable; `publish` freezes it (trigger refuses updates to a published version's definition) and the next edit creates a new draft from the published snapshot. Attempts reference `version_id`, so renames and reorders never break responses (keyed by question id).
- **Alternatives:** normalised `asm_tasks` / `asm_sections` / `asm_questions` tables. Rejected for the primary store because every reorder would be a multi-row write and immutability would need triggers on three tables; the normalised view is provided by `asm_version_questions` (a view over the JSON) for mapping, coverage and reports.

## D-07 Server-side response validation is generic, driven by a per-question response schema
- **Decision:** at publish time the registry writes each question's `responseSchema` (a small JSON-schema subset: type, required, enum, min/max items, min/max words, properties) into the version. `asm_validate_responses()` (plpgsql) checks responses against it. Adding a question type is therefore a code change only (D-06, requirement 4.2).

## D-08 Auto-check suggests; the assessor decides
- **Decision:** `asm_results.suggested_outcome` is written by `asm_autocheck()` for objective types (single/multi choice, true/false, matching, ordering, fill-blanks, number) from `asm_question_keys`; `outcome` is written only by an assessor through `asm_trainer('mark')`. Unit outcomes are never derived automatically (`asm_unit_outcomes` insert requires an active trainer or admin and an explicit sign-off).

## D-09 Reassessment and attempt limits are tenant settings with per-assessment overrides
- **Decision:** `asm_settings` (one row per tenant, nullable tenant for the legacy institution) holds `max_attempts` (default 3, as Submissions), `reassessment_days` (default 5, as Submissions' +5-day rule), `declaration_text`, `instructions`, `late_submission` (allow / block), `rollup_rule` (`all_satisfactory` default). An assessment version may override each key. Compliance values that are not certain (attempt counts, reassessment windows) are flagged in REPORT.md for human verification rather than hardcoded.

## D-10 Calendar: assessment events are rows the existing timetable screens read
- **Decision:** `asm_schedule_events` (due dates and practical sessions, with an optional room from `classrooms`) plus `asm_calendar(from, to)` which merges them with the batch's weekly classes for the signed-in student or trainer. No second calendar engine (there is no generic events table today: AUDIT.md K8).

## D-11 Notifications ride the existing `notification_deliveries` queue
- **Decision:** `asm_notifications` (in-app, per user) plus email rows in `notification_deliveries` with the new nullable column `assessment_event_id`; the `notification_deliveries_subject_ref` check is re-created to allow it (exactly as `20261113125512_bookings.sql:97-99` did for bookings). The existing `email-sender` worker sends every pending row that is not `application_submitted`, so no new function or cron is needed.

## D-12 Documents the brief asked for are created although CLAUDE.md says "never create new docs"
- **Decision:** `docs/assessment-integration/*` is created because the owner's brief names these files as deliverables; nothing else outside the brief's list is created. The converter for Submissions content is `scripts/assessment/convert-submissions-content.mjs` (a reusable tool, not a one-off), with its output in `docs/assessment-integration/imports/`.

## D-13 Migration numbering
- **Decision:** `20261113430000_assessment_management.sql` and `20261113440000_assessment_rpcs.sql` follow the hosted highest `20261113420000` (versions must sort after it for a clean replay and a plain `db push`).

## D-14 Local validation path
- **Decision:** `node scripts/lab/staff-lab.mjs up` (fresh local Supabase stack replaying every migration) then `npx supabase test db` on `supabase/tests/assessment_management.sql` (pgTAP, rolled back). Docker Desktop was not running at the start; it was started from its user-profile install path.

## D-15 Trainer identification
- **Decision:** a trainer for an assessment is any active `hr.staff_profiles` row linked to the batch (`batch_trainers`) or named on an assignment; `hr.staff_roles.role = 'trainer'` is shown as a hint in the picker but not required, because `rto_admin('staff_list')` already offers every active profile (AUDIT.md K6) and the owner's staff records may not all carry the role yet.

## D-16 Lab replay order: four hosted-applied files remapped in `scripts/lab/staff-lab.mjs`
- **Decision:** the lab's `HOSTED_LATER` map (already used for `20261112144811_main_site_host.sql`) now also replays `20261112172429_course_fees_master_data.sql` and `20261112172731_course_fees_three_columns.sql` after `20261113320000` (they alter `course_fee_setups`, created by `20261113270000`, and `application_letter_course`, defined by `20261113320000`), and `20261113025808_business_onboarding.sql` and `20261113031341_staff_signed_documents.sql` after `20261113140000` (they read `hr.sign_requests.subject_id`, which the envelopes migration adds).
- **Evidence:** the first fresh replay on 2026-11-14 stopped at `20261112172731` with `relation "public.course_fee_setups" does not exist`; after the first remap it stopped at `20261113025808` with `column r.subject_id does not exist` (direct `supabase start` output). A dependency scan over every file dated 2026-11-12 onward found no other forward reference.
- **Consequence:** no repo migration is renamed (hosted already holds them); only the lab replay order changes. The hosted project applied these files in the working order, so a plain `db push` of the new `20261113430000` / `20261113440000` files is unaffected (they sort after everything).

## D-17 No client write grants on any `asm_*` table; writes only through the three RPCs
- **Decision:** every `asm_*` table has RLS with SELECT policies only (and `revoke insert, update, delete` from `authenticated`). Even an Admin cannot insert an assessment row directly; the RPCs (`security definer`, owner `postgres`) are the only writers, each with explicit role checks, and the guard triggers (immutable published versions, locked submitted attempts, frozen results of returned attempts, append-only outcomes / feedback / audit) protect against RPC bugs as well.
- **Alternatives:** per-table write policies (as `batch_enrolments_admin_write` does). Rejected: the assessment rules are stateful (who may change what in which state) and belong in one place.
- **Evidence:** `supabase/tests/assessment_management.sql` "no client writes anywhere" block (152/152 on the lab, 2026-11-14).

## D-18 Batch membership changes: `follow_batch` (default) voids open drafts and tells joiners; `keep` changes nothing
- **Decision:** `asm_assignments.reassign_rule`. The trigger `asm_batch_enrolment_change` on `batch_enrolments` voids a leaving student's draft attempts (state `void`, reason "left the batch", history kept) for `follow_batch` assignments and notifies a joining student of every open assignment; submitted attempts are never touched. Eligibility itself is always live (`asm_assignment_eligible`: active enrolments of the batch, minus exclusions, plus manual additions).
- **Why:** the brief asks for "defined reassignment rules" without naming them; this is the least surprising reading and every effect is audited (`reassign_leave` / `reassign_join`).

## D-19 Policies never join staff-only tables directly
- **Decision:** a policy that needs `batch_enrolments` / `batch_trainers` calls a `security definer` helper (`asm_trainer_of_student`, `asm_trainer_on_assignment`, `asm_assignment_eligible` through `asm_student_on_assignment`). Those tables are readable only by CMS staff (`cms_is_staff()`), so a trainer's policy subquery on them would silently see no rows.
- **Evidence:** the first version of `asm_unit_outcomes_read` joined the tables directly and the batch trainer could not read the outcome they had just signed (test "the batch trainer signs the student off as Competent", fixed 2026-11-14).

## D-20 Email through the outbox depends on the existing activation rows
- **Decision:** `asm_notify` writes `notification_deliveries` rows (event `assessment_<event>`, `assessment_event_id` set; the subject check re-created to allow it). The existing claim (`support_mail_claim`, rewritten by `20261112160438_email_html_all.sql` to every event other than `application_submitted`) only sends when `notification_activation` holds an approved row for the tenant and `EF_NOTIFICATION_EMAIL_ENABLED=true`. Assessment emails therefore go live with the institution's existing email activation and never on their own; in-app rows (`asm_notifications`) are always written.
- **Consequence for the report:** "assessment emails" is listed as needing the owner's existing notification activation, not a new secret.

## D-21 Observation checklists and third-party reports are validated by the assessor's `required` flag
- **Decision:** `asm_validate_responses(definition, assessor_responses, 'assessor')` runs at `mark_return`; an assessor-only question blocks the decision only when its definition says `required: true` (then its `responseSchema.requiredKeys` apply). The builder sets `required: true` by default for the observation checklist type.
- **Why:** a third-party report is often optional (brief 4.3 lists it as a section, not a mandatory record), so the author decides per question.
