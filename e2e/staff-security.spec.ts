import { expect, test } from "@playwright/test";
import { PDF, addStaffDocument, anonClient, createAdmin, createStudentLogin, inDays, signedInClient, sql, submittedApplicant } from "./support";

// Row-level security and permission checks for staff data, through the same API the browser uses (LOCAL stack only).
test("an applicant cannot read other staff, their documents or the hr tables, and cannot review, approve or activate", async () => {
  const a = await submittedApplicant("Alpha", "trainer");
  const b = await submittedApplicant("Bravo", "admin");

  // The hr schema is not exposed through the Data API at all.
  const direct = await a.client.schema("hr" as never).from("staff_profiles").select("*");
  expect(direct.error).not.toBeNull();

  // The applicant's own view holds only their own application.
  const { data: mine } = await a.client.rpc("hr_staff_me");
  expect(mine.profile.email).toBe(a.email);
  expect(JSON.stringify(mine)).not.toContain(b.email);

  // Another applicant's file cannot be downloaded, a signed link cannot be made for it, and it cannot be overwritten or deleted.
  expect((await a.client.storage.from("staff-documents").download(b.path)).error).not.toBeNull();
  expect((await a.client.storage.from("staff-documents").createSignedUrl(b.path, 60)).error).not.toBeNull();
  expect((await a.client.storage.from("staff-documents").remove([b.path])).data ?? []).toHaveLength(0);
  expect((await a.client.storage.from("staff-documents").upload(`${b.id}/visa/evil.pdf`, PDF, { contentType: "application/pdf" })).error).not.toBeNull();
  // Their own file is readable while it stays private (no public URL works).
  expect((await a.client.storage.from("staff-documents").download(a.path)).error).toBeNull();
  const anon = await fetch(`${process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:56321"}/storage/v1/object/public/staff-documents/${a.path}`);
  expect(anon.status).toBeGreaterThanOrEqual(400);

  // After submitting, nothing can be added or replaced unless an administrator rejected it.
  expect((await a.client.storage.from("staff-documents").upload(`${a.id}/visa/again.pdf`, PDF, { contentType: "application/pdf" })).error).not.toBeNull();
  await expect(addStaffDocument(a.client, a.id, "Visa", inDays(300))).rejects.toThrow();

  // Not an admin: no list, no detail, no document review, no approve, no role, no activate, no reopen.
  const denied = async (fn: string, args: Record<string, unknown>) => { const { error } = await a.client.rpc(fn, args); expect(error?.code, fn).toBe("42501"); };
  await denied("hr_admin_staff_list", { p_status: null, p_search: null, p_limit: 10, p_offset: 0 });
  await denied("hr_admin_staff_detail", { p_id: b.profileId });
  await denied("hr_admin_staff_document_review", { p_doc: a.docs.passport.id, p_decision: "approved", p_note: null });
  await denied("hr_admin_staff_document_review", { p_doc: b.docs.passport.id, p_decision: "rejected", p_note: "no" });
  await denied("hr_admin_staff_activate_account", { p_id: a.profileId, p_role: "admin", p_note: null, p_confirm_admin: true });
  await denied("hr_admin_staff_approve", { p_id: a.profileId, p_role: "admin", p_note: "me", p_confirm_admin: true });
  await denied("hr_admin_staff_approve", { p_id: b.profileId, p_role: "trainer", p_note: null, p_confirm_admin: false });
  await denied("hr_admin_staff_reject", { p_id: b.profileId, p_note: "no" });
  await denied("hr_admin_staff_activate", { p_id: a.profileId, p_note: null });
  await denied("hr_staff_reopen", { p_id: a.profileId, p_note: "let me in" });

  // The service-only helpers are not callable from the browser.
  for (const fn of ["hr_staff_precheck", "hr_staff_document_apply_extraction"]) {
    const { error } = await a.client.rpc(fn, { p_email: "x@example.test", p_phone: "+61400000000", p_doc: a.profileId, p_status: "done", p_extracted: {} });
    expect(error, fn).not.toBeNull();
  }

  // A submitted application cannot be edited, and nobody signed out can read anything.
  expect((await a.client.rpc("hr_staff_save", { p_patch: { first_name: "Changed" } })).error?.message).toContain("can no longer be edited");
  expect((await a.client.rpc("hr_staff_set_citizenship", { p_citizen: true })).error?.message).toContain("can no longer be edited");
  expect((await anonClient().rpc("hr_staff_me")).error).not.toBeNull();
});

test("an agency or student user cannot see or decide staff applications", async () => {
  const student = await createStudentLogin("sec-student");
  const applicant = await submittedApplicant("Charlie", "trainer");
  const client = await signedInClient(student.email);
  for (const [fn, args] of [
    ["hr_admin_staff_list", { p_status: null, p_search: null, p_limit: 10, p_offset: 0 }],
    ["hr_admin_staff_document_review", { p_doc: applicant.docs.visa.id, p_decision: "approved", p_note: null }],
    ["hr_admin_staff_activate_account", { p_id: applicant.profileId, p_role: "trainer", p_note: null, p_confirm_admin: false }],
    ["hr_admin_staff_reject", { p_id: applicant.profileId, p_note: "no" }],
  ] as const) expect((await client.rpc(fn, args)).error?.code, fn).toBe("42501");
  expect((await client.storage.from("staff-documents").download(applicant.path)).error).not.toBeNull();
  expect((await client.rpc("hr_staff_me")).data).toBeNull();
});

test("only an administrator can read staff documents; activation needs approved documents and the Admin confirm", async () => {
  const admin = await createAdmin("sec-admin");
  const applicant = await submittedApplicant("Delta", "trainer");
  const adminClient = await signedInClient(admin.email);
  expect((await adminClient.storage.from("staff-documents").download(applicant.path)).error).toBeNull();
  expect((await adminClient.storage.from("staff-documents").createSignedUrl(applicant.path, 60)).data?.signedUrl).toBeTruthy();
  const { data: list } = await adminClient.rpc("hr_admin_staff_list", { p_status: "submitted", p_search: applicant.email, p_limit: 10, p_offset: 0 });
  expect(list.rows.map((r: { email: string }) => r.email)).toContain(applicant.email);
  // Activation is refused while documents are pending, and the Admin role needs the explicit confirm on the server as well.
  expect((await adminClient.rpc("hr_admin_staff_activate_account", { p_id: applicant.profileId, p_role: "trainer", p_note: null, p_confirm_admin: false })).error?.message).toContain("Approve every required document first");
  expect((await adminClient.rpc("hr_admin_staff_activate_account", { p_id: applicant.profileId, p_role: "admin", p_note: null, p_confirm_admin: false })).error?.message).toContain("Confirm");
  // A rejection needs a note; an invalid status filter is refused.
  expect((await adminClient.rpc("hr_admin_staff_document_review", { p_doc: applicant.docs.visa.id, p_decision: "rejected", p_note: " " })).error?.message).toContain("note");
  expect((await adminClient.rpc("hr_admin_staff_list", { p_status: "bogus", p_search: null, p_limit: 10, p_offset: 0 })).error).not.toBeNull();
});

test("a signed-in staff user cannot write hr tables directly: approving their own document through the API fails", async () => {
  const a = await submittedApplicant("Echo", "trainer");
  const docId = a.docs.passport.id;
  // The hr schema is not served by the Data API, so neither the update nor an insert reaches the table.
  const hrDocs = a.client.schema("hr" as never).from("staff_documents");
  const update = await hrDocs.update({ status: "approved", review_note: "", reviewed_by: a.id, reviewed_at: new Date().toISOString() }).eq("id", docId).select();
  expect(update.error).not.toBeNull();
  const insert = await hrDocs.insert({ category: "Visa", status: "approved", storage_path: `${a.id}/visa/forged.pdf` });
  expect(insert.error).not.toBeNull();
  const profile = await a.client.schema("hr" as never).from("staff_profiles").update({ status: "active" }).eq("auth_user_id", a.id);
  expect(profile.error).not.toBeNull();
  // Nothing of that name exists in the exposed public schema either.
  expect((await a.client.from("staff_documents").update({ status: "approved" }).eq("id", docId)).error).not.toBeNull();
  // The document is still pending review and the profile is still submitted.
  expect(sql(`select status || '/' || coalesce(reviewed_by::text, 'none') from hr.staff_documents where id = '${docId}'`)).toBe("pending/none");
  expect(sql(`select status from hr.staff_profiles where id = '${a.profileId}'`)).toBe("submitted");
});
