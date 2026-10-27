# Architecture

## Stack
React 19 + Vite + TypeScript SPA (not Next.js; no Node server). Supabase: Postgres + RLS, Auth, Storage (public `cms-media`, private `enrollment-documents`), seven Deno Edge Functions, durable SQL queues with pg_cron/pg_net dispatch. Domain logic stays runtime-neutral (Vite + Deno). Frontend hosting for https://slit.edu.au is UNVERIFIED; dev at http://localhost:3001 (3000 is TenderFlow).

```
Browser SPA -> Supabase Auth / PostgREST (RLS) / Storage / Edge Functions
Edge -> DB, Storage, OpenAI or Azure (document extraction), OpenAI (assistant)
DB queues + cron -> Edge workers (portal-document-extract, public-assistant-index)
```

## Surfaces (preserve all, with records, accounts, documents, URLs)
- Public site: `/`, about, courses, information, student visa, OSHC, forms-policies, agents, contact, enroll-now, CMS-published pages. Public RAG assistant.
- CMS `src/pages/admin`: courses, pages, navigation, footer, settings, documents, forms, contact, SEO, users, activity, knowledge.
- Agency Portal `src/pages/agency` + application wizard: applications (draft/autosave/submit), documents, notifications, agency profile, audit log, document-extraction queue.
- Data layers: `src/pages/admin/lib` (CMS), `src/lib` (public data, drafts). Browser Supabase client: `src/pages/admin/lib/supabase.ts`. Screen guards are UX only; SQL/Edge authorization is the boundary.

## Tenancy model
- `tenants`, `tenant_domains` (verified hosts; unknown host fails closed, no default tenant), `tenant_memberships`, `platform_admins`, `agency_tenants` (many-to-many agency <-> institution). Agencies and portal profiles stay shared.
- Applications carry `tenant_id` + `agency_id` with a composite FK to an authorized relationship; child tables reference tenant+parent.
- Authorization comes from `auth.uid()` plus live memberships in RLS and scoped RPCs. Client-supplied tenant IDs, headers, route IDs and `user_metadata` never grant access. A CMS admin is not automatically a platform admin.
- Legacy rows without evidence stay unassigned; backfill is evidence-led only.
- Public RAG, cache keys, indexing jobs and usage budgets are bound to the verified public tenant (P09 completes this; second tenant not activated).

## Security rules
- RLS is the durable authority; never remove RLS to roll back. JWT stays on for the three user functions; the three public/worker functions use `verify_jwt=false` with their own secret checks.
- Privileged workers receive job IDs and lease tokens, never client paths or tenant claims; storage targets are validated against the application-owned mapping.
- **SEC-18 fencing:** staging, chunk writes, activation, completion and cancellation of extraction and indexing jobs are conditional on a database-verified lease and source version. Stale or cancelled workers cannot write; reclaimed workers cannot race chunk replacement. Migration `20261024171632_fence_public_assistant_index_commit.sql`. Preserve it.
- Server-only provider keys; no secrets in Vite, logs or snapshots; no live provider calls in tests (deterministic mocks). No real student documents in tests.
- CMS HTML is sanitized by a reviewed boundary; public media is public by design, drafts do not imply privacy.
- Invoices/subscriptions/PRISMS stay mock-first or manual; no automated government interaction.

## Document extraction
`portal-document-extract` keeps queue, lease, validation and fenced-RPC logic and delegates to an injected `DocumentExtractionProvider` (`_shared/document-extraction/`). OpenAI is the default; Azure is selected by `EF_DOCUMENT_EXTRACTION_PROVIDER=azure` with complete `EF_AZURE_DOCUMENT_*`; the deterministic mock is test-only. Missing config keeps manual entry working.

## Key decisions
- ADR-001 Preserve and extend existing components; no rebuild, framework switch or hosting migration.
- ADR-002 Observed framework is React/Vite, not Next.js.
- ADR-003 CMS and Agency share one backend; Submissions project is excluded.
- ADR-004 Modular monolith with portable domain code; no Redis or microservices.
- ADR-005 Many-to-many agency/institution authorization.
- ADR-006 Additive ownership with evidence-led backfill; never a default tenant.
- ADR-010 Azure/Postmark/Stripe mocked first; PRISMS manual.
- ADR-011 Baseline (existing-system) acceptance is separate from tenant acceptance.
- ADR-012 Phase order: 5 Azure, 6 RTO admin, 7 Postmark, 8 PRISMS, 9 RAG, 10 Stripe, 11 hardening.
- ADR-013 Provider seam for document extraction; mock cannot be selected by deployed config.
- Future Node/VPS portability is a later documented path only (P11-04); no hosting change now.
