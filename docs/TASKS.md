# Tasks

Status values: TODO, IN_PROGRESS, BLOCKED, DONE (DONE needs verified acceptance). The per-task `status:` line is authoritative; the table is derived.
Hosted release is tracked separately: Phases 1-4 hosted-VERIFIED (2026-10-26); Phase 5+ hosted PENDING. DONE for Phase 5+ means local/mock-only.

Phase order (ADR-012, 2026-10-26): 5 Azure, 6 RTO administration, 7 Postmark, 8 PRISMS, 9 multi-tenant RAG chatbot, 10 Stripe, 11 hardening.

| Phase | Tasks | DONE | Open | Hosted |
|---|---:|---:|---:|---|
| 1 Existing system audit | 4 | 4 | 0 | VERIFIED |
| 2 Multi-tenant DB and security foundation | 10 | 10 | 0 | VERIFIED |
| 3 Tenant-driven website, branding, CMS | 5 | 5 | 0 | VERIFIED |
| 4 Agency portal and admission isolation | 5 | 5 | 0 | VERIFIED |
| 5 Azure AI Document Intelligence | 4 | 3 | 1 | PENDING |
| 6 RTO and company administration | 4 | 4 | 0 | PENDING |
| 7 Postmark email and notifications | 3 | 3 | 0 | PENDING |
| 8 PRISMS registration (manual) | 3 | 3 | 0 | PENDING |
| 8b Admissions workflow revision | 5 | 4 | 1 | PENDING |
| 9 Multi-tenant RAG chatbot | 5 | 0 | 5 | PENDING |
| 10 Stripe subscriptions and billing | 3 | 0 | 3 | PENDING |
| 11 Performance, security, observability, deploy | 4 | 0 | 4 | PENDING |
| **Total** | **55** | **41** | **14** | |

**Next eligible: P09-01** (Phase 8b is complete except P08-08, BLOCKED on PRISMS API access). P05-04 live run needs explicit owner approval and a hosted release.

## Phases 1-4 (DONE)

- P01-01 Inventory existing architecture. DONE. Source/migration/route inventory; live unknowns separated.
- P01-02 Truthful preservation baseline. DONE. Safe checks run; no compile-only claims.
- P01-03 Security and tenancy evolution design. DONE. Risks (SEC-xx) prioritised; additive ownership strategy.
- P01-04 Persistent plan and handoff. DONE. Task graph and docs published (since replaced by this file).
- P02-01 Reconcile project, isolated baseline. DONE. Project identity verified read-only; 30-file clean replay; egress-isolated DB.
- P02-02 Regression and access fixture baseline. DONE. Native Auth/Storage/Edge/browser baselines; SEC-18 race fixed.
- P02-03 Correct authorization boundaries. DONE. 9 captured auth failures fixed; RLS/Storage policy cases pass.
- P02-04 Privileged document targets and worker ownership. DONE. Poisoned targets denied; lease fencing and cancellation.
- P02-05 Tenant registry and relationships. DONE. tenants/domains/memberships/agency_tenants; unknown host fails closed.
- P02-06 Tenant authorization boundary. DONE. Client tenant IDs confer no rights; no implicit platform admin.
- P02-07 Evidence-led ownership backfill. DONE. Mapping and exception ledger; ambiguous rows stay unassigned.
- P02-08 Relational isolation constraints. DONE. Tenant+parent FKs, least-privilege grants, policy adapters.
- P02-09 Migration and compensating rollback rehearsal. DONE. Clean replay and upgrade; rollback keeps accepted writes and RLS.
- P02-10 Phase 2 review package. DONE. 160 SQL assertions, 71 tenant regressions, 33 native Auth/Storage cases.
- P03-01 Tenant site config and host. DONE. Verified-host public config; unknown host fails closed.
- P03-02 Scoped CMS mutations and concurrent edits. DONE. Transactional versioned writes; stale overwrite rejected.
- P03-03 Branding, navigation, SEO. DONE. Per-tenant branding/nav/SEO; old deep links kept.
- P03-04 Secure CMS HTML and public media. DONE. Sanitizer replaced; malicious HTML inert.
- P03-05 Publication and cache integration. DONE. Publish/unpublish propagate; no cross-tenant cache. 98 checks.
- P04-01 Agency institution selection. DONE. Shared agency serves A and B explicitly; server-side denial.
- P04-02 Wizard and autosave concurrency. DONE. Versioned draft patches; conflicts reported.
- P04-03 Atomic idempotent submission/transitions. DONE. One reference/snapshot/event under concurrent repeats.
- P04-04 List counts, notifications, audit UI. DONE. Counts match >1000 fixtures; internal notes private.
- P04-05 Legacy admissions end to end. DONE. Preserved roles/accounts/documents verified; 109 Phase 4 checks.

## Phase 5 - Azure AI Document Intelligence

- P05-01 Document provider interface and fixtures. DONE (local, 2026-10-26). Provider contract, OpenAI adapter behind it, test-only mock; 17+9+3+20+4 cases and native lab 10/0 PASS.
- P05-02 Configured-safe Azure adapter. DONE (local, 2026-10-26). REST 2024-11-30, async poll, bounded timeouts, 429/5xx/invalid-JSON/failed/mismatch mapping; 22 cases PASS. Not deployed; live Azure NOT RUN.
- P05-03 Verify provider orchestration and history parity. status: DONE (local, 2026-10-26; migration undeployed). Orchestration `_shared/document-extraction/run.ts`, receipt table + fenced RPC (migration 20261026130000); 12 job-matrix cases, 13 pgTAP cases and native lab Azure path 4/0 PASS. Deps: P05-02.
  - Scope: wire `resumeOperationId`/`onOperationAccepted` into leased jobs (persist operation id, likely additive migration); audit/provenance and manual review parity.
  - Acceptance: no duplicate activation or confirmed overwrite; cancellation/retry/dead-letter limits and privacy hold; provider switch rolls back cleanly.
  - Tests: REG-DOC/JOBS failure matrix, versioned fixture parity (supabase/functions/portal-document-extract/index.ts, supabase/tests); native lab `scripts/lab/native-extraction.mjs`.
- P05-04 Optional live Azure acceptance gate. status: BLOCKED (mock-only readiness DONE locally 2026-10-26; live Azure NOT RUN, needs owner approval + hosted release). Deps: P05-03.
  - Scope: document synthetic fixture run and accuracy/cost evidence format; run only with credentials and explicit approval.
  - Acceptance: mock-only readiness reported separately; live result stays NOT RUN until approved and executed.
  - Tests: optional per-category real-fixture run; field-level outcomes, no invented accuracy.

## Phase 6 - RTO and company administration

- P06-01 Tenant and platform administration. status: DONE (local, 2026-10-26; migration 74 undeployed). Scoped commands (migration 20261026140000), `/admin/institution` page, 36-case admin matrix in `supabase/tests/phase2_authorization_red.sql` PASS, native lab 10/0 + Azure 4/0. Deps: P03-05, P04-05.
  - Scope: manage institution details/domains/memberships/agency relationships via scoped commands (src/pages/admin).
  - Acceptance: tenant admin cannot grant platform powers or touch another tenant; shared agencies preserved.
  - Tests: REG-AUTH/SEC admin matrix; domain verification/revocation.
- P06-02 Versioned workflow and configuration administration. status: DONE (local, 2026-10-26; migration 75 undeployed). Draft/publish/restore commands, `ConfigurationPanel`, 41 pgTAP cases; all 12 SQL suites 250/250, native lab 10/0 + Azure 4/0. Deps: P06-01.
  - Scope: validated role/workflow/integration/branding config with audit and safe defaults.
  - Acceptance: invalid config rejected; published workflows pin a version; secret values never returned.
  - Tests: config schema, transition versioning, restore regression.
- P06-03 Verify organization lifecycle and access audit. status: DONE (local, 2026-10-26; migration 77 undeployed). Invitation-based membership (uniform response), onboarding, platform suspend/reactivate, platform overview/audit, UI Platform tab. 44 new pgTAP cases, all 12 SQL suites 329/329, native lab 10/0 + Azure 4/0. Admin accessibility checked by review only (labels on new controls), not automated. Deps: P06-02, P06-04.
  - Scope: onboarding/suspension/member revocation, shared identity safety, admin usability.
  - Scope (add): make add-member by email return the same response whether or not the account exists.
  - Acceptance: suspension denies new operations without destroying records; audit attributes actor and tenant.
  - Tests: REG-AUTH/SEC/CMS/AGENCY plus admin accessibility.
- P06-04 Enforce pinned workflow and role configuration. status: DONE (local, 2026-10-26; migration 76 undeployed). `tenant_has_role` binds the three policy role sets to cms.edit/cms.read/applications.review; `portal_set_application_status` follows the pinned version. 33 new pgTAP cases, all 12 SQL suites 283/283, native lab 10/0 + Azure 4/0. Priority P0. Deps: P06-02.
  - Scope: make `portal_set_application_status` and the role/permission checks read the pinned workflow version and the published role config; the default (nothing published) must behave exactly like the current hard-coded rules. Remove the "not yet applied" notice in the admin Configuration tab when done.
  - Acceptance: transitions follow the pinned version; role restrictions are enforced server-side by RLS/RPC; old pinned applications keep working; no behavior change with default config.
  - Tests: REG-AUTH/AGENCY transition matrix per version; default-equals-hardcoded parity; restore regression.

## Phase 7 - Postmark email and notification events

- P07-01 Transactional notification outbox. status: DONE (local, 2026-10-26; migration 78 undeployed). Outbox events expand in-transaction into `notification_deliveries` (versioned templates/sender/defaults via config kind `notifications`, per-user opt-out); inbox untouched; nothing is sent. 39 new pgTAP cases, all 12 SQL suites 368/368, native lab 10/0 + Azure 4/0. Deps: P04-03, P06-02.
  - Scope: versioned template/sender/preferences and durable deliveries on top of in-app events.
  - Acceptance: committed transition yields one outbox event, rollback none; inbox preserved.
  - Tests: REG-NOTIFY/AGENCY rollback, duplicate status request, recipients.
- P07-02 Mock-first Postmark delivery and callbacks. status: DONE (local, 2026-10-26; migration 79 and new function `notification-delivery` undeployed; its `supabase/config.toml` verify_jwt=false entry is added; both routes fail closed). Leased claim, bounded retries, unknown outcomes never resent, Basic-auth deduplicated callbacks; 36 pgTAP + 9 unit cases, all 12 SQL suites 402/402, native lab OpenAI 10/0, Azure 4/0, Notify 7/0. Live Postmark NOT RUN. Deps: P07-01.
  - Scope: provider interface, safe unconfigured adapter, bounded attempts, current documented webhook verification.
  - Acceptance: mock lifecycle recorded; callbacks authenticated and deduped; disabled config sends nothing.
  - Tests: 429/timeout/replay/untrusted callback, template escaping.
- P07-03 Delivery preferences and recovery. status: DONE (local, 2026-10-26; migration 80 undeployed). Sweep marks dead workers' deliveries `unknown` (never auto-resent; administrators retry or close with a reason), sender ownership (approved address or verified hostname), per-institution owner activation gate, masked administrator delivery overview, email preferences in the agency portal. 39 new pgTAP cases, all 12 SQL suites 443/443, native lab OpenAI 10/0, Azure 4/0, Notify 8/0. Browser flows reviewed only, not automated. Live Postmark NOT RUN. Deps: P07-02.
  - Scope: queue crashes, opt-outs, sender ownership, admin delivery visibility.
  - Acceptance: no lost/duplicate notification across partial failures; owner review before live activation.
  - Tests: REG-NOTIFY plus inbox/browser tests.

## Phase 8 - PRISMS registration (manual workflow)

- P08-01 Manual registration and CoE lifecycle model. status: DONE (local, 2026-10-26; migration 81 undeployed). `enrollment_registrations` (draft/lodged/verified/cancelled), append-only evidence and history, reviewer-only commands; `coe_issued` stays distinct from a verified registration. 51 new pgTAP cases, all 12 SQL suites 494/494, native lab 10/0 + Azure 4/0 + Notify 8/0. No UI yet (P08-02); no government interaction. Deps: P04-05, P06-02, P06-04.
  - Scope: validated registration references/states/evidence and operator history (migrations).
  - Acceptance: required fields and tenant relations enforced; `coe_issued` distinct from verified external registration.
  - Tests: REG-REGISTER/SEC incomplete, duplicate, foreign reference, transitions.
- P08-02 Authorized manual registration workbench. status: DONE (local, 2026-10-26; migration 82 undeployed). `/agency/registrations` (reviewers only): list with warning for coe_issued/enrolled without a verified registration (never a block), checklist, evidence, lodge/verify/cancel, minimized audited CSV export; commands audited in the portal audit log. 28 new pgTAP + 6 unit cases, all 12 SQL suites 522/522, native lab 10/0 + Azure 4/0 + Notify 8/0. Page reviewed only, not run in a browser. No government interaction. Deps: P08-01.
  - Scope: checklist/export/manual confirmation/reconciliation views in src/pages/agency; keep evidence and CoE retention.
  - Scope (add): show a warning when an application is enrolled/coe_issued without a verified registration.
  - Acceptance: only authorized operators act; no automated government interaction; audit records confirmation.
  - Tests: REG-REGISTER browser validation, permissions, export minimization.
- P08-03 Reconciliation and exception handling. status: DONE (local, 2026-10-26; migration 83 undeployed). Computed exceptions (enrolled without verified registration, lodged > 14 days, verified on a withdrawn/rejected application, possible duplicate student), accept/reopen decisions with notes, attributable append-only CoE corrections, Exceptions tab in the workbench. 42 new pgTAP + 3 unit cases, all 12 SQL suites 564/564, native lab 10/0 + Azure 4/0 + Notify 8/0. Page reviewed only, not run in a browser. No government interaction. Deps: P08-02.
  - Scope: resolve duplicate/missing/outdated external records through reviewed manual actions.
  - Scope (add): list enrolled-without-verified-registration as a reconciliation exception.
  - Acceptance: every correction attributable; status/history consistent; no unsupported API assumptions.
  - Tests: REG-REGISTER/AGENCY correction, cancellation, mismatch, retention.

## Phase 8b - Admissions workflow revision

Owner decisions (2026-10-27), recorded for P08-04 to P08-07:
- Stored status values do NOT change. `coe_issued` stays; only its label becomes "CoE / VoE issued". "Offer issued" and "Under review" are removed from every selectable list, filter and the default transition graph; existing rows in those statuses stay valid and can only move forward.
- New default graph: draft -> submitted; submitted <-> action_required; submitted / action_required -> offer_accepted; offer_accepted -> coe_issued -> enrolled; rejected and withdrawn reachable by admins. After submission agents and agency admins have NO status transitions (enforced server-side by RPC/RLS, shown read-only in the UI); during action_required they can only add documents or edit allowed fields.
- The default-equals-hardcoded parity tests are updated deliberately, not left to drift.

- P08-04 Revise status model, labels and permissions. status: DONE (local, 2026-10-27; migration 91 local only, unapplied). New default graph, legacy under_review/offer_issued rows forward-only, agents/agency admins have no status transition after submission (portal_submit_v2 drafts only; status RPC reviewer-only; direct writes blocked), "CoE / VoE issued" label in UI and email text, removed statuses out of filters/pickers/dashboard. 25 new pgTAP + 4 unit cases, parity test deliberately updated (8 statuses, 64 pairs); all 12 SQL suites green (phase4 123, phase2 red 425), native lab 19/0 + Notify 9/0. Browser flows not run. Priority P0. Deps: P08-03, P06-02.
  - Scope: additive migration replacing the default workflow graph (new transitions above; legacy `under_review` / `offer_issued` rows only move forward); `portal_legacy_transition_allowed` and the pinned-workflow defaults follow the new graph; agents and agency admins lose every status transition after submission (RPC and RLS enforce it; during `action_required` they may only add documents / edit allowed fields); label "CoE / VoE issued" for `coe_issued` and the removal of the two statuses from selectable lists, filters, badges and inbox/notification text everywhere in the UI; read-only status display for agent roles.
  - Acceptance: only the new graph is selectable and enforceable; no stored status value changes; existing rows in removed statuses stay readable and can move forward; an agent or agency admin calling the status RPC after submission is refused server-side; labels consistent across portal, registrations workbench, filters and email text.
  - Tests: pgTAP for every allowed and refused transition per role (incl. legacy-status rows, direct REST writes); default-graph parity tests updated deliberately; offline label/filter tests; native lab regression.
- P08-05 Notification recipients and events (admin-managed). status: DONE (local, 2026-10-27; migration 92 local only, unapplied). Events application_submitted, application_status_changed, offer_accepted, coe_voe_issued (status RPC names the event after the target status); per-event internal recipients (max 10) and agent / agency admin / student toggles in the tenant `notifications` config (versioned, audited) or, for the legacy scope, `notification_legacy_event_settings`; deliveries support non-user recipients (activation, opt-out and sender rules unchanged); admin UI in Email deliveries and Website Settings. 37 new pgTAP + 4 unit cases, all 12 SQL suites green (phase4 160), native lab 20/0 + Notify 10/0. Browser flows not run. Deps: P08-04, P07-03.
  - Scope: per-event settings in the existing `notifications` config for application_submitted (admin recipients), offer_accepted (agent) and coe_voe_issued (student + agent): internal recipient emails list and toggles for agent / agency admins / student; deliveries must support non-user recipient emails (suppression, opt-out and the migration 84 activation rules unchanged for them); address validation, audit of changes, admin UI in the Email deliveries area.
  - Acceptance: each event resolves exactly its configured recipients; internal and student recipients are delivered without a portal account; invalid or duplicate addresses rejected on save; every change attributable; activation gate and sender rules still apply.
  - Tests: pgTAP recipients per event and toggle combination, non-user recipients, validation and audit; offline config tests; native lab Notify run.
- P08-06 Submission PDF. status: DONE (local, 2026-10-27; migration 93 local only, unapplied; notification-delivery function changed, undeployed). The worker builds a dependency-free PDF of the immutable submitted version at send time (in memory only; 2 MB / 40-page cap, falls back to a sign-in link) and attaches it to application_submitted; per-institution option attach (default) vs secure link; Postmark Attachments in the adapter, mock and lab; snapshot released only to the service role for a claimed delivery; delivery rows and logs keep only the reference. 16 new pgTAP + 7 unit cases, all 12 SQL suites green (phase4 176), native lab 21/0 + Notify 11/0. Browser flows not run. Deps: P08-05.
  - Scope: server-side PDF of the immutable submitted form version attached to the application_submitted email; per-institution option attach vs secure link; attachment size cap; Postmark attachment support in the adapter, mock and lab Notify run; no PII in logs or delivery rows beyond the application reference.
  - Acceptance: the PDF matches the submitted snapshot and never a later edit; over-cap or failed generation degrades to the secure link or a safe failure without blocking submission; no document content or student PII in logs or delivery rows.
  - Tests: snapshot-fidelity and size-cap unit tests; adapter/mock attachment payload tests; lab Notify run with attachment; log/row PII checks.
- P08-07 CoE/VoE issue flow (manual until the PRISMS API). status: DONE (local, 2026-10-27; migration 94 local only, unapplied; notification-delivery function changed, undeployed). Registration verification now possible from offer_accepted; reviewers upload the CoE/VoE PDF (type, 3 MB cap, %PDF- and %%EOF validated, private table with no browser grants, issued documents immutable); "Approve and issue" (verified registration + uploaded PDF + offer accepted) sets coe_issued through the status command in one transaction and the coe_voe_issued email carries the PDF to the P08-05 recipients (retried, never sent without it); missing/malformed student or user addresses create visible suppressed deliveries (invalid_recipient) listed for administrators. 39 new pgTAP + 7 unit cases (P08-05/06 paths included), parity/registration tests updated deliberately; all 12 SQL suites green (phase4 215, phase2 red 425), native lab 22/0 + Notify 12/0. Browser flows not run. Deps: P08-06, P08-02.
  - Scope: admin uploads the CoE or VoE PDF (type selection, size limit, PDF-only validation, private storage); requires a verified registration; relax registration verification to allow `offer_accepted` and later; "Approve and issue" sets `coe_issued` and emails student + agent with the document; audit and tests.
  - Scope (add): a missing or malformed student/recipient email must create a visible suppressed delivery (reason invalid_recipient) shown to administrators, never a silent skip; also apply this to the P08-05 event paths.
  - Acceptance: only an authorized admin can issue; issue is refused without a verified registration or a valid PDF; verification possible from `offer_accepted`; recipients per P08-05 receive the document; every step audited; private storage and access rules unchanged.
  - Tests: pgTAP issue preconditions and permissions, registration-verification range, storage policy; offline PDF validation; native lab Notify run for the issue email.
- P08-08 Automate CoE/VoE retrieval via the PRISMS API once the provider has API access. status: BLOCKED (external: no provider API access yet; no unsupported API assumptions). Deps: P08-07.
  - Scope: replace the manual CoE/VoE upload step with retrieval through the PRISMS API when access exists; keep the manual path as the fallback.
  - Acceptance: defined only after the provider documents and grants API access.
  - Tests: to be defined with the API contract.

## Phase 9 - Multi-tenant RAG chatbot

- P09-01 Scope RAG knowledge and cache to verified tenant. status: TODO. Priority P0. Deps: P02-10, P03-05, P08-07.
  - Scope: bind structured/FAQ/vector/cache/index operations and budgets to the authorized public tenant (public-assistant, public-assistant-index).
  - Acceptance: tenant B cannot retrieve A sources or cached answers; private student documents never enter the public index.
  - Tests: REG-RAG/SEC two-host, spoofed tenant, private bucket, unpublished.
- P09-02 Incremental indexing and worker limits. status: TODO. Deps: P09-01.
  - Scope: fence staging, PDF/config limits, retries/backoff, dedupe hashes, cleanup, event coverage.
  - Acceptance: no stale activation/chunk damage; bounded cost and concurrency; unpublish/delete reflected; old URLs preserved.
  - Tests: REG-JOBS/RAG concurrent same-version attempts, page limit, source changes, crash loop.
- P09-03 Bounded conversation context and privacy. status: TODO. Deps: P09-01.
  - Scope: deterministic answers retained; follow-up/clarification/multilingual and controlled history when practical.
  - Acceptance: follow-ups resolve without invented facts; context isolated by tenant/session; opt-out/delete respected.
  - Tests: scripted multi-turn, missing context, mixed language, prompt injection, source attribution.
- P09-04 Provider failure limits and usage. status: TODO. Deps: P09-02, P09-03.
  - Scope: parse realistic responses; align UI/server deadlines; trusted rate limits; actual tokens; scoped cost budget.
  - Acceptance: timeout/cancel does not duplicate work; no fabricated usage; unavailable provider gives safe fallback.
  - Tests: REG-RAG/JOBS concurrency, 429, nested envelope, token ledger, spoofed headers.
- P09-05 Combined tenant readiness. status: TODO. Deps: P09-04, P04-05.
  - Scope: full CMS/admissions/public RAG integration with two synthetic institutions; onboarding readiness doc only.
  - Acceptance: isolation and legacy gates pass; second-tenant activation stays a separate reviewed production action.
  - Tests: REG-PUBLIC/CMS/AGENCY/DOC/RAG/SEC with publication-to-answer trace.

## Phase 10 - Stripe subscriptions and billing

- P10-01 Tenant subscriptions and entitlements. status: TODO. Deps: P06-03.
  - Scope: plans/subscriptions/status/references and provider interface; no card data.
  - Acceptance: entitlements enforced server-side with explicit grace/cancel rules; tenant separation kept.
  - Tests: REG-BILL/SEC plan changes, invalid status, mock clock.
- P10-02 Mock-first Stripe events and receipts. status: TODO. Deps: P10-01.
  - Scope: raw-body verified webhook, durable unique event storage, ordering/idempotency, retries.
  - Acceptance: duplicate/reordered events cannot double-apply; no live secrets required.
  - Tests: tampered signature, replay, out-of-order, concurrent events.
- P10-03 Billing lifecycle and activation readiness. status: TODO. Deps: P10-02.
  - Scope: mock create/cancel/renew; reconcile receipts/audit; document live gate.
  - Acceptance: no real charge/subscription/webhook enabled; deterministic lifecycle evidence.
  - Tests: REG-BILL plus shared admin/account and outage regression.

## Phase 11 - Performance, security, observability, deployment

- P11-01 Core performance. status: TODO. Deps: P09-05, P06-03.
  - Scope: pagination/index plans, bundle/lazy loading, bounded worker throughput and memory.
  - Scope (add): measure database and backup-checkpoint growth from PDF bytes stored in tables; if volume warrants, move generated/uploaded PDFs to the private storage bucket with storage policies and tests.
  - Acceptance: measured p95/throughput/cost with stated dataset and hardware; no capacity claimed from compilation.
  - Tests: REG-PERF plus affected regressions.
- P11-02 Security, accessibility, failure review. status: TODO. Priority P0. Deps: P07-03, P08-03, P10-03, P11-01.
  - Scope: access/secret/dependency review, browser accessibility, load/failure, retention controls.
  - Acceptance: no unresolved release-blocking authorization regressions; residual risk explicitly accepted.
  - Tests: all regression groups, RLS/advisors on authorized test DB, threat cases.
- P11-03 Observability and recovery rehearsal. status: TODO. Deps: P11-02.
  - Scope: correlation logs/metrics, alerts, backup restore, queue/operator runbooks, deployment parity.
  - Acceptance: synthetic incident traceable without PII; restore/rollback preserves tenant ownership and accepted writes.
  - Tests: crash/restore/drain, log redaction, recovery timing.
- P11-04 Release approval package and portability handoff. status: TODO. Deps: P11-03.
  - Scope: exact artifact/config/migration checklist with measured evidence; future Node/VPS path documented separately.
  - Acceptance: reviewable release; no deployment or hosting migration without explicit approval.
  - Tests: final regression evidence and restore/rollback review.
