# Assessment Management: hardening run (feat/assessment-hardening)

Overnight run started 2026-11-14 (owner asleep, autonomous). Branch from `live/main` 645d670. Each task appends its status here and commits.
Rules in force: no backups, no Submissions data, no `db push`, no push to `live/main` or `origin`; read-only hosted queries only.

## T1 SQL suites green (DONE)

Lab: the stack from the previous session (`skyline-staff-lab`, all 262 migrations); pgTAP installed. All 15 suites: `node scripts/lab/staff-lab.mjs sql`.

| Suite | Before | After |
|---|---|---|
| phase4_authorization_positive | 304/556 (aborted at the closed agency path) | 536/536 |
| phase2_authorization_red | 474/477 | 477/477 |
| hr_staff_registration | 696/697 | 697/697 |
| assessment_management | 147/152 on a used lab (152/152 fresh) | 152/152 on a used lab |
| other 11 | PASS | PASS |

Test-only changes (product behaviour intended, nothing in product code):
- phase4: the one-step `portal_agency_create_with_admin` is closed (BIZ-ONB 20261113025808): the suite now adds the business through `admin_business_create` as the signed-in organisation admin (Inactive, contact agent, invalid email / agency-admin refusals) and asserts the old path raises 22023. Agent self-registration (public and post-sign-in) is closed (20261112112500): the 18 registration / review tests became 6 refusal tests; the ABN lookup uses the admin-created business. Claims: `coe_voe_issued` and other non-`application_submitted` deliveries are claimed by `support_mail_claim` (20261112160438). The sign-in link host is `main_site_host()` (20261112144811), not a fixed domain. INT-01 labels use `course_intake_display()` (COURSE-MGMT). Plan 556 -> 536.
- phase4 fixture: a fresh lab has no `cms_settings` row (hosted always has one), so the suite inserts one when none exists; the two seeded-letter checks (`SLIT Letter of Offer and Written Agreement`, `Standard Letter of Offer`) `skip` when the seed did not run, because the lab creates its CMS admin after migrations and the seeds need an active admin at migration time.
- phase2_authorization_red: claim tests use `support_mail_claim`; the duplicate-delivery test copies its own row instead of `limit 1`.
- hr_staff_registration: activation is blocked with the signed-documents message (20261113031341) before the offer-signed check.
- assessment_management: notification / outcome / pending counts are scoped to the suite's own assignment and assessment so a lab that already ran the Playwright journey still passes.

Possible product bugs noticed (not changed): none. Lab gap (not a product bug): the letter seeds do not run on a lab because no CMS admin exists at migration time; the offer-letter e2e paths that rely on the seeded SLIT letter cannot run on a lab until `staff-lab.mjs up` re-seeds them.

## T2 RPC and RLS security review (DONE)

Migration `20261113450000_assessment_security_hardening.sql`; 72 new pgTAP tests in `supabase/tests/assessment_management.sql` (224/224); all 15 suites PASS on the lab.

Reviewed: `asm_admin`, `asm_trainer`, `asm_student`, `asm_calendar`, `asm_validate_responses`, `asm_autocheck`, `asm_due_sweep`, every `asm_*` helper, every `asm_*` policy (SELECT-only, permissive role policy AND restrictive `tenant_scope` policy per table, no client write grants), the three storage policies on `assessment-evidence` and the two path helpers.

Sound as built: SECURITY DEFINER + `search_path = public` on every RPC and policy helper; `asm_due_sweep`, `asm_autocheck`, `asm_notify*`, `asm_log`, `asm_open_attempt` revoked from authenticated; assessor keys only via `asm_question_keys` (admin or trainer-on-version) and the student attempt view hides results, assessor responses and suggestions until the attempt is returned; storage paths are bound to an attempt id that the policy resolves to the caller's own draft (student) or an assignment the caller assesses (`<attempt>/assessor/`); signed URLs need the SELECT policy, which needs the same path check.

Gaps found and fixed:
1. `asm_admin` trusted every client id: an Admin / RTO Manager signed in under another institution's domain could read, edit, export, assign, void and reopen tenant 1 objects by id, and every list action was institution-wide. Fix: `asm_admin_scope_check(action, data)` refuses (P0002) any `id` / `assessmentId` / `fromAssessmentId` / `versionId` / `assignmentId` / `batchId` / `courseId` / `unitId` outside `tenant_scope`; the list / overview / audit / bank / batch / calendar queries are filtered by `tenant_scope`.
2. `asm_trainer_on_assignment(assignment, profile)` accepted any profile from any signed-in user (membership oracle) and ignored the tenant; it now answers only for the caller's own profile (admins and system jobs excepted) inside the tenant. Every trainer action and trainer policy routes through it.
3. Student RPC lookups add `tenant_scope` to the owner check (defence in depth).
4. `asm_evidence_path_readable` requires `tenant_scope` of the attempt and returns false, never null.
5. `asm_calendar` admin branches filtered by tenant.
6. 18 pure helpers / trigger functions had no `search_path` and were executable by PUBLIC / anon; trigger functions were executable by authenticated; the view `asm_version_questions` was writable by anon and authenticated. All revoked / pinned (pure validators stay callable by signed-in users: no data access).

Patch mechanism: the RPC bodies are patched in place from `pg_get_functiondef` with single-line anchors that must match an exact count (same technique as `20261112160438_email_html_all.sql`); the migration is not re-runnable by design.

Product bug found (fixed in T4, not here): after a draft is voided (student left and rejoined the batch, exclusion, cancelled assignment), `asm_student('assessment_open')` tries attempt number 1 again and fails on the unique key (`asm_attempts_assignment_id_student_id_attempt_no_key`). Reproduced at the end of the suite with student 3.

## T3 Trainer scope (DONE, D-22)

Migration `20261113460000_assessment_trainer_scope.sql`: `asm_settings.require_trainer_role` (default true), `asm_can_assess(assignment, profile)` / `asm_can_assess_attempt`, `asm_has_trainer_role`; `mark_save`, `mark_return` and assessor evidence (RPC and storage policy) need the marking right; `asm_record_unit_outcome` rewritten (batch trainer with the role on a batch of the unit's course, or a named assessor on an assignment of that unit the student attempted, or Admin / RTO Manager; `batchId` must be the student's, `assessmentId` must be of the unit; tenant checked). Reading stays open to every batch trainer; `my_assignments` and `attempt_get` carry `canAssess`, the marking page explains a refusal, Settings has "Who may mark and sign off". 39 tests "T3 ..." (suite 263/263); type-check and lint clean.

Hosted read-only query (project xcpydisstlvtvcsqnjob, system id 7692130048193495360, 2026-11-14): active staff 1; with the trainer role 0; batches 0; batch-trainer links 0; **active staff linked to batches who lack the trainer role: none** (nobody is linked yet); named assessors 0; highest hosted migration 20261113440000. Owner action after release: give trainers the Trainer role in HR before linking them to batches, or switch the setting off.

## T4 Attempt pattern, server-side (DONE)

Migration `20261113470000_assessment_attempt_pattern.sql`: partial unique index `asm_attempts_one_open` (one draft per student per assignment); `asm_attempt_count` (non-void attempts), `asm_max_attempts` (setting + per-assessment override), `asm_next_attempt` as the single gate for every further attempt (assignment open, no draft, under the limit or an audited administrator `overrideLimit`, next number = max + 1 so a voided draft no longer blocks the student: the T2 bug). `mark_return` (NYS -> next attempt due in `reassessment_days`), `assessment_open`, admin `attempt_reopen` and `reassessment_decide` all go through it; new trainer actions `attempt_void` / `attempt_reopen` for assessors with the marking right (never beyond the limit), audited (`attempt_void`, `attempt_reopen`, `attempt_limit_override`). Late rule: `block` refuses after the due date unless `late_until` extends it; `allow` accepts and flags late but never after `late_until`. Row-version conflicts (40001) on draft_save / submit / mark_save / mark_return were already refused when `rowVersion` is sent; the student page now tracks the server row version in a ref and sends it on submit (it sent `rowVersion + 1`, which was wrong whenever no autosave was pending). The admin attempt drawer gained "Allow beyond the attempt limit (audited)". Submitted attempts immutable (guard trigger) and version binding (assignment's version) re-tested. 56 tests "T4 ..." (suite 319/319); type-check and lint clean.

Not changed, by design: `rowVersion` stays optional server-side (the suite and older clients call without it; the client always sends it); a due-date change on the assignment reaches only first-attempt drafts, a per-student due date reaches every draft of that student (reassessment windows are per attempt).

## T5 Submissions feature parity, features only (DONE)

Compared AUDIT.md S1-S14 (S-A §9 classification, S-C §5.4, Part R3 "from Submissions, behaviour only") against what is built.

| Submissions feature | Skyline status |
|---|---|
| Admin overview, trainer queue / Grade-me, trainer course units + unit submissions + my students, student dashboard | Built (overview, pending marking, my assignments / students, My assessments) |
| Student acknowledgment gate (changed outcome must be acknowledged) | **Built now** (`20261113480000`): `asm_attempts.acknowledged_at`, `asm_student('result_acknowledge')` (returned / final only, first time kept, audited), "Results to acknowledge" panel on My assessments, `acknowledgedAt` in every attempt view |
| Idempotent final submit with request id + submission events | **Built now**: `submit` takes `requestId`, keeps it on the attempt and returns the original receipt (`idempotent: true`) on a retry; the student page sends one id per submission; audit / notifications stay single |
| Debounced per-question autosave with merge guard | Built (autosave + row version; T4 fixed the client's row-version bookkeeping) |
| Attempts, reassessment window, late rules, extension (per-student due date), access dates | Built (T4) |
| Feedback per task / attempt, trainer + student sign-off with names, declaration + hash | Built (feedback thread, task results, declaration with sha-256, signed unit outcomes) |
| Course / unit / batch links, batch trainers, batch unit dates | Built (assignments on batches, `intake_units`, unit mapping) |
| In-app notifications, Postmark email | Built (asm_notifications + existing outbox) |
| Reports (cohort / assessment) with export, audit log | Built (CSV, append-only `asm_audit_log` with viewer / export) |
| Reasonable Adjustment matrix, Learner Evaluation, 15 policy sections, Results / Summary sheets | Content: converter output in `imports/` (import through Assessments › Import), structure is data |

Deliberately not built (reason):
- Rollover cron that auto-writes Not Yet Satisfactory on a missed reassessment window: D-08 / brief 8, nothing is decided automatically; the daily sweep notifies overdue students and the assessor decides.
- Office sign-off checkboxes (`initial_checked` / `updated_checked`) and auto-complete when all are ticked: superseded by the signed unit outcome and the audit log; an admin reviews attempts in the CMS drawer.
- Completed-attempt PDF queue to SharePoint: needs a PDF worker / Edge Function and a provider; the e-sign PDF pipeline can be reused later (REPORT.md gap).
- FCM push and the realtime bell: Skyline has no push channel; in-app rows plus email through the existing outbox.
- XLSX report export: CSV opens in Excel; no spreadsheet dependency added.
- OTP logins, instance access tokens, public form start page, impersonation and its log, "login as student" batch flag: D-02, Skyline logins and RLS only.
- Melbourne end-of-day default deadlines: due dates are explicit timestamps chosen by staff (shown in Melbourne time).

17 tests "T5 ..." (suite 337/337); type-check and lint clean.
