import assert from "node:assert/strict";
import test from "node:test";
import { canManagePortalUsers, isEditableApplicationStatus, portalAccessMessage, portalLanding } from "../src/pages/agency/lib/applicationAccess.ts";
import { availableActions, csvCell, EXPORT_COLUMNS, exportCsv, EXCEPTION_TEXT, normaliseCoeNumber, registrationChecklist, registrationWarning, validateCorrection, verifyBlockers } from "../src/pages/agency/lib/registrationWorkbench.ts";

test("only database-editable portal statuses enable draft UI", () => {
  assert.equal(isEditableApplicationStatus("draft"), true);
  assert.equal(isEditableApplicationStatus("action_required"), true);
  assert.equal(isEditableApplicationStatus("submitted"), false);
  assert.equal(isEditableApplicationStatus("under_review"), false);
  assert.equal(isEditableApplicationStatus("enrolled"), false);
});

test("completion and submission-date lookalikes never affect editability", () => {
  // The helper deliberately receives status only: 0%, 3%, an absent date, and
  // document extraction state are presentation data, not authorisation input.
  assert.equal(isEditableApplicationStatus("draft"), true);
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
  assert.equal(portalLanding("agency_admin"), "/agency/dashboard");
  assert.equal(portalLanding("agent"), "/agency/applications");
});

test("sign-in: only organization and agency admins are shown user management", () => {
  assert.equal(canManagePortalUsers("slit_admin"), true);
  assert.equal(canManagePortalUsers("agency_admin"), true);
  assert.equal(canManagePortalUsers("agent"), false);
  assert.equal(canManagePortalUsers(null), false);
});

test("sign-in: suspended, expired and unassigned accounts each get a distinct clear message", () => {
  const messages = ["agency_suspended", "user_suspended", "invite_expired", "no_access"].map(portalAccessMessage);
  assert.equal(new Set(messages).size, 4);
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

test("login: each kind of access lands in the right place and multiple kinds ask first", () => {
  const cms = { active: true, mustChangePassword: false };
  assert.deepEqual(decideLogin({ cms, portal: "no_access" }), { kind: "go", to: "/admin" });
  assert.deepEqual(decideLogin({ cms: null, portal: "active" }), { kind: "go", to: "/agency" });
  assert.deepEqual(decideLogin({ cms, portal: "org_admin" }), { kind: "choose", options: ["cms", "portal"] });
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

test("header: signed-in visitors see Dashboard instead of Sign In, and the Agency Portal button is gone", () => {
  assert.deepEqual(headerAccountLink(false), { label: "Sign In", to: "/login" });
  assert.deepEqual(headerAccountLink(true), { label: "Dashboard", to: "/login" });
  const header = readFileSync(new URL("../src/components/feature/SiteHeader.tsx", import.meta.url), "utf8");
  for (const gone of ["Agency Portal", "/agency/login", "/admin/login"]) assert.ok(!header.includes(gone), gone);
  assert.ok(header.includes("Enroll Now"));
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

// ---- P08-04: status model, labels and agent read-only after submission ----
import { LEGACY_STATUSES, SELECTABLE_STATUSES, STATUS_LABELS, canSubmitApplicationStatus, nextStatusOptions } from "../src/pages/agency/lib/applicationAccess.ts";

test("status model: stored values are unchanged and only coe_issued is relabelled", () => {
  assert.equal(STATUS_LABELS.coe_issued, "CoE / VoE issued");
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), ["action_required", "coe_issued", "draft", "enrolled", "offer_accepted", "offer_issued", "rejected", "submitted", "under_review", "withdrawn"]);
  assert.equal(STATUS_LABELS.enrolled, "Enrolled");
});

test("status model: Under review and Offer issued are in no selectable list, but legacy labels stay readable", () => {
  for (const removed of LEGACY_STATUSES) {
    assert.ok(!(SELECTABLE_STATUSES as readonly string[]).includes(removed), removed);
    assert.ok(STATUS_LABELS[removed]);
    for (const status of Object.keys(STATUS_LABELS)) assert.ok(!nextStatusOptions(status).some((target) => target === removed), `${status} -> ${removed}`);
  }
  assert.deepEqual([...SELECTABLE_STATUSES], ["draft", "submitted", "action_required", "offer_accepted", "coe_issued", "enrolled", "rejected", "withdrawn"]);
});

test("status model: the UI options equal the default graph in migration 91; legacy rows only move forward", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261027050000_admissions_status_model_revision.sql", import.meta.url), "utf8");
  const workflow = /when 'workflow' then jsonb_build_object\([\s\S]*?\]'::jsonb\)/.exec(sql)?.[0] ?? "";
  const pairs = [...workflow.matchAll(/\{"from":"(\w+)","to":"(\w+)"\}/g)].map((m) => `${m[1]}>${m[2]}`).filter((p) => !p.startsWith("draft>"));
  const fromUi = Object.keys(STATUS_LABELS).flatMap((from) => ["under_review", "offer_issued"].includes(from) ? [] : nextStatusOptions(from).map((to) => `${from}>${to}`));
  assert.deepEqual([...pairs].sort(), [...fromUi].sort());
  assert.ok(workflow.includes('"draft","to":"submitted"'));
  assert.deepEqual([...nextStatusOptions("under_review")].sort(), ["action_required", "offer_accepted", "rejected", "withdrawn"]);
  assert.deepEqual([...nextStatusOptions("offer_issued")].sort(), ["offer_accepted", "rejected", "withdrawn"]);
  assert.deepEqual(nextStatusOptions("enrolled"), []);
  assert.deepEqual(nextStatusOptions("rejected"), []);
  assert.deepEqual(nextStatusOptions("draft"), [], "a draft is submitted, never moved by the status command");
});

test("status model: only a draft can be submitted by an agent or agency admin; the status control is read-only for them", () => {
  assert.equal(canSubmitApplicationStatus("draft"), true);
  for (const status of Object.keys(STATUS_LABELS).filter((s) => s !== "draft")) assert.equal(canSubmitApplicationStatus(status), false, status);
  const detail = readFileSync(new URL("../src/pages/agency/applications/detail/page.tsx", import.meta.url), "utf8");
  assert.ok(detail.includes("Read-only. Status changes are made by SLIT administration."));
  const workspace = readFileSync(new URL("../src/pages/agency/components/ApplicationWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(workspace.includes("canSubmit={canSubmitApplicationStatus(application.status)}"));
});

// ---- P08-05: admin-managed notification recipients (pure UI validation; the database re-validates) ----
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS, configWithEvent, eventErrorMessage, hasAnyRecipient, parseRecipients, validateEventForm } from "../src/lib/notificationEvents.ts";

test("recipients: addresses are split, trimmed, lower-cased and validated; duplicates and more than 10 are reported", () => {
  assert.deepEqual(parseRecipients("  Admissions@Example.EDU.au \n ops@example.test, it@example.test;qa@example.test").emails, ["admissions@example.edu.au", "ops@example.test", "it@example.test", "qa@example.test"]);
  assert.equal(parseRecipients("").error, null);
  assert.match(parseRecipients("not-an-email").error ?? "", /not a valid email/i);
  assert.match(parseRecipients("a@b.test, A@B.test").error ?? "", /listed twice/i);
  assert.match(parseRecipients(Array.from({ length: 11 }, (_, i) => `r${i}@example.test`).join("\n")).error ?? "", /at most 10/i);
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
