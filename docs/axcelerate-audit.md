# aXcelerate import: Part 0 audit and gap report

Date: 2026-11-28. Scope: the owner's brief "Build the aXcelerate import system" (Parts 0-4 received; the brief stops in Part 4, so the
Part 8 entity list, and anything after Part 4, were not received). **Status: AWAITING APPROVAL. No feature code written.**

Sources: Skyline repo `main` bf3f373, hosted project `xcpydisstlvtvcsqnjob` (read-only queries, 2026-11-28), aXcelerate's public API
reference (https://app.axcelerate.com/api/, https://developer.axcelerate.com/docs/). No aXcelerate tokens are saved yet, so **every
aXcelerate field below is "unconfirmed"** until the first live GET sample (Part 0.2). Fields marked *(s)* came from a summary of the
reference, not verbatim text.

---

## 0. Read this first

### 0.1 Urgent: the released aXcelerate caller is not read-only (breaks Part 1)
AXCELERATE-CONNECTION (released today, integrations-admin v16) lets an admin send **POST, PUT and DELETE** to **any** aXcelerate path
(`axcelerate_call`), and its presets include `POST /course/instance/search` and `POST /report/saved/run` (report API, forbidden by Part 1.3).
No tokens are saved, so nothing has been sent to aXcelerate. **Fix (first build step, small):** `axcelerateClient` = GET only + the
Part 1 allow-list + security event on anything else; the page's caller keeps only allow-listed GETs; remove the POST presets and the
method picker. Until then, do not save tokens.

### 0.2 Conflicts between the brief and what exists (decisions needed, section 6)
1. **Several allow-listed reads are POST-only in aXcelerate.** The reference documents `/course/instance/search` and `/users` as POST, and
   `/venues` and `/accounting/catalogueitem` with GET/POST swapped. With GET-only these may be unreachable; course instances can still be
   listed with `GET /course/instances` per course, venues with `GET /course/deliveryLocations`, users not at all.
2. **"Nightly GET poll on lastUpdated" only works for some entities.** `lastUpdated_min/_max` exists on `/courses`, `/course/instances`,
   `/course/instance/search` and `/course/enrolments` (paired, at most 90 days apart). Contacts, invoices, transactions, organisations
   and users have **no** updated-since filter; without reports or webhooks (both forbidden) they can only be re-read in full (paged)
   or re-read for the contacts whose enrolments changed.
3. **`/enrolment/enrolmentInfo` is not in aXcelerate's reference.** It stays on the allow-list but may 404.
4. **Course key.** aXcelerate courses carry the national code (`CODE`), not a CRICOS code. Skyline's course key `cms_courses.cricos`
   is NOT NULL. Matching must go national code -> Skyline course -> CRICOS; a domestic-only qualification without CRICOS has no key.
5. **"Every Qualification has an application."** `intake_enrolments.application_id` is nullable, but the consistency check flags a
   Qualification without one (QUAL-NO-APP), and every application must have a student. An imported enrolment needs an application.
6. **Qualifications need an intake.** `intake_enrolments.intake_id` is NOT NULL; aXcelerate class instances map to `course_intakes`,
   but a student enrolled in a qualification with no instance has no intake.
7. **AVETMISS guards refuse incomplete rows.** New writes to students, Qualifications, unit results and locations go through
   AVETMISS triggers (23514). aXcelerate records with missing or non-standard codes will be refused row by row (they become
   "import errors" to fix, per Part 2.2), not stored as junk.
8. **The "aXcelerate import" permission.** Skyline has no per-feature permission table: admin = `cms_users.role = 'Admin'`
   (`public.cms_is_admin()`), menu gates are `cms.admin` / `cms.read` / `applications.review`, and `integration_permissions` gives
   viewer / operator per connection. A new permission needs a home (section 6, D5).
9. **Organisation scope.** Integrations are already per organisation (`integration_connections.tenant_id`, Vault per connection).
   `public.tenants` has 0 rows on hosted, so SLIT is the organisation-wide scope (`tenant_id` null). Nothing is hard-coded.

---

## 1. Skyline audit (code and database)

### 1.1 Pages an import would touch (menu location -> route -> file)
| Menu location | Route | File | Tabs / drawers |
|---|---|---|---|
| Master Data › Students | /admin/students, /admin/students/:id | src/pages/admin/StudentsPage.tsx, StudentDetailPage.tsx | Overview, Qualification, AVETMISS panel (StudentAvetmissPanel), Timeline, Attendance card, Messages |
| Admissions › Applications | /admin/applications | src/pages/admin/ApplicationsArea (+ agency ApplicationWorkspace) | Form, Documents, history, offer letters |
| Admissions › Qualifications | /admin/qualifications, /admin/qualifications/:id | src/pages/admin/QualificationsPage.tsx, QualificationDetailPage.tsx | filters Needs placement / PRISMS to report; documents, status history |
| Master Data › Courses | /admin/course-fees, /admin/courses/:id/:step | CourseFeesPage.tsx, CourseWizardPage | course wizard (units, fees, master timetable, intakes) |
| LMS (left menu, area pages) | /admin/lms/courses, /units, /intakes, /attendance, /results, /completion, /locations, /timetable | src/pages/admin/lms/*.tsx | Units: Details, Learning content, Resources, Assessments; Results (outcome per unit) |
| Intakes | /admin/intakes, /admin/intakes/:id | IntakesPage.tsx, IntakeDetailPage.tsx | Overview, Timeline, Class setup, Students, Assessments, Batches |
| HRMS › Locations / LMS › Locations | /admin/staff/locations, /admin/lms/locations | LocationsPage.tsx, LmsLocationsPage.tsx | AVETMISS location fields, rooms |
| HRMS › Employees | /admin/staff/employees/:id | StaffPage.tsx, StaffDetailPage.tsx | Details, Documents, Pay and bank, Signing, Messages |
| Master Data › Agents / Businesses | /admin/agents/:id, /admin/businesses/:id | AgentsPage.tsx, AgentDetailPage.tsx, BusinessesPage.tsx, BusinessDetailPage.tsx | Business: Details, Documents, Agents, Students, Applications, Commissions |
| Finance › Payments | /admin/finance/payments | src/pages/admin/finance/PaymentsPage.tsx | PaymentEditor (manual add / refund) |
| Dashboard | /admin | src/pages/admin/DashboardPage.tsx | Needs action today, stat cards, quick actions |
| External Integrations | /admin/integrations/* | src/pages/admin/integrations/ConnectionsPage.tsx (+ AxcelerateConnection.tsx) | Configuration, Credentials, Webhooks, Sync History, Logs |
| Audit & Activity | /admin/activity, /agency/audit-log | ActivityPage.tsx, agency/audit-log | Activity Log, Admissions Audit |

All 152 routes and the full admin menu are in Appendix A and B.

### 1.2 Roles, permissions, audit logs, integrations
- **Roles:** `cms_users.role` Admin / Editor (+ `rto_manager` flag); `cms_is_admin()` = active Admin with a password set. Portal roles via
  `agency_memberships` (agent, agency admin, student); staff via `hr.staff_profiles` / `hr.staff_roles`; `platform_admins`.
  Menu permissions: `cms.admin`, `cms.read`, `applications.review` (`admin_menu_authorized`). Per-connection: `integration_permissions` (viewer / operator).
- **Audit logs:** `portal_audit_log` (append-only: phase4_immutable policies, the Admissions Audit page), `cms_activity_log`
  (Activity Log page; editable by policy), `integration_logs` (code only, no user), `asm_audit_log` (frozen), `hr.staff_audit`,
  `business_rule_audit_logs`, `email_account_audit`, `tenant_access_audit`, `axcelerate_api_calls` (who, method, path, status; released today).
- **Integrations:** `integration_definitions` (22 connectors incl. `axcelerate`), `integration_connections` (per `tenant_id`), secrets in
  Vault via `integration_private.credentials` (`integration_credential_write/read`, service role only). Environment-managed connectors use
  Edge Function secrets. aXcelerate details: `{environment, subdomain, apiToken, wsToken}` in Vault, summary shows last 4 characters.
- **Edge Functions (42 live):** Appendix D. **Cron (19):** Appendix D. **Buckets (16):** Appendix D. **RLS policies:** 561 in public + hr;
  RLS on for every public table.
- **Email uniqueness:** `enrollment_students` unique on lower(trim(email)) when set (students only); `hr.staff_profiles.email` unique;
  `cms_users.email` unique; `agents.email` not unique. Matches "unique within a role".

---

## 2. aXcelerate audit (unconfirmed: from the public reference; no live sample yet)
Field lists per entity are in Appendix E. Pagination: `offset` + `displayLength` (max 100) on most lists; `/course/enrolments` uses
`offset` + `limit` (default 100). Dates mostly `yyyy-mm-dd`, timestamps in several formats. Enrolment status codes (class): tent, ip,
canc, def, susp, comp. Outcome codes are AVETMISS (20, 30, 40, 51, 60, 70, 85 ...).

---

## 3. Gap report

Legend: Status EXISTS / PARTIAL / MISSING. Action REUSE / EXTEND / CREATE.
Every imported row also needs an "imported from aXcelerate" link (axcelerate id, imported at, edited in Skyline at): proposed as one new
table `axcelerate_links` (CREATE) instead of a column on every table, so no existing table changes shape.

### 3.1 Connection, permission, audit (Parts 1, 2)
| aXcelerate / brief item | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| URL, WS token, API token per organisation | External Integrations › aXcelerate | Credentials | Vault via integration_private.credentials; integration_connections.tenant_id | EXISTS | EXTEND: show "Token saved on <date> by <name>" (store who/when) instead of last 4 characters |
| axcelerateClient (GET only, allow-list) | none (server) | none | supabase/functions/_shared/integrations/axcelerate.ts | PARTIAL (allows any method/path) | EXTEND: GET only, allow-list, security events |
| Test connection (GET /courses displayLength=1) | External Integrations › aXcelerate | Credentials | integrations-admin `test` | EXISTS | REUSE |
| "aXcelerate import" permission | Administration › Users & Permissions | none | none | MISSING | CREATE (see D5) |
| Audit trail (who, when, IP, scope) | Import centre | Audit | portal_audit_log (append-only) + axcelerate_api_calls | PARTIAL | EXTEND portal_audit_log (target_type axcelerate_*), add IP |
| Security event email to SLIT admins | none | none | notification_deliveries (queue) | PARTIAL | EXTEND: new event, recipients = active Admins |
| Survey (counts, document size, custom fields, statuses) | Import centre | Survey | none | MISSING | CREATE |
| Import jobs (start, cancel, retry, progress) | Import centre / page buttons | Jobs | integration_sync_jobs (connection_test only) | PARTIAL | CREATE axcelerate_import_runs / _items (sync_jobs is too narrow) |
| Field mapping | Import centre | Mapping | none | MISSING | CREATE |
| Conflicts (Keep Skyline / Take aXcelerate) | Import centre | Conflicts | none | MISSING | CREATE |
| Skipped list (deleted in Skyline) | Import centre | Skipped | none | MISSING | CREATE |
| "Import everything" card | Dashboard | none | none | MISSING | CREATE (card in DashboardPage) |
| Import centre page | External Integrations | none | none | MISSING | CREATE /admin/integrations/axcelerate (one page, tabs) |

### 3.2 Contacts -> Students
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| CONTACTID | Students | none | none | MISSING | CREATE axcelerate_links |
| GIVENNAME, SURNAME, PREFERREDNAME | Students | Overview | enrollment_students.full_name (+ details jsonb first/last) | PARTIAL | REUSE (compose full_name, keep parts in details) |
| EMAILADDRESS | Students | Overview | enrollment_students.email (unique among students) | EXISTS | REUSE (match key) |
| MOBILEPHONE, PHONE, WORKPHONE | Students | Overview | enrollment_students.phone (+ details) | EXISTS | REUSE |
| DOB | Students | Overview | enrollment_students.date_of_birth | EXISTS | REUSE |
| SEX | Students | AVETMISS | enrollment_students.sex_code | EXISTS | REUSE (map M/F/X) |
| USI, USI_VERIFIED | Students | AVETMISS | application_usi.usi (per application) | PARTIAL | EXTEND: store on the student's import application; never re-verify against aXcelerate |
| COUNTRYOFBIRTHID | Students | AVETMISS | enrollment_students.birth_country_code | EXISTS | REUSE (SACC code check) |
| CITIZENSTATUSID | Students | AVETMISS | enrollment_students.residency_status | PARTIAL | EXTEND mapping |
| PRIOREDUCATIONIDS | Students | AVETMISS | student_prior_education | EXISTS | REUSE |
| DISABILITYTYPEIDS | Students | AVETMISS | student_disabilities | EXISTS | REUSE |
| language / labour force / school level / indigenous (not found in reference) | Students | AVETMISS | home_language_code, labour_force_code, school_level_code, indigenous_status_code | EXISTS | REUSE if the live sample has them |
| ADDRESS1/2, CITY, STATE, POSTCODE, COUNTRY, BUILDINGNAME, UNITNO, STREETNO, STREETNAME, POBOX | Students | Overview | enrollment_students.address_* + details | EXISTS | REUSE |
| passport, visa (not found in reference) | Students | Overview | enrollment_students.passport_number (NOT NULL), nationality (NOT NULL) | PARTIAL | decision D7 (required in Skyline) |
| CUSTOMFIELD_* | Students | Overview | enrollment_students.details (jsonb) | PARTIAL | EXTEND: details.axcelerate_custom |
| EMERGENCYCONTACT, PARENTCONTACTID, EMPLOYERCONTACTID, PAYERCONTACTID | Students | none | details jsonb | PARTIAL | EXTEND (details) |
| ORGID(S) (employer) | none | none | none | MISSING | no home (section 4) |

### 3.3 Courses, units, instances, venues
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| Course ID, CODE (national code), NAME | Master Data › Courses / LMS › Courses | wizard | cms_courses.code, name; key cms_courses.cricos | PARTIAL | REUSE: match by code; CRICOS from the existing CRICOS lookup; no create without CRICOS (D2) |
| COST, GST_TYPE | Courses | Fees | course_fee_items | EXISTS | REUSE (only when the course has no fees yet) |
| DELIVERY, DURATION | Courses | wizard | cms_courses.duration, delivery_mode_identifier | EXISTS | REUSE |
| Instance UNITS (UNITCODE, UNIT, ELECTIVE, SCHEDULEDSTART/END) | LMS › Units / Intakes | Timeline | cms_course_units, intake_units | EXISTS | REUSE (units by code; new units via the existing Training.gov.au add) |
| INSTANCEID, NAME, STARTDATE, FINISHDATE, MAXPARTICIPANTS | Intakes | Overview | course_intakes (start_date, end_date, name, capacity) | EXISTS | REUSE (CoE/VoE study load: D6) |
| TRAINERCONTACTID | Intakes | Class setup | intake_trainers, intake_units.trainer_id (hr staff) | PARTIAL | REUSE after trainer import |
| LOCATION, DELIVERYLOCATIONID | Locations | none | locations (avetmiss_location_id, suburb, postcode, state_code, country_code) | EXISTS | REUSE |
| Venues (CONTACTID, NAME, address) | Locations | rooms | locations / classrooms | EXISTS | REUSE |

### 3.4 Enrolments -> Qualifications and unit results
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| ENROLID / ID (type p) | Qualifications | none | intake_enrolments (Qualification) | EXISTS | REUSE + axcelerate_links |
| status tent/ip/def/susp/canc/comp | Qualifications | status | intake_enrolments.status (Tentative, In Progress, Deferred, Suspended, Cancelled, Completed) | EXISTS | REUSE (1:1 mapping) |
| ENROLMENTDATE, STARTDATE, FINISHDATE, DateCompleted | Qualifications | Overview | enrolled_on, course_start_date, course_end_date, actual_completion_date | EXISTS | REUSE |
| funding / study reason | Qualifications | AVETMISS | funding_source_code, study_reason_code | EXISTS | REUSE (AVETMISS codes) |
| unit enrolments (type s): UNITCODE, OUTCOMECODE, activity start/end, DELIVERY | LMS › Results | Results | lms_unit_students (outcome_code, actual_start/end_date, delivery_mode_identifier, location_id) | EXISTS | REUSE |
| application behind the enrolment | Applications | Form | enrollment_applications (student_id NOT NULL) | PARTIAL | decision D3 (create a direct application, source 'axcelerate') |
| CoE number (international) | Qualifications | Overview | intake_enrolments.coe_number | EXISTS | REUSE if present |
| Certificate (base64 PDF) | Qualifications | Documents | intake_enrolment_documents (kind certificate); course_completions | PARTIAL | REUSE intake_enrolment_documents; course_completions only for Skyline-issued |

### 3.5 Attendance
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| attendance DATE, STARTTIME, FINISHTIME, ENROLLEES (ATTENDEDFLAG, ATTENDEDDURATION, COMMENT) | LMS › Attendance | registers | lms_attendance_register (intake_unit_id, class_date), lms_attendance_marks (enrolment_id, status) | PARTIAL | EXTEND: no duration / comment column (add nullable) |
| class times | Intakes | Class setup | class_sessions | EXISTS | REUSE (only dates with attendance) |

### 3.6 People and organisations
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| Trainer (CONTACTID, NAME, EMAIL, ACTIVE, EMPTYPE) | HRMS › Employees | Details | hr.staff_profiles (+ hr.staff_roles) | PARTIAL | decision D8 (staff records drive HR onboarding) |
| Users / contactRoles | Administration › Users | none | cms_users | EXISTS | do NOT import (logins are not migrated) |
| Agent (MARKETINGAGENTID, CONTACTID, DEFAULTCOMMISSIONRATE, ACTIVE) | Master Data › Agents | none | agents (business_id NOT NULL, email, phone, marn NOT NULL) | PARTIAL | decision D9 |
| Organisation (ORGID, NAME, LEGALNAME, ABN, PARENTORGID) | Master Data › Businesses | Details | agencies (agent businesses only) | PARTIAL | only organisations that are agent businesses; employers: no home |

### 3.7 Finance (GET only)
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| Invoice header (INVOICENR, INVOICEDATE, DUEDATE, PRICEGROSS, BALANCE, ISPAID, ISVOID) | Finance | none | none (payments is a Stripe-shaped payment log) | MISSING | decision D10: CREATE axcelerate invoice tables or store as payments rows |
| Invoice ITEMS (DESCRIPTION, QTY, TOTALGROSS, ENROLMENT) | Finance | none | none | MISSING | as D10 |
| Transactions (AMOUNT, TRANSDATE, PAYMENTMETHOD, FRAGMENTS) | Finance › Payments | none | payments (source, external_reference, amount_cents, paid_at, student_id, intake_enrolment_id) | PARTIAL | REUSE payments with source 'axcelerate' |
| Credit notes | Finance › Payments | none | payments.amount_refunded_cents | PARTIAL | as D10 |
| Catalogue items | Courses | Fees | course_fee_items / letter_other_fees | PARTIAL | not imported by default |

### 3.8 Documents, notes and other data
| aXcelerate field | Skyline page | Tab | Skyline table.column | Status | Action |
|---|---|---|---|---|---|
| Portfolio (PORTFOLIOTYPE, NUMBER, DATEISSUED, DATEEXPIRES, FILES) | Applications / Qualifications | Documents | enrollment_application_documents, intake_enrolment_documents | EXISTS | REUSE: files attach to the student's application or Qualification only (never loose) |
| Contact notes (TEXT, TYPE, DATEINSERTED, ADDEDBY) | Students | Messages / Timeline | comm_conversations / comm_messages (channel note) | PARTIAL | REUSE comm_messages (channel 'note', direction inbound, sent_by_name = aXcelerate author) |
| Custom field definitions | Import centre | Survey | none | MISSING | CREATE (survey list; values to details jsonb) |
| Tasks, follow-ups | none | none | qualification_tasks (Skyline task kinds only) | MISSING | no home (section 4) |
| Email / SMS templates | Communications | Templates | communication_templates | EXISTS | not imported by default (templates hold aXcelerate merge fields) |
| Portfolio checklists / types | none | none | none | MISSING | survey only |

---

## 4. Fields with no home, and Skyline fields aXcelerate cannot fill

**aXcelerate data with no home in Skyline:** employer organisations (ORGID, EMPLOYERCONTACTID), contact categories / domains, LUI,
TFN_RECORDED, SACE ID, tasks and follow-ups (CRM pipeline), opportunities, workshops (type w) and e-learning (type el) enrolments,
catalogue items, trainer pay rates (RATEAMOUNT), user logins and roles, invoice shipping addresses, portfolio checklists.
Proposal: keep the raw aXcelerate record in `axcelerate_links.raw` (jsonb) so nothing is lost, and show it read-only on the record.

**Skyline required fields aXcelerate cannot fill (or may not):**
- `enrollment_students.passport_number`, `nationality` (NOT NULL; aXcelerate has no passport field in the reference).
- `enrollment_students.agency_id` (NOT NULL): students without an agent go to the SLIT direct business (SLIT-DIRECT).
- `enrollment_applications.intake`, `student_name`, `student_email` (NOT NULL); `enrollment_application_courses.course_id`.
- `intake_enrolments.intake_id` (NOT NULL) for enrolments without a class instance.
- `cms_courses.cricos` (NOT NULL) for a qualification not in Skyline.
- `agents.business_id`, `email`, `phone`, `marn` (NOT NULL): agents without a MARN or business.
- AVETMISS fields Skyline enforces at write (sex, birth country, language, school level, labour force, disability / prior education
  flags, delivery mode, location ids) when aXcelerate leaves them blank or uses a non-standard code.

---

## 5. Proposed build (only what is missing; additive)
1. Lock down the existing caller (0.1).
2. One migration: `axcelerate_links` (entity, axcelerate_id, skyline table + id, raw, imported_at, last_import_run, edited_in_skyline_at,
   merged_into), `axcelerate_skipped`, `axcelerate_import_runs` / `_items` / `_errors`, `axcelerate_conflicts`, `axcelerate_mappings`,
   `axcelerate_survey`; triggers stamping `edited_in_skyline_at` on edits of linked rows; nullable `lms_attendance_marks` duration /
   comment; the permission (D5); RPCs behind `cms_is_admin()` + the permission; audit rows in `portal_audit_log`.
3. Edge Function `axcelerate-import` (JWT on; permission checked first): survey, per-page import, import everything (order: locations,
   courses / units, instances (intakes), trainers, agents, students, applications + Qualifications, unit results, attendance,
   documents, notes, finance), cancel, retry, conflicts; nightly sync cron (GET + lastUpdated where it exists).
4. Screens: "Import from aXcelerate" button on Students, Qualifications, Courses, Intakes, Locations, Agents, Employees, Payments
   (admins with the permission only); Dashboard "Import everything" card; Import centre (/admin/integrations/axcelerate: Survey,
   Mapping, Runs, Errors, Conflicts, Skipped, Audit); "Imported from aXcelerate" badge on records.

---

## 6. Decisions for the owner
- **D1** Send the rest of the brief (Part 4 onward, Part 8 entity list).
- **D2** A course not in Skyline: create it (needs CRICOS from the CRICOS lookup; refuse when none), or skip and list as an error?
- **D3** Each imported Qualification gets a direct application (source 'axcelerate', status matching: In Progress -> Active, Completed
  -> Active, Cancelled -> Withdrawn)? Without it every one shows as QUAL-NO-APP.
- **D4** Enrolments with no class instance: create one "aXcelerate import" intake per course, or skip?
- **D5** The "aXcelerate import" permission: a new admin permission table (`cms_permissions`: user + key), or a flag on `cms_users`?
- **D6** Instances become CoE or VoE intakes (study load): from the student's residency, or one default?
- **D7** Students without passport / nationality (domestic students): allow blank for imported rows (needs a relaxed NOT NULL) or put "Australia" / "Not provided"?
- **D8** Import trainers as staff (hr.staff_profiles, status Active, no onboarding emails), or only link trainers that already exist by email?
- **D9** Agents without a MARN or business: create a business from the aXcelerate organisation, or skip?
- **D10** Invoices: new read-only invoice tables (header + items) under Finance, or only payments rows?
- **D11** POST-only reads (/course/instance/search, /users, maybe /venues): accept that they are not used, or allow those exact POST
  search calls as reads (breaks "GET only")?
- **D12** Workshops (type w) and e-learning (type el): import or ignore?
- **D13** Contacts have no updated-since filter: nightly full re-read of contacts (paged, about 200 calls a minute), or only contacts
  whose enrolments changed?

---

## Appendix A. Routes (src/router/config.tsx)
| Path | Component | File |
|---|---|---|
| about-us | ContentPageRoute | src/pages/content/page |
| our-courses | CoursesPage | src/pages/courses/page |
| courses/:slug | CourseDetailPage | src/pages/course-detail/page |
| information | ContentPageRoute | src/pages/content/page |
| student-visa | ContentPageRoute | src/pages/content/page |
| oshc | ContentPageRoute | src/pages/content/page |
| forms-policies | FormsPoliciesPage | src/pages/forms-policies/page |
| forms/:id | CmsFormPage | src/pages/form/page |
| agents | AgentsPage | src/pages/agents/page |
| become-an-agent | BecomeAnAgentPage | src/pages/become-an-agent/page |
| careers | CareersPage | src/pages/careers/page |
| careers/:id | CareerDetailPage | src/pages/careers/detail/page |
| careers/:id/apply | CareerApplyPage | src/pages/careers/apply/page |
| contact | ContactPage | src/pages/contact/page |
| enroll-now | EnrollPage | src/pages/enroll/page |
| * | CmsPageRoute | src/pages/content/CmsPageRoute |
| /login | LoginPage | src/pages/login/page |
| /forgot-password | ForgotPasswordPage | src/pages/ForgotPasswordPage |
| /reset-password | ResetPasswordPage | src/pages/ResetPasswordPage |
| /staff/apply | redirect |  |
| /staff/onboard | StaffOnboardingPage | src/pages/staff/StaffOnboardingPage |
| /staff/offer | StaffOfferPage | src/pages/staff/StaffOfferPage |
| /sign | SigningPage | src/pages/SigningPage |
| /guardian-sign | GuardianSignPage | src/pages/guardian-sign/page |
| /admin/text-invite | TextInvitePage | src/pages/TextInvitePage |
| /agency/text-invite | TextInvitePage | src/pages/TextInvitePage |
| /bookings | BookingsPage | src/pages/bookings/BookingsPage |
| /book/:handle | PublicBookingPage | src/pages/bookings/PublicBookingPage |
| /book/:handle/:type | PublicBookingPage | src/pages/bookings/PublicBookingPage |
| /booking | ManageBookingPage | src/pages/bookings/ManageBookingPage |
| /staff/welcome | StaffWelcomePage | src/pages/staff/StaffWelcomePage |
| /staff | StaffHomePage | src/pages/staff/StaffHomePage |
| /staff/assessments | StaffAssessmentsPage | src/pages/staff/AssessmentsPage |
| /staff/timetable | StaffTimetablePage | src/pages/staff/TimetablePage |
| /certificate/:id | CertificatePage | src/pages/CertificatePage |
| /staff/assessments/attempts/:id | MarkingPage | src/pages/staff/MarkingPage |
| /staff/team/timesheets | TeamTimesheetsPage |  |
| /staff/team/leave | TeamLeavePage |  |
| /staff/team | redirect |  |
| login | LoginRedirect | src/pages/login/LoginRedirect |
| accept-invite | AcceptInvitePage | src/pages/agency/accept-invite/page |
| application-invite | ApplicationInvitePage | src/pages/agency/application-invite/page |
| dashboard | PortalDashboardPage | src/pages/agency/dashboard/page |
| workspace | AgencyWorkspacePage | src/pages/agency/workspace/page |
| applications | PortalApplicationsPage | src/pages/agency/applications/page |
| applications/new | NewApplicationPage | src/pages/agency/applications/new/page |
| applications/:id | ApplicationDetailPage | src/pages/agency/applications/detail/page |
| students | PortalStudentsPage | src/pages/agency/students/page |
| documents | PortalDocumentsPage | src/pages/agency/documents/page |
| assessments | StudentAssessmentsPage | src/pages/agency/assessments/page |
| assessments/:id | StudentAssessmentPage | src/pages/agency/assessments/detail/page |
| learning | StudentLearningPage | src/pages/agency/learning/page |
| qualification | MyQualificationPage | src/pages/agency/qualification/page |
| practice | PracticeRedirect |  |
| timetable | StudentTimetablePage | src/pages/agency/timetable/page |
| messages | StudentMessagesPage | src/pages/agency/messages/page |
| notifications | PortalNotificationsPage | src/pages/agency/notifications/page |
| bookings | BookingsHub | src/pages/bookings/BookingsHub |
| tickets | PortalTicketsPage |  |
| tickets/:id | PortalTicketDetailPage |  |
| agency-profile | AgencyProfilePage | src/pages/agency/agency-profile/page |
| profile | PortalProfilePage | src/pages/agency/profile/page |
| agencies | AdminAgenciesPage | src/pages/agency/agencies/page |
| users | AdminUsersPage | src/pages/agency/users/page |
| all-applications | AllApplicationsPage | src/pages/agency/all-applications/page |
| audit-log | AdminAuditLogPage | src/pages/agency/audit-log/page |
| registrations | RegistrationWorkbenchPage | src/pages/agency/registrations/page |
| login | LoginRedirect | src/pages/login/LoginRedirect |
| set-password | AdminSetPasswordPage | src/pages/admin/SetPasswordPage |
| lms | LmsPage |  |
| communication | CommunicationHubPage | src/pages/admin/CommunicationHubPage |
| email-management | EmailManagementPage | src/pages/admin/EmailManagementPage |
| lms/:area | LmsPage |  |
| courses | AdminCoursesPage | src/pages/admin/CoursesPage |
| courses/:slug | CourseEditorPage | src/pages/admin/CourseEditorPage |
| pages | AdminPagesPage | src/pages/admin/PagesPage |
| navigation | NavigationPage | src/pages/admin/NavigationPage |
| footer | FooterPage | src/pages/admin/FooterPage |
| settings | SettingsPage | src/pages/admin/SettingsPage |
| documents | DocumentsPage | src/pages/admin/DocumentsPage |
| forms | AdminFormsPage | src/pages/admin/FormsPage |
| forms/:id | FormBuilderPage | src/pages/admin/FormBuilderPage |
| contact | AdminContactPage | src/pages/admin/ContactPage |
| seo | AdminSeoPage | src/pages/admin/SeoPage |
| new | NewApplicationPage | src/pages/agency/applications/new/page |
| :id | ApplicationDetailPage | src/pages/agency/applications/detail/page |
| new | AgencyNewPage | src/pages/admin/AgencyNewPage |
| :id | AgencyRedirect | src/pages/admin/AgencyRedirect |
| audit-log | ApplicationsArea | src/pages/admin/ApplicationsArea |
| registrations | ApplicationsArea | src/pages/admin/ApplicationsArea |
| portal-users | ApplicationsArea | src/pages/admin/ApplicationsArea |
| businesses | BusinessesPage | src/pages/admin/BusinessesPage |
| businesses/:id | BusinessDetailPage | src/pages/admin/BusinessDetailPage |
| agents | AdminAgentsPage | src/pages/admin/AgentsPage |
| agents/:id | AgentDetailPage | src/pages/admin/AgentDetailPage |
| students | StudentsPage | src/pages/admin/StudentsPage |
| students/:id | StudentDetailPage | src/pages/admin/StudentDetailPage |
| qualifications | QualificationsPage | src/pages/admin/QualificationsPage |
| qualifications/:id | QualificationDetailPage | src/pages/admin/QualificationDetailPage |
| bookings | BookingsHub | src/pages/bookings/BookingsHub |
| tickets | TicketsPage |  |
| tickets/:id | TicketDetailPage |  |
| staff | redirect |  |
| staff/employees | StaffPage | src/pages/admin/StaffPage |
| staff/employees/org-chart | redirect |  |
| staff/employees/:id | StaffDetailPage | src/pages/admin/StaffDetailPage |
| staff/candidates | CandidatesPage |  |
| staff/candidates/:id | CandidateDetailPage |  |
| jobs | JobsPage | src/pages/admin/JobsPage |
| course-fees | CourseFeesPage | src/pages/admin/CourseFeesPage |
| course-fees/:id | CourseWizardRedirect |  |
| courses/:id/:step | CourseWizardPage |  |
| intakes | IntakesPage | src/pages/admin/IntakesPage |
| intakes/:id | IntakeDetailPage | src/pages/admin/IntakeDetailPage |
| classrooms | redirect |  |
| batches/:id | OldBatchRedirect |  |
| assessments | AssessmentsPage | src/pages/admin/assessments/AssessmentsPage |
| assessments/:id | AssessmentDetailPage | src/pages/admin/assessments/AssessmentDetailPage |
| staff/timesheets | TimesheetsPage | src/pages/admin/TimesheetsPage |
| staff/leave | LeaveAdminPage | src/pages/admin/LeaveAdminPage |
| staff/pay-schedules | PaySchedulesPage | src/pages/admin/PaySchedulesPage |
| staff/locations | LocationsPage | src/pages/admin/LocationsPage |
| staff/holidays | PublicHolidaysPage | src/pages/admin/PublicHolidaysPage |
| staff/xero-export | XeroExportPage | src/pages/admin/XeroExportPage |
| staff/templates | TemplatesPage | src/pages/admin/TemplatesPage |
| finance/payments | FinancePaymentsPage | src/pages/admin/finance/PaymentsPage |
| signing | AdminSigningPage | src/pages/admin/SigningPage |
| signing/:view | AdminSigningPage | src/pages/admin/SigningPage |
| staff/jobs | redirect |  |
| candidates | redirect |  |
| candidates/:id | LegacyCandidateRedirect |  |
| employees | redirect |  |
| employees/:id | LegacyEmployeeRedirect |  |
| employees/:id/onboarding | LegacyEmployeeRedirect |  |
| staff/:id | LegacyStaffDetailRedirect |  |
| notifications | NotificationLogPage | src/pages/admin/NotificationLogPage |
| users | UsersPage | src/pages/admin/UsersPage |
| business-rules | BusinessRulesPage | src/pages/admin/businessRules/BusinessRulesPage |
| institution | InstitutionPage | src/pages/admin/InstitutionPage |
| activity | ActivityPage | src/pages/admin/ActivityPage |
| integrations | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/overview | redirect |  |
| integrations/applications | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/add | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/credentials | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/webhooks | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/sync-history | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/logs | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| integrations/settings | IntegrationConnectionsPage | src/pages/admin/integrations/ConnectionsPage |
| knowledge | KnowledgePage | src/pages/admin/KnowledgePage |
| settings/application-statuses | ApplicationStatusesPage | src/pages/admin/ApplicationStatusesPage |
| knowledge/documents | redirect |  |

## Appendix B. Admin menu (admin_menu_items, enabled) {permission}
```
Administration {cms.admin}
Administration › Business Rules & Policies [/admin/business-rules] {cms.admin}
Administration › Institution [/admin/institution] {cms.admin}
Administration › Users & Permissions [/admin/users] {cms.admin}
Admissions › Applications [/admin/applications] {cms.admin}
Admissions › Qualifications [/admin/qualifications] {cms.admin}
Admissions › Registrations [/agency/registrations] {applications.review}
AI & Automation › Assistant Knowledge [/admin/knowledge] {cms.admin}
Audit & Activity › Activity Log [/admin/activity] {cms.read}
Audit & Activity › Admissions Audit [/agency/audit-log] {applications.review}
Bookings [/admin/bookings] {cms.admin}
Communications › Notification Log [/admin/notifications] {cms.admin}
Dashboard [/admin] {cms.read}
External Integrations › Add Connection / Connected Applications / Credentials & Secrets / Integration Logs / Overview / Settings / Sync History / Webhooks & Events [/admin/integrations/*] {cms.admin}
Finance › Payments [/admin/finance/payments] {cms.read}
HRMS › Employees / Leave / Locations / Pay Schedules / Public Holidays / Templates / Timesheets / Xero Export [/admin/staff/*] {cms.admin}
Master Data › Agents [/admin/agents] {cms.admin}
Master Data › Assessments [/admin/assessments] {cms.admin}
Master Data › Businesses [/admin/businesses] {cms.admin}
Master Data › Candidates [/admin/staff/candidates] {cms.admin}
Master Data › Courses [/admin/course-fees] {cms.admin}
Master Data › Jobs [/admin/jobs] {cms.admin}
Master Data › Students [/admin/students] {cms.admin}
Sign › Requests / Pending / Completed / Templates [/admin/signing/*] {cms.admin}
Tickets [/admin/tickets] {cms.admin}
Website › Application statuses / Contact / Course Catalogue / Documents & Policies / Footer / Forms / Header & Navigation / Pages / SEO / Website Settings {cms.read}
LMS (in-app menu, not admin_menu_items): /admin/lms/courses, units, intakes, assessments, batches, timetable, timetable-create, timetable-settings, term-breaks, locations, attendance, completion, results
```

## Appendix C. Tables and columns (hosted, schemas public / hr / skyline_private / integration_private; `!` = NOT NULL)

- **hr.document_category_receipts**: object_id:uuid!, category:text!, object_version:text, passport_document_id:uuid
- **hr.employee_bank**: profile_id:uuid!, account_name:text, bsb:text, account_number:text, bank_name:text!, updated_at:timestamptz!, updated_by:uuid, account_name_enc:bytea, bsb_enc:bytea, account_number_enc:bytea
- **hr.employee_pay**: profile_id:uuid!, pay_schedule_id:uuid, pay_basis:text, rate:numeric, ordinary_hours_week:numeric, usual_work_days:_int2, award:text!, xero_employee_id:text!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid
- **hr.employment**: profile_id:uuid!, application_id:uuid, department:text!, job_title:text!, employment_type:text, joining_date:date, manager_id:uuid, work_location:text!, created_at:timestamptz!, pay_details_at:timestamptz, pay_details_by:uuid, location_id:uuid
- **hr.holiday_sync_runs**: id:int8!, triggered_by:text!, status:text!, started_at:timestamptz!, finished_at:timestamptz, started_by:uuid, years:_int4!, sources:jsonb!, inserted:int4!, updated:int4!, demoted:int4!, kept_manual:int4!, unchanged:int4!, error:text!, detail:jsonb!
- **hr.job_applications**: id:uuid!, job_id:uuid!, profile_id:uuid!, cover_letter:text!, status:text!, decided_by:uuid, decided_at:timestamptz, decision_note:text!, created_at:timestamptz!, updated_at:timestamptz!, source:text!, stage:text!, interview_at:timestamptz, interview_notes:text!, recruiter_notes:text!, cover_letter_path:text, cover_letter_filename:text, cover_letter_mime:text, cover_letter_size:int4
- **hr.jobs**: id:uuid!, title:text!, description:text!, employment_type:text!, salary:text!, location:text!, status:text!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, department:text!, vacancies:int4!, published_at:timestamptz
- **hr.leave_ledger**: id:int8!, profile_id:uuid!, leave_type_id:uuid!, entry_kind:text!, hours:numeric!, effective_date:date!, period_id:uuid, request_id:uuid, reason:text!, created_by:uuid, created_at:timestamptz!
- **hr.leave_policies**: id:uuid!, leave_type_id:uuid!, effective_from:date!, effective_to:date, hours_per_year:numeric, days_per_year:numeric, days_per_occasion:numeric, paid_days_per_occasion:numeric, accrual_fraction:numeric, qualifying_years:numeric, note:text!, created_at:timestamptz!, created_by:uuid
- **hr.leave_requests**: id:uuid!, profile_id:uuid!, leave_type_id:uuid!, start_date:date!, end_date:date!, unit:text!, quantity:numeric!, hours:numeric!, note:text!, status:text!, is_admin_entry:bool!, created_by:uuid!, created_at:timestamptz!, decided_by:uuid, decided_at:timestamptz, decision_note:text!, cancelled_at:timestamptz, cancelled_by:uuid
- **hr.leave_types**: id:uuid!, code:text!, name:text!, description:text!, is_paid:bool!, requires_balance:bool!, accrual_method:text!, sort_order:int4!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!
- **hr.locations**: id:uuid!, name:text!, address:text!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid
- **hr.optional_holiday_requests**: id:uuid!, profile_id:uuid!, holiday_id:uuid!, status:text!, note:text!, is_admin_entry:bool!, created_by:uuid!, created_at:timestamptz!, decided_by:uuid, decided_at:timestamptz, decision_note:text!, cancelled_at:timestamptz, cancelled_by:uuid
- **hr.optional_holiday_rules**: year:int4!, allowance:int4!, is_paid:bool!, updated_at:timestamptz!, updated_by:uuid
- **hr.pay_periods**: id:uuid!, schedule_id:uuid!, start_date:date!, end_date:date!, pay_date:date!, status:text!, locked_at:timestamptz, locked_by:uuid, exported_at:timestamptz, created_at:timestamptz!
- **hr.pay_schedules**: id:uuid!, name:text!, frequency:text!, anchor_date:date!, pay_date_offset_days:int4!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid
- **hr.public_holidays**: id:uuid!, holiday_date:date!, name:text!, is_optional:bool!, state:text!, status:text!, note:text!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid, source:text!, sync_source:text, synced_at:timestamptz
- **hr.recruitment_events**: id:int8!, profile_id:uuid!, application_id:uuid, actor_id:uuid, action:text!, details:jsonb!, created_at:timestamptz!
- **hr.settings**: id:bool!, timezone:text!, state:text!, ordinary_hours_week:numeric!, open_shift_flag_hours:int4!, usual_work_days:_int2!, breaks_paid:bool!, updated_at:timestamptz!, updated_by:uuid
- **hr.sign_codes**: id:int8!, recipient_id:uuid!, code_hash:text!, created_at:timestamptz!, expires_at:timestamptz!, attempts:int4!, verified_at:timestamptz, session_hash:text, session_expires_at:timestamptz, ip:text
- **hr.sign_events**: id:int8!, request_id:uuid!, event:text!, actor_id:uuid, at:timestamptz!, recipient_id:uuid, detail:jsonb!, prev_hash:text, hash:text!
- **hr.sign_fields**: id:uuid!, request_id:uuid!, recipient_id:uuid!, type:text!, page:int4!, x:numeric!, y:numeric!, w:numeric!, h:numeric!, required:bool!, label:text!, value:text, filled_at:timestamptz, key:text
- **hr.sign_notifications**: id:int8!, request_id:uuid!, recipient_id:uuid, kind:text!, audience:text!, dedupe_key:text!, state:text!, attempts:int4!, lease_until:timestamptz, message_id:text, error:text, created_at:timestamptz!, sent_at:timestamptz
- **hr.sign_rate**: key:text!, window_start:timestamptz!, hits:int4!
- **hr.sign_recipients**: id:uuid!, request_id:uuid!, role_key:text!, role_label:text!, name:text!, email:text!, signing_order:int4!, required:bool!, state:text!, sent_at:timestamptz, viewed_at:timestamptz, signed_at:timestamptz, declined_at:timestamptz, decline_reason:text, signer_name:text, consent:text, signature_kind:text, signature_image:text, signature_hash:text, ip:text, user_agent:text, delivery_error:text, last_notified_at:timestamptz, reminder_count:int4!
- **hr.sign_requests**: id:uuid!, title:text!, recipient_name:text!, recipient_email:text!, template_id:uuid, rendered_text:text, field_values:jsonb!, original_path:text!, original_hash:text!, state:text!, token_hash:text, expires_at:timestamptz, delivery_id:uuid, delivery_started_at:timestamptz, delivery_error:text, signed_path:text, signed_hash:text, signer_name:text, signed_at:timestamptz, consent:text, created_by:uuid!, created_at:timestamptz!, viewed_at:timestamptz, profile_id:uuid, edited:bool!, template_text:text, reference:text!, signing_mode:text!, subject_type:text, subject_id:uuid, tenant_id:uuid, category:text!, template_version:int4, expiry_days:int4!, reminder_days:int4!, message:text, revision:int4!, current_path:text, current_hash:text, certificate_path:text, certificate_hash:text, sent_at:timestamptz, completed_at:timestamptz, expired_at:timestamptz, closed_reason:text, offer_letter_id:uuid, require_code:bool!, agency_onboarding_id:uuid
- **hr.sign_template_parts**: id:uuid!, kind:text!, name:text!, html:text!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, deleted_at:timestamptz
- **hr.sign_template_versions**: template_id:uuid!, version:int4!, snapshot:jsonb!, created_by:uuid, created_at:timestamptz!
- **hr.sign_templates**: id:uuid!, name:text!, title:text!, body:text, created_by:uuid!, updated_at:timestamptz!, kind:text!, audience:text!, category:text!, status:text!, version:int4!, source_path:text, source_hash:text, source_pages:int4, roles:jsonb!, fields:jsonb!, signing_mode:text!, expiry_days:int4!, reminder_days:int4!, deleted_at:timestamptz, created_at:timestamptz!, body_html:text, subject:text, is_default:bool!, header_html:text, footer_html:text, bracket_variables:bool!, payment_enabled:bool!, payment_amount_cents:int4, payment_currency:text!, payment_description:text, payment_timing:text!, system_key:text, header_later_html:text, use_letterhead:bool!
- **hr.sign_token_history**: token_hash:text!, recipient_id:uuid!, retired_at:timestamptz!
- **hr.sign_tokens**: token_hash:text!, recipient_id:uuid!, notification_id:int8, created_at:timestamptz!
- **hr.staff_applications**: id:uuid!, profile_id:uuid!, requested_role:text, submitted_at:timestamptz, reviewed_by:uuid, reviewed_at:timestamptz, review_note:text!, created_at:timestamptz!, updated_at:timestamptz!, resume_path:text, resume_filename:text, resume_mime:text, resume_size:int4, resume_uploaded_at:timestamptz, account_invited_at:timestamptz, files_purged_at:timestamptz, role_type:text
- **hr.staff_audit**: id:int8!, profile_id:uuid!, actor_id:uuid, actor_kind:text!, action:text!, detail:jsonb!, created_at:timestamptz!
- **hr.staff_deletions**: id:uuid!, profile_id:uuid!, email:text, name:text, status:text, files:int4!, deleted_by:uuid!, deleted_at:timestamptz!
- **hr.staff_documents**: id:uuid!, application_id:uuid!, profile_id:uuid!, category:text!, bucket_name:text!, storage_path:text!, filename:text!, mime_type:text!, file_size:int4!, is_current:bool!, extraction_status:text!, extracted:jsonb!, extracted_at:timestamptz, extraction_error:text, created_at:timestamptz!, expiry_date:date, status:text!, review_note:text!, reviewed_by:uuid, reviewed_at:timestamptz
- **hr.staff_emails**: id:int8!, profile_id:uuid!, kind:text!, audience:text!, to_email:text, payload:jsonb!, state:text!, attempts:int4!, lease_until:timestamptz, provider_message_id:text, last_error:text, created_at:timestamptz!, sent_at:timestamptz
- **hr.staff_invites**: id:uuid!, profile_id:uuid!, purpose:text!, token_hash:text!, created_by:uuid!, created_at:timestamptz!, expires_at:timestamptz!, revoked_at:timestamptz, revoked_by:uuid, superseded_at:timestamptz, used_at:timestamptz, last_seen_at:timestamptz
- **hr.staff_offer_letters**: offer_id:uuid!, profile_id:uuid!, template_id:uuid, template_name:text!, title:text!, body_html:text!, field_values:jsonb!, created_at:timestamptz!, created_by:uuid, edited:bool!, template_html:text
- **hr.staff_offers**: id:uuid!, profile_id:uuid!, storage_path:text!, filename:text!, file_size:int4!, sha256:text!, uploaded_by:uuid!, uploaded_at:timestamptz!, sent_at:timestamptz, sent_by:uuid, withdrawn_at:timestamptz, withdrawn_by:uuid, signed_at:timestamptz, signer_name:text, consent_text:text, signer_ip:text, signer_user_agent:text, signed_path:text, signed_sha256:text, declined_at:timestamptz, decline_reason:text
- **hr.staff_profiles**: id:uuid!, auth_user_id:uuid, first_name:text!, middle_name:text!, last_name:text!, date_of_birth:date, email:text, phone_e164:text, address_street:text!, address_line2:text!, address_suburb:text!, address_state:text!, address_postcode:text!, address_country:text!, emergency_name:text!, emergency_relationship:text!, emergency_phone_e164:text, status:text!, status_changed_at:timestamptz!, created_at:timestamptz!, updated_at:timestamptz!, is_australian_citizen:bool, nationality:text!, passport_number:text!, visa_subclass:text!, visa_conditions:text!, tax_residency:text!, tax_free_threshold:text!, study_loan:text!, super_choice:text!, super_fund_name:text!, super_fund_abn:text!, super_usi:text!, super_member_number:text!
- **hr.staff_role_types**: key:text!, label:text!, access:text!, is_system:bool!, created_by:uuid, created_at:timestamptz!
- **hr.staff_roles**: id:uuid!, profile_id:uuid!, role:text!, granted_by:uuid!, granted_at:timestamptz!, revoked_at:timestamptz, revoked_by:uuid, role_type:text
- **hr.staff_section_checks**: profile_id:uuid!, section:text!, verified_by:uuid!, verified_at:timestamptz!
- **hr.staff_signed_uploads**: id:uuid!, profile_id:uuid!, title:text!, file_name:text!, storage_path:text!, size_bytes:int8!, uploaded_by:uuid, created_at:timestamptz!
- **hr.staff_status_events**: id:int8!, profile_id:uuid!, from_status:text, to_status:text!, actor_id:uuid, actor_kind:text!, note:text!, created_at:timestamptz!
- **hr.time_events**: id:uuid!, profile_id:uuid!, kind:text!, at:timestamptz!, source:text!, supersedes:uuid, reason:text!, recorded_by:uuid!, recorded_at:timestamptz!
- **hr.timesheet_approvals**: id:uuid!, period_id:uuid!, profile_id:uuid!, status:text!, decided_by:uuid!, decided_at:timestamptz!, note:text!
- **hr.xero_exports**: id:uuid!, period_id:uuid!, exported_by:uuid!, exported_at:timestamptz!, employee_count:int4!, line_count:int4!, lines:jsonb!, csv:text!
- **integration_private.credentials**: connection_id:uuid!, kind:text!, vault_id:uuid!, updated_at:timestamptz!
- **integration_private.oauth_states**: state_hash:text!, connection_id:uuid!, user_id:uuid!, connection_version:timestamptz!, expires_at:timestamptz!
- **integration_private.refresh_leases**: connection_id:uuid!, lease_id:uuid!, connection_version:timestamptz!, expires_at:timestamptz!
- **public.abr_businesses**: abn:text!, abn_status:text!, abn_status_from:date, record_last_updated:date!, replaced:bool!, entity_type_code:text, entity_type:text, main_name:text, other_names:_text, acn:text, gst_status:text, gst_status_from:date, state:text, postcode:text, synced_at:timestamptz!
- **public.abr_lookups**: abn:text!, raw:jsonb!, details:jsonb!, fetched_at:timestamptz!, fetched_by:uuid
- **public.abr_sync_runs**: id:int8!, started_at:timestamptz!, finished_at:timestamptz, status:text!, mode:text, cutoff_date:date, records_seen:int8, records_upserted:int8, error:text
- **public.academic_breaks**: id:uuid!, label:text!, start_date:date!, end_date:date!, created_at:timestamptz!, updated_by:uuid, course_id:text!, source:text!
- **public.admin_menu_items**: id:text!, parent_id:text, label:text!, route:text, icon_key:text!, sort_order:int4!, is_enabled:bool!, permission_key:text!, permission_scope:text!, is_system:bool!, open_in_new_tab:bool!, created_at:timestamptz!, updated_at:timestamptz!
- **public.admin_view_accounts**: kind:text!, email:text!, auth_user_id:uuid!, created_at:timestamptz!
- **public.admin_view_agent_logins**: agent_id:uuid!, auth_user_id:uuid!, profile_id:uuid!, created_by:uuid!, created_at:timestamptz!
- **public.admin_view_events**: id:uuid!, admin_auth_user:uuid!, admin_name:text!, kind:text!, created_at:timestamptz!, target_auth_user:uuid, target_name:text, target_type:text, agent_id:uuid, business_id:uuid, ended_at:timestamptz
- **public.admission_event_outbox**: id:uuid!, receipt_id:uuid, application_id:uuid!, tenant_id:uuid, event:text!, payload:jsonb!, created_at:timestamptz!, delivered_at:timestamptz
- **public.admission_submission_receipts**: id:uuid!, application_id:uuid!, tenant_id:uuid, version:int4!, request_key:text!, reference:text!, actor:uuid!, submitted_at:timestamptz!
- **public.agencies**: id:uuid!, name:text!, code:text!, registration_number:text!, business_email:text!, phone:text!, address:text!, country:text!, primary_contact:text!, status:text!, created_at:timestamptz!, updated_at:timestamptz!, is_permanent:bool!, directory_key:text, is_direct:bool!, registration_requested_at:timestamptz, registration_reviewed_at:timestamptz, registration_reviewed_by:uuid, registration_decision:text, onboarding_completed_at:timestamptz, profile:jsonb!, agreement_status:text!, agreement_commencement_date:date, agreement_expiry_date:date, agreement_onboarding_id:uuid, abr_raw:jsonb, abr_details:jsonb, abr_fetched_at:timestamptz, abr_confirmed:jsonb, acn:text, acn_source:text
- **public.agency_invitations**: id:uuid!, agency_id:uuid!, email:text!, full_name:text!, role:text!, status:text!, invited_by:uuid, invited_by_name:text!, expires_at:timestamptz!, sent_count:int4!, last_sent_at:timestamptz!, accepted_at:timestamptz, revoked_at:timestamptz, created_at:timestamptz!, phone:text!, student_id:uuid, link_token_hash:text, link_sent_at:timestamptz, link_confirmed_at:timestamptz
- **public.agency_memberships**: id:uuid!, user_id:uuid!, agency_id:uuid!, role:text!, status:text!, created_at:timestamptz!, updated_at:timestamptz!, is_test:bool!, student_id:uuid
- **public.agency_onboarding**: id:uuid!, agency_id:uuid!, agent_id:uuid!, request_id:uuid, status:text!, commencement_date:date, expiry_date:date, territory:text!, commission_percent:numeric, admin_name:text!, admin_position:text!, form_pages:int4!, sent_values:jsonb!, answers:jsonb!, form_content:bytea, agreement_content:bytea, certificate_content:bytea, signed_at:timestamptz, signer_name:text, closed_reason:text, sent_by:uuid, created_at:timestamptz!, stage:text!, application_request_id:uuid, agreement_request_id:uuid, application_certificate_content:bytea, application_signed_at:timestamptz, references_received_at:timestamptz, override_reason:text, override_by:uuid, override_at:timestamptz, message:text, approved_by:uuid, approved_at:timestamptz, declined_by:uuid, declined_at:timestamptz, decline_reason:text, activated_at:timestamptz, activation_invitation_id:uuid, kind:text!, agreement_uploaded_at:timestamptz, agreement_uploaded_by:uuid, agreement_upload_reason:text, agreement_file_name:text, prefill:jsonb, combined:bool!, presend:jsonb, presend_saved_at:timestamptz, presend_saved_by:uuid, witness_name:text, witness_png:text, witness_by:text, witness_box:jsonb, signature_event:jsonb, agreement_issued_at:timestamptz, agreement_issued_by:uuid, slit_witness_name:text, slit_witness_png:text, split_pending:bool!, commission_gst:text, slit_signature:text, slit_signature_kind:text, slit_signed_on:date
- **public.agency_onboarding_attachments**: request_id:uuid!, kind:text!, file_name:text!, content_type:text!, size_bytes:int4!, sha256:text!, content:bytea!, uploaded_at:timestamptz!
- **public.agency_onboarding_blank_cache**: cache_key:text!, path:text!, sha256:text!, pages:int4!, created_at:timestamptz!
- **public.agency_onboarding_corrections**: id:uuid!, onboarding_id:uuid!, round:int4!, message:text, flags:jsonb!, request_id:uuid, previous_request_id:uuid, previous_stage:text!, status:text!, changes:jsonb!, requested_by:uuid, requested_by_name:text, requested_at:timestamptz!, resubmitted_at:timestamptz, closed_at:timestamptz, closed_reason:text
- **public.agency_onboarding_drafts**: request_id:uuid!, recipient_id:uuid!, draft:jsonb!, saved_at:timestamptz!
- **public.agency_onboarding_events**: id:int8!, onboarding_id:uuid!, at:timestamptz!, actor:uuid, actor_name:text!, event:text!, detail:jsonb!
- **public.agency_onboarding_referees**: id:uuid!, onboarding_id:uuid!, position:int4!, contact_name:text!, organisation:text!, position_title:text!, email:text!, phone:text!, address:text!, status:text!, request_id:uuid, domain_warning:bool!, received_at:timestamptz, received_via:text, form_content:bytea, certificate_content:bytea, answers:jsonb!, file_name:text, uploaded_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.agency_onboarding_revisions**: id:uuid!, onboarding_id:uuid!, revision:int4!, kind:text!, request_id:uuid, note:text, changes:jsonb!, content:bytea!, sha256:text!, created_by:uuid, created_by_name:text, created_at:timestamptz!
- **public.agency_tenant_agents**: tenant_id:uuid!, agency_id:uuid!, profile_id:uuid!, active:bool!, updated_at:timestamptz!
- **public.agency_tenants**: agency_id:uuid!, tenant_id:uuid!, active:bool!
- **public.agent_commissions**: id:uuid!, tenant_id:uuid, agency_id:uuid!, agent_id:uuid, student_id:uuid, intake_enrolment_id:uuid, payment_id:uuid, benefit_type:text!, description:text, amount_cents:int4!, gst_cents:int4!, currency:text!, paid_on:date!, source:text!, external_reference:text, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.agent_office365_accounts**: agent_id:uuid!, upn:text!, ms_user_id:text, status:text!, licence_sku:text, last_error:text, welcome_sent_at:timestamptz, linked:bool!, account_created_at:timestamptz, licence_assigned_at:timestamptz, groups_added_at:timestamptz, groups_error:text, welcome_error:text, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.agents**: id:uuid!, business_id:uuid!, profile_id:uuid, full_name:text!, email:text!, phone:text!, marn:text!, role:text!, status:text!, status_changed_at:timestamptz, status_changed_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.application_admin_changes**: id:uuid!, application_id:uuid!, tenant_id:uuid, source:text!, field:text!, old_value:jsonb, new_value:jsonb, changed_by:uuid, changed_by_name:text!, changed_at:timestamptz!
- **public.application_declaration_texts**: key:text!, version:text!, title:text!, body:text!, sort:int2!, active:bool!, hash:text!, created_at:timestamptz!
- **public.application_form_used**: application_id:uuid!, version:int4!, template_id:uuid, template_version:int4, template_name:text!, title:text!, header_html:text, body_html:text!, footer_html:text, created_at:timestamptz!, header_later_html:text
- **public.application_signatures**: id:uuid!, application_id:uuid!, signer_role:text!, signer_name:text!, signer_user_id:uuid, png:text!, ip:text, user_agent:text, signed_at:timestamptz!
- **public.application_signed_copies**: application_id:uuid!, version:int4!, file_name:text!, content:bytea!, created_at:timestamptz!
- **public.application_status_transitions**: from_status:text!, action_key:text!, to_status:text, actor:text!, label:text!, kind:text!, note:text!, tone:text!, sort:int4!, is_active:bool!, is_automatic:bool!, is_primary:bool!, requires_reason:bool!, allowed_roles:_text!, icon:text!
- **public.application_statuses**: value:text!, label:text!, sort:int4!, tone:text!, hint:text!, editable:bool!, legacy:bool!, color:text!, is_final:bool!, is_active:bool!
- **public.application_usi**: application_id:uuid!, usi:text, status:text, usi_status:text, first_name_match:text, family_name_match:text, single_name_match:text, dob_match:text, verified_at:timestamptz, environment:text, verified_by:uuid, verified_by_name:text, verified_by_role:text, person_hash:text, locate_result:text, located_at:timestamptz, created_usi_at:timestamptz, create_document_type:text, create_request_id:text, consent_at:timestamptz, consent_by:uuid, consent_by_name:text, consent_role:text, create_requested_at:timestamptz, last_error:text, last_error_at:timestamptz, reverify_attempts:int4!, reverify_next_at:timestamptz, reverify_last_error:text, updated_at:timestamptz!
- **public.asm_ai_usage**: id:uuid!, tenant_id:uuid, assessment_id:uuid, pdf_sha256:text!, action:text!, model:text!, page:int4, candidates:int4!, input_tokens:int4!, output_tokens:int4!, cost_usd:numeric!, refused:int4!, created_by:uuid, created_at:timestamptz!
- **public.asm_assessments**: id:uuid!, tenant_id:uuid, course_id:text!, unit_id:text, code:text, title:text!, description:text!, is_template:bool!, current_version_id:uuid, settings_override:jsonb!, archived_at:timestamptz, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_assignment_students**: assignment_id:uuid!, student_id:uuid!, excluded:bool!, added_manually:bool!, due_at:timestamptz, note:text!, updated_by:uuid, updated_at:timestamptz!
- **public.asm_assignment_trainers**: assignment_id:uuid!, staff_id:uuid!
- **public.asm_assignments**: id:uuid!, tenant_id:uuid, assessment_id:uuid!, version_id:uuid!, available_from:timestamptz!, due_at:timestamptz!, late_until:timestamptz, status:text!, reassign_rule:text!, notes:text!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, intake_id:uuid!, intake_unit_id:uuid, window_from_master:bool!
- **public.asm_attempt_outputs**: attempt_id:uuid!, kind:text!, tenant_id:uuid, path:text!, pdf_sha256:text!, snapshot_hash:text!, created_by:uuid!, created_at:timestamptz!, marking:jsonb!, marking_hash:text!, acknowledgement:jsonb!, acknowledgement_hash:text!
- **public.asm_attempt_signatures**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, kind:text!, signer_user:uuid!, signer_role:text!, signer_name:text!, method:text!, signature_png:text, statement:text!, signed_at:timestamptz!, login:jsonb!
- **public.asm_attempt_snapshots**: attempt_id:uuid!, tenant_id:uuid, version_id:uuid!, template_sha256:text!, answers:jsonb!, signatures:jsonb!, record:jsonb!, hash:text!, created_at:timestamptz!
- **public.asm_attempts**: id:uuid!, tenant_id:uuid, assignment_id:uuid!, version_id:uuid!, student_id:uuid!, attempt_no:int4!, state:text!, responses:jsonb!, assessor_responses:jsonb!, responses_hash:text, declaration:jsonb, receipt_no:text, due_at:timestamptz, outcome:text, overall_feedback:text!, started_at:timestamptz!, submitted_at:timestamptz, marking_started_at:timestamptz, returned_at:timestamptz, finalised_at:timestamptz, voided_at:timestamptz, void_reason:text, marked_by:uuid, row_version:int4!, created_at:timestamptz!, updated_at:timestamptz!, acknowledged_at:timestamptz, submit_request_id:text, marked_on:date, qualification_id:uuid
- **public.asm_audit_log**: id:int8!, tenant_id:uuid, actor:uuid, actor_role:text!, action:text!, target_type:text!, target_id:text!, detail:jsonb!, created_at:timestamptz!
- **public.asm_evidence_files**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, question_id:text!, group_index:int4, by_assessor:bool!, object_path:text!, file_name:text!, mime:text!, bytes:int4!, sha256:text, uploaded_by:uuid, created_at:timestamptz!
- **public.asm_feedback**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, question_id:text, author:uuid!, author_role:text!, body:text!, created_at:timestamptz!
- **public.asm_layout_profiles**: id:uuid!, tenant_id:uuid, signature:text!, chrome:jsonb!, corrections:jsonb!, sample_assessment_id:uuid, updated_by:uuid, updated_at:timestamptz!, created_at:timestamptz!
- **public.asm_mapping_suggestions**: id:uuid!, assessment_id:uuid!, question_id:text!, element_id:uuid!, confidence:numeric!, reason:text!, model:text, state:text!, suggested_at:timestamptz!, decided_by:uuid, decided_at:timestamptz
- **public.asm_notifications**: id:uuid!, tenant_id:uuid, recipient_auth_user:uuid!, recipient_role:text!, event:text!, title:text!, body:text!, attempt_id:uuid, assignment_id:uuid, read_at:timestamptz, created_at:timestamptz!
- **public.asm_pdf_signatures**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, slot:text!, signer_user:uuid!, signer_name:text!, method:text!, signature_png:text, statement:text!, login:jsonb, signed_at:timestamptz!
- **public.asm_reassessments**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, student_id:uuid!, requested_by:uuid!, requested_role:text!, reason:text!, state:text!, new_due_at:timestamptz, next_attempt_id:uuid, decided_by:uuid, decided_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_results**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, question_id:text!, criterion_id:text, suggested_outcome:text, suggested_detail:jsonb, outcome:text, score:numeric, rubric_level_id:text, feedback:text!, marked_by:uuid, marked_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_saved_signatures**: user_id:uuid!, signature_png:text!, method:text!, updated_at:timestamptz!
- **public.asm_schedule_events**: id:uuid!, tenant_id:uuid, assignment_id:uuid!, kind:text!, title:text!, starts_at:timestamptz!, ends_at:timestamptz, room_id:uuid, trainer_staff_id:uuid, notes:text!, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_settings**: id:uuid!, tenant_id:uuid, max_attempts:int4!, reassessment_days:int4!, late_submission:text!, rollup_rule:text!, due_soon_days:int4!, declaration_text:text!, instructions:text!, evidence_max_mb:int4!, evidence_allowed_types:_text!, updated_by:uuid, updated_at:timestamptz!, require_trainer_role:bool!, workbook_header_url:text
- **public.asm_task_results**: id:uuid!, tenant_id:uuid, attempt_id:uuid!, task_id:text!, rollup_suggested:text, outcome:text, feedback:text!, signed_by:uuid, signed_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_unit_elements**: id:uuid!, tenant_id:uuid, unit_id:text!, kind:text!, parent_id:uuid, code:text!, text:text!, sort:int4!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!
- **public.asm_unit_mappings**: id:uuid!, tenant_id:uuid, version_id:uuid!, question_id:text!, criterion_id:text, element_id:uuid!, created_at:timestamptz!
- **public.asm_unit_outcomes**: id:uuid!, tenant_id:uuid, student_id:uuid!, unit_id:text!, assessment_id:uuid, outcome:text!, evidence_attempt_ids:_uuid!, signed_by:uuid!, signed_staff_id:uuid, signed_role:text!, signed_name:text!, signed_at:timestamptz!, notes:text!, supersedes_id:uuid, created_at:timestamptz!, intake_id:uuid
- **public.asm_versions**: id:uuid!, tenant_id:uuid, assessment_id:uuid!, version_no:int4!, status:text!, definition:jsonb!, checksum:text, published_at:timestamptz, published_by:uuid, retired_at:timestamptz, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, template:jsonb
- **public.australian_course_catalogue**: id:uuid!, course_code:text!, course_name:text!, course_type:text!, aqf_level:text, training_package_code:text, training_package_name:text, national_status:text!, release_number:text, description:text, entry_requirements:text, packaging_rules:text, total_units:int4, core_units_count:int4, elective_units_count:int4, supersedes_code:text, superseded_by_code:text, source:text!, source_url:text, source_updated_at:timestamptz, last_synced_at:timestamptz!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!, nrt_id:text, qualification_level_code:text, release_date:date, currency_start_date:date, currency_end_date:date, usage_recommendation:text, recognition_manager_code:text, recognition_manager_name:text, anzsco_code:text, anzsco_name:text, field_of_education_code:text, field_of_education_name:text, website_enabled:bool!, admissions_enabled:bool!, domestic_enabled:bool!, international_enabled:bool!, cms_course_id:text, skyline_updated_at:timestamptz, skyline_updated_by:uuid
- **public.australian_course_catalogue_sync_runs**: id:int8!, started_at:timestamptz!, finished_at:timestamptz, status:text!, source:text!, filter:text!, page_size:int4!, request_ids:_int8!, source_total:int4, received:int4, inserted:int4, updated:int4, not_in_source:int4, error:text
- **public.avetmiss_code_aliases**: code_set:text!, alias:text!, code:text!
- **public.avetmiss_codes**: code_set:text!, code:text!, label:text!, sort:int4!, is_active:bool!, created_at:timestamptz!
- **public.avetmiss_outcome_reconcile**: id:uuid!, outcome_id:uuid!, student_id:uuid!, unit_id:text!, intake_id:uuid, reason:text!, matches:int4!, created_at:timestamptz!, resolved_at:timestamptz, resolved_by:uuid, resolution_note:text
- **public.axcelerate_api_calls**: id:uuid!, connection_id:uuid!, user_id:uuid, method:text!, path:text!, http_status:int4, created_at:timestamptz!
- **public.batch_assignment_log**: id:int8!, enrolment_id:uuid, student_id:uuid, unit_id:text, from_batch_id:uuid, to_batch_id:uuid, action:text!, reason:text, by_user:uuid, at:timestamptz!
- **public.batch_students**: id:uuid!, enrolment_id:uuid!, batch_id:uuid!, unit_id:text, assigned_at:timestamptz!, assigned_by:uuid, archived_at:timestamptz, archive_reason:text
- **public.booking_availability**: id:int8!, user_id:uuid, weekday:int2!, start_time:time!, end_time:time!, room_id:uuid, staff_id:uuid
- **public.booking_hosts**: user_id:uuid!, handle:text!, display_name:text!, email:text!, kind:text!, headline:text!, timezone:text!, is_enabled:bool!, is_listed:bool!, created_at:timestamptz!, updated_at:timestamptz!
- **public.booking_time_off**: id:int8!, user_id:uuid, start_date:date!, end_date:date!, note:text!, room_id:uuid, staff_id:uuid
- **public.booking_types**: id:uuid!, user_id:uuid!, slug:text!, name:text!, description:text!, duration_min:int4!, location_kind:text!, location_detail:text!, location_id:uuid, buffer_min:int4!, min_notice_hours:int4!, max_days_ahead:int4!, requires_login:bool!, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!
- **public.bookings**: id:uuid!, type_id:uuid!, host_user:uuid!, starts_at:timestamptz!, ends_at:timestamptz!, status:text!, booker_user:uuid, booker_name:text!, booker_email:text!, booker_phone:text!, booker_timezone:text!, note:text!, type_name:text!, location_text:text!, token_hash:text!, cancelled_at:timestamptz, cancelled_by:text, cancel_reason:text, reschedule_count:int4!, created_at:timestamptz!, updated_at:timestamptz!
- **public.brand_letterheads**: id:uuid!, name:text!, style:text!, designer:text!, spec:jsonb!, html:jsonb!, targets:_text!, active:bool!, applied_by:uuid, applied_at:timestamptz!
- **public.business_deletions**: id:int8!, deleted_at:timestamptz!, deleted_by:uuid, deleted_by_name:text, business_name:text!, abn:text
- **public.business_documents**: id:uuid!, business_id:uuid!, kind:text!, file_name:text!, storage_path:text!, size_bytes:int8!, uploaded_by:uuid, created_at:timestamptz!, reason:text
- **public.business_rule_actions**: version_id:uuid!, branch:text!, handler:text!
- **public.business_rule_audit_logs**: id:uuid!, scope_key:text!, rule_id:uuid, action:text!, actor:uuid, reason:text!, before_data:jsonb, after_data:jsonb, created_at:timestamptz!
- **public.business_rule_categories**: id:uuid!, scope_key:text!, name:text!
- **public.business_rule_conditions**: version_id:uuid!, group_order:int4!, condition_order:int4!, field_key:text!, comparison:text!, operand:jsonb
- **public.business_rule_field_registry**: scope:text!, key:text!, label:text!, value_type:text!
- **public.business_rule_versions**: id:uuid!, rule_id:uuid!, version:int4!, state:text!, origin:text!, definition:jsonb!, starts_on:date!, ends_on:date, created_by:uuid, created_at:timestamptz!, approved_by:uuid, published_by:uuid, published_at:timestamptz
- **public.business_rules**: id:uuid!, scope_key:text!, identifier:text!, registration:jsonb
- **public.class_reschedule_rules**: id:uuid!, course_id:text, rules:jsonb!, updated_at:timestamptz!, updated_by:uuid
- **public.class_session_changes**: id:int8!, session_id:uuid!, intake_id:uuid!, kind:text!, reason_key:text, reason_label:text, note:text, step:text, old:jsonb, new:jsonb, notified:int4!, by_user:uuid, by_name:text, at:timestamptz!
- **public.class_sessions**: id:uuid!, session_date:date!, start_time:time!, end_time:time!, session_type:text!, room_id:uuid, unit_id:text, status:text!, is_manual:bool!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid, intake_id:uuid!, trainer_id:uuid, needs_reschedule:bool!, reschedule_reason:text, reschedule_note:text, made_up_by:text, joined_session_id:uuid, delivery:text!, batch_id:uuid!
- **public.classrooms**: id:uuid!, name:text!, campus:text, capacity:int4, is_active:bool!, created_at:timestamptz!, location_id:uuid, sort:int4!
- **public.cms_activity_log**: id:text!, user:text, action:text!, item:text!, area:text!, at:timestamptz!, tenant_id:uuid
- **public.cms_course_attachments**: id:text!, course_id:text!, name:text!, url:text!, sort:int4!, original_file_name:text, storage_file_name:text, bucket_name:text, storage_path:text, mime_type:text, file_size:int8, created_at:timestamptz!, legacy_url:text, migration_status:text, migration_error:text, migrated_at:timestamptz, tenant_id:uuid
- **public.cms_course_links**: id:text!, course_id:text!, label:text!, url:text!, external:bool!, sort:int4!, tenant_id:uuid
- **public.cms_course_sections**: id:text!, course_id:text!, title:text!, body:text!, sort:int4!, tenant_id:uuid
- **public.cms_course_units**: id:text!, course_id:text!, code:text!, name:text!, category:text!, sort:int4!, tenant_id:uuid, unit_type:text!, default_weeks:int4!, nominal_hours:int4, is_active:bool!, duration_weeks:numeric, nominal_hours_source:text, has_prerequisites:bool, elective_groups:text, usage_recommendation:text, tga_release_number:text, tga_release_date:date, tga_application:text, tga_unit_sector:text, tga_prerequisites:text, tga_supersedes_code:text, tga_supersedes_title:text, tga_supersedes_equivalent:bool, tga_developer:text, tga_companion_url:text, tga_synced_at:timestamptz, slit_hours:int4, theory_hours:int4, practical_hours:int4, assessment_hours:int4, hours_confirmed_at:timestamptz, hours_confirmed_by:uuid, prerequisite_ids:_text!, field_of_education_code:text, vet_flag:bool!, avetmiss_nominal_hours:int4, archived_at:timestamptz
- **public.cms_courses**: id:text!, slug:text!, code:text!, cricos:text!, name:text!, category:text!, training_package:text!, duration:text!, mode:text!, short_description:text!, full_description:text!, entry_requirements:text!, career:text!, fees:text!, image:text!, status:text!, display_order:int4!, featured:bool!, updated_at:timestamptz!, updated_by:text, tenant_id:uuid, tga_url:text, campus:text, is_active:bool!, show_fees:bool!, fee_note:text, seo_title:text, seo_description:text, homepage_carousel:bool!, variant_label:text, tga_training_package_code:text, tga_national_status:text, tga_release_number:text, tga_release_date:date, tga_packaging_rules:text, tga_anzsco_code:text, tga_anzsco_title:text, tga_field_of_education_code:text, tga_field_of_education:text, tga_qualification_level:text, tga_developer:text, tga_developer_url:text, tga_usage_recommendation:text, tga_supersedes_code:text, tga_supersedes_title:text, tga_supersedes_equivalent:bool, tga_specialisation_code:text, tga_specialisation_title:text, tga_core_units:int4, tga_elective_units:int4, tga_occupations:jsonb, tga_industry_sectors:jsonb, tga_foundation_skills:text, tga_documents:jsonb, tga_companion_url:text, tga_imported_at:timestamptz, cricos_provider_code:text, cricos_registered:bool, cricos_duration_weeks:int4, cricos_tuition_fee:numeric, cricos_non_tuition_fee:numeric, cricos_total_cost:numeric, cricos_course_level:text, cricos_field_of_education:text, cricos_work_component:text, cricos_language:text, cricos_dual_qualification:bool, cricos_locations:jsonb, cricos_checked_at:timestamptz, cricos_course_code:text, cricos_course_name:text, cricos_vet_national_code:text, cricos_foe1_broad:text, cricos_foe1_broad_code:text, cricos_foe1_narrow:text, cricos_foe1_narrow_code:text, cricos_foe1_detailed:text, cricos_foe1_detailed_code:text, cricos_foe2_broad:text, cricos_foe2_broad_code:text, cricos_foe2_narrow:text, cricos_foe2_narrow_code:text, cricos_foe2_detailed:text, cricos_foe2_detailed_code:text, cricos_foundation_studies:bool, cricos_has_work_component:bool, cricos_work_component_hours_week:int4, cricos_work_component_weeks:int4, cricos_work_component_total_hours:int4, cricos_expired:bool, institution_name:text, institution_trading_name:text, institution_type:text, institution_capacity:int4, institution_website:text, institution_postal_address_line_1:text, institution_postal_address_line_2:text, institution_postal_address_line_3:text, institution_postal_address_line_4:text, institution_postal_city:text, institution_postal_state:text, institution_postal_postcode:text, cricos_snapshot:jsonb, cricos_fetched_at:timestamptz, cricos_edited_fields:_text!, archived_at:timestamptz, delivery_mode_identifier:text, predominant_delivery_mode:text, avetmiss_level_code:text, avetmiss_recognition_code:text, wizard_locked_by:uuid, wizard_locked_at:timestamptz
- **public.cms_documents**: id:text!, name:text!, category:text!, description:text!, file_name:text!, url:text!, size_label:text!, docs_count:int4!, status:text!, display_order:int4!, original_file_name:text, storage_file_name:text, bucket_name:text, storage_path:text, mime_type:text, file_size:int8, created_at:timestamptz!, assistant_publication_approved:bool!, tenant_id:uuid
- **public.cms_edit_state**: scope_key:text!, tenant_id:uuid, version:int8!
- **public.cms_footer**: id:int2!, about:text!, quick_links_title:text!, student_links_title:text!, acknowledgement:text!, copyright:text!, show_acknowledgement:bool!, tenant_id:uuid, quick_links:jsonb!, student_links:jsonb!, links_configured:bool!, show_flags:bool!, aboriginal_flag_url:text!, torres_strait_flag_url:text!
- **public.cms_form_fields**: id:text!, form_id:text!, label:text!, type:text!, required:bool!, help:text!, options:jsonb!, visible:bool!, sort:int4!, config:jsonb, tenant_id:uuid
- **public.cms_forms**: id:text!, name:text!, description:text!, status:text!, updated_at:timestamptz!, tenant_id:uuid, submit_url:text!, submission_approved:bool!
- **public.cms_integration_secrets**: id:uuid!, tenant_id:uuid, provider:text!, secret:text!, updated_at:timestamptz!, updated_by:uuid
- **public.cms_navigation_items**: id:text!, parent_id:text, label:text!, to_path:text!, external:bool!, visible:bool!, sort:int4!, tenant_id:uuid
- **public.cms_pages**: id:text!, name:text!, slug:text!, title:text!, body:text!, in_nav:bool!, seo_title:text!, seo_description:text!, status:text!, updated_at:timestamptz!, updated_by:text, tenant_id:uuid
- **public.cms_revisions**: id:text!, entity:text!, entity_id:text!, title:text!, action:text!, status:text!, by:text, at:timestamptz!, snapshot:jsonb, tenant_id:uuid
- **public.cms_seo**: id:text!, page:text!, path:text!, title:text!, description:text!, keywords:text!, tenant_id:uuid
- **public.cms_settings**: id:int2!, name:text!, short_name:text!, logo:text!, favicon:text!, phone:text!, email:text!, admissions_email:text!, address:text!, rto:text!, cricos:text!, sign_in_url:text!, updated_at:timestamptz!, updated_by:text, home_hero_images:jsonb!, home_about_image:text!, tenant_id:uuid, primary_color:text!, heading_font:text!, body_font:text!, map_embed_src:text!, theme_configured:bool!, accent_color:text, loader_style:text!, courses_carousel_auto:bool!, courses_carousel_interval_seconds:int4!, courses_carousel_pause_on_hover:bool!, courses_carousel_motion:text!, courses_carousel_drift_speed:text!, timezone:text!, calendly_url:text!, abn:text, website:text, offer_validity_days:int4!, letter_date_format:text!, legal_name:text, avetmiss_toid:text, avetmiss_legal_name:text, avetmiss_org_type_code:text, avetmiss_address_line1:text, avetmiss_address_line2:text, avetmiss_suburb:text, avetmiss_postcode:text, avetmiss_state_code:text, avetmiss_contact_name:text, avetmiss_contact_phone:text, avetmiss_contact_email:text, org_acn:text, org_entity_name:text, org_entity_type:text, org_trading_names:text, org_abn_status:text, org_abn_status_from:date, org_gst_status:text, org_gst_from:date, org_register_state:text, org_register_postcode:text, org_abr_url:text, org_abr_checked_at:timestamptz, org_place_name:text, org_place_address:text, org_place_street:text, org_place_suburb:text, org_place_state:text, org_place_postcode:text, org_place_country:text, org_place_website:text, org_place_phone:text, org_place_phone_international:text, org_place_maps_url:text, org_place_id:text, org_place_business_status:text, org_place_match_percent:int2, org_place_checked_at:timestamptz
- **public.cms_social_links**: id:text!, settings_id:int2!, label:text!, href:text!, sort:int4!, icon:text!, visible:bool!, tenant_id:uuid
- **public.cms_users**: id:text!, name:text!, email:text!, role:text!, status:text!, last_login:text, created_at:timestamptz!, auth_user_id:uuid, must_change_password:bool!, rto_manager:bool!, ui_prefs:jsonb!, signature_png:text, signature_updated_at:timestamptz, mobile:text
- **public.comm_conversations**: id:uuid!, person_kind:text!, person_ref:uuid, display_name:text!, email:text, phone:text, last_message_at:timestamptz, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.comm_messages**: id:uuid!, conversation_id:uuid!, direction:text!, channel:text!, subject:text!, body:text!, template_key:text, to_address:text, status:text!, email_delivery_id:uuid, provider_message_id:text, sent_by:uuid, sent_by_name:text, created_at:timestamptz!, provider_request_id:int8, team_id:uuid
- **public.comm_team_members**: team_id:uuid!, cms_user_id:text!, added_by:uuid, added_at:timestamptz!, last_read_at:timestamptz
- **public.comm_team_messages**: id:uuid!, team_id:uuid!, author_cms_user_id:text, author_name:text!, body:text!, created_at:timestamptz!, microsoft_request_id:int8
- **public.comm_team_microsoft**: team_id:uuid!, connected_by:uuid, connected_at:timestamptz!, channel_name:text!
- **public.comm_teams**: id:uuid!, name:text!, description:text!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, archived_at:timestamptz
- **public.communication_templates**: id:uuid!, key:text!, name:text!, category:text!, audience:text!, description:text!, subject:text!, body:text!, channels:_text!, status:text!, is_system:bool!, created_by:uuid, updated_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.course_class_defaults**: course_id:text!, seats:int4, classroom_id:uuid, sessions:jsonb!, updated_at:timestamptz!, updated_by:uuid
- **public.course_coe_timetables**: course_id:text!, start_date:date!, updated_at:timestamptz!, updated_by:uuid, cycles_planned:int4!
- **public.course_coe_units**: id:uuid!, course_id:text!, cycle:int4!, unit_id:text!, weeks:numeric!, sort:int4!, start_date:date!, end_date:date!
- **public.course_completions**: id:uuid!, enrolment_id:uuid!, student_id:uuid!, course_id:text!, kind:text!, certificate_no:text!, student_name:text!, course_code:text!, course_name:text!, units:jsonb!, issued_at:timestamptz!, issued_by:uuid, issued_by_name:text!, revoked_at:timestamptz, revoked_by:uuid, revoke_reason:text, intake_id:uuid
- **public.course_fee_items**: id:uuid!, course_id:text!, intake_id:uuid, item_type:text!, label:text!, amount_cents:int8!, sort:int4!, updated_at:timestamptz!, updated_by:uuid, included_in_total:bool!, refundable:bool!, gst_treatment:text!
- **public.course_fee_setups**: id:uuid!, tenant_id:uuid, course_id:text!, intake_id:uuid, tuition_fee:numeric, enrolment_fee:numeric, material_fee:numeric, oshc_fee:numeric, deposit:numeric, payment_plan:text, campus:text, updated_at:timestamptz!, updated_by:uuid, orientation:text, hours_per_week:text, total_fee:numeric, orientation_date:date
- **public.course_holiday_teaching**: course_id:text!, holiday_date:date!, created_by:uuid, created_at:timestamptz!
- **public.course_intakes**: id:uuid!, course_id:text!, start_date:date!, end_date:date, label:text, is_active:bool!, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid, name:text, campus:text, capacity:int4, status:text!, study_load:text!, auto_created:bool!, classroom_id:uuid, class_days:_text!, start_time:time, end_time:time, wizard_pending:bool!, archived_at:timestamptz, archive_reason:text
- **public.course_locations**: id:uuid!, tenant_id:uuid, course_id:text!, location_name:text!, location_type:text, address_line_1:text, address_line_2:text, address_line_3:text, address_line_4:text, city:text, state:text, postcode:text, sort_order:int4!, created_at:timestamptz!
- **public.course_master_alert_seen**: user_id:uuid!, course_id:text!, week:date!, seen_at:timestamptz!
- **public.course_timing_templates**: id:uuid!, course_id:text!, name:text!, trainer_name:text, trainer_staff_id:uuid, sessions:jsonb!, source:text, created_at:timestamptz!
- **public.course_voe_calendars**: course_id:text!, method:text!, start_date:date!, updated_at:timestamptz!, updated_by:uuid, cycles_planned:int4!
- **public.course_voe_units**: course_id:text!, unit_id:text!, sort:int4!, rates:_numeric!, start_date:date!, end_date:date!, id:uuid!, cycle:int4!
- **public.cron_health_flags**: id:int8!, job:text!, day:date!, calls:int4!, failures:int4!, last_status:int4, last_detail:text, first_failure_at:timestamptz, last_failure_at:timestamptz, created_at:timestamptz!, kind:text!, summary:text
- **public.cron_health_mails**: day:date!, delivery_id:uuid, jobs:int4!, created_at:timestamptz!
- **public.cron_http_calls**: request_id:int8!, job:text!, called_at:timestamptz!, status_code:int4, failed:bool, detail:text, collected_at:timestamptz, function_name:text
- **public.edge_function_error_salt**: id:bool!, salt:bytea!
- **public.edge_function_errors**: id:int8!, function_name:text!, status:int4!, error:text!, reporter:text!, signed_in:bool!, staff:bool!, repeats:int4!, first_at:timestamptz!, last_at:timestamptz!
- **public.email_account_audit**: id:int8!, at:timestamptz!, actor:uuid, actor_name:text, action:text!, account_upn:text!, ms_user_id:text, sku:text, licence_name:text, result:text!, detail:jsonb!
- **public.enrollment_application_consents**: id:uuid!, application_id:uuid!, method:text!, signed_document_ref:text!, declaration_version:text!, recorded_by:uuid, recorded_by_name:text!, created_at:timestamptz!, tenant_id:uuid, signer_role:text, signer_user_id:uuid, declaration_key:text, text_version:text, text_hash:text, ip:text, user_agent:text, guardian_name:text, guardian_relationship:text, guardian_email:text
- **public.enrollment_application_courses**: id:uuid!, application_id:uuid!, course_id:text!, course_code:text!, course_title:text!, variant:text!, created_at:timestamptz!, tenant_id:uuid, intake_id:uuid, discount_percent:numeric!
- **public.enrollment_application_documents**: id:uuid!, application_id:uuid!, category:text!, bucket_name:text!, storage_path:text!, filename:text!, mime_type:text, file_size:int8, uploaded_by:uuid, review_state:text!, revision_of:uuid, is_current:bool!, created_at:timestamptz!, metadata:jsonb!, tenant_id:uuid, guest_link_id:uuid, student_id:uuid
- **public.enrollment_application_messages**: id:uuid!, application_id:uuid!, author:uuid, author_name:text!, author_role:text!, body:text!, visibility:text!, created_at:timestamptz!, tenant_id:uuid
- **public.enrollment_application_requests**: id:uuid!, application_id:uuid!, request_type:text!, title:text!, detail:text!, requested_by:uuid, requested_by_name:text!, state:text!, response:text!, resolved_at:timestamptz, created_at:timestamptz!, tenant_id:uuid
- **public.enrollment_application_status_history**: id:uuid!, application_id:uuid!, previous_status:text, new_status:text!, actor:uuid, actor_name:text!, actor_role:text!, note:text!, created_at:timestamptz!, tenant_id:uuid, action_key:text, reason:text, payload:jsonb!
- **public.enrollment_application_versions**: id:uuid!, application_id:uuid!, version:int4!, snapshot:jsonb!, created_by:uuid, created_by_name:text!, created_at:timestamptz!, tenant_id:uuid
- **public.enrollment_applications**: id:uuid!, reference:text, agency_id:uuid!, created_by:uuid, assigned_agent_id:uuid, status:text!, student_name:text!, student_email:text!, intake:text!, completion:int4!, data:jsonb!, submitted_at:timestamptz, version:int4!, created_at:timestamptz!, updated_at:timestamptz!, is_test:bool!, submitted_by:uuid, client_key:text, tenant_id:uuid, draft_version:int8!, workflow_version_id:uuid, student_id:uuid!, source:text
- **public.enrollment_coe_documents**: id:uuid!, application_id:uuid!, tenant_id:uuid, registration_id:uuid!, kind:text!, file_name:text!, size_bytes:int4!, sha256:text!, content:bytea!, uploaded_by:uuid, uploaded_at:timestamptz!, superseded_at:timestamptz, issued_at:timestamptz, issued_by:uuid, document_number:text, issue_date:date
- **public.enrollment_document_deletion_recovery**: document_id:uuid!, application_id:uuid!, bucket_name:text!, storage_path:text!, state:text!, last_error:text, requested_at:timestamptz!, resolved_at:timestamptz, tenant_id:uuid
- **public.enrollment_document_extraction_attempts**: id:uuid!, job_id:uuid!, attempt_number:int4!, state:text!, error_code:text, error:text, provider_response_id:text, usage:jsonb!, created_at:timestamptz!, completed_at:timestamptz, tenant_id:uuid
- **public.enrollment_document_extraction_jobs**: id:uuid!, document_id:uuid!, application_id:uuid!, content_sha256:text, schema_version:text!, configuration_version:text!, state:text!, attempt_count:int4!, next_attempt_at:timestamptz!, lease_expires_at:timestamptz, last_error_code:text, last_error:text, provider_response_id:text, usage:jsonb!, created_at:timestamptz!, started_at:timestamptz, completed_at:timestamptz, updated_at:timestamptz!, lease_token:uuid, tenant_id:uuid, review_only:bool!
- **public.enrollment_document_extraction_operations**: job_id:uuid!, provider_engine:text!, operation_id:text!, recorded_at:timestamptz!
- **public.enrollment_document_field_reviews**: id:uuid!, application_id:uuid!, document_id:uuid, field_identifier:text!, candidate_value:text, existing_value:text, final_value:text, state:text!, source:jsonb!, reviewed_by:uuid, reviewed_at:timestamptz, created_at:timestamptz!, audit_revision:int8!, tenant_id:uuid
- **public.enrollment_offer_letters**: id:uuid!, application_id:uuid!, tenant_id:uuid, source:text!, template_id:uuid, file_name:text!, size_bytes:int4!, sha256:text!, content:bytea!, message:text!, override_note:text!, recipient_kind:text!, recipient_name:text!, recipient_email:text!, issued_by:uuid, issued_by_name:text!, issued_at:timestamptz!, resent_at:timestamptz, accepted_at:timestamptz, accepted_by:uuid, accepted_by_name:text!, accepted_via:text, accept_note:text!, template_name:text!, template_version:int4, variable_values:jsonb!, manual_values:jsonb!, cc_emails:_text, sign_layout:jsonb, signing_request_id:uuid, signed_at:timestamptz, signed_content:bytea, signed_sha256:text, certificate_content:bytea, certificate_sha256:text, prepaid_more:text, payment_amount_cents:int4, payment_currency:text, payment_description:text, payment_note:text, deposit_paid_at:timestamptz, deposit_auto_remind:bool!, payment_copy_content:bytea, payment_copy_sha256:text, payment_copy_at:timestamptz, payment_copy_queued_at:timestamptz, payment_copy_mail_missed_at:timestamptz, payment_copy_followup_at:timestamptz
- **public.enrollment_registration_corrections**: id:int8!, registration_id:uuid!, tenant_id:uuid, field:text!, old_value:text, new_value:text!, reason:text!, actor:uuid, actor_name:text!, created_at:timestamptz!
- **public.enrollment_registration_evidence**: id:uuid!, registration_id:uuid!, tenant_id:uuid, kind:text!, description:text!, document_id:uuid, recorded_by:uuid, recorded_at:timestamptz!
- **public.enrollment_registration_history**: id:int8!, registration_id:uuid!, tenant_id:uuid, from_state:text, to_state:text!, actor:uuid, actor_name:text!, note:text!, created_at:timestamptz!
- **public.enrollment_registration_reviews**: id:int8!, application_id:uuid!, tenant_id:uuid, kind:text!, decision:text!, note:text!, actor:uuid, actor_name:text!, created_at:timestamptz!
- **public.enrollment_registrations**: id:uuid!, application_id:uuid!, tenant_id:uuid, state:text!, coe_number:text, created_by:uuid, created_at:timestamptz!, lodged_at:timestamptz, lodged_by:uuid, verified_at:timestamptz, verified_by:uuid, cancelled_at:timestamptz, cancelled_by:uuid, cancel_reason:text, updated_at:timestamptz!
- **public.enrollment_students**: id:uuid!, agency_id:uuid!, tenant_id:uuid, student_profile_id:uuid, full_name:text!, email:text, phone:text, date_of_birth:date, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, agent_id:uuid, passport_number:text!, nationality:text!, details:jsonb!, qualifications:jsonb!, status:text!, status_changed_at:timestamptz, status_changed_by:uuid, student_number:text, sex_code:text, birth_country_code:text, home_language_code:text, english_proficiency_code:text, indigenous_status_code:text, school_level_code:text, school_level_year:text, labour_force_code:text, disability_flag:text, prior_education_flag:text, at_school_flag:text, archived_at:timestamptz, address_building:text, address_flat:text, address_street_number:text, address_street_name:text, address_needs_review:bool!, residency_status:text
- **public.google_place_lookups**: abn:text!, query:text!, found:bool!, place:jsonb, fetched_at:timestamptz!
- **public.guest_document_links**: id:uuid!, tenant_id:uuid, application_id:uuid!, token_hash:bytea!, expires_at:timestamptz!, created_by:uuid!, created_at:timestamptz!, revoked_at:timestamptz, last_used_at:timestamptz, sent_at:timestamptz, completed_at:timestamptz, sent_to_email:text, declared:jsonb!
- **public.guest_link_consents**: id:uuid!, link_id:uuid!, consent_version:text!, consented_at:timestamptz!
- **public.guest_link_hits**: bucket:text!, window_start:timestamptz!, hits:int4!
- **public.guest_link_sends**: id:uuid!, link_id:uuid!, application_id:uuid!, tenant_id:uuid, channel:text!, recipient:text!, sent_by:uuid!, sent_at:timestamptz!, outbox_id:uuid
- **public.intake_batches**: id:uuid!, intake_id:uuid!, code:text!, name:text, room_id:uuid, capacity:int4, default_trainer_id:uuid, sort:int4!, archived_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!, updated_by:uuid
- **public.intake_class_times**: id:uuid!, intake_id:uuid!, weekday:int2!, slot:text!, start_time:time!, end_time:time!, session_type:text!, room_id:uuid, sort:int4!, trainer_id:uuid, batch_id:uuid!
- **public.intake_enrolment_documents**: id:uuid!, enrolment_id:uuid!, kind:text!, title:text!, file_name:text, mime_type:text, size_bytes:int4, sha256:text, content:bytea, copy_state:text!, source_table:text, source_id:uuid, source_bucket:text, source_path:text, student_visible:bool!, uploaded_by:uuid, created_at:timestamptz!
- **public.intake_enrolment_status_history**: id:uuid!, enrolment_id:uuid!, from_status:text, to_status:text!, reason:text, note:text, evidence_document_id:uuid, effective_on:date!, changed_by:uuid, changed_by_name:text, changed_at:timestamptz!
- **public.intake_enrolment_units**: enrolment_id:uuid!, unit_id:text!
- **public.intake_enrolments**: id:uuid!, student_id:uuid!, enrolment_type:text!, status:text!, enrolled_on:date!, created_by:uuid, carry_over:bool!, continues_enrolment_id:uuid, prereq_first:bool!, intake_id:uuid!, study_reason_code:text, funding_source_code:text, course_start_date:date, course_end_date:date, withdrawn_on:date, archived_at:timestamptz, status_reason:text, status_note:text, resume_date:date, status_changed_at:timestamptz!, application_id:uuid, coe_number:text, voe_number:text, coe_document_id:uuid, actual_completion_date:date, award_issued_date:date
- **public.intake_group_deliveries**: id:int8!, message_id:uuid!, person_kind:text!, person_id:uuid!, channel:text!, to_address:text, email_delivery_id:uuid, provider_request_id:int8, status:text!
- **public.intake_group_members**: intake_id:uuid!, person_kind:text!, person_id:uuid!, active:bool!, m365_status:text!, m365_user_id:text, m365_error:text, whatsapp_invited_at:timestamptz, whatsapp_joined:bool!, sms_opt_out:bool!, added_at:timestamptz!, removed_at:timestamptz
- **public.intake_group_messages**: id:uuid!, intake_id:uuid!, kind:text!, channels:_text!, subject:text, body:text!, sent_by:uuid, sender_name:text, created_at:timestamptz!
- **public.intake_groups**: intake_id:uuid!, status:text!, mail_nickname:text!, m365_group_id:text, m365_address:text, m365_status:text!, m365_error:text, m365_synced_at:timestamptz, whatsapp_invite_link:text, sms_enabled:bool!, welcome_enabled:bool!, created_at:timestamptz!, closed_at:timestamptz
- **public.intake_trainers**: intake_id:uuid!, staff_id:uuid!, batch_id:uuid!
- **public.intake_units**: id:uuid!, intake_id:uuid!, unit_id:text!, start_date:date!, end_date:date!, hours:int4, sort:int4!, trainer_id:uuid, master_kind:text, master_cycle:int4, master_unit_id:uuid, archived_at:timestamptz
- **public.integration_connections**: id:uuid!, tenant_id:uuid, connector_id:text!, status:text!, credential_configured:bool!, webhook_configured:bool!, last_success_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.integration_definitions**: id:text!, name:text!, auth_type:text!, availability:text!, description:text!
- **public.integration_event_attempts**: id:uuid!, connection_id:uuid!, event_id:uuid!, status:text!, code:text!, created_at:timestamptz!, correlation_id:uuid!
- **public.integration_logs**: id:uuid!, connection_id:uuid!, connector_id:text!, severity:text!, code:text!, correlation_id:uuid!, created_at:timestamptz!
- **public.integration_permissions**: connection_id:uuid!, user_id:uuid!, role:text!, created_at:timestamptz!
- **public.integration_settings**: id:uuid!, tenant_id:uuid, timeout_seconds:int4!, max_retries:int4!, alerts_enabled:bool!, updated_at:timestamptz!
- **public.integration_sync_jobs**: id:uuid!, connection_id:uuid!, operation:text!, status:text!, created_at:timestamptz!, completed_at:timestamptz, success_count:int4!, failure_count:int4!, attempts:int4!, correlation_id:uuid!
- **public.integration_webhook_events**: id:uuid!, connection_id:uuid!, provider_event_id:text!, event_type:text!, status:text!, attempts:int4!, created_at:timestamptz!, verified_at:timestamptz, retry_count:int4!
- **public.integration_webhook_registrations**: id:uuid!, connection_id:uuid!, provider_id:text!, endpoint_url:text!, event_types:_text!, created_at:timestamptz!
- **public.letter_other_fees**: id:uuid!, tenant_id:uuid, label:text!, amount_cents:int8, is_active:bool!, sort:int4!, updated_at:timestamptz!, updated_by:uuid
- **public.letter_variables**: key:text!, grp:text!, label:text!, description:text!, source_kind:text!, source_ref:text!, source_label:text!, format:text!, input_type:text!, required:bool!, editable_source:bool!, aliases:_text!, sample:text!, sort:int4!
- **public.lms_attendance_marks**: register_id:uuid!, enrolment_id:uuid!, status:text!
- **public.lms_attendance_register**: id:uuid!, intake_unit_id:uuid!, class_date:date!, state:text!, updated_at:timestamptz!, updated_by:uuid, intake_id:uuid!, batch_id:uuid!
- **public.lms_intake_students**: intake_id:uuid!, student_id:uuid!, enrolled_at:timestamptz!
- **public.lms_practice_questions**: id:uuid!, request_id:uuid!, student_id:uuid!, unit_id:text!, prompt:text!, prompt_key:text!, choices:jsonb!, correct:int2!, explanation:text!, topic:text!, evidence:text!, created_at:timestamptz!, served_at:timestamptz, answered_at:timestamptz, selected:int2, saved:bool!
- **public.lms_practice_requests**: id:uuid!, student_id:uuid!, unit_id:text!, assignment_id:uuid, difficulty:text!, focus:text, source_key:text!, source_version:text!, created_at:timestamptz!, finished_at:timestamptz
- **public.lms_resource_audit**: id:int8!, file_id:uuid!, actor:uuid, action:text!, detail:jsonb!, created_at:timestamptz!
- **public.lms_resource_import_files**: id:uuid!, import_id:uuid!, parent_id:uuid, name:text!, source_path:text!, object_path:text!, bytes:int4!, extension:text!, state:text!, attempts:int4!, lease:uuid, eligible_at:timestamptz!, sha256:text, result:jsonb, usage:jsonb, failure:text, reviewed_by:uuid, reviewed_at:timestamptz, created_at:timestamptz!
- **public.lms_resource_imports**: id:uuid!, tenant_id:uuid, created_by:uuid!, unit_hint:text, created_at:timestamptz!
- **public.lms_tutor_requests**: id:uuid!, student_id:uuid!, unit_id:text!, created_at:timestamptz!
- **public.lms_unit_resources**: id:uuid!, tenant_id:uuid, unit_id:text!, file_id:uuid!, previous_id:uuid, title:text!, category:text!, audience:text!, security_hold:bool!, sha256:text!, assessment_id:uuid, published_at:timestamptz, created_at:timestamptz!
- **public.lms_unit_students**: intake_id:uuid!, unit_id:text!, student_id:uuid!, course_id:text!, allocated_at:timestamptz!, assigned_start_date:date, assigned_end_date:date, carried_from_intake_id:uuid, actual_start_date:date, actual_end_date:date, outcome_code:text, outcome_recorded_at:timestamptz, outcome_recorded_by:uuid, delivery_mode_identifier:text, predominant_delivery_mode:text, location_id:uuid, funding_source_code:text, outcome_evidence_note:text, outcome_evidence_path:text, location_is_auto:bool!, batch_id:uuid, qualification_id:uuid
- **public.locations**: id:uuid!, name:text!, address:text, kind:text!, sort:int4!, is_active:bool!, created_at:timestamptz!, avetmiss_location_id:text, suburb:text, postcode:text, state_code:text, country_code:text!
- **public.notification_activation**: id:uuid!, tenant_id:uuid, note:text!, approved_by:uuid, approved_at:timestamptz!, revoked_at:timestamptz, revoked_by:uuid
- **public.notification_attachment_settings**: tenant_id:uuid, submission_pdf:text!, updated_by:uuid, updated_at:timestamptz!
- **public.notification_deliveries**: id:uuid!, seq:int8!, outbox_id:uuid, tenant_id:uuid, application_id:uuid, recipient_user:uuid, recipient_email:text!, event:text!, template_source:text!, template_version_id:uuid, sender:jsonb, subject:text!, body:text!, state:text!, state_reason:text, created_at:timestamptz!, attempt_count:int4!, next_attempt_at:timestamptz!, lease_token:uuid, lease_expires_at:timestamptz, provider_message_id:text, last_error_code:text, sent_at:timestamptz, updated_at:timestamptz!, support_ticket_id:uuid, html_body:text, signing:bool!, booking_id:uuid, assessment_event_id:uuid, hub_message_id:uuid
- **public.notification_delivery_attempts**: id:uuid!, delivery_id:uuid!, attempt_number:int4!, outcome:text!, error_code:text, provider_message_id:text, created_at:timestamptz!
- **public.notification_dispatch_state**: id:bool!, last_request_id:int8, last_dispatched_at:timestamptz
- **public.notification_legacy_event_settings**: event:text!, settings:jsonb!, updated_by:uuid, updated_at:timestamptz!
- **public.notification_preferences**: auth_user_id:uuid!, event:text!, email_enabled:bool!, updated_at:timestamptz!, sms_enabled:bool!
- **public.notification_provider_events**: id:uuid!, event_key:text!, record_type:text!, provider_message_id:text!, delivery_id:uuid, detail:jsonb!, received_at:timestamptz!
- **public.notification_sender_domains**: id:uuid!, tenant_id:uuid, domain:text!, note:text, verified_by:uuid, verified_at:timestamptz!, revoked_at:timestamptz
- **public.notification_sender_settings**: tenant_id:uuid, from_email:text!, from_name:text, reply_to:text, updated_by:uuid, updated_at:timestamptz!
- **public.notification_sms_contacts**: auth_user_id:uuid!, phone_e164:text!, consent_text:text!, consented_at:timestamptz!, updated_at:timestamptz!
- **public.notification_sms_deliveries**: id:uuid!, seq:int8!, email_delivery_id:uuid!, tenant_id:uuid, recipient_user:uuid!, event:text!, subject:text!, state:text!, state_reason:text, attempt_count:int4!, next_attempt_at:timestamptz!, lease_token:uuid, lease_expires_at:timestamptz, provider_message_id:text, last_error_code:text, sent_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.omara_agent_businesses**: marn:text!, agency_id:uuid!, confidence:int4!, evidence:jsonb!, linked_by:uuid, linked_at:timestamptz!
- **public.omara_agent_verifications**: id:int8!, marn:text!, fetched_at:timestamptz!, source_url:text!, outcome:text!, changed:jsonb!
- **public.omara_agents**: marn:text!, full_name:text!, status:text, registration_commenced_at:timestamptz, business_name:text, address_line:text, suburb:text, state:text, postcode:text, country:text, phone:text, email:text, website:text, contact_id:uuid, source_url:text!, register_updated_at:timestamptz, verified_at:timestamptz!, disciplinary:jsonb, raw_fields:jsonb!, created_at:timestamptz!, updated_at:timestamptz!
- **public.omara_discovery_runs**: id:uuid!, agency_id:uuid, abn:text, names:jsonb!, provider:text!, queries:jsonb!, results:int4!, pages_fetched:int4!, est_cost_usd:numeric!, error:text, created_at:timestamptz!, created_by:uuid
- **public.payments**: id:uuid!, tenant_id:uuid, connection_id:uuid, subject_type:text!, subject_id:uuid!, description:text!, amount_cents:int4!, currency:text!, timing:text!, status:text!, payer_email:text, stripe_checkout_session_id:text, stripe_payment_intent_id:text, checkout_url:text, checkout_expires_at:timestamptz, checkout_count:int4!, livemode:bool, amount_paid_cents:int4, amount_refunded_cents:int4!, paid_at:timestamptz, refunded_at:timestamptz, failure_reason:text, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, receipt_url:text, stripe_charge_id:text, reminder_count:int4!, last_reminder_at:timestamptz, fee_type:text, student_id:uuid, intake_enrolment_id:uuid, course_id:text, source:text!, external_reference:text
- **public.platform_admins**: auth_user_id:uuid!, active:bool!, created_at:timestamptz!
- **public.portal_audit_log**: id:uuid!, actor:uuid, actor_name:text!, actor_role:text!, action:text!, target_type:text!, target_id:text!, agency_id:uuid, application_id:uuid, detail:jsonb!, created_at:timestamptz!, tenant_id:uuid
- **public.portal_notifications**: id:uuid!, recipient:uuid!, application_id:uuid, reference:text!, event:text!, title:text!, message:text!, read:bool!, created_at:timestamptz!, tenant_id:uuid
- **public.portal_profiles**: id:uuid!, auth_user_id:uuid!, full_name:text!, email:text!, phone:text!, job_title:text!, status:text!, created_at:timestamptz!, updated_at:timestamptz!, is_test:bool!
- **public.prereq_class_times**: id:uuid!, class_id:uuid!, weekday:int2!, start_time:time!, end_time:time!, session_type:text!, room_id:uuid
- **public.prereq_classes**: id:uuid!, course_id:text!, name:text!, trainer_id:uuid, room_id:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.public_assistant_answer_cache**: cache_key:text!, source_version:text!, answer:jsonb!, expires_at:timestamptz!, created_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_chunks**: id:uuid!, source_id:uuid!, ordinal:int4!, heading:text, content:text!, content_tsv:tsvector, content_hash:text!, page_reference:text, course_code:text, embedding:vector, embedding_model:text, embedding_dimensions:int4, created_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_document_corrections**: id:uuid!, document_text_id:uuid!, page_number:int4, replacement_text:text!, reason:text!, created_by:uuid, created_at:timestamptz!, approved_at:timestamptz, tenant_id:uuid
- **public.public_assistant_document_pages**: id:uuid!, document_text_id:uuid!, page_number:int4!, original_text:text!, cleaned_text:text!, status:text!, warnings:jsonb!, tenant_id:uuid
- **public.public_assistant_document_text**: id:uuid!, document_id:text!, source_version:text!, file_hash:text!, original_text:text!, cleaned_text:text!, extraction_method:text!, extraction_version:text!, processing_status:text!, warning:jsonb!, extracted_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_faqs**: id:uuid!, question:text!, normalized_question:text!, answer:text!, source_url:text!, status:text!, aliases:_text!, source_version:text!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_generation_budgets**: period_start:date!, requests:int4!, input_tokens:int4!, output_tokens:int4!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_generation_requests**: request_id:uuid!, lease_token:uuid!, period_start:date!, settled_at:timestamptz, input_tokens:int4!, output_tokens:int4!, created_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_generation_slots**: slot:text!, lease_token:uuid, lease_expires_at:timestamptz, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_index_jobs**: id:uuid!, source_type:text!, source_key:text!, source_version:text!, state:text!, attempt_count:int4!, next_attempt_at:timestamptz!, lease_token:uuid, lease_expires_at:timestamptz, error_code:text, error:text, created_at:timestamptz!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_rate_limits**: bucket:text!, window_started_at:timestamptz!, request_count:int4!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_sources**: id:uuid!, source_type:text!, source_key:text!, canonical_url:text!, title:text!, publication_status:text!, source_version:text!, content_hash:text!, effective_at:timestamptz, indexed_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!, tenant_id:uuid
- **public.public_assistant_usage_events**: id:int8!, kind:text!, request_key:text, input_tokens:int4!, output_tokens:int4!, latency_ms:int4, model:text, created_at:timestamptz!, tenant_id:uuid
- **public.qualification_status_reasons**: id:uuid!, status:text!, label:text!, sort:int4!, is_other:bool!, is_active:bool!
- **public.qualification_tasks**: id:uuid!, kind:text!, event:text, enrolment_id:uuid, application_id:uuid, student_id:uuid, title:text!, detail:text, due_on:date, status:text!, prisms_reference:text, closed_note:text, closed_by:uuid, closed_at:timestamptz, created_at:timestamptz!
- **public.rto_placement_overrides**: id:uuid!, student_id:uuid!, course_id:text!, enrolment_id:uuid, action:text!, reason:text!, detail:jsonb!, actor:uuid, at:timestamptz!, intake_id:uuid
- **public.sign_batch_sends**: id:uuid!, template_id:uuid!, student_id:uuid!, request_id:uuid, created_by:uuid, created_at:timestamptz!, intake_id:uuid!
- **public.sign_template_units**: template_id:uuid!, course_id:text!, unit_id:text!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!
- **public.sms_messages**: message_id:text!, application_id:uuid, recipient:text!, last_digits:text, status:text!, status_code:text, status_text:text, sent_at:timestamptz!, reported_at:timestamptz
- **public.staff_office365_accounts**: staff_id:uuid!, upn:text!, ms_user_id:text, status:text!, licence_sku:text, last_error:text, welcome_sent_at:timestamptz, linked:bool!, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, account_created_at:timestamptz, licence_assigned_at:timestamptz, groups_added_at:timestamptz, groups_error:text, welcome_error:text
- **public.status_config_audit**: id:int8!, table_name:text!, row_key:text!, action:text!, before:jsonb, after:jsonb, changed_by:uuid, changed_by_name:text!, changed_at:timestamptz!
- **public.status_reasons**: id:uuid!, status:text!, label:text!, sort:int4!, is_other:bool!, is_active:bool!
- **public.storage_cleanup_queue**: id:int8!, bucket_name:text!, storage_path:text!, reason:text!, requested_at:timestamptz!, requested_by:uuid, done_at:timestamptz
- **public.student_applications**: id:uuid!, auth_user_id:uuid!, status:text!, reference:text, submitted_at:timestamptz, created_at:timestamptz!, updated_at:timestamptz!
- **public.student_disabilities**: student_id:uuid!, disability_type_code:text!, created_at:timestamptz!
- **public.student_documents**: id:uuid!, auth_user_id:uuid!, name:text!, category:text!, bucket_name:text!, storage_path:text!, mime_type:text, file_size:int8, created_at:timestamptz!
- **public.student_office365_accounts**: student_id:uuid!, upn:text!, ms_user_id:text, status:text!, licence_sku:text, last_error:text, welcome_sent_at:timestamptz, created_by:uuid, created_at:timestamptz!, updated_at:timestamptz!, linked:bool!, account_created_at:timestamptz, licence_assigned_at:timestamptz, groups_added_at:timestamptz, groups_error:text, welcome_error:text
- **public.student_prereq_catchup**: enrolment_id:uuid!, unit_id:text!, start_date:date!, end_date:date!, created_at:timestamptz!
- **public.student_prior_education**: student_id:uuid!, prior_education_code:text!, recognition_code:text!, qualification_name:text, created_at:timestamptz!
- **public.student_profiles**: id:uuid!, auth_user_id:uuid!, full_name:text, email:text, phone:text, date_of_birth:date, country:text, created_at:timestamptz!, updated_at:timestamptz!
- **public.support_mail_dispatch_state**: id:bool!, last_request_id:int8, last_dispatched_at:timestamptz
- **public.support_notification_recipients**: id:uuid!, email:text!, label:text!, created_at:timestamptz!, created_by:uuid
- **public.support_ticket_messages**: id:uuid!, ticket_id:uuid!, kind:text!, author_user:uuid, author_name:text!, from_staff:bool!, internal:bool!, body:text!, attachments:jsonb!, created_at:timestamptz!
- **public.support_tickets**: id:uuid!, ref:text!, tenant_id:uuid, requester_user:uuid!, requester_profile:uuid, requester_role:text!, requester_name:text!, requester_email:text!, agency_id:uuid, student_id:uuid, category:text!, subject:text!, priority:text!, status:text!, assigned_to:uuid, assigned_name:text, created_at:timestamptz!, updated_at:timestamptz!, last_message_at:timestamptz!, last_requester_activity_at:timestamptz!, last_staff_activity_at:timestamptz, requester_read_at:timestamptz!, staff_read_at:timestamptz, resolved_at:timestamptz, closed_at:timestamptz
- **public.tenant_access_audit**: id:int8!, tenant_id:uuid, actor:uuid, action:text!, target:uuid, details:jsonb!, created_at:timestamptz!
- **public.tenant_config_versions**: id:uuid!, tenant_id:uuid!, kind:text!, version:int4, state:text!, config:jsonb!, restored_from:int4, created_by:uuid, created_at:timestamptz!, published_by:uuid, published_at:timestamptz
- **public.tenant_conversation_messages**: id:uuid!, tenant_id:uuid!, conversation_id:uuid!, role:text!, content:text!, created_at:timestamptz!
- **public.tenant_conversations**: id:uuid!, tenant_id:uuid!, owner_user_id:uuid!, created_at:timestamptz!
- **public.tenant_domains**: hostname:text!, tenant_id:uuid!, verified_at:timestamptz, verification_evidence:text
- **public.tenant_member_invites**: id:uuid!, tenant_id:uuid!, email:text!, role:text!, invited_by:uuid, created_at:timestamptz!, accepted_at:timestamptz, accepted_by:uuid
- **public.tenant_memberships**: tenant_id:uuid!, auth_user_id:uuid!, role:text!, active:bool!
- **public.tenant_notification_senders**: tenant_id:uuid!, email:text!, approved_by:uuid, approved_at:timestamptz!, revoked_at:timestamptz, note:text
- **public.tenant_ownership_decisions**: id:uuid!, table_name:text!, record_key:text!, tenant_id:uuid, status:text!, evidence:text!, observed_hash:text!, proposed_by:uuid!, reviewed_by:uuid, created_at:timestamptz!, reviewed_at:timestamptz, applied_at:timestamptz
- **public.tenant_website_config**: tenant_id:uuid!, settings_id:int2!, footer_id:int2!, theme_version:int4!, content_version:int8!
- **public.tenants**: id:uuid!, slug:text!, name:text!, status:text!, created_at:timestamptz!
- **public.tga_nominal_hours**: unit_code:text!, hours:int4!, loaded_at:timestamptz!
- **public.tga_unit_content**: code:text!, details:jsonb!, fetched_at:timestamptz!
- **public.unit_contents**: id:uuid!, unit_id:text!, kind:text!, title:text!, body:text!, url:text, storage_path:text, file_name:text, mime_type:text, size_bytes:int4, sort:int4!, visible_to_students:bool!, created_by:uuid, created_at:timestamptz!, updated_by:uuid, updated_at:timestamptz!
- **public.usi_calls**: id:int8!, created_at:timestamptz!, op:text!, application_id:uuid!, actor:uuid, actor_name:text, actor_role:text!, automatic:bool!, person_hash:text, outcome:text, finished_at:timestamptz
- **skyline_private.application_guardian_codes**: id:uuid!, request_id:uuid!, code_hash:text!, created_at:timestamptz!, expires_at:timestamptz!, attempts:int4!, used_at:timestamptz
- **skyline_private.application_guardian_requests**: id:uuid!, application_id:uuid!, name:text!, relationship:text!, email:text!, mobile:text!, token_hash:text!, state:text!, created_by:uuid, created_at:timestamptz!, expires_at:timestamptz!, sent_at:timestamptz, verified_until:timestamptz, signed_at:timestamptz
- **skyline_private.application_handoff_events**: id:uuid!, application_id:uuid!, event:text!, actor:uuid, actor_role:text, actor_name:text, detail:jsonb!, created_at:timestamptz!
- **skyline_private.application_handoffs**: application_id:uuid!, state:text!, sent_at:timestamptz, sent_by:uuid, sent_snapshot:jsonb, opened_at:timestamptz, last_saved_at:timestamptz, change_note:text, change_requested_at:timestamptz, signed_at:timestamptz, signed_by:uuid, signed_by_name:text, finalize_kind:text, request_key:text, finalize_note:text, submitted_at:timestamptz, taken_back_at:timestamptz, updated_at:timestamptz!
- **skyline_private.contact_codes**: id:uuid!, user_id:uuid!, kind:text!, code_hash:text!, created_at:timestamptz!, expires_at:timestamptz!, attempts:int4!, used_at:timestamptz
- **skyline_private.contact_verifications**: user_id:uuid!, kind:text!, value:text!, verified_at:timestamptz, created_at:timestamptz!
- **skyline_private.link_aliases**: alias_hash:text!, scope:text!, subject:uuid!, base_hash:text, email:text!, mobile:text!, created_at:timestamptz!, expires_at:timestamptz!, used_at:timestamptz
- **skyline_private.link_codes**: id:uuid!, scope:text!, subject:uuid!, code_hash:text!, created_at:timestamptz!, expires_at:timestamptz!, attempts:int4!, used_at:timestamptz
- **skyline_private.link_proofs**: scope:text!, subject:uuid!, kind:text!, value:text!, verified_at:timestamptz, created_at:timestamptz!
- **skyline_private.password_rotations**: auth_user_id:uuid!, password_fingerprint:text!, requested_at:timestamptz!
- **skyline_private.portal_passwords_created**: user_id:uuid!, created_at:timestamptz!
- **skyline_private.sms_receipt_keys**: id:int2!, key_hash:text!, created_at:timestamptz!, created_by:uuid, last_report_at:timestamptz
- **skyline_private.student_application_invites**: id:uuid!, application_id:uuid!, recipient:text!, token_hash:text!, state:text!, created_by:uuid!, created_at:timestamptz!, expires_at:timestamptz!, sent_at:timestamptz, accepted_at:timestamptz, sms_token_hash:text

## Appendix D. Edge Functions, cron jobs, buckets (hosted 2026-11-28)
- Edge Functions (42): address-search, admin-view-as, asm-import, calendly-admin, cms-admin-users, cricos-lookup, document-signing,
  email-sender, guest-documents, holiday-sync, intake-groups, integrations-admin, integrations-credentials, integrations-refresh,
  integrations-webhook, lms-bulk-worker, notification-delivery, omara-abr-enrich, omara-discovery, omara-ingest, payments,
  portal-admin-users, portal-application-delete, portal-document-delete, portal-document-extract, portal-invite-activate,
  portal-self-register, public-assistant, public-assistant-index, staff-admin, staff-onboarding, staff-register, student-application-invite,
  student-office365, student-practice, support-ticket-mail, tga-course-import, unit-foe-fill, usi-service, validated-document-upload, xero-push.
- Cron (19): asm-due-sweep, cron-http-collect, cron-http-health, hr-holiday-sync, hr-pay-periods-topup, hr-retention-purge, intake-groups,
  intake-wizard-cleanup, integration-token-refresh, lms-bulk-resource-worker, notification-delivery-worker, portal-document-extraction-worker,
  public-assistant-index-worker, qualification-daily, rto-auto-place, signing-notifications, support-ticket-mail, unit-foe-fill, usi-reverify.
- Buckets (16): assessment-evidence, assessment-output, assessment-templates, business-documents, cms-media, enrollment-documents,
  lms-bulk-resources, signing-documents, staff-documents, staff-signed-documents, student-documents, support-attachments, template-assets,
  tenant-cms, tenant-public-media, unit-content.
- Connectors (integration_definitions): axcelerate, azure_document_intelligence, brave_search, calendly, clicksend, cloudflare_turnstile,
  datazoo, docusign, geoscape, google_maps, microsoft_teams, microsoft365, openai, postmark, prisms, stripe, tavily, training_gov_au, usi,
  vevo, whatsapp, xero.
- Hosted volumes (2026-11-28): students 3, applications 3, Qualifications 0, courses 3, units 73, intakes 4, locations 5, rooms 10,
  agents 4, businesses 4, payments 11, class sessions 829, tenants 0.

## Appendix E. aXcelerate fields per entity (UNCONFIRMED: public reference, no live sample; *(s)* = from a summary of the reference)
- **Contact** `/contact/:id`, `/contacts/search` *(s)*: CONTACTID, GIVENNAME, SURNAME, PREFERREDNAME, EMAILADDRESS, SEX, DOB (yyyy-mm-dd),
  USI, USI_VERIFIED, USI_EXEMPTION, LUI, TFN_RECORDED, OPTIONALID, ORGID, ORGIDS, ADDRESS1, ADDRESS2, CITY, STATE, POSTCODE, COUNTRY,
  SADDRESS1.. (residential), BUILDINGNAME, UNITNO, STREETNO, STREETNAME, POBOX, COUNTRYID, PHONE, MOBILEPHONE, WORKPHONE, FAX, COMMENT,
  WEBSITE, CITIZENSTATUSID, COUNTRYOFBIRTHID, PRIOREDUCATIONIDS, DISABILITYTYPEIDS, EMERGENCYCONTACT, PARENTCONTACTID, EMPLOYERCONTACTID,
  PAYERCONTACTID, SACESTUDENTID, CATEGORYIDS, DOMAINIDS, CUSTOMFIELD_*. Not found: language, labour force, school level, indigenous,
  passport, visa, CRICOS fields. Paging offset + displayLength (max 100). No updated-since filter.
- **Course list** `/courses` *(s)*: ROWID, ID, COUNT, NAME, STREAMNAME, CODE, COST, GST_TYPE, DELIVERY, DURATION, DURATIONTYPE, ISACTIVE,
  TYPE, SHORTDESCRIPTION, PRIMARYIMAGE, SECONDARYIMAGE, LASTUPDATEDUTC. Filters type (w / p), searchTerm, trainingArea, public, current,
  isActive, lastUpdated_min / _max.
- **Course detail** `/course/detail` *(s)*: OUTLINE, CODE, COST, GST_TYPE, NAME, ID, TYPE, DESCRIPTION, LASTUPDATEDUTC.
- **Course instance** `/course/instances`, `/course/instance/detail` *(s)*: ID, INSTANCEID, NAME, STARTDATE, FINISHDATE, DATEDESCRIPTOR,
  LOCATION, DELIVERYLOCATIONID, COST, GST_TYPE, OWNERCONTACTID, TRAINERCONTACTID, NOTICES, PARTICIPANTS, MAXPARTICIPANTS, MINPARTICIPANTS,
  PARTICIPANTVACANCY, ENROLMENTOPEN, ISACTIVE, STATUS, REPORTINGSTANDARD, QUALIFICATION, FINANCECODE, PUBLIC, LASTUPDATEDUTC,
  UNITS (UNITID, UNITCODE, UNIT, MODULE, UNITORDER, SCHEDULEDSTARTDATE, SCHEDULEDENDDATE, ELECTIVE, WORKSHOPS).
- **Enrolment** `/course/enrolments` (partly verbatim): ID, CONTACTID, INSTANCEID, TYPE (p / s), CODE, NAME, ENROLMENTDATE, STARTDATE,
  FINISHDATE, DELIVERY (CODE, DESCRIPTION), AMOUNTPAID, LEARNERID, GIVENNAME, SURNAME, EMAIL, MOBILEPHONE, SCHOOLTYPEID, SCHOOLORGID,
  ACTIVITIES (STATUS, OUTCOMECODE ...), LASTUPDATEDUTC. Paging offset + limit (100). lastUpdated_min / _max (paired, 90 days).
  `/contact/enrolments/:id` *(s)*: ROWID, TYPE, ID, INSTANCEID, ENROLID, INVOICEID, INVOICEPAID, LEARNERID, CODE, LOCATION, DELIVERY,
  ACTIVITYTYPE, NAME, STARTDATE, FINISHDATE, MANDATORY, STATUS, OUTCOMECODE, CUSTOMFIELD_*. `/enrolment/enrolmentInfo`: not in the reference.
- **Attendance** `/course/instance/attendance` *(s)*: INSTANCEID, TYPE, COMPLEXID, DATE, STARTTIME, FINISHTIME, DURATION, ENROLLEES
  (ENROLID, CONTACTID, GIVENNAME, SURNAME, COMPLETEDFLAG, ATTENDEDFLAG, ATTENDANCEID, ATTENDEDDURATION, COMMENT, PHOTOURL).
- **Venues / delivery locations** *(s)*: CONTACTID, NAME, SADDRESS1, SADDRESS2, SCITY, SSTATE, SPOSTCODE, MOBILEPHONE / ID, CODE, NAME,
  BUILDINGNAME, UNITNO, STREETNO, STREETNAME, CITY, STATE, POSTCODE, COUNTRY, COUNTRYID, ACTIVE.
- **Trainer** `/trainer/:id` *(s)*: CONTACTID, NAME, EMAIL, ACTIVE, CONSULTANTID, EMPTYPE, CONTACTHRS, CONTACTHRSTIMEFRAME, RATEAMOUNT,
  PAYTIMEFRAME, EXPERIENCE, IMAGE, DOMAINID, CONENTRYDATE, CONSULTANTUPDATEDDATETIMEUTC.
- **User** *(s)*: USERID, CONTACTID, CONTACT_NAME, USERNAME, ROLEID, ROLENAME, ROLETYPEID, ACTIVE, DOMAINID, PENDINGLOGININVITE.
- **Agent** `/agent/:id` *(s)*: MARKETINGAGENTID, CONTACTID, DEFAULTCOMMISSIONRATE, ACTIVE, CUSTOMFIELD_*.
- **Organisation** `/organisation/:id` (verbatim): ORGID, NAME, LEGALNAME, ABN, ANZSIC, PARENTORGID, PARENT, HIERACHYPATH, HIERACHYDEPTH,
  HIERACHYROOT, ORGOPTIONALID, PAYERCONTACTID, EMPLOYERCONTACTID, SCHOOLTYPEID, BOOKING_NOTES, ORGANISATIONNOTES, DETAILS, CATEGORIES,
  FINANCESYSTEMCARDID, ORGNAMEACCOUNTING, PURCHASEORDERREQUIRED, NWDF_ORGSIZEBRACKET, BANNER, CUSTOMFIELD_*.
- **Invoice** `/accounting/invoice(/:id)` (verbatim): INVOICEID, INVOICENR, INVGUID, INVOICEDATE, ORDERDATE, DUEDATE, PRICENETT, PRICEGROSS,
  BALANCE, ISPAID, ISVOID, ISCANCELLED, ISARCHIVED, CURRENCY, CONTACTID, CONTACTNAME, ORGANISATION, OWNERCONTACTID, address fields, COMMENT,
  ITEMS (ITEMID, DESCRIPTION, QTY, UNITPRICENETT/GROSS/TAX, TOTALNETT/GROSS/TAX, TAXPERCENT, ITEMCODE, FINANCECODE, COSTCENTRECODE,
  SERVICEDATE, ENROLMENT (CONTACTID, INSTANCEID, TYPE)), PAYMENTS.
- **Credit note** (verbatim): CREDITNOTEID, CREDITNOTENR, CREDITNOTEDATE, PRICEGROSS, PRICENETT, BALANCE, ISCREDITED, ISVOID, SOURCEINVOICEID,
  CONTACTID, ITEMS.
- **Transaction** *(s)*: TRANSACTIONID, CONTACTID, AMOUNT, TRANSDATE, PAYMENTMETHOD(ID), TRANSACTIONTYPE(ID), REFERENCE, DESCRIPTION,
  CURRENCY, ISCOMPLETED, FRAGMENTS (INVOICEID, CREDITNOTEID, AMOUNT, APPLIEDDATE).
- **Catalogue item** *(s)*: ITEMID, ITEMCODE, ITEMDESCRIPTION, DEFAULTPRICE, FINCODE, PRICEGSTINCLUSIVE.
- **Contact notes** `/contact/notes/:id` (verbatim): ID, TEXT, TYPE, DATEINSERTED, DATEUPDATED, ADDEDBY, UPDATEDBY, ADDEDBYCONTACTID,
  UPDATEDBYCONTACTID, ATTACHMENTS.
- **Portfolio** `/contact/portfolio` (verbatim): PORTFOLIOID, PORTFOLIOTYPEID, PORTFOLIOTYPE, PORTFOLIOTYPENAME, RESTRICTED, NUMBER,
  DATEISSUED, DATEEXPIRES, ISSUEDBY, DETAILS, FILES (PORTFOLIODOCID, FILENAME, FOLDER, TEMPORARYACCESSURL, ACCESSMIN), CUSTOMFIELD_*.
- **Certificate** `/contact/enrolment/certificate` *(s)*: CERTIFICATE (base64 PDF).
- **Custom fields** `/customFields` *(s)*: ID, LABEL, VARIABLENAME, TYPE, OPTIONS, LINKTO, MANDATORY, ACTIVE, AVAILABLETOEXTERNAL.
- **Tasks** `/tasks` (verbatim): ID, NAME, TYPE, STATUS, STATUS_CODE, PRIORITY, CATEGORY(ID), DUEDATE, COMPLETEDDATE, OWNER(ID), REQUESTER(ID).
- **Follow-ups** `/followUps` *(s)*: MTASKID, CONTACTID, FOLLOWUPDATE, WHOSETASK_*, OPPORTUNITY, OPPORTUNITYSTATUS, FORECASTVALUE, ORGID.
- Status / outcome codes (verbatim, Codes and Identifiers): class enrolment tent, ip, canc, def, susp, comp; outcome 20 C, 30 CNA, 40 W,
  41 CLOS, 51 RPL-G, 52 RPL-NG, 60 CT, 61 SUP, 70 CA, 81 / 82 NAS, 85 NYS; delivery mode I / E / W.

