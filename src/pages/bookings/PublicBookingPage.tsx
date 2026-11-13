import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Card, Field, TextArea, TextInput } from "@/pages/admin/components/ui";
import { createBooking, downloadIcs, formatWhen, publicHost, type BookingRow, type PublicHost } from "@/lib/bookingApi";
import BookingShell from "./BookingShell";
import SlotPicker from "./SlotPicker";

/** /book/<handle> and /book/<handle>/<meeting type>: pick a meeting type, a free time, enter your details. No login needed unless the type asks for one. */
export default function PublicBookingPage() {
  const { handle = "", type = "" } = useParams();
  const navigate = useNavigate();
  const [host, setHost] = useState<PublicHost | null | undefined>(undefined);
  const [slot, setSlot] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [done, setDone] = useState<BookingRow | null>(null);

  useEffect(() => {
    setHost(undefined);
    publicHost(handle).then((h) => { setHost(h); if (h?.viewer) setForm((f) => ({ ...f, name: f.name || h.viewer!.name, email: h.viewer!.email })); }).catch(() => setHost(null));
  }, [handle]);
  useEffect(() => { setSlot(""); setError(""); }, [type]);

  if (host === undefined) return <BookingShell><p role="status" className="text-sm text-foreground-600">Loading…</p></BookingShell>;
  if (!host) return <BookingShell><Card className="p-6"><h1 className="font-heading text-lg font-bold">This booking page is not available</h1><p className="mt-2 text-sm text-foreground-600">Check the link, or ask the person for a new one.</p></Card></BookingShell>;
  const chosen = host.types.find((t) => t.slug === type) ?? null;
  const here = `/book/${host.handle}${chosen ? `/${chosen.slug}` : ""}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || !slot) return;
    setBusy(true); setError("");
    try { setDone(await createBooking(host.handle, chosen.slug, slot, form)); }
    catch (err) { setError(err instanceof Error ? err.message : "The booking could not be made."); setSlot(""); setReload((n) => n + 1); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <BookingShell>
        <Card className="p-6" >
          <div data-testid="booking-confirmed">
            <p className="text-sm font-semibold text-green-700"><i className="ri-checkbox-circle-fill mr-1" aria-hidden="true" />Booking confirmed</p>
            <h1 className="mt-1 font-heading text-xl font-bold text-foreground-950">{done.typeName} with {done.hostName}</h1>
            <p className="mt-3 text-sm text-foreground-800"><b>When:</b> {formatWhen(done.startsAt)}</p>
            <p className="mt-1 text-sm text-foreground-800"><b>Where:</b> {done.location}</p>
            <p className="mt-3 text-sm text-foreground-600">A confirmation was emailed to you, with a link to change or cancel.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" icon="ri-calendar-line" onClick={() => downloadIcs(done)}>Add to calendar</Button>
              {done.token ? <Button variant="outline" onClick={() => navigate(`/booking#t=${done.token}`)}>Change or cancel</Button> : null}
              <Button variant="ghost" onClick={() => { setDone(null); setSlot(""); setReload((n) => n + 1); }}>Book another time</Button>
            </div>
          </div>
        </Card>
      </BookingShell>
    );
  }

  return (
    <BookingShell>
      <Card className="p-6">
        <h1 className="font-heading text-xl font-bold text-foreground-950">{host.name}</h1>
        {host.headline ? <p className="mt-1 text-sm text-foreground-600">{host.headline}</p> : null}
        {host.isSelf ? <p className="mt-3 rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">This is your own booking page, as others see it. <Link to="/bookings" className="font-semibold text-primary-700 underline">Manage it</Link></p> : null}

        {!chosen ? (
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-foreground-900">Choose a meeting</h2>
            {host.types.length === 0 ? <p className="mt-2 text-sm text-foreground-600">No meetings can be booked here yet.</p> : (
              <ul className="mt-2 space-y-2">
                {host.types.map((t) => (
                  <li key={t.slug}>
                    <Link to={`/book/${host.handle}/${t.slug}`} className="block rounded-md border border-background-300 px-4 py-3 hover:border-primary-400">
                      <span className="font-semibold text-foreground-950">{t.name}</span>
                      <span className="mt-0.5 block text-xs text-foreground-600">{t.duration} min · {t.location}{t.requiresLogin ? " · sign-in needed" : ""}</span>
                      {t.description ? <span className="mt-1 block text-sm text-foreground-700">{t.description}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mt-5">
            <p className="text-sm"><Link to={`/book/${host.handle}`} className="text-primary-700 hover:underline">&larr; All meetings</Link></p>
            <h2 className="mt-2 font-heading text-base font-bold text-foreground-950">{chosen.name}</h2>
            <p className="text-xs text-foreground-600">{chosen.duration} min · {chosen.location}</p>
            {chosen.description ? <p className="mt-1 text-sm text-foreground-700">{chosen.description}</p> : null}
            {chosen.requiresLogin && !host.signedIn ? (
              <p className="mt-4 rounded-md bg-background-100 px-3 py-3 text-sm text-foreground-800">Sign in to book this meeting. <Link to={`/login?next=${encodeURIComponent(here)}`} className="font-semibold text-primary-700 underline">Sign in</Link></p>
            ) : host.isSelf ? null : (
              <>
                <div className="mt-4"><SlotPicker handle={host.handle} type={chosen.slug} selected={slot} onPick={setSlot} reload={reload} /></div>
                {error ? <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
                {slot ? (
                  <form onSubmit={submit} className="mt-5 space-y-3 border-t border-background-200 pt-4">
                    <p className="text-sm font-semibold text-foreground-900">{formatWhen(slot)}</p>
                    <Field label="Your name" required><TextInput required minLength={2} maxLength={100} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                    <Field label="Email" required hint={host.viewer ? "Your sign-in email." : "The confirmation and the change / cancel link go here."}>
                      <TextInput type="email" required maxLength={254} autoComplete="email" disabled={Boolean(host.viewer)} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                    </Field>
                    <Field label="Phone"><TextInput type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                    <Field label="Anything to share before the meeting?"><TextArea rows={3} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
                    <Button type="submit" disabled={busy}>{busy ? "Booking…" : "Confirm booking"}</Button>
                  </form>
                ) : null}
              </>
            )}
          </div>
        )}
      </Card>
    </BookingShell>
  );
}
