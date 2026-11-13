// BOOK-01: the in-house booking module (migration 20261113125512_bookings). Every call is a database function; the public
// ones (host page, free slots, create, manage by emailed token) work signed out.
import { supabase } from "@/pages/admin/lib/supabase";

export type LocationKind = "phone" | "video" | "in_person" | "teams";
export interface BookingIdentity { name: string; email: string; kind: "staff" | "agent" | "student" | "other" }
export interface AvailabilityRow { weekday: number; start: string; end: string }
export interface TimeOffRow { start: string; end: string; note: string }
export interface MeetingType {
  id?: string; slug?: string; name: string; description: string; duration: number; locationKind: LocationKind; locationDetail: string; locationId: string | null;
  buffer: number; minNoticeHours: number; maxDaysAhead: number; requiresLogin: boolean; active: boolean;
}
export interface BookingRow {
  id: string; status: "confirmed" | "cancelled"; startsAt: string; endsAt: string; typeName: string; location: string; note: string; bookerName: string;
  bookerEmail: string | null; bookerPhone: string | null; hostName: string; hostHandle: string; hostTimezone: string; typeSlug: string;
  cancelledBy: "host" | "booker" | null; cancelReason: string | null; side: "host" | "booker"; token?: string;
}
export interface BookingMe {
  identity: BookingIdentity; origin: string;
  host: { handle: string; displayName: string; headline: string; timezone: string; enabled: boolean; listed: boolean } | null;
  availability: AvailabilityRow[]; timeOff: TimeOffRow[]; types: MeetingType[]; locations: Array<{ id: string; name: string; address: string }>; bookings: BookingRow[];
}
export interface PublicHost {
  handle: string; name: string; headline: string; timezone: string; kind: string; isSelf: boolean; signedIn: boolean; viewer: BookingIdentity | null;
  types: Array<{ slug: string; name: string; description: string; duration: number; location: string; requiresLogin: boolean }>;
}
export interface DirectoryHost { handle: string; name: string; kind: string; headline: string }

async function call<T>(fn: string, params: Record<string, unknown> = {}, fallback = "Something went wrong. Please try again."): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(error.message && !/^(JWT|PGRST|permission denied)/i.test(error.message) ? error.message : fallback);
  return data as T;
}

export const bookingMe = () => call<BookingMe>("booking_me");
export const saveBookingHost = (p: Record<string, unknown>) => call<BookingMe>("booking_host_save", { p });
export const saveMeetingType = (p: MeetingType) => call<BookingMe>("booking_type_save", { p });
export const deleteMeetingType = (id: string) => call<BookingMe>("booking_type_delete", { p_id: id });
export const bookingDirectory = (search: string) => call<DirectoryHost[]>("booking_directory", { p_search: search });
export const publicHost = (handle: string) => call<PublicHost | null>("booking_public_host", { p_handle: handle });
export const freeSlots = (handle: string, type: string, token?: string) =>
  call<string[]>("booking_slots", { p_handle: handle, p_type: type, p_from: new Date().toISOString().slice(0, 10), p_days: 62, p_token: token ?? null });
export const createBooking = (handle: string, type: string, start: string, who: { name: string; email: string; phone: string; note: string }) =>
  call<BookingRow>("booking_create", { p_handle: handle, p_type: type, p_start: start, p_name: who.name, p_email: who.email, p_phone: who.phone, p_note: who.note, p_timezone: viewerTimezone() });
export const manageBooking = (token: string) => call<BookingRow>("booking_manage", { p_token: token }, "This booking link is not valid.");
export const cancelBooking = (by: { token?: string; id?: string }, reason: string) => call<BookingRow>("booking_cancel", { p_token: by.token ?? null, p_id: by.id ?? null, p_reason: reason });
export const rescheduleBooking = (by: { token?: string; id?: string }, start: string) => call<BookingRow>("booking_reschedule", { p_start: start, p_token: by.token ?? null, p_id: by.id ?? null });

export function viewerTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Melbourne"; } catch { return "Australia/Melbourne"; }
}
export function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try { const all = intl.supportedValuesOf?.("timeZone"); if (all?.length) return all; } catch { /* older browser */ }
  return ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Manila", "Europe/London", "America/New_York", "UTC"];
}
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** A link name from a person's name: lowercase letters, numbers and hyphens, 3 to 40 characters. */
export function suggestHandle(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base.length >= 3 ? base : `${base || "me"}-book`;
}

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
/** A calendar file for one booking (opens in Outlook, Apple Calendar, Google Calendar). */
export function bookingIcs(b: BookingRow): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Skyline//Bookings//EN", "BEGIN:VEVENT", `UID:${b.id}@skyline-bookings`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(b.startsAt)}`, `DTEND:${stamp(b.endsAt)}`, `SUMMARY:${icsText(`${b.typeName} with ${b.side === "host" ? b.bookerName : b.hostName}`)}`,
    `LOCATION:${icsText(b.location)}`, ...(b.note ? [`DESCRIPTION:${icsText(b.note)}`] : []), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
export function downloadIcs(b: BookingRow) {
  const url = URL.createObjectURL(new Blob([bookingIcs(b)], { type: "text/calendar" }));
  const a = document.createElement("a"); a.href = url; a.download = "booking.ics"; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
