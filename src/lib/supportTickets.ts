import { supabase } from "@/pages/admin/lib/supabase";

/** TKT-01 support tickets. All reads and writes go through the support_* database functions. */
export type TicketCategory = "enrolment_documents" | "fees_payments" | "course_training" | "other";
export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketAttachment = { path: string; name: string; size: number; type: string };

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  enrolment_documents: "Enrolment & documents",
  fees_payments: "Fees & payments",
  course_training: "Course & training",
  other: "Other",
};
export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open", in_progress: "In progress", waiting: "Waiting on requester", resolved: "Resolved", closed: "Closed",
};
export const STATUS_CLASS: Record<TicketStatus, string> = {
  open: "bg-blue-100 text-blue-800", in_progress: "bg-amber-100 text-amber-800", waiting: "bg-purple-100 text-purple-800",
  resolved: "bg-green-100 text-green-800", closed: "bg-background-200 text-foreground-700",
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export type TicketRow = {
  id: string; ref: string; subject: string; category: TicketCategory; priority: TicketPriority; status: TicketStatus;
  requesterName: string; requesterRole: "student" | "agent" | "agency_admin"; requesterEmail: string | null;
  agencyName: string | null; studentId: string | null; studentName: string | null;
  assignedName: string | null; assignedToMe: boolean; createdAt: string; updatedAt: string; lastMessageAt: string; unread: boolean;
};
export type TicketMessage = {
  id: string; kind: "message" | "event"; authorName: string; fromStaff: boolean; internal: boolean; body: string;
  attachments: TicketAttachment[]; createdAt: string;
};
export type TicketDetail = { ticket: TicketRow; messages: TicketMessage[]; isHandler: boolean; isRequester: boolean; canReply: boolean };

async function rpc<T>(name: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || fallback);
  return data as T;
}

export const listTickets = (opts: { status?: string; search?: string; scope?: "all" | "mine" | "unassigned"; limit?: number; offset?: number } = {}) =>
  rpc<{ total: number; rows: TicketRow[]; isHandler: boolean }>("support_ticket_list",
    { p_status: opts.status ?? null, p_search: opts.search ?? null, p_scope: opts.scope ?? "all", p_limit: opts.limit ?? 50, p_offset: opts.offset ?? 0 },
    "We could not load the tickets.");
export const getTicket = (id: string) => rpc<TicketDetail>("support_ticket_detail", { p_ticket: id }, "We could not load this ticket.");
export const ticketUnreadCount = () => rpc<number>("support_unread_count", {}, "");
export const ticketStudents = () => rpc<{ id: string; name: string }[]>("support_ticket_students", {}, "We could not load your students.");

export const createTicket = (input: { category: TicketCategory; subject: string; body: string; priority: TicketPriority; attachments: TicketAttachment[]; studentId?: string | null }) =>
  rpc<{ id: string; ref: string }>("support_ticket_create", {
    p_category: input.category, p_subject: input.subject, p_body: input.body, p_priority: input.priority,
    p_attachments: input.attachments, p_student: input.studentId || null,
  }, "The ticket could not be created.");
export const replyTicket = (id: string, body: string, internal: boolean, attachments: TicketAttachment[]) =>
  rpc<{ ok: boolean }>("support_ticket_reply", { p_ticket: id, p_body: body, p_internal: internal, p_attachments: attachments }, "The reply could not be sent.");
export const updateTicket = (id: string, change: { status?: TicketStatus; priority?: TicketPriority; assign?: "me" | "none" }) =>
  rpc<TicketRow>("support_ticket_update", { p_ticket: id, p_status: change.status ?? null, p_priority: change.priority ?? null, p_assign: change.assign ?? null }, "The ticket could not be updated.");

const MAX_BYTES = 10 * 1024 * 1024;
/** Uploads to the private support-attachments bucket under the caller's own folder. */
export async function uploadTicketFiles(files: File[]): Promise<TicketAttachment[]> {
  if (files.length > 5) throw new Error("Attach at most 5 files.");
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Sign in again to attach files.");
  const out: TicketAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
    const path = `${auth.user.id}/${crypto.randomUUID()}/${safe}`;
    const { error } = await supabase.storage.from("support-attachments").upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error(`${file.name} could not be uploaded: ${error.message}`);
    out.push({ path, name: file.name.slice(0, 200), size: file.size, type: file.type });
  }
  return out;
}
export async function openTicketFile(path: string): Promise<void> {
  const { data, error } = await supabase.storage.from("support-attachments").createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw new Error("The file could not be opened.");
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

/** Administrators only: the requester's phone for the WhatsApp link (portal profile first, then the student record). Empty when unknown. */
export async function ticketRequesterPhone(ticket: Pick<TicketRow, "requesterEmail" | "studentId" | "requesterRole">): Promise<string> {
  if (ticket.requesterEmail) {
    const { data } = await supabase.from("portal_profiles").select("phone").eq("email", ticket.requesterEmail).limit(1).maybeSingle();
    const phone = String((data as { phone?: string | null } | null)?.phone ?? "").trim();
    if (phone) return phone;
  }
  if (ticket.requesterRole === "student" && ticket.studentId) {
    const { data } = await supabase.rpc("admin_student_detail", { p_student: ticket.studentId });
    return String((data as { phone?: string | null } | null)?.phone ?? "").trim();
  }
  return "";
}

/** CMS > Tickets > Notification emails: who gets an email about every ticket reply and status change (admins only). */
export type TicketNotifyRecipient = { id: string; email: string; label: string; createdAt: string };
export const listTicketNotify = () => rpc<TicketNotifyRecipient[]>("support_notify_list", {}, "We could not load the notification emails.");
export const addTicketNotify = (email: string, label: string) =>
  rpc<TicketNotifyRecipient>("support_notify_add", { p_email: email, p_label: label }, "We could not add this email.");
export const removeTicketNotify = (id: string) => rpc<void>("support_notify_remove", { p_id: id }, "We could not remove this email.");
