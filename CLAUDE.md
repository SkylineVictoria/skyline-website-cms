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
- After any hosted migration push, append the new migrations to the backup manifest before the next checkpoint run, or backups stop.
- Migrations are additive and timestamp-ordered. Unknown ownership is never assigned to a default tenant; client tenant IDs are not authorization.
- Keep SEC-18 lease/source fencing and cancellation. JWT stays on; never disable it as an auth workaround.
- Dev server: `vite --port 3001`. Port 3000 belongs to TenderFlow; never disturb it.
- Never print or commit `.env` or CLI secret files. New env vars are named `EF_<SERVICE>_<SETTING>`; `.env.example` stays placeholder-only.
- Backup task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m` runs `scripts/release-close/*` and writes to `docs/release-evidence/close-20261026/`, `C:\Users\goura\Skyline-Recovery` and `C:\Users\goura\.skyline-recovery-keys`. Do not move, edit or delete those.

## Map
- `src/` frontend; `supabase/functions/` seven Edge Functions (all deployed) + `_shared/`; `supabase/migrations/` 91 files; `supabase/tests/` SQL tests; `ocr-service/` local PaddleOCR, not wired to the app.
- `scripts/test-*.{ts,mjs}` product-logic tests (npm `test:*`); `scripts/lab/` native lab (start `node scripts/lab/server.mjs --p04-complete`, needs Docker; run `scripts/lab/native-extraction.mjs`, add `--azure` / `--notify` for the Azure / notification paths); `scripts/release-close/` backup task only.
- npm: `type-check`, `lint` (covers `src/` only), `build`, `test:*`; `*:integration` and `test:public-assistant:local-acceptance` need local Supabase.

## Current position
Phases 1-4 DONE and hosted-VERIFIED. Phases 5 (P05-01..03), 6, 7 and 8 are DONE and released as migrations 73-90 (hosted verification not recorded); 91 (status model) is local only. P05-04 BLOCKED on live Azure approval.
Next eligible: P09-01 (Phase 8b is done; P08-08 is BLOCKED on PRISMS API access). Highest local migration: 94 (91-94 local only, plus a notification-delivery redeploy for the PDF and CoE/VoE attachments; hold until the new frontend release); hosted at 90 as last verified 2026-10-27 (91 pending).
Hosted Edge Functions: all seven deployed (portal-document-extract v15; notification-delivery with JWT on, matching config.toml; cms-admin-users v11 and portal-admin-users v12, both JWT on, redeployed 2026-10-27 08:52Z).
The notification-delivery-worker cron job exists hosted (migration 88) and is inactive since migration 90 (inferred from the applied list, not queried); nothing sends email until the owner approves a sender and sets the Postmark secrets and Vault key. Supabase Auth uses custom SMTP via Postmark (no-reply@slit.edu.au).
Live Postmark NOT RUN. Live Azure NOT RUN. Frontend hosting for https://slit.edu.au is UNVERIFIED and separately gated.
