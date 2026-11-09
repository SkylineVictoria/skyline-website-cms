import { expect, test } from "@playwright/test";
import { E2E_ANON_KEY, E2E_API_URL } from "./env";
import { anonClient, createAdmin, createStudentLogin, onboard, resetRateLimits, signedInClient, sql, staffAt } from "./support";

// Who can do what, against the LOCAL lab stack only: links are the only credential for applicants, hr_* is never reachable from the
// browser, staff-admin is for administrators, and the bucket is private.
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });

test("a link only opens its own person: another person's document is refused, a guessed link gets the neutral 403", async () => {
  const admin = await signedInClient((await createAdmin("sec-admin")).email);
  const one = await staffAt(admin, "secone", "documents_submitted");
  const two = await staffAt(admin, "sectwo", "documents_submitted");
  const theirs = sql(`select id from hr.staff_documents where profile_id = '${two.id}' and is_current limit 1`);
  // A submitted link is read-only but still opens; it cannot reach the other person's file.
  const foreign = await onboard({ action: "view_url", t: one.token, id: theirs });
  expect(foreign.status).toBe(400);
  expect(foreign.body.url).toBeUndefined();
  const guess = await onboard({ action: "open", t: "g".repeat(43) });
  expect([guess.status, guess.body.code]).toEqual([403, "link_invalid"]);
});

test("hr functions are not reachable from the browser: anon and signed-in users get nothing", async () => {
  const student = await createStudentLogin("sec-student");
  const asStudent = await signedInClient(student.email);
  for (const [client, who] of [[anonClient(), "anon"], [asStudent, "student"]] as const) {
    const svc = await client.rpc("hr_svc_onboarding_open", { p_token_hash: "a".repeat(64) });
    expect(svc.error, `${who} cannot call hr_svc_*`).not.toBeNull();
    const list = await client.rpc("hr_admin_staff_list", { p_status: null, p_search: null, p_limit: 5, p_offset: 0, p_statuses: null });
    expect(list.error, `${who} cannot list staff`).not.toBeNull();
    const candidates = await client.rpc("hr_admin_candidates", { p_job: null, p_state: null, p_search: "", p_limit: 5, p_offset: 0 });
    expect(candidates.error, `${who} cannot list candidates`).not.toBeNull();
    const file = await client.storage.from("staff-documents").list();
    expect(file.data ?? []).toHaveLength(0);
  }
});

test("staff-admin answers only administrators; the retention purge only the scheduled job", async () => {
  const student = await createStudentLogin("sec-fn");
  const asStudent = await signedInClient(student.email);
  const someone = sql("select id from hr.staff_profiles order by created_at desc limit 1");
  const { error } = await asStudent.functions.invoke("staff-admin", { body: { action: "send_invite", profileId: someone, purpose: "documents" } });
  expect(error).not.toBeNull();
  const hire = await asStudent.functions.invoke("staff-admin", { body: { action: "hire", applicationId: "00000000-0000-4000-8000-000000000000" } });
  expect(hire.error, "a student cannot hire").not.toBeNull();
  const anonCall = await fetch(`${E2E_API_URL}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: E2E_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ action: "purge" }) });
  expect(anonCall.status).toBe(401);
  const admin = await signedInClient((await createAdmin("sec-purge")).email);
  const asAdmin = await admin.functions.invoke("staff-admin", { body: { action: "purge" } });
  expect(asAdmin.error).not.toBeNull();
});
