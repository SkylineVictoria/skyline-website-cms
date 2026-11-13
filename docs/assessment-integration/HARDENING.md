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
