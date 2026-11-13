# CLAUDE.md - Skyline ERP

React 19 / Vite / TypeScript app on Supabase (Postgres, Auth, Storage, Deno Edge Functions). Surfaces: public site, CMS (`src/pages/admin`), Agency Portal (`src/pages/agency`), application wizard, document-extraction queue, public RAG assistant. Preserve all of them with their records, accounts, documents and published URLs.

## Session start
1. `git status --short`: the tree may hold intentional uncommitted changes. Preserve them; never revert, stash or clean.
2. Read this file, then the phase table and your task in `docs/TASKS.md` only.
3. Read `docs/SUPABASE.md` only for Edge Function, migration or env work; `docs/ARCHITECTURE.md` only if you need the tenancy/security model.

## "go" protocol
When the owner says "go" or "continue", do the next eligible task: the first TODO task in `docs/TASKS.md` whose dependencies are all DONE. "go P0X-0Y" picks that task. Local, mock-only work only; finish ONE task, then stop and report.
- Read only that task, plus SUPABASE.md / ARCHITECTURE.md if relevant.
- Migrations: additive, local only, never applied hosted. Tests go into existing test scripts and `supabase/tests`, not new files. Run the native lab when the task touches DB or Edge behavior.
- Before reporting run: type-check, build, lint on src/, offline `test:*`, deno check on all functions, migrations count; if the task touches DB or Edge behavior, run ALL supabase/tests SQL suites in the lab and report counts. Fix lint issues only in files you touch.
- Update only the task's status line in TASKS.md, at most 3 lines in COMPLETED.md, and SUPABASE.md if functions, migrations or env names changed.
- After each task, update the single 'Current position' line (next eligible task, highest local migration, anything newly undeployed). Nothing else in CLAUDE.md.
- Stop and ask instead of proceeding when the task is BLOCKED or needs hosted/live/credentials, a decision cannot be undone, or acceptance cannot be verified locally.
- Report PASS/FAIL/BLOCKED/NOT RUN with exact evidence in chat; compile or mock success is not end-to-end proof. Keep replies short; no recaps of steps.

## Efficiency
- Search with Grep and read file ranges; don't read whole large files, and don't re-read a file you just edited.
- Run only the relevant tests while developing; run the full pre-report suite once at the end.
- Pipe command output through tail/grep so only failures and summary lines enter the conversation.
- No narration between tool calls. Final report max 15 lines: what changed, PASS/FAIL/NOT RUN per check, decisions needed.
- Don't paste SQL or code into the report; name the file and test.
- Don't create plans or recaps; just do the task.

## Never create
New docs, evidence/log/JSON result files, phase folders, handoff/status/test-results files, or one-off scripts. Scratch files go in the OS temp dir, not the repo.

## Status values
TODO, IN_PROGRESS, BLOCKED, DONE (DONE needs verified acceptance). Local status and hosted release status are separate.

## Safety
- Only project `xcpydisstlvtvcsqnjob` (system ID `7692130048193495360`) is approved; verify real project metadata and DB identity before any hosted operation. Project `qoylrmorezlqdvufonmx` (Submissions) is never touched.
- No hosted migrations, `db push`, reset, repair, Edge deploys, secret/cron/DNS/frontend-hosting changes, commits or provider calls without explicit release-specific approval. The completed Phase 1-4 release is not to be rerun.
- No real student documents; no live provider calls (Azure, OpenAI, Postmark, Stripe, PRISMS); no email or charges. Use deterministic mocks.
- Migrations 1-90 are APPLIED on hosted (checked 2026-10-27) and must never be edited; fixes go in new migrations. 91 and above are local only until the owner releases them.
- **Pre-release mode (owner, 2026-11-12, until the first release): no backups, no 15-minute checkpoint, apply migrations directly to xcpydisstlvtvcsqnjob after local tests pass. Never touch qoylrmorezlqdvufonmx.** The task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m` is DISABLED (scripts kept); no hosted backup before a push and no `hosted-refreshed.json` manifest update. Push from a worktree without local-only files (e.g. P09-01 20261113220000). When the owner ends this mode: append every hosted version since 20261113320000 to the manifest, then re-enable the task.
- Migrations are additive and timestamp-ordered. Unknown ownership is never assigned to a default tenant; client tenant IDs are not authorization.
- Keep SEC-18 lease/source fencing and cancellation. JWT stays on; never disable it as an auth workaround.
- Dev server: `vite --port 3001`. Port 3000 belongs to TenderFlow; never disturb it.
- After every push to main (owner rule, 2026-11-13), update the owner's working folder `C:\Users\goura\Desktop\Skyline-Website` (the dev server runs from it): (1) `git status`; uncommitted changes there: stop and tell the owner, touch nothing; (2) otherwise switch to `main` and fast-forward it to `live/main`; (3) `npm install` if package.json or package-lock.json changed; (4) restart the dev server on 3001 if it was running; (5) say in the final report which commit localhost is on. When no other session is running, work in that folder directly instead of a worktree, so the dev server hot-reloads as files change.
- Never print or commit `.env` or CLI secret files. New env vars are named `EF_<SERVICE>_<SETTING>`; `.env.example` stays placeholder-only.
- Backup task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m` (DISABLED in pre-release mode) runs `scripts/release-close/*` and writes to `docs/release-evidence/close-20261026/`, `C:\Users\goura\Skyline-Recovery` and `C:\Users\goura\.skyline-recovery-keys`. Do not move, edit or delete those.

## Map
- `src/` frontend; `supabase/functions/` 29 Edge Functions (all deployed; every production function has its folder) + `_shared/`; `supabase/migrations/`; `supabase/tests/` SQL tests; `ocr-service/` local PaddleOCR, not wired to the app.
- `scripts/test-*.{ts,mjs}` product-logic tests (npm `test:*`); `scripts/lab/` native lab (start `node scripts/lab/server.mjs --p04-complete`, needs Docker; run `scripts/lab/native-extraction.mjs`, add `--azure` / `--notify` for the Azure / notification paths); `scripts/release-close/` backup task only.
- npm: `type-check`, `lint` (covers `src/` only), `build`, `test:*`; `*:integration` and `test:public-assistant:local-acceptance` need local Supabase.

## Current position
Verified on hosted 2026-11-11 (project xcpydisstlvtvcsqnjob, system id 7692130048193495360): every released repo migration is APPLIED (217 of 217, highest 20261113210000; 20261111131056 integration_token_refresh_schedule and PR #31's 20261111143429 student_office365_accounts are in the repo and hosted-refreshed.json) and every repo Edge Function is DEPLOYED (student-office365 v1; hosted also has integrations-admin v5 and integrations-refresh v1 from the External Integrations session), so everything below is RELEASED except P09-01; versions in SUPABASE.md "Release status". live/main carries the frontend (Vercel project skyline-website-cms, production at skyline-website-cms.vercel.app). Next eligible: P09-02. Highest hosted 20261113210000; highest local 20261113230000 (find_student_by_email, NOT applied; 20261113220000 P09-01 NOT applied). Newly undeployed: P09-01 migration 20261113220000 + public-assistant + public-assistant-index changes (release order in SUPABASE.md "Public assistant per tenant"); email-unique-per-role first stage: migration 20261113230000 + cms-admin-users (SUPABASE.md "Email unique within a role"). Hosted holds five 2026-11-12 versions applied outside this branch (20261112021616 on live/main; the four email migrations now in the repo), none in hosted-refreshed.json.
RELEASED 2026-11-11 ~08:5xZ: TPL-02 document templates (Header / Body / Footer, presets, [Variables] registry, signer tokens and initials on every page, .docx import, Arimo PDF, one editor font) and INT-01 intakes (course_intakes, CMS > Courses > Intakes, enrolment form intake from the course with the next-12-months fallback for a course without intakes, server checks on save and submit). Migrations 20261113190000, 20261113200000, 20261113210000; document-signing v5. Also released: pdf.js legacy build for the PDF viewer, signing retry on WORKER_LIMIT. Backups in `C:\Users\goura\Skyline-Backups\templates-intakes-release-20261111` and `...\intakes-step3-release-20261111`. See SUPABASE.md "Document templates with Header, Body and Footer".
RELEASED 2026-11-12 (owner's go, no prior backup: recovery machine unreachable): TKT-01 support tickets, hosted migration 20261112021616_support_tickets (bucket support-attachments, CMS menu Tickets), frontend via PR #32. OWNER ACTION: add 20261112021616 to hosted-refreshed.json on the recovery machine; until then the 15-minute checkpoint fails at "history".
RELEASED by another session: External Integrations (migrations as hosted versions 20261111075147 / 20261111075214, renamed in the repo 2026-11-11 from 20261113180001 / 20261113180002; integrations-admin v2, integrations-webhook v1).
RELEASED 2026-11-11: TPL-01 one template system + PR #29 passport holder check; HOL-01 holiday sync (cron hr-holiday-sync); LET-01 letters, locations, job / pay type, sign-in link; SIGN-02 envelopes (cron signing-notifications active, its two Vault secrets set 05:48Z; the one open request SLIT-2026-000001 gets its next reminder about 14 Nov 03:07Z, one at a time). 2026-11-10: SIGN-01, Tax and super, ONB-01, ONB-02, HRMS-01, HR-02 staff enrolment v2. Phases 1-8b released (P05-04 BLOCKED on live Azure approval, P08-08 BLOCKED on PRISMS API access).
RELEASED 2026-11-13: COURSE-MGMT courses, units, fee line items, intakes (master timetable), schedules, classrooms, batches, trainers, enrolments; migrations 20261113340000 ... 20261113390000 (highest hosted 20261113410000: TIMETABLE-B batch class timing, room clashes, rooms board, intake cards and sheet, batch page; TIMETABLE-A locations/rooms, term breaks, SLIT master timetable import; COURSE-FLOW guided course wizard, batch date overrides, intake duplicate; FEE-LOO fee lines as the SLIT letter prints them, GST per line, Settings › Other fees and charges). Fee total = sum of `course_fee_items.included_in_total` (deposit excluded, shown as part of the total) via `course_fee_total_cents`, used by letters, website and CMS. Roles: `cms_users.rto_manager` (RTO Manager edits; Admin enrols students with an application; Editor website only). Details: SUPABASE.md "Courses, units, intakes and batches".
Cron on hosted (all active): hr-holiday-sync, hr-pay-periods-topup, hr-retention-purge, notification-delivery-worker (every minute), portal-document-extraction-worker, public-assistant-index-worker, signing-notifications.
RELEASED 2026-11-12: OFFER-SIGN offer letters signed from the email without login (migration 20261113330000, document-signing, email-sender; see SUPABASE.md). Highest hosted 20261113330000; still local only: 20261113220000 (P09-01).
15-minute recovery task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m`: DISABLED 2026-11-12 (pre-release mode, see Safety); its manifest hosted-refreshed.json lacks every hosted version after 20261113320000 (incl. sixteen 20261112* versions from other sessions) and must gain them before it is re-enabled.
Owner-only items: copy the Vault secret `hr_bank_details_key` somewhere safe; Turnstile error 400020 on the live staff form (hostname not in the site key); the Auth Invite template (needs a token); hosted staff have no logins until an admin sends sign-in links; staff must add real intakes per course (until then the form offers the next twelve months). NOT RUN live: admin-authenticated smoke tests (template save / preview / sign, intakes screen, offer email), live Postmark, live Azure. https://slit.edu.au is a separate site (not this frontend).
