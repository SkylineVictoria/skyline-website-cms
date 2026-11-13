# Assessment Management integration: dual-codebase audit

Read-only audit of **Submissions** (`C:\Users\goura\Desktop\Submissions`, reference only, never modified) and **Skyline-Website** (`C:\Users\goura\Desktop\Skyline-Website`, the target). Written 2026-11-13/14 for the Assessment Management integration (brief section 10, Phase 1). Every finding carries a `file:line` reference relative to the repo it belongs to; line numbers are from the files as read on 2026-11-13. Nothing was executed against either hosted project; no `.env*`, CLI secret or deploy-metadata file was opened.

How this file is organised:

| Part | Content |
|---|---|
| Part S | Submissions, sections S1-S14 (the brief's Submissions checklist). The detail is in four audit modules (S-A architecture/auth/dashboards/courses/notifications/reports, S-B form engine, S-B2 hardcoding inventory, S-C assessment lifecycle/DB). An index maps each S-number to the module sections. |
| Part K | Skyline, sections K1-K15 (the brief's Skyline checklist). K2, K3, K4, K6, K7 and K8 are summarised from, and point into, module K-D (courses, units, intakes, batches, trainers, students, timetable); the rest are written directly. |
| Part M | Classification summary and the feature comparison matrix with the integration decision per row. |
| Part I | Auth / identity comparison. |
| Part DM | Integrated data model (what is reused, what is new). |
| Part W | Admin, trainer and student workflows on the integrated system. |
| Part R | Missing functionality, risks and reusable code. |
| Part P | Phased plan with testable acceptance criteria. |
| Part V | Confirmed findings, assumptions and items needing runtime access (consolidated). |

Status vocabulary used throughout (brief section 10, "Classification"): **Implemented** (a traced code path does it end to end), **Partial** (exists but with a gap named in the row), **Missing** (nothing in code), **Unused** (code exists, no caller or route).

One identity note up front: `CLAUDE.md` names the Submissions Supabase project as `qoylrmorezlqdvufonmx`, while the Submissions checkout's `supabase/.temp/project-ref` holds `fvveqziyusjgqejowkfp` (S-A §1). Both are treated as off-limits; which one is live needs runtime access to confirm. The Skyline link is `supabase/.temp/project-ref` = `xcpydisstlvtvcsqnjob` (confirmed by reading the file; matches CLAUDE.md).

---

# Part S. Submissions (reference only)

## S index: brief checklist to module sections

| # | Brief item | Where the detail is |
|---|---|---|
| S1 | Architecture and stack | S-A §1 (React 19 / Vite 7 SPA, anon-key PostgREST, `pdf-server` Express+Playwright on Render/Railway, Vercel frontend, 174 migrations, FCM push) |
| S2 | OTP auth, roles and permissions | S-A §2 (OTP request/verify, 12-hour staff session token checked by ten RPCs, student `sessionStorage` blob, instance access tokens, impersonation), S-A §3 (roles `superadmin/admin/trainer/office`, client route guards, server-side enforcement table, RLS inventory), S-A Appendix B |
| S3 | Admin, trainer and student dashboards | S-A §4 (admin overview, trainer/office queue + Grade-me panel, trainer course units / unit submissions / my students, student dashboard + acknowledgment gate, `FormsListPage` unused, `FormStartPage` public), S-A Appendix A route map |
| S4 | Form builder: schema, builder UI, renderer, validation, uploads | S-B §0-§7 (two engines; `skyline_form_*` hierarchy; 12 question types and `pdf_meta` configs; builder pages and what is / is not configurable; `InstanceFillPage` render switch by `pdf_render_mode`; validation modules; `photomedia` uploads; PDF export), S-C Appendix B |
| S5 | Assessment creation, publication and assignment | S-C §2 (create = always `published`; no publish step; no versioning; assignment paths; dates / extension rules; access links) |
| S6 | Submissions and drafts | S-C §3 (three overlapping state fields, transition table, draft = answers rows with merge guard, role × workflow edit rules, rollover rules 1-6, repairs), S-C Appendix D-F |
| S7 | Storage and evidence | S-C §4 (one public bucket `photomedia`, path templates, public URLs, no signed URLs, SharePoint PDF pipeline, signatures as TEXT), S-B §6 |
| S8 | Marking / feedback, outcomes, reassessment | S-C §5 (trainer-captured data, task → unit derivation, exact reassessment rules, feedback / sign-off / acknowledgment), S-B2 (d), (e), S-C Appendix C, H |
| S9 | Course / unit / batch links | S-A §5, S-C §6 (form = unit; `skyline_course_forms`; `skyline_batches` + `skyline_batch_trainers`; `skyline_students.batch_id`; `skyline_student_courses` lifecycle; instance has no course / batch / trainer column) |
| S10 | Notifications and emails | S-A §6 (in-app `skyline_notifications` + FCM via `send-notification`; Postmark only for OTP and enrolment; `user_id` namespace shared by staff and students), S-C Appendix G |
| S11 | Reports, exports and audit logs | S-A §7, S-C §7 (Assessment Reports XLSX, directory export, link exports, learning-doc activity, client-supplied audit columns, `impersonation_logs`, `skyline_submission_events`) |
| S12 | Tables and foreign keys | S-C §1.1 (full inventory with FKs / uniques / checks), S-C Appendix A (`skyline_form_instances` column by column) |
| S13 | Edge Functions, RLS, validation and tests | S-A §8 (ten Edge Functions, env names only; vitest pure-logic tests), S-C §1.2-§1.4 (triggers, RPC inventory with SECURITY DEFINER and grants, RLS: assessment tables have none), S-B §5 (validation) |
| S14 | Every hardcoded element (brief 4.1) | S-B2 (a) questions / options, (b) task / section structure, (c) per-unit / per-course / per-organisation, (d) marking rules, (e) outcome logic, (f) instructions / declarations, (g) file rules, (h) conditional behaviour, (i) other constants; plus "Actual assessment content embedded in source" (18 content sets for the converter) |

Headline findings for Submissions (each expanded in the modules):

1. **No Supabase Auth and no RLS on assessment data.** The browser uses the anon key against 37 tables; SECURITY DEFINER RPCs for submit, delete, membership and enrolment have no caller check (S-A §3.3, S-C §1.4). Authorisation is UI-only, so nothing from its auth layer can be reused in Skyline (Part I).
2. **The form engine is a fixed "Student Pack".** `createForm` builds a compulsory structure (Introductory Details with 5 fixed sections + 15 policy sections, one step per task with 5 fixed sections, Summary, Appendix A, Learner Evaluation); the Results sheet, Summary sheet, Appendix A matrix and marking checklists are rendered from code, not data (S-B §3.3, S-B2 (b)).
3. **No versioning.** `forms.version` is free text; instances point at `form_id`; editing a question changes every instance in place and deleting one cascades into submitted answers (S-C §2.2).
4. **Marking and outcome logic are code.** Task S/NS derived from yes/no marks; unit C/NYC from tasks; three attempts; +5 days after NYC; cron rollover auto-writes a Not Yet Satisfactory on a missed second window (S-C §5.2-§5.3, S-B2 (d)-(e)).
5. **Evidence is public.** One public bucket, public URLs, bucket-wide anon policies from a script (S-C §4).
6. **Course / unit / batch model is thin.** Form = unit (free-text codes), course ↔ form many-to-many, one batch per student, instance has no course / batch / trainer column (S-C §6).
7. **Reusable as behaviour, not as code:** attempt / reassessment semantics, declaration wording, Melbourne end-of-day deadlines, acknowledgment gate, idempotent submit RPC with request id, debounced per-question autosave with merge guard (Part R, "Reusable code").

The four modules follow verbatim (headings demoted one level).


---

## Module S-A. A. Submissions app — architecture, auth, roles, dashboards, course model, notifications, reports

Read-only audit of `C:\Users\goura\Desktop\Submissions` (package name `signflow`, brand "Skyline Submissions"). Every path below is relative to that repo root. Nothing was modified; no `.env*` file was opened; no git/supabase/npm command was run against it. Line numbers are from the files as found on 2026-11-13.

---

### 1. Architecture and stack

| Concern | Finding | Evidence |
|---|---|---|
| Framework | React 19 + TypeScript + Vite 7, single SPA (`#app` root), `StrictMode` | `package.json:51,27`, `src/main.tsx:11-34`, `index.html` |
| Router | `react-router-dom` 7, `BrowserRouter`, every page lazy-loaded | `package.json:54`, `src/App.tsx:2,19-69,87` |
| Route tree | Public: `/login`, `/forms/:formId/start`, `/forms/:formId/student-access`, `/student-access`, `/student/dashboard`, `/instances/:instanceId`, `/induction/:token`, `/enroll-now`, `/legacy`. Staff: `/admin/*` under `ProtectedRoute` + `AdminLayout` | `src/App.tsx:91-166` |
| State | React context for auth (`AuthContext`), local component state everywhere else; `zustand` store only backs the legacy JSON-driven wizard (`/legacy`) | `src/contexts/AuthContext.tsx:26-83`, `src/store/formStore.ts`, `src/App.tsx:166`, `README.md:249-252` |
| Forms/validation | `react-hook-form` + `zod` (enrolment form), hand-rolled validation for assessment instance | `package.json:53,61`, `src/lib/enrolmentValidation.ts` |
| Styling | Tailwind CSS 4 via `@tailwindcss/postcss`, CSS variables (`--bg`, `--text`, `--border`), `lucide-react` icons | `package.json:17,58,45`, `postcss.config.js`, `tailwind.config.js` |
| PDF generation (client) | `@react-pdf/renderer` 4 for generic-links PDF and enrolment PDF; lazy chunk | `package.json:36`, `vite.config.ts:36-40`, `src/components/pdf/GenericLinksPdf.tsx`, `src/lib/enrolmentPdf.tsx` |
| PDF generation (server) | Separate Node/Express service `pdf-server/` using Playwright/Chromium (HTML -> PDF), with a job worker that uploads completed assessment PDFs to SharePoint via MS Graph | `pdf-server/index.ts:2,78,86,2438,2656`, `pdf-server/pdfWorker.ts:1-14`, `render.yaml:8`, `README.md:9,21` |
| pdf-server routes | `GET /health`, `POST /jobs/process-pdfs` (header `x-worker-secret`), `POST /jobs/seed-completed-pdfs`, `GET /pdf/induction/:token`, `POST /pdf/induction/:token/filled`, `GET /pdf/:instanceId`, `GET /pdf/preview/form/:formId` | `pdf-server/index.ts:78,86-88,127-129,159,253,2438,2656` |
| Dev proxy | Vite proxies `/pdf` to `http://localhost:3001` (the pdf-server) | `vite.config.ts:8-13` |
| Deploy: frontend | Vercel, framework `vite`, SPA rewrite to `/index.html` | `vercel.json:1-9`, `README.md:81,137-142` |
| Deploy: pdf-server | Railway (`pdf-server/Dockerfile`, start `node dist/index.js`) or Render blueprint (`signflow-pdf`, rootDir `pdf-server`, docker, env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NODE_OPTIONS`) | `railway.toml:6-13`, `render.yaml:6-16` |
| Supabase usage | Browser talks to Postgres directly with the **anon key** (`createClient` with a guarded fetch); PostgREST tables + RPCs; Storage buckets; Realtime on `skyline_notifications`; 10 Deno Edge Functions; `pg_cron`, `pg_net`, Vault referenced in migrations | `src/lib/supabase.ts:4-9`, `supabase/migrations/20260430120000_skyline_notifications_realtime.sql:14`, `supabase/migrations/20260706140000_enqueue_pdf_on_instance_complete.sql:11,72-80,98-104`, `supabase/migrations/20260917123000_assessment_submission_workflow_hardening.sql:10,535-539` |
| Linked Supabase project ref | `fvveqziyusjgqejowkfp` (from `supabase/.temp/project-ref`); there is **no** `supabase/config.toml` | `supabase/.temp/project-ref` |
| Request guard | 5-minute per-endpoint backoff on 503/504/522 or network errors, in-flight dedupe + TTL cache for reads | `src/lib/supabaseRequestGuard.ts:3,96-119,140-178` |
| Maintenance mode | `VITE_MAINTENANCE_MODE=true` renders `MaintenanceScreen` and never loads Supabase | `src/main.tsx:18-25`, `src/utils/maintenanceMode.ts:2-5` |
| Push | Firebase Cloud Messaging web push, service worker `public/firebase-messaging-sw.js` | `src/lib/firebase.ts:4-33`, `src/services/pushNotificationService.ts:47` |
| Other libs | `xlsx` (report export), `recharts` (finance charts), `luxon`/`date-fns`, `react-quill-new`, `mammoth` (.docx import in builder), `jszip`, `qrcode`, `heic2any`, `react-signature-canvas`, `@dnd-kit` (builder) | `package.json:34-60` |
| Storage buckets | `photomedia` (images, learning docs under `photomedia/Learning/...`), `student-enrolment-documents` (15 MB, policies), payment receipts go to SharePoint not Storage | `supabase/migrations/20260427000001_learning_bucket_and_policies.sql:1-9`, `supabase/migrations/20260514120000_student_enrolment_applications.sql:198-203`, `supabase/functions/skyline-record-student-payment/index.ts:36-45` |
| Migrations | 174 files in `supabase/migrations` (two pairs share a basename with different timestamps and differ: `20260713090704`/`20260713140000_course_lifecycle_scheduling.sql`, `20260706083854` (0 bytes)/`20260706140000_enqueue_pdf_on_instance_complete.sql`); one deliberately unapplied file in `supabase/pending/` | `supabase/pending/20261110000006_revoke_client_writes_on_users.sql:1-12` |
| Explicitly not RLS | Original schema states "RLS is NOT enabled"; most business tables still have none | `supabase/migrations/20250211000000_create_form_tables.sql:3`, `README.md:10`, `docs/security-followups.md:7-9` |

---

### 2. Authentication

#### 2.1 Summary
Custom OTP auth; **Supabase Auth is not used** (no `supabase.auth.*` call anywhere in `src/`; migrations never reference `auth.uid()`). Every browser request runs as the `anon` DB role. Staff identity is proven only to a small set of RPCs via a server-issued 12-hour session token; everything else trusts a user object in `localStorage`. Student "sessions" are a `sessionStorage` blob with no server-side token.

Evidence: `supabase/migrations/20261110000001_trainer_login_as_student.sql:4-7`, `docs/security-followups.md:7-10,101-102`, `src/services/paymentPlans.ts:694`.

#### 2.2 OTP request (staff / student / induction)

| Step | Where | Detail |
|---|---|---|
| Email gate (UI) | `src/lib/emailUtils.ts:36-40` | Only `@slit.edu.au`, `@student.slit.edu.au`, or the hard-coded master address (`emailUtils.ts:6`) can request an OTP. |
| Staff vs student choice | `src/pages/LoginPage.tsx:32-53` | `@student.slit.edu.au` goes straight to student OTP; otherwise staff OTP, falling back to student OTP when the staff RPC says "not found". |
| Client call | `src/lib/formEngine.ts:2100-2145` | `POST {VITE_SUPABASE_URL}/functions/v1/skyline-request-otp` with `Authorization: Bearer <anon key>` and `{email, type}`; induction uses `skyline-request-induction-otp` with a 404 fallback to the generic function + `X-Skyline-Otp-Type` header. Wrappers: `requestOtp` 2841, `requestStudentOtp` 2148, `requestInductionOtp` 2153. |
| Edge Function | `supabase/functions/skyline-request-otp/index.ts:29-36,53-61,86-99` | Resolves `type`, uses the **service-role** client, calls `skyline_request_otp` / `skyline_request_student_otp` / `skyline_request_induction_otp`, emails the code via Postmark, returns `{success}` only (OTP never returned to browser). Induction-only variant: `supabase/functions/skyline-request-induction-otp/index.ts:44-81`. |
| Postmark | `supabase/functions/skyline-request-otp/postmarkOtp.ts:5-11,43,80-86` | Env names only: `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL`, optional `POSTMARK_MESSAGE_STREAM` (+ `SKYLINE_` aliases). Subject "Your Skyline OTP is :{otp}". Docs: `docs/POSTMARK_OTP.md:1-30`. |
| OTP table | `supabase/migrations/20260313000001_otp_and_master_admin.sql:2-11` | `skyline_otps(id, email, otp_code, expires_at, created_at)`; one row per email (prior rows deleted on request). |
| Staff request RPC | `...20260313000001_otp_and_master_admin.sql:22-62` | Requires active `skyline_users` row; 6-digit `random()` code; 10-minute expiry; **returns the OTP in the result row** (line 60). |
| Student request RPC | `supabase/migrations/20260313000003_student_otp.sql:5-45` | Same, against `skyline_students` with status null/active. |
| Induction request RPC | `supabase/migrations/20260402000001_induction_otp_institutional_email.sql:3-52` | Accepts any active student/user **or any address on the two institutional domains**. |

**Surprise (confirmed in migrations):** the OTP-generating RPCs are `GRANT EXECUTE ... TO anon` and return the OTP: `20260313000001:153`, `20260313000003:70-71`, `20260330190001_induction_otp_student_or_user.sql:107-108`. No later migration revokes them. So the "OTP is never exposed to the client" property holds only for the Edge Function path; a caller with the anon key can call the RPC directly and read the code. Whether the hosted DB still has these grants needs runtime access.

#### 2.3 OTP verification and session

| Actor | Verify RPC | Returns | Client handling |
|---|---|---|---|
| Staff | `skyline_verify_otp_login(p_email, p_otp)` current definition `supabase/migrations/20261110000001_trainer_login_as_student.sql:226-281` (SECURITY DEFINER, matches active user + unexpired OTP, deletes OTP, issues session) | `id, full_name, email, phone, status, role, can_login_as_student, can_login_as_trainer, can_view_finance_reports, session_token` | `loginWithOtp` `src/lib/formEngine.ts:2846-2870` stores token (`setStaffSessionToken` 2536-2543, key `skyline_staff_session_token_v1` 2526) and returns `AppUser`; `AuthContext.login` `src/contexts/AuthContext.tsx:58-62` stores the user as JSON in `localStorage['skyline_auth_user']` (`formEngine.ts:2386,2512-2518`). |
| Student (dashboard) | `skyline_verify_student_otp(p_email, p_otp)` `supabase/migrations/20260313000003_student_otp.sql:48-68` | `(id, email)` of `skyline_students` | `studentLoginWithOtp` `formEngine.ts:1696-1711`; `LoginPage.tsx:77-87` then writes `sessionStorage['signflow_student_dashboard_auth_v1'] = {studentId, email, at}` and navigates to `/student/dashboard`. No server token. |
| Student (per form) | same RPC via `studentLoginWithOtpForForm` `formEngine.ts:2234-2248` | | `studentFormAccessFromId` 2157-2231 checks inactive status, finds the student's instance for the form, blocks re-entry after submission unless a valid student token exists (2202-2218), then issues an instance access link. Page: `src/pages/StudentAccessPage.tsx:40-73`. |
| Induction | `skyline_verify_induction_otp` / `skyline_induction_unlock` | session row in `skyline_induction_sessions` | `formEngine.ts:2254-2283,7475-7490`; sessions table `supabase/migrations/20260330000002_induction_submissions.sql:4-11`. |

Staff session mechanics (`supabase/migrations/20261110000001_trainer_login_as_student.sql`):
- `skyline_staff_sessions(token_hash PK, user_id FK, created_at, expires_at default +12h)`, RLS on, all client grants revoked: lines 24-35.
- `skyline_issue_staff_session` builds a 64-hex token from two UUIDs, stores SHA-256 only: 69-85. `skyline_staff_from_token` resolves the caller and raises SQLSTATE `PT401` when missing/expired/inactive: 89-114. `skyline_logout`: 291-299. Role/rights/status change deletes all of that user's sessions (trigger 489-514).
- PostgREST maps `PTxxx` to HTTP status; client maps `PT401` -> clear token and ask to sign in again, `PT403` -> forbidden: `src/lib/formEngine.ts:2557-2595`.
- On app load `AuthContext` re-reads login rights straight from `skyline_users` (`fetchUserLoginRights` `formEngine.ts:2805-2831`) and merges them into the stored user: `src/contexts/AuthContext.tsx:32-56`.
- Expiry is enforced only by token-checked RPCs; all direct table access keeps working with the stale `localStorage` user (`docs/security-followups.md:101-102`).

#### 2.4 Legacy password paths (closed)
- Staff password login `skyline_login` (incl. empty-password bypass for `is_master`) and `skyline_change_password` are revoked from clients; `password_hash` is hidden by column-level SELECT grants: `supabase/migrations/20261110000002_close_password_login_holes.sql:8-32`. `skyline_admin_set_password` revoked: `20261110000003_users_token_checked_rpcs.sql:244`.
- Student password: `skyline_student_set_password` / `skyline_student_authenticate` still exist and are granted to `anon` (`supabase/migrations/20260306000001_student_password_and_access.sql:9-59`); `setStudentPassword` is exported (`formEngine.ts:2285-2294`) but has no caller in `src/pages` or `src/components` -> dormant.
- Pending (not applied): revoke direct INSERT/UPDATE/DELETE on `skyline_users` and the old `skyline_create_user`: `supabase/pending/20261110000006_revoke_client_writes_on_users.sql:14-18`; rationale `docs/security-followups.md:23-33`.

#### 2.5 Instance access tokens (per-assessment secure links)

| Item | Evidence |
|---|---|
| Table `skyline_instance_access_tokens(id, instance_id FK cascade, role_context student/trainer/office, token UNIQUE, expires_at, consumed_at, revoked_at, created_at)` | `supabase/migrations/20260225000004_create_instance_access_tokens.sql:2-11` |
| Token = 24 random bytes hex, generated **in the browser** | `src/lib/formEngine.ts:1585-1589` |
| Issue: student links expire at the instance deadline (Melbourne end-of-day of `COALESCE(extension_date,end_date)`), blocked when outside `[start_date, deadline]` or when course lifecycle denies; trainer/office default 90 days, student fallback 30 days; URL `/instances/{id}?token=...` | `formEngine.ts:1628-1694` |
| Validate: revoked / consumed / expired, student inactive, `did_not_attempt`, date window, course lifecycle | `formEngine.ts:1831-1947` |
| Consume / revoke / extend / sync-to-deadline / allow resubmission | `formEngine.ts:1949-2091` |
| Page resolves the acting role from the token (`setRole(tokenRole)`), admin edit mode via `?admin=1` | `src/pages/InstanceFillPage.tsx:658,713-722,519` |
| Student final submit revokes student tokens | `src/pages/InstanceFillPage.tsx:2526-2532` |

All of this is client-side logic reading/writing the tokens table with the anon key; nothing server-side ties a token to the HTTP caller.

#### 2.6 Impersonation / preview

| Feature | Client | Server |
|---|---|---|
| Superadmin "Open as user" (preview another **staff** user in a new tab) | `src/pages/AdminUsersPage.tsx:283-296,442-447` queues the payload in `localStorage` (`signflow_staff_impersonation_pending_v1`, 120 s TTL) and the new tab moves it to `sessionStorage['signflow_staff_impersonation_v1']`: `src/lib/formEngine.ts:2388-2499`; `AuthContext` exposes `isImpersonating` / `exitImpersonation`: `src/contexts/AuthContext.tsx:20-23,64-67`; banner + "Exit preview" in `src/layouts/AdminLayout.tsx:105-106,289,340-343` | Session token stays the superadmin's; trainer RPCs accept `p_as_user_id` only from a superadmin (`skyline_staff_acting_as`, `PT403` otherwise): `supabase/migrations/20261110000005_preview_as_user.sql:22-48`; client adds it via `previewAsUserParam` `formEngine.ts:2603-2607`. Not superadmin-only on the client: the button is only disabled for superadmin targets and self (`AdminUsersPage.tsx:442`). |
| "Login as student" (staff opens a student dashboard) | `canLoginAsStudent` 2610-2621 (button visibility), `loginAsStudentViaServer` 2624-2643, `openStudentDashboardAsStaff` 2665-2685 writes the student `sessionStorage` blob with `by: <staff id>` and `window.open('/student/dashboard')`. UI: `src/pages/AdminStudentDetailsPage.tsx:228,1437,1584`, `src/pages/TrainerStudentDetailsPage.tsx:39-53,113` | Rule `skyline_staff_may_login_as_student`: superadmin, or admin with `can_login_as_student`, or a trainer of the student's batch when `skyline_batches.allow_trainer_student_login` is true: `20261110000001:119-155`. `skyline_login_as_student` authorises, writes `impersonation_logs` (actor, acting_as, target, batch, ip from `cf-connecting-ip`/`x-forwarded-for`, user agent): `20261110000005:213-269`; log table `20261110000001:43-62` (+ `acting_as_*` `20261110000005:14-19`); reader `skyline_list_impersonation_logs` admin/superadmin only `20261110000005:275-320` — **no UI yet** (`docs/security-followups.md:81-85`). |
| Batch flag | `src/pages/AdminBatchesPage.tsx:258-259,324-326` via `setBatchTrainerStudentLogin` `formEngine.ts:2646-2659` | `skyline_set_batch_trainer_student_login` admin/superadmin: `20261110000001:368-400`; SECURITY INVOKER trigger rejects direct anon writes to the flag: `20261110000001:466-487`. |

Audit side effect: `getAuditFields()` uses the **effective** (previewed) user for `created_by`/`updated_by` (`src/lib/formEngine.ts:2834-2838`), so table-level audit columns record the previewed user, while `impersonation_logs` records the real actor.

#### 2.7 Identity model

| Entity | Table | Key columns | Notes |
|---|---|---|---|
| Staff | `skyline_users` (renamed from `skyline_trainers`) | `id BIGINT identity, full_name, email NOT NULL UNIQUE, phone, status active/inactive, role, password_hash, is_master, can_login_as_student, can_login_as_trainer, can_view_finance_reports, created_at, updated_at, updated_by` | Create `supabase/migrations/20260225000003_create_trainers_table.sql:2-10`; rename + role + password `20260302000003_rename_trainers_to_users_add_auth.sql:5-10`; role check widened to `superadmin/admin/trainer/office` `20260405000001_superadmin_role.sql:3-6`; `is_master` `20260313000001:14`; rights `20260429130500_user_impersonation_rights.sql:2-4`, `20260529110000_user_finance_reports_right.sql:2-3`; readable columns list `20261110000002:18-32`. Email is unique (table constraint) and normalised to lower-case by the admin RPCs (`20261110000003:71,157`). |
| Students | `skyline_students` | `id BIGINT identity, name, email NOT NULL, created_at` + `student_id TEXT` (external Contact ID), `first_name, last_name, phone, date_of_birth, address_*, city, state, postal_code, country, guardian_name, guardian_phone, notes, status default 'active'`, `batch_id`, `password_hash`, audit cols | `20250211000001_add_students.sql:2-9`, `20260225000005:2-6`, `20260227000001:2-16`, `20260302000002:12-13`, `20260306000001:5-6`, `20260314000001:75-79`. **`email` has only a non-unique index** (`20250211000001:9`); `student_id` has a case-insensitive partial unique index (`20260615200000:17-19`). OTP verify joins on `lower(email)` and the client takes `rows[0]` (`formEngine.ts:1706-1708,2242-2246`), so duplicate student emails would silently log in the first match. |
| `auth.users` | not used | | No `auth.uid()` in any migration; no `supabase.auth` in `src/`. |
| Master admin | `skyline_users.is_master` + hard-coded address | | Inserted by migration `20260313000001:16-19`; exempt from the domain check in `src/lib/emailUtils.ts:5-6,38`. Password bypass path is now revoked (`20261110000002:8`). |
| Student <-> staff | disjoint tables; a staff account can never be a login-as target (`20261110000001:116-118`). | | |

---

### 3. Roles and permissions

#### 3.1 Role vocabulary

| Role / right | Stored where | Meaning | Evidence |
|---|---|---|---|
| `superadmin` | `skyline_users.role` | Everything incl. form builder, user rights, "Open as user", login-as-student, finance, deletes | `src/lib/formEngine.ts:2347`, `src/components/SuperAdminOnlyRoute.tsx:10`, `supabase/migrations/20261110000003:63-67,194-199` |
| `admin` | `skyline_users.role` | All admin pages except builder; payment plans; finance reports only with `can_view_finance_reports`; login-as-student only with `can_login_as_student`; may create trainer/office users and edit them, not other admins | `src/lib/formEngine.ts:2362-2377`, `20261110000003:46-48,63-67,200-204` |
| `trainer` | `skyline_users.role` | Trainer dashboard, course units, unit submissions, "My students"; every `AdminOnlyRoute` bounces them | `src/components/AdminOnlyRoute.tsx:8-9`, `src/layouts/AdminLayout.tsx:45,67-71` |
| `office` | `skyline_users.role` | Treated like admin by the route guards (only trainers are redirected); gets admin nav + Enrollment; blocked from finance (payment plans admin/superadmin only; finance reports superadmin/admin-with-right) | `src/components/AdminOnlyRoute.tsx:5-9`, `src/layouts/AdminLayout.tsx:72-81,96-98`, `src/lib/formEngine.ts:2371-2377`, `SKYLINE_SUBMISSIONS_PROCESS_FLOW.md:39` |
| `is_master` | `skyline_users.is_master` | Legacy password bypass (now unreachable) and "exclude from user listing hints" | `20260313000001:13-19` |
| `can_login_as_student` | `skyline_users` bool | Admin may open student dashboards | `20260429130500:3`, `20261110000001:135` |
| `can_login_as_trainer` | `skyline_users` bool | Stored and returned, but the UI sets it equal to `can_login_as_student` and no server rule reads it | `src/pages/AdminUsersPage.tsx:227-228,251-252`; grep: only read in login RPCs |
| `can_view_finance_reports` | `skyline_users` bool | Admin may open Finance Reports (superadmin always true) | `20260529110000:2-8`, `src/lib/formEngine.ts:2362-2369` |
| Form roles `student / trainer / office` | `skyline_form_questions.role_visibility` / `role_editability` JSONB and the token's `role_context` | Per-question visibility/editability inside an instance; independent of staff role | `src/utils/roleGuard.ts:1-19`, `supabase/migrations/20250211000000:56-57`, `src/pages/InstanceFillPage.tsx:713-722` |
| Legacy `Role`/`RoleScope` | `src/types/index.ts:1-3`, `src/utils/roleUtils.ts:3-24` | Used only by the JSON-schema wizard (`/legacy`, `FormView`, `FormPage`) | `src/App.tsx:166` |
| Student | not a `skyline_users` role; identity is a `skyline_students` row in `sessionStorage` | | `src/pages/StudentDashboardPage.tsx:183,218-226` |

#### 3.2 Route guards (client only)

| Guard | Logic | File |
|---|---|---|
| `ProtectedRoute` | `user` from context must exist, else `/login` | `src/components/ProtectedRoute.tsx:10-23` |
| `AdminOnlyRoute` | redirects **only** `role === 'trainer'` to `/admin/dashboard` | `src/components/AdminOnlyRoute.tsx:6-11` |
| `SuperAdminOnlyRoute` | trainer -> dashboard; non-superadmin -> `/admin/forms` (wraps the form builder only) | `src/components/SuperAdminOnlyRoute.tsx:6-12`, `src/App.tsx:122` |
| `FinanceReportsRoute` / `PaymentPlansRoute` | `canViewFinanceReports` / `canManagePaymentPlans` | `src/components/FinanceReportsRoute.tsx:7-14`, `src/components/PaymentPlansRoute.tsx:7-14` |
| `DashboardOrFormsRedirect` | trainer -> `/admin/dashboard`, others -> `/admin/overview` | `src/App.tsx:71-76` |
| Page-level | `TrainerCourseUnitsPage` and `TrainerUnitSubmissionsPage` bounce non-trainers | `src/pages/TrainerCourseUnitsPage.tsx:126`, `src/pages/TrainerUnitSubmissionsPage.tsx:172` |
| Nav | trainer nav: Dashboard, Course units, My students; staff nav: Overview, Reports, Forms, Students, Batches, Courses, Users, Assessments (+ Finance children, + Enrollment for admin/office/superadmin) | `src/layouts/AdminLayout.tsx:67-98` |

#### 3.3 Server-side enforcement

**Token-checked RPCs (caller resolved from `p_token`):** `skyline_logout`, `skyline_can_login_as_student`, `skyline_login_as_student`, `skyline_set_batch_trainer_student_login`, `skyline_list_impersonation_logs` (`20261110000001:291-457`), `skyline_admin_create_user`, `skyline_admin_update_user` (`20261110000003:17-241`), `skyline_trainer_list_my_students`, `skyline_trainer_get_student` (`20261110000004:32-152`, re-declared with `p_as_user_id` in `20261110000005:54-181`), `skyline_trainer_list_my_batches` (`20261110000007_my_students_batch_filter.sql:14-48`). Internal helpers revoked from clients: `skyline_issue_staff_session`, `skyline_staff_from_token`, `skyline_staff_may_login_as_student`, `skyline_staff_trains_batch`, `skyline_staff_acting_as` (`20261110000001:157-159`, `20261110000004:29`, `20261110000005:48`).

**Everything else is enforced by the UI only.** Examples traced:

| Operation | Mechanism | Caller check? | Evidence |
|---|---|---|---|
| Read/write forms, questions, instances, answers, results, students, batches, courses, tokens | direct PostgREST on tables (37 tables touched from `src/`) | none (anon role, no RLS) | grep of `.from('...')` across `src/`; `README.md:10` |
| Admin dashboard stats | `skyline_admin_dashboard_stats_v2` SECURITY DEFINER | none; granted to anon/authenticated | `20260330160001_admin_dashboard_stats.sql:141-142`, `20260512120000:3-13` |
| Assessment directory | `skyline_list_submitted_instances_paged` (15 params) | none; GRANT to `authenticated` but EXECUTE defaults to PUBLIC (no REVOKE) | `20260723120000_assessment_search_student_id_unit_code.sql:12-28,289-291`; PUBLIC default explained in `20261110000002:5-6` |
| Student final submit | `skyline_submit_instance_to_trainer(p_instance_id, p_request_id)` SECURITY DEFINER, granted anon | none (any caller can submit any instance) | `20260917123000:97-247` |
| Delete student / batch | `skyline_admin_delete_student_if_no_assessments`, `skyline_superadmin_delete_student`, `skyline_superadmin_delete_batch` | none (no `p_token`, no role lookup) | `20260418000011_admin_delete_student_and_batch.sql:5-40`; grep of `20260421000002` shows no role/token reference |
| Batch membership | `skyline_update_batch_student_assignments`, direct writes to `skyline_batches`, `skyline_batch_trainers`, `skyline_students.batch_id` | none | `20260615200000:37-98`, `docs/security-followups.md:51-65` |
| Course enrolment | `skyline_upsert_student_course_enrollment`, `skyline_import_student_course_timetable` (take `p_actor_user_id` from the client) | none | `20260713140000:237-249,403-406`, `20260720044631:5-11` |
| Instance dates / extensions / tokens | direct `UPDATE skyline_form_instances`, `skyline_instance_access_tokens` | none | `src/lib/formEngine.ts:1389-1430,1681-1686` |
| Payment edge functions | `skyline-record-student-payment`, `skyline-upload-payment-receipt` look up `skyline_users.role` for a **client-supplied `staffUserId`** and require admin/superadmin | id is trusted from the body | `supabase/functions/skyline-record-student-payment/index.ts:129-173`, `supabase/functions/skyline-upload-payment-receipt/index.ts:152-200`, `docs/security-followups.md:67-72` |
| `send-notification` | inserts rows for any `userIds` given | none beyond the gateway JWT | `supabase/functions/send-notification/index.ts:148-186` |

**RLS actually enabled (with no client policies, i.e. closed to clients):** `skyline_staff_sessions`, `impersonation_logs` (`20261110000001:34-35,60-62`), `skyline_submission_events` (`20260917123000:91-94`), `skyline_induction_sessions`/`skyline_induction_submissions` (`20260330000002:30-31`), `student_enrolment_applications` (`20260514120000:29`), finance tables `ax_*`, `skyline_student_payment_transactions`, `skyline_payment_receipts`, `skyline_student_payment_allocations` (SELECT policies only: `20260727150000:457-468`, `20260729035851:70-73`). Storage policies exist only for the enrolment-documents bucket (`20260514120000:198-203`).

Other DB-level guards: trigger `skyline_batches_guard_login_flag` (`current_user IN ('anon','authenticated')` check, `20261110000001:466-487`); trigger `skyline_students_batch_course_check` (student must be actively enrolled in the batch's course, `20260615210000:2-43`); course lifecycle validation trigger (`20260713140000:153-232`); `skyline_users_revoke_sessions` (`20261110000001:505-514`).

---

### 4. Dashboards

#### 4.1 Admin overview (`/admin/overview`, `AdminOnlyRoute`)
- Page `src/pages/AdminDashboardPage.tsx`; Melbourne time presets (today / this week / last week / this month / last month / custom) `:17-41`; donut tiles `:46-...`; cards link to assessments / students / users `:320-359`.
- Stats: `getAdminDashboardStatsV2` (`AdminDashboardPage.tsx:122`; `src/lib/formEngine.ts:3411-3468`, 60 s cache) -> RPC `skyline_admin_dashboard_stats_v2(p_from_date, p_to_date, p_status, p_batch_id)` `supabase/migrations/20260512120000_admin_dashboard_stats_batch_filter.sql:3-86`. Totals: active students, users with role trainer, users with role admin/superadmin, instances of active students. Workflow buckets use **legacy** columns: awaiting_student = `status='draft'`; awaiting_trainer = `role_context='trainer' and status<>'locked'`; awaiting_office = `role_context='office' and status<>'locked'`; completed = `status='locked'` (`:55-60`).
- Table: `listAdminDashboardInstancesPaged` (`AdminDashboardPage.tsx:144`; `formEngine.ts:3470-3500`) -> RPC `skyline_admin_dashboard_instances_paged(p_page, p_page_size, p_status, p_from_date, p_to_date, p_batch_id)` returning batch and trainer names `20260507140000_admin_dashboard_batch_filter_and_trainer.sql:3-30` (plain `LANGUAGE plpgsql STABLE`, not SECURITY DEFINER).
- Batch filter via `listBatches` `:177`; row link via `getOrIssueInstanceAccessLink` `:13`.
- Legacy v1 RPC `skyline_admin_dashboard_stats` (`20260330160001`, re-declared `20260405000001:76-207`) and its client `getAdminDashboardStats` (`formEngine.ts:7580`) have no page caller -> unused.

#### 4.2 Trainer / office dashboard (`/admin/dashboard`)
- `src/pages/DashboardPage.tsx:66` derives `role = user.role === 'trainer' ? 'trainer' : 'office'` (admins/superadmins see the office queue here).
- Queue: `listDashboardInstances(role, user.id, page, 20, search, pendingOnly, batchId)` `:98-101` -> `src/lib/formEngine.ts:4037-...`: trainer scope = students whose `batch_id` is in `fetchBatchIdsForTrainer` (primary `skyline_batches.trainer_id` + `skyline_batch_trainers`, `formEngine.ts:3123-3149`); office scope = all active students; then direct `skyline_form_instances` query with search over student id / name / email / batch / unit code. Pending count `getDashboardPendingCount` `:4552-4590`.
- Batch filter: trainers `listTrainerBatches` (`:4492-4505`), office `listBatches` (`DashboardPage.tsx:102-103`).
- Outcome labels from `skyline_form_assessment_summary_data` via `fetchAssessmentSummaries` (`DashboardPage.tsx:8`), masking "competent" while awaiting trainer (`src/utils/assessmentRowUi.ts`).
- `TrainerGradeMePanel` (`DashboardPage.tsx:262-263`; `src/components/trainer/TrainerGradeMePanel.tsx`): loads up to 2000 pending instances via `listTrainerPendingForGradeMePanel` (`formEngine.ts:4308-4328`), groups by batch, issues a trainer token and opens the instance in a new tab (`TrainerGradeMePanel.tsx:150`).
- `FormDocumentsPanel` for learning docs is embedded in both dashboards (`DashboardPage.tsx:34`).

#### 4.3 Trainer course units / unit submissions
- `src/pages/TrainerCourseUnitsPage.tsx`: `listTrainerCourseOptionsForUnits` (courses of the trainer's batches, `formEngine.ts:4515-4544`) + `listTrainerBatches` `:39`; `getFormsForCourse(cid, {asAdmin:false})` `:69` lists active forms (units) of the course; links to `/admin/course-units/:formId/submissions`; guard `:126`.
- `src/pages/TrainerUnitSubmissionsPage.tsx`: `listTrainerUnitInstancesPaged(uid, formId, page, 20, q)` `:77` -> `formEngine.ts:4330-4400` (direct query, restricted to students in the trainer's batches); issues a trainer link `:166`; imports `updateFormInstanceDates` and `extendInstanceAccessTokensToDate` (`:11-16`), i.e. trainers can change instance dates from this page; guard `:172`.

#### 4.4 Trainer "My students"
- `src/pages/TrainerMyStudentsPage.tsx:36,49`: `listMyBatchesForTrainer` / `listMyStudentsForTrainer` (`formEngine.ts:2726-2782`) -> token-checked RPCs `skyline_trainer_list_my_batches`, `skyline_trainer_list_my_students(p_token, p_search, p_limit, p_offset, p_as_user_id, p_batch_id)` (`20261110000007:14-60`). 25 per page, server-side search.
- `src/pages/TrainerStudentDetailsPage.tsx:39,53`: `getMyStudentForTrainer` (RPC `skyline_trainer_get_student`, `PT403` outside own batches `20261110000005:122-181`) and "Login as student".

#### 4.5 Student dashboard (`/student/dashboard`, public route)
- `src/pages/StudentDashboardPage.tsx:218-226` reads `studentId` from `sessionStorage` (no server check; anyone can set it — `docs/security-followups.md:12-21`).
- Data: `listStudentAssessmentsPaged(studentId, 1, PAGE_SIZE)` `:235` -> `formEngine.ts:1713-1830`: one PostgREST select on `skyline_form_instances` embedding answer/assessment counts, summary results, student and form (`:1724-1727`), then token state from `skyline_instance_access_tokens` (`:1753-1760`). Profile loaded directly from `skyline_students` `:260`. Course enrolments via `listStudentCourseEnrollments` (`:3`). Opening an assessment issues a fresh student token `:360`.
- Access rules: `studentMayOpenAssessment` / `studentMayMutateAssessment` / `evaluateStudentCourseRunningAccess` (`src/lib/studentAssessmentAccess.ts:175,404-410`) — students may open only when the course enrolment is `in_progress` with dates and today inside them.
- Whole dashboard is wrapped in `NotificationAcknowledgmentGate` (`:833-835`) and shows `NotificationBell` (`:31`), `StudentQualificationsPanel`, `FormDocumentsPanel`.
- Logout clears the key `:669`.

#### 4.6 `FormsListPage` / `FormStartPage`
- `src/pages/FormsListPage.tsx` lists published forms and links to `/forms/:id/start`, but it is **not imported by `App.tsx`** (only `AdminFormsListPage` is, `src/App.tsx:19`) -> unused.
- `src/pages/FormStartPage.tsx:26-37` **is** routed publicly (`src/App.tsx:94`): it lets any visitor choose a role (student / trainer / **office**), create a new `skyline_form_instances` row (`createFormInstance`, no `student_id`) and receive a signed link. Legacy demo path that still works against production tables.

---

### 5. Course / unit / batch model

#### 5.1 Tables and FKs

| Table | Columns (type, FK) | Evidence |
|---|---|---|
| `skyline_forms` (one form = one unit of competency assessment) | `id`, `name`, `version`, `status` draft/published/archived, `unit_code`, `header_asset_url`, `cover_asset_url`, `created_at`; `qualification_code`, `qualification_name`, `unit_name`; `start_date`/`end_date` TEXT (legacy, no longer drives access); `active` bool (false = admin-only); `learning_material_urls TEXT[]`; `created_by/updated_by FK skyline_users`, `updated_at` | `20250211000000:7-16`, `20250213000003:2-4`, `20260302000001:3-5` (+ `src/lib/formEngine.ts:1677-1678`), `20260321000001:2-3`, `20260525100000:2-3`, `20260314000001:14-18`; TS type `src/types/database.ts:6-42` |
| `skyline_form_steps` -> `skyline_form_sections` -> `skyline_form_questions` -> `skyline_form_question_options` / `skyline_form_question_rows` | cascade FKs; `sections.pdf_render_mode` enum incl. `assessment_tasks`, `task_instructions`, `task_questions`, `task_results`, `assessment_summary`, later `task_marking_checklist`, `additional_instructions`; `sections.assessment_task_row_id`, `instructions_meta`; `questions.type` enum, `role_visibility`, `role_editability`, `pdf_meta` JSONB | `20250211000000:19-87`, `20250220000001:2-9`, `20260322000001`, `20260409000002`, `src/types/database.ts:43-149` |
| `skyline_courses` (qualification) | `id`, `name`, `sort_order`, `created_at`, `qualification_code`, audit cols | `20260310000004:2-9`, `20260327000001:2-5`, `20260314000001:93-98`; TS `formEngine.ts:6162-6169` |
| `skyline_course_forms` | `(course_id FK courses cascade, form_id FK forms cascade)` PK — many-to-many course<->unit | `20260310000004:12-18` |
| `skyline_batches` | `id`, `name`, `trainer_id FK skyline_users RESTRICT` (primary trainer), `created_at`, `course_id FK courses RESTRICT`, `allow_trainer_student_login` bool, audit cols | `20260302000002:2-9`, `20260326000002:2-5`, `20261110000001:15-19`, `20260314000001:81-86`; TS `formEngine.ts:3088-3102` |
| `skyline_batch_trainers` | `(batch_id FK batches cascade, user_id FK users RESTRICT)` PK; primary trainer is also copied here | `20260530120000:3-21` |
| `skyline_students.batch_id` | `FK skyline_batches RESTRICT`; one batch per student; trigger requires an active `skyline_student_courses` row for the batch's course | `20260302000002:12-15`, `20260615210000:2-43`, RPC `skyline_update_batch_student_assignments` `20260615200000:37-98` |
| `skyline_student_courses` (enrolment) | `(student_id FK cascade, course_id FK cascade)` PK, `status` active/inactive (link), `start_date`, `end_date`, `enrollment_status` tentative/in_progress/suspended/cancelled/completed, `completed_at`, `intake_label`, `enrollment_status_changed_at/by`, audit cols; partial unique index: one `in_progress` per student; trigger forbids overlapping date ranges across a student's non-cancelled courses | `20260409000003:4-18`, `20260614120000:3-15`, `20260713140000:11-32,146-148,153-232`; client state machine `src/lib/courseLifecycle.ts:36-42` |
| `skyline_form_instances` (assessment attempt record, student x unit) | `id`, `form_id FK forms cascade`, `student_id FK students SET NULL`, `status` draft/submitted/locked/incomplete, `role_context` student/trainer/office, `workflow_status` draft/waiting_trainer/waiting_office/completed/failed/awaiting_submission, `trainer_checked_at`, `office_checked_at`, `created_at`, `submitted_at`, `submission_count` (0-3), `start_date`/`end_date` DATE, `extension_date` DATE (>= end_date, mirror trigger), `no_attempt_rollovers`, `did_not_attempt`, `admin_reference_note`, `trainer_nyc_assessed_on_1..3`, audit cols | `20250211000000:90-99`, `20250211000001:12-15`, `20260227000002:3-9`, `20260422000001:31-33`, `20260917123000:12-30`, `20260325000001:2-3`, `20260326000004:3-8` -> DATE `20260415000005`, `20261105000001:24-70` (header says "DRAFT — run by hand", `:1`), `20260424000001:4-6`, `20260519120000:3-4`, `20260520140000:4-7` |
| Answers / results | `skyline_form_answers` (unique per instance+question[+row], `value_text/number/json`), `skyline_form_trainer_assessments` (per question yes/no), `skyline_form_trainer_row_assessments` (per grid row), `skyline_form_results_data` (per task section: attempts 1-3 s/ns, dates, feedback, trainer name/signature/date), `skyline_form_results_office` (per section: `entered_date`, `entered_by`, `initial_checked`, `updated_checked`), `skyline_form_assessment_summary_data` (one per instance: `final_attempt_1..3_result` competent/not_yet_competent, trainer/student sig+date x3, `student_overall_feedback`, `admin_initials`, `admin_initial_checked`, `admin_updated_checked`) | `20250211000000:102-116`, `20250217000001:2-11`, `20260309000001:3-13`, `20250219000001:2-19` + `20260310000001:2-5`, `20250218000001:2-12` + `20260530140000:3-5`, `20250220000001:12-38` + `20260530140000:7-9` |
| Workflow audit / artefacts | `skyline_submission_events` (instance, student, event_type, request_id unique per instance, success, error); `skyline_instance_access_tokens`; `skyline_generated_pdfs` (instance x role unique, `pdf_status` pending/generating/uploaded/failed/stale, SharePoint ids/urls, retry/lock fields) | `20260917123000:70-85`, `20260225000004:2-11`, `20260703180000:7-32` |

#### 5.2 Instance lifecycle (server pieces)
- Creation: `createFormInstance(formId, roleContext, studentId?, {start_date,end_date})` defaults start=today, end=+30 days Melbourne (`src/lib/formEngine.ts:1295-1335`); bulk creation per course/unit through `upsertStudentAssessmentsForCourse`/`upsertStudentAssessmentsForForms` (`:6331,6376`) and the timetable import RPC (`20260720044631:5-16`).
- Student final submit: `skyline_submit_instance_to_trainer(p_instance_id, p_request_id)` row-locked, idempotent per `request_id`, writes `skyline_submission_events`, sets `status='submitted', role_context='trainer', workflow_status='waiting_trainer'`, caps `submission_count` at 3 (`20260917123000:97-243`); client `submitInstanceToTrainerViaRpc` `formEngine.ts:7259`, called from `src/pages/InstanceFillPage.tsx:2526-2545`.
- Trainer / office transitions are **client-side updates** via `updateInstanceWorkflowStatus` mapping workflow -> legacy `status`/`role_context` (`formEngine.ts:7327-7380`), invoked at `InstanceFillPage.tsx:2600,2624,2646,2668`. NYC attempts record `trainer_nyc_assessed_on_n` and give the student a +5 day window (`formEngine.ts:1523-1546`).
- Trigger `skyline_auto_assign_trainer_on_student_submit` moves draft->submitted rows to `role_context='trainer'` when the student's batch has a trainer (`20260421000004:5-38`).
- Rollover: `skyline_run_scheduled_no_attempt_rollover` scheduled by `pg_cron` every 15 min, `skyline_sync_no_attempt_rollover` revoked from clients (`20260917123000:482-541`); older client-callable version `20260424000001:10-81`. The file is marked "Review-only migration: do not apply to production until approved" (`20260917123000:2`).
- Completion -> PDF: trigger `skyline_enqueue_pdf_on_instance_complete` (locked + completed) inserts a pending `skyline_generated_pdfs` row and best-effort `pg_net` POSTs `trigger-pdf-worker` using Vault secrets `project_url`, `service_role_key`, `pdf_worker_cron_secret` (`20260706140000:13-120`). Worker: `pdf-server/pdfWorker.ts` (1 job at a time, 3 retries, 30-min stale lock, `:7-14`).

#### 5.3 Batch unit dates (admin)
- `src/pages/AdminBatchUnitDatesPage.tsx` (route `/admin/batches/:batchId/unit-dates`, `src/App.tsx:127-130`): tabs Students / Assessment; filters From/To, unit, open-ended mode (`:43-50`); loads roster via `listStudentsInBatch` `:151`; eligibility via `fetchBatchAssessmentOptions` `:217` (`formEngine.ts:4694-4770`) -> RPC `skyline_batch_assessment_options(p_batch_id, p_course_id, p_from_date, p_to_date, p_start_only_null_end, p_open_null_end_exact, p_page, p_page_size, p_form_id)` returning `{students (page), units, student_units, students_total, eligible_student_ids}`; latest definition `20260418000009_batch_assessment_options_server_pagination.sql:4-119` (12 successive redefinitions since `20260415000003`). Mass-save creates missing instances (`createFormInstance`/`getInstanceForStudentAndForm`, `:8-9`) and sets dates via `updateFormInstanceDates` `:348` (which auto-resets terminal rollover state when `end_date` changes, `formEngine.ts:1389-1430`), then `extendInstanceAccessTokensToDate` `:11`.
- `skyline_batch_assessment_eligibility(p_batch_id, p_course_id, p_from_date, p_to_date)` returns `(student_id, form_id, form_name)` (`20260415000002:3-42`, DATE version `20260415000006:4-40`) — **not called from `src/`** (grep of `.rpc(` names) -> unused by the frontend.

---

### 6. Notifications and emails

| Piece | Evidence |
|---|---|
| `skyline_push_tokens(id uuid, user_id TEXT, fcm_token, platform, browser, is_active, created_at, updated_at)` unique (user_id, fcm_token) | `20260429154000_notifications_push_tables.sql:2-12` |
| `skyline_notifications(id uuid, user_id TEXT, title, message, url, type, is_read, created_at, read_at)`; added to the `supabase_realtime` publication | `20260429154000:15-29`, `20260430120000:3-18` |
| `skyline_assessment_acknowledgments(student_id FK, instance_id, form_name, outcome_label, outcome_kind, acknowledged_at)` unique (student, instance); full CRUD granted to anon | `20260613120000_assessment_acknowledgments.sql:3-17` |
| Edge `send-notification`: body `{userIds[], title, message, url?, type?}`; inserts in-app rows first, loads active tokens, mints a Google OAuth JWT (RS256) from `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`, sends FCM v1 per token, deactivates `UNREGISTERED`/`INVALID_ARGUMENT` tokens; push failure never fails the request | `supabase/functions/send-notification/index.ts:9-15,167-181,185-186,193-197,34-90,101-133,241-284`; docs `docs/firebase-notification-setup.md:1-40` |
| Client invocation (fire-and-forget) | `invokeWorkflowSendNotification` `src/lib/formEngine.ts:7802-7824`; recipients from `getInstanceWorkflowNotificationContext` `:7760-7800` (student -> `String(skyline_students.id)`, trainers -> primary + `skyline_batch_trainers`); called on student submit, NYC, failed, to-office, completed: `src/pages/InstanceFillPage.tsx:2543,2609,2633,2655,2675` |
| Type -> visual mapping (`workflow_completed`, `workflow_failed`, `workflow_resubmit`, `workflow_student_submit`, `workflow_to_office`, text heuristics) | `src/utils/notificationOutcome.ts:49-86` |
| Bell: last 10 rows + unread count (30 s cache), realtime-driven refresh; mark read / mark all read | `src/services/notifications.ts:47-127`, `src/components/NotificationBell.tsx:75,217,228`; staff `AdminLayout.tsx:317,330`, student `StudentDashboardPage.tsx:31` |
| Acknowledgment gate: student dashboard is blurred and locked until every unread notification is marked read and every changed assessment outcome is acknowledged (upsert into acknowledgments) | `src/components/NotificationAcknowledgmentGate.tsx:60-93,121-124,128-245`, `src/services/notifications.ts:129-226`, `StudentDashboardPage.tsx:833-835` |
| Push registration: SW `/firebase-messaging-sw.js`, VAPID from `VITE_FIREBASE_VAPID_KEY`, token upsert, session/local caching to avoid repeat writes, foreground `onMessage` | `src/services/pushNotificationService.ts:45-53,74-171`, `src/lib/firebase.ts:4-33`, `public/firebase-messaging-sw.js` |
| Notifications page `/admin/notifications` | `src/App.tsx:111`, `src/pages/NotificationsPage.tsx` |
| Emails (Postmark only): OTP (staff/student/induction) and enrolment submission (PDF + uploaded documents to applicant, admissions inbox `ENROLMENT_ADMISSIONS_EMAIL`, optional agent) | `supabase/functions/skyline-send-enrolment-email/index.ts:1-27`, `postmarkEnrolment.ts`; `docs/POSTMARK_OTP.md:64-82`; invoked from `src/lib/enrolmentApi.ts:138` |
| No email on assessment workflow events; only in-app + push. | `src/lib/formEngine.ts:7802-7824` |

**Surprise:** `skyline_notifications.user_id` / `skyline_push_tokens.user_id` are free TEXT that hold `skyline_users.id` for staff and `skyline_students.id` for students (`formEngine.ts:7752-7753`, `StudentDashboardPage.tsx:833`, `AdminLayout.tsx:317`). The two id spaces overlap, so staff user 7 and student 7 would read each other's notifications and push tokens. Also any client can insert/read/update notifications directly (no RLS; `NotificationBell.tsx:217,228`).

---

### 7. Reports, exports and audit logs

| Item | Evidence |
|---|---|
| Assessment Reports page `/admin/reports/assessments` (AdminOnly) = `src/pages/admin/reports/AssessmentReports.tsx` re-exported by the 1-line `src/pages/AdminAssessmentReportsPage.tsx` | `src/App.tsx:157-164`, `src/pages/AdminAssessmentReportsPage.tsx:1` |
| Data: `fetchAssessmentReportPage(filters, page, pageSize)` -> `listSubmittedInstancesPaged` (RPC `skyline_list_submitted_instances_paged`, sorted by student) then batch names via `skyline_students -> skyline_batches(name)`; export fetches every page of 500 | `src/services/assessmentReports.ts:104-146,48-72` |
| Export: SheetJS `.xlsx` named `assessment-reports-YYYY-MM-DD.xlsx`, columns Instance ID, Student, Unit, Start, End, Status, Batch | `src/services/assessmentReports.ts:148-188` |
| Status rule: `locked` and not did-not-attempt -> Completed; did-not-attempt or past effective end date -> Failed; else In Progress | `src/utils/assessmentReportStatus.ts:7-28` |
| Assessment directory `/admin/assessments` (filters, links, revoke/resubmission, quick edit) | `src/pages/AdminAssessmentsPage.tsx:5-19,308,363-374,912,992,1637` |
| `skyline_course_link_exports(id, course_id FK, batch_id FK SET NULL, payload_json, created_at, created_by FK users)` — snapshots of "generic links" PDFs; written/read from the Courses page, rendered with `GenericLinksPdf` (`@react-pdf`) | `20260326000003:2-13`, `src/lib/formEngine.ts:6490-6550`, `src/pages/AdminCoursesPage.tsx:17-18,279-346`, `src/components/pdf/GenericLinksPdf.tsx:34` |
| `skyline_learning_doc_activity(form_id FK, action upload/delete/add_url/remove_url, file_path, file_name, public_url, audience student/trainer, performed_by, performed_by_name, created_at)`; written on learning-document changes | `20260525110000:2-16`, `src/lib/formDocuments.ts:227` |
| Audit columns `created_by`/`updated_by` (FK `skyline_users`) + `updated_at` triggers on forms, steps, sections, questions, options, rows, instances, answers, students, batches, users, courses | `20260314000001_audit_columns_created_updated.sql:5-98`; values come from the client (`getAuditFields` `formEngine.ts:2834-2838`) |
| `impersonation_logs` (login-as-student) and `skyline_submission_events` (final submits) are the only server-written audit tables | sections 2.6 and 5.2 |
| Finance (out of scope, exists): `/admin/finance/reports` and `/admin/finance/payment-plans`; `src/services/financeReports.ts` invokes `axcelerate-finance-reports` (`:167`) and `axcelerate-finance-sync` (`:214`); `src/services/paymentPlans.ts` calls payment edge functions (`:607,721,735`); finance tables `ax_invoices`, `ax_invoice_payments`, `ax_invoice_payment_allocations`, `ax_student_ledger_entries`, `skyline_payment_plans*`, `skyline_student_payment_*`, `skyline_payment_receipts` | `src/App.tsx:136-156`, migrations `20260604120000` .. `20260729035851` |
| Ad-hoc SQL reports | `sql/admin_reports/carpentry_incomplete_student_units.sql`, `sql/admin_reports/course_lifecycle_preflight.sql`; view `skyline_course_lifecycle_preflight` `20260713140000:411-541` |

---

### 8. Edge Functions and tests

#### 8.1 Edge Functions (`supabase/functions/`, Deno, `npm:@supabase/supabase-js@2`)

| Function | Purpose | Auth / env names | Evidence |
|---|---|---|---|
| `skyline-request-otp` | Create OTP via RPC and email it (staff / student / induction by `type`) | gateway JWT only; `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTMARK_*` | `index.ts:13-100`, `postmarkOtp.ts:5-11` |
| `skyline-request-induction-otp` | Induction-only OTP (institutional domains) | same | `index.ts:12-81` |
| `send-notification` | In-app rows + FCM push for `userIds` | none; `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | `index.ts:148-300` |
| `trigger-pdf-worker` | Wakes the Render/Railway pdf-server (`POST {PDF_WORKER_URL}/jobs/process-pdfs`, header `x-worker-secret`) | optional `PDF_WORKER_CRON_SECRET` header check; `PDF_WORKER_URL`, `PDF_WORKER_SECRET` | `index.ts:35-41,50-72` |
| `skyline-send-enrolment-email` | Postmark email with application PDF + Storage attachments | `POSTMARK_*`, `ENROLMENT_ADMISSIONS_EMAIL` | `index.ts:1-27` |
| `skyline-record-student-payment` | Record a payment-plan payment and upload its receipt to SharePoint (MS Graph) | trusts `staffUserId` in body, requires admin/superadmin; `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SHAREPOINT_SITE_URL/SITE_ID/LIBRARY_NAME/PAYMENT_RECEIPTS_DRIVE_ID`, `MAX_RECEIPT_FILE_BYTES` | `index.ts:36-45,129-173` |
| `skyline-upload-payment-receipt` | Upload/replace a receipt for an existing transaction | same model | `index.ts:152-200` |
| `axcelerate-finance-sync` | Pull invoices/payments/ledger from aXcelerate into `ax_*` tables (batched) | `AXCELERATE_API_TOKEN`, `AXCELERATE_WS_TOKEN`, `AXCELERATE_BASE_URL` | `index.ts:1-45` |
| `axcelerate-finance-sync-cron` | Chains sync batches; scheduled daily by `pg_cron` | `FINANCE_SYNC_CRON_SECRET` | `index.ts:1-45`, `20260605100000_ax_finance_sync_daily_cron.sql:85` |
| `axcelerate-finance-reports` | Finance reports from cached `ax_*` tables | service role only | `index.ts:1-45` |

No `_shared/` folder; Postmark helper is duplicated per function (`docs/POSTMARK_OTP.md:50-60`).

#### 8.2 Tests (vitest 4, `npm test` = `vitest run`, no config file -> defaults; 29 spec files, ~370 cases)

| Area | Files | What they cover |
|---|---|---|
| Assessment UI logic | `src/utils/assessmentRowUi.test.ts` (32), `assessmentDeadline.test.ts` (18: `COALESCE(extension_date,end_date)`, mirror rule), `assessmentValidationMessages.test.ts` (13), `assessmentResultValidation.test.ts` (7), `assessmentBatchDisplay.test.ts` (4), `formUnitDisplay.test.ts` (4) | pure functions |
| Workflow / migration | `src/lib/assessmentWorkflowMigration.test.ts` (8) asserts the hardening migration SQL text; `assessmentCompletionStatus.test.ts` (6) | static |
| Course model | `src/lib/courseLifecycle.test.ts` (9), `studentAssessmentAccess.test.ts` (19), `studentBatchValidation.test.ts` (7), `studentImportCourseDates.test.ts` (17), `studentImportEnrollment.test.ts` (10) | pure functions |
| Form builder / answers | `assessmentTaskSteps.test.ts` (13), `contentBlockClone.test.ts` (6), `contentBlockAnswerIsolation.integration.test.ts` (3, mocked client), `questionDuplicate.test.ts` (7), `formAnswerMerge.test.ts` (11), `parseMixedContent.test.ts` (49), `writtenEvidenceChecklist.test.ts` (11), `answerAttachment*.test.ts` (8), `storage.answerAttachment.test.ts` (`it.each`), `QuestionRenderer.attachment.test.tsx` (4) | pure + component |
| Finance | `paymentPlanCalculations.test.ts` (36), `paymentAllocation.test.ts` (10), `paymentReceiptHelpers.test.ts` (21) | pure |
| Infra | `supabaseRequestGuard.test.ts` (4) | backoff/dedupe |
| **Not covered** | auth/OTP, session tokens, route guards, RPC/RLS behaviour, Edge Functions, dashboards, notifications | no SQL test suite exists (`supabase/tests` absent) |

---

### 9. Classification

| Feature | Status | Basis |
|---|---|---|
| Staff OTP login (Edge Function + Postmark + session token) | Implemented | 2.2, 2.3 |
| Student OTP login (dashboard and per-form) | Implemented (no server session) | 2.3, 4.5 |
| Induction OTP + session | Implemented | 2.3 |
| Staff password login / change password | Unused (revoked) | 2.4 |
| Student password login | Unused (RPCs exist, no caller) | 2.4 |
| Instance access tokens (issue/validate/revoke/extend) | Implemented, client-enforced | 2.5 |
| Superadmin "Open as user" preview | Implemented (client + `p_as_user_id`) | 2.6 |
| Login as student + `impersonation_logs` | Implemented; log viewer Missing | 2.6 |
| Batch flag `allow_trainer_student_login` | Implemented (server-guarded) | 2.6, 3.3 |
| Roles superadmin/admin/trainer/office | Implemented (client guards); office == admin on routes | 3.1, 3.2 |
| `can_login_as_trainer` right | Partial (stored, never used) | 3.1 |
| Finance rights (`can_view_finance_reports`, payment plans) | Implemented (client gate; edge functions check role for a client-supplied id) | 3.1, 3.3 |
| Token-checked user management (`skyline_admin_create_user/update_user`) | Implemented; revoke of direct writes Pending | 2.4, 3.3 |
| RLS / server authorisation on assessment data | Missing (anon key, no RLS, SECURITY DEFINER RPCs without caller checks) | 3.3 |
| Admin overview dashboard | Implemented (`stats_v2`, `instances_paged`) | 4.1 |
| Legacy `skyline_admin_dashboard_stats` v1 | Unused | 4.1 |
| Trainer/office dashboard + Grade-me panel | Implemented (direct table queries) | 4.2 |
| Trainer course units / unit submissions | Implemented | 4.3 |
| Trainer "My students" (token RPCs) | Implemented | 4.4 |
| Student dashboard + acknowledgment gate | Implemented | 4.5, 6 |
| `FormsListPage` | Unused (not routed) | 4.6 |
| `FormStartPage` public instance creation | Implemented but legacy/unsafe (public route) | 4.6 |
| `/legacy` JSON wizard (`FormWizardPage`, `FormView`, zustand) | Partial / legacy demo | 1, 3.1 |
| Courses, course_forms, batches, batch_trainers, student_courses lifecycle | Implemented | 5.1 |
| Batch unit dates + `skyline_batch_assessment_options` | Implemented | 5.3 |
| `skyline_batch_assessment_eligibility` RPC | Unused by frontend | 5.3 |
| Idempotent final-submit RPC + `skyline_submission_events` | Implemented (migration flagged review-only) | 5.2 |
| Trainer/office transitions (`updateInstanceWorkflowStatus`) | Implemented client-side; `trainer_checked_at`/`office_checked_at` never written | 5.2, `formEngine.ts:7327-7380` |
| Rollover cron | Implemented (pg_cron) | 5.2 |
| Completed-PDF queue -> worker -> SharePoint | Implemented (needs Vault + worker env) | 5.2 |
| In-app notifications + realtime bell | Implemented | 6 |
| FCM push | Implemented (optional, env-gated) | 6 |
| Assessment Reports page + xlsx export | Implemented | 7 |
| Course link exports | Implemented | 7 |
| Learning document activity log | Implemented | 7 |
| Audit columns | Implemented (client-supplied actor) | 7 |
| Finance reports / payment plans / aXcelerate sync | Implemented (out of scope) | 7, 8.1 |
| Automated tests for auth/RLS/RPC | Missing | 8.2 |

---

### 10. Confirmed vs assumed vs needs runtime access

**Confirmed from source**
- No Supabase Auth; anon key for all browser traffic; session token only for the ten `p_token` RPCs (2.1, 3.3).
- Table shapes, FKs, triggers, grants and revokes exactly as listed, as written in `supabase/migrations/*.sql` and `supabase/pending/*.sql`.
- Role vocabulary, client route guards, nav, rights columns, impersonation and login-as-student rules.
- OTP-generating RPCs are granted to `anon` and return the OTP (2.2).
- `skyline_students.email` is not unique; `skyline_users.email` is.
- Notifications `user_id` namespace is shared between staff and students (6).
- Linked project ref `fvveqziyusjgqejowkfp`.

**Assumed (reasonable inference, not directly observable)**
- Migrations are applied to the hosted DB in filename order and the duplicate-basename pairs (`20260713090704` vs `20260713140000`, empty `20260706083854`) were reconciled by hand; `20261105000001` says it is run manually and `20260917123000` says "review-only" — the applied set may differ from the folder.
- `supabase/pending/20261110000006` is **not** applied (its own header and `docs/security-followups.md:23-28`).
- Function EXECUTE defaults to PUBLIC, so every SECURITY DEFINER RPC without a `REVOKE ... FROM PUBLIC` is callable with the anon key (stated by the project itself in `20261110000002:5-6`).
- `office` users reach every admin page; no code says otherwise.

**Needs runtime access to confirm**
- Actual grants/RLS state on the hosted project (e.g. whether `skyline_request_otp` is still anon-executable, whether `20261110000006` or `20260917123000` were applied).
- Which Edge Functions are deployed and which secrets/Vault entries (`project_url`, `service_role_key`, `pdf_worker_cron_secret`) exist; whether `pg_cron` jobs `skyline-assessment-no-attempt-rollover` and the finance sync are active.
- Whether the pdf-server is deployed on Render or Railway and reachable from `trigger-pdf-worker`.
- Real data quality: duplicate student emails, students without `batch_id`, instances whose `status`/`role_context`/`workflow_status` disagree (the hardening migration repairs some of these, `20260917123000:34-68`).
- Vercel/Railway/Render project linkage (deploy metadata files were intentionally not read).

---

### Appendix A. Route map (`src/App.tsx`)

| Path | Guard | Page | Line |
|---|---|---|---|
| `/login` | none | `LoginPage` (staff OTP, student fallback) | 91 |
| `/` | redirect by role | `DashboardOrFormsRedirect` | 92, 71-76 |
| `/forms` | redirect | -> `/admin` | 93 |
| `/forms/:formId/start` | none | `FormStartPage` (legacy: creates instance for any role) | 94 |
| `/forms/:formId/student-access`, `/student-access?formId=` | none | `StudentAccessPage` (student OTP -> token link) | 95-96 |
| `/student/dashboard` | none (sessionStorage) | `StudentDashboardPage` | 97 |
| `/instances/:instanceId?token=&admin=1` | token | `InstanceFillPage` | 98 |
| `/induction/:token` | induction OTP/session | `PublicInductionPage` | 99 |
| `/enroll-now` | none | `EnrollNowPage` | 100 |
| `/admin` (layout) | `ProtectedRoute` | `AdminLayout` | 101 |
| `/admin/dashboard` | layout | `DashboardPage` (trainer/office queue) | 103 |
| `/admin/course-units`, `/admin/course-units/:formId/submissions` | trainer only (page) | `TrainerCourseUnitsPage`, `TrainerUnitSubmissionsPage` | 104-105 |
| `/admin/my-students`, `/admin/my-students/:studentId` | token RPCs | `TrainerMyStudentsPage`, `TrainerStudentDetailsPage` | 106-107 |
| `/admin/overview` | `AdminOnlyRoute` | `AdminDashboardPage` | 108 |
| `/admin/profile`, `/admin/notifications` | layout | `MyProfilePage`, `NotificationsPage` | 109, 111 |
| `/admin/enrollment`, `/admin/enrollment/induction`, `/admin/enrollment/admissions` | `AdminOnlyRoute` | enrolment hub, inductions, applications | 110, 112-120 |
| `/admin/forms`, `/admin/forms/:formId/preview` | `AdminOnlyRoute` | forms list, preview | 121, 123 |
| `/admin/forms/:formId/builder` | `AdminOnlyRoute` + `SuperAdminOnlyRoute` | `AdminFormBuilderPage` | 122 |
| `/admin/students`, `/admin/students/:studentId` | `AdminOnlyRoute` | students directory / details (login-as-student, courses, payment plans) | 124-125 |
| `/admin/batches`, `/admin/batches/:batchId/unit-dates` | `AdminOnlyRoute` | batches, batch unit dates | 126-130 |
| `/admin/courses`, `/admin/courses/:courseId` | `AdminOnlyRoute` | courses (+ link exports), course students | 131-132 |
| `/admin/users` (`/admin/trainers` redirects) | `AdminOnlyRoute` | users directory, rights, "Open as user" | 133-134 |
| `/admin/assessments` | `AdminOnlyRoute` | assessment directory | 135 |
| `/admin/finance/payment-plans` | `AdminOnlyRoute` + `PaymentPlansRoute` | payment plans | 136-145 |
| `/admin/finance/reports` (`/admin/reports/finance` redirects) | `AdminOnlyRoute` + `FinanceReportsRoute` | finance reports | 146-156 |
| `/admin/reports/assessments` | `AdminOnlyRoute` | assessment reports | 157-164 |
| `/legacy` | none | `FormWizardPage` (JSON-schema demo) | 166 |

### Appendix B. RPCs called from the frontend and their caller check

Source: grep of `.rpc('...')` across `src/` (55 distinct names). "Token" = resolves caller from `p_token`; "none" = no caller identity at all.

| RPC | Caller check | Defined in |
|---|---|---|
| `skyline_verify_otp_login`, `skyline_verify_student_otp`, `skyline_verify_induction_otp` | OTP itself | `20261110000001:226-281`, `20260313000003:48-68`, `20260402000001:54-...` |
| `skyline_logout`, `skyline_can_login_as_student`, `skyline_login_as_student`, `skyline_set_batch_trainer_student_login`, `skyline_trainer_list_my_batches`, `skyline_trainer_list_my_students`, `skyline_trainer_get_student`, `skyline_admin_create_user`, `skyline_admin_update_user` | Token | `20261110000001`, `20261110000003`, `20261110000005`, `20261110000007` |
| `skyline_submit_instance_to_trainer` | none (idempotent by `request_id`) | `20260917123000:97-247` |
| `skyline_sync_no_attempt_rollover` | revoked from clients in `20260917123000:482-485`; the app no longer calls it (the only `src/` reference is the test `src/lib/assessmentWorkflowMigration.test.ts:52`, which asserts `formEngine` does **not** call it); rollover now runs only via `pg_cron` | `20260424000001:10-81`, `20260917123000:488-541` |
| `skyline_admin_dashboard_stats`, `skyline_admin_dashboard_stats_v2`, `skyline_admin_dashboard_instances_paged`, `skyline_list_submitted_instances_paged`, `skyline_form_ids_for_course_active_on`, `skyline_batch_assessment_options` | none | `20260330160001`, `20260512120000`, `20260507140000`, `20260723120000`, `20260418000012:136-158`, `20260418000009` |
| `skyline_update_batch_student_assignments`, `skyline_upsert_student_course_enrollment`, `skyline_import_student_course_timetable` | none (`p_actor_user_id` from client) | `20260615200000`, `20260713140000`, `20260720044631` |
| `skyline_admin_delete_student_if_no_assessments`, `skyline_admin_delete_batch_if_all_students_inactive`, `skyline_superadmin_delete_student`, `skyline_superadmin_delete_batch` | none | `20260418000011`, `20260421000002`, `20260421000003` |
| `skyline_diagnose_shared_content_block_grids`, `skyline_repair_shared_content_block_grids` | none | `20260724035221` |
| `skyline_student_set_password` | none (no UI caller) | `20260306000001` |
| Induction: `skyline_induction_unlock`, `skyline_induction_submission_state`, `skyline_induction_save_draft`, `skyline_induction_submit`, `skyline_admin_*_induction_*` (5) | induction session / none for admin | `20260330000002`, `20260522100000`, `20260330120001`-`20260418000010` |
| Enrolment: `skyline_student_enrolment_create_draft`, `_find_draft_by_email`, `_get_draft`, `_save_draft`, `_submit`, `_list` | application UUID / none for list | `20260514120000`-`20260521150000` |
| Finance: `skyline_assign_payment_plan_student(_with_installments)`, `skyline_unassign_payment_plan_student`, `skyline_confirm_payment_plan`, `skyline_generate_payment_plan_installments`, `skyline_copy_payment_plan_installments_to_student`, `skyline_update_student_installment_payment`, `skyline_reorder_pending_student_installments`, `skyline_correct_student_plan_payment`, `skyline_preview_fifo_payment_allocation` | `skyline_assert_payment_staff_role` on a client-supplied user id (out of scope) | `20260610120000`-`20260729035851` |

### Appendix C. Tables the browser reads/writes directly (anon key)

`skyline_form_questions` (56 call sites), `skyline_form_sections` (45), `skyline_form_instances` (39), `skyline_form_question_rows` (37), `skyline_students` (31), `skyline_form_question_options` (31), `skyline_form_steps` (23), `skyline_batches` (19), `skyline_instance_access_tokens` (16), `skyline_forms` (14), `skyline_course_forms` (13), `skyline_student_courses` (12), `skyline_courses` (12), `skyline_notifications` (9), `skyline_users` (8, column-restricted), `skyline_generated_pdfs` (6), `skyline_batch_trainers` (5), `skyline_form_results_data` (4), `skyline_form_answers` (4), `skyline_inductions` (4), `skyline_form_assessment_summary_data` (3), `skyline_form_trainer_assessments` (2), `skyline_form_trainer_row_assessments` (2), `skyline_form_results_office` (2), `skyline_course_link_exports` (2), `skyline_assessment_acknowledgments` (2), `skyline_push_tokens` (1), `skyline_learning_doc_activity` (1), plus finance tables (`skyline_payment_plan*`, `skyline_student_payment_*`, `skyline_payment_receipts`). Source: grep of `.from('...')` in `src/`.


---

## Module S-B. B — Submissions form engine audit (read-only reference: `C:\Users\goura\Desktop\Submissions`)

All paths are relative to the Submissions repo root. Line numbers are from the files as read on 2026-11-13. Nothing was modified.

### 0. Two engines coexist

| Engine | Definition source | Renderer / store | Status |
|---|---|---|---|
| **Legacy static "Training Evaluation Form"** | `src/data/formDefinition.json` (292 lines, 9 KB) typed by `src/types/formDefinition.ts:1-81` | `src/pages/FormWizardPage.tsx`, `src/pages/FormView.tsx`, `src/pages/FormPage.tsx`, `src/components/form/FormSectionRenderer.tsx`, zustand store `src/store/formStore.ts` (persist key `'form-storage'` :46), PDF via `src/utils/pdfExport.tsx` + `src/components/pdf/PdfDocument.tsx` | Demo/legacy; not DB-backed; role gating via `src/utils/roleUtils.ts` (`RoleScope` student/trainer/both/office) |
| **DB-backed "SignFlow" Student Pack builder** | `skyline_form_*` tables (migrations) loaded by `src/lib/formEngine.ts:674-740 fetchTemplateForForm` | Builder `src/pages/AdminFormBuilderPage.tsx` (3449 lines), fill `src/pages/InstanceFillPage.tsx` (5759 lines), `src/components/form-fill/*`, PDF by `pdf-server/` (Express + Playwright) | Production |

The rest of this document is about the DB-backed engine unless stated.

### 1. Form definition schema

#### 1.1 Legacy JSON schema (`src/types/formDefinition.ts`)

| Section type | Fields | Line |
|---|---|---|
| `detailsTable` | `title`, `fields[]{fieldId,label,roleScope,type:'text'|'email'|'number'|'date'}` | :10-21 |
| `likertMatrix` | `title`, `questions[]{fieldId,question,roleScope}`, `scaleLabels[]` | :23-34 |
| `textarea` | `fieldId,label,roleScope,rows?` | :36-42 |
| `checkboxGroup` | `title`, `options[]{fieldId,label,roleScope}` | :44-54 |
| `signatureBlock` | `fieldId,label,roleScope,showNameField?,showDateField?` | :56-63 |
| `FormDefinition` | `meta{title,orgName,orgAddress,version}`, `pages[]{pageNumber,sections[]}` | :3-8, :72-80 |

Answers: flat `answers[fieldId]: any` (`src/types/index.ts:12-14`); signatures `{imageDataUrl, typedText?, signedAtDate}` (:5-10). `formDefinition.json` content: 2 details tables (student/trainer, qualification/unit), 3 likert matrices (4 + 7 + 7 rows, scale "Strongly Disagree…Strongly Agree"), 3 textareas, 1 checkbox declaration group, 2 signature blocks, 1 "Office Use Only" details table (:12-287).

#### 1.2 DB hierarchy (form → steps → sections → questions → options/rows)

Created by `supabase/migrations/20250211000000_create_form_tables.sql` (all `skyline_` prefixed, BIGINT identity PKs, **RLS not enabled** :3) and extended later. TS mirror: `src/types/database.ts:6-215` (note: TS names omit the `skyline_` prefix; the real tables are `skyline_forms`, etc.).

**`skyline_forms`** (:7-16): `id, name, version, status CHECK('draft','published','archived') default 'draft', unit_code, header_asset_url, cover_asset_url, created_at`; + `qualification_code, qualification_name, unit_name` (`20250213000003:2-4`); + `start_date TEXT, end_date TEXT` (`20260302000001:3-5`, now unused for access); + `active BOOLEAN default true` (`20260321000001:7`); + `learning_material_urls TEXT[]` (`20260525100000:2-3`); + `created_by/updated_by` audit (`20260314000001`).

**`skyline_form_steps`** (:19-25): `id, form_id FK cascade, title, subtitle, sort_order`. Unique `(form_id,title)` index planned in `20261104000002:12-13` (DRAFT, not applied) after duplicate cleanup `20261104000001`.

**`skyline_form_sections`** (:31-38): `id, step_id FK, title, description, pdf_render_mode CHECK(...), sort_order`; + `assessment_task_row_id BIGINT FK → skyline_form_question_rows ON DELETE SET NULL` (`20250216000001:7`); + `instructions_meta JSONB` (`20260409000001:4-5`).
`pdf_render_mode` final CHECK list (`20260409000002:4-12`): `normal, likert_table, grid_table, declarations, assessment_tasks, assessment_submission, reasonable_adjustment, reasonable_adjustment_indicator, additional_instructions, task_instructions, task_questions, task_written_evidence_checklist, task_marking_checklist, task_results, assessment_summary` (15 values; evolution: `20250211000003`, `20250213000002`, `20250216000001`, `20250220000001`, `20260319000001`, `20260322000001`, `20260409000002`).

**`skyline_form_questions`** (:44-59): `id, section_id FK, type CHECK(...), code, label NOT NULL, help_text, required bool, sort_order, role_visibility JSONB '{}', role_editability JSONB '{}', pdf_meta JSONB '{}'`. `type` final CHECK (`20260415000001:10-23`): `instruction_block, short_text, long_text, yes_no, single_choice, multi_choice, likert_5, grid_table, date, signature, page_break, image` (12 values).

**`skyline_form_question_options`** (:65-71): `id, question_id FK, value, label, sort_order`.
**`skyline_form_question_rows`** (:77-84): `id, question_id FK, row_label, row_help, row_image_url, sort_order`; + `row_meta JSONB '{}'` (`20250216000001:4`) holding `{instructions: TaskInstructionsData}` for assessment-task rows.

**`skyline_form_instances`** (:90-97): `id, form_id FK, status CHECK('draft','submitted','locked') (+'incomplete' in 20260917123000:16), role_context CHECK('student','trainer','office'), created_at, submitted_at`; + `student_id` (`20250211000001`), `workflow_status` (`20260227000002:25`; values grown to `draft,waiting_trainer,waiting_office,completed,failed,awaiting_submission` `20260917123000:24-30`), `trainer_checked_at, office_checked_at` (:26-27), `submission_count int default 0` (`20260325000001:10-11`), `start_date/end_date` (`20260326000004`; text→date `20260415000005`), `no_attempt_rollovers int, did_not_attempt bool` (`20260424000001:4-6`), `trainer_nyc_assessed_on_1..3 date` (`20260520140000:4-7`), `admin_reference_note` (`20260519120000`), `extension_date date` + CHECK ≥ end_date + mirror trigger (`20261105000001:24-70`, DRAFT run-by-hand).

**`skyline_form_answers`** (:102-116): `id, instance_id FK, question_id FK, row_id FK nullable, value_text, value_number NUMERIC, value_json JSONB, updated_at`; unique on `(instance_id,question_id)` where row_id null and `(instance_id,question_id,row_id)` otherwise; + `created_by/updated_by`.

**`skyline_form_assets`** (:119-126): `form_id, type, file_url, meta` (unused by builder; cover image goes on `forms.cover_asset_url`).

**Side tables (answers that are NOT in `skyline_form_answers`):**

| Table | Purpose | Columns | Migration |
|---|---|---|---|
| `skyline_form_trainer_assessments` | per-question S/NS by trainer | `instance_id, question_id, satisfactory CHECK('yes','no')`, unique (instance,question) | `20250217000001:2-9` |
| `skyline_form_trainer_row_assessments` | per-grid-row S/NS (Task 2+) | `instance_id, question_id, row_id, satisfactory yes/no` | `20260309000001:3-11` |
| `skyline_form_results_data` | Results Sheet per task section | `first/second/third_attempt_satisfactory CHECK('s','ns')`, `*_attempt_date TEXT`, `*_attempt_feedback`, `trainer_name, trainer_signature, trainer_date`, `student_name, student_signature`; unique (instance,section) | `20250219000001`, `20250225000002`, `20260310000001` |
| `skyline_form_results_office` | Office Use per task section | `entered_date DATE, entered_by, initial_checked bool, updated_checked bool` | `20250218000001`, `20260530140000:3-5` |
| `skyline_form_assessment_summary_data` | one per instance | `start_date, end_date, final_attempt_1..3_result CHECK('competent','not_yet_competent'), trainer_sig_1..3, trainer_date_1..3, student_sig_1..3, student_date_1..3, student_overall_feedback, admin_initials, admin_initial_checked, admin_updated_checked` | `20250220000001:12-36`, `20260530140000:7-9` |
| `skyline_instance_access_tokens` | role-specific secure links | `instance_id, role_context, token unique, expires_at, consumed_at, revoked_at` | `20260225000004:32-41` |
| `skyline_generated_pdfs` | PDF export queue | `instance_id, role, pdf_status CHECK(pending,generating,uploaded,failed,stale), sharepoint_* urls/ids, storage_path, retry_count, last_error, locked_at/by, generated_at, uploaded_at, download_count` | `20260703180000:7-32` |
| `skyline_assessment_acknowledgments` | student outcome acknowledgement audit | `student_id, instance_id, form_name, outcome_label, outcome_kind, acknowledged_at` | `20260613120000:3-12` |
| `skyline_courses` / `skyline_course_forms` | course ↔ form many-to-many | `name, sort_order, qualification_code` / `(course_id, form_id)` | `20260310000004`, `20260327000001` |

#### 1.3 Engine load/save API (`src/lib/formEngine.ts`, 7825 lines — a god module; only ~1 500 lines are form-engine)

- Types: `FormStepWithSections`, `FormSectionWithQuestions` (+`taskRow`), `FormQuestionWithOptionsAndRows`, `FormTemplate{form,steps}` :61-78.
- `fetchTemplateForForm(formId,{allowInactiveForAdmin,skipEnsureTaskSections})` :674-740 — batched loads (IN-chunks of 200 :637), groups sections→questions→options/rows, attaches `taskRow` for `assessment_task_row_id`. Calls `ensureTaskSectionsForForm` :240-351 **on every load** unless skipped (lazy migration that creates missing task steps / marking checklists — see §3.3).
- `fetchFormBuilderTree` :753-785 (no options/rows), `fetchSectionQuestionsForBuilder` :788-813.
- `fetchAnswersForInstance` :815-825; `saveAnswer(instanceId, questionId, rowId, {text,number,json}, {allowClear,source,actorRole})` :1186-1250 — select-then-update/insert, merges via `mergeSaveValuePreservingExisting` (`src/utils/formAnswerMerge.ts:69-101`) so empty values never wipe stored values unless `allowClear`.
- Results/summary/trainer marks: `fetchResultsData/saveResultsData` :925-978 (upsert on `instance_id,section_id`), `fetchResultsOffice/saveResultsOffice` :980-1023, `fetchAssessmentSummaryData/saveAssessmentSummaryData` :1049-1126, `fetchTrainerAssessments/saveTrainerAssessment` :1128-1154, `fetchTrainerRowAssessments/saveTrainerRowAssessment` :1157-1184 (key `q-${questionId}-${rowId}`).
- Instances: `createFormInstance` :1295-1334 (defaults start=today Melbourne, end=+30 days), `updateFormInstanceDates` :1389-1484 (reset rules), `clearAssessmentAttemptHistory` :1337-1387, `recordTrainerNycAssessedOn` :1523-1539, `STUDENT_RESUBMISSION_DAYS_AFTER_NYC = 5` :1541-1546, tokens :1585-2064, `allowStudentResubmission` :2067-2090, `updateInstanceRole` :7241, `InstanceWorkflowStatus` :7246-7252, `submitInstanceToTrainerViaRpc` :7259-7284, `updateInstanceWorkflowStatus` :7327-7384 (maps workflow → legacy status/role_context).
- Form CRUD: `createForm` :6023-6067 → `createCompulsoryFormStructure` :5709-5993; `duplicateForm` :6565-6748 (deep copy + `remapPdfMetaQuestionIds`), `nextVersion` :6558-6563 (bumps minor: `1.0.0 → 1.1.0`), `formNameExists` :6551, `deleteFormSuperadmin` :6855, `updateForm` :102-107.
- Repairs/diagnostics: duplicate task steps :539-577, `repairAssessmentTaskLabelsToLocalOrder` :6771-6817, shared content-block grids :6957-7240 (+ SQL RPC `20260724035221`).

#### 1.4 Helper modules

| File | Role |
|---|---|
| `src/form/layout.ts:1-55` | A4 points, fonts, fixed likert column widths (`no 50 / criteria 330 / likert 55×5`) for legacy web+PDF parity |
| `src/store/formStore.ts` | legacy zustand store: role, answers, two signatures, submitted flags |
| `src/lib/defaultFormSteps.ts:32-343` | `DEFAULT_STEPS_5_TO_20`: 15 policy sections inserted into the Introductory Details step by `createDefaultSectionsToStep(stepId, startSortOrder)` :346-401 (skips 'Reasonable Adjustment' :355) |
| `src/lib/assessmentTaskSteps.ts` | `ASSESSMENT_TASK_LABEL_RE = /Assessment\s+Task\s*-?\s*(\d+)/i` :3, `nextAssessmentTaskLabel` :17-19 → `Assessment Task - N`, form-scoped renumber plan :50-67, duplicate-step detection :100-124 |
| `src/lib/taskQuestionsNumbering.ts:6-20` | Q-numbers: top-level questions only, skipping `instruction_block`, `pdf_meta.isAdditionalBlockOf` children and `page_break` (must match pdf-server) |
| `src/lib/questionDuplicate.ts` | `buildQuestionDuplicateInsertPayload` :46-76 (deep-clones JSON, label `"(Copy)"` :35-38, optional clear of `contentBlocks[].questionId` / `code`), `applyQuestionFieldUpdate` :79-102 |
| `src/lib/contentBlockClone.ts` | `remapPdfMetaQuestionIds` :21-57 (rewires `isAdditionalBlockOf` + `contentBlocks[].questionId` after clone), shared-child detection/repair planning :63-117, diagnostic :123-181 |
| `src/lib/writtenEvidenceChecklist.ts:10-45` | `WRITTEN_EVIDENCE_CODE='written.evidence.checklist'`, mode `task_written_evidence_checklist`; any `single_choice` with rows in that section is a checklist question |

### 2. Question types, config (`pdf_meta`) and answer shapes

Answer map keys (`src/utils/stepAnswerSave.ts:15-18`, `src/utils/gridTableAnswers.ts:8-11`): `q-{questionId}` (row_id null) or `q-{questionId}-{rowId}`.

| type | Builder config (pdf_meta keys, `AdminFormBuilderPage.tsx`) | Render | Answer shape in memory → DB columns |
|---|---|---|---|
| `instruction_block` | `imageUrl, imageLayout(side_by_side/above/below), imageWidthPercent 20-80, imageFullWidth` (:2271-2344); in `task_questions` sections: `pdf_meta.instructions = TaskInstructionsData` via `QuestionInstructionEditor` (:2166-2190) | `QuestionRenderer.tsx:525-539` label+help_text+image; rich blocks via `TaskInstructionsBlocksDisplay` | none (skipped by `stepAnswerSave.ts:44,64`; `answerAttachment.ts:40`) |
| `page_break` | none (:2207-2210) | dashed divider :541-545; PDF page break | none |
| `short_text` | `wordLimit` (:2244-2258), `allowAnswerImage` (:2260-2270), question image keys, `textAboveHeader` (task_questions only :2387-2398) | Textarea 3 rows, word-truncated :630-744; codes `evaluation.trainingDates`/`evaluation.evaluationDate` render a DatePicker :631-646 | `string` → `value_text`; with attachment `{text, answerImageUrl}` → `value_text` + `value_json {answerImageUrl}` |
| `long_text` | same as short_text (default rows 8; fixed height from word limit) | :746-837 | same as short_text |
| `yes_no` | options editor (:2384-2386) but renderer ignores options | RadioGroup Yes/No :856-891; `declarationStyle` → checkbox :857-871 | `'yes'|'no'` → `value_text` |
| `single_choice` | options editor; rows editor when it is a checklist question (:2527-2543) | RadioGroup vertical :893-911; checklist rows rendered in `InstanceFillPage` (WEC :3329, marking :3387-3475) | `value` → `value_text`; checklist: per row `'yes'|'no'` → `value_text` with `row_id` |
| `multi_choice` | options editor | Checkbox list :913-940; `assessment_submission` custom render `InstanceFillPage.tsx:3475-3530` | `string[]` → `value_json` (legacy comma string tolerated :3488) |
| `likert_5` | rows editor | `LikertTableQuestion.tsx` (scale 1-5, labels :12-13); section mode `likert_table` uses `SectionLikertTable.tsx` | per row `'1'..'5'` → `value_text` with `row_id` (`stepAnswerSave.ts:92-108`); single-row stores question-level |
| `grid_table` | `layout` (`TableLayoutSelect.tsx:15-97`: `no_image`, `default`, `no_image_no_header`, `split`; legacy `polygon`), `firstColumnLabel`, `secondColumnLabel`, `columnsMeta[{label,type:'question'|'answer'}]` (+ legacy mirrors `columns[]`, `columnTypes[]`), `columnWordLimits[]`, `headerCase` (original/uppercase/title), rows (`row_label, row_help, row_image_url`), bulk add ≤100 rows (:3206-3244) | `GridTableQuestion.tsx:113-405`; Status column per row for trainer (:14-19) | per row `{ "r{rowId}_c{colIdx}": string }` → `value_json` with `row_id` (`stepAnswerSave.ts:80-90`); legacy question-level text parsed by `gridTableAnswers.ts:159-229` |
| `date` | — | DatePicker :839-854 with min/max | ISO `yyyy-MM-dd` → `value_text` |
| `signature` | `showNameField/showDateField` (set only by seed code, no builder UI) | `SignaturePad` :584-607 (draw → PNG data URL, or typed name red italic); declaration variants use `DeclarationSignatureWithDate.tsx` | `string` (dataURL or typed) → `value_text`, or `{signature, date, signedBy?, typedText?, imageDataUrl?, signedAtDate?}` → `value_json` (`DeclarationSignatureWithDate.tsx:8-54`) |
| `image` | question image keys | `ImageAnswerField` :152-297 (upload/replace/delete) | `{url}` → `value_json`; with attachment `{value:{url}, answerImageUrl}` |
| special: `short_text` + `pdf_meta.appendixMatrix` / code `reasonable_adjustment_appendix.matrix` | seed only | `AppendixAMatrixForm.tsx` checkboxes from `appendixAMatrixData.ts` | `Record<checkboxId, boolean>` → `value_json` |

Attachment envelope (`src/lib/answerAttachment.ts:1-152`): enabled only by `pdf_meta.allowAnswerImage`; string inner → `{text, answerImageUrl}`; non-string → `{value, answerImageUrl}`; `answerImageUrl: null` = explicit removal; per-row questions keep the attachment on the question-level row (`stepAnswerSave.ts:66-72`). Must stay in sync with `pdf-server/answerAttachment.ts`.

Content blocks (`AdminFormBuilderPage.tsx:115-142, 2544-2929`): a `task_questions` parent may carry `pdf_meta.contentBlocks[]` of `instruction_block | grid_table | short_text | long_text | image`; grid/text blocks are **separate child questions** with `pdf_meta.isAdditionalBlockOf = parentId` (hidden from lists :1351-1352, :2081, :2118; excluded from numbering/validation/marking). Defaults: grid child `layout:'no_image', columnsMeta [{Terms,question},{Explanation,answer}]` :1641; text children word limits 200/50 :1649.

### 3. Builder UI

#### 3.1 Pages

- `src/pages/AdminFormsListPage.tsx` — list/search/filter by course, create (name, version, qualification code/name, unit code/name; default two tasks "Assessment Task - 1 / Written Questions", "Assessment Task - 2 / Practical" :94-97), duplicate, toggle `active` :181-188, copy generic student link `/forms/{id}/student-access` :149-154, delete (superadmin only; `canManageForms = role === 'superadmin'` :19), per-form documents panel.
- `src/pages/AdminFormBuilderPage.tsx` — three-pane builder (Steps | Sections | Questions + editor). Form name (unique check :1815), version :1836-1847, cover image upload/paste :753-783, :1854-1910, Preview → `/admin/forms/{id}/preview`.
- `src/pages/AdminFormPreviewPage.tsx` — read-only structure stepper (labels + type/required :96-103); live PDF via `VITE_PDF_API_URL` `/pdf/preview/form/{formId}` :19-24 (manual, not automatic).

#### 3.2 What an admin can configure

| Level | Configurable | Mechanism |
|---|---|---|
| Form | name, version, qualification/unit (create only), cover image, active, learning material URLs, course links | `updateForm` :102; list page |
| Step | add (`Step N` :848), rename (double-click :291-300; renaming a task step also renames the linked task row :862-872), reorder by drag (`@dnd-kit`, :1252-1266), duplicate (:1066-1202; task steps get a new grid row + sections relinked), delete (:1018-1045; deletes grid row if it was the only linked step) | |
| Section | add (`Section N`, inherits the step's task row :875-901), rename, reorder (:1268-1288), `pdf_render_mode` select (`PDF_RENDER_MODES` :354-370; switching to WEC/marking modes auto-creates their questions :999-1012), "Link to task" dropdown for the 5 task modes (:467-474), duplicate (empty copy, task link cleared :1204-1250), delete **only if not prebuilt** (`PREBUILT_SECTION_TITLES` :193-213) | |
| Question | add (`short_text 'New Question'`; in WEC sections a yes/no checklist question :1375-1424), add instruction (:1426-1453, task_questions only), label (multiline), help text, required, type (`QUESTION_TYPES` :82-95), word limit, allow answer image, question image + layout, role visibility ×3, role editability ×3 (:2346-2383), options (value/label; `QuestionOptionsEditor` :2992-3095), rows (`QuestionRowsEditor` :3108-3449: label, description, image upload/paste/URL, bulk add, per-row "Edit instructions" for assessment-task rows), table layout/columns/word limits, `textAboveHeader`, content blocks, reorder (:1344-1373), duplicate (:1455-1619 deep clone incl. children), delete only if not prebuilt (`isPrebuiltQuestion` by code prefix :219-222) | debounced saves 450 ms (:688, :2990, :3106), flushed on blur/preview/unload |
| Task instructions | `TaskInstructionsModal.tsx` — structured fields (`TaskInstructionsData` :37-50: assessment_type, task_description, applicable_conditions, resubmissions, location_*, answering_instructions, purpose_*, task_instructions) **or** free `blocks[]` (paragraph/table with heading, rich text, image layout, column headers :23-36); smart paste (tab/space tables, Hazard-Risk format :256-260), `.docx` import (`parseInstructionInput.ts:400` via mammoth). Stored in `row_meta.instructions` (task row), `pdf_meta.instructions` (question) or `sections.instructions_meta` (`additional_instructions`) | `SectionInstructionsEditor.tsx`, `QuestionInstructionEditor.tsx`, `AdditionalInstructionsEditor.tsx` |

#### 3.3 What is fixed in code (not configurable)

- Compulsory structure created on `createForm` (`formEngine.ts:5709-5993`): step "Introductory Details" with sections Student and trainer details / Qualification and unit of competency / Assessment Tasks (grid `assessment.tasks`) / Assessment Submission Method / Reasonable Adjustment indicator / 15 policy sections; one step per assessment-task row with **five fixed sections** (`insertAssessmentTaskStepWithSections` :412-537: Student Instructions, Questions, Written Evidence Checklist, Assessment Marking Checklist, Results); then "Assessment Summary", "Appendix A - Reasonable Adjustments", "Learner Evaluation".
- `ensureTaskSectionsForForm` :240-351 re-runs on every builder/template load and back-fills missing task steps / marking checklists (lazy migration; single-flight guard :233-246).
- Adding a row to the `assessment_tasks` grid auto-creates a task step (:3185-3202); deleting a row deletes its steps (:3285-3293).
- Results sheet, Assessment Summary sheet, Appendix A matrix, Learner Evaluation likert scale, task-results attempt columns, office checkboxes: layout and labels are hard-coded in `InstanceFillPage.tsx` and `pdf-server/*` (builder shows "No editing needed here" :2934-2958).
- Prebuilt sections/questions cannot be deleted; question `code` cannot be edited in the UI (only cleared on duplicate).
- No drag between steps/sections (reorder only within parent). No undo. No draft/publish workflow in the builder (`status` is set to `'published'` on create :6038 and never changed in UI).

#### 3.4 Versioning / cloning

- `forms.version` is a free text string; `duplicateForm` creates `"<name> (Copy)"` with minor bump :6569-6570 and copies steps/sections/questions/options/rows and `instructions_meta` :6639, remapping content-block ids :6727-6741. Assessment-task labels are preserved, not renumbered (:6743-6746; see `assessmentTaskSteps.ts:21-30`).
- Instances point at `form_id`; edits to a form affect existing instances (no snapshot). `active=false` hides a form from non-admins (`fetchForm` :90-93).

### 4. Renderer and fill flow

#### 4.1 Routing / access
- Instance URL `/instances/{id}?token=…` issued by `issueInstanceAccessLink` (`formEngine.ts:1628-1694`); `validateInstanceAccessToken` :1831-1947 checks role, revoked/consumed/expired, student inactive, `did_not_attempt`, Melbourne date window `[start_date, COALESCE(extension_date,end_date)]`, course lifecycle (`studentAssessmentAccess.ts`). Student token expiry = deadline 23:59 Melbourne (:1671-1673); trainer/office default 90 days, student 30 (:1679).
- `FormStartPage.tsx` (legacy demo start) picks a role and creates an instance :27-38.

#### 4.2 InstanceFillPage (`src/pages/InstanceFillPage.tsx`)
- Steps = `Introduction` ("Student Pack" static text :3055-3077) + template steps; Appendix A hidden from students (`getVisibleStepsForRole` :150-153 — title regex `/Appendix\s*A/i`).
- Per-section render switch on `pdf_render_mode` (:3121-5660): `reasonable_adjustment_indicator` :3121, `reasonable_adjustment` :3126, `assessment_tasks` :3298, `task_marking_checklist` :3387, `assessment_submission` :3475, `additional_instructions` :3532, `task_instructions` :3664, `task_questions` :3847, `task_results` :4504, `assessment_summary` :4931, `likert_table` :5282, default/`declarations`/`normal` :5330+.
- Role gating: `isQuestionEditableForRole` :548-566 (**office ⊇ trainer ⊇ student**: office may edit anything editable by any role; trainer may edit student fields; admin edit mode unlocks all), `isQuestionVisibleForRole` :569-585 likewise; `canRoleEditCurrentWorkflow` :1798-1811 (student only while `draft`; trainer unless `waiting_office` handed off; office only in `waiting_office`); `getStudentDeclarationEditable` :1813-1829; `canOfficeAdminEdit` :1832-1835; `isQuestionReadOnlyByTrainer` :1985 (student resubmission: rows/questions marked satisfactory become read-only, see `GridTableQuestion.tsx:176-178`).
- Attempt logic: `getSubmissionWave` :280-282 (1..3 from `submission_count`), active marking attempt :290-296, student prep attempt :299-308, staff column editability `column <= active` :319-320; results sheet editability :4535-4560.
- Autosave: per-question debounce 300 ms (`debouncedSave` :1506-1522), status chips saving/saved/error; "Next" flushes pending and persists every target of the step sequentially (`collectStepAnswerSaveTargets` :1901-1925); results/summary fields save immediately via `saveResultsData`/`saveAssessmentSummaryData` (:1047-1056, :1724, :1757); summary trainer dates mirror results attempt dates (:244-260); identity fields hydrated from student/batch profile (`identityFieldRepair.ts`, :809-812, :1080-1124); auto-fill qualification/unit/evaluation unit name from `forms` (:5619-5623).
- Submit paths: student → `submitInstanceToTrainerViaRpc` (`skyline_submit_instance_to_trainer`, `20260917123000:98-240`, caps `submission_count` at 3) + notification :2545-2548; trainer finalise :2586-2680 (NYC & attempt<3 → `recordTrainerNycAssessedOn`, token to assessed-on+5 days, back to student draft; NYC at attempt 3 → `failed` + role office; Competent → `waiting_office`); office → ticks Initial/Updated or "Office Checked" → `completed` (`assessmentCompletionStatus.ts:110-188`).
- Legacy flat `answers` from `skyline_form_answers` via `answerFromDbRow` (`answerAttachment.ts:134-152`); legacy grid text migrated to rows on load (`gridTableAnswers.ts:260-287`).

#### 4.3 Components
`QuestionRenderer.tsx` (type switch + shared `QuestionAttachment` :322-442), `GridTableQuestion.tsx`, `LikertTableQuestion.tsx`, `SectionLikertTable.tsx` (section code A/B/C from title :7-13), `AppendixAMatrixForm.tsx`, `SignatureField.tsx` / `SignaturePad.tsx` (react-signature-canvas 600×240/320, pen `#dc2626`), `DeclarationSignatureWithDate.tsx` (signature + date, auto-dates on sign :83-89), `TaskInstructionsBlocksDisplay.tsx` (rich blocks or the 8 fixed instruction headings :176-192).

### 5. Validation

| Module | Rules |
|---|---|
| `InstanceFillPage.tsx:2016-2420 getStepValidationErrors` | per visible step; skips post-summary task steps; `task_results`: student needs name+signature (:2058-2065), trainer in strict review needs ≥1 valid attempt (:2068-2070), trainer name/signature/date on submit (:2072-2082), date chain (:2084-2087); `assessment_summary`: end ≥ start (:2099-2105), date chain, attempt N result required (:2147-2204); Appendix A locked after first cycle (:2247-2250); trainer reviewing task questions must mark Yes/No (:2300-2309); required questions per type incl. grid fill rule `isGridTableFilled` :356-420 (header table: one full row; no-header question table: one fully filled answer column), signature+date gaps, `evaluation.evaluationDate` ≥ declaration/first attempt (:2385-2404) |
| `src/utils/assessmentRequiredGaps.ts` | describes which cells/fields are missing for grid (:55-126), signature (:128-149), content blocks (:163-235) |
| `src/utils/assessmentValidationMessages.ts` | message formats `Q9 – Title: Field is required.` (:34-52), summary toast (:58-96), scroll-to-question (:98-109) |
| `src/utils/assessmentResultValidation.ts` | valid outcome strings (:37-50), ≥1 valid attempt on each results sheet + summary before progress (:89-116), `ASSESSMENT_RESULT_PROGRESS_MESSAGE` :5-6 |
| `src/utils/assessmentAttemptDates.ts` | date chain S1→T1→S2→T2→S3→T3 mins and error texts (:92-242); declaration date extraction :264-279 |
| `src/lib/writtenEvidenceChecklist.ts` | which questions count as checklist; empty sections hidden (`InstanceFillPage.tsx:3092-3095`) |
| `src/utils/identityFieldRepair.ts` | identity codes `student.fullName/id/email, trainer.fullName` :3-8; backfill plans |
| `src/lib/enrolmentValidation.ts` (public enrolment form, separate product) | zod `enrolmentDraftSchema`/`enrolmentSubmitSchema` :83-368, phone/email rules :7-80, checklist requirements :373-386 |

### 6. Uploads / storage

- Bucket `photomedia`, root folder `skyline` (`src/lib/storage.ts:3-4`). Paths: cover `skyline/{formId}_{name}_{ts}.{ext}` :47; row image `skyline/{formId}/questions/{qid}/rows/{rowId}_{ts}` :76; question image `skyline/{questionId}/{name}_{ts}` :107; instruction image `skyline/instructions/{task_row|section}/{id}/{name}_{ts}` :140; induction docs `skyline/induction/{folder}/{key}` :182; **answer images** `skyline/answers/{instanceId}/{questionId}/{name}_{ts}` :227; delete by public URL :241-280. Learning materials `photomedia/Learning/<formname-id>/<filename>` (`20260427000001:1-10`, policies: anon/auth SELECT, auth write — comment only, no SQL).
- HEIC/HEIF converted client-side to JPEG q0.92 (`storage.ts:11-30`). Accepted: `image/*` (+`.heic,.heif` for answer attachments `QuestionRenderer.tsx:386`; cover `image/jpeg,png,webp,gif,heic,heif` `AdminFormBuilderPage.tsx:1857`). **No size limits** on assessment uploads; enrolment uploads 5 MB passport / 15 MB default, types jpeg/jpg/png/gif/pdf (`src/constants/enrolmentOptions.ts:288-293`). No count limits (one image per answer/question/row slot).
- `image` question type added by `20260415000001`.

### 7. PDF export

- Legacy: `src/utils/pdfExport.tsx` (@react-pdf/renderer from `formDefinition.json`, file `training-evaluation-form-{role}-{date}.pdf` :32) + `src/components/pdf/PdfDocument.tsx` (groups likert sections A/B/C, declarations :11-33).
- Production: `pdf-server/` Node/Express + Playwright. Routes (`pdf-server/index.ts`): `/health` :78, `POST /jobs/process-pdfs` :86 (worker), `POST /jobs/seed-completed-pdfs` :127, induction PDFs :159/:253, **`GET /pdf/:instanceId?role=&download=`** :2438 (live render), `GET /pdf/preview/form/:formId` :2656. Worker HTML in `pdf-server/htmlGenerator.ts` (1919 lines) duplicates the live route's renderer (index.ts ~1130-2440); shared pieces: `assessmentQuestionBlock.ts`, `instructionBlocksHtml.ts`, `writtenEvidenceChecklist.ts`, `appendixAMatrixData.ts`, `answerAttachment.ts`, `pdfConstants.ts` (A4, 60 s timeouts, bulk max 25, restart Chromium after 4 jobs), `pdfFileNaming.ts` (`{unitCode}_{studentId}_{studentName}.pdf` :40-52; SharePoint path `base/unitCode/file` :54-71), `sharepointUpload.ts` (Graph upload).
- Queue: `skyline_generated_pdfs` rows inserted by trigger when instance is `locked` + `completed` (`20260706140000:13-165`), optional pg_net call to Edge Function `supabase/functions/trigger-pdf-worker/index.ts` (forwards to `${PDF_WORKER_URL}/jobs/process-pdfs`, limit ≤2 :58). Frontend `src/lib/generatedPdfs.ts`: prefer SharePoint URL, else live Render URL with confirm (:97-98, :105-130).

### 8. Role model summary ("office", "trainer office only")

- Three fill roles `student | trainer | office` (`role_context`, `src/utils/roleGuard.ts:1`); staff app roles `superadmin | admin | trainer | office` (`formEngine.ts:2347`). The **office** fill role is used by admins/office staff via admin "Quick Edit"/office queue; `isAdminEditMode` unlocks everything.
- Template flags: `role_visibility` / `role_editability` JSONB `{student,trainer,office}`; missing key = true (`roleGuard.ts:7-9,16-18`). Seed presets (`formEngine.ts:5688-5695`): `DEFAULT_ROLES`, `READ_ONLY_VISIBLE`, `READ_ONLY_EDIT`, `STUDENT_ONLY {student only}`, `TRAINER_OFFICE_VISIBLE {trainer,office}`, `TRAINER_ONLY_EDIT`, `TRAINER_OFFICE_EDIT`, `ALL_CAN_EDIT`.
- "Trainer/office only" sections: Appendix A (`20260312000001:5-11` sets both visibility and editability to trainer+office; students never see the step), Written Evidence Checklist and Marking Checklist questions (`TRAINER_OFFICE_VISIBLE/EDIT`, `20260322000003`), trainer S/NS marks (side tables, never student-editable), results-sheet trainer block, summary trainer block, office checkboxes (office only via `canOfficeAdminEdit`).
- Runtime overrides the template: trainer may edit student-editable fields, office may edit trainer- and student-editable fields (`InstanceFillPage.tsx:548-566`), so the template flags effectively encode a *minimum* role, not an exclusive owner.


---

## Module S-B2. B2 — Submissions hardcoding inventory (read-only reference: `C:\Users\goura\Desktop\Submissions`)

Every row is something a fully data-driven target system must move into data/config. Paths are relative to the Submissions repo root; `mig/` = `supabase/migrations/`. Format: `file:line` — what is baked in.

### (a) Questions and answer options baked into code/SQL

| Location | Hardcoded content |
|---|---|
| `src/data/formDefinition.json:12-71` | Legacy "Training Evaluation Form": student/trainer details fields (`student.fullName/id/email`, `trainer.fullName`), qualification/unit fields |
| `src/data/formDefinition.json:77-226` | 3 Likert matrices (Logistics 4 q, Learning 7 q, Trainer/Assessor 7 q) with scale labels `Strongly Disagree…Strongly Agree` and comment textareas |
| `src/data/formDefinition.json:233-287` | Final Declarations checkboxes (2), student/trainer signature blocks, Office Use Only fields (`office.approved/date/notes`) |
| `src/lib/formEngine.ts:5728-5731` | Student and trainer details questions (`student.fullName`, `student.id`, `student.email` STUDENT_ONLY; `trainer.fullName` TRAINER_OFFICE_EDIT), all `required` |
| `src/lib/formEngine.ts:5743-5746` | Qualification/unit read-only questions `qualification.code/name`, `unit.code/name` |
| `src/lib/formEngine.ts:5760` | `assessment.tasks` grid_table with fixed columns `['Evidence number','Assessment method/ Type of evidence']` |
| `src/lib/formEngine.ts:5784-5785` | Default tasks `Assessment Task - 1 / Written Questions`, `Assessment Task - 2 / Practical` (also `src/pages/AdminFormsListPage.tsx:94-97`, copy text :618) |
| `src/lib/formEngine.ts:5805-5817` | `assessment.submission` multi_choice options `hand / email / lms / other` with labels, plus `assessment.otherDesc` short_text |
| `src/lib/formEngine.ts:5829` | RA indicator `instruction_block` |
| `src/lib/formEngine.ts:5872-5875` | Appendix A questions `reasonable_adjustment_appendix.task/.explanation/.matrix (pdf_meta.appendixMatrix)`, `trainer.reasonableAdjustmentAppendixSignature` |
| `src/lib/formEngine.ts:5898-5903` | Learner Evaluation Participant Information: `evaluation.unitName/studentName/trainerName/employer/trainingDates/evaluationDate` with role presets |
| `src/lib/formEngine.ts:5916-5930, 5942-5959, 5971-5988` | Likert questions `evaluation.logistics` (4 rows), `evaluation.trainer` (7 rows), `evaluation.learning` (7 rows) with full row texts + comment long_text questions |
| `src/lib/formEngine.ts:176-194, 467-485` | Written Evidence Checklist question `written.evidence.checklist` single_choice + Yes/No options (TRAINER_OFFICE) |
| `src/lib/formEngine.ts:204-223, 325-346, 496-533` | Marking checklist questions `assessment.marking.evidence_outcome` / `.performance_outcome` + Yes/No options |
| `src/lib/defaultFormSteps.ts:32-343` | 15 policy sections (one `instruction_block` each) + Reasonable Adjustment yes_no/short/long/signature (`reasonable_adjustment.applied/task/description`, `trainer.reasonableAdjustmentSignature` :209-240) + Student declaration signature `student.declarationSignature` (:330-338) |
| `src/lib/appendixAMatrixData.ts:12-125` | Appendix A Reasonable Adjustment Strategies Matrix: 2 tables, ~55 checkbox ids/labels (`ra_lln_*`, `ra_nesb_*`, `ra_indigenous_*`, `ra_age_*`, `ra_edu_*`, `ra_disability_*`) |
| `pdf-server/appendixAMatrixData.ts:1-147` | Duplicate copy of the matrix for PDF (must match ids) |
| `src/components/form-fill/QuestionRenderer.tsx:882-885` | `yes_no` options fixed to `yes/Yes`, `no/No` (DB options ignored) |
| `src/components/form-fill/LikertTableQuestion.tsx:12-13` | Likert scale `1..5` and labels |
| `src/components/form-fill/SectionLikertTable.tsx:4-5` | same scale/labels; `:7-13` section codes A/B/C by title keyword |
| `src/components/pdf/PdfDocument.tsx:11-19` | Likert section order A/B/C by title keyword |
| `src/pages/AdminFormBuilderPage.tsx:915-937` | auto-created WEC question + Yes/No options when a section switches to WEC mode |
| `src/pages/AdminFormBuilderPage.tsx:970-996` | auto-created Evidence/Performance Outcome questions + Yes/No options |
| `src/pages/AdminFormBuilderPage.tsx:1383-1398` | new question defaults (`short_text 'New Question'`; WEC sections → checklist question) |
| `src/pages/AdminFormBuilderPage.tsx:1636-1650` | content-block child defaults: grid `Terms(question)/Explanation(answer)`, word limits 200/50 |
| `src/pages/AdminFormBuilderPage.tsx:3044` | new option value `opt_{Date.now()}` / label `New option` |
| `mig/20250221000001_add_reasonable_adjustment_to_existing_forms.sql:34-45` | inserts 4 RA questions (yes_no/short/long/signature) with role JSON |
| `mig/20250222000001_add_learner_evaluation_to_existing_forms.sql:33-171` | inserts Participant Information (6 q), three likert questions with all row texts, three comment questions |
| `mig/20250225000004_add_appendix_a_task_explanation_questions.sql:8-44` | inserts Appendix A task/explanation/matrix questions |
| `mig/20260310000003_replace_intro_ra_with_indicator.sql:43-55` | inserts RA indicator instruction_block |
| `mig/20260319000001_move_written_evidence_checklist_to_tasks.sql:28-41` | inserts WEC section + question + Yes/No options per task |
| `mig/20260322000002_backfill_assessment_marking_checklist_to_existing_forms.sql:35-68` | inserts marking checklist section + Candidate Name/Assessor Name/Assessment date/s (removed again by `20260322000004:4-9`) + Evidence/Performance Outcome + options |
| `mig/20260322000005_backfill_written_evidence_and_marking_checklists.sql:27-95` | same WEC + marking content for forms that skipped earlier backfills |
| `mig/20260607120000_cpccco2013_q4_tools_grid_rows.sql:4-8` | inserts 11 extra empty rows into question id 8019 (CPCCCO2013 Q4 tools table) |
| `mig/20260724035221_repair_shared_content_block_grids.sql:186-215` | SQL clone of child questions/options/rows (structure, not content) |
| `src/utils/parseMixedContent.ts:16-29, 31-48, 259-265` | paste-parser vocab: `KNOWN_HEADERS` (Assessment Information, Description, Evidence to submit, Estimated Cost (AUD), Risk Category, …), `ASSESSMENT_INFO_ROW_LABELS`, continuation labels |
| `src/components/form-fill/TaskInstructionsModal.tsx:256-260` | Hazard/Risk/Consequence/Control Measures table recogniser + fixed headers |
| `src/constants/enrolmentOptions.ts:3-281` | (public enrolment form) TITLE, GENDER, INDIGENOUS, EMPLOYMENT, LANGUAGE, SCHOOL_LEVEL, PRIOR_EDUCATION(_TYPE), DISABILITY(_TYPE), ENGLISH_ASSESSMENT, STUDY_REASON, OSHC, HEAR_ABOUT, COUNTRY, APPLICATION_CHECKLIST_ITEMS (:166), DECLARATION_ITEMS (:173-250), ENGLISH_PROFICIENCY_MAPPING, FALLBACK_COURSE_OPTIONS |

### (b) Task / section / step structure baked in

| Location | Rule |
|---|---|
| `src/lib/formEngine.ts:5714` | first step title `Introductory Details`, subtitle `Student, trainer, qualification & assessment`, sort 0 |
| `src/lib/formEngine.ts:5722, 5737, 5752, 5798, 5823` | fixed section titles/order 0-4: Student and trainer details, Qualification and unit of competency, Assessment Tasks (`assessment_tasks`), Assessment Submission Method (`assessment_submission`), Reasonable Adjustment (`reasonable_adjustment_indicator`); policy sections from sort 5 (:5833) |
| `src/lib/formEngine.ts:5839-5842, 5847, 5859, 5883` | step order: task steps (sort 1..n) → `Assessment Summary` / `Final record of student competency` → `Appendix A - Reasonable Adjustments` / `Reasonable adjustment strategies and declaration` → `Learner Evaluation` / `Training evaluation and feedback` |
| `src/lib/formEngine.ts:432-458` | task step subtitle `Instructions, Questions & Results`; five sections `Student Instructions(0) / Questions(1) / Written Evidence Checklist(2) / Assessment Marking Checklist(3) / Results(4)` with fixed `pdf_render_mode`s |
| `src/lib/formEngine.ts:141-147, 165` | section order map by mode when migrating |
| `src/lib/formEngine.ts:250` | intro step found by title `'Introductory Details'` or subtitle containing `'Student'` |
| `src/lib/formEngine.ts:261-278, 6829-6848` | assessment task rows located via section mode `assessment_tasks` + `grid_table` / code `assessment.tasks` |
| `src/lib/formEngine.ts:421-430, 442-447` | step identity by `(form_id,title)` (race guard) |
| `src/lib/assessmentTaskSteps.ts:3-19, 45-67` | `Assessment Task - N` label pattern, next-number, form-scoped renumbering; `:21-30` labels preserved on duplicate |
| `src/lib/taskQuestionsNumbering.ts:6-20` | Q numbering skips instruction blocks, content-block children, page breaks |
| `src/lib/defaultFormSteps.ts:355` | 'Reasonable Adjustment' default section skipped (title match) |
| `src/pages/AdminFormBuilderPage.tsx:193-217` | `PREBUILT_SECTION_TITLES` (19 titles) cannot be deleted |
| `src/pages/AdminFormBuilderPage.tsx:219-222` | prebuilt question = code prefix `student. trainer. qualification. unit. assessment. reasonable_adjustment.` |
| `src/pages/AdminFormBuilderPage.tsx:354-370` | `PDF_RENDER_MODES` display labels |
| `src/pages/AdminFormBuilderPage.tsx:467, 865, 877, 1074, 1215` | the five "task-linked" modes list repeated inline |
| `src/pages/AdminFormBuilderPage.tsx:848, 882` | default titles `Step N`, `Section N` |
| `src/pages/AdminFormBuilderPage.tsx:1076-1084` | duplicate task step title = next `Assessment Task - N`; others `(Copy)` |
| `src/pages/AdminFormBuilderPage.tsx:2027-2041, 2064-2149` | which modes allow adding questions / show fixed descriptions (task_results, assessment_summary, title `'Assessment Summary Sheet'`) |
| `src/pages/AdminFormBuilderPage.tsx:3166-3203, 3285-3296` | assessment_tasks row add/remove creates/deletes whole steps |
| `src/utils/taskResultsOutcome.ts:3-9` | `TASK_SECTION_MODES` set |
| `src/utils/taskResultsOutcome.ts:11-25` | Assessment Summary step detected by title regex `/Assessment Summary/i` or section title `Assessment Summary Sheet`; everything after it is "post-summary" and ignored for outcomes (:35-57) |
| `src/pages/InstanceFillPage.tsx:150-153, 2021, 2048, 3128-3129` | Appendix A step detected by title regex `/Appendix\s*A/i` (hidden from students) |
| `src/pages/InstanceFillPage.tsx:2955` | Introduction step label `Introduction` / `Student Pack overview` |
| `src/pages/InstanceFillPage.tsx:3107, 3117` | hard list of modes that always render / suppress section title |
| `pdf-server/htmlGenerator.ts:766, 781, 799, 828` and `pdf-server/index.ts:1140, 1263, 1283, 1301, 1330` | Learner Evaluation detected by exact title; "Appendix B" header; numbered-section exclusions; page-break rules A/B/C by `sort_order` 1/2/3; Student&Trainer + Qualification grouped on one page |
| `pdf-server/htmlGenerator.ts:1720-1726` | details grouping by code prefix → `Student details / Trainer details / Qualification/Course/Program Details / Unit of competency / Office Use Only` |
| `mig/20250211000004_consolidate_compulsory_step.sql:10-47` | step consolidation keyed on titles `Student & Trainer` / `Qualification & Unit` → `Assessment Details` |
| `mig/20250223000001:5-46`, `mig/20250225000003:5-37`, `mig/20260310000002:10-33` | deletes/moves sections by title (`For more information`, duplicate `Reasonable Adjustment`, `Student declaration` to end) |
| `mig/20260319000001:50-53` | deletes steps titled `Written Evidence Checklist` |
| `mig/20261104000001` (DRAFT) / `mig/20261104000002:12-13` (DRAFT) | duplicate-step cleanup and unique `(form_id,title)` index |
| `src/lib/writtenEvidenceChecklist.ts:10-11`, `pdf-server/writtenEvidenceChecklist.ts:9-10` | checklist identity by code `written.evidence.checklist` / mode |

### (c) Per-unit / per-course / per-organisation components

| Location | Keyed on |
|---|---|
| `mig/20260607120000_cpccco2013_q4_tools_grid_rows.sql:1-8` | unit `CPCCCO2013`, question id `8019`, 12 rows |
| `sql/admin_reports/carpentry_incomplete_student_units.sql:1-13` | qualification `CPC30220` (course id 14) vs painting `CPC30620` (id 13) |
| `src/utils/gridTableAnswers.ts:66-79, 104-153, 159-205` | legacy "Tool : Use" line parsing for the Q4 tools table (2-answer-column assumption) |
| `src/utils/formUnitDisplay.ts:18-34, 46-61` | unit code parsed from form name pattern `QUAL_UNITCODE_Unit title` (underscore split, code ≥5 chars with letters+digits) |
| `src/utils/trainerCourseHighlight.ts:5-8` | localStorage key `signflow.trainerHighlightCourseId`, highlight CSS |
| `pdf-server/pdfFileNaming.ts:31-32, 40-52, 54-71` | PDF name from codes `student.id` / `student.fullName`; `{unitCode}_{studentId}_{studentName}.pdf`; SharePoint folder = unit code |
| `pdf-server/htmlGenerator.ts:692-695`, `pdf-server/index.ts:1189-1192`, `pdf-server/logoUrls.ts:16` | organisation identity: Skyline Institute of Technology, `Level 8, 310 King Street Melbourne VIC – 3000`, `RTO: 45989 CRICOS: 04114B`, `info@slit.edu.au`, `+61 3 9125 1661`, SVG logo fallback |
| `src/data/formDefinition.json:3-6` | org name/address/RTO/CRICOS in legacy meta |
| `docs/otp-email-body.html:14`, `docs/otp-email-template.json:2` | org name in OTP email; subject `Your Skyline OTP is :{{OTP}}` |
| `src/lib/formEngine.ts:2152`, `mig/20260402000001_induction_otp_institutional_email.sql:1,38` | institutional email domains `@slit.edu.au` / `@student.slit.edu.au` |
| `src/pages/AdminFormsListPage.tsx:632-644` | placeholders `MSF30422`, `Certificate III in Glass and Glazing`, `MSMSUP102` |
| `src/components/form-fill/QuestionRenderer.tsx:631` | codes `evaluation.trainingDates`, `evaluation.evaluationDate` force a DatePicker |
| `src/pages/InstanceFillPage.tsx:5456-5462, 5619-5623` | code-specific behaviour for `qualification.*`, `unit.*`, `evaluation.unitName/trainerName/employer/trainingDates/evaluationDate` (read-only + auto-filled from `skyline_forms`) |
| `src/utils/identityFieldRepair.ts:3-8`; `InstanceFillPage.tsx:604, 619-627, 809-812, 1080-1124, 1178-1202, 1352-1357, 4513-4524, 4948-4955, 5030-5031` | code lookups `student.fullName/id/email`, `trainer.fullName`, `student.declarationSignature`, `trainer.reasonableAdjustmentSignature`, `evaluation.studentName/trainerName` |

### (d) Marking rules

| Location | Rule |
|---|---|
| `mig/20250217000001:6`, `mig/20260309000001:8` | trainer mark values `yes/no` (per question, per grid row) |
| `mig/20250219000001:6,9`, `mig/20260310000001:3` | results sheet outcomes `s/ns`, three attempts |
| `mig/20250220000001:17-19` | summary outcomes `competent/not_yet_competent` ×3 |
| `src/utils/taskResultsOutcome.ts:82-87` | assessable question = not instruction/page_break and not content-block child |
| `src/utils/taskResultsOutcome.ts:310-369` | derive task S/NS (attempt 1 only) from trainer per-question marks + WEC/marking checklist rows: any `no` → NS, all `yes` → S, else unmarked |
| `src/utils/taskResultsOutcome.ts:392-458` | unit outcome: any task NS → NYC; all S → Competent; else null; check messages :425-448; blocker text :460-471; labels `✓ Satisfactory` :473-477 |
| `src/utils/assessmentResultValidation.ts:18-31` | submission wave = clamp(submission_count,1,3); valid strings :37-50; ≥1 valid attempt required on each results sheet and summary :53-116 |
| `src/pages/InstanceFillPage.tsx:272-320` | `summaryRequiresSecond/ThirdAttempt` (prior NYC), `getSubmissionWave`, active/prep/submit attempt numbers, staff can edit columns `<= active` |
| `src/pages/InstanceFillPage.tsx:587-594, 2586-2591` | trainer may not submit until every task sheet has S/NS for the current attempt |
| `src/pages/InstanceFillPage.tsx:2147-2204` | "attempt N result (Competent / Not Yet Competent) is required" rules |
| `src/pages/InstanceFillPage.tsx:2300-2309` | trainer must mark Yes/No on every required task question (likert exempt) |
| `src/pages/InstanceFillPage.tsx:4535-4560` | results attempt-column editability; trainer footer editability |
| `src/pages/InstanceFillPage.tsx:187-202` | resubmission declaration date must be ≥ prior trainer/attempt date **+1 day** |
| `src/pages/InstanceFillPage.tsx:244-260` | summary `trainer_date_N` ↔ results `*_attempt_date` mirroring |
| `src/components/form-fill/GridTableQuestion.tsx:14-19, 176-178, 250-251, 294-316` | per-row Status (✓/✗) column; rows marked satisfactory read-only on resubmission |
| `src/components/form-fill/QuestionRenderer.tsx:123-128` | `showRowAssessmentColumn` for "Assessment Task 2+" grid tables |
| `src/utils/assessmentAttemptDates.ts:42-262` | date chain S1→T1→S2→T2→S3→T3 and error texts |
| `src/lib/assessmentCompletionStatus.ts:53-83` | office completion = `admin_initial_checked` + `admin_updated_checked` on summary **and** `initial_checked`/`updated_checked` on every task results section |
| `src/lib/assessmentCompletionStatus.ts:90-104, 128-188` | hand-off/auto-complete rules → `completed` |
| `src/components/form-fill/SectionLikertTable.tsx:63-68` | continuous row numbering across likert questions |
| `src/lib/formEngine.ts:1082-1106, 1814-1818` | `trainer_result` = latest non-null attempt; office completed = workflow completed OR both admin checks |

### (e) Outcome / workflow logic

| Location | Rule |
|---|---|
| `src/lib/formEngine.ts:7246-7252` | `InstanceWorkflowStatus` enum `draft/waiting_trainer/waiting_office/completed/failed/awaiting_submission` |
| `src/lib/formEngine.ts:7327-7384` | workflow → legacy `status`/`role_context` mapping (`draft→draft/student`, `awaiting_submission→incomplete/student`, `waiting_*→submitted`, `completed|failed→locked`, office/failed → role office); first submit stamps `submitted_at`, count ≥1 |
| `src/lib/formEngine.ts:1541-1546` | `STUDENT_RESUBMISSION_DAYS_AFTER_NYC = 5` |
| `src/lib/formEngine.ts:1295-1334` | new instance window = today → +30 days (Melbourne) |
| `src/lib/formEngine.ts:1435-1463` | date-change reset rules (end change clears rollovers/did_not_attempt, back to draft/student; full reset clears attempts) |
| `src/lib/formEngine.ts:1657-1679` | student token valid only inside window, expires at deadline 23:59 Melbourne; default TTL student 30 d / staff 90 d |
| `src/lib/formEngine.ts:1995-2022, 2089` | extension default +30 days |
| `src/pages/InstanceFillPage.tsx:2593-2640` | NYC & attempt < 3 → record `trainer_nyc_assessed_on_N`, deadline = assessed-on + 5, instance back to student draft; NYC at attempt 3 → `failed`, role office |
| `src/pages/InstanceFillPage.tsx:2657-2680` | Competent → `waiting_office`; office finalise → `completed` |
| `src/pages/InstanceFillPage.tsx:1798-1835` | who may edit in which workflow state |
| `src/utils/instanceWorkflow.ts:13-63` | legacy status normalisation (locked→completed, submitted+office→waiting_office, incomplete→awaiting_submission, did_not_attempt without submission → failed) |
| `src/utils/assessmentRowUi.ts:36-49` | terminal "did not attempt" = `did_not_attempt && rollovers ≥ 2 && submitted == 0` |
| `src/utils/assessmentRowUi.ts:114-223` | status precedence completed > trainer_completed > pending_review > saved answers > did_not_attempt > in_progress/not_submitted; labels `Completed / Competent / Not competent / Submitted / In progress / Not submitted by due date / Didn't attempt any` |
| `src/utils/assessmentRowUi.ts:334-354, 356-392` | badge labels `Awaiting Student / Waiting Trainer / Waiting Office / Completed / Submitted (Not Sent) / Did not attempt` + colours |
| `src/utils/assessmentRowUi.ts:394-410` | access window text `Expired on … (23:59 AEDT)`; end date applies to students only |
| `src/utils/assessmentRowUi.ts:574-580, 704-708, 762-776, 778-807, 835-849` | attempt texts (`First/Second/Third Attempt Done`, `Submitted Nth attempt — awaiting trainer`, `Second/Third Attempt Required`, `No more attempts (contact admin)`, `Missed 1st attempt, 2nd attempt`), missed-slot mapping (rollover 1 → slot 0, 2 → slot 1, final miss → slot 2) |
| `src/utils/assessmentReportStatus.ts:7-28` | report status Completed/Failed/In Progress |
| `src/utils/notificationOutcome.ts:10-47, 55-83, 88-110` | outcome kind inferred from notification `type` prefixes `workflow_*` and **keyword matching on message text** (`finalised`, `competent`, `missed 1st`, …) |
| `src/utils/assessmentDateChange.ts:14-16, 18-52` | end-date reset dialog text; reset prompt when 3 submissions |
| `mig/20260421000004:5-38` | trigger: student draft→submitted auto-assigns `role_context='trainer'` when batch has a trainer |
| `mig/20260424000001:10-81` | rollover RPC: +5 days per missed window, max 2 rollovers, then `did_not_attempt` + role office; token realign |
| `mig/20260507000000:4-113` | rollover extended to missed window after NYC (attempt 1→2, 2→3) |
| `mig/20260507100000:38-86` | **auto NS on missed 2nd attempt**: sets `final_attempt_2_result='not_yet_competent'`, `second_attempt_satisfactory='ns'`, date = new_end − 5 |
| `mig/20260520140000:4-14`, `mig/20260520140100:66-82` | `trainer_nyc_assessed_on_1..3`; auto-NS date uses assessed-on when present |
| `mig/20260529130000:43-52, 55-140` | did_not_attempt rows forced to `locked`/`failed` |
| `mig/20260917123000:16-30, 38-64, 98-240, 250-470, 487-538` | `status` adds `incomplete`; workflow adds `awaiting_submission`; submit RPC caps `submission_count` at 3 and rejects when not draft/incomplete; rollover rewrites; **pg_cron** job `skyline_run_scheduled_no_attempt_rollover` |
| `mig/20261105000001:24-70`, `mig/20261105000002:21-264` | `extension_date` CHECK ≥ end_date, mirror trigger, effective deadline `COALESCE(extension_date,end_date)` in every RPC |
| `mig/20260706140000:13-165` | PDF enqueue when `status='locked' AND workflow_status='completed'`, role `office` |
| `mig/20260422000001:33` | `failed` workflow value |
| `src/lib/studentAssessmentAccess.ts:17-27` | course-lifecycle access messages (`MSG_COURSE_NOT_IN_PROGRESS`, tentative/suspended/cancelled/completed) |

### (f) Instructions, declarations and acknowledgement text

| Location | Text |
|---|---|
| `src/lib/defaultFormSteps.ts:43-49` | "Fill out assessment outcome records in the Student Pack when: …" (Instructions to complete outcomes) |
| `src/lib/defaultFormSteps.ts:67, 85, 103, 121, 139, 157, 175, 193, 255, 273, 291, 309` | Unit Requirements, Feedback to student, Plagiarism, Collusion, Competency outcome, Additional evidence, Reassessment, Fail to complete by due date, Confidentiality, Assessment appeals process, Recognised prior learning, Special needs |
| `src/lib/defaultFormSteps.ts:206, 212, 221, 228` | Reasonable Adjustment description and question labels |
| `src/lib/defaultFormSteps.ts:322-327` | Student declaration (4 bullets incl. plagiarism-checking permission) |
| `src/lib/formEngine.ts:5752` | "The student must be assessed as satisfactory in each of the following assessment tasks…" |
| `src/lib/formEngine.ts:5823, 5829`; `mig/20260310000003:40, 49` | "Reasonable Adjustment: See Appendix A – Reasonable Adjustments for details…" |
| `mig/20250221000001:23` | RA description "Students with carer responsibilities, cultural or religious obligations…" |
| `src/pages/InstanceFillPage.tsx:3057-3076` | "Student Pack" introduction (purpose, contents, evaluation form, link to other unit documents) |
| `pdf-server/htmlGenerator.ts:742-760`, `pdf-server/index.ts:1239-1256` | same intro text in PDF |
| `src/pages/InstanceFillPage.tsx:3047-3050` | Office admin task instructions |
| `src/pages/InstanceFillPage.tsx:3124, 3134` | RA indicator fallback sentence |
| `src/pages/InstanceFillPage.tsx:3814-3821`; `src/components/form-fill/TaskInstructionsBlocksDisplay.tsx:67, 176-192` | fixed instruction block headings: Assessment type / Instructions provided to the student / Applicable conditions / Resubmissions and reattempts / Location / Instructions for answering the written questions / Purpose of the assessment / Task instructions |
| `pdf-server/htmlGenerator.ts:1050`, `pdf-server/index.ts:1639` | "Assessment method-based instructions and guidelines: {row_help}" |
| `src/pages/InstanceFillPage.tsx:4792-4800`; `pdf-server/htmlGenerator.ts:1353-1354`; `pdf-server/index.ts:2017-2018` | Results-sheet Student Declaration bullets ("I declare that the answers I have provided are my own work…", permission to reproduce / plagiarism check) |
| `src/pages/InstanceFillPage.tsx:4896-4899`; `pdf-server/htmlGenerator.ts:1380` | "Office Use Only — The outcome of this assessment has been entered into the Student Management System." |
| `src/pages/InstanceFillPage.tsx:5211`; `pdf-server/htmlGenerator.ts:1467`; `index.ts:2116` | Trainer/Assessor summary declaration "I declare that I have conducted a fair, valid, reliable, and flexible assessment…" |
| `src/pages/InstanceFillPage.tsx:5225`; `htmlGenerator.ts:1471`; `index.ts:2120` | Student summary declaration "I declare that I have been assessed in this unit… appeal rights." |
| `src/pages/InstanceFillPage.tsx:5250`; `htmlGenerator.ts:1478`; `index.ts:2127` | "Administrative use only - Entered onto Student Management Database" Initial/Updated |
| `pdf-server/htmlGenerator.ts:1547-1568`; `index.ts:2190-2210` | Appendix A policy bullets + Trainer/Assessor Declaration ("I declare that I have attached all relevant evidence to provide reasonable adjustment…") |
| `pdf-server/htmlGenerator.ts:781`, `index.ts:1283` | "Appendix B - Learner Evaluation Form" |
| `pdf-server/htmlGenerator.ts:944`, `index.ts:1463` | task table headers "Evidence number" / "Assessment method/ Type of evidence" (also `InstanceFillPage.tsx:3307-3308`) |
| `pdf-server/htmlGenerator.ts:1334-1348, 1434-1466`; `index.ts:1998-2012, 2083-2115` | "Satisfactory (S) / Not Satisfactory (NS)", "Competent / Not Yet Competent", default summary rows `Assessment Task 1/2` when no tasks |
| `pdf-server/writtenEvidenceChecklist.ts:74, 83-84` | "Written Evidence Checklist", columns "Written Evidence / Submitted / Yes / No" |
| `src/pages/InstanceFillPage.tsx:4585, 4654, 4723, 4842, 4860` | "First attempt:", "Second attempt:", "Third attempt:", "Trainer/Assessor Name/Signature" |
| `src/pages/InstanceFillPage.tsx:3526` | "(Please describe here)" under Other submission method |
| `src/pages/InstanceFillPage.tsx:2709-2726` | confirm dialogs "Final Submit…", "Office Check…" |
| `src/pages/InstanceFillPage.tsx:2060-2080, 2103, 2147-2204, 2308, 2402, 2587, 2605, 2629` | validation / toast strings |
| `src/utils/assessmentValidationMessages.ts:34-52, 58-74, 88` | message formats (`Q9 – Title: Field is required.`, "N questions are incomplete…") |
| `src/utils/assessmentResultValidation.ts:5-6`; `src/utils/taskResultsOutcome.ts:425-448, 460-471`; `src/utils/assessmentAttemptDates.ts:131-153, 170-189, 217-238` | progress/blocker/date-chain messages |
| `src/lib/formEngine.ts:1843-1902, 2139, 2163, 2170, 2215, 2567, 2587` | access/OTP/session messages ("This secure link has expired…", "OTP sent… Valid for 10 minutes.") |
| `src/lib/generatedPdfs.ts:37-52, 97-98` | PDF availability messages |
| `src/pages/AdminFormBuilderPage.tsx:2066-2071, 2108-2114, 2936-2957, 3302-3316` | builder helper copy describing fixed sheets |
| `src/pages/AdminFormsListPage.tsx:212, 553, 596, 618` | list-page copy |
| `src/data/formDefinition.json:237-244` | legacy declaration checkbox texts |
| `src/constants/enrolmentOptions.ts:166-250` | enrolment application checklist + declaration items (public form) |
| `docs/DYNAMIC_ASSIGNMENT_INSTRUCTIONS.md:50-69` | sample instruction texts (documentation only) |

### (g) File rules

| Location | Rule |
|---|---|
| `src/lib/storage.ts:3-4` | bucket `photomedia`, folder `skyline` |
| `src/lib/storage.ts:13-17, 22` | HEIC/HEIF types list; converted to JPEG quality 0.92 |
| `src/lib/storage.ts:42-47, 76, 103-107, 140, 182, 227` | path templates; name sanitised to 50 / 40 chars; unique by `Date.now()`; `upsert:false` |
| `src/lib/storage.ts:259` | public URL marker `/storage/v1/object/public/photomedia/` |
| `src/components/form-fill/QuestionRenderer.tsx:229, 342-346, 386, 306` | accept `image/*` (answer image), `image/*` or `.heic/.heif` (attachment), extension map png/gif/webp/jpg |
| `src/pages/AdminFormBuilderPage.tsx:756-757, 1857, 2278, 2283, 2605, 2681, 2769, 3336` | cover accepts `image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif`; others `image/*` |
| `src/constants/enrolmentOptions.ts:288-293` | enrolment `FILE_SIZE_LIMITS` passport 5 MB / default 15 MB; `ALLOWED_FILE_TYPES` jpeg/jpg/png/gif/pdf |
| (none) | no size/count limits for assessment uploads; one image per slot |
| `mig/20260427000001:1-10` | learning materials path `photomedia/Learning/<formname-id>/<filename>` (comment only) |
| `pdf-server/pdfConstants.ts:2, 5, 7-8, 17-29, 63` | bulk export max 25; Chromium restart after 4 jobs; 60 s timeouts; signature 150×60 px, answer images max 280 px; warn on base64 > 400 KB |
| `supabase/functions/trigger-pdf-worker/index.ts:58` | worker batch limit ≤ 2 |
| `src/utils/parseInstructionInput.ts:400` | `.docx` import via mammoth |

### (h) Conditional behaviour keyed to specific questions/sections/roles

| Location | Condition |
|---|---|
| `src/utils/roleGuard.ts:3-19` | missing role key ⇒ visible/editable |
| `src/utils/roleUtils.ts:3-24` | legacy scope rules (office sees all, edits only office scope; submitted locks) |
| `src/lib/formEngine.ts:5688-5695` | role preset constants used by seeds |
| `mig/20250213000001:2-4`, `mig/20250220000001_assessment_submission_student_edit.sql:2-4`, `mig/20250225000001:2-4`, `mig/20250213000004:3-5`, `mig/20260312000001:5-22`, `mig/20260322000003:4-13` | role editability/visibility rewritten by `code` (`assessment.submission`, `trainer.fullName`, `qualification.*`, Appendix A trainer/office only, Appendix B all, checklist codes) |
| `src/pages/InstanceFillPage.tsx:548-585` | office ⊇ trainer ⊇ student editability/visibility override |
| `src/pages/InstanceFillPage.tsx:1798-1835, 1985` | workflow-state gating; trainer-marked-satisfactory read-only |
| `src/pages/InstanceFillPage.tsx:2021, 3082` | Appendix A / `reasonable_adjustment` sections hidden for students |
| `src/pages/InstanceFillPage.tsx:2247-2250, 3167-3169` | Appendix A editable only in first cycle (submission wave < 2 and no 2nd/3rd attempt data) |
| `src/pages/InstanceFillPage.tsx:2029, 2262-2268, 3080-3091, 5334, 5438` | de-duplicate `student.declarationSignature` when also shown in submission section (`assessmentSubmissionHasDeclSig` hard-coded `false` at :3080) |
| `src/pages/InstanceFillPage.tsx:3092-3103` | hide WEC / marking checklist sections with no rows |
| `src/pages/InstanceFillPage.tsx:3484-3486` | submission options spanning full width when label matches `/lms|learning management/i` or value `other` |
| `src/pages/InstanceFillPage.tsx:3516-3527` | `short_text` inside `assessment_submission` rendered as underline input |
| `src/pages/InstanceFillPage.tsx:5341, 5542` | signature with code starting `student.` gets declaration min-date handling |
| `src/pages/InstanceFillPage.tsx:5426, 5636` | `declarations` mode ⇒ `declarationStyle` checkboxes |
| `src/pages/InstanceFillPage.tsx:2878, 2891` | PDF preview only for office role |
| `src/components/form-fill/QuestionRenderer.tsx:445` | inline attachment layout only for short/long text |
| `src/components/form-fill/QuestionRenderer.tsx:99`, `AdminFormBuilderPage.tsx:2339` | image width clamped 20-80 % |
| `src/components/form-fill/GridTableQuestion.tsx:130-136` | layout-dependent default column labels (`Item/Description`, `Polygon Name/Polygon Shape`, `Shape/Image`, `Name/Image`) |
| `src/pages/AdminFormBuilderPage.tsx:2099, 2141, 2166` | instruction editor only for `instruction_block` inside `task_questions` |
| `src/pages/AdminFormBuilderPage.tsx:2387-2398, 2544` | `textAboveHeader` and content blocks only in `task_questions` |
| `src/pages/AdminFormBuilderPage.tsx:2527-2543` | rows editor shown for likert/grid/checklist/marking codes only |
| `src/pages/AdminFormBuilderPage.tsx:1215-1216` | duplicated task-linked sections lose their task link |
| `src/pages/AdminFormBuilderPage.tsx:2260` | attachment toggle hidden for `NON_ANSWER_QUESTION_TYPES` |
| `src/utils/stepAnswerSave.ts:44, 64`, `src/lib/answerAttachment.ts:40` | instruction/page_break never saved |
| `src/utils/taskResultsOutcome.ts:82-87, 338-361` | marking derived only from `task_questions`, `task_marking_checklist`, `task_written_evidence_checklist` sections |
| `src/lib/writtenEvidenceChecklist.ts:28-33` | any `single_choice` in WEC mode is a checklist |
| `pdf-server/htmlGenerator.ts:799, 1386`, `index.ts:1301, 2035` | section numbering/exclusion by mode and by title `'Assessment Summary Sheet'` |
| `pdf-server/htmlGenerator.ts:1484-1486, 1525-1536` | RA indicator vs full RA rendering decided by presence of Appendix A |
| `src/pages/StudentDashboardPage.tsx` et al. (see `src/lib/assessmentWorkflowMigration.test.ts:51-52`) | client no longer calls rollover RPC; relies on cron |

### (i) Anything else baked in

| Location | Item |
|---|---|
| `mig/20250211000000:11, 93-94`; `mig/20260917123000:16, 24-30`; `mig/20260227000002:25`; `mig/20260422000001:33` | enums: form status, instance status, role_context, workflow_status |
| `mig/20260703180000:29-31`; `src/lib/generatedPdfs.ts:3` | `pdf_status` enum |
| `src/lib/formEngine.ts:2347`, `mig/20260405000001` | staff roles `superadmin/admin/trainer/office` |
| `src/lib/formEngine.ts:1488-1498, 1549-1575`; `src/utils/melbourneTime.ts:3`; `src/utils/assessmentRowUi.ts:60-63, 407`; `mig/20260424000001:24, 44`; `mig/20260917123000`; `mig/20261105000002:28, 147, 264`; `InstanceFillPage.tsx:2605` | `Australia/Melbourne` time zone and "23:59 AEDT/Melbourne" semantics everywhere (client + SQL) |
| `src/lib/formEngine.ts:6012-6021` | default form dates = current month start/end |
| `src/lib/formEngine.ts:6037-6038, 6558-6563, 6570` | version default `1.0.0`, duplicate bumps minor, status forced `published`, name suffix `(Copy)` |
| `src/lib/questionDuplicate.ts:35-38` | `(Copy)` label suffix |
| `src/lib/assessmentTaskSteps.ts`, `src/lib/taskQuestionsNumbering.ts`, `src/components/form-fill/QuestionRenderer.tsx:520-521`, `src/utils/assessmentValidationMessages.ts:17-19` | numbering schemes `Assessment Task - N`, `Q{n}:` |
| `src/components/form-fill/SectionLikertTable.tsx:7-13`, `PdfDocument.tsx:11-19` | likert section codes A/B/C |
| `src/pages/InstanceFillPage.tsx:2545-2548, 2611-2615, 2635-2639, 2657-2660, 2677-2680`; `src/lib/formEngine.ts:7801-7825` | notification titles/messages/types `workflow_student_submit/resubmit/failed/to_office/completed` (in-app + FCM via `send-notification` Edge Function) |
| `docs/otp-email-template.json`, `docs/otp-email-body.html`, `docs/POSTMARK_OTP.md` | OTP email templates (Postmark / Power Automate) |
| `src/lib/formEngine.ts:1305, 1679, 1995, 2089, 2139` | durations: 30-day instance window, 30/90-day tokens, 30-day extension, 10-minute OTP, `STAFF session 12 h` (:2521) |
| `src/lib/formEngine.ts:637, 4308, 2437`; `src/pages/AdminFormsListPage.tsx:20` | chunk 200, grade-me cap 2000, impersonation pending 120 s, page size 20 |
| `src/pages/AdminFormBuilderPage.tsx:688, 2990, 3106`; `InstanceFillPage.tsx:1522, 1675` | debounce timings 450 / 300 / 800 ms |
| `src/store/formStore.ts:46`; `src/lib/formEngine.ts:2386-2389, 2436, 2526`; `src/utils/trainerCourseHighlight.ts:5`; `src/constants/enrolmentOptions.ts:1` | localStorage/sessionStorage keys |
| `src/form/layout.ts:5-32` | A4 geometry, fonts, likert column widths (legacy) |
| `src/components/form-fill/SignatureField.tsx:171-180`, `SignaturePad.tsx:138-147` | canvas 600×240/320, pen `#dc2626`, typed signature red italic serif |
| `src/components/form-fill/GridTableQuestion.tsx:157-158, 225`; `SectionLikertTable.tsx:38-57` | table styling `#595959/#5E5E5E` headers, min-width 760/500 px |
| `pdf-server/pdfFileNaming.ts:7-13` | filename sanitiser |
| `src/pages/AdminFormsListPage.tsx:19, 150` | superadmin-only form management; generic link route `/forms/{id}/student-access` |
| `src/pages/AdminFormPreviewPage.tsx:19-24`, `src/lib/generatedPdfs.ts:76-95` | pdf-server routes `/pdf/preview/form/{id}`, `/pdf/{instanceId}?role=` |
| `mig/20260610120000` … `20260729035851`, `src/lib/paymentPlanCalculations.ts` | finance/payment-plan enums and rules (out of form scope) |
| `src/lib/courseLifecycle.ts`, `mig/20260713140000:20, 288-290` | course enrolment statuses and transitions |

### Actual assessment content embedded in source (for a converter → JSON import)

Only template scaffolding and policy/evaluation text live in source; **unit-specific question banks (e.g. CPCCCO2013 written questions, practical checklists) exist only in the live DB** (`skyline_form_*` rows) and must be exported from there.

| # | Content set | Source ranges | Shape produced |
|---|---|---|---|
| 1 | Introductory Details step scaffold (student/trainer details, qualification/unit, Assessment Tasks grid + default tasks, Assessment Submission Method options, RA indicator) | `src/lib/formEngine.ts:5709-5831` | 5 sections, 12 questions, 4 options, 2 rows |
| 2 | 15 policy instruction sections + Reasonable Adjustment (yes_no/short/long/signature) + Student declaration signature | `src/lib/defaultFormSteps.ts:32-343` (`createDefaultSectionsToStep` :346-401) | 16 sections, 19 questions, 2 options |
| 3 | Per-task step scaffold: Student Instructions / Questions / Written Evidence Checklist (`written.evidence.checklist` yes/no) / Assessment Marking Checklist (`evidence_outcome`, `performance_outcome` yes/no) / Results | `src/lib/formEngine.ts:412-537`; migrations `20260319000001:28-41`, `20260322000002:35-68`, `20260322000005:27-95`; builder `AdminFormBuilderPage.tsx:915-996` | 5 sections, 3 questions, 6 options per task (checklist rows come from DB) |
| 4 | Assessment Summary step/section (no questions; sheet rendered from code) | `src/lib/formEngine.ts:5844-5854`; `mig/20250220000002:2-26`; sheet layout `InstanceFillPage.tsx:4931-5280`, `pdf-server/htmlGenerator.ts:1386-1480` | 1 step, 1 section + fixed sheet (3 attempts × tasks, Competent/NYC, 2 declarations, feedback, admin Initial/Updated) |
| 5 | Appendix A – Reasonable Adjustments: questions, strategies matrix (55 checkboxes), policy bullets and trainer declaration | `src/lib/formEngine.ts:5856-5878`; `mig/20250221000001:20-45`; `mig/20250225000004:8-44`; `src/lib/appendixAMatrixData.ts:12-125` (+ `pdf-server/appendixAMatrixData.ts`); `pdf-server/htmlGenerator.ts:1547-1568` | 1 step, 1 section, 4 questions, matrix JSON, 2 text blocks |
| 6 | Appendix B – Learner Evaluation: Participant Information (6 q), Logistics (4 rows), Trainer/Assessor (7 rows), Learning (7 rows), 3 comment questions, Likert scale labels | `src/lib/formEngine.ts:5880-5990`; `mig/20250222000001:3-171`; `LikertTableQuestion.tsx:12-13` | 1 step, 4 sections, 12 questions, 18 rows |
| 7 | Legacy Training Evaluation Form (JSON) | `src/data/formDefinition.json:1-292` | 3 pages, 11 sections, 18 likert items, 2 declaration checkboxes |
| 8 | Results Sheet template (3 attempts S/NS+date+feedback, Student Declaration bullets, student name/signature, trainer name/signature/date, Office Use Only) | `InstanceFillPage.tsx:4504-4930`; `pdf-server/htmlGenerator.ts:1320-1385`; `pdf-server/index.ts:1990-2035` | fixed sheet (no questions) |
| 9 | Student Pack introduction page | `InstanceFillPage.tsx:3057-3076`; `pdf-server/htmlGenerator.ts:742-760`; `index.ts:1239-1256` | 4 paragraphs + 2 lists |
| 10 | RA indicator text and RA description | `mig/20260310000003:40,49`; `formEngine.ts:5823,5829`; `mig/20250221000001:23` | 2 strings |
| 11 | Written Evidence Checklist / Marking Checklist labels and table headers | `pdf-server/writtenEvidenceChecklist.ts:74,83-84`; `formEngine.ts:453-457` | labels only (rows in DB) |
| 12 | Task-instructions fixed block headings and default location options | `InstanceFillPage.tsx:3814-3821`; `TaskInstructionsBlocksDisplay.tsx:176-192`; `docs/DYNAMIC_ASSIGNMENT_INSTRUCTIONS.md:50-69` | 8 headings (+ example texts in docs) |
| 13 | Default task labels/methods and submission-method options | `AdminFormsListPage.tsx:94-97`; `formEngine.ts:5784-5785, 5810-5815` | 2 rows, 4 options |
| 14 | CPCCCO2013 Q4 tools grid row expansion | `mig/20260607120000:4-8` | 11 blank rows for question 8019 |
| 15 | Organisation identity for PDF/header | `pdf-server/htmlGenerator.ts:692-695`; `index.ts:1189-1192`; `formDefinition.json:3-6`; `pdf-server/logoUrls.ts` | 1 record |
| 16 | Public enrolment application options, checklist and declarations | `src/constants/enrolmentOptions.ts:3-293` | ~20 option lists, 6 checklist items, declaration items |
| 17 | Paste-parser vocabularies | `src/utils/parseMixedContent.ts:16-48, 259-265`; `TaskInstructionsModal.tsx:256-260` | header/label lists |
| 18 | Role preset matrices used by seeds | `src/lib/formEngine.ts:5688-5695`; `defaultFormSteps.ts:9-12`; migrations in §(h) | 8 presets |


---

## Module S-C. C. Submissions — Assessment Lifecycle Audit

Read-only audit of `C:\Users\goura\Desktop\Submissions` (React 19 / Vite / TS + Supabase, hosted project `qoylrmorezlqdvufonmx`, never touched). Source only; no `.env*` read, nothing executed. Paths are relative to that repo root. `M:` is shorthand for `supabase/migrations/`. Line numbers were taken from the files as read on 2026-11-13.

Scope of the data model: every table is prefixed `skyline_` (except `student_enrolment_applications`, `impersonation_logs`, `ax_*`). All PKs are `BIGINT GENERATED ... AS IDENTITY` (a few `BIGSERIAL`/UUID). The app does **not** use Supabase Auth: every browser request runs as the `anon` role (`docs/security-followups.md:7-9`, `README.md:10` "No RLS (per spec)").

---

### 1. Database schema

#### 1.1 Table inventory — assessment domain

| Table | Columns (type, default) | FKs / unique / check | Defined at |
|---|---|---|---|
| `skyline_forms` | `id`, `name text NN`, `version text`, `status text ='draft'` CHECK draft/published/archived, `unit_code`, `header_asset_url`, `cover_asset_url`, `created_at tz`; `qualification_code`, `qualification_name`, `unit_name`; `start_date text`, `end_date text` (legacy, unused for access); `created_by/updated_by → skyline_users`, `updated_at`; `active bool =true`; `learning_material_urls text[] ='{}'` | FK audit cols → `skyline_users(id)` | `M:20250211000000_create_form_tables.sql:7-16`; cover `M:20250211000002:2`; qual/unit `M:20250213000003:2-4`; dates `M:20260302000001:4-5`; audit `M:20260314000001:14-16`; active `M:20260321000001:2`; URLs `M:20260525100000:3` |
| `skyline_form_steps` | `id`, `form_id NN`, `title NN`, `subtitle`, `sort_order int =0`, audit cols | FK `form_id → skyline_forms ON DELETE CASCADE`; DRAFT unique `(form_id,title)` (not applied) | `M:20250211000000:19-28`; audit `M:20260314000001:21-26`; unique draft `M:20261104000002:12-13` |
| `skyline_form_sections` | `id`, `step_id NN`, `title NN`, `description`, `pdf_render_mode text ='normal'`, `sort_order`, `assessment_task_row_id`, `instructions_meta jsonb`, audit cols | FK `step_id → steps CASCADE`; FK `assessment_task_row_id → skyline_form_question_rows SET NULL`; CHECK `pdf_render_mode IN (normal, likert_table, grid_table, declarations, assessment_tasks, assessment_submission, reasonable_adjustment, reasonable_adjustment_indicator, additional_instructions, task_instructions, task_questions, task_written_evidence_checklist, task_marking_checklist, task_results, assessment_summary)` | `M:20250211000000:31-41`; task link `M:20250216000001:7`; instructions `M:20260409000001:5`; final CHECK `M:20260409000002:3-12` |
| `skyline_form_questions` | `id`, `section_id NN`, `type NN`, `code`, `label NN`, `help_text`, `required bool =false`, `sort_order`, `role_visibility jsonb ='{}'`, `role_editability jsonb ='{}'`, `pdf_meta jsonb ='{}'`, audit cols | FK `section_id → sections CASCADE`; CHECK `type IN (instruction_block, short_text, long_text, yes_no, single_choice, multi_choice, likert_5, grid_table, date, signature, page_break, image)` | `M:20250211000000:44-62`; image type `M:20260415000001:7-24`; audit `M:20260314000001:37-42` |
| `skyline_form_question_options` | `id`, `question_id NN`, `value NN`, `label NN`, `sort_order`, audit cols | FK `question_id → questions CASCADE` | `M:20250211000000:65-74` |
| `skyline_form_question_rows` | `id`, `question_id NN`, `row_label NN`, `row_help`, `row_image_url`, `sort_order`, `row_meta jsonb ='{}'` (task instructions rich text), audit cols | FK `question_id → questions CASCADE` | `M:20250211000000:77-87`; row_meta `M:20250216000001:4` |
| `skyline_form_assets` | `id`, `form_id NN`, `type`, `file_url NN`, `meta jsonb`, `created_at` | FK `form_id CASCADE` | `M:20250211000000:119-128` (no caller found in `src/`) |
| `skyline_form_instances` | `id`, `form_id NN`, `status text ='draft'` CHECK draft/submitted/locked/**incomplete**, `role_context text ='student'` CHECK student/trainer/office, `created_at`, `submitted_at`; `student_id`; `workflow_status text ='draft'` CHECK draft/waiting_trainer/waiting_office/completed/failed/**awaiting_submission**, `trainer_checked_at`, `office_checked_at` (never written by app); `submission_count int NN =0`; `start_date date`, `end_date date` (TEXT→DATE); `no_attempt_rollovers int NN =0`, `did_not_attempt bool NN =false`; `admin_reference_note text`; `trainer_nyc_assessed_on_1/2/3 date`; `extension_date date`; `created_by/updated_by`, `updated_at` | FK `form_id → forms CASCADE`; FK `student_id → students SET NULL`; CHECK `skyline_form_instances_extension_not_before_end (extension_date IS NULL OR end_date IS NULL OR extension_date >= end_date)`; **no unique (form_id, student_id)** — one-instance-per-student-form is enforced only in app code (`src/lib/formEngine.ts:1253-1266`) | `M:20250211000000:90-99`; student `M:20250211000001:12-15`; workflow `M:20260227000002:3-9`; count `M:20260325000001:2-12`; dates `M:20260326000004:3-8` → DATE `M:20260415000005:5-31`; rollover `M:20260424000001:4-6`; failed `M:20260422000001:31-33`; note `M:20260519120000:3-7`; nyc dates `M:20260520140000:4-14`; incomplete/awaiting `M:20260917123000:12-31`; extension `M:20261105000001:24,41-43` |
| `skyline_form_answers` | `id`, `instance_id NN`, `question_id NN`, `row_id`, `value_text`, `value_number numeric`, `value_json jsonb`, `updated_at`, `created_at`, `created_by/updated_by` | FK instance/question/row all `CASCADE`; partial UNIQUE `(instance_id, question_id) WHERE row_id IS NULL` and `(instance_id, question_id, row_id) WHERE row_id IS NOT NULL` | `M:20250211000000:102-116`; audit `M:20260314000001:68-72` |
| `skyline_form_trainer_assessments` | `id`, `instance_id NN`, `question_id NN`, `satisfactory text` CHECK yes/no, `updated_at` | UNIQUE `(instance_id, question_id)`; FKs CASCADE | `M:20250217000001:2-11` |
| `skyline_form_trainer_row_assessments` | `id`, `instance_id`, `question_id`, `row_id NN`, `satisfactory` CHECK yes/no, `updated_at` | UNIQUE `(instance_id, question_id, row_id)`; FKs CASCADE | `M:20260309000001:3-13` |
| `skyline_form_results_data` (per task "Results Sheet") | `id`, `instance_id NN`, `section_id NN`, `first/second/third_attempt_satisfactory text` CHECK s/ns, `first/second/third_attempt_date text`, `first/second/third_attempt_feedback text`, `trainer_name`, `trainer_signature text`, `trainer_date text`, `student_name`, `student_signature text`, `updated_at` | UNIQUE `(instance_id, section_id)`; FK section → `skyline_form_sections CASCADE` | `M:20250219000001:2-19` / `M:20250224000001:16-33`; student `M:20250225000002:3-4`; trainer `M:20250225000005:3-5`; 3rd attempt `M:20260310000001:3-5` |
| `skyline_form_results_office` | `id`, `instance_id`, `section_id`, `entered_date date`, `entered_by text`, `initial_checked bool NN`, `updated_checked bool NN`, `updated_at` | UNIQUE `(instance_id, section_id)` | `M:20250224000001:3-13`; checkboxes `M:20260530140000:3-5` |
| `skyline_form_assessment_summary_data` | `id`, `instance_id NN`, `start_date text`, `end_date text`, `final_attempt_1/2/3_result text` CHECK competent/not_yet_competent, `trainer_sig_1..3 text`, `trainer_date_1..3 text`, `student_sig_1..3 text`, `student_date_1..3 text`, `student_overall_feedback text`, `admin_initials text`, `admin_initial_checked bool`, `admin_updated_checked bool`, `updated_at` | UNIQUE `(instance_id)` | `M:20250220000001:12-38`; admin checks `M:20260530140000:7-9` |
| `skyline_instance_access_tokens` | `id`, `instance_id NN`, `role_context` CHECK student/trainer/office, `token text UNIQUE`, `expires_at NN`, `consumed_at`, `revoked_at`, `created_at` | FK instance CASCADE | `M:20260225000004:2-17` |
| `skyline_submission_events` | `id`, `instance_id NN`, `student_id`, `event_type text`, `request_id text`, `success bool`, `error`, `occurred_at` | UNIQUE `(instance_id, request_id)`; RLS on, anon/authenticated revoked, service_role SELECT/INSERT | `M:20260917123000_assessment_submission_workflow_hardening.sql:71-94` |
| `skyline_assessment_acknowledgments` | `id uuid`, `student_id NN`, `instance_id NN` (no FK), `form_name`, `outcome_label`, `outcome_kind`, `acknowledged_at` | UNIQUE `(student_id, instance_id)`; `GRANT ALL ... TO anon` | `M:20260613120000:3-17` |
| `skyline_generated_pdfs` | `id bigserial`, `instance_id NN`, `role ='office'`, `pdf_status ='pending'` CHECK pending/generating/uploaded/failed/stale, `sharepoint_web_url`, `sharepoint_public_url`, `sharepoint_drive_item_id`, `sharepoint_site_id`, `sharepoint_drive_id`, `storage_path`, `retry_count`, `last_error`, `locked_at`, `locked_by`, `generated_at`, `uploaded_at`, `last_downloaded_at`, `download_count`, timestamps | UNIQUE `(instance_id, role)` | `M:20260703180000:7-37` |
| `skyline_students` | `id`, `name NN`, `email NN`, `created_at`; `student_id text` (external ID); `first_name`, `last_name`, `phone`, `date_of_birth`, `address_line_1/2`, `city`, `state`, `postal_code`, `country`, `guardian_name`, `guardian_phone`, `notes`, `status ='active'`; `batch_id`; `password_hash`; audit cols | FK `batch_id → skyline_batches ON DELETE RESTRICT`; partial UNIQUE `lower(trim(student_id))`; trigger `skyline_students_batch_course_check` | `M:20250211000001:2-9`; `M:20260225000005:3`; `M:20260227000001:3-16`; `M:20260302000002:12-15`; `M:20260306000001:5-6`; unique `M:20260615200000:17-19`; trigger `M:20260615210000:39-43` |
| `skyline_users` (renamed from `skyline_trainers`) | `id`, `full_name NN`, `email UNIQUE`, `phone`, `status` CHECK active/inactive, `created_at`, `updated_at`; `role` CHECK superadmin/admin/trainer/office, `password_hash`; `is_master bool`; `can_login_as_student`, `can_login_as_trainer`; `can_view_finance_reports` etc. | | `M:20260225000003:2-13`; rename `M:20260302000003:5-10`; master `M:20260313000001:14`; superadmin `M:20260405000001:3-6`; rights `M:20260429130500:2-4` |
| `skyline_batches` | `id`, `name NN`, `trainer_id NN`, `created_at`; `course_id`; audit cols; `allow_trainer_student_login bool NN` | FK `trainer_id → skyline_users RESTRICT`; FK `course_id → courses RESTRICT` | `M:20260302000002:2-9`; course `M:20260326000002:3`; flag `M:20261110000001:15-16` |
| `skyline_batch_trainers` | `batch_id`, `user_id`, `created_at` | PK `(batch_id, user_id)`; FK batch CASCADE, user RESTRICT; primary trainer mirrored here | `M:20260530120000:3-21` |
| `skyline_courses` | `id`, `name NN`, `sort_order`, `created_at`; `qualification_code`; audit cols | | `M:20260310000004:2-9`; `M:20260327000001:3` |
| `skyline_course_forms` | `course_id`, `form_id` | PK `(course_id, form_id)`; both CASCADE | `M:20260310000004:12-18` |
| `skyline_student_courses` | `student_id`, `course_id`, `status ='active'` CHECK active/inactive, audit cols; `start_date date`, `end_date date`, `enrollment_status NN ='in_progress'` CHECK tentative/in_progress/suspended/cancelled/completed, `completed_at date`, `intake_label`; `enrollment_status_changed_at/by` | PK `(student_id, course_id)`; partial UNIQUE one `in_progress` per student; CHECK `start_date <= end_date`; trigger `trg_skyline_validate_student_course_row` (no overlap, one in-progress) | `M:20260409000003:4-24`; `M:20260614120000:3-15`; `M:20260713140000:11-32,146-148,229-232` |
| `skyline_course_link_exports` | `id`, `course_id NN`, `batch_id`, `payload_json jsonb NN`, `created_at`, `created_by` | FK course CASCADE, batch SET NULL | `M:20260326000003:2-12` |
| `skyline_learning_doc_activity` | `id`, `form_id NN`, `action` CHECK upload/delete/add_url/remove_url, `file_path`, `file_name`, `public_url`, `audience` CHECK student/trainer, `performed_by`, `performed_by_name`, `created_at` | FK form CASCADE | `M:20260525110000:2-16` |
| `skyline_notifications` | `id uuid`, `user_id text NN` (student id or user id as text), `title`, `message`, `url`, `type ='general'`, `is_read`, `created_at`, `read_at` | realtime publication | `M:20260429154000:15-29`; `M:20260430120000:3-18` |
| `skyline_push_tokens` | `id uuid`, `user_id text`, `fcm_token`, `platform`, `browser`, `is_active`, timestamps | UNIQUE `(user_id, fcm_token)` | `M:20260429154000:2-12` |
| `skyline_otps` | `id`, `email`, `otp_code`, `expires_at`, `created_at` | | `M:20260313000001:2-11` |
| `skyline_inductions` / `skyline_induction_sessions` / `skyline_induction_submissions` | windows with `access_token uuid UNIQUE`, `start_at/end_at`; sessions `(induction_id, student_id, session_token uuid, expires_at)`; submissions `(induction_id, student_id, student_email, payload jsonb, submitted_at)` UNIQUE `(induction_id, student_id)`; later `guest_email`, `deleted_at`, `draft_updated_at` | RLS enabled (no policies; RPC only) | `M:20260330000001:3-14`; `M:20260330000002:4-31`; `M:20260330100001`; `M:20260330180001`; `M:20260522100000` |
| `skyline_staff_sessions` / `impersonation_logs` | `token_hash PK`, `user_id`, `expires_at (+12h)`; log of actor/target/batch/ip/ua, no FKs | RLS on, all client grants revoked | `M:20261110000001:24-62` |
| `student_enrolment_applications` | `id uuid`, `application_no UNIQUE`, `status` CHECK draft/submitted/under_review/approved/rejected, names, email, `payload jsonb`, `files jsonb`, `agent_copy_sent` | RLS on, RPC-only | `M:20260514120000:3-31` |
| Finance (names only) | `ax_invoices`, `ax_invoice_payments`, `ax_invoice_payment_allocations`, `ax_student_ledger_entries`, `skyline_payment_plans`, `skyline_payment_plan_installments`, `skyline_student_payment_plans`, `skyline_student_payment_plan_installments`, `skyline_payment_plan_audit`, `skyline_student_payment_transactions`, `skyline_payment_receipts`, `skyline_student_payment_allocations` | RLS enabled on the `ax_*` and payment tx/receipt/allocation tables | `M:20260604120000` … `M:20260729035851` |
| `backup.*` | ad-hoc snapshot tables created by DRAFT migrations (`dupstep_*_20261104`, `instance_end_dates_before_extension_20261105`) | | `M:20261104000001:19-36`; `M:20261105000001:19-21` |

Frontend type mirror: `src/types/database.ts:6-215` only declares `forms`, `form_steps`, `form_sections`, `form_questions`, `form_question_options`, `form_question_rows`, `form_instances` (no workflow/date/rollover columns), `form_answers`, `form_assets`; every other table is accessed untyped through `src/lib/formEngine.ts` (7,825 lines).

#### 1.2 Triggers

| Trigger | Table / event | Function | Effect | Where |
|---|---|---|---|---|
| `skyline_*_updated_at` (12 tables) | BEFORE UPDATE on forms, steps, sections, questions, options, rows, instances, answers, students, batches, users, courses | `skyline_set_updated_at()` | sets `updated_at = now()` | `M:20260314000001_audit_columns_created_updated.sql:5-11,18-98` |
| `skyline_auto_assign_trainer_on_student_submit` | BEFORE UPDATE on `skyline_form_instances` | `skyline_auto_assign_trainer_on_student_submit()` SECURITY DEFINER | when `status` draft→submitted and `role_context` student and the student's batch has a trainer: sets `role_context='trainer'` | `M:20260421000004:5-38` |
| `skyline_students_batch_course_check` | BEFORE INSERT OR UPDATE OF `batch_id` on `skyline_students` | `skyline_enforce_student_batch_course()` | raises unless student has an active `skyline_student_courses` row for the batch's course | `M:20260615210000:2-43` |
| `trg_skyline_validate_student_course_row` | BEFORE INSERT/UPDATE on `skyline_student_courses` | `skyline_validate_student_course_row()` | date order, one in-progress, no overlapping non-cancelled ranges, stamps status change | `M:20260713140000:153-232` |
| `skyline_enqueue_pdf_on_instance_complete` | AFTER INSERT OR UPDATE OF `status, workflow_status` on instances | `skyline_enqueue_pdf_on_instance_complete()` SECURITY DEFINER | when row becomes `locked`+`completed`: inserts pending `skyline_generated_pdfs (role='office')` and pg_net-posts to Edge `trigger-pdf-worker` | `M:20260706140000:13-158` |
| `skyline_form_instances_extension_mirror` | BEFORE UPDATE OF `end_date` on instances | `skyline_form_instances_sync_extension_date()` | if extension equalled old end, follow new end; if extension < new end, raise it | `M:20261105000001:46-70` (DRAFT, "run by hand") |
| `skyline_generated_pdfs_updated_at`, `skyline_inductions_updated_at`, `skyline_student_courses_updated_at` | updated_at | | | `M:20260703180000:56-59`; `M:20260330000001:20-22`; `M:20260409000003:21-24` |
| `skyline_batches_guard_login_flag`, `skyline_users_revoke_sessions` | batches / users | guard `allow_trainer_student_login`; revoke staff sessions on user change | | `M:20261110000001:466-506` |
| pg_cron `skyline-assessment-no-attempt-rollover` | every 15 min | `skyline_run_scheduled_no_attempt_rollover()` | server-side rollover (see §3.4) | `M:20260917123000:523-541` |

#### 1.3 RPC inventory (functions), grouped

SD = `SECURITY DEFINER`. Latest definition cited; earlier overloads/versions in the same-named files.

| Purpose | Function (signature) | SD | Grants | Where |
|---|---|---|---|---|
| Student final submit | `skyline_submit_instance_to_trainer(p_instance_id bigint, p_request_id text DEFAULT NULL) RETURNS jsonb` — row lock, idempotent per request_id, writes `skyline_submission_events` | yes | anon, authenticated, service_role | `M:20260917123000:98-248` (replaces 1-arg `M:20260513140000:4-66`, dropped at `:96`) |
| Missed-window rollover | `skyline_sync_no_attempt_rollover(p_instance_ids bigint[]) RETURNS TABLE(...)` | yes | **revoked from anon/authenticated**; service_role, postgres | `M:20261105000002_extension_deadline_functions.sql:21-247` (history: `M:20260424000001:10`, `M:20260507000000:4`, `M:20260507100000:7`, `M:20260520140100:3`, `M:20260529130000:55`, `M:20260917123000:250-485`) |
| Scheduled rollover | `skyline_run_scheduled_no_attempt_rollover() RETURNS integer` | yes | service_role, postgres | `M:20261105000002:250-279` |
| Batch eligibility | `skyline_batch_assessment_eligibility(p_batch_id, p_course_id, p_from_date, p_to_date) RETURNS TABLE(student_id, form_id, form_name)` | no (sql STABLE) | default | `M:20260415000006:4-40` |
| Batch unit-date options | `skyline_batch_assessment_options(p_batch_id, p_course_id, p_from_date, p_to_date, p_start_only_null_end bool, p_open_null_end_exact bool, p_page int, p_page_size int, p_form_id bigint) RETURNS jsonb` | no (sql STABLE) | default | `M:20260418000009:4-119` |
| Course "active on" | `skyline_form_ids_for_course_active_on(p_course_id, p_on date) RETURNS bigint[]` | no | default | `M:20261105000002:959-978` |
| Assessment directory | `skyline_list_submitted_instances_paged(...)` 12-arg and 15-arg overloads (`p_batch_id`, `p_search_student_ext_id`, `p_search_unit_code`, `p_end_date_to`) RETURNS TABLE(id, form_id, form_name, form_version, student_id, student_name, student_email, status, role_context, created_at, submitted_at, submission_count, start_date, end_date, total_count) | no (plpgsql STABLE, dynamic SQL) | default | `M:20261105000002:282-428, 430-673`; search parser `M:20260723120000:12` |
| Admin dashboard | `skyline_admin_dashboard_stats_v2(p_from_date, p_to_date, p_status[, p_batch_id]) RETURNS jsonb` (2 overloads); `skyline_admin_dashboard_instances_paged(...)` (2 overloads); legacy `skyline_admin_dashboard_stats` | stats yes; paged no | default | `M:20261105000002:676-956`; `M:20260330160001:4`; `M:20260405000001:76` |
| Batch membership | `skyline_update_batch_student_assignments(p_batch_id, p_student_ids bigint[]) RETURNS jsonb` | yes | authenticated | `M:20260615200000:37-98` |
| Enrolment lifecycle | `skyline_upsert_student_course_enrollment(p_student_id, p_course_id, p_start_date, p_end_date, p_enrollment_status, p_intake_label, p_link_status, p_completed_at, p_actor_user_id, p_allow_create, p_clear_dates) RETURNS jsonb`; `skyline_import_student_course_timetable(...)`; `skyline_course_ranges_overlap(...)` | yes / yes / no | | `M:20260713140000:237-252`; `M:20260720044631:5`; `M:20260713140000:37-52` |
| Deletion | `skyline_admin_delete_student_if_no_assessments(bigint)`, `skyline_admin_delete_batch_if_all_students_inactive(bigint)`, `skyline_superadmin_delete_student(bigint)` (deletes all instances), `skyline_superadmin_delete_batch(bigint, bigint[])` | yes | **anon, authenticated** (no caller check) | `M:20260418000011:5-84`; `M:20260421000003:4`; `M:20260421000002:3-83` |
| PDF queue | `skyline_instance_pdf_complete(row)` (sql immutable); `skyline_enqueue_instance_pdf(bigint, text)`; `skyline_invoke_pdf_worker_async()` (pg_net + Vault secrets `project_url`, `service_role_key`, `pdf_worker_cron_secret`); `skyline_enqueue_pdf_on_instance_complete()` trigger; `skyline_seed_completed_instance_pdfs(text, int)` | yes (except first) | postgres, service_role | `M:20260706140000:13-216` |
| Form repair | `skyline_diagnose_shared_content_block_grids(bigint)`, `skyline_repair_shared_content_block_grids(bigint)` | yes | | `M:20260724035221:5,76` |
| Staff auth | `skyline_login(text, text)` (SD; later revoked from clients), `skyline_request_otp`, `skyline_verify_otp_login(text,text)` (SD, returns session token), `skyline_logout(p_token)`, `skyline_issue_staff_session`, `skyline_staff_from_token`, `skyline_change_password`, `skyline_create_user` (SD, anon — revoke pending), `skyline_admin_set_password`, `skyline_admin_create_user(p_token,…)`, `skyline_admin_update_user(p_token,…)` | mostly yes | see `docs/security-followups.md:23-49` | `M:20260302000003:26-57`; `M:20260313000001:22-101`; `M:20261110000001:69-291`; `M:20261110000003:17,100`; pending `supabase/pending/20261110000006_revoke_client_writes_on_users.sql` |
| Student auth | `skyline_request_student_otp(text)`, `skyline_verify_student_otp(text,text)`, `skyline_student_set_password(bigint,text)` (SD, anon), `skyline_student_authenticate(text,text)` (SD, anon) | yes | anon, authenticated | `M:20260313000003:5,48`; `M:20260306000001:9-59` |
| Trainer scope / impersonation | `skyline_staff_trains_batch(user,batch)` (sql SD, internal), `skyline_trainer_list_my_students(p_token, p_search, p_limit, p_offset)`, `skyline_trainer_get_student(p_token, p_student_id)`, `skyline_trainer_list_my_batches(p_token,…)`, `skyline_staff_may_login_as_student`, `skyline_can_login_as_student(p_token, p_student_id)`, `skyline_login_as_student(p_token, p_student_id)`, `skyline_set_batch_trainer_student_login`, `skyline_list_impersonation_logs(p_token, p_limit, p_offset)`, `skyline_staff_acting_as` | yes | token-checked | `M:20261110000004:9-60`; `M:20261110000007:14,52`; `M:20261110000001:119-403`; `M:20261110000005:22-275` |
| Induction | `skyline_induction_unlock`, `skyline_induction_submission_state`, `skyline_induction_submit`, `skyline_induction_save_draft`, `skyline_request_induction_otp`, `skyline_verify_induction_otp`, `skyline_admin_{count,list}_induction_submissions`, `skyline_admin_patch_induction_submission_{office,payload}`, `skyline_admin_patch_induction_end_at` | yes | anon | `M:20260330*`, `M:20260402000001`, `M:20260418000010`, `M:20260428000001`, `M:20260522100000` |
| Enrolment applications | `skyline_student_enrolment_{create_draft,save_draft,get_draft,submit,list,find_draft_by_email}`, `skyline_enrolment_next_application_no`, `skyline_enrolment_touch_updated_at`, `skyline_enrolment_has_meaningful_contact` | yes | anon | `M:20260514120000:33-180`; `M:20260514130000`; `M:20260514140000`; `M:20260521*` |
| Finance (names only) | `skyline_assign_payment_plan_student[_with_installments]`, `skyline_confirm_payment_plan`, `skyline_copy_payment_plan_installments_to_student`, `skyline_generate_payment_plan_installments`, `skyline_unassign_payment_plan_student`, `skyline_record_student_plan_payment`, `skyline_correct_student_plan_payment`, `skyline_update_student_installment_payment`, `skyline_reorder_pending_student_installments`, `skyline_preview_fifo_payment_allocation`, `skyline_recalculate_installment_from_allocations`, `skyline_replace_payment_receipt_metadata`, `skyline_assert_payment_staff_role`, `skyline_validate_installment_payment_state`, `skyline_add_payment_period`, `invoke_axcelerate_finance_sync_cron` | | | `M:20260610120000` … `M:20260729035851`, `M:20260605100000` |

RPCs actually called from `src/` (grep `.rpc(`): the submit, options, list/dashboard, delete, user/enrolment/induction/payment and impersonation RPCs above. `skyline_sync_no_attempt_rollover` is **not** called from the client any more (`src/lib/assessmentWorkflowMigration.test.ts:52` asserts that); `skyline_batch_assessment_eligibility` has no client caller (only `_options`).

#### 1.4 RLS policies and tables without RLS

| Table | RLS | Policies |
|---|---|---|
| `storage.objects` (bucket `student-enrolment-documents`) | n/a | `student_enrolment_docs_insert` FOR INSERT TO anon, authenticated WITH CHECK bucket; `student_enrolment_docs_select` FOR SELECT TO anon, authenticated — `M:20260514120000:197-205` |
| `storage.objects` (bucket `photomedia`) | n/a | not in migrations; `scripts/fix-storage-policies.sql:7-22` creates `photomedia_allow_insert/update/select` for **all roles, whole bucket, no path restriction** |
| `skyline_submission_events` | enabled | none; `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT SELECT, INSERT TO service_role` — `M:20260917123000:91-94` |
| `skyline_staff_sessions`, `impersonation_logs` | enabled | none; all client grants revoked — `M:20261110000001:34-35,61-62` |
| `skyline_induction_sessions`, `skyline_induction_submissions` | enabled | none (RPC only) — `M:20260330000002:30-31` |
| `student_enrolment_applications` | enabled | none (RPC only) — `M:20260514120000:29-31` |
| `ax_invoices`, `ax_invoice_payments`, `ax_invoice_payment_allocations`, `ax_student_ledger_entries` | enabled | (finance, out of scope) |
| `skyline_student_payment_transactions`, `skyline_payment_receipts`, `skyline_student_payment_allocations` | enabled | SELECT policies `skyline_payment_tx_select`, `skyline_payment_receipts_select`, `skyline_payment_alloc_select` — `M:20260727150000:457-468`; `M:20260729035851:70-73` |
| **No RLS at all** | `skyline_forms`, `skyline_form_steps`, `skyline_form_sections`, `skyline_form_questions`, `skyline_form_question_options`, `skyline_form_question_rows`, `skyline_form_assets`, `skyline_form_instances`, `skyline_form_answers`, `skyline_form_trainer_assessments`, `skyline_form_trainer_row_assessments`, `skyline_form_results_data`, `skyline_form_results_office`, `skyline_form_assessment_summary_data`, `skyline_instance_access_tokens`, `skyline_assessment_acknowledgments` (explicit GRANT ALL to anon `M:20260613120000:17`), `skyline_generated_pdfs`, `skyline_students`, `skyline_users` (column-level SELECT on `password_hash` revoked per `docs/security-followups.md:47-48`), `skyline_batches`, `skyline_batch_trainers`, `skyline_courses`, `skyline_course_forms`, `skyline_student_courses`, `skyline_course_link_exports`, `skyline_learning_doc_activity`, `skyline_notifications`, `skyline_push_tokens`, `skyline_otps`, `skyline_inductions`, payment-plan tables | Every assessment table is readable and writable with the public anon key (`docs/security-followups.md:12-21`). Access tokens, OTPs and role checks are UX gates, not authorization. |

Other security-relevant facts in source: default staff passwords and a master-admin bypass account are inserted by migrations (`M:20260302000003:15-23`, `M:20260313000001:16-19`; values not reproduced here); the student dashboard trusts `sessionStorage` (`docs/security-followups.md:14-16`).

---

### 2. Assessment creation, publication and assignment

#### 2.1 How a form becomes an assessment

| Aspect | Implementation | Where |
|---|---|---|
| Create | `createForm` inserts `skyline_forms` with `status='published'` always, `version` default `'1.0.0'`, `start/end_date` defaulting to the current month, then `createCompulsoryFormStructure` builds the "Introductory Details" step and task steps | `src/lib/formEngine.ts:6023-6067`, `:5689-5714` (role constants `READ_ONLY_EDIT`, `TRAINER_ONLY_EDIT`, `TRAINER_OFFICE_EDIT`, `ALL_CAN_EDIT`) |
| Default content | 15 instruction steps + Reasonable Adjustment + Student declaration | `src/lib/defaultFormSteps.ts:34-328` |
| Publication | There is no publish step. `forms.status` CHECK allows draft/published/archived but the app only writes `published`. Visibility is `forms.active` (toggle in `src/pages/AdminFormsListPage.tsx:181-186`); `fetchForm` filters `active=true` unless `allowInactiveForAdmin` | `M:20260321000001:2-3`; `src/lib/formEngine.ts:86-100` |
| Qualification / unit | `forms.qualification_code`, `qualification_name`, `unit_code`, `unit_name` (free text; no units table). `listActiveFormsByQualificationCode` filters active forms by code | `M:20250213000003`; `src/lib/formEngine.ts:6364-6374`; display repair `src/utils/formUnitDisplay.ts` |
| Course link | many-to-many `skyline_course_forms` (`setFormCourses`, `setCourseForms`) | `src/lib/formEngine.ts:6457-6489` |
| `forms.start_date/end_date` | legacy TEXT; explicitly **not** used for link expiry ("Default expiry now comes from instance-level policy, not skyline_forms.start_date/end_date") | `src/lib/formEngine.ts:1677` |
| `active_on` filter | Assessment directory "active on" = instances whose `[start_date, COALESCE(extension_date,end_date)]` contains the date; `skyline_form_ids_for_course_active_on` lists forms with such instances | `M:20261105000002:346-353, 959-978`; `src/lib/formEngine.ts:3865` |
| Task structure | Each assessment task = a row of the `grid_table` question in the `assessment_tasks` section; `ensureTaskSectionsForForm` creates one step per task row with sections `task_instructions`, `task_questions`, `task_written_evidence_checklist`, `task_marking_checklist` (sort 3), `task_results` (sort 4), linked by `sections.assessment_task_row_id`. **This runs on every template fetch** (`fetchTemplateForForm` unless `skipEnsureTaskSections`), so reading a form can insert steps/sections/questions | `src/lib/formEngine.ts:240-351, 674-683, 412` |
| Duplicate-step incident | DRAFT cleanup migration + planned unique `(form_id, title)` because concurrent "ensure" calls inserted duplicate task steps | `M:20261104000001:1-16`; `M:20261104000002:1-13`; `scripts/db-cleanup/*` |

#### 2.2 Versioning — none

- `forms.version` is a free-text label edited in the builder (`src/pages/AdminFormBuilderPage.tsx:1835-1843`). No `form_versions` table, no snapshot of steps/questions.
- `duplicateForm` copies a form to `"<name> (Copy)"` with `nextVersion()` and remaps content-block question ids, but the copy has no link to the original (`src/lib/formEngine.ts:6565-6600`; `src/lib/contentBlockClone.ts`).
- Instances reference `form_id` only; answers reference `question_id` with `ON DELETE CASCADE` (`M:20250211000000:105-106`). **Editing a question changes every existing instance in place; deleting a question deletes its answers in every submitted/locked instance.** Migrations that mutate templates after the fact (e.g. `M:20260607120000_cpccco2013_q4_tools_grid_rows.sql:4-8`, `M:20260724035221`) exist precisely because of this.
- Step/section/question `updated_by` exists (`M:20260314000001`) but nothing stores previous values.

#### 2.3 Assignment to students / batches

| Path | What it does | Where |
|---|---|---|
| `createFormInstance(formId, roleContext, studentId?, {start_date,end_date})` | inserts `skyline_form_instances`; if opts omitted, defaults start=today (Melbourne) and end=+30 days | `src/lib/formEngine.ts:1295-1334` |
| Course → student ("Assign course" in student detail) | `updateStudentCourseEnrollment` then `upsertStudentAssessmentsForCourse`: for every form in `skyline_course_forms`, create or re-date one instance per (student, form); student link expiry set to end | `src/components/students/StudentQualificationsPanel.tsx:172-189`; `src/lib/formEngine.ts:6331-6362` |
| Single form → student | `upsertStudentAssessmentsForForms(sid,[fid],{dates})` | `src/pages/AdminStudentDetailsPage.tsx:1729-1732`; `src/lib/formEngine.ts:6376-6404` |
| Course page "send forms" | for each selected student×form without an instance, `createFormInstance` with per-pair dates, then export a "generic links" PDF stored in `skyline_course_link_exports.payload_json` | `src/pages/AdminCoursesPage.tsx:233-253, 256-274`; `src/lib/formEngine.ts:6490-6550` |
| Batch unit dates (`AdminBatchUnitDatesPage`) | calls `skyline_batch_assessment_options` to list **existing** instances for students in the batch × forms in the batch's course, then mass-updates dates or creates missing instances | `src/pages/AdminBatchUnitDatesPage.tsx:325-367`; `src/lib/formEngine.ts:4694`; RPC `M:20260418000009:19-57` |
| Anonymous instance | `FormStartPage` creates an instance with no student (`createFormInstance(formId, role)`) | `src/pages/FormStartPage.tsx:30` |
| Uniqueness | `getInstanceForStudentAndForm` (`limit(1)`) is the only guard; no DB unique index | `src/lib/formEngine.ts:1253-1266` |
| Batch membership validation | `skyline_update_batch_student_assignments` + trigger reject students not actively enrolled in the batch course; client mirror `partitionStudentsByBatchCourse` | `M:20260615200000:37-98`; `M:20260615210000`; `src/lib/studentBatchValidation.ts:17-39` |
| Trainer scope | trainer sees instances of students whose `batch_id` is in `fetchBatchIdsForTrainer` (primary `skyline_batches.trainer_id` ∪ `skyline_batch_trainers.user_id`) | `src/lib/formEngine.ts:3123-3149, 4049-4059, 4343-4354` |

Dates and extension on an instance (`src/utils/assessmentDeadline.ts:13-55`; `src/lib/formEngine.ts:1389-1484`):

| Change | Effect |
|---|---|
| `end_date` changed (any role incl. trainer, `TrainerUnitSubmissionsPage.tsx:126-162`) | `did_not_attempt=false`, `no_attempt_rollovers=0`, status/role/workflow back to `draft`/student (`formEngine.ts:1446-1451`) and student token expiry moved to the effective deadline (`extendInstanceAccessTokensToDate` `:2025-2043`, which **also rewrites `end_date`**) |
| `end_date` changed on a terminal did-not-attempt row, or admin confirms "Reset assessment attempts?" | full reset: `submission_count=0`, `submitted_at=null`, nyc dates null, then `clearAssessmentAttemptHistory` wipes summary results/signatures, results_data attempts, trainer marks, office checks — **answers are kept** (`formEngine.ts:1424-1445, 1337-1387`; prompt rules `src/utils/assessmentDateChange.ts:14-52`, `src/utils/assessmentRowUi.ts:930-979`) |
| `start_date` changed when a rollover had happened | same reset-to-draft as end change (`:1452-1457`) |
| `extension_date` set | never resets attempts; effective deadline = `COALESCE(extension_date, end_date)`; DB CHECK ext ≥ end; mirror trigger when end moves; UI validation `validateExtensionDate` | `M:20261105000001`; `M:20261105000002`; `src/utils/assessmentDeadline.ts:30-55` |
| "Extend link 30 days" (`AdminAssessmentsPage.tsx:382`) | `extendInstanceAccessTokens` writes `extension_date` and re-enables tokens | `src/lib/formEngine.ts:1995-2022` |

Access links: `issueInstanceAccessLink` issues a 48-hex token per role; student tokens expire at the effective deadline (Melbourne 23:59), trainer/office at +90 days; student issuance is refused outside the window or when the course lifecycle blocks (`src/lib/formEngine.ts:1628-1694`). `validateInstanceAccessToken` re-checks revoked/consumed/expired, inactive student, `did_not_attempt`, window and course lifecycle (`:1831-1947`). Student tokens are revoked on submit (`src/pages/InstanceFillPage.tsx:2532`) and re-enabled by rollover/NYC/date changes.

---

### 3. Submissions and drafts

#### 3.1 Lifecycle fields

An instance carries three overlapping state fields: legacy `status` (draft / submitted / locked / incomplete), `role_context` (student / trainer / office = whose queue it is in) and `workflow_status` (draft / waiting_trainer / waiting_office / completed / failed / awaiting_submission). The client always writes all three (`src/lib/formEngine.ts:7327-7384`) and normalises any combination on read (`src/utils/instanceWorkflow.ts:13-63`, duplicated in `InstanceFillPage.tsx:760-794`).

| workflow_status | status | role_context | Meaning | Entered by |
|---|---|---|---|---|
| `draft` | draft | student | with student (initial, or reopened after NYC / date change / rollover) | create; `updateInstanceWorkflowStatus('draft')`; rollover; date change |
| `awaiting_submission` | incomplete | student | deadline passed twice-extended with saved answers but no final submit ("Not submitted by due date") | rollover only (`M:20261105000002:158-175`) |
| `waiting_trainer` | submitted | trainer | student submitted | RPC `skyline_submit_instance_to_trainer`; repair handoff `formEngine.ts:7287-7325` |
| `waiting_office` | submitted | office | trainer recorded Competent | `InstanceFillPage.tsx:2646-2649` |
| `completed` | locked | office | office finalised | `:2667-2669`, auto `:1584-1609`, Quick Edit `src/lib/assessmentCompletionStatus.ts:110-188` |
| `failed` | locked | office | 3rd NYC, or terminal did-not-attempt | `:2624-2627`; rollover `M:20261105000002:178-234` |

Transitions:

| From | Trigger | To | Code |
|---|---|---|---|
| draft / awaiting_submission (student) | Final Submit (all visible required questions valid) | waiting_trainer; `submission_count = min(count+1,3)`; `submitted_at` kept from first submit; `did_not_attempt=false`; event `final_submit` | `src/pages/InstanceFillPage.tsx:2493-2552`; `M:20260917123000:197-239` |
| any terminal (`did_not_attempt`, locked, failed, completed) | Final Submit | rejected `instance_terminal` (event logged) | `M:20260917123000:180-195` |
| waiting_trainer | trainer submit, derived outcome Competent | waiting_office + notification `workflow_to_office` | `InstanceFillPage.tsx:2646-2662` |
| waiting_trainer | trainer submit, NYC, attempt 1 or 2 | draft/student, `end_date = NYC date + 5`, tokens reopened, notification `workflow_resubmit` | `:2594-2622` |
| waiting_trainer | trainer submit, NYC, attempt 3 | failed/locked/office, notification `workflow_failed` | `:2624-2643` |
| waiting_office | office "Finalize" (no check required) or all Initial/Updated boxes ticked | completed/locked → PDF queued | `:2667-2682`, `:1584-1609`; trigger `M:20260706140000:119-158` |
| draft (status draft→submitted by any direct write) | DB trigger | role_context=trainer if batch has trainer | `M:20260421000004:5-38` |

#### 3.2 Draft saving

- No draft table: a draft is `status='draft'` plus rows in `skyline_form_answers`. Answers upsert per `(instance, question, row)`; `saveAnswer` reads the existing row and merges so an empty incoming value never wipes a non-empty stored one unless `allowClear` (`src/lib/formEngine.ts:1186-1250`; `src/utils/formAnswerMerge.ts:69-101`). Saves are debounced and flushed before submit (`InstanceFillPage.tsx:2485-2492`).
- Per-step save targets are built by `collectStepAnswerSaveTargets` (grid rows per `row_id`, likert per row, single_choice per row, otherwise question-level) (`src/utils/stepAnswerSave.ts:60-148`).
- Every student-side write (answers, results, summary, submit) passes `assertStudentInstanceMutationAllowed`: refuses when locked/failed/did_not_attempt, and for a student-owned draft enforces the course lifecycle gate (active enrolment, `enrollment_status='in_progress'`, inclusive Melbourne date window, exactly one in-progress enrolment) (`src/lib/studentAssessmentAccess.ts:175-241, 433-500`). Non-student roles and `source='adminQuickEdit'` bypass it.
- Answer value shapes: `value_text` / `value_number` / `value_json`; attachments add `value_json.answerImageUrl` (see §4).

#### 3.3 Who may edit which question, when

| Rule | Where |
|---|---|
| Template per-question `role_editability {student,trainer,office}` and `role_visibility`; trainer may edit anything student- or trainer-editable; office anything; "admin edit mode" (office role flag) unlocks all | `src/pages/InstanceFillPage.tsx:548-585` |
| Workflow gate `canRoleEditCurrentWorkflow`: student only in `draft` and only when lifecycle allows; trainer unless completed/failed or handed to office; office only in `waiting_office` (or admin edit mode) | `:1798-1811` |
| On resubmission, questions the trainer marked satisfactory `yes` are read-only for the student (`isResubmissionAfterTrainer`) | `:1976-1988` |
| Student declaration signature editable on first cycle only; staff may correct later | `:1813-1829` |
| Attempt columns: staff may edit attempt ≤ active attempt; validation requires the active attempt column | `:318-326`; `src/utils/assessmentResultValidation.ts:18-31` |
| Data migrations toggling editability: submission method student+trainer (`M:20250220000001`), trainer full name trainer/office (`M:20250225000001`), Appendix A trainer/office only + Learner Evaluation all (`M:20260312000001`), checklists trainer/office (`M:20260322000003`) | |

#### 3.4 "Did not attempt", rollover and repairs

Rollover is server-side only (pg_cron every 15 min, `M:20260917123000:523-541`), operating on instances past `COALESCE(extension_date,end_date)` in Melbourne date (`M:20261105000002:250-279`). Rules in order:

1. Never submitted, student/draft, `no_attempt_rollovers < 2`: `end_date += 5`, `extension_date += 5`, rollovers+1, student tokens re-enabled (`:31-43, 143-154`).
2. NYC on attempt 1 with no attempt-2 result, and either student/draft with count 1–2 or trainer/submitted with count 1, rollovers < 2: +5 days, rollovers+1, back to student/draft, **and auto-writes `final_attempt_2_result='not_yet_competent'` and every task `second_attempt_satisfactory='ns'` dated `trainer_nyc_assessed_on_1` or deadline−5** (`:47-116`).
3. NYC on 1 and 2 with no attempt-3 result, student/draft count 2–3, rollovers < 2: +5 days, rollovers+1, student/draft (`:118-141`). (No auto-NS for attempt 3.)
4. Never submitted, rollovers ≥ 2, has any answer row → `status='incomplete'`, `workflow_status='awaiting_submission'` (`:158-175`).
5. Never submitted, rollovers ≥ 2, no answers → `did_not_attempt=true`, locked/failed/office (`:178-196`).
6. NYC path overdue with rollovers ≥ 2 → `did_not_attempt=true`, locked/failed/office (`:201-234`).

Repairs: `M:20260513120000` (submitted but role stuck student → trainer), `M:20260513141000` (submitted_at set but status draft → submitted/trainer, excluding NYC resubmission windows), `M:20260529130000:44-52` (did_not_attempt rows forced to locked/failed), `M:20260529140000` (draft rows with stale failed/completed → draft), `M:20260917123000:35-69` (did_not_attempt rows with a competent result → waiting_office/completed; with answers → incomplete). Client repair "Send to trainer": `repairInstanceTrainerHandoff` (`src/lib/formEngine.ts:7287-7325`). DRAFT SQL: `scripts/db-cleanup/repair_stuck_submissions.sql`, read-only `stuck_submitted_not_sent.sql`.

---

### 4. Storage and evidence

| Item | Detail | Where |
|---|---|---|
| Bucket `photomedia` (public) | single bucket for everything below; public URLs via `getPublicUrl`; no `createSignedUrl` usage anywhere in `src/`; policies (from script, not migration) allow anon INSERT/UPDATE/SELECT on the whole bucket | `src/lib/storage.ts:3-4`; `scripts/fix-storage-policies.sql:7-22` |
| Form cover image | `skyline/{formId}_{name}_{ts}.{ext}` | `src/lib/storage.ts:36-61` |
| Row image (task grid rows) | `skyline/{formId}/questions/{questionId}/rows/{rowId}_{ts}.{ext}` | `:68-90` |
| Question image | `skyline/{questionId}/{name}_{ts}.{ext}` | `:97-121` |
| Instruction image | `skyline/instructions/{task_row|section}/{id}/{name}_{ts}.{ext}` | `:127-154` |
| **Answer attachment / image answer** | `skyline/answers/{instanceId}/{questionId}/{name}_{ts}.{ext}`; HEIC converted to JPEG client-side; delete by public URL best-effort | `:214-280` |
| Attachment envelope in DB | enabled only by `pdf_meta.allowAnswerImage`; string answers → `value_text` + `value_json={answerImageUrl}`; number → `value_number` + json; array/object → `value_json={value, answerImageUrl}`; per-row questions keep the attachment on the `row_id NULL` row; `{}` means "attachment removed" | `src/lib/answerAttachment.ts:1-25, 104-152`; parity copy `pdf-server/answerAttachment.ts` |
| Induction documents | `skyline/induction/{submissionId|sessionToken}/{docKey}[_{slot}]` (upsert on duplicate) | `src/lib/storage.ts:161-208` |
| Learning documents | `Learning/<slug(formName)>-<formId>/<file>` (student) and `.../trainer/<file>` (trainer-only, excluded from student listing); upload upserts; student uploads also appended to `forms.learning_material_urls`; every action logged to `skyline_learning_doc_activity`; zip download via authenticated download | `src/lib/formDocuments.ts:5-30, 55-131, 160-193, 195-240`; `M:20260427000001` (comment only, no policies); `M:20260525100000` |
| Enrolment documents | bucket `student-enrolment-documents` (public, 15 MB, jpeg/png/gif/pdf) with fallback to `photomedia/admissions` | `M:20260514120000:183-205`; `src/lib/enrolmentStorage.ts:5-6, 75-82` |
| Generated assessment PDFs | **not in Supabase Storage**: queue row in `skyline_generated_pdfs` → Edge `trigger-pdf-worker` (`PDF_WORKER_URL`, `PDF_WORKER_SECRET`, optional `PDF_WORKER_CRON_SECRET`) → Render/Express `pdf-server` `POST /jobs/process-pdfs` (header `x-worker-secret`) → Puppeteer render → Microsoft Graph upload to SharePoint library (`SHAREPOINT_LIBRARY_NAME`, `SHAREPOINT_FOLDER_PATH`, per-unit folder) → stores `sharepoint_web_url`, `sharepoint_public_url`, `storage_path`. Frontend opens the SharePoint URL or falls back to live `GET {VITE_PDF_API_URL}/pdf/{instanceId}?role=office` | `supabase/functions/trigger-pdf-worker/index.ts:35-69`; `pdf-server/index.ts:86-88, 2438`; `pdf-server/pdfWorker.ts:66-166`; `pdf-server/sharepointUpload.ts:106-204`; `pdf-server/pdfFileNaming.ts:41-69`; `src/lib/generatedPdfs.ts:28-129` |
| Signatures | stored as TEXT (data URL or typed text) in `results_data.trainer_signature/student_signature`, summary `trainer_sig_N/student_sig_N`, and the `student.declarationSignature` answer | `InstanceFillPage.tsx:913-921, 599-610` |

---

### 5. Marking, feedback, outcomes, reassessment

#### 5.1 Data captured by the trainer

| Table / field | Granularity | Written by |
|---|---|---|
| `skyline_form_trainer_assessments.satisfactory` yes/no | per question (task_questions) | `saveTrainerAssessment` `src/lib/formEngine.ts:1144-1154` |
| `skyline_form_trainer_row_assessments.satisfactory` | per grid row | `:1173-1184` |
| Written-evidence / marking checklist answers (`single_choice` rows yes/no) | per checklist row, stored as ordinary answers | `src/lib/writtenEvidenceChecklist.ts`; `src/utils/taskResultsOutcome.ts:348-361` |
| `skyline_form_results_data` per `task_results` section | attempt 1/2/3 S/NS + date + feedback; trainer name/signature/date; student name/signature | `saveResultsData` `:958-978`; `InstanceFillPage.tsx:923-` |
| `skyline_form_assessment_summary_data` (one per instance) | overall attempt 1/2/3 Competent/NYC, trainer sig/date ×3, student sig/date ×3, overall feedback, admin initials/checks | `saveAssessmentSummaryData` `:1108-1126`; `InstanceFillPage.tsx:1644-` |
| `skyline_form_results_office` | per task section: `entered_date/by`, Initial/Updated checks | `:1008-1023`; `InstanceFillPage.tsx:1611-1642` |
| `skyline_form_instances.trainer_nyc_assessed_on_N` | Melbourne date of NYC decision | `recordTrainerNycAssessedOn` `:1523-1539` |

#### 5.2 Derivation rules (task → unit outcome)

- Task results sections are matched to assessment-task rows via `assessment_task_row_id`; duplicates for the same row are collapsed to the section with the most data and merged (`src/utils/taskResultsOutcome.ts:181-308`).
- Effective task attempt result: stored S/NS wins; for attempt 1 only, if unset, derived from marks: any `no` → NS; all marked `yes` → S; any unmarked → null (`:320-390`).
- Unit outcome for an attempt: any task NS → `not_yet_competent`; every task S → `competent`; otherwise null (`:453-458`). The trainer cannot select "Competent" on the summary while any task is NS/unmarked (`InstanceFillPage.tsx:1662-1679`, message `formatCompetentBlockerMessage`). NYC can be ticked freely.
- Active attempt = `getSubmissionWave(submission_count)` = clamp(count,1,3) (`src/utils/assessmentResultValidation.ts:18-24`; `InstanceFillPage.tsx:311-316`); the student preps attempt N+1 fields after an NYC (`:898-910`).
- Before the trainer can submit: every task sheet and the summary need ≥1 attempt with outcome **and** date (`validateAssessmentBeforeProgress` `src/utils/assessmentResultValidation.ts:53-116`); all template steps must validate (`InstanceFillPage.tsx:2445-2479`); date chains S1 ≤ T1 ≤ S2 ≤ T2 ≤ S3 ≤ T3 and attempt dates ≥ student declaration date (`src/utils/assessmentAttemptDates.ts:92-242`), bypassable by staff in admin edit mode (`canStaffBypassDateOrderConstraints`).
- Summary `final_attempt_N_result` is what the trainer ticks; `getTrainerAttemptOutcome(latestAttempt)` (derived from task checks) is what decides the workflow branch on submit (`:2560-2561`) — the two can disagree if the trainer ticks NYC on the summary while all tasks are S (workflow follows the derived value).

#### 5.3 Exact reassessment / attempt rules as implemented

1. Three attempts maximum: `submission_count` is clamped to 3 by the submit RPC (`M:20260917123000:214`).
2. Trainer NYC on attempt 1 or 2 (`InstanceFillPage.tsx:2594-2622`): `trainer_nyc_assessed_on_N = today (Melbourne)`; new deadline = that date + **5 days** (`STUDENT_RESUBMISSION_DAYS_AFTER_NYC`, `formEngine.ts:1541-1546`); `end_date` is **overwritten** with the new deadline and student tokens re-enabled to Melbourne 23:59 of it (`extendInstanceAccessTokensToDate` `:2025-2043`); instance → draft/student; in-app + push notification `workflow_resubmit`. Trainer marks are retained: questions marked `yes` lock for the student (`:1985-1988`); everything else stays editable; prior attempt columns stay visible.
3. Trainer NYC on attempt 3 → `failed`/locked/office; notification `workflow_failed` (`:2624-2643`). Only an admin end-date change with "reset attempts" reopens it (`src/utils/assessmentDateChange.ts:14-17, 98-111`).
4. Student resubmits through the same Final Submit; `submitted_at` is never overwritten, count increments (`M:20260917123000:213-225`).
5. Missed resubmission windows are handled by the cron rollover (§3.4): two +5-day extensions; on the first missed attempt-2 window the system itself records attempt 2 as NYC/NS; after the second extension the instance becomes `failed` with `did_not_attempt=true`.
6. Reset: changing `end_date` on an exhausted/terminal row or confirming the reset dialog clears all attempt data except answers (`formEngine.ts:1337-1387`).
7. `extension_date` extends the deadline without touching attempts (`:1412-1413`).

#### 5.4 Feedback, sign-off, acknowledgment

- Feedback fields: per task per attempt `first/second/third_attempt_feedback`; `student_overall_feedback` on the summary. No separate feedback table or threaded comments.
- Sign-off: trainer/student signature + date on each results sheet and three trainer/student signature+date pairs on the summary (`M:20250220000001:20-31`). Signatures are opaque TEXT; no signer identity or hash is stored (results tables have no `created_by`). Instance/answer `created_by/updated_by` reference `skyline_users` and are null for students (`getAuditFields`).
- Office sign-off: `admin_initial_checked`/`admin_updated_checked` on the summary + `initial_checked`/`updated_checked` per task section; all ticked ⇒ auto-complete (`InstanceFillPage.tsx:1584-1609`; `src/lib/assessmentCompletionStatus.ts:53-83`); manual "Finalize" does not require them (`:2667-2669`; `SKYLINE_SUBMISSIONS_PROCESS_FLOW.md` §8 flags this).
- Student acknowledgment (`M:20260613120000`): the dashboard computes a status label per instance (`calculateAssessmentFinalStatus`, `src/utils/assessmentRowUi.ts:114-223`), shows a gate for outcomes of kind passed/failed/missed/resubmit whose label differs from the last acknowledged label, and upserts `skyline_assessment_acknowledgments` (`src/services/notifications.ts:129-226`; `src/components/NotificationAcknowledgmentGate.tsx`).
- Notifications: `send-notification` Edge Function inserts `skyline_notifications` rows per `userIds` (student id as text, or trainer user ids) and sends FCM push; types `workflow_student_submit`, `workflow_resubmit`, `workflow_failed`, `workflow_to_office`, `workflow_completed` (`src/lib/formEngine.ts:7802-7825`; `supabase/functions/send-notification/index.ts:135-185`; visuals `src/utils/notificationOutcome.ts:49-86`).

---

### 6. Course / unit / batch links from the instance

| Link | Column / join | Notes |
|---|---|---|
| Instance → form (unit) | `skyline_form_instances.form_id` | unit code/name live on the form |
| Instance → student | `student_id` (nullable, SET NULL on student delete; superadmin delete removes instances first `M:20260421000002:14`) | |
| Instance → course | **no column**; derived via `skyline_course_forms.form_id` (many courses possible) and the student's `skyline_student_courses` rows; lifecycle gate picks the single `in_progress` enrolment and denies when ambiguous (`src/lib/studentAssessmentAccess.ts:334-400`) | directory filters use `EXISTS course_forms` (`M:20261105000002:323-331`) |
| Instance → batch | **no column**; via `skyline_students.batch_id` (one batch per student at a time) | report/batch columns are looked up per student (`src/services/assessmentReports.ts:48-72`; `src/utils/assessmentBatchDisplay.ts`) |
| Instance → trainer | **no column**; `role_context='trainer'` + batch trainers (`skyline_batches.trainer_id` ∪ `skyline_batch_trainers`) | changing a student's batch silently changes who can see/mark the instance |
| Course lifecycle | `skyline_student_courses.enrollment_status`, dates; backfilled from instance dates (`M:20260713140000:57-81`); one in-progress per student; students blocked outside the window, staff never blocked (`src/lib/studentAssessmentAccess.ts:139-172`) | |
| Batch ↔ course | `skyline_batches.course_id`; students must be enrolled in that course (trigger `M:20260615210000`, RPC `M:20260615200000`, client `src/lib/studentBatchValidation.ts`) | |

---

### 7. Reports

| Report | Implementation | Where |
|---|---|---|
| Assessment Reports page | `src/pages/admin/reports/AssessmentReports.tsx` (383 lines; `AdminAssessmentReportsPage.tsx` re-exports) using `fetchAssessmentReportPage` (server page via `skyline_list_submitted_instances_paged`, sort student asc, workflow `all`, batch filter) and `fetchAllAssessmentReportRows` (pages of 500) → `downloadAssessmentReportCsv` which writes **XLSX** (`xlsx`), columns Instance ID, Student, Unit, Start, End, Status, Batch | `src/services/assessmentReports.ts:104-188` |
| Report status | `Completed` if `status='locked'` and not terminal DNA; `Failed` if terminal DNA **or today > effective deadline** (so a submission waiting for trainer past its end date reports "Failed"); else `In Progress` | `src/utils/assessmentReportStatus.ts:7-28` |
| Assessment directory export | `AdminAssessmentsPage` loops the paged RPC and exports | `src/pages/AdminAssessmentsPage.tsx:672-759` |
| Dashboard stats | `skyline_admin_dashboard_stats_v2` buckets awaiting_student / awaiting_trainer / awaiting_office / did_not_attempt / completed | `M:20261105000002:755-832` |
| Generic links PDF | `skyline_course_link_exports` + `GenericLinksPdf` | `src/lib/formEngine.ts:6490-6550`; `src/components/pdf/GenericLinksPdf.tsx` |
| Ad-hoc SQL | `sql/admin_reports/carpentry_incomplete_student_units.sql`, `course_lifecycle_preflight.sql`; `scripts/db-cleanup/instance-progress-status.sql` | read-only SQL for the SQL editor |
| Finance reports | separate (`FinanceReports.tsx`, aXcelerate) | out of scope |

---

### 8. Vitest tests relevant to assessments

| File | Asserts |
|---|---|
| `src/lib/assessmentWorkflowMigration.test.ts` | hardening migration text: saved-answer expiries become incomplete, untouched expiries stay DNA, competent/answered DNA rows repaired, rollover is scheduled not client-called, submit RPC locks row and records request id, terminal states reject student mutation |
| `src/lib/assessmentCompletionStatus.test.ts` | office checklist completeness, handoff allowed only after a student submission, duplicate task_results sections share office checks |
| `src/utils/assessmentResultValidation.test.ts` | ≥1 valid attempt (outcome+date) on results sheet and summary; partial rows rejected |
| `src/utils/assessmentDeadline.test.ts` | `mirrorExtensionDate` equals the DB trigger rule; access window, "Not submitted by due date", report status and row semantics use `COALESCE(extension_date,end_date)` |
| `src/utils/assessmentRowUi.test.ts` | terminal DNA needs rollovers ≥ 2; end-date change auto-resets exhausted rows but never completed ones; missed-attempt text; status precedence (completed > trainer result > submitted > saved answers > DNA); attempt dot tones per scenario |
| `src/utils/assessmentValidationMessages.test.ts` | question-numbered validation messages, content-block gaps, hidden/non-student fields |
| `src/utils/formAnswerMerge.test.ts` | merge never wipes existing values; identity-field repair detection; attempt reset preserves identity answers |
| `src/lib/answerAttachment.test.ts`, `answerAttachmentPdf.test.ts`, `storage.answerAttachment.test.ts`, `src/components/form-fill/QuestionRenderer.attachment.test.tsx` | attachment envelope round-trip for every question type, per-row attachment on question-level row, PDF renders attachments once, upload path/bucket identical for all types, upload disabled until instance exists |
| `src/lib/studentAssessmentAccess.test.ts` | lifecycle gate: in-progress within inclusive dates only; tentative/suspended/cancelled/completed blocked; missing data fails closed; staff never blocked; unknown role = student |
| `src/lib/studentBatchValidation.test.ts` | import id normalisation, course-id merge, batch-course partition, mismatch message |
| `src/lib/studentImportCourseDates.test.ts`, `studentImportEnrollment.test.ts`, `courseLifecycle.test.ts` | course dates derived from units, one in-progress course, overlap rejection, tentative defaults |
| `src/lib/assessmentTaskSteps.test.ts` | task numbering is form-scoped; duplicate task-step detection by row id |
| `src/lib/contentBlockClone.test.ts`, `questionDuplicate.test.ts`, `contentBlockAnswerIsolation.integration.test.ts` | content-block id remapping on duplicate; shared-child diagnostics; answers do not leak across cloned children |
| `src/lib/writtenEvidenceChecklist.test.ts` | every checklist question with rows is selected; PDF table per question |
| `src/lib/assessmentSearch.test.ts` | search tokeniser (student id / unit code / general) |
| `src/utils/assessmentBatchDisplay.test.ts`, `formUnitDisplay.test.ts`, `parseMixedContent.test.ts` | batch grouping/labels; unit code/name repair; pasted Word instruction tables |
| `src/lib/supabaseRequestGuard.test.ts` | request guard (not assessment-specific) |

No tests execute SQL; migration behaviour is asserted by reading migration text. `supabase/tests` does not exist in this repo.

---

### 9. Classification

| Capability | Status | Evidence |
|---|---|---|
| Assessment (form) creation | Implemented | `createForm`, builder, default steps (§2.1) |
| Versioning | Missing | free-text `version`, no snapshots, live edits affect instances (§2.2) |
| Assignment to students / batches | Implemented (app-level) | §2.3; no DB uniqueness; batch = student attribute |
| Drafts (autosave, merge guard) | Implemented | §3.2 |
| Submission (atomic, idempotent, audited) | Implemented | `skyline_submit_instance_to_trainer` + `skyline_submission_events` |
| Evidence / attachments | Implemented (public bucket) | §4; no signed URLs, anon write to whole bucket |
| Marking (per question/row/checklist, per task S/NS) | Implemented | §5.1–5.2 |
| Feedback | Partial | per-attempt free text only; no threads, no student reply |
| Reassessment (3 attempts, +5 days, auto-NS on missed window) | Implemented | §5.3 |
| Unit outcome (C / NYC per attempt) | Implemented | summary `final_attempt_N_result`, derived from tasks |
| Sign-off (student/trainer/office) | Partial | TEXT signatures, no signer identity/hash; office finalize not gated |
| Audit history | Partial | submission events, learning-doc log, impersonation log, updated_at only; results/answers overwritten; no form history |
| Reports | Partial | one XLSX export + dashboard counts; status label treats overdue-but-submitted as Failed |
| Student acknowledgment of outcome | Implemented | §5.4 |
| Row-level security / server authorization | Missing | §1.4 |
| `skyline_form_assets`, `trainer_checked_at`, `office_checked_at`, `forms.start/end_date`, `skyline_batch_assessment_eligibility`, `allowStudentResubmission` | Unused / vestigial | no callers found in `src/` |

---

### 10. Confirmed vs Assumed vs Needs runtime access

**Confirmed from source**
- Table/column/constraint inventory, triggers, RPC signatures and SECURITY DEFINER flags (§1).
- Workflow state machine, submit RPC semantics, rollover rules and their migration history (§3).
- Reassessment constants (3 attempts, +5 days, Melbourne dates) and reset behaviour (§5.3).
- Storage path patterns, public-URL usage, SharePoint PDF pipeline (§4).
- Absence of RLS on assessment tables and anon grants on destructive RPCs (§1.4).

**Assumed (code reading, not executed)**
- That `M:20260917123000` (marked "Review-only … do not apply to production until approved"), `M:20261104000001/2` and `M:20261105000001/2` (marked DRAFT / "run by hand") are applied on the hosted project; the frontend already depends on `extension_date` and `awaiting_submission`, so they likely are, but the migration headers say otherwise.
- That `scripts/fix-storage-policies.sql` reflects the live `photomedia` policies (it is a script, not a migration).
- That the report "Failed" label for overdue submitted instances is a bug rather than intent (`src/utils/assessmentReportStatus.ts:22-26` ignores `suppressExpiry`).
- That no code path relies on `skyline_form_assets` or `trainer_checked_at/office_checked_at` (no `src/` references found).

**Needs runtime / hosted access to verify**
- Which of the two `skyline_list_submitted_instances_paged` / `_dashboard_*` overloads PostgREST resolves for the client calls; whether the pending `supabase/pending/20261110000006` revoke has been applied.
- Live `storage.buckets`/`storage.objects` policies, bucket public flags, and Vault secrets used by `skyline_invoke_pdf_worker_async`.
- pg_cron job state and the actual contents of `backup.*` snapshot tables.
- Data-quality questions implied by repairs: how many instances have duplicate task steps, multiple instances per (student, form), or inconsistent `status`/`role_context`/`workflow_status` triples.
- Whether `allow_trainer_student_login`, impersonation and notification/FCM flows work end-to-end (Edge Function secrets).

---

### Appendix A. `skyline_form_instances` column by column

| Column | Type / default | Written by | Read by | Where added |
|---|---|---|---|---|
| `id` | bigint identity | insert | everywhere | `M:20250211000000:91` |
| `form_id` | bigint NN → forms CASCADE | `createFormInstance` | template fetch, directory joins | `:92` |
| `status` | text ='draft' CHECK draft/submitted/locked/incomplete | submit RPC, `updateInstanceWorkflowStatus`, rollover, date change | queue filters (`role_context`+`status`) | `:93`; incomplete `M:20260917123000:12-16` |
| `role_context` | text ='student' CHECK student/trainer/office | same + `updateInstanceRole` + auto-assign trigger | trainer/office queues (`formEngine.ts:4126-4140`) | `:94` |
| `created_at` | tz default now() | insert | ordering | `:95` |
| `submitted_at` | tz | first successful submit only | dashboards, "submitted" fallback | `:96`; rule `M:20260917123000:213` |
| `student_id` | bigint → students SET NULL | insert | everything student-facing | `M:20250211000001:12-13` |
| `workflow_status` | text ='draft' CHECK 6 values | all transition writers | `normalizeInstanceWorkflowStatus`, PDF trigger | `M:20260227000002:4`; `M:20260917123000:18-31` |
| `trainer_checked_at`, `office_checked_at` | tz | nothing in `src/` | nothing | `M:20260227000002:5-6` (unused) |
| `created_by`, `updated_by`, `updated_at` | → users; trigger | `getAuditFields()` (null for students) | — | `M:20260314000001:61-65` |
| `submission_count` | int NN =0 | submit RPC (clamp 3), reset | attempt number everywhere | `M:20260325000001:3` |
| `start_date`, `end_date` | date | assignment, date editors, trainer NYC (+5), rollover (+5) | access window, directory, reports | `M:20260326000004:4-5` → `M:20260415000005` |
| `no_attempt_rollovers` | int NN =0 | rollover (+1), date change (0) | terminal-DNA rule (≥2) | `M:20260424000001:5` |
| `did_not_attempt` | bool NN =false | rollover (true), submit RPC/date change (false) | token validation, filters, status | `M:20260424000001:6` |
| `admin_reference_note` | text | `updateInstanceAdminReferenceNote` (`formEngine.ts:613`) | admin only ("must not be exposed to students") | `M:20260519120000:3-7` |
| `trainer_nyc_assessed_on_1/2/3` | date | `recordTrainerNycAssessedOn` | rollover auto-NS date | `M:20260520140000:4-7` |
| `extension_date` | date, CHECK ≥ end_date, mirror trigger | admin extension UI, "extend 30 days", rollover (+5) | effective deadline everywhere | `M:20261105000001:24-70` |

### Appendix B. Section render modes and question types

| `pdf_render_mode` | Role in the assessment | Notes |
|---|---|---|
| `normal`, `likert_table`, `grid_table` | generic content / Learner Evaluation | `likert_table` used by Appendix B evaluation (`M:20260312000001:13-22`) |
| `declarations` | Student declaration step (question `student.declarationSignature`) | anchors the date chain (`InstanceFillPage.tsx:599-610`) |
| `assessment_tasks` | the task list: one `grid_table` question whose rows are the tasks; `row_meta` holds task instructions | `taskResultsOutcome.ts:228-245`; `M:20250216000001:4` |
| `assessment_submission` | submission method (`assessment.submission`, `assessment.otherDesc`) | editability flipped by `M:20250213000001` / `M:20250220000001` |
| `reasonable_adjustment` / `reasonable_adjustment_indicator` | Appendix A (trainer/office only) / intro pointer to it | `M:20260310000003`; `M:20260312000001:5-11` |
| `additional_instructions` | section-level rich instructions in `sections.instructions_meta` | `M:20260409000001-2` |
| `task_instructions`, `task_questions`, `task_written_evidence_checklist`, `task_marking_checklist`, `task_results` | the five auto-generated sections per task row (`assessment_task_row_id`) | created by `ensureTaskSectionsForForm` (`formEngine.ts:288-348`); marking checklist questions `assessment.marking.evidence_outcome` / `performance_outcome` |
| `assessment_summary` | one per form, after the last task; backs `skyline_form_assessment_summary_data` | `M:20250220000001`; summary step index `taskResultsOutcome.ts:11-25` |

| Question `type` | Stored as | Per-row? |
|---|---|---|
| `short_text`, `long_text`, `yes_no`, `single_choice` (no rows), `date` | `value_text` | no |
| `multi_choice` | `value_json` array | no |
| `single_choice` with rows (checklists) | `value_text` per `row_id` | yes |
| `likert_5` | `value_text` per `row_id` | yes |
| `grid_table` | `value_json` object of cells per `row_id` (`src/utils/gridTableAnswers.ts`) | yes |
| `image` | `value_json {url}` | no |
| `signature` | `value_json` object or text (data URL / typed) | no |
| `instruction_block`, `page_break` | never answered | — |
| any + `pdf_meta.allowAnswerImage` | adds `answerImageUrl` to `value_json` on the question-level row | — |
| `pdf_meta.contentBlocks[].questionId` / `isAdditionalBlockOf` | child questions embedded in a parent (shared-child bug repaired by `M:20260724035221`) | — |

### Appendix C. `skyline_sync_no_attempt_rollover` version history

| Migration | Change |
|---|---|
| `M:20260424000001_add_no_attempt_rollover_tracking.sql` | first version: client-callable (anon), never-submitted drafts get +5 days twice, then `did_not_attempt` + `role_context='office'` (no lock) |
| `M:20260507000000_no_attempt_rollover_after_nyc.sql` | also rolls over after a trainer NYC when `submission_count` equals the NYC attempt |
| `M:20260507100000_fix_rollover_counts_and_auto_ns_missed_attempt.sql` | includes trainer/submitted count-1 rows, hands back to student/draft, auto-marks attempt 2 NYC/NS dated `new_end - 5` |
| `M:20260520140100_rollover_nyc_assessed_on_dates.sql` | auto-NS date prefers `trainer_nyc_assessed_on_1` |
| `M:20260529130000_fix_did_not_attempt_workflow.sql` | terminal rows become `status='locked'`, `workflow_status='failed'`; directory/dashboard filters exclude DNA from office/completed |
| `M:20260917123000_assessment_submission_workflow_hardening.sql` | anon/authenticated EXECUTE revoked; pg_cron every 15 min; drafts with answers → `incomplete`/`awaiting_submission`; only untouched rows → DNA; legacy repairs |
| `M:20261105000002_extension_deadline_functions.sql` | every deadline test uses `COALESCE(extension_date,end_date)`; `extension_date` also moves +5 |

### Appendix D. Read-side normalisation and display precedence

`normalizeInstanceWorkflowStatus` (`src/utils/instanceWorkflow.ts:13-63`): if `workflow_status` is empty derive from legacy (`locked`→completed, `submitted`+office→waiting_office, `submitted`→waiting_trainer, `incomplete`→awaiting_submission, `draft`+trainer/office→waiting_*); a submitted instance still showing `draft` with non-student role is promoted to waiting_*; a student draft with no submission can never show failed/completed; `did_not_attempt` without a submission forces `failed`; submitted+office forces waiting_office.

`calculateAssessmentFinalStatus` (`src/utils/assessmentRowUi.ts:114-223`), highest wins: office completed (`workflow_status='completed'` or admin Initial+Updated ticked or locked+office+competent) → `Completed`; any trainer attempt result → `Competent` / `Not competent`; submitted → `Submitted`; saved answers → `In progress` / `Not submitted by due date` (past effective deadline); `did_not_attempt && rollovers ≥ 2 && no submission` → `Didn't attempt any`; else in progress. Workflow badge labels: `getInstanceWorkflowLabel` (`:335-354`) adds `Submitted (Not Sent)` when submitted but still student/draft.

### Appendix E. Access-token lifecycle

| Event | Effect on `skyline_instance_access_tokens` | Where |
|---|---|---|
| Admin/trainer opens or sends link | new token row; student expiry = effective deadline 23:59 Melbourne (refused outside window or when course not in progress); trainer/office +90 days | `src/lib/formEngine.ts:1628-1694` |
| Reuse | `getOrIssueInstanceAccessLink` returns an existing unexpired, unrevoked, unconsumed token | `:1592-1626` |
| Open `/instances/:id?token=` | validate (revoked/consumed/expired/inactive student/DNA/window/lifecycle) | `:1831-1947` |
| Student final submit | all student tokens revoked | `src/pages/InstanceFillPage.tsx:2532`; `:1958-1967` |
| Trainer NYC / end-date edit | `extendInstanceAccessTokensToDate` sets `end_date`, un-revokes and re-dates student tokens | `:2025-2043` |
| "Extend 30 days" | writes `extension_date`, un-revokes, re-dates | `:1995-2022` |
| Extension-only edit | `syncStudentTokenExpiryToDeadline` | `:2049-2064` |
| Rollover (+5) | SQL un-revokes and re-dates unconsumed student tokens | `M:20261105000002:143-154` |
| Student dashboard | `link_expired` flag computed from token table (`:1753-1765, 1775`); dashboard opens via `issueInstanceAccessLink` | `src/pages/StudentDashboardPage.tsx` |

### Appendix F. Role × workflow edit matrix (InstanceFillPage)

| Role | draft | awaiting_submission | waiting_trainer | waiting_office | completed / failed |
|---|---|---|---|---|---|
| student | edit (if lifecycle allows) + Final Submit | edit + Final Submit (RPC accepts) | read-only | read-only | read-only |
| trainer | edit (may fix student answers) | edit | edit + trainer submit | edit only while `role_context` still trainer | read-only |
| office | read-only | read-only | read-only | edit office fields, Finalize | admin fields still editable (`canOfficeAdminEdit`) |
| office + admin edit mode | everything | everything | everything | everything | everything (Quick Edit may hand off / complete) |

Source: `src/pages/InstanceFillPage.tsx:548-566, 1790-1835`; `src/lib/assessmentCompletionStatus.ts:90-104`.

### Appendix G. Notification types emitted

| `type` | Recipients (`skyline_notifications.user_id`) | Trigger |
|---|---|---|
| `workflow_student_submit` | all batch trainers (user ids) | student final submit (`InstanceFillPage.tsx:2538-2550`) |
| `workflow_resubmit` | student (student id as text) | trainer NYC attempt 1/2 (`:2606-2616`) |
| `workflow_failed` | student | trainer NYC attempt 3 (`:2630-2640`) |
| `workflow_to_office` | student | trainer Competent (`:2652-2662`) |
| `workflow_completed` | student | office finalize (`:2672-2682`) |
| (none) | — | rollover, date changes, extension, admin reset: no notification is sent |

### Appendix H. Hard-coded constants

| Constant | Value | Where |
|---|---|---|
| Max attempts | 3 | `M:20260917123000:214`; `assessmentResultValidation.ts:18-20` |
| Resubmission window after NYC | 5 days | `src/lib/formEngine.ts:1541` |
| Rollover extension / count | +5 days, twice (`no_attempt_rollovers < 2`) | `M:20261105000002:31-43` |
| Rollover cadence | every 15 min (pg_cron) | `M:20260917123000:535-539` |
| Default instance window when caller passes no dates | today → +30 days (Melbourne) | `formEngine.ts:1303-1315` |
| Default token TTL without instance deadline | student 30 d, trainer/office 90 d | `formEngine.ts:1679` |
| "Extend link" | +30 days from today | `AdminAssessmentsPage.tsx:382`; `formEngine.ts:1995` |
| Staff session | 12 h | `M:20261110000001:28` |
| OTP validity | 10 min | `M:20260313000001:1` |
| Grade-me panel cap | 2000 instances | `formEngine.ts:4308` |
| Time zone for all deadlines | `Australia/Melbourne`, end of day 23:59 | `formEngine.ts:1488-1575`; `src/utils/melbourneTime.ts` |


---

# Part K. Skyline-Website (target)

Paths are relative to the Skyline repo root. Helper functions used in the policies cited below: `cms_is_staff()` / `cms_is_admin()` (`supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:52-57`), `cms_is_rto_manager()` (`supabase/migrations/20261113340000_course_management.sql:11-16`), `tenant_scope(uuid)` (`supabase/migrations/20261025052725_enforce_total_tenant_scope.sql:3-8`), `portal_student_id()` (`supabase/migrations/20261104270000_student_portal_login.sql:48-55`). Module K-D (appended after K15) holds the long-form evidence for K2, K3, K4, K6, K7 and K8.

## K index

| # | Brief item | Status | Where |
|---|---|---|---|
| K1 | The CMS | Implemented | K1 |
| K2 | Courses, Master Data vs catalogue | Implemented | K2, K-D §1 |
| K3 | Units, fees, intakes | Implemented; unit elements / criteria Missing | K3, K-D §2-§4 |
| K4 | Applications and enrolments | Implemented; application ↔ batch link Partial | K4, K-D §7 |
| K5 | Agents | Implemented | K5 |
| K6 | HRMS / employees, trainer identification | Implemented; trainer role filter Partial | K6, K-D §6 |
| K7 | Batches, trainer / student allocation | Implemented | K7, K-D §5 |
| K8 | Timetable / calendar | Partial (planning only; no dated events) | K8, K-D §8 |
| K9 | Auth / roles, dashboards | Implemented | K9 |
| K10 | Multi-tenancy | Implemented for CMS / portal; Partial for RTO tables | K10 |
| K11 | Migrations | Implemented (260 files, additive, timestamp order) | K11 |
| K12 | Storage and document management | Implemented (private buckets, path policies) | K12 |
| K13 | Template / form engine and e-signing | Implemented (two engines, neither an assessment engine) | K13 |
| K14 | Notifications and background jobs | Implemented (outbox + cron workers) | K14 |
| K15 | Audit and reporting | Partial (audit tables per domain; no cross-domain reporting) | K15 |

## K1. The CMS

| Aspect | Finding | Evidence |
|---|---|---|
| Identity | `cms_users(id text, name, email unique, role 'Admin'/'Editor', status, ...)` plus `auth_user_id` and `must_change_password` bound to Supabase Auth; `rto_manager boolean` added by COURSE-MGMT | `supabase/migrations/0001_cms_schema.sql:35-43`; `supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:40-57`; `supabase/migrations/20261113340000_course_management.sql:8-9` |
| Tables | `cms_settings`, `cms_social_links`, `cms_users`, `cms_courses` (+sections, attachments, links), `cms_pages`, `cms_forms`, `cms_form_fields`, `cms_documents`, `cms_navigation_items`, `cms_footer`, `cms_seo`, `cms_revisions`, `cms_activity_log` | `supabase/migrations/0001_cms_schema.sql` (table list) |
| Publishing model | Draft store + `cms_commit`; the public site reads `cms_public_snapshot`; admin reads `cms_admin_snapshot` | `src/pages/admin/lib/db.ts:433`; `src/lib/publicData.ts:483-509` |
| Pages | `src/pages/admin/*` (Courses, Pages, Navigation, Footer, Settings, Documents, Forms, Contact, SEO, Users, Activity, Knowledge, plus Master Data, HRMS, Tickets, Integrations, Signing, Templates) | directory listing of `src/pages/admin` |
| Menu | `admin_menu_items` rows with `permission_key` (`cms.read` / `cms.admin` / `applications.review`) rendered by `AdminMenu.tsx`; a route must also be in the allow-list `src/pages/admin/lib/adminMenu.ts:29-38` | `supabase/migrations/20261102090902_admin_menu_items.sql:4-47`; `src/pages/admin/components/AdminMenu.tsx:45` |
| Route guards | `RequireAdmin` wraps admin pages (UX only); SQL / RPC checks are the boundary | `src/router/config.tsx`; `docs/ARCHITECTURE.md` "Screen guards are UX only" |
| Design system | Tailwind, shared `components/ui`, CMS `RichTextEditor` (document mode), sheets / drawers / tables used by the RTO pages (`IntakeSheet.tsx`, `BatchTimingDrawer.tsx`, `StudentPicker.tsx`); display density and collapsible sidebar per user (UI-PREFS) | `src/pages/admin/components/rto/*`; `supabase/migrations/20261113420000_cms_user_ui_prefs.sql` |
| Where Assessment Management plugs in | New menu row under Master Data (migration + `adminMenu.ts` allow-list entry); course wizard step list `src/pages/admin/CourseWizardPage.tsx:13-19`; `BatchPage.tsx:174-176` placeholder "Assessments & Results"; `StudentDetailPage.tsx:100` next to `StudiesPanel` | K-D §9 |

Classification: **Implemented**. The CMS is the host for the admin side of Assessment Management; nothing in it models assessments.

## K2. Courses: Master Data vs website catalogue

One table, `cms_courses`, edited by two surfaces: the Master Data wizard (`/admin/courses/:id/:step`, facts / timetable / fees / intakes / website) and the website editor (`/admin/courses/:slug`). The national catalogue (`australian_course_catalogue`) is a lookup that creates or links a `cms_courses` row. Full evidence: K-D §1.

Facts the integration relies on:

- `cms_courses.tenant_id uuid` nullable (SLIT runs as the legacy scope with `tenant_id IS NULL`); unique `(id, tenant_id)` (`supabase/migrations/20261024180429_tenant_resource_policies_and_worker_boundaries.sql:44-45,430`). **The RTO delivery tables (`course_intakes`, `intake_units`, `batches`, `batch_trainers`, `batch_enrolments`, `batch_sessions`, `classrooms`, `locations`, `academic_breaks`) carry no `tenant_id`; the course is the only tenant anchor in the chain** (K-D §5.1, §10). This is why DECISIONS.md D-03 copies `tenant_id` from the course onto every `asm_*` row.
- `rto_student_on_course` compares `enrollment_application_courses.course_id` to `cms_courses.id` only, while public Enrol Now applications store the slug (K-D §1.3). Assessment assignment must resolve students through `batch_enrolments`, not through applications, to avoid inheriting this gap.
- Course labels: `course_label` / `course_name_variant` (`supabase/migrations/20261113360000_course_labels.sql:14-27`).

Classification: **Implemented**.

## K3. Units, fees and intakes

- Units: `cms_course_units(id text, course_id, code, name, category, sort, unit_type core/elective, default_weeks, duration_weeks, nominal_hours, is_active)` with RLS read (staff or Published course) / write (`cms_is_staff()`), saved through `rto_admin('units_save')` (K-D §2). **No elements, performance criteria, performance evidence, knowledge evidence or assessment conditions exist anywhere** (grep evidence in K-D §2). The unit mapping matrix (brief 4.4) therefore needs new tables keyed by `cms_course_units.id`.
- Fees: `course_fee_items`, `course_fee_total_cents`, legacy `course_fee_setups` kept in sync by trigger (K-D §3). Not touched by assessments.
- Intakes: `course_intakes(id uuid, course_id, start_date, end_date, label, status draft/open/full/closed, capacity, campus)`; `intake_units(intake_id, unit_id, start_date, end_date, hours, sort)` generated over working days (K-D §4). The unit window inside an intake (`intake_units`, overridable per batch by `batch_unit_overrides`) is the natural default for an assessment's availability and due dates.

Classification: units / fees / intakes **Implemented**; unit elements and criteria **Missing**.

## K4. Applications and enrolments

Two distinct "enrolments" exist (K-D §7.3): the admission application (`enrollment_applications` + `enrollment_application_courses`, status workflow in `application_statuses`, offer letters, CoE) and the delivery enrolment (`batch_enrolments(batch_id, student_id, enrolment_type, status active/deferred/withdrawn/completed)`). Nothing links the two by FK; staff enrol into a batch from the batch page, the intake sheet or the student's Studies panel via `rto_admin('enrol')`.

For assessments the delivery side is authoritative: a student is "in" an assessment through an active `batch_enrolments` row of the batch the assessment is assigned to. The application is only needed for letters and identity (`hr.sign_subject`).

Classification: applications **Implemented**; application ↔ batch coupling **Partial** (by convention, not by data).

## K5. Agents

| Aspect | Finding | Evidence |
|---|---|---|
| Model | `agencies` (business) → `agents(business_id, profile_id -> portal_profiles, role agent/agency_admin)` → `enrollment_students(agency_id, agent_id, tenant_id)`; `agency_tenants` many-to-many agency ↔ institution; `agency_memberships(role agent/agency_admin/student, student_id)` ties a portal login to a business | `supabase/migrations/20261104090000_one_business_agent_student_chain.sql:50-66,92-96`; `supabase/migrations/0006_agency_portal.sql:136-157`; `supabase/migrations/20261104270000_student_portal_login.sql:33-39` |
| Portal | `src/pages/agency/*`: dashboard, applications (draft / autosave / submit wizard), all-applications, documents, notifications, agency profile, audit log, registrations, users, tickets | directory listing of `src/pages/agency` |
| Students in the same portal | Students sign in to the same `/agency` surface with `agency_memberships.role = 'student'`; the portal shows applications only, no batches, units, timetable or results | K-D §7.4 |
| Relevance | Agents have no part in assessments. The student experience for assessments must be added to the portal (`src/pages/agency`) as new routes guarded by `portal_identity().role = 'student'`, not to a new app | — |

Classification: **Implemented** (out of assessment scope except as the host of the student experience).

## K6. HRMS / employees and trainer identification

Trainer = an `hr.staff_profiles` row (`auth_user_id unique -> auth.users`, `status` draft/submitted/preboarding/active/rejected/inactive, unique `email` and `phone_e164`) with an `hr.staff_roles(role in ('admin','trainer'))` row; `batch_trainers.staff_id -> hr.staff_profiles(id)` links trainers to batches. `rto_admin('staff_list')` offers every active profile with no filter on the trainer role (`supabase/migrations/20261113350000_course_management_followups.sql:442-444`). Trainers sign in through Supabase Auth and land on `/staff` (`src/pages/staff/StaffHomePage.tsx`: profile, documents, timesheet, leave, holidays), which has no batches, classes or calendar. A trainer with only the `trainer` role has no `cms_users` row and therefore no CMS access (`supabase/migrations/20261105190000_hr_staff_rpcs.sql:8`). Full evidence: K-D §6.

Consequences used in DECISIONS.md D-02 / D-15: the trainer predicate is `exists (select 1 from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status = 'active')` joined to `batch_trainers` or to a direct assessment assignment; the trainer UI goes into `/staff`, not the CMS.

Classification: HRMS identity **Implemented**; trainer allocation **Partial** (no role filter, no per-session trainer, no availability check).

## K7. Batches, trainer and student allocation

`batches(id, intake_id, name unique per intake, classroom_id, class_days, start_time, end_time, capacity, is_active)` (no course column: course via intake; no tenant column), `batch_trainers`, `batch_enrolments`, `batch_unit_overrides`, `batch_sessions` (weekly recurring theory / practical / assessment slots with room). RLS: staff read, RTO Manager write, Admin may write `batch_enrolments`. Actions in `rto_admin` (`enrol`, `unenrol`, `batch_save`) and `rto_course_flow` (`batch_setup`, `batch_trainers_set`, `student_move`, `enrolment_set`, `batch_get`, `rooms_board`). UI: `src/pages/admin/BatchPage.tsx` with five sections, the fifth a placeholder "Assessments & Results" (`:174-176`). Full evidence: K-D §5.

Batch membership changes (`student_move`, `enrolment_set` withdrawn / active) are the hooks for the brief's reassignment rules (section 7, step 9).

Classification: **Implemented**.

## K8. Timetable / calendar

There is **no generic dated event table**: the timetable is dated unit windows (`intake_units`, `batch_unit_overrides`) × weekly recurring `batch_sessions`, expanded on the client one week at a time (`rto_course_flow('rooms_board')`). Calendar-like UI exists only in the CMS (intake Gantt `SchedulePanel.tsx`, rooms board `RoomsBoard.tsx`, batch timing lines); `/staff` and `/agency` have no class calendar. Holidays come from `hr.public_holidays`, breaks from `academic_breaks`. Full evidence: K-D §8.

What the brief's "existing calendar" therefore means: the existing timetable *data* (batch sessions, unit windows, holidays, breaks) and the existing week-grid / Gantt *components*. Assessment due dates and dated practical sessions need a new dated table that those components can read alongside sessions (DECISIONS.md D-10: `asm_schedule_events` + `asm_calendar(from, to)`), and the student and trainer calendar views are new screens built from the existing components.

Classification: **Partial** (planning timetable Implemented; dated events, student calendar and trainer calendar Missing).

## K9. Auth, roles and dashboards

| Actor | Identity | Role check | Landing |
|---|---|---|---|
| CMS staff (Admin / Editor, RTO Manager flag) | `auth.users` → `cms_users.auth_user_id` | `cms_is_staff()`, `cms_is_admin()`, `cms_is_rto_manager()`; password rotation enforced through `must_change_password` | `/admin` (`src/pages/admin/DashboardPage.tsx`) |
| HR staff / trainer | `auth.users` → `hr.staff_profiles.auth_user_id` | `hr_staff_access()` (status), `hr.staff_roles.role` | `/staff` (`src/pages/staff/StaffHomePage.tsx`) |
| Agent / agency admin | `auth.users` → `portal_profiles.auth_user_id` → `agency_memberships(role)` | `portal_identity()` | `/agency` (`src/pages/agency/dashboard/page.tsx`) |
| Student | same as agent with `agency_memberships.role = 'student'`, `student_id -> enrollment_students` | `portal_student_id()`, `portal_identity().role = 'student'` | `/agency` (applications only) |
| Platform admin | `platform_admins` | `tenant_is_platform_admin()` | — |

Evidence: `supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:40-62`; `supabase/migrations/20261105190000_hr_staff_rpcs.sql:85-96`; `supabase/migrations/20261104270000_student_portal_login.sql:48-80`; `src/lib/loginRouting.ts:10-13,55-86` (one login may hold several destinations and is offered a choice).

Identity rule (owner, 2026-11-12): an email is unique within a role but may repeat across roles (`supabase/migrations/20261112042544_email_unique_per_role.sql:1-45`); a portal login holds exactly one portal role (`supabase/migrations/20261112042642_portal_invite_single_login_role.sql:1-20`). So the same `auth.users` row can be a trainer (`hr.staff_profiles`) and a student (`portal_profiles` + membership) at once; the assessment RPCs must pick the acting role explicitly (admin / trainer / student entry points, DECISIONS.md D-04) rather than infer it.

Dashboards: CMS `/admin` (CMS and application KPIs), portal `/agency` (applications), `/staff` (HR self-service). None shows assessment data.

Classification: **Implemented** (three identity domains on one Supabase Auth; no assessment dashboards).

## K10. Multi-tenancy

`tenants`, `tenant_domains` (verified hosts; unknown host fails closed), `tenant_memberships`, `platform_admins`, `agency_tenants`; `tenant_scope(tenant_id)` restrictive policies and `tenant_bind` triggers on CMS / application tables; legacy rows keep `tenant_id IS NULL` and are never assigned a default tenant (`docs/ARCHITECTURE.md` "Tenancy model"; `supabase/migrations/20261024175010_tenant_registry_and_verified_resolution.sql`; `supabase/migrations/20261024180429_tenant_resource_policies_and_worker_boundaries.sql:284-292`). The RTO delivery tables are the exception: no tenant column, access = "any CMS staff" (K2, K-D §10).

For `asm_*` tables: `tenant_id` copied from `cms_courses.tenant_id` (nullable), restrictive `tenant_scope(tenant_id)` policy plus the role predicate, and a bind trigger that refuses a client-supplied tenant that differs from the course's (DECISIONS.md D-03). Client tenant ids are never authorisation (`CLAUDE.md` Safety).

Classification: **Implemented** for CMS / portal; **Partial** for the RTO chain.

## K11. Migrations

260 files in `supabase/migrations` (`0001_cms_schema.sql` … `20261113420000_cms_user_ui_prefs.sql`); versions 1-90 and every released timestamp up to `20261113420000` are stated APPLIED on hosted in `CLAUDE.md` "Current position" (not re-verified here: runtime). Local-only: `20261113220000` (P09-01) and `20261113230000` (`find_student_by_email`). Conventions that the new migrations follow: additive only, timestamp order after the hosted highest (`20261113430000`, `20261113440000`: DECISIONS.md D-13), RLS enabled with explicit policies in the creating migration, security-definer RPCs with `revoke all … from public, anon` and explicit grants, pgTAP suites in `supabase/tests/*.sql` (14 suites), lab replay via `scripts/lab/staff-lab.mjs` / `scripts/lab/server.mjs` (Docker). Known hazard from `docs/SUPABASE.md` "Migrations": the local lab replays every file, so a version numbered below a hosted one would replay out of order on a fresh database.

Classification: **Implemented**.

## K12. Storage and document management

| Bucket | Visibility | Purpose / policy source |
|---|---|---|
| `cms-media` | public | website media (`supabase/migrations/0001_cms_schema.sql`) |
| `tenant-public-media`, `tenant-cms` | public / private, 20 MB, pdf/png/jpeg | tenant media (`supabase/migrations/20261024180429_...`) |
| `enrollment-documents` | private | application documents; path-based policies `portal_docs_obj_read/insert/update/delete` (`supabase/migrations/0006_agency_portal.sql:572-598`), hardened in `20261024154813_protect_registered_portal_storage_objects.sql` and `20261025052520_harden_tenant_storage_and_ownership.sql`; category validation `20261110150831_...`; worker-only CoE documents `enrollment_coe_documents` |
| `business-documents` | private | agency / business documents |
| `staff-documents`, `staff-signed-documents` | private | HRMS (`supabase/migrations/20261105180000_hr_staff_schema.sql`) |
| `signing-documents`, `template-assets` | private | e-sign originals / signed PDFs, template pictures (`supabase/migrations/20261110154917_document_signing.sql`, TPL-02) |
| `support-attachments` | private | tickets (`20261112021616_support_tickets`) |

Patterns to reuse for assessment evidence: a private bucket, object path = `<owner row id>/<file>` checked in the `storage.objects` policy against the owning row's select / write policy, short-lived signed URLs created client-side, and uploads validated server-side where content matters (`validated-document-upload` Edge Function for passports). Document viewing uses pdf.js legacy build (`components/signing/PdfPages.tsx`).

Classification: **Implemented**.

## K13. Template / form engine and e-signing

Two engines exist; neither models tasks → sections → questions with marking:

| Engine | What it is | Evidence | Fit for assessments |
|---|---|---|---|
| Website Form Builder | `cms_forms` + `cms_form_fields`; 14 flat field types (`Text, Email, Phone, Number, Date, Dropdown, Radio, Checkbox, Textarea, File Upload, Section Heading, Static Note, Terms, Table`) shared by builder, preview and public renderer; 477-line `FormBuilderPage.tsx` | `src/lib/formFields.ts:8-22`; `src/pages/admin/FormBuilderPage.tsx`; `src/pages/form/*` | Public enquiry forms. No sections / tasks, marking, assessor-only data, conditional logic, repeating groups or versioning. Not extended (DECISIONS.md D-01). |
| Document templates + e-signing | `hr.sign_templates(name, title, body, header_html, footer_html, bracket_variables)`, `hr.sign_template_parts` (header / footer presets), `hr.sign_template_versions`, `hr.templates` (HR letters / emails with `{{placeholders}}`), `hr.sign_requests` (state machine draft → sent → viewed → signed, `original_hash` / `signed_hash` sha-256, `consent`, `signer_name`, `signed_at`), `hr.sign_recipients`, `hr.sign_fields` (signature / initials / date / name / text / checkbox placed on PDF pages), `hr.sign_tokens` (hashed emailed links), `hr.sign_events`, `hr.sign_notifications` (reminders by cron `signing-notifications`); Edge Function `document-signing` renders PDFs with pdf-lib and the shared variable registry `_shared/template-variables.ts` | `supabase/migrations/20261110154917_document_signing.sql:3-23`; `supabase/migrations/20261113140000_document_signing_envelopes.sql:114-131`; `supabase/migrations/20261113190000_template_sections.sql`; `docs/SUPABASE.md` "Document templates with Header, Body and Footer" | Documents with signer fields, one envelope per recipient. Reused only for its declaration pattern (typed signature, consent text, hash of what was signed) and, later, for optional PDF export of a completed assessment. Not the assessment engine (D-01). |

Classification: **Implemented** (for their own purposes); assessment form engine **Missing**.

## K14. Notifications and background jobs

| Piece | Finding | Evidence |
|---|---|---|
| In-app | `portal_notifications(recipient, application_id, event, title, message, read)` for the portal; `hr.sign_notifications` for signing | `supabase/migrations/0006_agency_portal.sql:271-283` |
| Email outbox | `admission_event_outbox` → `notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, subject, body, state pending/suppressed, …)` with `support_ticket_id` and `booking_id` added later and the check `notification_deliveries_subject_ref` re-created each time a new subject arrives | `supabase/migrations/20261026180000_transactional_notification_outbox.sql:225-247`; `supabase/migrations/20261112114818_support_ticket_emails.sql:14`; `supabase/migrations/20261113125512_bookings.sql:95-99` |
| Workers | Edge Functions `notification-delivery` (v20, JWT on, service-role check), `email-sender`, `support-ticket-mail`; cron `notification-delivery-worker` (every minute), `signing-notifications`, `support-ticket-mail`, `hr-holiday-sync`, `hr-pay-periods-topup`, `hr-retention-purge`, `integration-token-refresh`, `portal-document-extraction-worker`, `public-assistant-index-worker` | `docs/SUPABASE.md:22,52-55,103-109`; `cron.schedule(...)` grep across migrations |
| Provider | Postmark through `_shared/notification/delivery.ts` (adapter, test-only mock, dispatcher); sending only when `EF_NOTIFICATION_EMAIL_ENABLED=true` | `docs/SUPABASE.md:55,79-80` |
| Preferences | `notification_preferences(auth_user_id, event, email_enabled)` via `portal_set_notification_preference` | `supabase/migrations/20261026180000_...:249-256` |

Assessment events (published, due soon, overdue, submitted, marked, reassessment, outcome) ride this outbox: an `asm_notifications` in-app table per user plus `notification_deliveries` rows with a new nullable `assessment_event_id`, the subject check re-created to allow it, exactly as bookings did (DECISIONS.md D-11). "Due soon" / "overdue" need a scheduled sweep; the existing per-minute cron pattern (a SQL function that enqueues, the worker that sends) is reused rather than a new function.

Classification: **Implemented**.

## K15. Audit and reporting

| Area | Finding | Evidence |
|---|---|---|
| Audit tables | `cms_activity_log` (CMS), `cms_revisions`, `portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, application_id, detail jsonb)` written by `portal_log_admin_access` / `portal_log_agency_change`, `tenant_access_audit`, `status_config_audit`, `hr.staff_audit`, `hr.sign_events`, `integration_webhook_events`, `admission_event_outbox` | `supabase/migrations/0001_cms_schema.sql`; `supabase/migrations/0006_agency_portal.sql:284-298`; `supabase/migrations/20261028130000_admin_access_audit.sql`; `supabase/migrations/20261028140000_agency_change_audit.sql`; `supabase/migrations/20261024175010_...:9` |
| Audit UI | CMS Activity page; portal Audit log (`src/pages/agency/audit-log/page.tsx` reads `portal_audit_log`); Notification log page | directory listing; grep |
| Reporting | Per-domain lists and CSV exports (students, applications, HRMS Xero export); no reporting engine, no cohort / outcome reports | `src/pages/admin/*` |
| Tests | 14 pgTAP suites in `supabase/tests` (authorization red / positive, storage policy, fencing, identity, HRMS, staff registration, assistant, extraction); script tests `scripts/test-*.ts/.mjs` (npm `test:*`); Playwright `e2e/*.spec.ts` (`hrms`, `regression`, `staff-admin`, `staff-registration`, `staff-security`) | `ls supabase/tests`; `package.json` scripts; `e2e/` |

The assessment audit log is a new append-only table (`asm_audit_log`) in the `portal_audit_log` shape (actor, role, action, target, detail jsonb) written only by the `asm_*` RPCs; immutable history views read it together with the append-only attempt tables.

Classification: **Partial** (audit per domain Implemented; reporting Missing for assessments).

The long-form module K-D follows (headings demoted one level).


---

## Module K-D. D. Skyline ERP: Courses, Units, Intakes, Batches, Trainers, Students, Timetable (read-only audit, 2026-11-13)

Scope: repo `C:\Users\goura\Desktop\Skyline-Website` (React 19 / Vite / TS on Supabase). All paths are relative to the repo root. Line numbers are from the files as read today; migrations 1-90 and everything up to `20261113420000` are stated as APPLIED on hosted in `CLAUDE.md` (not verified here; see section 11).

Key helpers referenced throughout:

| Helper | Defined | What it checks |
|---|---|---|
| `public.cms_is_staff()` | `supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:52-54` | `auth.uid()` has an Active `cms_users` row (`auth_user_id`) without `must_change_password` |
| `public.cms_is_admin()` | `supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:55-57` | same, plus `role = 'Admin'` |
| `public.cms_is_rto_manager()` | `supabase/migrations/20261113340000_course_management.sql:11-16` | same as staff, plus `cms_users.rto_manager` |
| `public.tenant_scope(uuid)` | `supabase/migrations/20261025052725_enforce_total_tenant_scope.sql:3-8` | null tenant = legacy scope (no request domain, caller has no tenant membership); else the verified `tenant_current()` |
| `public.tenant_has_role(uuid, text[])` | `supabase/migrations/20261024175010_tenant_registry_and_verified_resolution.sql:23` (re-defined `20261026160000...:158`) | membership role on the tenant |
| `public.portal_is_slit_admin()` | `supabase/migrations/20261024174609_enforce_admin_identity_and_rotation.sql:60-62` | alias of `cms_is_admin()` |
| `public.portal_student_id()` | `supabase/migrations/20261104270000_student_portal_login.sql:48-55` | the signed-in student's `enrollment_students.id` via `agency_memberships.role = 'student'` |

---

### 1. COURSES: Master Data course vs website catalogue

#### 1.1 One record, two editors

There is **one** course table, `public.cms_courses`. "Master Data › Courses" (facts, units, fees, intakes, batches) and the website editor (overview, requirements, media, publishing) both edit the same row; there is no separate "course catalogue" table for the website. The national catalogue (`australian_course_catalogue`) is a lookup that can create/link a `cms_courses` row.

| Aspect | Where | Notes |
|---|---|---|
| Table definition (original) | `supabase/migrations/0001_cms_schema.sql:46-67` | `id text PK`, `slug text unique`, `code`, `cricos`, `name`, `category`, `training_package`, `duration`, `mode`, `short_description`, `full_description`, `entry_requirements`, `career`, `fees` (legacy text), `image`, `status` (`Published`/`Draft`), `display_order`, `featured`, `updated_at`, `updated_by text` |
| Tenant column | `supabase/migrations/20261024180429_tenant_resource_policies_and_worker_boundaries.sql:44-45` | `tenant_id uuid references tenants(id)` (nullable; the SLIT site runs with `tenant_id IS NULL` = legacy scope); unique `(id, tenant_id)` at `:430` |
| Course-management columns | `supabase/migrations/20261113340000_course_management.sql:19-30` | `tga_url`, `campus`, `is_active`, `show_fees`, `fee_note`, `seo_title`, `seo_description`, `homepage_carousel` (mirrors `featured`) |
| Variant | `supabase/migrations/20261113350000_course_management_followups.sql:72` | `variant_label` (e.g. "52 Weeks"); label helpers `course_label` / `course_name_variant` at `supabase/migrations/20261113360000_course_labels.sql:14-27` |
| Website child tables | `supabase/migrations/0001_cms_schema.sql:69-91` | `cms_course_sections`, `cms_course_attachments`, `cms_course_links` (FK `course_id -> cms_courses on delete cascade`) |

#### 1.2 RLS on `cms_courses`

| Policy | File | Rule |
|---|---|---|
| `cms_courses_read` | `supabase/migrations/0002_cms_rls_policies.sql:57` | `status = 'Published' or cms_is_staff()` |
| `cms_courses_write` | `supabase/migrations/0002_cms_rls_policies.sql:58` | `cms_is_staff()` (any CMS user, incl. Editor) |
| `tenant_boundary_*` (restrictive) | `supabase/migrations/20261024180429_...:285-288` | `tenant_scope(tenant_id)` / `tenant_scope_write(tenant_id)` |
| `tenant_member_*` | `supabase/migrations/20261024180429_...:289-292` | `tenant_has_role(tenant_id, [...])` for a tenant-scoped site |
| `tenant_bind` trigger | `supabase/migrations/20261024180429_...:284` | binds `tenant_id` on insert/update |

Role split inside the application layer (not RLS): `rto_admin('course_save')` requires `cms_is_rto_manager()` (`supabase/migrations/20261113350000_course_management_followups.sql:212-215`); `website_save` is open to any CMS user (`supabase/migrations/20261113340000_course_management.sql:347-359`). Because the `cms_courses_write` policy still allows any staff member to write the row directly, the RTO-Manager restriction is enforced only through the RPC and the CMS UI, not by RLS (finding).

#### 1.3 Slug linkage and `letter_course_by_slug`

There is **no function named `letter_course_by_slug`**. The migration `supabase/migrations/20261113290000_letter_course_by_slug.sql` defines `public.letter_course_id(p_course, p_code)` (`:7-14`): resolves an application's `enrollment_application_courses.course_id` by id, then by slug, then by unique code, because applications made from the public course pages store the **slug** in `course_id` (comment at `:1-4`, example `SLIT-2026-0080`).

Related slug lookups:

| Function | File | Accepts |
|---|---|---|
| `course_intake_open_for(uuid, text)` | `supabase/migrations/20261113200000_course_intakes.sql:62-66` | course id **or** slug |
| `course_intakes_open(text)` | `supabase/migrations/20261113390000_course_flow.sql:121-132` | id or slug (+ 12-month fallback when the course has no intakes) |
| `public_course_facts(slug, tenant)` | `supabase/migrations/20261113340000_course_management.sql:568-582` (re-defined `...370000:73`) | slug + tenant, anon-callable; Published + `is_active` only |
| `rto_student_on_course(uuid, text)` | `supabase/migrations/20261113340000_course_management.sql:294-298` | **id only** (`ac.course_id = p_course`) |

Finding: `rto_student_on_course` compares `enrollment_application_courses.course_id` to `cms_courses.id` only. An application whose course row stores the slug (public Enrol Now path) is not recognised as "on the course", so an Admin cannot enrol that student into a batch (RTO Managers can, via direct enrolment). Needs runtime confirmation on hosted data.

#### 1.4 National catalogue (training.gov.au)

| Item | Where |
|---|---|
| Table `australian_course_catalogue` | `supabase/migrations/20261102105121_create_australian_course_catalogue.sql:1-27` (`course_code` unique, `course_type`, `aqf_level`, `training_package_*`, `national_status`, `total_units`, `core_units_count`, `elective_units_count`, `is_active`); later columns `cms_course_id`, `website_enabled`, `admissions_enabled`, `domestic_enabled`, `international_enabled` (used at `supabase/migrations/20261102120000_...:349-352`) |
| `activate_australian_course(...)` | `supabase/migrations/20261102120000_australian_course_catalogue_national_sync.sql:304-360`: links an existing `cms_courses` row by code or creates a Draft one (`id = 'course-<epoch ms>'`, slug from code+name) |
| Frontend | `src/pages/admin/lib/courseCatalogue.ts:5-22` (row shape), `:54-67` (`search_australian_course_catalogue`), `:88-109` (activation); UI `src/pages/admin/components/CourseCatalogue.tsx` (autocomplete + Activate modal used by `src/pages/admin/CoursesPage.tsx:23`) |

The catalogue does not carry units of competency per course (only counts).

#### 1.5 Frontend pages

| Page / component | Route | Reads / writes |
|---|---|---|
| `src/pages/admin/CourseFeesPage.tsx` (Master Data › Courses; views `courses` / `intakes` / `rooms`, `:11-30`) | `/admin/course-fees` (`src/router/config.tsx:255`) | `rto_admin('course_list')` |
| `src/pages/admin/CourseWizardPage.tsx` (steps `details`, `timetable`, `fees`, `intakes`, `website`, `:13-19`) | `/admin/courses/:id/:step` (`src/router/config.tsx:259`); old `/admin/course-fees/:id?tab=` redirects (`CourseWizardPage.tsx:123-128`) | `rto_admin('course_get' / 'course_save' / 'units_save' / 'fees_save' / 'website_save')` (`:50`, `:106-110`) |
| `src/pages/admin/components/rto/CourseSteps.tsx` | — | `CourseFacts` (`:15-51`), `TimetablePreview` (`:54-75`), `UnitsTab` (`:91-164`), `WebsiteTab` (`:167-224`) |
| `src/pages/admin/CoursesPage.tsx` (website list) | `/admin/courses` (`src/router/config.tsx:204`) | CMS store snapshot (`cms_admin_snapshot`, `src/pages/admin/lib/db.ts:433`); row opens `/admin/courses/:slug` (`CoursesPage.tsx:31`) |
| `src/pages/admin/CourseEditorPage.tsx` (website content: Overview, Requirements & Career, Media & Files, Facts (read-only), Publishing, `:16-22`) | `/admin/courses/:slug` (`src/router/config.tsx:205`) | CMS draft store + `cms_commit`; facts link back to the wizard (`:79`, `:261-264`) |
| Public site | `/our-courses`, `/courses/:slug` (`src/router/config.tsx:118-119`) | `cms_public_snapshot` rows (`src/lib/publicData.ts:483-509`) + `public_course_facts` for fees/intakes (`src/components/feature/CourseFeesIntakes.tsx:18`, `src/pages/course-detail/page.tsx:38`) |

Authoritative source: `cms_courses` row. The website reads the published snapshot; fee and intake facts come live from `public_course_facts`.

---

### 2. UNITS OF COMPETENCY

| Aspect | Where | Detail |
|---|---|---|
| Table `cms_course_units` | `supabase/migrations/0005_cms_issue_fixes.sql:9-16` | `id text PK` (`'unit-' || uuid`, `supabase/migrations/20261113340000_...:375`), `course_id text` (no FK in the original; tenant-parent FK `(course_id, tenant_id) -> cms_courses(id, tenant_id)` at `supabase/migrations/20261024180429_...:431`), `code`, `name`, `category` ('Core'/'Elective' text), `sort` |
| Tenant column | `supabase/migrations/20261024180429_...:4` (`tenant_id`), bind trigger `:125`, restrictive read policy `:126` |
| Course-management columns | `supabase/migrations/20261113340000_course_management.sql:33-38` | `unit_type` (`core`/`elective`), `default_weeks` (1-104 int), `nominal_hours` (0-5000), `is_active` |
| Half-week duration | `supabase/migrations/20261113400000_timetable_import.sql:78-92` | `duration_weeks numeric(5,1)` (0.5-104); trigger `course_unit_weeks_sync` keeps `default_weeks = ceil(duration_weeks)` |
| RLS | `supabase/migrations/0005_cms_issue_fixes.sql:22-35` | read: staff or the course is Published; write: `cms_is_staff()` |
| Save path | `rto_admin('units_save')` `supabase/migrations/20261113340000_...:361-387` | upsert by id; a removed unit used by an `intake_units` row is deactivated instead of deleted (`:384-386`) |
| UI | `src/pages/admin/components/rto/CourseSteps.tsx:91-164` (`UnitsTab`: Code, Name, Type, Weeks, Hours, Active; drag order; bulk weeks) | plus `TimetablePreview` (`:54-75`) |
| Website | `src/pages/course-detail/page.tsx:32` prints Code / Unit / Type from the snapshot's `cms_course_units` |
| Import | `supabase/migrations/20261113400000_timetable_import.sql:455-460` onwards: per course, `sort`, `duration_weeks`, `nominal_hours` from the SLIT master timetable |

Relation to the delivery chain: `intake_units.unit_id -> cms_course_units(id) on delete restrict` (`supabase/migrations/20261113340000_...:126`); `batch_unit_overrides.intake_unit_id -> intake_units` (`supabase/migrations/20261113390000_course_flow.sql:10-18`).

**Elements / performance criteria / knowledge evidence / assessment conditions: none.** No column, table or UI field exists for them (grep across `supabase/migrations` and `src` for `assessment`, `element`, `criteria` finds only `batch_sessions.session_type = 'assessment'` and the placeholder on the batch page). `StudiesPanel` (`src/pages/admin/components/rto/StudiesPanel.tsx`) is the student's enrolments list, not a unit/assessment view.

---

### 3. FEES and fee line items (brief)

| Object | Where | Notes |
|---|---|---|
| `course_fee_items` | `supabase/migrations/20261113340000_course_management.sql:64-75` | `course_id -> cms_courses`, `intake_id -> course_intakes` (null = course scope; an intake with items overrides the course), `item_type`, `label`, `amount_cents`, `sort`; `included_in_total` (`...350000:6`), `refundable`, `gst_treatment` (`...370000:10-12`); type list widened to `application, registration, enrolment, material, tuition, other, oshc, initial_deposit` (`...370000:7-9`) |
| Defaults trigger | `supabase/migrations/20261113370000_fee_letter_alignment.sql:21-28` | deposit and OSHC excluded from total; application/registration non-refundable |
| `course_fee_total_cents(course, intake)` | first `...340000:198-203`; current rule `...350000:27` + GST-aware scope total `...370000:48-52` | sum of included items (GST-exclusive lines +10%); intake items replace course items |
| `course_fee_gst_cents` | `supabase/migrations/20261113370000_fee_letter_alignment.sql:59-63` | |
| `course_fee_type_rank` | `supabase/migrations/20261113370000_fee_letter_alignment.sql:32-36` | letter order |
| Legacy `course_fee_setups` | `supabase/migrations/20261113270000_offer_letter_templates.sql:62-81` (`tenant_id`, `course_id`, `intake_id`, tuition/enrolment/material/oshc/deposit, `total_fee` added `...20261112172731:2`) | kept in sync by trigger `course_fee_items_sync` (`...340000:95-120`); offer letters read it |
| `letter_other_fees` | `supabase/migrations/20261113370000_fee_letter_alignment.sql:90-105` | Settings › Other fees and charges |
| RLS | `course_fee_items`: staff read / RTO write (`...340000:183-193`); `course_fee_setups`: no policies, security-definer only (`...270000:79-80`) |
| Frontend rule | `src/pages/admin/lib/rto.ts:5-22`, `:106-113` (`feeTotal`, `feeGst`, `depositOf`); editor `FeesEditor` in `src/pages/admin/components/rto/shared.tsx:52` |

---

### 4. INTAKES

#### 4.1 Table `course_intakes`

| Column | Source |
|---|---|
| `id uuid`, `course_id text -> cms_courses on delete cascade`, `start_date`, `end_date`, `label`, `is_active`, `created_at`, `updated_at`, `updated_by`; unique `(course_id, start_date)` | `supabase/migrations/20261113200000_course_intakes.sql:17-30` |
| `name`, `campus`, `capacity`, `status` (`draft`/`open`/`full`/`closed`); trigger `course_intake_status_sync` keeps `is_active = (status = 'open')` | `supabase/migrations/20261113340000_course_management.sql:41-61` |
| No `tenant_id` (tenant follows the course) | — |

RLS: `course_intakes_read` for authenticated = `is_active and exists(cms_courses ...)` (`supabase/migrations/20261113200000_...:37-38`); no write policy, all writes via `course_intakes_admin` (`:78-119`, staff) and `rto_admin` (RTO Manager).

#### 4.2 Functions

| Function | File | Role |
|---|---|---|
| `course_intake_name/display/json`, `course_intake_today()` (Melbourne) | `supabase/migrations/20261113200000_course_intakes.sql:41-59`; display re-defined `...390000:113-117` ("Mon YYYY (start – end) · campus") | labels |
| `course_intakes_open(course)` | `...200000:69-75`, final `...390000:121-132` | enrolment dropdown; fallback months only when the course has no intakes |
| `course_intakes_admin(action, course, id, data)` | `...200000:78-119` | legacy INT-01 staff screen; still used by `src/pages/admin/lib/courseIntakes.ts:12-20` (only imported by `src/pages/admin/components/CourseFees.tsx:4`, which itself is no longer imported: **unused**) |
| `intake_auto_name` | `...340000:205-209`, `...360000:28` | "CODE Mon YYYY – Mon YYYY" |
| `intake_generate_schedule(intake, start[, units, end])` | `...340000:225-243`; 4-arg form `...350000:148` / `...400000:139-...` | lays `intake_units` over working days (`rto_is_working_day`, `...400000:70-75`: Mon-Fri, not a confirmed `hr.public_holidays`, not in `academic_breaks`); core units always, electives chosen; "fit to end date" |
| `rto_intake_json` | `...340000:260-273`, final `...410000:113-132` | card JSON incl. `enrolled`, `batches`, `trainers`, `hours`, `batchList` |
| `rto_admin` actions `intake_list`, `intake_get`, `intake_save` (generate/unitIds/fitEnd), `schedule_save`, `intake_delete`, `intake_fees_save` | `...350000:310-373`, `:324-349` | RTO Manager |
| `rto_course_flow('intake_duplicate')` | `...390000:54-81`, final `...410000:151-180` | copy at a new start date: unit dates shift, batches + trainers + sessions + overrides copied, no students, draft |
| `application_course_intake_check` trigger | `...200000:125-138` | refuses an intake not open for the course on `enrollment_application_courses` |

#### 4.3 UI

| Component | File | Notes |
|---|---|---|
| `IntakesStep` (wizard step) | `src/pages/admin/components/rto/IntakesStep.tsx:1-12` | renders `IntakesView` |
| `IntakeCards` / `IntakesView` | `src/pages/admin/components/rto/IntakeCards.tsx:1-20` | cards; status picker; Duplicate / Delete; opens sheet at `#<intake id>` |
| `IntakeSheet` | `src/pages/admin/components/rto/IntakeSheet.tsx:17-18` tabs Overview · Timeline · Batches · Students; Timeline uses `schedule_save` and regenerate via `intake_save` (`:100-107`); Batches cards (`:236-250`); Students per-batch columns with drag-move (`:277-322`) |
| `NewIntakeDrawer` | `src/pages/admin/components/rto/NewIntakeDrawer.tsx:11-18` suggests the next term start from `academic_breaks`; creates with `intake_save {status:'draft', generate:true}` (`:54-62`) |
| `SchedulePanel` (timeline) | `src/pages/admin/components/rto/SchedulePanel.tsx:1-4`, `:17-27` | Gantt of `intake_units`, holidays from `listHolidays` (`src/lib/hrmsApi`), breaks from `academic_breaks` |
| `IntakesPage` | `src/pages/admin/IntakesPage.tsx:10-25` (`intake_list`, `course_list`); route `/admin/intakes` (`src/router/config.tsx:260`), embedded in Courses › Intakes |
| `IntakeDetailPage` | `src/pages/admin/IntakeDetailPage.tsx:4-7` redirect to `/admin/course-fees?view=intakes#id` |

#### 4.4 Who reads intakes for enrolment

| Reader | File |
|---|---|
| Portal / public application form | `src/pages/agency/lib/intakes.ts:14-27` (`course_intakes_open`), `src/pages/agency/components/IntakeSelect.tsx:1-13` |
| Draft save | `portal_save_draft_v2` writes `enrollment_application_courses.intake_id` (`supabase/migrations/20261113200000_course_intakes.sql:141-185`) |
| Public course page | `public_course_facts` (`supabase/migrations/20261113340000_...:575-576`) |
| Offer letter | `application_letter_values` reads `course_intakes` and `course_fee_setups` (`supabase/migrations/20261113290000_letter_course_by_slug.sql:30-40`) |
| Signing variables | `hr.sign_subject` (`supabase/migrations/20261113200000_course_intakes.sql:212-217`) |

---

### 5. BATCHES

#### 5.1 Tables

| Table | Definition | Columns |
|---|---|---|
| `batches` | `supabase/migrations/20261113340000_course_management.sql:144-156` | `id`, `intake_id -> course_intakes cascade`, `name` (unique per intake; auto `G1, G2 ...` at `...410000:225`), `classroom_id -> classrooms set null`, `class_days text[]`, `start_time`, `end_time`, `capacity`, `is_active`, `created_at`. No `course_id` (via intake), no trainer column, no `tenant_id` |
| `batch_trainers` | `...340000:158-162` | `(batch_id -> batches, staff_id -> hr.staff_profiles)` PK; many-to-many |
| `batch_enrolments` | `...340000:164-174` | `id`, `batch_id`, `student_id -> enrollment_students cascade`, `enrolment_type` (`CoE`/`VoE`/`Domestic`), `status` (`active`/`deferred`/`withdrawn`/`completed`), `enrolled_on`, `created_by`; unique `(batch_id, student_id)`. **No `application_id`, no `intake_id`, no `course_id`** |
| `batch_unit_overrides` | `supabase/migrations/20261113390000_course_flow.sql:10-18` | `(batch_id, intake_unit_id)` PK, `start_date`, `end_date` |
| `batch_sessions` | `supabase/migrations/20261113400000_timetable_import.sql:95-107` | weekly recurring class: `weekday 1-7`, `slot`, `start_time`, `end_time`, `session_type` (`theory`/`practical`/`assessment`), `room_id -> classrooms`, `sort` |
| `classrooms` | `...340000:135-142`; `location_id`, `sort` added `...400000:16-17` | rooms |

RLS for all six COURSE-MGMT tables: `<t>_staff_read` (`cms_is_staff()`) and `<t>_rto_write` (`cms_is_rto_manager()`), `supabase/migrations/20261113340000_...:183-193`; `batch_enrolments_admin_write` (`cms_is_admin()`) at `:194-195`; `batch_unit_overrides` at `...390000:19-24`; `batch_sessions`/`locations`/`academic_breaks`/`course_timing_templates` at `...400000:123-134`.

#### 5.2 Server actions

| Action | Function | Rule |
|---|---|---|
| `batch_save` / `batch_delete` (legacy fields) | `rto_admin`, `...350000:374-403` | RTO Manager; delete refused while active/deferred/completed enrolments exist (`...340000:493-495`) |
| `batch_setup` (name, capacity, active, `trainerIds`, `sessions[]`) | `rto_course_flow`, `supabase/migrations/20261113410000_batch_timing_rooms.sql:218-255` | RTO Manager; rewrites `batch_sessions`, then `rto_batch_sync_legacy` (`:64-74`) copies days/times/room to the legacy columns; returns clashes |
| `batch_trainers_set` | `...410000:289-294` | RTO Manager |
| `batch_override_set` / `batch_override_reset` | `...390000:83-103`, `...410000:182-202` | per-unit batch dates; same dates as the intake = no row |
| `enrol` (students[] → batch) | `rto_admin`, `...350000:405-422` | Admin or RTO Manager; student must have an application for the course (`rto_student_on_course`) unless RTO Manager, who gets `rto_direct_application` (`...350000:185-202`: draft application, `source = 'direct enrolment'`); capacity check after insert |
| `unenrol` | `...350000:424-427` | sets `withdrawn` |
| `student_move` (same intake only) / `enrolment_set` (active/withdrawn) | `...410000:296-324` | Admin or RTO Manager |
| `session_add` / `session_delete` | `...410000:257-276` | rooms board |
| `batch_get` | `...410000:278-287` | batch + intake + siblings + clashes + caller roles |
| `rto_batch_json` | `...410000:92-110` | `trainers[]`, `students[]`, `schedule[]` (intake dates or override), `sessions[]`, `startDate`/`endDate` from `rto_batch_span` (`:22-29`) |

Constraints: `batches` check `end_time > start_time`, `class_days <@ {Mon..Sun}`, unique `(intake_id, name)`; `batch_sessions` check `end_time > start_time`; clash check is a warning only (`rto_session_clashes`, `...410000:43-61`).

#### 5.3 UI

| Component | File | Notes |
|---|---|---|
| `BatchPage` | `src/pages/admin/BatchPage.tsx` (route `/admin/batches/:id`, `src/router/config.tsx:263`) | sections 1 Class timing (`:95-112`), 2 Trainers (`:114-118`, `TrainersEditor` `:209-233` uses `rto_admin('staff_list')`), 3 Units with per-batch date overrides (`:120-143`), 4 Students: add / move / remove (`:145-172`), 5 **Assessments & Results placeholder** (`:174-176`) |
| `BatchTimingDrawer` | `src/pages/admin/components/rto/BatchTimingDrawer.tsx:1-3`, `:20-50` | week strip, slots, room by location, "Use course timetable" (`timing_list` → `course_timing_templates`), "Copy timing from G1", live clash check |
| `StudentPicker` | `src/pages/admin/components/rto/StudentPicker.tsx:12-13`, `:28-35` (`student_search`), `:44-53` (`enrol`), `:103` ("also show students who have not applied" for RTO Managers) |
| `StudiesPanel` (student side) | `src/pages/admin/components/rto/StudiesPanel.tsx:19-34` (`student_studies`, `enrol`) | Course → Intake → Batch → type |
| Rooms | `src/pages/admin/ClassroomsPage.tsx:8-16` (`RoomsManager`, `locations_rooms` / `room_save`), `src/pages/admin/components/rto/RoomsBoard.tsx:16-30` (`rooms_board`) |

---

### 6. TRAINER IDENTIFICATION

| Question | Answer | Evidence |
|---|---|---|
| What is a trainer row? | A row of `hr.staff_profiles` (HRMS identity). There is no `employees`/`staff`/`trainers` table in `public`. | `supabase/migrations/20261105180000_hr_staff_schema.sql:38-63`: `id`, `auth_user_id uuid not null unique -> auth.users(id)`, names, `email` (unique), `phone_e164` (unique), address, emergency contact, `status` (`draft`/`submitted`/`preboarding`/`active`/`rejected`/`inactive`) |
| Role flag | `hr.staff_roles(profile_id, role in ('admin','trainer'), granted_by, revoked_at)`; one live role per person | `supabase/migrations/20261105180000_hr_staff_schema.sql:98-108`; requested role on `hr.staff_applications.requested_role` (`:65-76`) |
| Job title / employment | `hr.employment(profile_id PK, department, job_title, employment_type, joining_date, manager_id, work_location)` | `supabase/migrations/20261109153953_skyline_master_data_hr.sql:47-58` |
| Batch link | `batch_trainers.staff_id -> hr.staff_profiles(id)` (not `auth.users`, not `cms_users`, not `hr.employment`) | `supabase/migrations/20261113340000_course_management.sql:158-162` |
| Which staff are offered as trainers | `rto_admin('staff_list')` = every `hr.staff_profiles` with `status = 'active'`; **no filter on `hr.staff_roles.role = 'trainer'`** | `supabase/migrations/20261113350000_course_management_followups.sql:442-444` |
| Timetable import trainer names | `course_timing_templates.trainer_name` text + optional `trainer_staff_id -> hr.staff_profiles` (linked only when exactly one profile has the name) | `supabase/migrations/20261113400000_timetable_import.sql:110-120`, `:455-460` |
| How a trainer signs in | Supabase Auth user (`auth.users`) → `hr.staff_profiles.auth_user_id`. `/login` resolves access with `hr_staff_access()` (returns the profile status) and sends an active staff member to `/staff` unless they also hold a CMS login | `supabase/migrations/20261105190000_hr_staff_rpcs.sql:85-90`; `src/lib/staffApi.ts:94-114` (`hr_staff_claim_account`, `hr_staff_me`, `hr_staff_access`); `src/lib/loginRouting.ts:10-13`, `:55-62`, `:64-86` |
| Staff workspace | `src/pages/staff/StaffHomePage.tsx` (route `/staff`, `src/router/config.tsx:158`; `ROLE_LABEL` admin/trainer at `:28`): profile, documents, timesheet, leave, holidays. **No batches, classes or calendar for the trainer.** | grep of `src/pages/staff` for `batch`/`timetable` finds nothing |
| CMS login for staff | Only an approved `admin` role gets a `cms_users` row (`supabase/migrations/20261105190000_hr_staff_rpcs.sql:8`); a trainer has no CMS access | |

So the auth chain for a trainer is `auth.users.id = hr.staff_profiles.auth_user_id`, and `batch_trainers.staff_id = hr.staff_profiles.id`. A "my batches" query for a signed-in trainer would be `batch_trainers join hr.staff_profiles on auth_user_id = auth.uid()` — no such function or page exists today.

---

### 7. STUDENTS and ENROLMENTS

#### 7.1 Student tables

| Table | Definition | Role |
|---|---|---|
| `enrollment_students` (the CRM student) | `supabase/migrations/20261102094611_normalize_business_agent_student_relationships.sql:135-160` | `id`, `agency_id -> agencies` (business), `tenant_id -> tenants`, `student_profile_id -> student_profiles` (nullable), `full_name`, `email`, `phone`, `date_of_birth`, `created_by -> portal_profiles`; composite FK `(agency_id, tenant_id) -> agency_tenants`. Later: `agent_id -> agents`, `passport_number`, `nationality` (`supabase/migrations/20261104090000_one_business_agent_student_chain.sql:92-96`); `details jsonb`, `qualifications jsonb` (`supabase/migrations/20261104120000_student_details_on_student.sql:18-20`); `status Active/Inactive` (`supabase/migrations/20261104210000_student_status.sql:7-10`); unique email / phone (`supabase/migrations/20261104150000_student_unique_by_email_and_mobile.sql:15-17`) |
| `student_profiles` | **not created by any repo migration** (only referenced: `...20261102094611:139`, `...20261112035802:14`) | "self-service login profile" per the comment at `...20261102094611:185`; Needs runtime access to confirm its hosted definition |
| `portal_profiles` | `supabase/migrations/0006_agency_portal.sql:136-146` | `auth_user_id unique`; the portal login identity (agents, agency admins, students) |
| `agency_memberships` | `supabase/migrations/0006_agency_portal.sql:148-157`; `role` extended to `student` + `student_id -> enrollment_students` (one login per student) `supabase/migrations/20261104270000_student_portal_login.sql:33-39` | links a portal profile to a business and (for students) to the student record |
| `agents` | `supabase/migrations/20261104090000_one_business_agent_student_chain.sql:50-66` | `business_id`, `profile_id -> portal_profiles`, `role agent/agency_admin` |
| `student_office365_accounts` | `supabase/migrations/20261111143429_student_office365_accounts.sql:4-17` | `student_id PK -> enrollment_students`, `upn`, `ms_user_id`, `status`; a mailbox record, **not** a login identity for the ERP |

RLS on `enrollment_students`: `tenant_scope(tenant_id)` and (SLIT admin | same-agency creator | agency admin | application access) at `...20261102094611:162-184`; self-read for a signed-in student `...20261104270000:60-61`.

#### 7.2 CMS student pages

| Page / component | File | Data |
|---|---|---|
| `StudentsPage` | `src/pages/admin/StudentsPage.tsx:6-9` (route `/admin/students`, `src/router/config.tsx:241`) | `StudentsTable` + `AddStudentDialog` |
| `StudentsTable` | `src/pages/admin/components/StudentsTable.tsx:36-41` | `admin_students_list` (`supabase/migrations/20261104250000_inactive_business_last.sql:50`) via `src/pages/admin/lib/businessData.ts:161`; student status, login state, applications per status |
| `AddStudentDialog` | `src/pages/admin/components/AddStudentDialog.tsx:14-18` | business → agent → student (`portal_student_save`, `supabase/migrations/20261113230000_find_student_by_email.sql:56-108`); email uniqueness error mapping `:26-27` |
| `AddStudentRecordDialog` | `src/pages/admin/components/AddStudentRecordDialog.tsx:21-25` | creates a business or an agent inline |
| `StudentDetailPage` | `src/pages/admin/StudentDetailPage.tsx:9-16`, `:100-103` (route `/admin/students/:id`) | applications list, details, login invite (`sendStudentInvitation`), `StudiesPanel`, Office 365 panel, signing panel |

#### 7.3 Enrolment data model

There are two different "enrolments":

| Concept | Table | Link to course / intake | Status |
|---|---|---|---|
| Admission application | `enrollment_applications` (`supabase/migrations/0006_agency_portal.sql:159-182`; `student_id` `...20261102094611:158-160`; `tenant_id` `...20261024180429:10`; `source` `...20261113350000:182`) + `enrollment_application_courses` (`0006:184-193`; `intake_id -> course_intakes restrict` `...20261113200000:122`) | course by `course_id` (id **or slug**), `course_code`, `course_title`, `variant`; chosen intake | workflow in `application_statuses` (`supabase/migrations/20261113260000_application_status_workflow.sql:1-20`): draft → submitted → offer_issued → offer_accepted → coe_issued → **enrolled** |
| Batch enrolment (delivery) | `batch_enrolments` (`supabase/migrations/20261113340000_course_management.sql:164-174`) | batch → intake → course; **no FK to the application** | `active`/`deferred`/`withdrawn`/`completed`, `enrolment_type` CoE/VoE/Domestic |

Application → batch flow: nothing automatic. Staff enrol via `rto_admin('enrol')` from the batch page, the intake sheet or the student's Studies panel; the only coupling is the eligibility check `rto_student_on_course` (has an application row for the course) or, for RTO Managers, the automatic draft application `rto_direct_application` (`...20261113350000:185-202`). Setting an application to `enrolled` does not create a batch enrolment, and a batch enrolment does not move the application status (grep `batch_enrolments` in `...260000`, `...330000`: no references). Finding: the two are reconciled only by convention.

#### 7.4 Student login identity

| Step | Where |
|---|---|
| Invite a student (role `student`, `student_id`) | `agency_invitations` columns `supabase/migrations/20261104270000_student_portal_login.sql:41-44`; `StudentDetailPage.tsx:33-43` (`sendStudentInvitation`) |
| Accepting creates `portal_profiles` + `agency_memberships(role='student', student_id)` | `...20261104270000:1-12` (header), `:193-201` |
| Resolving the signed-in student | `portal_student_id()` `...20261104270000:48-55`; `portal_identity()` returns role `student` `:64-80` |
| Google sign-in for students | `supabase/migrations/20261105100000_google_student_needs_only_mobile.sql:16-18`, `:70-72` |
| Login routing | `src/lib/loginRouting.ts:55-62` (`portal` destination), `DESTINATION_PATH.portal = '/agency'` (`:11`) |
| `find_student_by_email(p_email)` | `supabase/migrations/20261113230000_find_student_by_email.sql:12-52`: `free` / `student {id, full_name}` / `taken` for the "student email" step (local only, NOT applied hosted per CLAUDE.md) |

The student portal (`src/pages/agency/*`) shows applications only; there is no page for batches, units, timetable or results (grep `batch`/`studies`/`timetable` in `src/pages/agency` matches only `IntakeSelect.tsx` and `ApplicationWorkspace.tsx`).

#### 7.5 "Email unique within a role"

| Migration | Rule |
|---|---|
| `supabase/migrations/20261112035802_one_email_one_identity.sql:1-30`, triggers `:75-81` | first stage: one email = one person across staff / agent / student (`identity_email_conflict`, `identity_email_guard` on `cms_users`, `hr.staff_profiles`, `agents`, `enrollment_students`, `student_profiles`, `agency_invitations`, `enrollment_applications.student_email`) |
| `supabase/migrations/20261112035822_one_email_one_identity_fix_field_access.sql` | field-access fix |
| `supabase/migrations/20261112042544_email_unique_per_role.sql:1-45` | **current rule**: unique within a role (staff table-wise; one agent record overall; one student record), a person may be student + staff + agent with the same email |
| `supabase/migrations/20261112042642_portal_invite_single_login_role.sql:1-20` | a portal login holds one role; an invite may not flip an active agent login into a student login |
| `supabase/migrations/20261112080818_portal_signup_intent_check.sql:1-15` | sign-up page intent check after Google sign-in |
| `supabase/migrations/20261113230000_find_student_by_email.sql` | the lookup used by the CMS "New application" / portal "Start application" email step; `portal_student_save` returns hint `email_taken` (`:90-91`, `:101-107`) |

Implication for a "trainer who is also a student" or "staff portal login": the same `auth.users` row can carry an `hr.staff_profiles` and a `portal_profiles` (`hr_staff_start` attaches to the same login, `supabase/migrations/20261105190000_hr_staff_rpcs.sql:92-96`), and `loginRouting.ts:64-86` offers a choice of destinations.

---

### 8. TIMETABLE / CALENDAR

#### 8.1 Tables that carry dates and times

| Table | Definition | Grain | Row shape |
|---|---|---|---|
| `course_intakes` | `supabase/migrations/20261113200000_course_intakes.sql:17-30` | one run of a course | `start_date`, `end_date`, `status` |
| `intake_units` | `supabase/migrations/20261113340000_course_management.sql:123-133` | one unit inside an intake | `intake_id`, `unit_id`, `start_date`, `end_date`, `hours`, `sort` |
| `batch_unit_overrides` | `supabase/migrations/20261113390000_course_flow.sql:10-18` | per-batch unit dates | `batch_id`, `intake_unit_id`, `start_date`, `end_date` |
| `batch_sessions` | `supabase/migrations/20261113400000_timetable_import.sql:95-107` | **weekly recurring** class pattern (no concrete date) | `batch_id`, `weekday 1-7`, `slot`, `start_time`, `end_time`, `session_type theory/practical/assessment`, `room_id`, `sort` |
| `course_timing_templates` | `supabase/migrations/20261113400000_timetable_import.sql:110-120` | per course+batch name template from the SLIT workbook | `sessions jsonb[]` of `{weekday, slot, start, end, type, roomId}`, `trainer_name`, `trainer_staff_id` |
| `locations` | `supabase/migrations/20261113400000_timetable_import.sql:7-15` | campus / workshop | `name`, `address`, `kind theory/practical`, `sort`, `is_active`; seed `:19-25` |
| `classrooms` | `supabase/migrations/20261113340000_course_management.sql:135-142` + `location_id`, `sort` (`...400000:16-17`) | room | seed `:28-47` |
| `academic_breaks` | `supabase/migrations/20261113400000_timetable_import.sql:50-57` | term break | `label`, `start_date`, `end_date`; seed `:60-67` |
| `hr.public_holidays` | `supabase/migrations/20261110120000_hrms_settings_holidays_time.sql:135-147` | holiday | `holiday_date`, `name`, `is_optional`, `state`, `status review/confirmed` |
| `hr.locations` (HRMS work locations, **separate** from `public.locations`) | `supabase/migrations/20261113090000_hr_locations_job_type_login.sql:10` | | `src/pages/admin/LocationsPage.tsx:9-13` |

Derived spans: `rto_intake_span`, `rto_batch_span` (`supabase/migrations/20261113410000_batch_timing_rooms.sql:13-29`); working day rule `rto_is_working_day` (`...400000:70-75`); slot rule `rto_slot` (`...410000:7-10`).

#### 8.2 Is there a generic calendar / event table?

**No.** There is no `events`, `calendar`, `class_sessions` (dated), `assessments`, `assessment_due_dates` or `attendance` table. The only "event" tables are unrelated (`hr.time_events` for punches, `hr.sign_events`, `notification_provider_events`, `integration_webhook_events`, `admission_event_outbox`, `hr.recruitment_events`, `hr.staff_status_events`). The timetable model is: dated unit windows (`intake_units` / `batch_unit_overrides`) × weekly recurring sessions (`batch_sessions`), expanded on the client (rooms board) for one week at a time (`rto_course_flow('rooms_board')`, `...410000:326-343`, returns sessions whose batch span overlaps `from..to`).

To host assessment due dates and dated practical sessions, a new table would be needed, e.g. a dated `batch_events` (`batch_id`, `intake_unit_id?`, `event_date`, `start_time`, `end_time`, `kind`, `room_id`, `trainer_staff_id?`); nothing like it exists.

#### 8.3 Calendar-style UI today

| Surface | File | What it shows |
|---|---|---|
| CMS intake timeline (Gantt) | `src/pages/admin/components/rto/SchedulePanel.tsx:1-4` | unit bars by date, today, holidays, breaks |
| CMS rooms board (week grid) | `src/pages/admin/components/rto/RoomsBoard.tsx:1-2`, `:16-30` | rooms × weekday × slot for one week (`mondayOf(todayIso())`) |
| CMS batch timing | `src/pages/admin/BatchPage.tsx:95-112` + `BatchTimingDrawer.tsx` | weekly lines ("Theory · Mon, Tue · 12:00 PM – 8:30 PM · King Street campus, Room 8.2", `src/pages/admin/lib/rto.ts:182-192`) |
| Staff `/staff` | `src/pages/staff/StaffHomePage.tsx` | timesheet / leave / holidays; link to Bookings (`:109`); **no class calendar** |
| Student portal `/agency` | `src/pages/agency/components/PortalLayout.tsx:13`, `:21` | Bookings link only; no timetable |
| Public bookings (Calendly) | `src/pages/bookings/*`, `src/lib/bookingApi.ts` | meeting bookings, unrelated to classes |

---

### 9. ADMIN MENU and ROUTING (where new "Assessments" tabs go)

#### 9.1 Menu model

| Item | Where |
|---|---|
| Table `admin_menu_items` (`id`, `parent_id`, `label`, `route` regex `^/(admin|agency)(/[a-z0-9-]+)*$`, `icon_key`, `sort_order`, `is_enabled`, `permission_key cms.read/cms.admin/applications.review`, `permission_scope`, `is_system`) | `supabase/migrations/20261102090902_admin_menu_items.sql:4-19` |
| Read policy `admin_menu_authorized(permission, scope)` | `...20261102090902:26-47` (legacy scope: `cms.read` → `cms_is_staff()`, `cms.admin` → `cms_is_admin()`) |
| Group `agencies` relabelled "Master Data" | `supabase/migrations/20261109153953_skyline_master_data_hr.sql:4` (original row `...20261102090902:85` "Agencies & Agents") |
| Row `agency_course_fees` "Course Fees" → `/admin/course-fees`, `cms.admin` | `supabase/migrations/20261112172429_course_fees_master_data.sql:29-31`; sort 35 (`...20261113380000:5`) |
| Rows `rto_intakes` (`/admin/intakes`, `cms.read`, sort 36) and `rto_classrooms` (`/admin/classrooms`, `cms.admin`, sort 37) | `...20261113340000:585-588`, `...20261113380000:4-9`; both **disabled** (`is_enabled = false`) by `supabase/migrations/20261113390000_course_flow.sql:7` |
| Frontend loads rows with `supabase.from('admin_menu_items')` | `src/pages/admin/components/AdminMenu.tsx:45` |
| Route allow-list (a menu row only renders if its route is listed) | `src/pages/admin/lib/adminMenu.ts:29-38` (`'/admin/course-fees'`, `'/admin/intakes'`, `'/admin/classrooms'` are listed) |
| Active-state rule maps `/admin/courses/:id/:step` to the Courses row | `src/pages/admin/lib/adminMenu.ts:55-60` |

Adding a menu row needs both a migration row and an entry in `adminMenu.ts:29-38`; a new tab inside an existing page needs no menu change.

#### 9.2 Routes for the course/batch surfaces

| Route | Element | Guard | File |
|---|---|---|---|
| `/admin/course-fees` | `CourseFeesPage` (views `courses` / `intakes` / `rooms`) | `RequireAdmin` | `src/router/config.tsx:255`; `src/pages/admin/CourseFeesPage.tsx:11-23` |
| `/admin/course-fees/:id` | `CourseWizardRedirect` | none | `src/router/config.tsx:257`; `src/pages/admin/CourseWizardPage.tsx:123-128` |
| `/admin/courses/:id/:step` (`details`, `timetable`, `fees`, `intakes`, `website`) | `CourseWizardPage` | none at router level; non-RTO/non-Admin users see only `website` (`CourseWizardPage.tsx:68-69`) | `src/router/config.tsx:259`; steps `CourseWizardPage.tsx:13-19`, render `:106-110` |
| `/admin/courses/:slug` | `CourseEditorPage` (website content) | none | `src/router/config.tsx:205` |
| `/admin/intakes`, `/admin/intakes/:id` | `IntakesPage`, redirect to sheet | `RequireAdmin` | `src/router/config.tsx:260-261` |
| `/admin/classrooms` | `ClassroomsPage` | `RequireAdmin` | `src/router/config.tsx:262` |
| `/admin/batches/:id` | `BatchPage` (sections 1-5; section 5 placeholder) | `RequireAdmin` | `src/router/config.tsx:263`; `src/pages/admin/BatchPage.tsx:174-176` |
| `/admin/students/:id` | `StudentDetailPage` (+ `StudiesPanel`) | `RequireAdmin` | `src/router/config.tsx:242` |
| `/admin/staff/employees/:id` | `StaffDetailPage` | `RequireAdmin` | `src/router/config.tsx:251` |

Note: `RequireAdmin` wraps the RTO pages, so an Editor cannot open them even though `rto_admin` would let any CMS user read (`...340000:307`); the wizard route itself is unguarded and relies on the server's role answer.

#### 9.3 `rto_manager` role

| Item | Where |
|---|---|
| Column `cms_users.rto_manager`, granted to all Admins on migration | `supabase/migrations/20261113340000_course_management.sql:8-9` |
| `cms_is_rto_manager()` | `...340000:11-16` |
| Toggle actions `rto_role_get` / `set_rto_manager` (Admin or RTO Manager; at least one must remain) | `supabase/migrations/20261113350000_course_management_followups.sql:471-481` |
| UI toggle | `src/pages/admin/components/rto/RtoManagerToggle.tsx` (Users › edit) |
| Role matrix in `rto_admin` | `...350000:212-221`: RTO Manager writes courses/units/fees/intakes/schedules/batches/classrooms; Admin or RTO Manager `enrol`/`unenrol`; `rto_course_flow` `...410000:145-149`: reads for any CMS user, `student_move`/`enrolment_set` Admin or RTO Manager, the rest RTO Manager |
| Client role probe | `rto_admin('me')` → `{rtoManager, admin}` (`...350000:223-224`), used by `CourseWizardPage.tsx:50`, `BatchPage.tsx` via `batch_get`, `StudiesPanel.tsx:21` |

Where new "Assessments" tabs would fit: (a) the course wizard step list `src/pages/admin/CourseWizardPage.tsx:13-19` + `stepPath` type `src/pages/admin/lib/rto.ts:90-91` (e.g. a step between `timetable` and `fees` for assessment design per unit); (b) `BatchPage.tsx:174-176` section 5 (already a placeholder named "Assessments & Results"); (c) `IntakeSheet.tsx:17-18` tab list; (d) `StudentDetailPage.tsx:100` next to `StudiesPanel`. Server side, a new action family would follow `rto_course_flow`'s pattern (`...410000:137-149` role gate).

---

### 10. Classification

| Area | Status | Evidence |
|---|---|---|
| Courses (one record, facts + website, catalogue link) | **Implemented** | `cms_courses` + wizard + editor (section 1) |
| Units of competency (code, title, core/elective, weeks, hours, order, active) | **Implemented**; elements / PCs / evidence **Missing** | section 2 |
| Fees | **Implemented** | section 3 |
| Intakes (status, capacity, generated unit timeline, duplicate, fee override) | **Implemented** | section 4; legacy `course_intakes_admin` + `CourseIntakes.tsx` / `CourseFees.tsx` **Unused** |
| Batches (name, capacity, active, unit-date overrides, weekly sessions, rooms, clashes) | **Implemented** | section 5 |
| Trainer allocation | **Partial**: `batch_trainers` many-to-many to `hr.staff_profiles`, but any active staff member is offered (no `trainer` role filter), no availability/clash check per trainer, no per-session trainer | `...350000:442-444`; `batch_sessions` has no trainer column |
| Student allocation to batches | **Implemented** (add, move within intake, withdraw/undo, capacity) | section 5.2 |
| Enrolments (application → batch) | **Partial**: application workflow and batch enrolment exist separately; no FK or status sync between them; eligibility check misses slug-keyed applications | section 7.3, 1.3 |
| Timetable (unit windows × weekly sessions × rooms) | **Implemented** for planning; **Missing** dated/instanced sessions | section 8.1-8.2 |
| Calendar events (generic, dated, e.g. assessment due dates, practical days) | **Missing** | section 8.2 |
| Student calendar view (portal) | **Missing** (portal shows applications only) | section 7.4, 8.3 |
| Trainer calendar / my-batches view (`/staff`) | **Missing** | section 6, 8.3 |
| Assessments & results | **Missing** (placeholder section only) | `src/pages/admin/BatchPage.tsx:174-176`; SUPABASE.md `docs/SUPABASE.md:669` ("Assessment Management is not in this project") |
| Multi-tenant scoping of RTO tables | **Partial**: none of `course_intakes`, `intake_units`, `batches`, `batch_*`, `classrooms`, `locations`, `academic_breaks`, `course_timing_templates` carry `tenant_id`; access is "any CMS staff" via `cms_is_staff()` | `...340000:183-193`, `...400000:123-134` |
| Tests | **Partial**: INT-01 intake tests in `supabase/tests/phase4_authorization_positive.sql:870-878`; no SQL test references `rto_admin`, `batches`, `batch_enrolments` or `batch_sessions` | grep |

---

### 11. Confirmed vs Assumed vs Needs runtime access

**Confirmed (read in the repo)**
- All table definitions, FKs, RLS policies, helper functions and RPC role gates cited above, with the file:line references given.
- Trainer link = `batch_trainers.staff_id -> hr.staff_profiles.id`; staff identity = `hr.staff_profiles.auth_user_id -> auth.users`.
- Student link = `batch_enrolments.student_id -> enrollment_students.id`; student login = `agency_memberships(role='student', student_id) -> portal_profiles.auth_user_id -> auth.users`.
- No generic calendar/event table; `batch_sessions` is weekly-recurring only.
- No assessment/element/performance-criteria data anywhere; batch page section 5 is a placeholder.
- `letter_course_by_slug` does not exist; the slug resolver is `letter_course_id` (`supabase/migrations/20261113290000_letter_course_by_slug.sql:7-14`).

**Assumed (reasoned from code, not executed)**
- The slug-vs-id mismatch in `rto_student_on_course` blocks Admin enrolment for applications created from the public course page (depends on what `course_id` values exist in hosted `enrollment_application_courses`).
- `cms_courses_write` (any staff) still permits direct table writes that bypass the RTO Manager rule (`supabase/migrations/0002_cms_rls_policies.sql:58`); whether the client ever writes `cms_courses` directly outside `cms_commit` was not traced.
- `course_intakes_admin` + `src/pages/admin/components/CourseIntakes.tsx` are dead code (only imported by `CourseFees.tsx`, which nothing imports).
- The disabled menu rows `rto_intakes` / `rto_classrooms` stay disabled on hosted (migration `...390000:7` applied per CLAUDE.md).

**Needs runtime access**
- Hosted definition of `public.student_profiles` (referenced by FK at `supabase/migrations/20261102094611_...:139` but never created in the repo).
- Which migrations are actually applied on hosted (CLAUDE.md states every version up to `20261113420000` is APPLIED and `20261113220000` / `20261113230000` are local only; not verified in this read-only audit).
- Real data: how many `enrollment_application_courses.course_id` values are slugs; whether any `hr.staff_profiles` with role `trainer` exist and have logins; whether `course_timing_templates.trainer_staff_id` got linked for any course after the import.
- Behaviour of `rto_session_clashes` and `rooms_board` on hosted data (only verifiable in the lab or hosted).


---

# Part M. Classification summary and feature comparison matrix

## M1. Classification at a glance

| Capability | Submissions | Skyline |
|---|---|---|
| Authentication | Implemented (custom OTP; no Supabase Auth; no RLS) | Implemented (Supabase Auth, three identity domains, RLS) |
| Student dashboard | Implemented (sessionStorage identity) | Partial (portal shows applications only) |
| Trainer dashboard | Implemented (queue, grade-me, my students) | Missing (`/staff` has no batches) |
| Admin dashboard | Implemented (stats, directory) | Implemented (CMS / applications), no assessment data |
| Form builder | Implemented, fixed Student Pack structure, 12 types | Partial (website Form Builder, 14 flat types) |
| Assessments (create / version / publish / assign) | Partial (create + assign; no versioning, no publish step) | Missing |
| Submissions / drafts / attempts | Implemented (3 attempts, idempotent submit RPC) | Missing |
| Evidence storage | Implemented, public bucket | Implemented patterns (private buckets, path policies), no assessment bucket |
| Marking / feedback / outcomes | Implemented (code-derived S/NS, C/NYC) | Missing |
| Courses / units | Partial (form = unit, free-text codes) | Implemented (units table; no elements / criteria) |
| Batches | Implemented (one batch per student) | Implemented (intake → batch, many-to-many trainers, enrolments) |
| Timetable | Missing (dates only on instances) | Partial (planning timetable; no dated events) |
| Notifications | Implemented (in-app + FCM; no email on workflow) | Implemented (outbox + Postmark worker + in-app) |
| Reports / audit | Partial (one XLSX export; client-supplied audit columns) | Partial (per-domain audit tables; no assessment reports) |

## M2. Feature comparison matrix with the integration decision

Decision vocabulary: **Reuse** (use Skyline's as is), **Adapt** (Skyline's with additions), **Integrate** (Skyline's data plus new assessment rows linked to it), **Extend** (new capability on an existing Skyline mechanism), **Build** (new in Skyline; Submissions is behavioural reference only).

| Row | Submissions evidence | Skyline evidence | Decision |
|---|---|---|---|
| Authentication | S-A §2: OTP + localStorage user; anon key; ten token-checked RPCs; student has no server session | K9: `auth.uid()` + `cms_users` / `hr.staff_profiles` / `agency_memberships`; RLS and security-definer RPCs | **Reuse** Skyline logins; no OTP (DECISIONS D-02) |
| Student dashboard | S-A §4.5: instance list, acknowledgment gate, course lifecycle gate | K5 / K9: `/agency` portal, `portal_student_id()`; no assessment screens | **Extend** the portal with My Assessments / Results / calendar; reuse the acknowledgment idea as "receipt + outcome read" |
| Trainer dashboard | S-A §4.2-4.4: queue by batch, grade-me panel, unit submissions, my students | K6: `/staff` self-service only; `batch_trainers` exists | **Extend** `/staff` with My Assessments / Pending Marking / students; scope by `batch_trainers` |
| Admin dashboard | S-A §4.1: stats v2, instances paged | K1: CMS dashboard, Master Data menu | **Extend** CMS with Assessment Management (library, submissions overview, outcomes) |
| Form builder | S-B §1-§3: steps → sections → questions, 12 types, `pdf_meta` configs, prebuilt sections not deletable, `@dnd-kit` reorder within parent | K13: `cms_form_fields` flat; e-sign fields on PDF | **Build** a data-driven engine with a question-type registry (D-01, D-06, D-07) |
| Assessments | S-C §2: form = unit, always published, no versions, instances per student×form | K3: `cms_course_units`; K7: batches | **Build** `asm_assessments` / `asm_versions` mapped to course → unit, assigned to batches (**Integrate** with units, batches, enrolments) |
| Submissions | S-C §3: draft = answers rows; submit RPC; rollover cron; three overlapping state columns | none | **Build** append-only `asm_attempts` + JSONB responses, one state column, declaration with hash (D-05, D-06) |
| Evidence storage | S-C §4: public bucket, public URLs, bucket-wide anon policies | K12: private buckets with path policies and signed URLs | **Extend** the Skyline storage pattern with a private `assessment-evidence` bucket (D-04) |
| Marking / feedback | S-C §5: yes/no per question, S/NS per task per attempt, C/NYC per attempt, feedback text per attempt, office checks | none | **Build** results per question / criterion / task with suggested vs confirmed outcomes, feedback per question / criterion / overall, sign-off (D-08) |
| Courses / units | S-C §6: `skyline_courses`, `skyline_course_forms`; unit = form | K2-K3: `cms_courses`, `cms_course_units`, intakes, fees | **Reuse** Skyline master data; **Build** unit elements / criteria tables and the mapping matrix |
| Batches | S-A §5.1: `skyline_batches`, `batch_trainers`, `students.batch_id` | K7: `batches`, `batch_trainers`, `batch_enrolments` | **Reuse**; assessment assignment resolves students through `batch_enrolments` |
| Timetable | none (instance dates only) | K8: `intake_units`, `batch_sessions`, holidays, breaks; no dated events | **Extend** with `asm_schedule_events` merged into one calendar RPC (D-10); reuse components |
| Notifications | S-A §6: in-app + FCM, type → visual heuristics | K14: outbox, `notification_deliveries`, Postmark worker, in-app | **Extend** the outbox with `assessment_event_id` (D-11) |
| Reports / audit | S-A §7: XLSX export; client-supplied `created_by`; submission events | K15: `portal_audit_log` shape; pgTAP tests | **Build** `asm_audit_log`, cohort / outcome views, CSV exports; **Reuse** the audit shape and test harness |

---

# Part I. Auth / identity comparison

| Question | Submissions | Skyline | Integration answer |
|---|---|---|---|
| Same Supabase project? | No. Its own project (`qoylrmorezlqdvufonmx` per CLAUDE.md; `.temp/project-ref` says `fvveqziyusjgqejowkfp`) | `xcpydisstlvtvcsqnjob` | Separate projects; nothing is shared or migrated (brief 1.1). |
| Auth provider | None (custom OTP RPCs + Postmark; `auth.users` unused) | Supabase Auth (password, Google for students, invitations) | Skyline only. A second OTP login is unnecessary: every actor the brief names already has a Skyline login path (K9). |
| Staff identity | `skyline_users(id bigint, email unique, role superadmin/admin/trainer/office, rights)` | `cms_users` (Admin / Editor + `rto_manager`) for CMS; `hr.staff_profiles` + `hr.staff_roles` (admin / trainer) for HRMS | Admin = `cms_is_admin()` / `cms_is_rto_manager()`; trainer = active `hr.staff_profiles` linked by `batch_trainers` or a direct assignment. Submissions' `office` role maps to CMS Admin; `superadmin` to RTO Manager + Admin. |
| Student identity | `skyline_students(id bigint, email not unique, student_id text)`; dashboard trusts `sessionStorage` | `enrollment_students(id uuid, email unique within role)` + `agency_memberships(role='student', student_id)` + `portal_profiles.auth_user_id` | `portal_student_id()` in every student policy and RPC. |
| Same email in several roles | Disjoint tables, so possible by accident | Allowed by rule (`20261112042544`), one portal role per login | Assessment RPCs take the acting role from the entry point (`asm_admin` / `asm_trainer` / `asm_student`) and verify it server-side; a trainer who is also a student uses the student entry point for their own attempts and never sees assessor keys through it. |
| Session / token | 12-hour staff token checked by ten RPCs; per-instance access tokens generated in the browser | Supabase JWT; RLS on every table | No instance tokens. Access to an attempt = RLS on `asm_attempts` (owner student, assigned trainer, tenant admin). Signed URLs (60 s) only for evidence objects the caller may select. |
| Impersonation | Superadmin "open as user", login-as-student with `impersonation_logs` | Not present for students; CMS admins read student records directly | Not built. Admins read attempts through the admin RPCs with the audit log recording the actor; no "act as student". |
| Identity rule to respect | — | Email unique within a role (K9) | No new identity tables; no duplicate student / trainer records (brief section 5). |

---

# Part DM. Integrated data model

Existing Skyline rows reused unchanged: `cms_courses`, `cms_course_units`, `course_intakes`, `intake_units`, `batches`, `batch_trainers`, `batch_enrolments`, `batch_unit_overrides`, `batch_sessions`, `classrooms`, `enrollment_students`, `hr.staff_profiles`, `cms_users`, `notification_deliveries` (one nullable column added), `storage.buckets` (one bucket added).

New tables (all `public.asm_*`, all with `tenant_id` copied from the course, RLS enabled in the creating migration, `created_at` / `updated_at`, and written only through `asm_admin` / `asm_trainer` / `asm_student` unless noted):

| Table | Purpose | Key columns / rules |
|---|---|---|
| `asm_settings` | tenant-level configuration with per-assessment overrides (D-09) | `tenant_id` unique (null = legacy), `max_attempts` (3), `reassessment_days` (5), `late_submission` allow/block, `rollup_rule`, `declaration_text`, `instructions`, `evidence_max_mb`, `evidence_allowed_types` |
| `asm_unit_elements` | elements, performance criteria, performance evidence, knowledge evidence, assessment conditions per unit (brief 4.4) | `unit_id -> cms_course_units`, `kind`, `code`, `text`, `sort` |
| `asm_question_bank`, `asm_question_bank_versions` | reusable versioned questions shared across assessments and units | bank row + immutable version rows (`definition` jsonb, `version_no`) |
| `asm_assessments` | the assessment record | `course_id -> cms_courses`, `unit_id -> cms_course_units`, `code`, `title`, `is_template`, `current_version_id`, `settings_override` jsonb, `archived_at` |
| `asm_versions` | immutable snapshots (D-06) | `assessment_id`, `version_no`, `status draft/published/retired`, `definition` jsonb (tasks → sections → questions with stable ids, conditional logic, repeating groups, criteria, rubrics, response schemas), `published_at`, `published_by`, `checksum`; trigger refuses definition changes once published |
| `asm_version_questions` (view) | normalised view over the JSON for mapping, coverage and reports | `version_id`, `task_id`, `section_id`, `question_id`, `type`, `marking_mode` |
| `asm_question_keys` | assessor-only data (D-05) | `version_id`, `question_id`, `model_answer`, `answer_key` jsonb, `assessor_guidance`, `rubric_levels` jsonb; RLS staff + assigned trainers only; never joined by student RPCs |
| `asm_unit_mappings` | the mapping matrix as data | `version_id`, `question_id` or `criterion_id`, `element_id -> asm_unit_elements`; coverage gap = elements with no mapping |
| `asm_assignments` | who sits which version (brief 7) | `version_id`, `batch_id -> batches`, optional `student_id` override, `available_from`, `due_at`, `late_until`, `trainer_staff_ids[]` extra assessors, `reassign_rule` |
| `asm_attempts` | append-only attempt records | `assignment_id`, `student_id -> enrollment_students`, `version_id` (frozen), `attempt_no`, `state draft/submitted/marking/returned/final`, `responses` jsonb (keyed by question id), `declaration` jsonb (typed signature, text version, sha-256 of responses, signed_at), `submitted_at`, `receipt_no`, `row_version` int for concurrency; drafts update `responses`, submitted rows are locked by trigger |
| `asm_evidence_files` | uploaded evidence | `attempt_id`, `question_id`, `object_path` (`<attempt_id>/<question_id>/<uuid>-<name>`), `mime`, `bytes`, `sha256`; storage policy checks the attempt's select / write rule |
| `asm_results` | per question / criterion results | `attempt_id`, `question_id`, `criterion_id`, `suggested_outcome` (auto-check, D-08), `outcome S/NYS`, `score`, `feedback`, `marked_by`, `marked_at` |
| `asm_task_results` | per task outcome per attempt | `attempt_id`, `task_id`, `outcome S/NYS`, `rollup_suggested`, `feedback`, `signed_by`, `signed_at` |
| `asm_feedback` | overall feedback threads | `attempt_id`, `author`, `role`, `body`, `created_at` |
| `asm_reassessments` | reassessment decisions | `attempt_id`, `requested_by`, `reason`, `new_due_at`, `approved_by`, `state`, creates the next `asm_attempts` row |
| `asm_unit_outcomes` | Competent / Not Yet Competent with sign-off (brief 8) | `student_id`, `unit_id`, `assessment_id`, `outcome C/NYC`, `signed_by -> hr.staff_profiles` or `cms_users`, `signed_at`, `evidence_attempt_ids[]`; insert-only, superseding rows reference the prior one |
| `asm_schedule_events` | due dates and practical sessions in the calendar (D-10) | `assignment_id`, `kind due/practical`, `starts_at`, `ends_at`, `room_id -> classrooms`, `trainer_staff_id` |
| `asm_notifications` | in-app notifications per user | `recipient_auth_user`, `event`, `title`, `body`, `read_at`, `attempt_id` |
| `asm_audit_log` | append-only audit (brief 9) | `actor`, `actor_role`, `action`, `target_type`, `target_id`, `detail` jsonb |

Relationship chain (brief section 6) as foreign keys: `cms_courses` → `cms_course_units` → `asm_assessments` → `asm_versions` → `asm_assignments` (→ `batches` → `batch_trainers` / `batch_enrolments`) → `asm_attempts` (→ `enrollment_students`) → `asm_results` / `asm_task_results` / `asm_feedback` → `asm_reassessments` → `asm_unit_outcomes`.

---

# Part W. Workflows on the integrated system

**Admin (CMS, `cms_is_admin()` or `cms_is_rto_manager()`)**
1. Master Data › Assessments › New: choose course and unit (`cms_course_units`), title, code; or clone an assessment / start from a template / import JSON.
2. Builder: tasks → sections → questions by drag and drop; every registered question type; field settings (required, help text, assessor-only guidance); conditional logic; repeating groups; criteria and rubrics; mapping to `asm_unit_elements` with a coverage-gap panel; question bank insert / save.
3. Publish: validation (every question has a response schema; mapped elements; declaration present), snapshot to `asm_versions` (immutable), version N+1 draft created on next edit.
4. Assign: pick batches (students resolved from active `batch_enrolments`, trainers from `batch_trainers`), set availability and due dates (defaults from the unit window in `intake_units` / `batch_unit_overrides`), optional practical sessions → `asm_schedule_events`; notifications "published".
5. Monitor: submissions overview, pending marking, overdue, reassessments, outcomes; reports and CSV; audit history; authorised overrides (extend due date, reopen, void) all logged.

**Trainer / assessor (`/staff`, active `hr.staff_profiles` on `batch_trainers` or named on the assignment)**
1. My Assessments (by batch) and Pending Marking.
2. Open an attempt: student responses, evidence (signed URLs), assessor keys and guidance beside each question, auto-check suggestions to confirm, observation checklist and third-party report sections filled by the assessor.
3. Mark per question / criterion / rubric level, task outcome S / NYS (rollup suggested by the configured rule, assessor decides), feedback per question, criterion and overall; save with `row_version` check.
4. Return: Satisfactory → ready for unit outcome; Not Yet Satisfactory → reassessment (next attempt opened with the configured window, notification "reassessment").
5. Unit outcome: Competent / Not Yet Competent with explicit sign-off (name, time, which attempts), never automatic.
6. Calendar: due dates and practical sessions of my batches beside my classes.

**Student (`/agency` portal, `portal_student_id()`)**
1. My Assessments resolved through enrolment → batch → assignment; availability, due date, attempts used.
2. Complete: form rendered from the published version (student view never contains keys), autosaved drafts, evidence upload to the private bucket, conditional sections, repeating groups.
3. Submit: declaration (typed signature, declaration text version, hash of responses), receipt number and time; attempt locked.
4. Results: feedback, outcomes, reassessment windows, deadlines; calendar with due dates and practical sessions.

---

# Part R. Missing functionality, risks and reusable code

## R1. Missing in Skyline (must be built)

Everything in Part DM, the question-type registry and its three renderers, the student and trainer assessment screens, the calendar views, the assessment notifications and the reports. Also: unit elements / criteria data (no source exists in Skyline; the training.gov.au catalogue carries only counts, K-D §1.4), a trainer-role filter for `staff_list`, and dated calendar events.

## R2. Risks

| Risk | Evidence | Mitigation |
|---|---|---|
| Trainers have no CMS access and `/staff` has no batch views; a trainer screen built in the CMS would be unreachable for them | K6 | Trainer surface in `/staff`; RPC `asm_trainer` keyed on `hr.staff_profiles.auth_user_id` |
| RTO tables have no tenant column; a second tenant would see every batch | K10 | `asm_*` rows carry `tenant_id` from the course; the restrictive policy applies even though `batches` has none |
| Application ↔ batch coupling is by convention; slug-keyed applications fail `rto_student_on_course` | K4, K-D §1.3 | Assessment assignment uses `batch_enrolments` only |
| Assessor keys could leak through a generic select on the version JSON | D-05 | Keys live in `asm_question_keys`; student RPC builds the view from `definition` and a test asserts no `key` / `modelAnswer` / `assessorGuidance` keys in the student JSON |
| Immutable versions vs the need to fix typos after publish | D-06 | Edit creates a new draft; attempts keep `version_id`; admin may retire a version |
| Compliance constants (3 attempts, 5-day window, late policy, automatic NS on missed window) are Submissions' choices, not verified rules | S-C §5.3, brief 8 | Configurable in `asm_settings`; flagged in REPORT.md for human verification; no automatic NS or C |
| Concurrency: two assessors or admin + assessor editing the same attempt | brief 9 | `row_version` check in every update RPC; trigger refuses stale writes |
| Storage path tampering | brief 9 | Object path must start with an attempt id the caller may write; policy joins `asm_attempts` |
| Rate of change on `main` from other sessions (external integrations, email rules) | CLAUDE.md "Current position" | Rebase before the gate; SQL suites re-run on the merged tree |
| Lab replay failed once at `20261112172731` on the first attempt (`scripts/lab/staff-lab.mjs up`, log in the previous session's scratchpad) | previous run | Re-run the lab from a clean Docker state; if a repo migration itself fails on a fresh replay, record it in REPORT.md and validate the new migrations statement-by-statement (brief 11.3) |

## R3. Reusable code

From Skyline (reused directly):
- Role helpers and policy style: `cms_is_admin()`, `cms_is_rto_manager()`, `tenant_scope()`, `portal_student_id()`; RPC action-dispatch pattern of `rto_admin` / `rto_course_flow` (`supabase/migrations/20261113410000_batch_timing_rooms.sql:137-149`).
- Storage policy pattern for private buckets (`supabase/migrations/0006_agency_portal.sql:572-598` and hardening migrations).
- Notification outbox and worker (`notification_deliveries`, `notification-delivery`, `email-sender`), subject-check re-creation pattern (`20261113125512_bookings.sql:97-99`).
- Audit shape of `portal_audit_log`; pgTAP suites in `supabase/tests`; lab scripts; Playwright `e2e/` harness.
- UI: CMS `RichTextEditor` (instruction blocks), sheets / drawers / tables from `src/pages/admin/components/rto/*`, `SchedulePanel` / `RoomsBoard` week components, pdf.js viewer, `@dnd-kit` is already a dependency of Submissions only (Skyline: verify `package.json` before adding).
- Declaration evidence pattern from e-signing: typed signature + consent text + sha-256 of the signed content (`hr.sign_requests` checks).

From Submissions (behaviour only, re-implemented):
- Attempt semantics (attempt number, S/NS per task per attempt, C/NYC per attempt), reassessment window, Melbourne end-of-day deadlines, student acknowledgment of a changed outcome, idempotent submit with request id, per-question autosave with "never wipe a stored value with an empty one" merge.
- Content: the 15 policy sections, declaration texts, Reasonable Adjustment matrix, Learner Evaluation likert sets (converter output in `imports/`), the Results-sheet and Summary-sheet layouts as default task / summary templates.
- Not reused: anon-key data access, instance tokens, `pdf_meta` content blocks, title-regex structure detection, pdf-server.

---

# Part P. Phased plan with testable acceptance criteria

| Phase | Deliverable | Acceptance (local, automated unless marked) |
|---|---|---|
| 1 Audit | this file, DECISIONS.md | Files exist; every finding has `file:line`; matrix has 14 rows with a decision each |
| 2 Database | `20261113430000_assessment_management.sql` (tables, RLS, bucket, policies), `20261113440000_assessment_rpcs.sql` (`asm_admin`, `asm_trainer`, `asm_student`, `asm_calendar`, `asm_validate_responses`, `asm_autocheck`) | Fresh lab replays all migrations; `supabase/tests/assessment_management.sql` (pgTAP) passes: tenant isolation, student ownership, trainer scope, publication permission, evidence policy, key leakage, locked attempts, history preservation, sign-off authority, audit rows, concurrency, tampered ids |
| 3 Admin | Assessment Management pages, builder, question bank, versions, mapping, assignments, overview, reports, import / export, audit; course wizard and batch page tabs | Type-check, lint, build pass; registry unit tests (`scripts/test-assessment-registry.ts`) pass; Playwright admin journey where the harness runs |
| 4 Trainer | `/staff` assessments, marking, reassessment, unit outcome, progress | Trainer SQL tests; Playwright trainer journey |
| 5 Student | portal My Assessments, renderer, drafts, evidence, declaration + receipt, results | Student SQL tests (no key leakage); Playwright student journey |
| 6 Calendar + notifications | `asm_schedule_events`, `asm_calendar`, reassignment rules, outbox events | SQL tests for calendar scope and event enqueue; worker consumes rows in the lab |
| 7 Competency + reports | unit outcomes, progress, cohort reports, CSV, history views | SQL tests for outcome authority and immutability; export produces rows |
| 8 Tests + gate | flexibility acceptance test (`scripts/test-assessment-flexibility.ts`: every type, logic, repeating group, criteria, rubric, mapping, observation; student completes with files; trainer marks; outcome signed; version 2 while attempt stays on version 1), regression (`test:*`, SQL suites, e2e) | All green, then merge per brief section 11 |

---

# Part V. Confirmed, assumed, needs runtime access (consolidated)

**Confirmed from source (both repos)**
- Every table, FK, policy, trigger, RPC signature, grant, route and component cited in Parts S and K, at the `file:line` given.
- Submissions: no Supabase Auth, no RLS on assessment data, anon-executable destructive RPCs, OTP RPCs returning the code, fixed Student Pack structure, no versioning, public evidence bucket, three overlapping instance state columns, 3 attempts / +5 days / cron rollover with automatic NS.
- Skyline: three identity domains on one Supabase Auth; `batch_trainers.staff_id -> hr.staff_profiles.id`; `batch_enrolments.student_id -> enrollment_students.id`; no unit elements / criteria; no dated calendar table; trainers have no CMS access and no batch views; RTO tables have no tenant column; outbox + worker notifications; 14 pgTAP suites, script tests and Playwright harness; linked project ref `xcpydisstlvtvcsqnjob`.

**Assumed (reasoned, not executed)**
- Hosted Skyline matches CLAUDE.md "Current position" (every version up to `20261113420000` applied; `20261113220000` / `20261113230000` local only).
- Submissions' DRAFT / "review-only" migrations are applied on its hosted project (the frontend depends on them).
- `cms_courses_write` (any staff) still allows direct writes that bypass the RTO Manager rule; not relevant to `asm_*` which never grant direct writes.
- Submissions' per-unit question banks exist only in its live database (not in source); the converter can produce only scaffolding and policy / evaluation content (S-B2 "Actual assessment content embedded in source").
- The `@dnd-kit` packages are not yet Skyline dependencies (to verify in `package.json` when the builder is built).

**Needs runtime / hosted access (not done; recorded for the report)**
- Which Submissions project ref is live (`qoylrmorezlqdvufonmx` vs `fvveqziyusjgqejowkfp`); its live grants, storage policies, cron state. Not needed for the build (read-only reference) and not queried.
- Hosted definition of `public.student_profiles` (referenced, never created in the repo).
- Real data: trainers with role `trainer` and logins; `course_timing_templates.trainer_staff_id` linkage; slug-keyed applications; existing `course_intakes` per course.
- Hosted migration list and Edge Function versions (verified last on 2026-11-11 per CLAUDE.md; the deployment sequence re-verifies before any push).
