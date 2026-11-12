import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResponsiveTable from "../src/components/ui/ResponsiveTable.tsx";
import assert from "node:assert/strict";
import test from "node:test";
import { calendlyEmbedSrc, calendlyUrlProblem } from "../src/lib/calendly.ts";
import { directoryAgencyToForm, EMPTY_AGENCY_FORM, validateAgencyForm } from '../src/pages/admin/lib/agencyForm.ts';
import type { DirectoryAgency } from '../src/pages/agency/lib/portalData.ts';

test('agency directory fills real business fields, starts the added business inactive and does not invent missing contact details', () => {
  const agency: DirectoryAgency = { ...EMPTY_AGENCY_FORM, id: 'directory:sample', name: 'Sample Business', code: 'OMARA-ABC12345',
    phone: '+61412345678 / +61400000000', primaryContact: 'Registered Contact', status: 'Inactive', businessEmail: '',
    address: '1 Sample Street', country: 'Australia', registrationNumber: '', isPermanent: false, createdAt: '',
    agentCount: 0, applicationCount: 0, directoryKey: 'sample', existingAgencyId: null, source: 'directory', marn: '1234567' };
  const form = directoryAgencyToForm(agency);
  assert.equal(form.name, agency.name);
  assert.equal(form.address, agency.address);
  assert.equal(form.primaryContact, agency.primaryContact);
  assert.equal(form.status, 'Inactive', 'every new business starts inactive until a SLIT administrator activates it');
  assert.equal(form.businessEmail, '');
  assert.equal(form.registrationNumber, '', 'a person MARN is not an agency ABN');
  assert.equal(validateAgencyForm(form).phone, '+61412345678');
  assert.ok(validateAgencyForm(form).errors.businessEmail, 'missing directory email must be completed before creating');
  assert.equal(directoryAgencyToForm({ ...agency, phone: '', primaryContact: '' }).phone, '');
});
import { menuTree, menuActive, menuIcon, type AdminMenuItem } from "../src/pages/admin/lib/adminMenu.ts";
import { canManagePortalUsers, portalAccessMessage, portalLanding } from "../src/pages/agency/lib/applicationAccess.ts";
// ---- Application statuses from the database (20261113260000): the frontend helpers read the catalogue the migration seeds ----
import { actionsFor, canSubmitFrom, currentStatuses, isEditableStatus, parseWorkflow, statusInfo } from "../src/lib/applicationStatuses.ts";

const workflowSql = readFileSync(new URL("../supabase/migrations/20261113260000_application_status_workflow.sql", import.meta.url), "utf8");
const seededWorkflow = (() => {
  const statusRows = /insert into public\.application_statuses\([^)]*\) values([\s\S]*?);\n/.exec(workflowSql)?.[1] ?? "";
  const actionRows = /insert into public\.application_status_actions\([^)]*\) values([\s\S]*?);\n/.exec(workflowSql)?.[1] ?? "";
  const tuples = (block: string) => [...block.matchAll(/\(([^()]*)\)/g)].map((m) => [...m[1].matchAll(/'((?:[^']|'')*)'|(null|true|false|\d+)/g)].map((v) => v[1] !== undefined ? v[1].replace(/''/g, "'") : v[2]));
  return parseWorkflow({
    statuses: tuples(statusRows).map(([value, label, sort, tone, hint, editable, legacy]) => ({ value, label, sort: Number(sort), tone, hint, editable: editable === "true", legacy: legacy === "true" })),
    actions: tuples(actionRows).map(([from, action, to, actor, label, kind, note, tone, sort]) => ({ from, action, to: to === "null" ? null : to, actor, label, kind, note, tone, sort: Number(sort) })),
  });
})();

import { availableActions, csvCell, EXPORT_COLUMNS, exportCsv, EXCEPTION_TEXT, normaliseCoeNumber, registrationChecklist, registrationWarning, validateCorrection, verifyBlockers } from "../src/pages/agency/lib/registrationWorkbench.ts";

test('admin menu: order, nesting and active deep links follow backend rows', () => {
  const row = (id: string, parent_id: string | null, route: string | null, sort_order = 0): AdminMenuItem =>
    ({ id, parent_id, route, sort_order, label: id, icon_key: 'pages', is_enabled: true, open_in_new_tab: false });
  const tree = menuTree([row('site', null, null, 20), row('pages', 'site', '/admin/pages'), row('home', null, '/admin', 0)]);
  assert.deepEqual(tree.map(n => n.id), ['home', 'site']);
  assert.equal(menuActive(tree[1], '/admin/pages/a-page'), true);
  assert.equal(menuActive(tree[0], '/admin/pages'), false);
  assert.equal(menuActive(tree[1], '/admin/pages-lookalike'), false);
  // The Documents & Signatures row (20261110154917) is a top-level link: it must be shown, and active on its pages.
  const signing = menuTree([row('document_signing', null, '/admin/signing', 85)]);
  assert.deepEqual(signing.map(n => n.id), ['document_signing']);
  assert.equal(menuActive(signing[0], '/admin/signing'), true);
});
test('admin menu: denied parents, disabled rows, cycles and unsafe routes fail closed', () => {
  const row = (id: string, parent_id: string | null, route: string | null): AdminMenuItem =>
    ({ id, parent_id, route, sort_order: 0, label: id, icon_key: 'pages', is_enabled: true, open_in_new_tab: false });
  assert.deepEqual(menuTree([
    row('orphan', 'denied', '/admin/users'), row('a', 'b', null), row('b', 'a', null),
    row('script', null, 'javascript:alert(1)'), row('remote', null, '//example.test'),
    row('unknown', null, '/admin/not-implemented'), row('empty', null, null),
    { ...row('disabled', null, '/admin/pages'), is_enabled: false },
  ]), []);
  assert.equal(menuIcon('pages'), 'ri-file-text-line');
  assert.equal(menuIcon('evil onclick=alert(1)'), 'ri-folder-line');
  assert.equal(menuIcon('__proto__'), 'ri-folder-line');
});

test("only database-editable portal statuses enable draft UI", () => {
  assert.equal(isEditableStatus(seededWorkflow, "draft"), true);
  assert.equal(isEditableStatus(seededWorkflow, "action_required"), true);
  assert.equal(isEditableStatus(seededWorkflow, "submitted"), false);
  assert.equal(isEditableStatus(seededWorkflow, "under_review"), false);
  assert.equal(isEditableStatus(seededWorkflow, "offer_issued"), false);
  assert.equal(isEditableStatus(seededWorkflow, "enrolled"), false);
  assert.equal(isEditableStatus(seededWorkflow, "anything-unknown"), false, "an unknown status is never editable");
});

test("completion and submission-date lookalikes never affect editability", () => {
  // The helper deliberately receives status only: 0%, 3%, an absent date, and
  // document extraction state are presentation data, not authorisation input.
  assert.equal(isEditableStatus(seededWorkflow, "draft"), true);
});

// ---- P08-02 manual registration workbench (REG-REGISTER browser validation, export minimization) ----
test("registration: CoE numbers are normalised and malformed values are refused before any request", () => {
  assert.deepEqual(normaliseCoeNumber("  e0000000001 "), { ok: true, value: "E0000000001" });
  for (const bad of ["", "abc", "E 0000000001", "E000000000000000000001", "E0000000001!", "<script>1</script>"]) assert.equal(normaliseCoeNumber(bad).ok, false, bad);
});

test("registration: the warning covers coe_issued and enrolled without a verified registration, and nothing else", () => {
  assert.equal(registrationWarning("coe_issued", null), true);
  assert.equal(registrationWarning("enrolled", "lodged"), true);
  assert.equal(registrationWarning("enrolled", "cancelled"), true);
  assert.equal(registrationWarning("coe_issued", "verified"), false);
  assert.equal(registrationWarning("offer_accepted", null), false);
  assert.equal(registrationWarning("under_review", null), false);
});

test("registration: offered actions follow the lifecycle and a cancelled registration only allows a new one", () => {
  assert.deepEqual(availableActions(null), ["create"]);
  assert.deepEqual(availableActions("cancelled"), ["create"]);
  assert.deepEqual(availableActions("draft"), ["lodge", "cancel"]);
  assert.deepEqual(availableActions("lodged"), ["verify", "cancel"]);
  assert.deepEqual(availableActions("verified"), ["cancel"]);
});

test("registration: coe_issued is shown as distinct from a verified registration in the checklist", () => {
  const items = registrationChecklist({ applicationStatus: "coe_issued", state: "draft", evidenceCount: 0, coeNumber: null });
  const done = Object.fromEntries(items.map((i) => [i.key, i.done]));
  assert.deepEqual(done, { status: true, lodged: false, evidence: false, coe: false, verified: false });
  assert.match(items[0].label, /not a registration/);
});

test("registration: verification is blocked client-side for every reason the database would refuse it", () => {
  const ok = { applicationStatus: "coe_issued", state: "lodged" as const, evidenceCount: 1, coeNumber: null, coeInput: "E0000000001" };
  assert.deepEqual(verifyBlockers(ok), []);
  assert.equal(verifyBlockers({ ...ok, state: "draft" }).length, 1);
  assert.deepEqual(verifyBlockers({ ...ok, applicationStatus: "offer_accepted" }), [], "P08-07: verification is possible from offer_accepted");
  assert.equal(verifyBlockers({ ...ok, applicationStatus: "submitted" }).length, 1);
  assert.equal(verifyBlockers({ ...ok, evidenceCount: 0 }).length, 1);
  assert.equal(verifyBlockers({ ...ok, coeInput: "x" }).length, 1);
  assert.equal(verifyBlockers({ ...ok, state: "draft", applicationStatus: "submitted", evidenceCount: 0, coeInput: "" }).length, 4);
});

test("registration: the export writes only the fixed minimal columns and neutralises spreadsheet formulas", () => {
  assert.deepEqual([...EXPORT_COLUMNS], ["reference", "studentName", "intake", "courses", "applicationStatus", "registrationState", "coeNumber", "lodgedAt", "verifiedAt"]);
  const csv = exportCsv([{ reference: "A-1", studentName: "=HYPERLINK(\"http://evil\")", intake: "2027-02", courses: "BSB50; CHC30", applicationStatus: "enrolled", registrationState: "verified", coeNumber: "E0000000001",
    lodgedAt: null, verifiedAt: "2026-10-26", passportNumber: "X1234567", email: "student@example.test", documentId: "d-1" }]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Reference,Student,Intake,Courses,Application status,Registration state,CoE number,Lodged,Verified");
  assert.ok(!csv.includes("X1234567") && !csv.includes("student@example.test") && !csv.includes("d-1"), "fields outside the export columns are dropped");
  assert.ok(lines[1].includes("\"'=HYPERLINK(\"\"http://evil\"\")\""), lines[1]);
  assert.equal(csvCell("a,b"), "\"a,b\"");
  for (const lead of ["=1+1", "+1", "-1", "@SUM(A1)"]) assert.ok(csvCell(lead).startsWith("'"), lead);
});

test("registration: every reconciliation exception has a label and an explanation, and corrections are validated before sending", () => {
  assert.deepEqual(Object.keys(EXCEPTION_TEXT).sort(), ["enrolled_without_verified", "lodged_stale", "possible_duplicate", "verified_application_closed"]);
  for (const entry of Object.values(EXCEPTION_TEXT)) assert.ok(entry.label.length > 5 && entry.explanation.length > 20);
  assert.deepEqual(validateCorrection("E0000000001", "e0000000050", "External record differs"), []);
  assert.equal(validateCorrection("E0000000001", "e0000000001", "same").length, 1, "an unchanged number is refused");
  assert.equal(validateCorrection("E0000000001", "bad!", "reason").length, 1);
  assert.equal(validateCorrection("E0000000001", "E0000000050", "  ").length, 1);
  assert.equal(validateCorrection(null, "", "").length, 2);
});

// ---- CMS layout limits, colours, menu sync and local drafts ----
import { FOOTER_LIMITS, NAV_LIMITS, validateFooterLinks, validateNavigation } from "../src/config/cmsLimits.ts";
import { contrastLevel, contrastWithWhite, normaliseHex, DEFAULT_PRIMARY_HEX } from "../src/lib/colour.ts";
import { syncPageNavigation } from "../src/lib/pageNav.ts";
import { clearDraft, draftKey, readDraft, writeDraft } from "../src/pages/admin/lib/draftStore.ts";

const link = (n: number, label = `Link ${n}`) => ({ label, to: `/p${n}` });
const navItem = (n: number, label = `Item ${n}`, children = 0) => ({ id: `n${n}`, label, to: `/n${n}`, visible: true, children: Array.from({ length: children }, (_, i) => ({ id: `c${n}-${i}`, label: `Child ${i}`, to: `/c${i}`, external: false, visible: true })) });

test("footer links: at most 8 per column and 30-character labels", () => {
  assert.deepEqual(validateFooterLinks([{ title: "Quick links", links: Array.from({ length: FOOTER_LIMITS.maxLinksPerColumn }, (_, i) => link(i)) }]), []);
  assert.equal(validateFooterLinks([{ title: "Quick links", links: Array.from({ length: 9 }, (_, i) => link(i)) }]).length, 1);
  assert.equal(validateFooterLinks([{ title: "Student links", links: [link(1, "x".repeat(FOOTER_LIMITS.maxLabelLength + 1))] }]).length, 1);
  assert.equal(validateFooterLinks([{ title: "Student links", links: [{ label: "", to: "/a" }] }]).length, 1);
  assert.deepEqual(validateFooterLinks([{ title: "Quick links", links: undefined }]), []);
});

test("navigation: 7 top-level items, 6 per dropdown, 22-character labels", () => {
  assert.deepEqual(validateNavigation(Array.from({ length: NAV_LIMITS.maxTopLevel }, (_, i) => navItem(i, "x".repeat(NAV_LIMITS.maxLabelLength), NAV_LIMITS.maxChildren))), []);
  assert.equal(validateNavigation(Array.from({ length: 8 }, (_, i) => navItem(i))).length, 1);
  assert.equal(validateNavigation([navItem(1, "Parent", 7)]).length, 1);
  assert.equal(validateNavigation([navItem(1, "y".repeat(23))]).length, 1);
});

test("colour helpers: hex normalising and the white-text contrast check", () => {
  assert.equal(normaliseHex("#ABC"), "#aabbcc");
  assert.equal(normaliseHex("ea6619"), "#ea6619");
  assert.equal(normaliseHex("#12345"), null);
  assert.equal(contrastLevel("#000000"), "good");
  assert.equal(contrastLevel("#ffffff"), "poor");
  assert.equal(contrastLevel(DEFAULT_PRIMARY_HEX), "large-only");
  assert.ok(contrastWithWhite("#ffffff") < 1.1);
});

test("a published page marked 'Show in main menu' reaches the menu; the switch, a new URL and deletion keep it consistent", () => {
  const page = { name: "Scholarships", slug: "scholarships", status: "Published", inNav: true };
  const base = [navItem(1, "Home")];
  const added = syncPageNavigation(base, page);
  assert.deepEqual(added.map((i) => [i.label, i.to]), [["Home", "/n1"], ["Scholarships", "/scholarships"]]);
  assert.equal(syncPageNavigation(added, page).length, 2, "already present: no duplicate");
  assert.equal(syncPageNavigation(base, { ...page, status: "Draft" }).length, 1, "a draft page is not added");
  assert.equal(syncPageNavigation(added, { ...page, slug: "grants" }, "scholarships")[1].to, "/grants", "the menu follows a changed URL");
  assert.equal(syncPageNavigation(added, { ...page, inNav: false }).length, 1, "switch off removes it");
  const nested = [{ ...navItem(1, "Study", 0), to: "/scholarships", children: [{ id: "k", label: "More", to: "/more", external: false, visible: true }] }];
  const cleared = syncPageNavigation(nested, { ...page, inNav: false });
  assert.deepEqual([cleared.length, cleared[0].to, cleared[0].children.length], [1, "", 1], "a dropdown parent with children is kept, only its link is cleared");
  const full = Array.from({ length: NAV_LIMITS.maxTopLevel }, (_, i) => navItem(i));
  assert.throws(() => syncPageNavigation(full, page), /already has 7 items/);
});

test("local drafts round-trip, are keyed per tenant, editor and record, and survive unavailable storage", () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
  const key = draftKey("school.example", "footer", "footer");
  assert.notEqual(key, draftKey("other.example", "footer", "footer"));
  assert.notEqual(key, draftKey("school.example", "course", "footer"));
  assert.equal(readDraft(key, storage), null);
  assert.equal(writeDraft(key, { about: "Unsaved text" }, storage), true);
  assert.deepEqual(readDraft<{ about: string }>(key, storage)?.value, { about: "Unsaved text" });
  clearDraft(key, storage);
  assert.equal(readDraft(key, storage), null);
  memory.set(key, "{not json");
  assert.equal(readDraft(key, storage), null, "a corrupt draft is ignored");
  assert.equal(writeDraft(key, { huge: "x".repeat(2_000_000) }, storage), false, "an oversized draft is skipped, not thrown");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(readDraft(key, broken), null);
  assert.equal(writeDraft(key, {}, broken), false);
  assert.doesNotThrow(() => clearDraft(key, broken));
});

// ---- footer logos, header preview model and stored-draft listing ----
import { footerLogos, LEGACY_ACKNOWLEDGEMENT_LOGO, LEGACY_FOOTER_LOGO } from "../src/config/brandFallbacks.ts";
import { previewNavigation } from "../src/pages/admin/lib/previewModels.ts";
import { listDrafts } from "../src/pages/admin/lib/draftStore.ts";

test("footer logos: the settings logo wins; the legacy images are only a fallback for the legacy site", () => {
  assert.deepEqual(footerLogos("https://cdn.example/logo.png", false), { main: "https://cdn.example/logo.png", acknowledgement: "https://cdn.example/logo.png" });
  assert.deepEqual(footerLogos("https://cdn.example/logo.png", true), { main: "https://cdn.example/logo.png", acknowledgement: "https://cdn.example/logo.png" });
  assert.deepEqual(footerLogos("  ", false), { main: LEGACY_FOOTER_LOGO, acknowledgement: LEGACY_ACKNOWLEDGEMENT_LOGO });
  assert.deepEqual(footerLogos("", true), { main: "", acknowledgement: "" }, "a tenant never shows the legacy images");
});

test("header preview shows what the public header would build: visible items and children with a label only", () => {
  const nav = previewNavigation([
    { id: "a", label: "About", to: "/about", visible: true, children: [{ id: "a1", label: "Team", to: "/team", external: false, visible: true }, { id: "a2", label: "", to: "/x", external: false, visible: true }, { id: "a3", label: "Hidden", to: "/h", external: false, visible: false }] },
    { id: "b", label: "Hidden item", to: "/b", visible: false, children: [] },
    { id: "c", label: "  ", to: "/c", visible: true, children: [] },
    { id: "d", label: "Contact", to: "", visible: true, children: [] },
  ]);
  assert.deepEqual(nav, [{ label: "About", to: "/about", external: false, children: [{ label: "Team", to: "/team" }] }, { label: "Contact", to: undefined, external: false }]);
});

test("stored drafts of one editor are listed newest first and never mix editors or tenants", () => {
  const data = new Map<string, string>();
  const storage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  data.set(draftKey("t", "page", "new"), JSON.stringify({ value: { a: 1 }, savedAt: 100 }));
  data.set(draftKey("t", "page", "p-2"), JSON.stringify({ value: { a: 2 }, savedAt: 300 }));
  data.set(draftKey("t", "seo", "s-1"), JSON.stringify({ value: {}, savedAt: 500 }));
  data.set(draftKey("other", "page", "p-9"), JSON.stringify({ value: {}, savedAt: 900 }));
  data.set(draftKey("t", "page", "broken"), "{nope");
  assert.deepEqual(listDrafts("t", "page", storage).map((d) => d.recordId), ["p-2", "new"]);
  assert.deepEqual(listDrafts("t", "faq", storage), []);
  assert.deepEqual(listDrafts("t", "page", null), []);
});

// ---- single portal sign-in: database-resolved role decides landing page, user-management UI and no-access messages ----
test("sign-in: each role lands on its own page and unknown roles never get one", () => {
  assert.equal(portalLanding("slit_admin"), "/agency/dashboard");
  assert.equal(portalLanding("agency_admin"), "/agency/workspace");
  assert.equal(portalLanding("agent"), "/agency/workspace");
});

test("sign-in: only organization and agency admins are shown user management", () => {
  assert.equal(canManagePortalUsers("slit_admin"), true);
  assert.equal(canManagePortalUsers("agency_admin"), true);
  assert.equal(canManagePortalUsers("agent"), false);
  assert.equal(canManagePortalUsers(null), false);
});

test("sign-in: suspended, expired and unassigned accounts each get a distinct clear message", () => {
  const messages = ["agency_suspended", "user_suspended", "invite_expired", "no_access", "pending_review", "registration_declined"].map(portalAccessMessage);
  assert.equal(new Set(messages).size, 6);
  assert.match(portalAccessMessage("pending_review"), /reviewing your agent account/i);
  assert.match(portalAccessMessage("registration_declined"), /not approved/i);
  assert.match(portalAccessMessage("agency_suspended"), /agency is currently suspended/i);
  assert.match(portalAccessMessage("user_suspended"), /deactivated/i);
  assert.match(portalAccessMessage("invite_expired"), /expired/i);
  assert.match(portalAccessMessage(null), /not linked to an agency/i);
});

// ---- single /login: safe return paths, old URL redirects, role routing, messages and the header ----
import { readFileSync } from "node:fs";
import { decideLogin, headerAccountLink, legacyLoginTarget, loginErrorMessage, loginNotice, loginUrl, safeNext } from "../src/lib/loginRouting.ts";

test("login: only same-origin return paths are accepted", () => {
  for (const ok of ["/admin", "/admin/courses?x=1#top", "/agency/applications/abc"]) assert.equal(safeNext(ok), ok, ok);
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "admin", "/a\nb", "/login", "/login?next=/admin", "", null, undefined, 5]) assert.equal(safeNext(bad as string), null, String(bad));
  assert.equal(safeNext("/" + "a".repeat(2100)), null);
});

test("login: unauthenticated users go to /login with a safe next; old login URLs redirect there", () => {
  assert.equal(loginUrl("/admin/courses"), "/login?next=%2Fadmin%2Fcourses");
  assert.equal(loginUrl("https://evil.example"), "/login");
  assert.equal(loginUrl("/agency/applications", true), "/login?next=%2Fagency%2Fapplications&reason=expired");
  assert.equal(legacyLoginTarget(""), "/login");
  assert.equal(legacyLoginTarget("?next=/agency/applications"), "/login?next=%2Fagency%2Fapplications");
  assert.equal(legacyLoginTarget("?next=//evil.example"), "/login");
  assert.equal(legacyLoginTarget("", "/admin/pages"), "/login?next=%2Fadmin%2Fpages");
  assert.equal(legacyLoginTarget("", "https://evil.example"), "/login");
});

test("login: each kind of access lands in the right place; SLIT admins go to the CMS and other multiple kinds ask first", () => {
  const cms = { active: true, mustChangePassword: false };
  assert.deepEqual(decideLogin({ cms, portal: "no_access" }), { kind: "go", to: "/admin" });
  assert.deepEqual(decideLogin({ cms: null, portal: "active" }), { kind: "go", to: "/agency" });
  assert.deepEqual(decideLogin({ cms, portal: "org_admin" }), { kind: "go", to: "/admin" }, "a SLIT administrator is never asked to choose");
  assert.deepEqual(decideLogin({ cms, portal: "org_admin" }, null, "portal"), { kind: "go", to: "/admin" }, "not even when the portal was used last");
  assert.deepEqual(decideLogin({ cms, portal: "active" }, null, "portal"), { kind: "choose", options: ["portal", "cms"] });
  assert.deepEqual(decideLogin({ cms, portal: "no_access" }, "/admin/courses"), { kind: "go", to: "/admin/courses" });
  assert.deepEqual(decideLogin({ cms: null, portal: "active" }, "/admin/courses"), { kind: "go", to: "/agency" }, "a return path into an area the user cannot use is ignored");
  assert.deepEqual(decideLogin({ cms, portal: "org_admin" }, "/agency/users"), { kind: "go", to: "/agency/users" });
  assert.deepEqual(decideLogin({ cms: { active: true, mustChangePassword: true }, portal: "no_access" }, "/admin/courses"), { kind: "password", to: "/admin/set-password" });
});

test("login: no role, suspended, invited and expired states are blocked with distinct messages", () => {
  const blocked = (access: Parameters<typeof decideLogin>[0]) => { const d = decideLogin(access); assert.equal(d.kind, "blocked"); return d.kind === "blocked" ? d.message : ""; };
  const messages = [
    blocked({ cms: null, portal: "no_access" }), blocked({ cms: null, portal: "user_suspended" }), blocked({ cms: null, portal: "agency_suspended" }),
    blocked({ cms: null, portal: "invite_expired" }), blocked({ cms: { active: false, mustChangePassword: false }, portal: "no_access" }),
  ];
  assert.equal(new Set(messages).size, 5);
  assert.match(messages[0], /not linked/i);
  assert.match(messages[2], /agency is currently suspended/i);
  assert.match(blocked({ cms: null, portal: null }), /not linked/i);
});

test("login: failures are generic, rate limits and unaccepted invitations are explained, expired sessions are announced", () => {
  assert.equal(loginErrorMessage({ message: "Invalid login credentials", code: "invalid_credentials", status: 400 }), "Incorrect email or password.");
  assert.equal(loginErrorMessage({ message: "User not found" }), "Incorrect email or password.");
  assert.equal(loginErrorMessage(null), "Incorrect email or password.");
  assert.match(loginErrorMessage({ status: 429, code: "over_request_rate_limit" }), /too many attempts/i);
  assert.match(loginErrorMessage({ code: "email_not_confirmed", message: "Email not confirmed" }), /invitation has not been accepted/i);
  assert.match(loginNotice("expired"), /session has expired/i);
  assert.equal(loginNotice(null), "");
});

test("header: one Login / Enroll Now button for everyone, and no Agency Portal or separate Enroll Now button", () => {
  assert.deepEqual(headerAccountLink(false), { label: "Login / Enroll Now", to: "/login" });
  assert.deepEqual(headerAccountLink(true), { label: "Login / Enroll Now", to: "/login" });
  const header = readFileSync(new URL("../src/components/feature/SiteHeader.tsx", import.meta.url), "utf8");
  for (const gone of ["Agency Portal", "/agency/login", "/admin/login"]) assert.ok(!header.includes(gone), gone);
  assert.ok(!header.includes("Enroll Now"), "the header uses the one Login / Enroll Now button");
});

// ---- user dialogs: pure validation, self / last-admin guards and safe server-error mapping ----
import { deactivationBlock, mapServerError, normaliseEmail, roleChangeBlock, validateEmail, validateName, validateRole, validateUserForm } from "../src/pages/agency/lib/userValidation.ts";

test("user dialog: names are required, trimmed, 2-100 characters and free of control characters", () => {
  assert.equal(validateName("  Priya Nair "), null);
  for (const bad of ["", "   ", "A", "x".repeat(101), "Bad\u0000Name", "Tab\tName"]) assert.notEqual(validateName(bad), null, JSON.stringify(bad));
  assert.equal(validateName("x".repeat(100)), null);
  assert.equal(validateName(" ab "), null);
});

test("user dialog: emails are normalised, validated, length-limited and unique case-insensitively", () => {
  assert.equal(normaliseEmail("  Priya@Agency.COM "), "priya@agency.com");
  assert.equal(validateEmail(" Priya@Agency.com "), null);
  for (const bad of ["", "nope", "a@b", "a b@c.com", "a@@b.com", "<x>@b.com", "a@b.com\n", `${"x".repeat(250)}@b.com`]) assert.notEqual(validateEmail(bad), null, JSON.stringify(bad));
  assert.match(validateEmail("PRIYA@agency.com", ["priya@Agency.com"]) ?? "", /already in the list/i);
  assert.equal(validateEmail("new@agency.com", ["priya@agency.com"]), null);
});

test("user dialog: roles must be one the page allows; add needs an agency only when asked; edit never revalidates the email", () => {
  assert.equal(validateRole("agent", ["agent", "agency_admin"]), null);
  for (const bad of ["", "slit_admin", "owner"]) assert.notEqual(validateRole(bad, ["agent", "agency_admin"]), null, bad);
  const ctx = { mode: "add" as const, existingEmails: [], allowedRoles: ["agent", "agency_admin"], needsAgency: true, nameEditable: true };
  assert.deepEqual(Object.keys(validateUserForm({ name: "", email: "x", role: "", agencyId: "" }, ctx)).sort(), ["agencyId", "email", "name", "role"]);
  assert.deepEqual(validateUserForm({ name: "Ada Lovelace", email: "ada@x.com", role: "agent", agencyId: "a1" }, ctx), {});
  assert.deepEqual(validateUserForm({ name: "", email: "bad", role: "agent", agencyId: "" }, { ...ctx, mode: "edit", needsAgency: false, nameEditable: false }), {});
});

test("user dialog: you cannot deactivate yourself or the last active administrator, and cannot demote the last one", () => {
  assert.match(deactivationBlock({ isSelf: true, targetRole: "agent", targetActive: true, activeAdmins: 3 }) ?? "", /your own account/i);
  assert.match(deactivationBlock({ isSelf: false, targetRole: "agency_admin", targetActive: true, activeAdmins: 1 }) ?? "", /last active agency administrator/i);
  assert.equal(deactivationBlock({ isSelf: false, targetRole: "agency_admin", targetActive: true, activeAdmins: 2 }), null);
  assert.equal(deactivationBlock({ isSelf: false, targetRole: "agent", targetActive: true, activeAdmins: 1 }), null);
  assert.equal(deactivationBlock({ isSelf: true, targetRole: "agent", targetActive: false, activeAdmins: 1 }), null, "reactivation is never blocked");
  assert.match(roleChangeBlock({ currentRole: "agency_admin", newRole: "agent", targetActive: true, activeAdmins: 1 }) ?? "", /last active agency administrator/i);
  assert.equal(roleChangeBlock({ currentRole: "agency_admin", newRole: "agent", targetActive: true, activeAdmins: 2 }), null);
});

test("user dialog: server errors map to a field or a fixed message and never expose raw text", () => {
  assert.deepEqual(mapServerError(new Error("This email already belongs to an active portal user.")).field, "email");
  assert.deepEqual(mapServerError(new Error("This email has already been invited. Resend or revoke the pending invitation.")).field, "email");
  assert.equal(mapServerError(new Error("Role must be agency administrator or agent.")).field, "role");
  assert.equal(mapServerError(new Error("This is the last active agency administrator. Add another administrator first.")).field, undefined);
  for (const raw of ["duplicate key value violates unique constraint \"agency_memberships_pkey\" 8f2c1d3e-0000-4000-8000-000000000001", "TypeError: x is undefined\n    at stack.ts:1", ""]) {
    const mapped = mapServerError(new Error(raw));
    assert.ok(!mapped.message.includes("8f2c1d3e") && !mapped.message.includes("stack") && !mapped.message.includes("duplicate key"), mapped.message);
  }
});

// ---- Edge Function input rules shared by cms-admin-users and portal-admin-users ----
import { cleanEmail, cleanName } from "../supabase/functions/_shared/user-input.ts";

test("edge input: emails are trimmed, lower-cased, capped at 254 and free of control characters", () => {
  assert.deepEqual(cleanEmail("  MiXed@Example.COM "), { ok: true, value: "mixed@example.com" });
  for (const bad of ["", "   ", "nope", "a@b", "a b@c.com", "a\u0001@b.com", `${"x".repeat(250)}@b.com`, null, undefined]) assert.equal(cleanEmail(bad).ok, false, JSON.stringify(bad));
  assert.equal(cleanEmail(`${"x".repeat(240)}@example.com`).ok, true);
});

test("edge input: names are required, trimmed, 2-100 characters and free of control characters", () => {
  assert.deepEqual(cleanName("  Priya Nair "), { ok: true, value: "Priya Nair" });
  for (const bad of ["", "  ", "A", "x".repeat(101), "Bad\u0000Name", "Tab\tName", null, undefined]) assert.equal(cleanName(bad).ok, false, JSON.stringify(bad));
  assert.equal(cleanName("x".repeat(100)).ok, true);
});

test("edge input: cms-admin-users rejects unknown roles instead of defaulting to Editor", () => {
  const source = readFileSync(new URL("../supabase/functions/cms-admin-users/index.ts", import.meta.url), "utf8");
  assert.ok(/role !== "Admin" && role !== "Editor"\) return json\(\{ error: "Role must be Admin or Editor\." \}, 400\)/.test(source));
  assert.ok(!source.includes('String(parsed.role ?? "Editor")'));
});

// ---- Status model (20261113260000): statuses, labels and moves come from the database; the frontend has none of its own ----
test("status model: the catalogue lists ten statuses in order, Offer letter issued between Action required and Offer accepted", () => {
  assert.deepEqual(seededWorkflow.statuses.map((s) => s.value), ["draft", "submitted", "under_review", "action_required", "offer_issued", "offer_accepted", "coe_issued", "enrolled", "rejected", "withdrawn"]);
  assert.equal(statusInfo(seededWorkflow, "offer_issued").label, "Offer letter issued");
  assert.equal(statusInfo(seededWorkflow, "coe_issued").label, "CoE / VoE issued");
  assert.deepEqual(currentStatuses(seededWorkflow).map((s) => s.value).includes("under_review"), false, "the legacy status is not offered in filters");
  assert.equal(statusInfo(seededWorkflow, "submitted").hint, "Ready for offer letter");
});

test("status model: Take action shows exactly the staff actions of each status, in order", () => {
  const menu = (status: string) => actionsFor(seededWorkflow, status, "staff").map((x) => x.label);
  assert.deepEqual(menu("submitted"), ["Issue offer letter", "Action required", "Withdraw", "Reject"]);
  assert.deepEqual(menu("action_required"), ["Send reminder", "Withdraw", "Reject"]);
  assert.deepEqual(menu("offer_issued"), ["Resend offer letter", "Mark offer accepted", "Withdraw", "Reject"]);
  assert.deepEqual(menu("offer_accepted"), ["Issue CoE / VoE", "Withdraw", "Reject"]);
  assert.deepEqual(menu("coe_issued"), ["Mark enrolled", "Withdraw"]);
  assert.deepEqual(menu("enrolled"), [], "No action");
  assert.deepEqual(menu("rejected"), [], "No action");
  // Reasons are required where the drawer asks for one.
  const note = (status: string, action: string) => seededWorkflow.actions.find((x) => x.from === status && x.action === action)?.note;
  assert.equal(note("submitted", "action_required"), "required");
  assert.equal(note("submitted", "reject"), "required");
  assert.equal(note("offer_issued", "mark_accepted"), "required");
});

test("status model: the applicant submits a draft, resubmits after Action required and accepts an issued offer; nothing else", () => {
  assert.equal(canSubmitFrom(seededWorkflow, "draft"), true);
  for (const status of seededWorkflow.statuses.map((s) => s.value).filter((s) => s !== "draft")) assert.equal(canSubmitFrom(seededWorkflow, status), false, status);
  assert.deepEqual(seededWorkflow.actions.filter((x) => x.actor === "applicant").map((x) => `${x.from}>${x.to}`).sort(), ["action_required>submitted", "draft>submitted", "offer_issued>offer_accepted"]);
  const workspace = readFileSync(new URL("../src/pages/agency/components/ApplicationWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(workspace.includes("canSubmitFrom(workflow, application.status)"));
});

test("status model: no status list, label or move is written into the frontend", () => {
  for (const file of ["src/pages/agency/lib/applicationAccess.ts", "src/pages/agency/lib/portalData.ts", "src/pages/agency/applications/detail/page.tsx", "src/pages/agency/components/ApplicationsTable.tsx", "src/pages/admin/lib/agencyStatus.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/["'](offer_accepted|coe_issued|under_review|offer_issued)["']\s*[:,\]]/.test(text), `${file} lists statuses`);
    assert.ok(!/STATUS_LABELS|STATUS_META|nextStatusOptions|SELECTABLE_STATUSES/.test(text), `${file} keeps a status table`);
  }
  const detail = readFileSync(new URL("../src/pages/agency/applications/detail/page.tsx", import.meta.url), "utf8");
  assert.ok(!detail.includes("Change status"), "the header has no status control: every change goes through Take action");
  assert.ok(!detail.includes("Note for the applicant"), "the header has no message box");
});

// ---- P08-05: admin-managed notification recipients (pure UI validation; the database re-validates) ----
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS, configWithEvent, eventErrorMessage, hasAnyRecipient, parseRecipients, validateEventForm } from "../src/lib/notificationEvents.ts";

test("recipients: addresses are split, trimmed, lower-cased and validated; duplicates and more than 10 are reported", () => {
  assert.deepEqual(parseRecipients("  Admissions@Example.EDU.au \n ops@example.test, it@example.test;qa@example.test").emails, ["admissions@example.edu.au", "ops@example.test", "it@example.test", "qa@example.test"]);
  assert.equal(parseRecipients("").error, null);
  assert.match(parseRecipients("not-an-email").error ?? "", /not a valid email/i);
  assert.match(parseRecipients("a@b.test, A@B.test").error ?? "", /listed twice/i);
  assert.match(parseRecipients(Array.from({ length: 21 }, (_, i) => `r${i}@example.test`).join("\n")).error ?? "", /at most 20/i);
  assert.match(parseRecipients(`${"x".repeat(250)}@b.test`).error ?? "", /not a valid/i);
});

test("recipients: the form builds the settings object and warns when nobody would be emailed", () => {
  const ok = validateEventForm({ recipientsText: "Ops@Example.test", notifyAgent: false, notifyAgencyAdmins: false, notifyStudent: true });
  assert.deepEqual(ok, { settings: { recipients: ["ops@example.test"], notifyAgent: false, notifyAgencyAdmins: false, notifyStudent: true }, error: null });
  assert.equal(hasAnyRecipient(ok.settings), true);
  assert.equal(hasAnyRecipient({ recipients: [], notifyAgent: false, notifyAgencyAdmins: false, notifyStudent: false }), false);
  assert.notEqual(validateEventForm({ recipientsText: "bad", notifyAgent: true, notifyAgencyAdmins: false, notifyStudent: false }).error, null);
});

test("recipients: a tenant save keeps every other published field and never copies the built-in defaults", () => {
  const settings = { recipients: ["ops@example.test"], notifyAgent: true, notifyAgencyAdmins: false, notifyStudent: false };
  const published = configWithEvent("published", { sender: { name: "X", email: "a@b.test" }, events: { offer_accepted: { recipients: [] } } }, "coe_voe_issued", settings);
  assert.deepEqual(Object.keys(published).sort(), ["events", "sender"]);
  assert.deepEqual(Object.keys(published.events as object).sort(), ["coe_voe_issued", "offer_accepted"]);
  assert.deepEqual(configWithEvent("default", { templates: { big: true } }, "offer_accepted", settings), { events: { offer_accepted: settings } });
});

test("recipients: the four events match the database and server errors become fixed messages", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261027060000_notification_event_recipients.sql", import.meta.url), "utf8");
  const listed = /create function public\.notification_default_event_settings[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
  assert.deepEqual([...listed.matchAll(/when '(\w+)' then/g)].map((m) => m[1]).sort(), [...NOTIFICATION_EVENTS].sort());
  for (const event of NOTIFICATION_EVENTS) assert.ok(NOTIFICATION_EVENT_LABELS[event].title);
  assert.match(eventErrorMessage({ code: "42501", message: "Organization administrator access required" }), /permission/i);
  assert.match(eventErrorMessage({ code: "40001" }), /changed since/i);
  assert.match(eventErrorMessage({ code: "22023", message: "Duplicate recipient email address" }), /listed twice/i);
  assert.ok(!eventErrorMessage({ code: "XX000", message: "duplicate key value 8f2c1d3e" }).includes("8f2c1d3e"));
});

// ---- P08-07: CoE / VoE upload and issue rules ----
import { COE_KINDS, MAX_COE_BYTES, coeErrorMessage, issueBlockers, validatePdfBytes, validatePdfFile } from "../src/pages/agency/lib/coeVoe.ts";

test("coe/voe: only plain-named PDFs up to 3 MB are accepted, and the content must really be a complete PDF", () => {
  assert.equal(validatePdfFile({ name: "CoE Jane (2027).pdf", size: 1000 }), null);
  for (const bad of [{ name: "coe.docx", size: 1000 }, { name: "../coe.pdf", size: 1000 }, { name: "coe.pdf", size: 3 }, { name: "coe.pdf", size: MAX_COE_BYTES + 1 }, { name: ".pdf", size: 1000 }]) assert.notEqual(validatePdfFile(bad), null, JSON.stringify(bad));
  const enc = (text: string) => new TextEncoder().encode(text);
  assert.equal(validatePdfBytes(enc("%PDF-1.4\nbody\n%%EOF\n")), null);
  assert.match(validatePdfBytes(enc("PK\u0003\u0004 renamed zip")) ?? "", /not a PDF/);
  assert.match(validatePdfBytes(enc("%PDF-1.4\ntruncated")) ?? "", /incomplete/);
  assert.deepEqual(COE_KINDS.map((k) => k.value), ["coe", "voe"]);
});

test("coe/voe: Approve and issue is blocked for every reason the database would refuse it", () => {
  const ok = { applicationStatus: "offer_accepted", registrationState: "verified", hasDocument: true, issued: false };
  assert.deepEqual(issueBlockers(ok), []);
  assert.equal(issueBlockers({ ...ok, applicationStatus: "submitted" }).length, 1);
  assert.equal(issueBlockers({ ...ok, registrationState: "lodged" }).length, 1);
  assert.equal(issueBlockers({ ...ok, hasDocument: false }).length, 1);
  assert.equal(issueBlockers({ ...ok, applicationStatus: "submitted", registrationState: null, hasDocument: false }).length, 3);
  assert.deepEqual(issueBlockers({ ...ok, issued: true }), ["The CoE / VoE has already been issued."]);
  assert.match(coeErrorMessage({ code: "42501" }), /permission/i);
  assert.ok(!coeErrorMessage({ code: "XX000", message: "relation enrollment_coe_documents 8f2c1d3e" }).includes("8f2c1d3e"));
});


test("shared table keeps conditional column labels, native controls, and full-width messages aligned", () => {
  const html = renderToStaticMarkup(h(ResponsiveTable, { "aria-label": "Registrations", "aria-busy": true },
    h("thead", null, h("tr", null, h("th", null, "Student"), false, h("th", null, "Actions"))),
    h("tbody", null,
      h("tr", null, h("td", null, "Sample Student"), null, h("td", null, h("input", { type: "checkbox", "aria-label": "Select for export", defaultChecked: true }))),
      h("tr", null, h("td", { colSpan: 2 }, "Loading registrations")))));
  assert.match(html, /data-label="Student"/);
  assert.match(html, /data-label="Actions"/);
  assert.match(html, /scope="col"/);
  assert.match(html, /headers="[^"]+-column-1"/);
  assert.match(html, /type="checkbox"[^>]*aria-label="Select for export"[^>]*checked/);
  assert.match(html, /colSpan="2"[^>]*data-table-message/i);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/data-label=/g) ?? []).length, 2);
});

test("shared table exposes sorting controls in the small-screen toolbar without invoking handlers", () => {
  let calls = 0;
  const html = renderToStaticMarkup(h(ResponsiveTable, null,
    h("thead", null, h("tr", null, h("th", null, h("button", { onClick: () => { calls++; } }, "Student")))),
    h("tbody", null, h("tr", null, h("td", null, "Name")))));
  assert.match(html, /aria-label="Table sorting"/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.equal(calls, 0);
});

// ---- Agencies list: application status breakdown ----
import { sortedStatusCounts } from "../src/pages/admin/lib/agencyStatus.ts";

test("agencies list: status breakdown follows the catalogue order and drops empty or unknown statuses", () => {
  assert.deepEqual(sortedStatusCounts({ offer_accepted: 1, draft: 2, action_required: 1, enrolled: 0, mystery: 4 }, seededWorkflow.statuses),
    [["draft", 2], ["action_required", 1], ["offer_accepted", 1]]);
  assert.deepEqual(sortedStatusCounts(undefined, seededWorkflow.statuses), []);
  assert.deepEqual(sortedStatusCounts({}, seededWorkflow.statuses), []);
});

// ---- Businesses, agents and students (CMS) ----
import { groupByStudent } from "../src/pages/admin/lib/businessGroups.ts";
import type { ApplicationRow } from "../src/pages/admin/lib/businessData.ts";

test("agent page: applications group under their student, newest activity first, unknown students kept", () => {
  const app = (id: string, studentId: string): ApplicationRow => ({ id, reference: id, status: "draft", intake: "", completion: 0, createdAt: "", updatedAt: "",
    submittedAt: null, studentId, agentId: "a", agentName: "Agent", courses: [] });
  const groups = groupByStudent([app("1", "s2"), app("2", "s1"), app("3", "s2"), app("4", "s9")],
    [{ id: "s1", name: "One", email: "" }, { id: "s2", name: "Two", email: "" }]);
  assert.deepEqual(groups.map((g) => [g.student.name, g.applications.map((a) => a.id)]), [["Two", ["1", "3"]], ["One", ["2"]], ["Student", ["4"]]]);
});

test("business, agent and student screens fit the page: no horizontal scrolling tables", () => {
  for (const file of ["BusinessesPage", "BusinessDetailPage", "AgentsPage", "AgentDetailPage", "StudentsPage", "StudentDetailPage",
    "components/StudentsTable", "components/ApplicationsList"]) {
    const source = readFileSync(`src/pages/admin/${file}.tsx`, "utf8");
    assert.doesNotMatch(source, /overflow-x-auto|min-w-\[\d/, `${file} must not scroll sideways`);
    if (/<thead>/.test(source)) assert.match(source, /ResponsiveTable/, `${file} uses the shared responsive table`);
  }
});

// ---- Agents: activation starts from the agent's own business, or the one OMARA lists ----
import { toActivate } from "../src/pages/admin/lib/agentActivation.ts";

test("agents: the Activate dialog starts from the agent's business and knows whether they already have a login", () => {
  const base = { key: "g1", agentId: "g1", omaraId: "o1", profileId: null, invitationId: null, name: "Anna Lee", email: "", phone: "0412 000 000", role: "agent" as const, status: "Inactive" as const,
    statusChangedAt: null, marn: "1100001", registered: true, businessId: "b1", businessName: "Bright Futures", businessStatus: "Inactive" as const, students: 0, statusCounts: {} };
  const start = toActivate(base);
  assert.deepEqual(start.business, { id: "b1", name: "Bright Futures", status: "Inactive" }, "every agent belongs to one business");
  assert.equal(start.hasLogin, false);
  assert.equal(start.agentId, "g1");
  assert.equal(start.marn, "1100001", "the MARN is kept so activation keeps the OMARA link");
  assert.equal(start.phone, "0412 000 000");
  assert.equal(toActivate({ ...base, profileId: "p1", role: "agency_admin" }).hasLogin, true);
});

// Agency ABN onboarding: deterministic fixtures only; no government calls.
import { normalizeAbn, validateAbn, parseAgencyAbnPage, lookupAgencyAbn } from '../supabase/functions/_shared/validation/abn.ts';

test('new manual agencies require checksum-valid ABNs; legacy editing remains compatible', () => {
  assert.equal(normalizeAbn('85 165 345 717'), '85165345717');
  assert.equal(validateAbn('85 165 345 717'), '');
  assert.ok(validateAbn('')); assert.ok(validateAbn('85165345718')); assert.ok(validateAbn('8516534571a'));
  const form = { ...EMPTY_AGENCY_FORM, name: 'Sample', code: 'SAM-001', businessEmail: 'agency@example.test' };
  assert.ok(validateAgencyForm(form, true).errors.registrationNumber);
  assert.equal(validateAgencyForm(form).errors.registrationNumber, undefined);
  assert.equal(validateAgencyForm({ ...form, registrationNumber: '85165345717' }, true).errors.registrationNumber, undefined);
});

test('ABN lookup extracts only published business data and fails closed on a different ABN or blocked page', async () => {
  const html = `<h1>Current details for ABN 85 165 345 717</h1><table>
    <tr><th>Entity name:</th><td>SYNTHETIC &amp; COMPANY</td></tr>
    <tr><th>ABN status:</th><td>Active from 19&nbsp;Jun&nbsp;2020</td></tr>
    <tr><th>Entity type:</th><td>Individual/Sole Trader</td></tr>
    <tr><th>Goods &amp; Services Tax (GST):</th><td>Not currently registered</td></tr>
    <tr><th>Main business location:</th><td>WA 6112</td></tr></table>
    <table><caption>Business name(s)</caption><tr><td>Sample agency</td><td>14 Sep 2025</td></tr></table>`;
  const result = parseAgencyAbnPage(html, '85165345717');
  assert.equal(result.legalName, 'SYNTHETIC & COMPANY');
  assert.deepEqual(result.businessNames, ['Sample agency']); assert.equal(result.postcode, '6112');
  assert.equal('email' in result, false); assert.equal('phone' in result, false);
  assert.throws(() => parseAgencyAbnPage(html, '95830955864'));
  assert.throws(() => parseAgencyAbnPage('<h1>Access denied</h1>', '85165345717'));
  let requested = '';
  const mock = (async (url: string) => { requested = url; return new Response(html); }) as typeof fetch;
  assert.equal((await lookupAgencyAbn('85 165 345 717', mock)).abn, '85165345717');
  assert.equal(requested, 'https://abr.business.gov.au/ABN/View?abn=85165345717');
  await assert.rejects(lookupAgencyAbn('https://evil.invalid', mock));
  await assert.rejects(lookupAgencyAbn('85165345717', (async () => new Response('Blocked', { status: 429 })) as typeof fetch));
});

// ---- Enroll now (migration 119): what a student or an agent types on the sign-in page ----
import { codeProblem,
  EMPTY_AGENT_ENROL, EMPTY_STUDENT_ENROL, abnProblem, agentEnrolPayload, dateOfBirthProblem, dateOfBirthRange, formatAbn, mobileProblem, parseDateOfBirth, studentEnrolPayload,
  validateAgentEnrol, validateStudentEnrol,
} from "../src/lib/enrolForm.ts";

test("enrol: the mobile comes from the country-code phone field, so overseas students can enrol", () => {
  for (const ok of ["+61412345678", "+919876543210", "+447700900123"]) assert.equal(mobileProblem(ok), "", ok);
  for (const bad of ["", "0412345678", "+61", "+6141234", "abc"]) assert.ok(mobileProblem(bad), bad);
});

test("enrol: the date of birth says which rule failed, and the picker is limited to 10 to 100 years ago", () => {
  const today = new Date(Date.UTC(2026, 10, 5));
  assert.deepEqual(dateOfBirthRange(today), { min: "1926-11-05", max: "2016-11-05" });
  assert.equal(dateOfBirthProblem("2000-01-02", today), "");
  assert.match(dateOfBirthProblem("", today), /enter your date of birth/i);
  assert.match(dateOfBirthProblem("2020-01-01", today), /between 10 and 100/i);
  assert.match(dateOfBirthProblem("1900-01-01", today), /between 10 and 100/i);
  assert.match(dateOfBirthProblem("31/02/2000", today), /real date/i);
});

test("enrol: dates of birth are typed day first and must be real and 10 to 100 years ago", () => {
  const today = new Date(Date.UTC(2026, 10, 5));
  assert.equal(parseDateOfBirth("02/01/2000", today), "2000-01-02");
  assert.equal(parseDateOfBirth("2-1-2000", today), "2000-01-02");
  assert.equal(parseDateOfBirth("2000-01-02", today), "2000-01-02");
  assert.equal(parseDateOfBirth("31/02/2000", today), null, "not a real date");
  assert.equal(parseDateOfBirth("05/11/2017", today), null, "younger than 10");
  assert.equal(parseDateOfBirth("05/11/2016", today), "2016-11-05", "exactly 10 is fine");
  assert.equal(parseDateOfBirth("04/11/1926", today), null, "older than 100");
  assert.equal(parseDateOfBirth("01/02/03", today), null);
  assert.equal(parseDateOfBirth("", today), null);
});

test("enrol: the ABN is checked like the Edge Function does and shown in groups", () => {
  assert.equal(abnProblem("85 165 345 717"), "");
  assert.ok(abnProblem(""));
  assert.ok(abnProblem("85165345718"));
  assert.ok(abnProblem("8516534571"));
  assert.equal(formatAbn("85165345717"), "85 165 345 717");
  assert.equal(formatAbn("851"), "85 1");
  assert.equal(formatAbn("85165345717999"), "85 165 345 717", "never more than 11 digits");
});

test("enrol: a student gives only email, mobile and a password and agrees (name and date of birth optional); the payload is normalised", () => {
  const today = new Date(Date.UTC(2026, 10, 5));
  const empty = validateStudentEnrol(EMPTY_STUDENT_ENROL, today);
  assert.deepEqual(Object.keys(empty).sort(), ["agreed", "email", "mobile", "password"]);
  const minimal = { ...EMPTY_STUDENT_ENROL, email: "a@b.test", mobile: "+61412345678", password: "long-enough-pw", agreed: true };
  assert.ok(validateStudentEnrol({ ...minimal, password: "short" }, today).password);
  assert.deepEqual(validateStudentEnrol(minimal, today), {});
  assert.equal(studentEnrolPayload(minimal, today).firstName, "");
  const form = { ...EMPTY_STUDENT_ENROL, firstName: " Stu ", lastName: "Dent", email: "Stu.Dent@Example.test ", mobile: "+61412345678", dateOfBirth: "2000-01-02", course: "X - Y", referralCode: " AGT-1 ", agreed: true, password: "long-enough-pw" };
  assert.deepEqual(validateStudentEnrol(form, today), {});
  assert.deepEqual(studentEnrolPayload(form, today), { kind: "student", firstName: "Stu", lastName: "Dent", email: "stu.dent@example.test", phone: "+61412345678", dateOfBirth: "2000-01-02", course: "X - Y", referralCode: "AGT-1" });
  assert.ok(validateStudentEnrol({ ...form, referralCode: "x".repeat(41) }, today).referralCode);
  assert.ok(validateStudentEnrol({ ...form, email: "not-an-email" }, today).email);
  assert.ok(validateStudentEnrol({ ...form, agreed: false }, today).agreed);
});

test("enrol: an agent must give the business, a valid ABN, a contact, a work email and a phone", () => {
  const empty = validateAgentEnrol(EMPTY_AGENT_ENROL);
  assert.deepEqual(Object.keys(empty).sort(), ["abn", "agreed", "businessName", "contactName", "email", "phone"]);
  const form = { ...EMPTY_AGENT_ENROL, businessName: " Sample Agency ", abn: "85 165 345 717", contactName: "Reg Istrar", email: "Reg@Example.test", phone: "+61398765432", agreed: true };
  assert.deepEqual(validateAgentEnrol(form), {});
  assert.deepEqual(agentEnrolPayload(form), { kind: "agent", businessName: "Sample Agency", abn: "85165345717", contactName: "Reg Istrar", email: "reg@example.test", phone: "+61398765432" });
  assert.ok(validateAgentEnrol({ ...form, abn: "85165345718" }).abn);
  assert.ok(validateAgentEnrol({ ...form, businessName: "A" }).businessName);
  assert.ok(validateAgentEnrol({ ...form, phone: "12" }).phone);
});

test("enrol: only Google, Facebook and phone accounts are offered the student details step", async () => {
  const { isSelfSignUpAccount } = await import("../src/lib/authProviders.ts").catch(() => ({ isSelfSignUpAccount: null }));
  if (!isSelfSignUpAccount) return; // the module reads Vite globals; covered by type-check when it cannot load here
  assert.equal(isSelfSignUpAccount({ app_metadata: { provider: "google", providers: ["google"] } }), true);
  assert.equal(isSelfSignUpAccount({ app_metadata: { provider: "phone" } }), true);
  assert.equal(isSelfSignUpAccount({ app_metadata: { provider: "email", providers: ["email", "facebook"] } }), true);
  assert.equal(isSelfSignUpAccount({ app_metadata: { provider: "email", providers: ["email"] } }), false);
  assert.equal(isSelfSignUpAccount(null), false);
});

test("enrol: the agent's email or phone already used by another company is shown as a popup, other errors are not", async () => {
  const { isContactConflict } = await import("../src/lib/enrolForm.ts");
  assert.equal(isContactConflict("The email you entered is already linked to another company. Please enter a different email, since this will be the admin account for your company."), true);
  assert.equal(isContactConflict("The phone number you entered is already linked to another company. Please enter a different phone number, since this will be the admin account for your company."), true);
  assert.equal(isContactConflict("The ABN you entered already exists in our system. Please contact Skyline to get registered."), false);
  assert.equal(isContactConflict("Enter a phone number."), false);
});

test("enrol: emails need a real-looking domain; Australian phones are 10 digits starting with 0, entered with the country code", async () => {
  const { validEmail, emailProblem, validateAgentEnrol, EMPTY_AGENT_ENROL } = await import("../src/lib/enrolForm.ts");
  for (const ok of ["name@company.com.au", "first.last+tag@mail.example.com", "a@b.io"]) assert.equal(validEmail(ok), true, ok);
  for (const bad of ["", "name", "name@", "@company.com", "name@company", "name@company.c", "name@@company.com", "na me@company.com",
    "name@company..com", ".name@company.com", "name.@company.com", "na..me@company.com", "name@-company.com", "name@company-.com", "name@company.123"]) {
    assert.equal(validEmail(bad), false, bad);
  }
  assert.match(emailProblem(""), /enter your email/i);
  assert.match(emailProblem("name@company"), /valid email/i);
  const form = { ...EMPTY_AGENT_ENROL, businessName: "Sample", abn: "85 165 345 717", contactName: "Reg Istrar", email: "reg@example.com.au", agreed: true };
  assert.equal(validateAgentEnrol({ ...form, phone: "+61398765432" }).phone, undefined, "Australian landline");
  assert.equal(validateAgentEnrol({ ...form, phone: "+61412345678" }).phone, undefined, "Australian mobile");
  assert.equal(validateAgentEnrol({ ...form, phone: "+919876543210" }).phone, undefined, "overseas number");
  assert.ok(validateAgentEnrol({ ...form, phone: "+6141234567" }).phone, "Australian number one digit short");
  assert.ok(validateAgentEnrol({ ...form, phone: "0412345678" }).phone, "without the country-code field");
  assert.ok(validateAgentEnrol({ ...form, phone: "" }).phone, "empty");
  assert.match(validateAgentEnrol({ ...form, email: "reg@example" }).email ?? "", /valid email/i);
});


test("sign up: the emailed code that claims an agent-created student record is 6 to 10 digits", () => {
  assert.equal(codeProblem("123456"), "");
  assert.equal(codeProblem(" 123 456 "), "");
  assert.equal(codeProblem("1234567890"), "");
  assert.notEqual(codeProblem("12345"), "");
  assert.notEqual(codeProblem("12a456"), "");
  assert.notEqual(codeProblem(""), "");
});

test("contact page: the Calendly link saved in the CMS must be a calendly.com scheduling page; the embed is a plain iframe address", () => {
  assert.equal(calendlyUrlProblem(""), "");
  assert.equal(calendlyUrlProblem("https://calendly.com/slit"), "");
  assert.equal(calendlyUrlProblem(" https://calendly.com/slit-admissions/30min "), "");
  assert.notEqual(calendlyUrlProblem("http://calendly.com/slit/30min"), "");
  assert.notEqual(calendlyUrlProblem("https://calendly.com/slit/30min?month=2026-11"), "");
  assert.notEqual(calendlyUrlProblem("https://example.com/calendly.com/slit"), "");
  assert.notEqual(calendlyUrlProblem("javascript:alert(1)"), "");
  assert.equal(calendlyEmbedSrc("https://calendly.com/slit/30min/", "slit.edu.au"), "https://calendly.com/slit/30min?embed_type=Inline&hide_gdpr_banner=1&embed_domain=slit.edu.au");
  assert.equal(calendlyEmbedSrc("https://calendly.com/slit", ""), "https://calendly.com/slit?embed_type=Inline&hide_gdpr_banner=1");
  assert.equal(calendlyEmbedSrc("https://example.com/x", "slit.edu.au"), "");
});

import EmailField from "../src/components/identity/EmailField.tsx";
import EmailInUseMessage from "../src/components/identity/EmailInUseMessage.tsx";
import {
  EMAIL_TAKEN_MESSAGE, emailStatusBlocks, emailTakenFrom, emailTakenFromFunctionError, isEmailTakenError, looksLikeEmail,
  normalizeEmail, shouldCheckEmail, takenDetailsFor,
} from "../src/lib/identity/email.ts";
import * as edgeEmail from "../supabase/functions/_shared/identity-email.ts";

const TRIGGER_ERROR = { code: "23505", hint: "email_taken", message: EMAIL_TAKEN_MESSAGE,
  details: "stu.x@example.test is already used by another student in SLIT. Each student needs their own email." };
const ROLE_CONFLICT = { code: "23505", hint: "login_role_conflict",
  message: "This email already signs in to the portal as an agent. One login can have only one portal role, so use a different email for this invite." };

test("identity email: normalizeEmail trims and lower-cases", () => {
  assert.equal(normalizeEmail("  Stu.X@Example.TEST \t"), "stu.x@example.test");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(looksLikeEmail(" A@b.co "), true);
  assert.equal(looksLikeEmail("jo@"), false);
});

test("identity email: isEmailTakenError matches the trigger (PostgREST), RPC and Edge Function shapes, and nothing else", () => {
  assert.equal(isEmailTakenError(TRIGGER_ERROR), true, "PostgREST error from the trigger");
  assert.equal(isEmailTakenError(ROLE_CONFLICT), true, "portal invite to a login with the other role");
  assert.equal(isEmailTakenError({ code: "email_taken", message: EMAIL_TAKEN_MESSAGE }), true, "Edge Function 409 body");
  assert.equal(isEmailTakenError({ code: "login_role_conflict", message: ROLE_CONFLICT.message }), true, "Edge Function 409 body, role conflict");
  assert.equal(isEmailTakenError(JSON.stringify({ code: "email_taken", message: EMAIL_TAKEN_MESSAGE })), true, "body still as text");
  assert.equal(isEmailTakenError({ error: { code: "23505", hint: "email_taken" } }), true, "nested under error");
  assert.equal(isEmailTakenError({ code: "23505", hint: "", message: "A student with this mobile already exists" }), false, "another duplicate is not an email error");
  assert.equal(isEmailTakenError({ code: "42501", hint: "email_taken" }), false, "hint without the unique-violation code");
  assert.equal(isEmailTakenError(new Error("This email is already in use. Please use a different email address.")), false, "message text alone is not trusted");
  assert.equal(isEmailTakenError(null), false);
  assert.equal(isEmailTakenError("not json"), false);
});

test("identity email: the field message is generic for email_taken and the server's sentence for login_role_conflict", () => {
  assert.deepEqual(emailTakenFrom(TRIGGER_ERROR), { reason: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: TRIGGER_ERROR.details });
  assert.equal(emailTakenFrom({ code: "email_taken", message: "Some other text" })?.message, EMAIL_TAKEN_MESSAGE);
  const ownRefusal = emailTakenFrom({ code: "23505", hint: "email_taken", message: "This email has already been invited. Resend or revoke the pending invitation." });
  assert.equal(ownRefusal?.message, EMAIL_TAKEN_MESSAGE);
  assert.equal(takenDetailsFor("admin", ownRefusal?.details), "This email has already been invited. Resend or revoke the pending invitation.", "admins see a function's own sentence");
  assert.equal(takenDetailsFor("portal", ownRefusal?.details), null, "agents do not");
  assert.equal(emailTakenFrom({ code: "email_taken", message: EMAIL_TAKEN_MESSAGE })?.details, null);
  const fromCause = new Error("We could not save this student.", { cause: { code: "23505", hint: "email_taken", message: "Another student already has this email" } });
  assert.equal(isEmailTakenError(fromCause), true, "a wrapper keeps the database error as its cause");
  assert.deepEqual(emailTakenFrom(ROLE_CONFLICT), { reason: "login_role_conflict", message: ROLE_CONFLICT.message, details: null });
});

test("identity email: an Edge Function 409 is read from the unread Response; other statuses are not email errors", async () => {
  const fnError = (status: number, body: unknown) => ({ name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code",
    context: new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(await emailTakenFromFunctionError(fnError(409, { code: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: "x is already used by another agent in SLIT." })),
    { reason: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: "x is already used by another agent in SLIT." });
  assert.equal(await emailTakenFromFunctionError(fnError(400, { code: "email_taken" })), null);
  assert.equal(await emailTakenFromFunctionError(fnError(409, { error: "This invitation is no longer pending." })), null);
  assert.equal((await emailTakenFromFunctionError(TRIGGER_ERROR))?.reason, "email_taken", "a PostgREST error passed straight through");
});

test("identity email: live checks only for signed-in forms, plausible emails and a changed email; Submit blocks while taken or checking", () => {
  assert.equal(shouldCheckEmail("new@example.test", "admin"), true);
  assert.equal(shouldCheckEmail("new@example.test", "portal"), true);
  assert.equal(shouldCheckEmail("new@example.test", "public"), false, "anonymous sign-up relies on the submit error");
  assert.equal(shouldCheckEmail("jo@", "admin"), false);
  assert.equal(shouldCheckEmail(" Own@Example.test ", "admin", "own@example.test"), false, "editing without changing the email: no check");
  assert.deepEqual(["idle", "checking", "available", "taken", "error"].map((s) => emailStatusBlocks(s as never)), [false, true, false, true, false]);
  assert.equal(takenDetailsFor("admin", "x is already used by another agent in SLIT."), "x is already used by another agent in SLIT.");
  assert.equal(takenDetailsFor("portal", "x is already used by another agent in SLIT."), null);
  assert.equal(takenDetailsFor("public", "x is already used by another agent in SLIT."), null);
});

test("identity email: Edge Functions answer 409 bodies the frontend maps; other duplicates are not email errors", () => {
  const db = { code: "23505", hint: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: "x is already used by another agent in SLIT." };
  assert.deepEqual(edgeEmail.emailConflictBody(db), { code: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: db.details, error: EMAIL_TAKEN_MESSAGE });
  assert.equal(edgeEmail.emailConflictBody({ ...ROLE_CONFLICT })?.code, "login_role_conflict");
  assert.equal(edgeEmail.emailConflictBody({ ...ROLE_CONFLICT })?.message, ROLE_CONFLICT.message);
  assert.equal(edgeEmail.emailConflictBody({ code: "23505", message: "A student with this mobile already exists" }), null);
  assert.equal(edgeEmail.emailConflictBody({ code: "22023", hint: "email_taken" }), null);
  assert.equal(isEmailTakenError(edgeEmail.publicEmailTakenBody()), true);
  assert.equal(edgeEmail.publicEmailTakenBody().details, null, "the public body never names the role");
  assert.equal(edgeEmail.EMAIL_TAKEN_MESSAGE, EMAIL_TAKEN_MESSAGE, "one sentence on both sides");
});

test("identity email: EmailInUseMessage shows the role detail to admins only", () => {
  const admin = renderToStaticMarkup(h(EmailInUseMessage, { context: "admin", details: TRIGGER_ERROR.details }));
  const portal = renderToStaticMarkup(h(EmailInUseMessage, { context: "portal", details: TRIGGER_ERROR.details }));
  assert.match(admin, /This email is already in use\. Please use a different email address\./);
  assert.match(admin, /already used by another student in SLIT/);
  assert.match(portal, /This email is already in use/);
  assert.doesNotMatch(portal, /another student/, "agents, students and the public never see the role");
  assert.match(renderToStaticMarkup(h(EmailInUseMessage, { context: "portal", message: ROLE_CONFLICT.message })), /already signs in to the portal as an agent/);
});

test("identity email: EmailField maps a submit error to the field, pinned to the submitted value", () => {
  const field = (props: Record<string, unknown>) => renderToStaticMarkup(h(EmailField, { value: "stu.x@example.test", onChange: () => {}, kind: "student", context: "admin", ...props }));
  const taken = field({ serverError: TRIGGER_ERROR });
  assert.match(taken, /data-email-status="taken"/);
  assert.match(taken, /aria-invalid="true"/);
  assert.match(taken, /aria-describedby="[^"]+-message"/);
  assert.match(taken, /This email is already in use/);
  assert.match(taken, /already used by another student in SLIT/, "admins see the role from the submit error");
  const portal = field({ context: "portal", serverError: TRIGGER_ERROR });
  assert.match(portal, /This email is already in use/);
  assert.doesNotMatch(portal, /another student/);
  assert.match(field({ context: "portal", serverError: ROLE_CONFLICT }), /already signs in to the portal as an agent/, "login_role_conflict shows the server's sentence");
  const publicTaken = field({ context: "public", serverError: { code: "email_taken", message: "An account with this email already exists. Sign in or reset your password." } });
  assert.match(publicTaken, /An account with this email already exists\. Sign in or reset your password\./);
  assert.match(publicTaken, /href="\/login"[^>]*>Sign in</);
  assert.match(publicTaken, /href="\/forgot-password"[^>]*>Forgot password</);
  assert.doesNotMatch(field({ context: "public", serverError: TRIGGER_ERROR }), /another student|This email is already in use/, "the public never sees the role or the signed-in wording");
  const other = field({ context: "public", serverError: { code: "23505", message: "A student with this mobile already exists" } });
  assert.doesNotMatch(other, /email-in-use/, "a different error is left to the form");
  assert.match(field({ context: "public" }), /data-email-status="idle"/, "public forms never run the live check");
  assert.match(field({ context: "admin", value: "new@example.test" }), /data-email-status="checking"/, "a signed-in form blocks until the check answers");
  assert.match(field({ context: "admin", savedEmail: "STU.X@example.test" }), /data-email-status="idle"/, "the saved email is not checked");
});

// ---- Staged application form: the steps grouped into stages by config (applicationStages.ts)
import { APPLICATION_STAGES, SECTION_SUMMARY, groupSections, sectionKey } from "../src/pages/agency/lib/applicationStages.ts";

// The portal form's 14 steps in form order, as portalSections builds them from the shared enrolment sections (checked below).
const PORTAL_STEP_TITLES = ["1. PERSONAL DETAILS & PASSPORT", "2. ADDRESS", "AUSTRALIAN VISA", "ENGLISH TEST", "4. STUDENT IDENTIFIER (AVETMISS)", "4a. ACADEMIC DOCUMENTS",
  "5. UNIQUE STUDENT IDENTIFIER (USI)", "6. EMERGENCY CONTACT", "7. COURSE INFORMATION", "8. STUDY REASON", "9. COURSE CREDIT", "10. OSHC / HEALTH INSURANCE",
  "11. HOW DID YOU HEAR ABOUT SLIT?", "13. STUDENT DECLARATION"];
const portalSteps = PORTAL_STEP_TITLES.map((title) => ({ title, fields: [] }));

test("stages: the 14 form steps are grouped into 4 stages by the config, each step exactly once", () => {
  const forms = readFileSync(new URL("../src/data/applicationForms.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/pages/agency/lib/portalSections.ts", import.meta.url), "utf8");
  for (const title of PORTAL_STEP_TITLES) assert.ok(forms.includes(`title: "${title}"`), `${title} is a step title`);
  const stages = groupSections(portalSteps);
  const keysOf = (ids: number[]) => ids.map((index) => sectionKey(portalSteps[index], index));
  assert.deepEqual(stages.map((stage) => stage.title), ["About you", "Visa & identity", "Education & course", "Finish"]);
  assert.deepEqual(stages.map((stage) => keysOf(stage.sections)), APPLICATION_STAGES.map((stage) => [...stage.sections]));
  assert.deepEqual(stages.flatMap((stage) => stage.sections).sort((a, b) => a - b), portalSteps.map((_, index) => index), "every step is on one stage, none twice");
  for (const key of Object.keys(SECTION_SUMMARY)) assert.ok(portalSteps.some((section, index) => sectionKey(section, index) === key), `summary key ${key} names a step`);
});

test("stages: a step the config does not name joins the stage of the step before it", () => {
  const extra = [...portalSteps.slice(0, 3), { title: "NEW CHECKS", fields: [] }, ...portalSteps.slice(3)];
  const stages = groupSections(extra);
  const holder = stages.find((stage) => stage.sections.includes(3));
  assert.ok(holder?.sections.includes(2), "placed next to the step before it");
  assert.equal(stages.flatMap((stage) => stage.sections).length, extra.length);
});
