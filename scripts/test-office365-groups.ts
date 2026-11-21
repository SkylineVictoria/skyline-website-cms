import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-office365-groups"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

// Offline regression tests for addGroups() in supabase/functions/_shared/office365-provision.ts: only the exact "already a member"
// Graph reply may be skipped; every other failure (a 400 with a different message, a 403) is recorded on the groups step.
const load = createJiti(import.meta.url, { alias: { "@": path.resolve("src") } });
const prov = await load.import<typeof import("../supabase/functions/_shared/office365-provision.ts")>("../supabase/functions/_shared/office365-provision.ts");

const STAFF = "11111111-1111-4111-8111-111111111111";
const GROUPS = "aaaaaaaa-1111-4222-8333-444444444444,bbbbbbbb-2222-4333-8444-555555555555";
const NEW_USER = "aaaaaaaa-0000-4000-8000-0000000000aa";
const jsonReply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => new Response("{}", { status: 404 });

/** The smallest fake tenant provision() needs: a token, verified domains, faculty seats, an existing sender, no matching users. */
const world = (memberReplies: Array<() => Response>) => {
  const calls: string[] = []; const steps: string[] = [];
  let memberCall = 0;
  const request = (async (input: string | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input)), method = init?.method ?? "GET"; calls.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }));
    if (url.includes("/domains?")) return new Response(JSON.stringify({ value: [{ id: "slit.edu.au", isVerified: true }, { id: "student.slit.edu.au", isVerified: true }] }));
    if (url.includes("/members/$ref")) return memberReplies[Math.min(memberCall++, memberReplies.length - 1)]();
    if (url.includes("/subscribedSkus")) return new Response(JSON.stringify({ value: [{ skuId: "fac", skuPartNumber: "STANDARDWOFFPACK_FACULTY", prepaidUnits: { enabled: 45 }, consumedUnits: 25 }] }));
    if (url.includes("/groups?$filter=")) return new Response(JSON.stringify({ value: [] }));
    if (url.includes("/users?$filter=")) return new Response(JSON.stringify({ value: [] }));
    if (method === "GET" && /\/users\/[^/?]+\?\$select=id$/.test(url)) return new Response(JSON.stringify({ id: "sender" }));
    if (url.includes("/licenseDetails")) return new Response(JSON.stringify({ value: [] }));
    if (method === "POST" && url.endsWith("/users")) return new Response(JSON.stringify({ id: NEW_USER }));
    if (method === "POST" && url.includes("/assignLicense")) return new Response(JSON.stringify({}));
    if (url.includes("/sendMail")) return new Response(null, { status: 202 });
    if (method === "PATCH") return new Response(null, { status: 204 });
    if (method === "GET" && url.includes("/users/")) return notFound();
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name.endsWith("_prepare")) return { data: { fullName: "Asha Patel", recordEmail: "asha.personal@example.test", trainer: true, account: null }, error: null };
    if (name.endsWith("_claim")) return { data: { conflict: false, upn: args.p_upn, msUserId: null }, error: null };
    if (name.endsWith("_finish")) return { data: {}, error: null };
    if (name === "o365_step") { steps.push(`${args.p_step}:${args.p_ok}:${args.p_detail ?? ""}`); return { data: {}, error: null }; }
    throw new Error(name);
  };
  const ENV: Record<string, string> = { EF_MICROSOFT365_CLIENT_ID: "c", EF_MICROSOFT365_CLIENT_SECRET: "s", EF_MICROSOFT365_TENANT_ID: "t", EF_MICROSOFT365_STUDENT_DOMAIN: "student.slit.edu.au", EF_MICROSOFT365_WELCOME_SENDER: "noreply@slit.edu.au" };
  const ports = { env: (n: string) => (n === "EF_MICROSOFT365_GROUPS_STAFF" ? GROUPS : ENV[n] ?? ""), fetch: request, rpc } as unknown as import("../supabase/functions/_shared/office365-provision.ts").Ports;
  return { ports, calls, steps };
};
const ok = () => new Response(null, { status: 204 });
const already = () => jsonReply(400, { error: { code: "Request_BadRequest", message: "One or more added object references already exist for the specified modified properties." } });
const badId = () => jsonReply(400, { error: { code: "Request_BadRequest", message: "Invalid object identifier 'bbbbbbbb-2222-4333-8444-555555555555'." } });
const denied = () => jsonReply(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } });

test("groups: 'already a member' is skipped by its message; the step records both groups", async () => {
  const w = world([already, ok]);
  const r = await prov.provision(w.ports, "employee", STAFF);
  assert.equal(r.status, 200);
  assert.ok(w.steps.includes("groups:true:2"), `steps: ${w.steps}`);
  assert.ok(w.steps.includes("account:true:") && w.steps.includes("welcome:true:"), "provisioning still completes around the skipped group");
});

test("groups: a 400 with any other message is recorded, not swallowed", async () => {
  const w = world([already, badId]);
  const r = await prov.provision(w.ports, "employee", STAFF);
  assert.equal(r.status, 200, "a group failure never undoes the account");
  assert.ok(w.steps.some((s) => s.startsWith("groups:false:bbbbbbbb:400:Request_BadRequest")), `steps: ${w.steps}`);
  assert.ok(w.steps.includes("welcome:true:"), "the login email still goes out");
});

test("groups: a 403 is recorded with its code", async () => {
  const w = world([denied, ok]);
  const r = await prov.provision(w.ports, "employee", STAFF);
  assert.equal(r.status, 200);
  assert.ok(w.steps.some((s) => s.startsWith("groups:false:aaaaaaaa:403:Authorization_RequestDenied")), `steps: ${w.steps}`);
});
