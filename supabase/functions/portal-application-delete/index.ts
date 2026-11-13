import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { deleteDrafts, DeleteStepError, type DeletePort } from "../_shared/draft-delete.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

// Rules (draft only, caller can edit, no student submission) are enforced by the database functions under the caller's own token.
// This function only adds what the browser cannot do: removing private storage objects with the service role, in the right order.
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  const configuration = backendConfiguration(url, serviceKey, anonKey);
  if (configuration) return reply(configuration, 503);
  if (request.method !== "POST") return reply({ ok: false, error: "Method not allowed." }, 405);
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ ok: false, error: "Authentication required." }, 401);
  const body = await request.json().catch(() => ({}));
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}`, ...(request.headers.has("x-tenant-domain") ? { "x-tenant-domain": request.headers.get("x-tenant-domain")! } : {}) } }, auth: { persistSession: false } });
  const { data: user } = await caller.auth.getUser(token);
  if (!user?.user) return reply({ ok: false, error: "Authentication required." }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // A rule message from the database (errcode 55000) is safe to show; anything else becomes a generic message.
  const step = (error: { code?: string; message?: string }) => new DeleteStepError(error.code === "55000" || error.code === "PT409" ? String(error.message) : "This draft can't be deleted.");
  const port: DeletePort = {
    prepare: async (id) => {
      const { data, error } = await caller.rpc("portal_delete_draft_prepare", { p_application: id });
      if (error || !data) throw step(error ?? {});
      return data;
    },
    removeObjects: async (bucket, paths) => {
      // An object that is already gone is the intended outcome of a retry.
      const failedWith = (error: { message: string } | null) => Boolean(error) && !/not found|does not exist|unknown key/i.test(error!.message);
      if (!failedWith((await admin.storage.from(bucket).remove(paths)).error)) return { ok: true };
      // The batch failed: remove one by one so the answer can say which files are left.
      const failed: string[] = [];
      for (const path of paths) if (failedWith((await admin.storage.from(bucket).remove([path])).error)) failed.push(path);
      return failed.length ? { ok: false, failed } : { ok: true };
    },
    finalize: async (id, expected) => {
      const { data, error } = await caller.rpc("portal_delete_draft_application", { p_application: id, p_expected_documents: expected });
      if (error || !data) throw step(error ?? {});
      return data;
    },
  };
  const outcomes = await deleteDrafts(port, body.applicationIds);
  if (!Array.isArray(outcomes)) return reply({ ok: false, error: outcomes.error }, 400);
  for (const outcome of outcomes) if (!outcome.ok) console.error(JSON.stringify({ event: "draft_delete_failed" }));
  return reply({ ok: true, results: outcomes });
});
