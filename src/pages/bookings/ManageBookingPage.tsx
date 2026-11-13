import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, TextArea } from "@/pages/admin/components/ui";
import { cancelBooking, downloadIcs, formatWhen, manageBooking, rescheduleBooking, type BookingRow } from "@/lib/bookingApi";
import BookingShell from "./BookingShell";
import SlotPicker from "./SlotPicker";

/** /booking#t=<token>: the link in the confirmation email. The person who booked can see, move or cancel the booking without a login. */
export default function ManageBookingPage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "");
  const [booking, setBooking] = useState<BookingRow | null | undefined>(undefined);
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [slot, setSlot] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { manageBooking(token).then(setBooking).catch(() => setBooking(null)); }, [token]);

  if (booking === undefined) return <BookingShell><p role="status" className="text-sm text-foreground-600">Loading…</p></BookingShell>;
  if (!booking) return <BookingShell><Card className="p-6"><h1 className="font-heading text-lg font-bold">This booking link is not valid</h1><p className="mt-2 text-sm text-foreground-600">Open the link from your confirmation email again.</p></Card></BookingShell>;
  const upcoming = booking.status === "confirmed" && new Date(booking.startsAt).getTime() > Date.now();
  const run = async (work: () => Promise<BookingRow>, message: string) => {
    setBusy(true); setError("");
    try { setBooking(await work()); setMode("view"); setSlot(""); setNotice(message); }
    catch (e) { setError(e instanceof Error ? e.message : "That did not work. Please try again."); }
    finally { setBusy(false); }
  };

  return (
    <BookingShell>
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="font-heading text-xl font-bold text-foreground-950">{booking.typeName} with {booking.hostName}</h1>
          <Badge tone={booking.status === "cancelled" ? "muted" : upcoming ? "success" : "muted"}>{booking.status === "cancelled" ? "Cancelled" : upcoming ? "Confirmed" : "Past"}</Badge>
        </div>
        <p className="mt-3 text-sm text-foreground-800"><b>When:</b> {formatWhen(booking.startsAt)}</p>
        <p className="mt-1 text-sm text-foreground-800"><b>Where:</b> {booking.location}</p>
        {booking.note ? <p className="mt-1 text-sm text-foreground-800"><b>Note:</b> {booking.note}</p> : null}
        {notice ? <p role="status" className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p> : null}
        {error ? <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}

        {upcoming && mode === "view" ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" icon="ri-calendar-line" onClick={() => downloadIcs(booking)}>Add to calendar</Button>
            <Button variant="outline" onClick={() => { setMode("move"); setNotice(""); }}>Change time</Button>
            <Button variant="ghost" onClick={() => { setMode("cancel"); setNotice(""); }}>Cancel booking</Button>
          </div>
        ) : null}
        {upcoming && mode === "move" ? (
          <div className="mt-5 border-t border-background-200 pt-4">
            <h2 className="mb-2 text-sm font-semibold text-foreground-900">Choose a new time</h2>
            <SlotPicker handle={booking.hostHandle} type={booking.typeSlug} token={token} selected={slot} onPick={setSlot} />
            <div className="mt-4 flex gap-2">
              <Button disabled={!slot || busy} onClick={() => void run(() => rescheduleBooking({ token }, slot), "Your booking has a new time. A confirmation was emailed.")}>{busy ? "Saving…" : slot ? `Move to ${formatWhen(slot)}` : "Choose a time"}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setMode("view")}>Keep current time</Button>
            </div>
          </div>
        ) : null}
        {upcoming && mode === "cancel" ? (
          <div className="mt-5 space-y-3 border-t border-background-200 pt-4">
            <Field label="Reason (optional)"><TextArea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void run(() => cancelBooking({ token }, reason), "Your booking was cancelled.")}>{busy ? "Cancelling…" : "Cancel booking"}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setMode("view")}>Keep booking</Button>
            </div>
          </div>
        ) : null}
        {!upcoming ? <p className="mt-4 text-sm"><Link to={`/book/${booking.hostHandle}`} className="font-semibold text-primary-700 underline">Book another time with {booking.hostName}</Link></p> : null}
      </Card>
    </BookingShell>
  );
}
