# Assessment Management integration: morning report

Run: 2026-11-13 late evening to 2026-11-14 (Asia/Kolkata), autonomous, on branch `feat/assessment-management` in the owner's working folder. Three sections of evidence: **VERIFIED** (run here, with the output), **ASSUMED** (reasoned from code), **NEEDS AUTHENTICATED RUNTIME CHECK** (not run).

## 1. What was built, by phase

| Phase | Status | Deliverable |
|---|---|---|
| 1 Audit | DONE | `AUDIT.md` (2,325 lines: Submissions S1-S14 with the hardcoding inventory, Skyline K1-K15, matrix, identity, data model, workflows, risks, plan, confirmed / assumed / runtime); `DECISIONS.md` D-01..D-21 |
| 2 Database, identity, security | DONE, APPLIED HOSTED | `20261113430000_assessment_management.sql`, `20261113440000_assessment_rpcs.sql`; private bucket `assessment-evidence`; pgTAP suite `supabase/tests/assessment_management.sql` (152) |
| 3 Admin | DONE (local) | CMS › Master Data › Assessments: library, builder (drag and drop, 20 types, conditional logic, repeating groups, case study, criteria, rubric, assessor-only keys, question bank, preview), unit mapping with coverage gaps, versions / publish / retire / export / import, assignments (batches, dates, extra assessors, sessions, per-student overrides), submissions overview, pending marking, reassessment requests, attempt viewer with reopen / void, outcomes, reports (cohort / assessment, CSV), settings, audit, calendar; Course wizard › Assessments; Batch › Assessments & Results; Student › Assessments and competency |
| 4 Trainer | DONE (local) | `/staff/assessments` (pending marking, my assessments with students, my students with competency progress, calendar, notifications), `/staff/assessments/attempts/:id` (answers beside model answer / guidance / key / auto-check suggestion, per criterion / rubric / question outcomes, observation checklist and third-party report, assessor evidence, task outcomes with rollup suggestion, feedback, decision, messages, unit outcome sign-off) |
| 5 Student | DONE (local) | `/agency/assessments` (My assessments, Results & progress, calendar, notifications), `/agency/assessments/:id` (task by task, autosave with row version, evidence upload, live validation, declaration + typed signature, receipt, results / feedback / reassessment / messages) |
| 6 Calendar + notifications | DONE | `asm_schedule_events` + `asm_calendar` merged with weekly classes, used by student, trainer and admin; reassignment trigger; events published / due_soon / overdue / submitted / marked / reassessment / outcome / reassigned / extended through `asm_notifications` and the existing outbox |
| 7 Competency, reports, audit | DONE | `asm_unit_outcomes` (signed, insert-only, superseding chain), progress views, cohort and assessment reports with CSV, append-only `asm_audit_log` with CMS viewer and export |
| 8 Tests | DONE (see section 5) | pgTAP 152, registry 51, Playwright journey, regression of every suite |
| Deployment | migrations APPLIED; frontend: see section 4 | |
| Converter | DONE | `scripts/assessment/convert-submissions-content.mjs` → `imports/` (3 files) |

## 2. Migrations applied (VERIFIED)

`npx supabase db push --linked --yes` on project **Skyline Web (xcpydisstlvtvcsqnjob, ap-southeast-2, Postgres 17.11)** at about 2026-11-14 00:0x Asia/Kolkata (2026-11-13 18:3xZ), after `--dry-run` listed exactly the two files:

- `20261113430000_assessment_management.sql`
- `20261113440000_assessment_rpcs.sql`

Verification run read-only on hosted right after (one SQL query over `pg_tables`, `pg_policies`, `storage.buckets`, `pg_proc`, `cron.job`, `admin_menu_items`, `information_schema.columns`, `supabase_migrations.schema_migrations`):

| Check | Result |
|---|---|
| `asm_*` tables / with RLS enabled | 21 / 21 |
| Policies on `asm_*` / non-SELECT policies | 40 / 0 (no client write policy anywhere) |
| Storage policies `asm_evidence_*` / bucket `assessment-evidence` private | 3 / yes |
| RPCs `asm_admin, asm_trainer, asm_student, asm_calendar, asm_validate_responses, asm_autocheck, asm_due_sweep` | 7 present |
| Cron `asm-due-sweep` | scheduled |
| Menu row `rto_assessments`, column `notification_deliveries.assessment_event_id` | present |
| Existing rows | `notification_deliveries` 10 rows (unchanged count), `batches` 0 (hosted has no batches yet), `asm_assessments` 0 |
| `migration list --linked` | highest remote `20261113440000`, 262 remote, no local-only version |

Local validation before the push: a fresh lab stack replayed all 266 files (262 repo + 4 lab shims) and the new suite passed 152/152; every other suite was compared with a baseline run WITHOUT the two migrations (section 5).

Backup (brief 11.2): **SKIPPED by a guardrail**. The session's permission system refused the hosted `db dump` (the command was classified as unauthorised access and I did not work around it); CLAUDE.md's pre-release mode also waives backups until the first release. The migrations are additive (new tables, one nullable column, one re-created `NOT VALID` check, one menu row), so nothing existing needed restoring.

## 3. Edge Functions deployed

None. No function was created or changed (DECISIONS D-04); the existing `email-sender` sends the assessment emails.

## 4. Commits and `main`

Commits on `feat/assessment-management` (small, logical): `586d895` audit + decisions, `e18a8ab` schema / RLS / RPCs / pgTAP, `735c78c` engine + admin + trainer + student UI, `5f381ae` registry tests + converter, `b773904` architecture / migration-plan docs + SUPABASE.md + e2e spec, then the merge of `live/main` (`006d4bb`, the only commit production gained since the branch point) and the e2e selector fixes.

Remotes: `live` (SkylineVictoria/skyline-website-cms, production, the branch Vercel builds) and `origin` (SiyanainfoAhm fork, whose `main` is an unrelated older history: 702 files differ). "main" in this repo's conventions is `live/main` (CLAUDE.md). Whether `main` was pushed: **see the final line of this file** (written after the gate).

## 5. Test results (VERIFIED)

| Suite | Result |
|---|---|
| `supabase/tests/assessment_management.sql` (pgTAP, fresh lab) | **PASS 152/152** |
| `npm run test:assessment-registry` | **PASS 51/51** |
| `npm run type-check` / `npm run lint` (src, 0 warnings) / `npm run build` | **PASS / PASS / PASS** (after the merge of `live/main` too) |
| Playwright `e2e/assessments.spec.ts` (lab) | admin builds / publishes / assigns: PASS; student completes / submits with declaration / receipt: PASS; trainer marks and signs off, student sees result: **see the final line of this file** |
| All 14 other SQL suites (fresh lab WITH the new migrations) | 11 PASS; 3 FAIL with the **same failures as the baseline WITHOUT the new migrations** (run twice, identical): `hr_staff_registration` 696/697 (activation message changed by the signed-documents work), `phase2_authorization_red` 473/477 (two stale menu expectations, now fixed by me → 475/477 expected; two notification-claim expectations stale since `20261112160438_email_html_all.sql` rerouted claims), `phase4_authorization_positive` 304/556 (`portal_agency_create_with_admin` now refuses direct creation since BIZ-ONB `20261113025808`; the aborted transaction cascades into 428 errors). These are pre-existing from other sessions' product changes, not from this work. |
| `test:*` script tests (document extraction, passport parser, portal access, staff registration, holiday import, public assistant) | not re-run after the merge: no file they cover changed (ASSUMED) |

Flexibility acceptance test (brief 8): **PASS** as the pgTAP journey: with zero code changes and zero migrations at runtime an admin creates an assessment with every question type, conditional logic, a repeating group, a case study, criteria, a rubric, unit mapping and an observation checklist and publishes it; the student completes it with a draft and a file upload and submits with the declaration; the trainer marks per criterion, adds feedback and triggers a reassessment; the unit outcome is recorded with sign-off; the admin edits the assessment into version 2 and publishes it while the student's attempts stay on version 1 (tests "version 2 publishes", "the student attempts stay bound to version 1").

## 6. Steps skipped by guardrails

- Hosted backup dump (section 2): permission system refused; migrations are additive.
- Submissions: nothing was read from its database, nothing in its repo changed (read-only source audit only). Its live project ref could not be confirmed offline (CLAUDE.md names `qoylrmorezlqdvufonmx`; the checkout's `.temp/project-ref` holds `fvveqziyusjgqejowkfp`); neither was touched.
- Pushing `origin/main`: not done, its history is unrelated to production (section 4); the feature branch and `live` are the targets.

## 7. Assumptions

- Hosted matched CLAUDE.md's "Current position" (confirmed by `migration list`: `20261113220000` and `20261113230000` were already applied, highest `20261113420000` before this push).
- The two 2026-11-12 fee migrations and the two 2026-11-13 onboarding / signed-documents migrations were applied on hosted after the files they depend on (they cannot have applied in version order); the lab now replays them that way (D-16).
- A trainer is any active `hr.staff_profiles` on the batch or named on the assignment (D-15); the `trainer` role row is a hint.
- Email for assessment events goes out only where the institution's existing notification activation and `EF_NOTIFICATION_EMAIL_ENABLED` already allow it (D-20); in-app notifications always.

## 8. Compliance items needing human verification (configurable, not hardcoded)

| Item | Where configured | Default used |
|---|---|---|
| Maximum attempts per assessment | Settings › `max_attempts`, per-assessment override | 3 (Submissions' rule) |
| Reassessment window after NYS | `reassessment_days` | 5 days (Submissions' rule) |
| Late submissions | `late_submission` allow / block, `late_until` per assignment | allow, flagged late |
| Task rollup suggestion | `rollup_rule` | all questions S → suggest S; assessor decides |
| Declaration wording | `declaration_text` | a generic plagiarism / own-work declaration |
| Evidence limits and types | `evidence_max_mb`, `evidence_allowed_types` | 25 MB, pdf / images / office / video / audio / zip |
| Unit outcome sign-off authority | trainer of the batch (or named assessor) or Admin / RTO Manager, with the explicit declaration | — |
| Retention and immutability of records | attempts, results of returned attempts, outcomes, feedback and audit are append-only | — |

Nothing marks a student Competent automatically; auto-check only suggests.

## 9. Required env vars, secrets, config

None new. Hosted additions are schema only: bucket `assessment-evidence` (private), cron job `asm-due-sweep` (21:00 UTC daily, `asm_due_sweep()`), menu row `rto_assessments` under Master Data (visible to CMS Admins; the route is allow-listed in `src/pages/admin/lib/adminMenu.ts`). Emails ride the existing Postmark outbox and activation.

## 10. Known gaps and risks

- The CMS Assessments menu row uses permission `cms.admin`; RTO Managers who are not Admins reach the page by URL (the RPC admits them), the menu does not show it to them (same pattern as Classrooms).
- Hosted has no `batches` rows yet, so nothing can be assigned until staff create intakes and batches (Courses › Intakes).
- Unit elements / performance criteria must be typed in by staff (Assessments › Unit mapping › Edit unit elements) or arrive with a JSON import; training.gov.au carries only counts.
- The three pre-existing SQL suite failures (section 5) belong to other sessions' changes; the gate in brief 11.6 is therefore not "all green" in the strict sense (see the final line for what was pushed).
- Bulk tooling not built: no CSV import of unit elements, no PDF export of a completed attempt (the e-sign PDF pipeline can be reused later), no email digest.
- Browser-level checks on hosted (admin-authenticated smoke of the CMS pages, the staff workspace and the portal) were NOT RUN; the local Playwright journey covers the same screens against the lab.
- `origin/main` (fork) diverges from production; nothing was pushed there.

## 11. Recommended next steps

1. Staff: add the unit elements and criteria for each unit (or import the SLIT assessment JSON per unit), review the three converted Submissions imports in `imports/` and import the Student Pack policies as a template.
2. Create intakes and batches on hosted, assign trainers, then assign the first assessment to a batch and run one real submission end to end (admin → student → trainer).
3. Decide the compliance defaults in Settings (attempts, reassessment window, late rule, declaration wording) against the Standards for RTOs 2025.
4. Re-enable the 15-minute checkpoint after the manifest is caught up (CLAUDE.md), so `asm_*` and `assessment-evidence` are in the backups.
5. Fix the stale expectations of the three pre-existing suites in their own change (BIZ-ONB, signed documents, email routing).
6. Later: PDF export of a completed attempt through the signing module, CSV import of unit elements, Playwright coverage of reassessment and version 2 in the browser.

## 12. Final gate outcome

(written last, after the browser journey and the push)
