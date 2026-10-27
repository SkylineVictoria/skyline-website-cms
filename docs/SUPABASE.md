# Supabase: Edge Functions, migrations, env, hosted release gate

Only project **xcpydisstlvtvcsqnjob** (Skyline Web, ap-southeast-2, PostgreSQL 17, DB system ID **7692130048193495360**) is approved. The Submissions project `qoylrmorezlqdvufonmx` is out of scope: never query or touch it. Everything hosted below needs explicit, release-specific owner approval.

## Edge Functions (`supabase/functions/`)

| Function | verify_jwt | Auth model | Hosted version |
|---|---|---|---|
| cms-admin-users | true | CMS admin JWT | 7 |
| portal-admin-users | true | org admin or agency admin JWT; rules enforced by migration 86 functions (agency admin: own agency only) | 7 |
| portal-document-delete | true | caller JWT + RLS, validated application-owned path | 7 |
| portal-document-extract | false | worker secret / user enqueue; leased, fenced | 12 |
| public-assistant-index | false | worker secret | 5 |
| public-assistant | false | public, rate-limited | 8 |
| notification-delivery | true (+ in-function check: service-role key only; 401 no token, 403 anon/user token; `/webhook` returns 410, disabled) | service-role key as Bearer token (no worker secret) | not deployed |

`supabase/config.toml` sets `verify_jwt=false` only for the three public/worker functions (notification-delivery now uses verify_jwt=true plus a service-role check; its webhook is disabled); never disable JWT as an auth workaround. Shared code: `_shared/config.ts`, `_shared/document-extraction/` (contract, openai, azure, select, test-only mock), `_shared/notification/delivery.ts` (Postmark adapter, test-only mock, selection, webhook check, dispatcher). Locked imports via `deno.lock`.

Local source is ahead of hosted for **portal-document-extract** (provider seam P05-01, Azure adapter P05-02): undeployed, hosted stays v12 until a release is approved.

## Env and secret names (never values; never print .env)

Supabase secrets are project-wide; the prefix gives no function isolation. Existing names are compatibility contracts. New integration vars use `EF_<SERVICE>_<SETTING>`. Local values live in ignored `supabase/functions/.env`; `.env.example` is placeholder-only.

| Name | Used by | Notes |
|---|---|---|
| SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY | all six (service role: secret) | managed |
| SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY | user-facing handlers | managed; anon or publishable required |
| DOCUMENT_EXTRACTION_WORKER_SECRET | portal-document-extract | secret; absent = worker never claims |
| OPENAI_API_KEY | extract, assistant, index | secret; absent = deterministic/FAQ only |
| OPENAI_DOCUMENT_MODEL | portal-document-extract | required for extraction |
| OPENAI_BASE_URL | assistant, index | optional; test adapter only |
| EF_DOCUMENT_EXTRACTION_PROVIDER | portal-document-extract | unset/`openai` = OpenAI, `azure` = Azure adapter |
| EF_AZURE_DOCUMENT_ENDPOINT, EF_AZURE_DOCUMENT_API_KEY (secret), EF_AZURE_DOCUMENT_MODEL | portal-document-extract | all required when provider=azure; incomplete = typed unavailable, manual entry continues |
| EF_AZURE_DOCUMENT_MODEL_MAP, EF_AZURE_DOCUMENT_API_VERSION | portal-document-extract | optional (API version default 2024-11-30) |
| PUBLIC_ASSISTANT_WORKER_SECRET | public-assistant-index | secret |
| PUBLIC_ASSISTANT_EMBEDDING_MODEL, _EMBEDDING_DIMENSIONS (1536) | assistant, index | keep query/index compatible |
| PUBLIC_ASSISTANT_GENERATION_MODEL, _ENABLE_GENERATION | public-assistant | generation off unless literal `true` |
| PUBLIC_ASSISTANT_CHUNK_TOKENS (420), _CHUNK_OVERLAP (60), _MAX_CHUNKS (512), _MAX_CONTENT_CHARS, _DOCUMENT_MAX_BYTES, _DOCUMENT_MAX_PAGES, _DOCUMENT_EXTRACTION_MODEL | public-assistant-index | optional tuning; invalid value fails closed |
| EF_NOTIFICATION_EMAIL_ENABLED | notification-delivery | sending on only when exactly `true`; default off |
| EF_POSTMARK_SERVER_TOKEN (secret) | notification-delivery | required with the enable flag; absent = nothing is claimed |
Notification email needs only EF_NOTIFICATION_EMAIL_ENABLED and EF_POSTMARK_SERVER_TOKEN. Sender address/name come from the database (migration 87); the scheduler/pg_cron job must call the function with `Authorization: Bearer <service-role key>` read from Supabase Vault at run time (never stored in the repo); unused secrets to delete in Supabase: EF_NOTIFICATION_WORKER_SECRET, EF_POSTMARK_FROM_EMAIL, EF_POSTMARK_FROM_NAME, EF_POSTMARK_WEBHOOK_USER, EF_POSTMARK_WEBHOOK_PASSWORD. Later, for the other workers only: DOCUMENT_EXTRACTION_WORKER_SECRET and PUBLIC_ASSISTANT_WORKER_SECRET are still used by their pg_net schedulers (`x-worker-secret` from Vault) and would need the same Bearer service-role change on both sides; unchanged here.
| Planned: EF_STRIPE_SECRET_KEY, EF_STRIPE_WEBHOOK_SECRET (P10) | none yet | not consumed |

## Migrations (`supabase/migrations/`)

- 83 files: `0001`-`0003` legacy, then timestamp-ordered `2026...`. Hosted has the first 72, 0 pending. Local only, unapplied: `20261026130000_document_job_provider_operations.sql` (P05-03), `20261026140000_tenant_administration_commands.sql` (P06-01: `tenant_admin_overview`, `tenant_update_details`, `tenant_grant_membership`, `tenant_claim_domain`, `tenant_verify_domain`, `tenant_revoke_domain`), `20261026150000_tenant_versioned_configuration.sql` (P06-02: `tenant_config_versions`, `tenant_config_save_draft/publish/restore/overview/effective`, `enrollment_applications.workflow_version_id`) and `20261026160000_enforce_pinned_workflow_and_role_configuration.sql` (P06-04: redefines `tenant_has_role` and `portal_set_application_status`; adds `tenant_role_permission`, `tenant_roles_permission`, `portal_legacy_transition_allowed`, `portal_pinned_transition_allowed`). and `20261026170000_tenant_lifecycle_and_invitations.sql` (P06-03: `tenant_member_invites`, `tenant_accept_pending_invites`, `tenant_set_status`, `tenant_onboard`, `tenant_platform_overview`, `tenant_platform_audit`; redefines `tenant_grant_membership` (now records an invitation) and `tenant_admin_overview`). and `20261026180000_transactional_notification_outbox.sql` (P07-01: `notification_deliveries`, `notification_preferences`, `portal_set_notification_preference`, enqueue trigger on `admission_event_outbox`, config kind `notifications`; redefines `tenant_config_defaults/validate/overview/effective`). and `20261026190000_notification_delivery_lifecycle.sql` (P07-02: `notification_claim_delivery`, `notification_record_attempt`, `notification_apply_provider_event`, `notification_delivery_attempts`, `notification_provider_events`; service_role only; fixes `notification_render`). and `20261026200000_notification_recovery_and_activation.sql` (P07-03: `notification_activation`, `tenant_notification_senders`, `notification_set_activation`, `tenant_set_notification_sender`, `tenant_notification_overview`, `tenant_notification_resolve`, `notification_recover_stuck`; redefines `notification_claim_delivery` and `notification_enqueue_deliveries`). and `20261026210000_manual_registration_model.sql` (P08-01: `enrollment_registrations`, `enrollment_registration_evidence`, `enrollment_registration_history`, `portal_registration_create/add_evidence/transition`; reviewers only, append-only history). and `20261026220000_registration_workbench_reads_and_export.sql` (P08-02: `portal_registration_workbench/detail/export`; audit entries added to the P08-01 commands). and `20261026230000_registration_reconciliation.sql` (P08-03: `portal_registration_exceptions`, `portal_registration_review_exception`, `portal_registration_correct_coe`, append-only `enrollment_registration_reviews` and `enrollment_registration_corrections`). Sending needs both `EF_NOTIFICATION_EMAIL_ENABLED=true` and a recorded platform activation for the institution. Browser roles get execute; authority is re-checked inside.
- Migration 86 (local only, unapplied): `20261027000000_agency_invitations_and_scoped_user_admin.sql` adds `agency_invitations` and the `portal_invitation_*`, `portal_member_update`, `portal_agency_create_with_admin`, `portal_resolve_access` functions; deploy it before the updated portal-admin-users and frontend.
- Migration 87 (local only, unapplied): `20261027010000_notification_sender_from_database.sql` adds `notification_sender_domains` / `notification_sender_settings`, resolves the sender per organization at claim time (`notification_resolve_sender`, legacy default it@slit.edu.au), and adds `notification_save_sender` / `notification_set_sender_domain` / `notification_sender_state`; run after 86. Verify the sender domain in Postmark first.
- Migration 88 (local only, unapplied): `20261027020000_schedule_notification_delivery_worker.sql` schedules cron `notification-delivery-worker` (every minute) via `notification_dispatch_worker()`, which sends `Bearer` + Vault secret `notification_service_role_key` (store once with `vault.create_secret`, see the file header); pause with `cron.alter_job(jobid, active := false)`, stop with `cron.unschedule('notification-delivery-worker')`; run after 87.
- Migration 89 (local only, unapplied): `20261027030000_invitation_input_validation.sql` redefines `portal_invitation_create` with name (2-100, no control chars) and email (trimmed, lower-cased, max 254) rules; cms-admin-users now rejects unknown roles (400) and both account functions share `_shared/user-input.ts`; run after 88.
- Migration 90 (local, unapplied): `20261027040000_notification_worker_inactive_until_activated.sql` sets the notification-delivery-worker job inactive (88 is already on hosted); activate with `cron.alter_job(jobid, active := true)` together with approving sending, the Vault key and the function deploy.
- Migration 91 (local only, unapplied; run after 90): `20261027050000_admissions_status_model_revision.sql` replaces the default workflow graph (tenant_config_defaults), `portal_legacy_transition_allowed`, `portal_submit_v2` (drafts only) and `notification_enqueue_deliveries` (status labels via new `portal_status_label`); stored statuses unchanged.
- Migration 92 (local only, unapplied; run after 91): `20261027060000_notification_event_recipients.sql` adds events offer_accepted / coe_voe_issued, per-event recipient settings (`notifications` config key `events`; legacy scope table `notification_legacy_event_settings`), nullable `notification_deliveries.recipient_user` for non-user recipients, and the functions `notification_event_settings_state` / `notification_save_legacy_event`.
- Migration 93 (local only, unapplied; run after 92): `20261027070000_submission_pdf_attachment.sql` adds `notification_attachment_settings` (attach vs secure link, default attach) and `notification_delivery_submission` (service role, lease-checked snapshot read); redeploy `notification-delivery` with it (PDF builder in `_shared/notification/submission-pdf.ts`).
- Migration 94 (local only, unapplied; run after 93): `20261027080000_coe_voe_issue_flow.sql` relaxes registration verification to offer_accepted+, adds `enrollment_coe_documents` (private, no browser grants) with `portal_coe_document_upload/list/content` and `portal_coe_voe_issue`, `notification_delivery_coe_document` (worker) and `notification_invalid_recipients`, and makes the enqueue trigger record invalid_recipient suppressed deliveries; redeploy `notification-delivery` with it.
- Additive only. Never edit, rename or reorder an applied file; fix forward with a new timestamped file.
- No `db reset`, no blanket `db push`, no history repair. Hosted history had out-of-band drift; apply reviewed wrappers per file.
- Test on a disposable local DB first (clean replay + upgrade from previous schema, RLS/grants/RPC, compensation). SQL tests live in `supabase/tests/`.
- Unknown legacy ownership stays unresolved; never backfill a default tenant.

## Hosted release gate (all steps need explicit approval; stop on any drift)

1. Verify identity: authenticated CLI metadata AND DB `system_identifier = 7692130048193495360` (not just env names or CLI link). Compare hosted migration history with local files.
2. Take a fresh verified encrypted checkpoint (`scripts/release-close/collect-production-checkpoint.mjs`, needs `--approved-recovery-export`).
3. Build a new reviewed manifest: ordered migration files + Edge source hashes + frontend fingerprint + exact commands. Show it to the owner.
4. If writers/workers are affected: install temporary writer guards, hold cron/dispatch and new claims, wait 460 s drain (no running cron, leases or pending pg_net), freeze, fresh checkpoint.
5. Apply migrations in timestamp order with `supabase db query --project-ref xcpydisstlvtvcsqnjob --linked --file <guarded wrapper>`.
6. Deploy only the named functions: `supabase functions deploy <name> --project-ref xcpydisstlvtvcsqnjob` (JWT per table above).
7. Read-only hosted checks, synthetic canaries, public-route smoke at http://localhost:3001; verify versions, JWT, cron state.
8. Remove guards, resume original cron/dispatch, confirm empty queues, clean synthetic data. Record result in COMPLETED.md.

Original cron: extraction worker `*/5 * * * *`, public indexing `*/15 * * * *`.

## Azure live acceptance (P05-04; NOT RUN)

- Needs explicit owner approval per run, plus the hosted gate above (migration `20261026130000` applied, function deployed). Never in CI or with real student documents.
- Secrets to set (names only): `EF_DOCUMENT_EXTRACTION_PROVIDER=azure`, `EF_AZURE_DOCUMENT_ENDPOINT`, `EF_AZURE_DOCUMENT_API_KEY`, `EF_AZURE_DOCUMENT_MODEL`; `EF_AZURE_DOCUMENT_MODEL_MAP` for English Test, Visa and Academic (custom models). Without a map those categories stay manual.
- Fixtures: synthetic only, one per mapped category (Passport, Driving Licence first; then any mapped custom-model category) plus one wrong-category file.
- Result format, one JSON object per fixture and field: `{category, field, expected, extracted, outcome, confidence?}`. `outcome` is `match`, `mismatch`, `missing` or `unexpected`.
- Record per category: pages, latency, outcome counts. Accuracy is the plain match count over expected fields. Never extrapolate or report cost without Azure's billed pages.
- Pass criteria: wrong category populates nothing; manual values untouched; the operation receipt is empty after each terminal state; one POST per document on retry.
- Mock-only readiness: native lab `--azure` run, 4/0. Live result stays NOT RUN until approved and executed.

## Rollback notes

- DB: forward compensation (new additive migration); never remove RLS to roll back; production restore needs separate approval (checkpoints in C:\Users\goura\Skyline-Recovery, see COMPLETED.md for conditions).
- Edge: redeploy the previous source version of the function; JWT settings stay as in the table.
- Scheduler: restoring `* * * * *` schedules is done by the reviewed alter_job statements for `portal-document-extraction-worker` and `public-assistant-index-worker`; do not drop the event-dispatch helpers.
- Local DB-backed lab: disposable network:none Docker containers only; never point tests at hosted data.
