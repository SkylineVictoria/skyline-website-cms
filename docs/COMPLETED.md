# Completed log (newest first)

## 2026-10-26 - Repo cleanup
docs/ cut to TASKS, COMPLETED, SUPABASE, ARCHITECTURE; evidence trees, phase docs and one-off scripts deleted (zip backup outside repo). Kept: product tests, native lab chain, backup-task scripts. Not committed.

## 2026-10-26 - P08-03 DONE (local)
Migration `20261026230000_registration_reconciliation.sql`: computed exceptions (enrolled without verified registration, stale lodgement, verified on a closed application, possible duplicate by name + date of birth), append-only reviews (accept/reopen with note) and CoE corrections (old/new value, reason, actor), history and audit entries; Exceptions tab on `/agency/registrations`. Nothing is overwritten or deleted. Undeployed; no browser run.

## 2026-10-26 - P08-02 DONE (local)
Migration `20261026220000_registration_workbench_reads_and_export.sql` (workbench list with warning flag, detail, minimized export with fixed columns for named applications only, audit entries for create/transition/export) and page `/agency/registrations` (reviewers only; helpers in `lib/registrationWorkbench.ts`: CoE validation, checklist, blockers, formula-safe CSV). `coe_issued`/`enrolled` without a verified registration is a warning, not a block (owner decision). Undeployed; no browser run.

## 2026-10-26 - P08-01 DONE (local)
Migration `20261026210000_manual_registration_model.sql`: manual external registration per application (draft/lodged/verified/cancelled; CoE number, evidence and unique active registration enforced), append-only evidence and history, commands `portal_registration_create/add_evidence/transition` for admissions reviewers only. Verification needs the application to read `coe_issued`/`enrolled` but never changes it, and vice versa. No automated government interaction; no UI (P08-02). Undeployed.

## 2026-10-26 - P07-03 DONE (local)
Migration `20261026200000_notification_recovery_and_activation.sql`: recovery sweep (`unknown`, never auto-resent; `tenant_notification_resolve` retry/close with audited reason), sender ownership (`tenant_notification_senders` or verified hostname, checked at creation and claim), platform activation gate (`notification_activation`; nothing is claimed until approved), `tenant_notification_overview` (masked recipients, no message text). UI: "Email deliveries" tab; email preferences on the agency Notifications page. Undeployed; live Postmark NOT RUN.

## 2026-10-26 - P07-02 DONE (local)
New Edge Function `notification-delivery` (worker + `/webhook`), `_shared/notification/delivery.ts` (Postmark adapter, mock, selection, Basic-auth webhook check, dispatcher) and migration `20261026190000_notification_delivery_lifecycle.sql` (leased claim, 3 bounded attempts, timeouts/crashes become `unknown` and are never resent, forward-only deduplicated callbacks, single-pass template rendering). Sending is off unless `EF_NOTIFICATION_EMAIL_ENABLED` is exactly `true`. Live Postmark NOT RUN; `config.toml` entry added (`verify_jwt = false`; worker route needs the secret, `/webhook` needs Basic credentials, both fail closed).

## 2026-10-26 - P07-01 DONE (local)
Migration `20261026180000_transactional_notification_outbox.sql`: `admission_event_outbox` rows expand in the same transaction into per-recipient `notification_deliveries` (recipients = inbox recipients; rendered subject/body, sender and template version snapshotted; opted-out recipients get a suppressed row); new config kind `notifications` (plain-text templates, fixed placeholders, sender, per-event on/off); `portal_set_notification_preference`. Nothing is sent (P07-02). Undeployed.

## 2026-10-26 - P06-03 DONE (local)
Migration `20261026170000_tenant_lifecycle_and_invitations.sql`: add-member-by-email records an invitation with the same response whether or not an account exists (claimed at sign-in by a confirmed matching email); `tenant_onboard`, platform-only `tenant_set_status` (non-destructive suspend/reactivate), `tenant_platform_overview/audit`; UI Platform tab. Suspension, revocation, shared-identity and audit cases in the SQL matrix. Undeployed.

## 2026-10-26 - P06-04 DONE (local)
Migration `20261026160000_enforce_pinned_workflow_and_role_configuration.sql`: published roles config now drives every `tenant_has_role` policy check (default = hard-coded sets, tenant_admin never locked out); `portal_set_application_status` follows the pinned workflow version (draft never leaves via the reviewer command; role-limited transitions; legacy unpinned apps unchanged). UI "not yet applied" notice removed. Undeployed.

## 2026-10-26 - P06-02 DONE (local)
Migration `20261026150000_tenant_versioned_configuration.sql`: per-tenant workflow/roles/integration/branding config with schema validation, one draft + immutable published versions, restore-as-draft, audit, safe defaults, secret-name-only integration config; new applications pin the published workflow version. Admin UI tab "Configuration". Stored workflow/roles are NOT yet enforced by RLS or `portal_set_application_status`.

## 2026-10-26 - P06-01 DONE (local)
Migration `20261026140000_tenant_administration_commands.sql`: tenant-admin-scoped overview, rename, member-by-email, domain claim/revoke; platform-only domain verify and agency links; all audited. UI `/admin/institution` (tenant hosts, admins only). 36 pgTAP matrix cases PASS in the lab DB; not deployed.

## 2026-10-26 - P05-04 mock-only readiness (live NOT RUN)
Native lab gateway has a fake Azure (202/poll/success/429/failed/hold) and a second Azure-configured extract instance; `native-extraction.mjs --azure`: Azure path 4/0 (receipt stored, reused after lease takeover with one POST, dropped on success), OpenAI path 10/0. Live Azure acceptance runbook in SUPABASE.md.

## 2026-10-26 - P05-03 DONE (local)
Leased jobs persist/reuse/clear the Azure operation id via `enrollment_document_extraction_operations` (worker-only, lease-fenced RPC, cleared by trigger on terminal state); orchestration moved to `_shared/document-extraction/run.ts`. Not deployed; migration applied only to the local lab DB. Native lab has no Azure mock (OpenAI path 10/0 before and after).

## 2026-10-26 - P05-02 DONE (local)
Azure adapter `_shared/document-extraction/azure.ts` (REST 2024-11-30, async poll, bounded timeouts, same-origin Operation-Location only) and provider selection via `EF_DOCUMENT_EXTRACTION_PROVIDER` (default openai). 22 Azure + 17 + 9 + 3 cases, Deno check, tsc PASS. Undeployed; live Azure NOT RUN; worker does not yet persist operation ids (P05-03).

## 2026-10-26 - P05-01 DONE (local)
Provider interface, OpenAI adapter behind it, test-only deterministic mock. 17 contract + 9 helper + 3 passport + 20 mock-handler + 4 portal cases, native lab 10 PASS / 0 FAIL before and after. No migration; hosted portal-document-extract stays v12.

## 2026-10-26 - Phase reorder (ADR-012)
Order is now 5 Azure, 6 RTO administration, 7 Postmark, 8 PRISMS, 9 multi-tenant RAG, 10 Stripe, 11 hardening. P06-01 deps re-derived to P03-05 and P04-05.

## 2026-10-26 - Phase 1-4 hosted release VERIFIED (do not rerun)
Project xcpydisstlvtvcsqnjob (system ID 7692130048193495360), manifest SHA256 d32c862a...a1378d81. 44 migrations applied: 72 hosted, 0 pending. Completed 04:39 UTC.
Functions (all ACTIVE): cms-admin-users v7 JWT true; portal-admin-users v7 JWT true; portal-document-delete v7 JWT true; portal-document-extract v12 JWT false; public-assistant-index v5 JWT false; public-assistant v8 JWT false.
Acceptance: 10 hosted read-only checks, 16 synthetic canaries, 4 public routes PASS; 83 tables / 1140 original rows unchanged. Verified at http://localhost:3001 (TenderFlow stays on 3000). Writers open, both original cron jobs restored, 3 failed extraction jobs retained without retry.
Frontend artifact SHA256 509d8752...cdf3d unchanged. Frontend hosting for https://slit.edu.au is UNVERIFIED and separately gated; no frontend/DNS deploy happened.

## 2026-10-26 - Backup and recovery
Windows task `Skyline-xcpydisstlvtvcsqnjob-Recovery-15m` (every 15 min, keeps last 48 successful, IgnoreNew, 12 min stop) runs scripts/release-close/scheduled-checkpoint.ps1: encrypted AES-256-GCM checkpoint to C:\Users\goura\Skyline-Recovery, DPAPI keys in C:\Users\goura\.skyline-recovery-keys, journal in docs/release-evidence/close-20261026/. Do not move or delete these paths.
Latest verified checkpoint 73e15717...ed847 (99 tables, 2 private objects, 802087 bytes). Isolated restore + 44-migration + Auth/CMS rehearsal 68.8 s.
RTO 4 h / RPO 1 h hold only with the original project and a healthy Windows user session, network, CLI and DPAPI profile. Not a hosted SLA; daily hosted backups alone do not meet 1 h RPO; no PITR; account/machine-loss recovery unproven.

## 2026-10-25 - Phases 1-4 DONE locally
Phase 2 foundation (tenant registry, authorization boundary, SEC-18 fencing, 56-file clean replay), Phase 3 CMS/branding (98 checks), Phase 4 agency portal (109 checks, 320 SQL assertions).

## Known lint debt
`npm run lint` has pre-existing errors: no-explicit-any in public-assistant, no-control-regex at supabase/functions/portal-document-extract/index.ts:81.

## Open blockers
- P05-04 (live Azure) needs owner approval and a hosted release.
- Any hosted migration, Edge deploy, secret/cron/DNS change or live provider call needs explicit release-specific approval.
- Frontend hosting for slit.edu.au UNVERIFIED.

CMS fix 1 (footer): the preview was a copy using the built-in links, not the editor's links; it now renders the shared SiteFooterView (also used by the public footer) from the unsaved form, with 8 links/column and 30-character limits and empty columns hidden.
CMS fix 2 (menu): `cms_pages.in_nav` was saved but never read and menu items were free text; pages now go in via a published-page picker or the page's "Show in main menu" switch (7 top-level, 6 per dropdown, 22 characters, enforced in the editor and on save), and the header collapses extras into "More".
CMS fix 3 (drafts): editors kept form state in page-local useState, re-synced on every store change, and the store refetched on every auth token refresh; they now use the shared useDraft hook (sessionStorage mirror, dirty-aware, leave warnings) and the store only refetches on a real account change.
CMS fix 4 (banner): the permanent "Connected to your database" banner is replaced by a status dot; only offline and failed-save problems show a dismissible banner with retry.
CMS fix 5 (theme): the loader fell back to indigo and ignored unset themes; Website Settings has a Theme section (primary and accent colour with contrast check, loader style, reset), --brand-primary/--brand-accent variables, and the cached loader brand refreshes on every settings save. Needs migration 85 (`20261026250000_cms_theme_accent_and_loader.sql`) for accent and loader style; not assumed applied.
CMS fix 6 (conflicts): preview/refetch conflicts fixed with the shared pieces above; modal editors (pages, SEO, documents, users), the configuration panel and a header preview are not covered yet.
CMS follow-up 1 (drafts everywhere): Pages, SEO, Documents, Users, Assistant Knowledge and Document Extraction corrections (now a dialog instead of two prompts) use the shared useSlotDraft/useDraft hooks (restore, Discard, Unsaved changes, resume list, no refetch overwrite); the Courses list has no unsaved form state (creating a course writes a draft immediately), so nothing to draft there.
CMS follow-up 2 (leave warning): the app now runs on a data router (createBrowserRouter) so useBlocker guards link clicks, browser Back/Forward and navigate() calls while any editor is dirty; beforeunload still covers closing the tab.
CMS follow-up 3 (header preview): SiteHeaderView is the one header renderer (public and preview); Header & Navigation shows it live from unsaved edits with a window-width selector so the "More" overflow can be seen.
CMS follow-up 4 (footer logo): the public footer uses the Website Settings logo (tenants never fall back); the legacy slit.edu.au images only apply when no logo is configured, and the editor preview follows the same rule.

Agency invitations (migration 86): agency admins invite/manage agents in their own agency only via portal-admin-users + DB functions; org admin creates an agency with its first admin atomically; invitations are accepted at first sign-in; single /agency/login resolves role from the database. Local only, unapplied.
Notification sender from DB (migration 87): per-organization sender (name from tenants.name, legacy it@slit.edu.au) with verified-domain list, worker authenticated by service-role key, webhook disabled; only EF_NOTIFICATION_EMAIL_ENABLED and EF_POSTMARK_SERVER_TOKEN remain. Local only, unapplied.
Notification scheduler (migration 88): pg_cron job calls notification-delivery every minute with the service-role key from Vault; skips overlap and no-work runs. Local only, unapplied.
Single sign-in (/login): CMS, org admin, agency admin and agent share one page that routes by database-resolved access (chooser when several); /admin/login and /agency/login redirect to it; "Back to site" link; header shows Sign In/Dashboard, Agency Portal button removed. No migration.
User dialogs: team/users pages use accessible Add/Edit and Deactivate dialogs with inline validation (userValidation.ts, Dialog.tsx, UserDialog.tsx); no API or migration changes.
Users list shows roles (PostgREST one-object embed fix); account input rules hardened in cms-admin-users and portal-admin-users (migration 89). Local only, unapplied.
Notification worker cron job inactive until activated (migration 90, 88 untouched as it is on hosted). Local only, unapplied.
P08-04 status model (migration 91, local only): new default graph, legacy statuses forward-only, agents read-only after submission, "CoE / VoE issued" label; parity tests updated deliberately.
P08-05 notification recipients (migration 92, local only): per-event internal/agent/agency-admin/student recipients, non-user deliveries, new offer_accepted and coe_voe_issued events, admin UI.
P08-06 submission PDF (migration 93, local only; notification-delivery needs redeploy): in-memory PDF of the submitted version attached to the submitted email, or a sign-in link per institution.
P08-07 CoE/VoE issue flow (migration 94, local only; notification-delivery needs redeploy): upload + Approve and issue emails the PDF; verification from offer_accepted; invalid_recipient deliveries are visible.
P05-05 per-category provider routing (no migration, local only; portal-document-extract needs redeploy): optional EF_DOCUMENT_EXTRACTION_ROUTES in select.ts; Azure routed to an unmapped category is configuration_invalid naming it, no silent fallback. 4 new cases in test-azure-provider (60 PASS), all offline test:* PASS, SQL suites NOT RUN (Docker down).
P05-05 fix (local, undeployed): Azure Driving Licence address now maps when no country is printed (AU state + 4-digit postcode, or AUS/AU/Australia), unit numbers, state names and au_country; licence/card number, class and expiry have no application field and stay unmapped. 4 new Australian-licence cases (test-azure-provider 64 PASS).
Wizard address + review (local, undeployed; portal-document-extract needs redeploy): non-Australian licence addresses map to ov_* fields (country inferred only for US state + ZIP, else warning), radio set from the address; review panel shows only read values and one selected address section behind "Add more details"; Confirm values advances the wizard. Tests added in test-azure-provider (67 PASS) and test-document-provider (19 PASS).
Wizard simplification (frontend only, local, undeployed; no edge function or migration changed): five upload-only steps with an immediate upload→reading→done loader; Details/Review steps and emergency contact removed; Finish opens the full form, where fields filled from documents carry a 'From document' badge.
Wizard replace + qualifications (migration 95, local only): an unedited value from a replaced/deleted file is re-applied from the new file (edited values stay conflicts); every Academic document appends a deduplicated qualification to data.academicQualifications, shown in the form, and deleting a file removes only its entries. SQL cases added to document_extraction_integration.sql (NOT RUN, Docker down).
Submission and PDF now include data.academicQualifications (list plus single-field fallback, deduplicated; PDF needs notification-delivery redeploy with migration 95); SQL suite document_extraction_integration 25/25 PASS locally (migration 95 null-handling fix).
Expiry warnings for passport, visa and English results (shared documentExpiry helper; wizard, full form, review; informational only; frontend only, no extraction/migration change).
Agent email fix (detail page used the signed-in user's email, now the assigned agent's) and homepage courses carousel (scroll-snap, up to 20 courses, CMS auto-slide settings; migration 96 local only: cms_settings.courses_carousel_* columns plus an administrator-only guard trigger).
Form inputs: Year Completed dropdown, USI (format-only validation; check character not verified) and phone (country code + E.164) controls, shared identifiers helper reused in review and PDF; frontend/PDF only (notification-delivery redeploy picks up the PDF formatting), no migration.
Persistent sign-in: one shared client (localStorage, auto-refresh), restore treats only 'no session' or a rejected refresh token as signed out, offline refresh failures keep the user signed in and retry, explicit Log out uses scope local; frontend only.
Homepage: featured cap raised 6 to 20 (UI-only limit, tooltip on disabled toggles); carousel gets a Continuous drift mode (new default, rAF transform marquee, Slow/Medium/Fast in px/s) with CMS motion setting; migration 97 local only (courses_carousel_motion, courses_carousel_drift_speed, admin-only guard extended).
CMS: Document Extraction page removed (old URL redirects to the dashboard); Applications now inside the CMS for Admins (shared agency pages, /admin/applications, PDF download, document view audit; admin links redirect there); notification recipient cap 10 to 20 (migration 98, local only); other requested notification features not built, see report.
Admin downloads: audit logging moved to portal_log_admin_access (the audit log rejects client inserts, so the earlier logging never wrote); download/preview open their tab before the awaits; migration 99 local only; end-to-end signed-URL download verified locally for Admin (Editor refused).
Agencies in the CMS (Admin only): list with counts, Add agency, detail tabs Details/Agents/Applications queried by agency id, deactivate with confirm; /agency/agencies redirects admins there; migration 100 local only (portal_log_agency_change audit function); isolation cases added to phase4_authorization_positive.
Migrations 97-100 applied to hosted 2026-10-28 (carousel motion/speed columns and guard, recipient cap 20, portal_log_admin_access, portal_log_agency_change); rollback-only post-checks 15/15 PASS; no Edge Function redeployed.
Admin notification visibility: Notification log page and per-application Notifications tab (admin only), per-event 'Will go to' preview and gate banner; migration 101 local only (notification_log_query, notification_gate_state). Offer-letter attachment not built: no offer letter is stored on applications today.
notification-delivery worker auth now checks the JWT role (service_role) and project ref instead of comparing to SUPABASE_SERVICE_ROLE_KEY; relies on verify_jwt = true; local only, not deployed.
