# CLAUDE.md - Skyline ERP

React 19 / Vite / TypeScript app on Supabase (Postgres, Auth, Storage, Deno Edge Functions). Surfaces: public site, CMS (`src/pages/admin`), Agency Portal (`src/pages/agency`), application wizard, document-extraction queue, public RAG assistant. Preserve all of them with their records, accounts, documents and published URLs.

## Project facts
- Hosted Supabase: project `xcpydisstlvtvcsqnjob` (https://xcpydisstlvtvcsqnjob.supabase.co, system ID `7692130048193495360`), the only approved one. `qoylrmorezlqdvufonmx` (Submissions) is never touched.
- Git: releases go to `main` only. Remotes: `live` = SkylineVictoria/skyline-website-cms (the release remote: a push to `live main` deploys the frontend), `upstream` = the same repository, `fork` = SiyanainfoAhm/skyline-website-cms. Work branches / worktrees are for unreleased work; other sessions' worktrees show in `git worktree list`: remove only your own, by its exact path.
- Frontend: Vercel team `skylinevictorias-projects`, project `skyline-website-cms`, production https://skyline-website-cms.vercel.app (READY about a minute after a push). vercel.json deploys `main` only; a branch preview is made with the Vercel connector `create_deployment` (SSO-protected). https://slit.edu.au is a separate WordPress site, not this frontend.
- Localhost: the owner's working folder `C:\Users\goura\Desktop\Skyline-Website`, `npm run dev` (vite) on port 3001 (port 3000 is TenderFlow). Localhost uses the hosted project: anything done there is live data. The owner's Chrome is signed in to the production CMS, not to localhost.
- Lab (local, Docker): `node scripts/lab/server.mjs --p04-complete` (native lab), `node scripts/lab/staff-lab.mjs` (up / e2e; e2e dev server on port 3011); the `supabase/tests` SQL suites run against a fresh lab. Every test / lab script refuses the hosted project unless `--allow-hosted` (scripts/lab/hosted-guard.mjs).
- CI (GitHub Actions): "AVETMISS compliance", "SLIT Business Rules", "LMS build verification", "Deploy Edge Functions" (manual, main only, secret SUPABASE_ACCESS_TOKEN). `scripts/check-migration-sync.mjs` compares hosted's history with `supabase/migrations` (needs the same token, or `--hosted-file`).

## Hard rules (owner, 2026-11-27)
- Migrations go through files: every hosted schema or function change in the database is a file in `supabase/migrations`, applied to hosted and recorded in `supabase_migrations.schema_migrations` in the same push (HARD RULE under Safety). Never type SQL changes into the Supabase dashboard / SQL editor.
- One session at a time on `main` and on hosted: if another session is changing main or hosted, stop and ask. Re-read `live/main` and hosted's migration history right before every push, apply or deploy.
- Probe before applying: a migration runs first in the lab (replay + suites) and then as a rolled-back probe on hosted (`begin; ... rollback;`, checking the behaviour it adds); it is applied only after both pass.
- Never push with failing checks (the pre-push list under "Test, build, deploy").
- Never delete real student, application or assessment data (records, documents, files, history). Test data (ZZ names, `@blackhole.postmarkapp.com` accounts) is deleted only with the owner's go.

## Test, build, deploy
- Checks before any push: `npm run type-check`, `npm run build`, `npm run lint` (src/), the offline `npm run test:*` scripts (not `*:integration` / `*:local-acceptance`, which need a local Supabase), `deno check --no-lock` on every function (in a worktree add `--node-modules-dir=none`), `node scripts/check-avetmiss.mjs`, `node scripts/check-business-rules.mjs`, and the migrations count. A change to DB or Edge behaviour also runs every `supabase/tests` SQL suite on a fresh lab (report counts).
- Frontend: commit on `main`, push to `live main` (Vercel builds production), confirm the deployment READY, then update the owner's working folder (Safety).
- Migration: new file with a version after the highest hosted one (re-read `schema_migrations` right before; an MCP `apply_migration` records the current UTC time, so name the file with that version, or apply with `execute_sql` / `npx supabase db query --remote --yes -f <file>` and insert the history row yourself) -> lab replay and suites -> rolled-back hosted probe -> apply -> history row -> commit and push in the same push -> `node scripts/check-migration-sync.mjs` shows no difference. Hosted writes need the owner's release approval.
- Edge Function: only from a clean, pushed, up-to-date `main` (HARD RULE under Safety). `npx supabase functions deploy <fn> --project-ref xcpydisstlvtvcsqnjob --use-api --yes` (uses the function's deno.json and config.toml verify_jwt), or `gh workflow run deploy-edge-functions.yml --ref main -f functions=<fn>` once the token works. Confirm the new version is live and the new action answers, then record it at the top of docs/EDGE_FUNCTION_VERSIONS.md.
- Release checklist: (1) owner approval for this release; (2) all checks pass; (3) migration applied after its probe, history row recorded, file committed; (4) commit A = migration + function changes only, pushed, function deployed from that clean main and confirmed; (5) commit B = frontend, pushed, Vercel READY; (6) entry at the top of docs/HISTORY.md, versions in docs/EDGE_FUNCTION_VERSIONS.md, SUPABASE.md if functions / migrations / env names changed; (7) working folder fast-forwarded, report which commit localhost is on.

## Current state (2026-11-27)
- The latest position is the top entry of docs/HISTORY.md (HOSTED-REPO-SYNC: hosted = repo, highest hosted and local migration 20261128001517).
- Known failing (fresh lab, SQL-SUITES-GREEN 2026-11-27): phase2_authorization_red 476/477 (default workflow config vs legacy transitions differ by 47 pairs); phase4_authorization_positive stopped at 137/1022 on a real finding (a SLIT admin Set to Submitted from Action required records no student signature; SUBMITTED-NEEDS-SIGNATURE came later, re-run it); rto_batch_seats 0/92 (written for the batches tables dropped 2026-11-19: rewrite or retire, owner). A push must not add to this list.
- Blocked: the repository secret SUPABASE_ACCESS_TOKEN is rejected (401) since 2026-11-27, so the "Deploy Edge Functions" job and the migration sync CI cannot run until the owner renews it (deploy with the CLI meanwhile); portal-document-extract waits for a deploy from main (live 38).
- Open decisions / owner actions: ClickSend delivery-report link (Integrations › ClickSend › Delivery reports); staff-register live v20 not redeployed until the owner confirms; rto_course_delete_all left as is (owner to decide); end of pre-release mode (manifest + recovery task, Safety); keys not set yet: EF_ABR_GUID, the Google Maps key (Integrations › Connections), the OMARA search API key, EF_MICROSOFT365_GROUPS_STUDENT / _STAFF; avetmiss_codes has no language / country lists. Check docs/HISTORY.md before acting on any of them: a later entry may have closed it.

## Where notes go (owner, 2026-11-27)
- Release and progress notes go into docs/HISTORY.md (newest first, under the date), never into CLAUDE.md. Deployed function versions go into docs/EDGE_FUNCTION_VERSIONS.md.
- CLAUDE.md changes only when a rule or a standing fact changes; keep it under 40k characters.

## Docs index (not auto-loaded; read when the task needs it)
- docs/HISTORY.md: release / progress log, newest first. Read the top entries at session start and the entries of the area you change.
- docs/EDGE_FUNCTION_VERSIONS.md: live versions recorded per deploy. Read before every Edge Function deploy.
- docs/SUPABASE.md: database, migration, Edge Function and env notes per feature. Read for Edge Function, migration or env work.
- docs/ASSESSMENTS.md: the PDF workbook assessment design. Read before changing assessments.
- docs/compliance/AVETMISS.md: AVETMISS traceability register. Read with the AVETMISS sections below before touching reportable data.
- docs/ARCHITECTURE.md: tenancy / security model. docs/TASKS.md, docs/COMPLETED.md: the phase task list ("go" protocol). docs/BUSINESS_RULES.md, docs/BUSINESS_RULES_AUDIT.md: business rules.

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
- After each task, add its entry at the top of docs/HISTORY.md (next eligible task, highest local migration, anything newly undeployed). Change CLAUDE.md only when a rule or fact changes (see "Where notes go").
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
New docs, evidence/log/JSON result files, phase folders, handoff/status/test-results files, or one-off scripts. Scratch files go in the OS temp dir, not the repo. The files in the "Docs index" below are the exception: they hold what was moved out of this file and the release log.

## Status values
TODO, IN_PROGRESS, BLOCKED, DONE (DONE needs verified acceptance). Local status and hosted release status are separate.

## Safety
- Only project `xcpydisstlvtvcsqnjob` (system ID `7692130048193495360`) is approved; verify real project metadata and DB identity before any hosted operation. Project `qoylrmorezlqdvufonmx` (Submissions) is never touched.
- No hosted migrations, `db push`, reset, repair, Edge deploys, secret/cron/DNS/frontend-hosting changes, commits or provider calls without explicit release-specific approval. The completed Phase 1-4 release is not to be rerun.
- **HARD RULE, every session (owner, 2026-11-20): Edge Functions are deployed only from an up-to-date `main` with a clean working tree.** Before any `functions deploy`: `git pull` (fast-forward to `live/main`), `git status` shows nothing uncommitted, and `git log live/main..HEAD` is empty (everything pushed). Never deploy a function from local uncommitted or unpushed changes, a feature branch or a worktree that is not `main`. Then check the function's live version (Supabase `get_edge_function` / `list_edge_functions`): if it is newer than the last version this session deployed (or, before this session's first deploy, newer than the version recorded in docs/EDGE_FUNCTION_VERSIONS.md), STOP and tell the owner instead of overwriting it. After every deploy, add its new version at the top of docs/EDGE_FUNCTION_VERSIONS.md.
- **HARD RULE, migrations in the repo (owner, 2026-11-27): every migration applied to hosted is committed to `supabase/migrations` in the same push, under the version hosted records and with the SQL hosted ran, no exceptions** (an MCP `apply_migration` records the current UTC time as its version: commit the file under that version, or apply with `execute_sql` and record the repo's version yourself). A repo migration is pushed only together with its hosted apply and history row. `node scripts/check-migration-sync.mjs` (CI: workflow "Migration sync") fails on any difference between hosted's history and the folder (CI workflow "Migration sync" from the push that brings hosted in step).
- **HARD RULE, deploy order (owner, 2026-11-20): when a change touches both an Edge Function and the frontend, deploy the function first and confirm it is live (its new version number, and the new action answering), THEN push the frontend.** Never leave the live site calling an action that is not deployed yet. Every push to main also deploys the frontend (Vercel), so do it as two pushes: first a commit with the migration and function changes only (push, deploy from that clean main, confirm), then the commit with the frontend that calls them. A migration the function needs is applied before the function.
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

## AVETMISS compliance (owner, 2026-11-26: every change follows AVETMISS so NCVER reporting never has gaps)
- Spec in use: NCVER AVETMISS VET Provider Collection Specifications release 8.0 (training activity to 31 Dec 2026). Release 8.1
  (published 27 Feb 2026) applies to activity from 1 Jan 2027, and the VET Information Standard replaces AVETMISS by 1 Jan 2029:
  before changing NAT logic, check ncver.edu.au for the latest release and note the version here.
- Data that feeds a NAT file (clients, enrolments, units, courses, locations, delivery modes, outcomes, dates, funding) is stored as
  AVETMISS codes with its required fields at the point of entry, never fixed up at reporting time; required fields are enforced
  in the database (triggers / constraints), not only in the browser.
- Before any change, check its AVETMISS impact against docs/compliance/AVETMISS.md (the traceability register) and update the register
  with it; run public.avetmiss_full_audit() (read-only) to see findings. The GitHub workflow "AVETMISS compliance" (scripts/check-avetmiss.mjs +
  the avetmiss_* SQL suites on a fresh lab stack) must pass; never weaken a guard to make it pass.
- Every change touching this data keeps supabase/tests/avetmiss_nat.sql passing (public.avetmiss_nat_build builds NAT00010-00130,
  public.avetmiss_nat_problems checks codes, required fields and cross-file links) and adds a case there when it adds a rule.
- Kept decisions: "Your RTO hours" (avetmiss_nominal_hours), unit field-of-education codes at onboarding, location and room
  completeness, delivery mode at course onboarding, domestic / international from the passport; program level / recognition codes
  stored on the course (cms_courses.avetmiss_level_code / _recognition_code, set when it is saved).
- Outcome (NAT00120) from the trainer's sign-off: C = 20 (end date = sign-off day); NYC with attempts left = 70 (no actual end);
  NYC on the last allowed attempt = 30 (end date = sign-off day); a resubmission re-signs and moves outcome and date; 40 / 41 / 51 /
  52 / 60 / 61 (withdrawal, RPL, credit transfer, superseded) are set by staff and never overwritten by a sign-off.

## AVETMISS rules (owner, 2026-11-26: no junk, new code follows AVETMISS)
- Past rows are never re-checked or rewritten; only values written from now on are refused (check_violation 23514, the field's own message).
- An AVETMISS value is stored only as a code from the lists (public.avetmiss_codes via avetmiss_code); never free text in a code column.
- Every new AVETMISS column gets a foreign key, a check or a validating trigger in the same migration; supabase/tests/avetmiss_no_junk.sql
  fails while public.avetmiss_guard_gaps() returns a row (columns of the NAT source tables, and any column commented "AVETMISS").
- A new form that collects AVETMISS answers calls avetmiss_check_answers before saving (errors under their fields, Submit also blocked
  by missingForSubmit) and shows a 23514 message as it is (ApplicationWizard is the pattern). Blank answers may be saved as a draft.
- Application answers (enrollment_applications.data values) are checked on every write by trigger avetmiss_application_values;
  the student record, enrolments, unit results and locations by their own triggers / constraints.

## Standing facts
Cron on hosted (all active): hr-holiday-sync, hr-pay-periods-topup, hr-retention-purge, notification-delivery-worker (every minute), portal-document-extraction-worker, public-assistant-index-worker, signing-notifications.
15-minute recovery task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m`: DISABLED 2026-11-12 (pre-release mode, see Safety); its manifest hosted-refreshed.json lacks every hosted version after 20261113320000 (incl. sixteen 20261112* versions from other sessions) and must gain them before it is re-enabled.
Owner-only items: copy the Vault secret `hr_bank_details_key` somewhere safe; Turnstile error 400020 on the live staff form (hostname not in the site key); the Auth Invite template (needs a token); hosted staff have no logins until an admin sends sign-in links; staff must add real intakes per course (until then the form offers the next twelve months). NOT RUN live: admin-authenticated smoke tests (template save / preview / sign, intakes screen, offer email), live Postmark, live Azure. https://slit.edu.au is a separate site (not this frontend).
