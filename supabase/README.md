# Skyline Website CMS — Supabase backend

> Audit update, 2026-10-24: this document contains historical CMS setup notes. The owner confirms CMS and Agency Portal share the Skyline backend; the independent Submissions system remains excluded. The checkout is React/Vite. Use [current database audit](../docs/ARCHITECTURE.md) and [deployment gates](../docs/SUPABASE.md) before any operation. The old four-migration list below is incomplete; 29 local files now exist, and live applied history was not verified. Historical account/verification statements are not current test evidence.

This project stores all Website CMS content in a **separate Supabase project**
(the "Skyline Test" development project). It does **not** touch the student
management / "Submissions" database.

- **Project ref (dev CMS):** `xcpydisstlvtvcsqnjob`
- **Schema:** everything lives in `public` with a consistent **`cms_` prefix**.
- **Auth:** Supabase Auth (email + password). Roles/profile in `cms_users`.
- **Storage:** public bucket `cms-media`.
- **Security:** RLS enabled on every table. Public can read only `Published`
  content; staff (rows in `cms_users`) can write.

## Environment variables

The frontend reads these (already configured by the Supabase connection):

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_PUBLIC_SUPABASE_URL` | `.env` (client) | Supabase project URL (public) |
| `VITE_PUBLIC_SUPABASE_ANON_KEY` | `.env` (client) | Supabase anon/publishable key (public, RLS-protected) |

No service-role key is ever shipped to the browser. Privileged operations run
only inside the `cms-admin-users` Edge Function, where Supabase injects the
service-role key as an environment variable.

## Tables

| Table | Purpose |
| --- | --- |
| `cms_settings` | Global site settings (singleton, id = 1) |
| `cms_social_links` | Footer/social links |
| `cms_users` | Admin/Editor profiles + roles (auth identity is in Supabase Auth) |
| `cms_courses` | Courses |
| `cms_course_sections` / `cms_course_attachments` / `cms_course_links` | Course child content |
| `cms_pages` | Website pages + rich text |
| `cms_forms` / `cms_form_fields` | The live forms and their field definitions |
| `cms_documents` | Forms & Policies documents (PDF URLs) |
| `cms_navigation_items` | Header navigation (self-referencing parent/child) |
| `cms_footer` | Footer content (singleton, id = 1) |
| `cms_seo` | Per-page SEO |
| `cms_revisions` | Version history snapshots |
| `cms_activity_log` | Audit log |

## Running the migrations on a fresh project

Run the files in order in the Supabase SQL editor (or `supabase db push` if you
use the CLI against the CMS project only):

1. `migrations/0001_cms_schema.sql` — tables, constraints, indexes
2. `migrations/0002_cms_rls_policies.sql` — helper functions, RLS, policies, storage
3. `migrations/0003_cms_auth_accounts.sql` — deprecated (kept for history; creates nothing)
4. `migrations/0004_cms_auth_hardening.sql` — links `cms_users` to Auth ids + rotation flag

> These migrations are for the **CMS project only**. They are never applied to
> the production / Submissions database.

## Staff accounts & provisioning

Staff accounts are **never** created by writing the `auth` schema or by
inserting plaintext passwords. The only supported paths are:

- **Edge Function `cms-admin-users`** (deployed in this project) — used by the
  CMS Users & Permissions screen. It calls the official Auth Admin API:
  `inviteUserByEmail`, `createUser`, `generateLink`, `deleteUser`.
- **Supabase Dashboard → Authentication** — for manual creation/recovery when
  the function's email delivery is unavailable.

Each `cms_users` row stores the profile/role and is linked to the real Auth
user via `auth_user_id`. A `must_change_password` flag forces a rotation on the
next sign-in for any account whose credentials were previously exposed.

### Accounts

| Account | Role | Notes |
| --- | --- | --- |
| `gourav.gupta@siyanainfo.com` | Admin | Confirmed Supabase Auth user, linked via `auth_user_id` |
| `gourav.gupta@slit.edu.au` | Editor | Confirmed Supabase Auth user, linked via `auth_user_id` |

The login email is only used as the Supabase Auth **username**; it does not
need to be a working mailbox to sign in.

- Passwords are **never** stored in this repository or in client code.
- The previously shared temporary password was exposed in plain text and is
  considered compromised — it has been retired and must not be reused. Rotate
  both accounts to unique strong passwords (via the CMS set-password flow or
  the Auth Admin API), then leave `must_change_password = false`.

### Edge Functions

| Slug | Purpose |
| --- | --- |
| `cms-admin-users` | Guarded staff provisioning (invite / reset / delete / list). Admin-only. |

## Password reset redirect configuration (required)

Supabase only sends users to your `redirectTo` if it matches the allow-list in
**Authentication → URL Configuration**. Otherwise it **silently falls back to
the Site URL** — the classic cause of reset links bouncing to `localhost:3000`
with `access_denied` / `otp_expired`.

- **Site URL** — the app's real public origin (no wildcard allowed here).
- **Redirect URLs** — add the exact recovery routes for every origin you use.

The app derives the redirect from `window.location.origin` at runtime
(`src/pages/admin/lib/auth.tsx` → `passwordResetUrl()`), so one build works on
the current Readdy preview link, a custom domain and `localhost` — no
publication or custom domain is required for resets to work.

Wildcard rules (Supabase matches the redirect against this allow list):
`*` matches any run of non-separator characters, `**` matches any run of
characters including separators (`.` and `/`). So `https://**/reset-password`
approves the reset page on any host, including every Readdy preview origin.

| Purpose | Redirect URL to add |
| --- | --- |
| Email recovery (this project) | `https://**/reset-password` |
| Forced rotation / invite landing | `https://**/admin/set-password` |
| Local development | `http://localhost:3000/**` |

**Site URL** cannot contain a wildcard, but it is only the *fallback* used when
nothing else matches — once the redirect above is allow-listed, reset links no
longer fall back to it. Set it to your current preview origin (or `localhost`)
for now, and to your real domain after publishing. Prefer exact URLs over the
broad `https://**` patterns once a stable domain exists.

### Email template requirement

The **Authentication → Email Templates → Reset Password** template must build
its link from the redirect, not the Site URL. Confirm the button link uses
`{{ .ConfirmationURL }}` (the default). If it is hardcoded to `{{ .SiteURL }}`,
Supabase ignores your `redirectTo` and the link will never reach
`/reset-password` — swap it for `{{ .ConfirmationURL }}` (or use
`{{ .RedirectTo }}` when composing a custom link).
