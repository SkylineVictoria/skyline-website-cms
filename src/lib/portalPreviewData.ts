import { createClient } from "@supabase/supabase-js";
import { PREVIEW_READ_ONLY, type PreviewView } from "./portalPreview";

const id = "00000000-0000-4000-8000-000000000001";
const today = () => new Date().toISOString().slice(0, 10);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Offline adapter for the REAL portal components. No request is forwarded, including
 * unknown reads, writes, RPCs, storage, functions or authentication operations.
 * There is no real user's token or data in this client. */
export async function previewFetch(view: PreviewView, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  let args: Record<string, unknown> = {};
  if (request.method === "POST") { try { args = await request.json(); } catch { /* rejected below */ } }
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
  const action = String(args.p_action ?? "");
  const emptyReads = new Set(["portal_application_statuses", "portal_course_options", "portal_student_agency_options", "asm_calendar", "hr_public_holidays", "booking_directory", "support_ticket_students"]);
  if (rpc && (request.method === "POST" || request.method === "GET")) {
    if (emptyReads.has(rpc)) return json([]);
    if (rpc === "portal_query_applications") return json({ total: 0, rows: [] });
    if (rpc === "portal_student_needs_mobile") return json(false);
    if (rpc === "support_ticket_list") return json({ total: 0, rows: [], isHandler: false });
    if (rpc === "support_unread_count") return json(0);
    if (rpc === "portal_status_catalog") return json({ application: [], business: [], agent: [], student: [] });
    if (rpc === "application_status_workflow") return json({ statuses: [{ value: "draft", label: "Draft", active: true, editable: false, sort: 0 }], actions: [], reasons: [], roles: [view] });
    if (rpc === "signing_mine" && action === "list") return json([]);
    if (rpc === "asm_student") {
      if (["my_assessments", "notifications"].includes(action)) return json([]);
      if (action === "progress") return json({ studentId: id, units: [] });
    }
    if (rpc === "asm_trainer") {
      if (action === "me") return json({ staffId: id, name: "Sample Staff", isTrainer: true, batches: [] });
      if (["pending_marking", "my_assignments", "my_students", "notifications"].includes(action)) return json([]);
    }
    if (rpc === "booking_me") return json({ identity: { name: `Sample ${view}`, email: `${view}@example.invalid`, kind: view }, origin: "", host: null, availability: [], timeOff: [], types: [], locations: [], bookings: [] });
    if (rpc === "hr_staff_me") return json({ profile: { id, first_name: "Sample", last_name: "Staff", email: "staff@example.invalid", status: "active" }, status: "active", role: "trainer", joiningDate: null, documents: [], employment: null, jobApplications: [], signedOffer: null });
    if (rpc === "hr_my_team") return json({ isAdmin: false, profileId: id, isManager: false, reports: [], schedules: [], pendingLeave: 0, pendingOptional: 0 });
    if (rpc === "hr_time_status") return json({ profileId: id, state: "none", since: null, nextKinds: [], openShift: null, today: today(), todayShifts: [], serverNow: new Date().toISOString(), timezone: "Australia/Melbourne" });
    if (rpc === "hr_my_timesheet") return json({ profileId: id, hasPaySetup: false, timezone: "Australia/Melbourne", periods: [], period: null, summary: null });
    if (rpc === "hr_leave_my") return json({ profileId: id, dailyHours: 7.6, types: [], balances: [], requests: [], canApprove: false });
    if (rpc === "hr_optional_holidays_my") return json({ profileId: id, year: new Date().getFullYear(), allowance: 0, isPaid: false, used: 0, remaining: 0, today: today(), holidays: [], requests: [] });
  }
  // Only explicitly reviewed list tables. Never turn arbitrary operations into successes.
  if (request.method === "GET" && url.pathname === "/rest/v1/notification_sms_contacts") return json(null);
  const table = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1];
  if (request.method === "GET" && table && ["portal_notifications", "notification_preferences", "portal_email_preferences", "enrollment_applications", "enrollment_application_documents"].includes(table)) return json([]);
  return json({ message: PREVIEW_READ_ONLY, code: "PREVIEW_READ_ONLY", error: PREVIEW_READ_ONLY }, 403);
}

export function createPreviewClient(view: PreviewView) {
  const client = createClient("https://preview.invalid", "preview-offline-key", {
    global: { fetch: (input, init) => previewFetch(view, input, init) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "offline-portal-preview" },
  });
  // Only the offline client's presentation identity is synthetic. The real client,
  // its session storage and the administrator's identity are never modified.
  const user = { id, email: `${view}@example.invalid`, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01T00:00:00Z" };
  client.auth.getUser = async () => ({ data: { user }, error: null });
  client.auth.signOut = async () => ({ error: new Error(PREVIEW_READ_ONLY) as never });
  return client;
}
