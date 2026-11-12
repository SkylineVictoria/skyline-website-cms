import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, ConfirmDialog, Modal, TextInput } from "@/pages/admin/components/ui";
import { addTicketNotify, listTicketNotify, removeTicketNotify, type TicketNotifyRecipient } from "@/lib/supportTickets";

/**
 * CMS > Tickets > Notification emails. Everyone on this list (for example a support@ distribution group) gets an email
 * about every ticket reply, internal note and status change. The person who opened the ticket and the person who acted
 * get their own copy anyway.
 */
export default function TicketNotifyEmails() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<TicketNotifyRecipient[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<TicketNotifyRecipient | null>(null);

  const load = useCallback(() => {
    setLoadError("");
    listTicketNotify().then(setList, (e: Error) => setLoadError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setBusy(true);
    try {
      const added = await addTicketNotify(email.trim(), label.trim());
      setList((prev) => [...(prev ?? []), added].sort((a, b) => a.email.localeCompare(b.email)));
      setEmail(""); setLabel("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!removing) return;
    const target = removing;
    setRemoving(null);
    try { await removeTicketNotify(target.id); setList((prev) => (prev ?? []).filter((r) => r.id !== target.id)); }
    catch (e) { setLoadError((e as Error).message); }
  };

  const count = list?.length ?? 0;
  return (
    <>
      <Button variant="outline" icon="ri-mail-settings-line" onClick={() => setOpen(true)} data-testid="ticket-notify-open">
        Notification emails{list ? ` (${count})` : ""}
      </Button>
      <Modal open={open} title="Ticket notification emails" onClose={() => setOpen(false)} width="max-w-xl"
        footer={<Button variant="outline" onClick={() => setOpen(false)}>Done</Button>}>
        <p className="text-sm text-foreground-600">
          These addresses get an email for every ticket reply, internal note and status change. Use a shared or group
          address (for example support@) so nobody has to be added one by one. The person who opened the ticket and the
          person who replied always get their own copy.
        </p>

        {loadError ? <p className="mt-3 text-sm text-primary-700" role="alert">{loadError} <button type="button" className="underline" onClick={load}>Try again</button></p> : null}

        <ul className="mt-4 divide-y divide-background-200 rounded-md border border-background-200" data-testid="ticket-notify-list">
          {list === null && !loadError ? <li className="px-3 py-3 text-sm text-foreground-500">Loading…</li> : null}
          {list !== null && count === 0 ? <li className="px-3 py-3 text-sm text-foreground-500">No emails yet. Only the requester and the person who replied are emailed.</li> : null}
          {(list ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
              <i className="ri-mail-line text-foreground-500" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground-900">{r.email}</span>
                {r.label ? <span className="block truncate text-xs text-foreground-500">{r.label}</span> : null}
              </span>
              <Button variant="ghost" size="sm" icon="ri-delete-bin-line" aria-label={`Remove ${r.email}`} onClick={() => setRemoving(r)}>Remove</Button>
            </li>
          ))}
        </ul>

        <form onSubmit={add} className="mt-4 space-y-2" noValidate>
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="support@example.com" aria-label="Email" data-testid="ticket-notify-email" />
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" maxLength={100} aria-label="Name" />
          </div>
          {error ? <p className="text-xs text-primary-700" role="alert">{error}</p> : null}
          <Button type="submit" icon="ri-add-line" disabled={busy || !email.trim()} data-testid="ticket-notify-add">{busy ? "Adding…" : "Add email"}</Button>
        </form>
      </Modal>
      <ConfirmDialog open={removing !== null} title="Remove this email?"
        message={removing ? `${removing.email} will stop getting ticket emails.` : ""}
        confirmLabel="Remove" onConfirm={() => { void remove(); }} onCancel={() => setRemoving(null)} />
    </>
  );
}
