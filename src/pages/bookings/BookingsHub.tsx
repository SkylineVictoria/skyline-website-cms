import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import {
  WEEKDAYS, bookingDirectory, bookingMe, cancelBooking, deleteMeetingType, downloadIcs, formatWhen, rescheduleBooking, saveBookingHost, saveMeetingType, suggestHandle, timezones, viewerTimezone,
  type AvailabilityRow, type BookingMe, type BookingRow, type DirectoryHost, type MeetingType, type TimeOffRow,
} from "@/lib/bookingApi";
import SlotPicker from "./SlotPicker";

type Tab = "bookings" | "types" | "availability" | "people";
const KIND_LABEL: Record<string, string> = { staff: "Staff", agent: "Agent", student: "Student", other: "" };
const NEW_TYPE: MeetingType = { name: "", description: "", duration: 30, locationKind: "phone", locationDetail: "", locationId: null, buffer: 0, minNoticeHours: 4, maxDaysAhead: 60, requiresLogin: false, active: true };
const DEFAULT_HOURS: AvailabilityRow[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));
const ALERT = "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800";
const NOTICE = "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800";

/**
 * Bookings (BOOK-01): the same screen for staff, agents and students. My bookings (as host and as the person who booked), my
 * meeting types, my weekly hours and time off, and the people who can be booked. Shown at /bookings and inside the CMS.
 */
export default function BookingsHub() {
  const [me, setMe] = useState<BookingMe | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("bookings");
  const load = useCallback(async () => { try { setMe(await bookingMe()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Bookings could not be loaded."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const done = (next: BookingMe, message: string) => { setMe(next); setNotice(message); setError(""); };
  const fail = (e: unknown) => { setNotice(""); setError(e instanceof Error ? e.message : "That did not work. Please try again."); };

  if (!me) return error ? <p role="alert" className={ALERT}>{error}</p> : <p role="status" className="text-sm text-foreground-600">Loading bookings…</p>;
  const canHost = me.identity.kind !== "other";
  const link = me.host ? `${me.origin}/book/${me.host.handle}` : "";
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "bookings", label: "My bookings" },
    ...(canHost ? [{ id: "types" as Tab, label: "Meeting types" }, { id: "availability" as Tab, label: "Availability" }] : []),
    { id: "people", label: "Book someone" },
  ];

  return (
    <div data-testid="bookings-hub">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground-950">Bookings</h1>
          <p className="text-sm text-foreground-600">Offer times people can book with you, and book time with others.</p>
        </div>
        {me.host ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a href={link} target="_blank" rel="noreferrer" className="font-medium text-primary-700 underline">{link.replace(/^https:\/\//, "")}</a>
            <Button size="sm" variant="outline" icon="ri-file-copy-line" onClick={() => void navigator.clipboard.writeText(link).then(() => setNotice("Your booking link was copied."), () => setNotice(link))}>Copy link</Button>
          </div>
        ) : null}
      </div>
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`}>{notice}</p> : null}
      {canHost && !me.host ? <SetupCard me={me} onDone={(next) => done(next, "Your booking page is ready. Add a meeting type so people can book.")} onError={fail} /> : null}
      {me.host && !me.host.enabled ? <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Your booking page is switched off: nobody can book you until you switch it on under Availability.</p> : null}
      {me.host && me.host.enabled && (me.types.filter((t) => t.active).length === 0 || me.availability.length === 0) ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Nobody can book you yet: add {me.types.filter((t) => t.active).length === 0 ? "a meeting type" : "your available hours"}.</p>
      ) : null}

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-background-200" aria-label="Booking sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => { setTab(t.id); setNotice(""); }}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>{t.label}</button>
        ))}
      </nav>
      {tab === "bookings" ? <BookingsTab me={me} onChanged={(message) => { setNotice(message); void load(); }} onError={fail} /> : null}
      {tab === "types" ? (me.host ? <TypesTab me={me} onDone={done} onError={fail} /> : <p className="text-sm text-foreground-600">Set up your booking page first.</p>) : null}
      {tab === "availability" ? (me.host ? <AvailabilityTab me={me} onDone={done} onError={fail} /> : <p className="text-sm text-foreground-600">Set up your booking page first.</p>) : null}
      {tab === "people" ? <PeopleTab /> : null}
    </div>
  );
}

function SetupCard({ me, onDone, onError }: { me: BookingMe; onDone: (next: BookingMe) => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState(me.identity.name);
  const [handle, setHandle] = useState(suggestHandle(me.identity.name));
  const [timezone, setTimezone] = useState(viewerTimezone());
  const [listed, setListed] = useState(me.identity.kind === "staff");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { onDone(await saveBookingHost({ handle, displayName: name, timezone, listed, enabled: true, availability: DEFAULT_HOURS })); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Card className="mb-5 p-5">
      <h2 className="font-heading text-base font-bold text-foreground-950">Set up your booking page</h2>
      <p className="mt-1 text-sm text-foreground-600">You get a link to share. It starts with Monday to Friday, 9 am to 5 pm; change that under Availability.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Name people see" required><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Link name" required hint={`${me.origin.replace(/^https:\/\//, "")}/book/${handle || "…"}`}><TextInput value={handle} maxLength={40} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} /></Field>
        <Field label="Your time zone" required><Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>{timezones().map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select></Field>
        <label className="flex items-start gap-2 self-end text-sm"><input type="checkbox" className="mt-0.5" checked={listed} onChange={(e) => setListed(e.target.checked)} /> <span>List me under “Book someone” for signed-in staff, agents and students. Without this, only people with your link can book.</span></label>
      </div>
      <div className="mt-4"><Button disabled={busy || name.trim().length < 2 || handle.length < 3} onClick={() => void save()}>{busy ? "Saving…" : "Create my booking page"}</Button></div>
    </Card>
  );
}

function BookingsTab({ me, onChanged, onError }: { me: BookingMe; onChanged: (message: string) => void; onError: (e: unknown) => void }) {
  const [cancelling, setCancelling] = useState<BookingRow | null>(null);
  const [moving, setMoving] = useState<BookingRow | null>(null);
  const [reason, setReason] = useState("");
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const upcoming = me.bookings.filter((b) => b.status === "confirmed" && new Date(b.endsAt).getTime() >= now);
  const earlier = me.bookings.filter((b) => !upcoming.includes(b)).reverse();
  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await work(); setCancelling(null); setMoving(null); setReason(""); setSlot(""); onChanged(message); } catch (e) { onError(e); setCancelling(null); setMoving(null); } finally { setBusy(false); }
  };
  const row = (b: BookingRow, actions: boolean) => (
    <li key={`${b.id}:${b.side}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-semibold text-foreground-950">{formatWhen(b.startsAt)}</p>
        <p className="text-sm text-foreground-800">{b.typeName} · {b.side === "host" ? <>with <b>{b.bookerName}</b>{b.bookerEmail ? <> (<a className="text-primary-700 underline" href={`mailto:${b.bookerEmail}`}>{b.bookerEmail}</a>{b.bookerPhone ? `, ${b.bookerPhone}` : ""})</> : null}</> : <>with <b>{b.hostName}</b></>}</p>
        <p className="text-xs text-foreground-600">{b.location}{b.note ? ` · “${b.note}”` : ""}</p>
        {b.status === "cancelled" ? <p className="text-xs text-foreground-600">Cancelled{b.cancelledBy ? ` by ${b.cancelledBy === b.side ? "you" : b.side === "host" ? b.bookerName : b.hostName}` : ""}{b.cancelReason ? `: ${b.cancelReason}` : ""}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={b.side === "host" ? "primary" : "secondary"}>{b.side === "host" ? "Booked with you" : "You booked"}</Badge>
        {b.status === "cancelled" ? <Badge tone="muted">Cancelled</Badge> : null}
        {actions ? <>
          <Button size="sm" variant="ghost" icon="ri-calendar-line" onClick={() => downloadIcs(b)}>Calendar</Button>
          <Button size="sm" variant="outline" onClick={() => { setSlot(""); setMoving(b); }}>Change time</Button>
          <Button size="sm" variant="ghost" onClick={() => { setReason(""); setCancelling(b); }}>Cancel</Button>
        </> : null}
      </div>
    </li>
  );
  return (
    <div className="space-y-5">
      <Card>
        <h2 className="border-b border-background-200 px-4 py-3 font-heading text-base font-bold text-foreground-950">Upcoming</h2>
        {upcoming.length ? <ul className="divide-y divide-background-200">{upcoming.map((b) => row(b, true))}</ul> : <p className="p-4 text-sm text-foreground-600">Nothing booked yet.</p>}
      </Card>
      {earlier.length ? (
        <Card>
          <h2 className="border-b border-background-200 px-4 py-3 font-heading text-base font-bold text-foreground-950">Past and cancelled (last 30 days)</h2>
          <ul className="divide-y divide-background-200">{earlier.map((b) => row(b, false))}</ul>
        </Card>
      ) : null}
      <Modal open={Boolean(cancelling)} title="Cancel this booking?" onClose={() => { if (!busy) setCancelling(null); }}
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setCancelling(null)}>Keep booking</Button><Button variant="danger" disabled={busy} onClick={() => cancelling && void run(() => cancelBooking({ id: cancelling.id }, reason), "The booking was cancelled and the other person was emailed.")}>{busy ? "Cancelling…" : "Cancel booking"}</Button></>}>
        {cancelling ? <div className="space-y-3"><p className="text-sm text-foreground-800">{cancelling.typeName}, {formatWhen(cancelling.startsAt)}. The other person is emailed.</p>
          <Field label="Reason (optional, included in the email)"><TextArea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div> : null}
      </Modal>
      <Modal open={Boolean(moving)} title="Choose a new time" onClose={() => { if (!busy) setMoving(null); }}
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setMoving(null)}>Keep current time</Button><Button disabled={busy || !slot} onClick={() => moving && void run(() => rescheduleBooking({ id: moving.id }, slot), "The booking has a new time and the other person was emailed.")}>{busy ? "Saving…" : slot ? `Move to ${formatWhen(slot)}` : "Choose a time"}</Button></>}>
        {moving ? <SlotPicker handle={moving.hostHandle} type={moving.typeSlug} selected={slot} onPick={setSlot} /> : null}
      </Modal>
    </div>
  );
}

function TypesTab({ me, onDone, onError }: { me: BookingMe; onDone: (next: BookingMe, message: string) => void; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState<MeetingType | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${me.origin}/book/${me.host!.handle}`;
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try { onDone(await saveMeetingType(editing), "The meeting type was saved."); setEditing(null); } catch (e) { onError(e); setEditing(null); } finally { setBusy(false); }
  };
  const remove = async (t: MeetingType) => {
    if (!t.id || !window.confirm(`Remove “${t.name}”? If it has bookings it is switched off instead, and those bookings stay.`)) return;
    try { onDone(await deleteMeetingType(t.id), "The meeting type was removed."); } catch (e) { onError(e); }
  };
  const set = (patch: Partial<MeetingType>) => setEditing((t) => (t ? { ...t, ...patch } : t));
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
        <p className="text-sm text-foreground-600">Each meeting type has its own length, place and link.</p>
        <Button size="sm" icon="ri-add-line" onClick={() => setEditing({ ...NEW_TYPE })}>Add meeting type</Button>
      </div>
      {me.types.length === 0 ? <p className="p-4 text-sm text-foreground-600">No meeting types yet. Add one, for example “Intro call, 30 minutes”.</p> : (
        <ul className="divide-y divide-background-200">
          {me.types.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold text-foreground-950">{t.name} {!t.active ? <Badge tone="muted">Off</Badge> : null} {t.requiresLogin ? <Badge tone="secondary">Sign-in needed</Badge> : null}</p>
                <p className="text-xs text-foreground-600">{t.duration} min · {t.locationKind === "phone" ? "Phone call" : t.locationKind === "video" ? "Video call" : "In person"} · <span className="break-all">{base.replace(/^https:\/\//, "")}/{t.slug}</span></p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" icon="ri-file-copy-line" onClick={() => void navigator.clipboard.writeText(`${base}/${t.slug}`).then(() => onDone(me, "The link was copied."), () => undefined)}>Copy link</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing({ ...t })}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(t)}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={Boolean(editing)} title={editing?.id ? "Edit meeting type" : "Add meeting type"} onClose={() => { if (!busy) setEditing(null); }} width="max-w-2xl"
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy || !editing || editing.name.trim().length < 2} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></>}>
        {editing ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" required><TextInput value={editing.name} maxLength={100} placeholder="Intro call" onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Length" required><Select value={String(editing.duration)} onChange={(e) => set({ duration: Number(e.target.value) })}>{[15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select></Field>
            <div className="md:col-span-2"><Field label="Description"><TextArea rows={2} maxLength={1000} value={editing.description} onChange={(e) => set({ description: e.target.value })} /></Field></div>
            <Field label="Where" required>
              <Select value={editing.locationKind} onChange={(e) => set({ locationKind: e.target.value as MeetingType["locationKind"], locationDetail: "", locationId: null })}>
                <option value="phone">Phone call</option>
                <option value="video">Video call (your own Zoom, Teams or Meet link)</option>
                <option value="in_person">In person</option>
                <option value="teams" disabled>Microsoft Teams, automatic link (needs Microsoft 365 connected)</option>
              </Select>
            </Field>
            {editing.locationKind === "phone" ? <Field label="Phone number or instruction" hint="For example: I will call you, or the number to call."><TextInput value={editing.locationDetail} maxLength={200} onChange={(e) => set({ locationDetail: e.target.value })} /></Field> : null}
            {editing.locationKind === "video" ? <Field label="Meeting link" required hint="Your standing meeting link, starting with https://"><TextInput type="url" value={editing.locationDetail} maxLength={500} placeholder="https://" onChange={(e) => set({ locationDetail: e.target.value })} /></Field> : null}
            {editing.locationKind === "in_person" ? (
              <Field label="Location" required>
                <Select value={editing.locationId ?? ""} onChange={(e) => set({ locationId: e.target.value || null })}>
                  <option value="">Another address (type it below)</option>
                  {me.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
            ) : null}
            {editing.locationKind === "in_person" && !editing.locationId ? <div className="md:col-span-2"><Field label="Address" required><TextInput value={editing.locationDetail} maxLength={300} onChange={(e) => set({ locationDetail: e.target.value })} /></Field></div> : null}
            <Field label="Gap around each booking"><Select value={String(editing.buffer)} onChange={(e) => set({ buffer: Number(e.target.value) })}>{[0, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : "None"}</option>)}</Select></Field>
            <Field label="Shortest notice"><Select value={String(editing.minNoticeHours)} onChange={(e) => set({ minNoticeHours: Number(e.target.value) })}>{[0, 1, 2, 4, 12, 24, 48].map((h) => <option key={h} value={h}>{h ? `${h} hour${h === 1 ? "" : "s"}` : "None"}</option>)}</Select></Field>
            <Field label="Bookable up to"><Select value={String(editing.maxDaysAhead)} onChange={(e) => set({ maxDaysAhead: Number(e.target.value) })}>{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days ahead</option>)}</Select></Field>
            <div className="space-y-2 self-end text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.requiresLogin} onChange={(e) => set({ requiresLogin: e.target.checked })} /> Only signed-in people can book</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.active} onChange={(e) => set({ active: e.target.checked })} /> Can be booked</label>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

function AvailabilityTab({ me, onDone, onError }: { me: BookingMe; onDone: (next: BookingMe, message: string) => void; onError: (e: unknown) => void }) {
  const host = me.host!;
  const [rows, setRows] = useState<AvailabilityRow[]>(me.availability);
  const [off, setOff] = useState<TimeOffRow[]>(me.timeOff);
  const [page, setPage] = useState({ displayName: host.displayName, handle: host.handle, headline: host.headline, timezone: host.timezone, enabled: host.enabled, listed: host.listed });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { onDone(await saveBookingHost({ ...page, availability: rows, timeOff: off.filter((o) => o.start && o.end) }), "Your availability was saved."); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const patchRow = (index: number, patch: Partial<AvailabilityRow>) => setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const patchOff = (index: number, patch: Partial<TimeOffRow>) => setOff((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="font-heading text-base font-bold text-foreground-950">Weekly hours</h2>
        <p className="text-sm text-foreground-600">In your time zone ({page.timezone.replace(/_/g, " ")}). A day without hours cannot be booked.{me.identity.kind === "staff" ? " Approved leave and public holidays are left out automatically." : ""}</p>
        <div className="mt-3 divide-y divide-background-200">
          {WEEKDAYS.map((label, weekday) => {
            const mine = rows.map((r, index) => ({ r, index })).filter((x) => x.r.weekday === weekday);
            return (
              <div key={label} className="flex flex-wrap items-start gap-3 py-2.5">
                <span className="w-24 pt-2 text-sm font-medium text-foreground-900">{label}</span>
                <div className="flex-1 space-y-2">
                  {mine.length === 0 ? <p className="pt-2 text-sm text-foreground-500">Not available</p> : mine.map(({ r, index }) => (
                    <div key={index} className="flex items-center gap-2">
                      <input type="time" aria-label={`${label} from`} value={r.start} onChange={(e) => patchRow(index, { start: e.target.value })} className="rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm" />
                      <span className="text-sm text-foreground-600">to</span>
                      <input type="time" aria-label={`${label} to`} value={r.end} onChange={(e) => patchRow(index, { end: e.target.value })} className="rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm" />
                      <Button size="sm" variant="ghost" aria-label={`Remove ${label} hours`} onClick={() => setRows((list) => list.filter((_, i) => i !== index))}><i className="ri-close-line" aria-hidden="true" /></Button>
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="outline" onClick={() => setRows((list) => [...list, { weekday, start: "09:00", end: "17:00" }])}>Add hours</Button>
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="font-heading text-base font-bold text-foreground-950">Time off</h2><p className="text-sm text-foreground-600">Days nobody can book you.</p></div>
          <Button size="sm" variant="outline" onClick={() => setOff((list) => [...list, { start: "", end: "", note: "" }])}>Add time off</Button>
        </div>
        {off.length === 0 ? <p className="mt-3 text-sm text-foreground-500">None.</p> : off.map((o, index) => (
          <div key={index} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="date" aria-label="First day" value={o.start} onChange={(e) => patchOff(index, { start: e.target.value, end: o.end && o.end >= e.target.value ? o.end : e.target.value })} className="rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm" />
            <span className="text-sm text-foreground-600">to</span>
            <input type="date" aria-label="Last day" value={o.end} min={o.start} onChange={(e) => patchOff(index, { end: e.target.value })} className="rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm" />
            <input type="text" aria-label="Note" placeholder="Note (only you see it)" maxLength={200} value={o.note} onChange={(e) => patchOff(index, { note: e.target.value })} className="min-w-[10rem] flex-1 rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm" />
            <Button size="sm" variant="ghost" aria-label="Remove time off" onClick={() => setOff((list) => list.filter((_, i) => i !== index))}><i className="ri-close-line" aria-hidden="true" /></Button>
          </div>
        ))}
      </Card>
      <Card className="p-5">
        <h2 className="font-heading text-base font-bold text-foreground-950">Booking page</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Field label="Name people see" required><TextInput value={page.displayName} maxLength={100} onChange={(e) => setPage({ ...page, displayName: e.target.value })} /></Field>
          <Field label="Link name" required hint="Changing it breaks links you already shared."><TextInput value={page.handle} maxLength={40} onChange={(e) => setPage({ ...page, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field>
          <Field label="Short line under your name"><TextInput value={page.headline} maxLength={300} placeholder="For example: Admissions team, Melbourne campus" onChange={(e) => setPage({ ...page, headline: e.target.value })} /></Field>
          <Field label="Your time zone" required><Select value={page.timezone} onChange={(e) => setPage({ ...page, timezone: e.target.value })}>{[...new Set([page.timezone, ...timezones()])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select></Field>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={page.enabled} onChange={(e) => setPage({ ...page, enabled: e.target.checked })} /> <span>My booking page is on</span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={page.listed} onChange={(e) => setPage({ ...page, listed: e.target.checked })} /> <span>List me under “Book someone” for signed-in staff, agents and students</span></label>
        </div>
      </Card>
      <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save availability"}</Button>
    </div>
  );
}

function PeopleTab() {
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<DirectoryHost[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { bookingDirectory(search).then((list) => { if (active) { setPeople(list); setError(""); } }).catch((e: Error) => { if (active) setError(e.message); }); }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search]);
  return (
    <Card>
      <div className="border-b border-background-200 px-4 py-3"><TextInput type="search" placeholder="Search by name" aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      {error ? <p role="alert" className="p-4 text-sm text-red-700">{error}</p> : !people ? <p className="p-4 text-sm text-foreground-600">Loading…</p> : people.length === 0 ? (
        <p className="p-4 text-sm text-foreground-600">Nobody is listed{search ? " under that name" : " yet"}. Someone not listed can still send you their booking link.</p>
      ) : (
        <ul className="divide-y divide-background-200">
          {people.map((p) => (
            <li key={p.handle} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div><p className="font-semibold text-foreground-950">{p.name} {KIND_LABEL[p.kind] ? <Badge tone="muted">{KIND_LABEL[p.kind]}</Badge> : null}</p>{p.headline ? <p className="text-xs text-foreground-600">{p.headline}</p> : null}</div>
              <Link to={`/book/${p.handle}`} className="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-[13px] font-medium text-background-50 hover:bg-primary-600"><i className="ri-calendar-check-line" aria-hidden="true" /> Book a time</Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
