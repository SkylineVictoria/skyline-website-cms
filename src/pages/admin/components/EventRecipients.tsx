import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { useToast } from "@/pages/admin/components/toastContext";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import {
  NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS, configWithEvent, eventErrorMessage, hasAnyRecipient, validateEventForm,
  type EventSettings, type NotificationEventKey,
} from "@/lib/notificationEvents";

interface State { legacy: boolean; version: number; source: string; config: Record<string, unknown>; events: Record<NotificationEventKey, EventSettings> }
interface Form { recipientsText: string; notifyAgent: boolean; notifyAgencyAdmins: boolean; notifyStudent: boolean }

const toForm = (s: EventSettings): Form => ({ recipientsText: s.recipients.join("\n"), notifyAgent: s.notifyAgent, notifyAgencyAdmins: s.notifyAgencyAdmins, notifyStudent: s.notifyStudent });

/** Who is emailed for each event. A tenant keeps this in its versioned notifications configuration; the legacy Skyline scope (tenantId null) in its own table. The database enforces who may change it. */
export default function EventRecipients({ tenantId }: { tenantId: string | null }) {
  const { push } = useToast();
  const [state, setState] = useState<State | null>(null);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pdfMode, setPdfMode] = useState<"attach" | "link">("attach");
  const [pdfError, setPdfError] = useState("");
  const [invalid, setInvalid] = useState<{ id: string; event: string; reference: string; recipient: string; at: string }[]>([]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("notification_event_settings_state", { p_tenant: tenantId });
    if (error || !data) { setState(null); return; } // not an organization administrator: the section stays hidden
    const next = data as State;
    setState(next);
    setForms(Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, toForm(next.events[event])])));
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void supabase.rpc("notification_attachment_state", { p_tenant: tenantId }).then(({ data }) => {
      const mode = (data as { submissionPdf?: string } | null)?.submissionPdf;
      if (mode === "attach" || mode === "link") setPdfMode(mode);
    });
  }, [tenantId]);

  useEffect(() => {
    void supabase.rpc("notification_invalid_recipients", { p_tenant: tenantId }).then(({ data }) => { if (Array.isArray(data)) setInvalid(data as typeof invalid); });
  }, [tenantId]);

  const savePdfMode = async (mode: "attach" | "link") => {
    setBusy("pdf"); setPdfError("");
    const { error } = await supabase.rpc("notification_save_attachment_mode", { p_tenant: tenantId, p_mode: mode });
    setBusy(null);
    if (error) { setPdfError(eventErrorMessage(error)); return; }
    setPdfMode(mode);
    push("Submission PDF setting saved");
  };

  const update = (event: NotificationEventKey, patch: Partial<Form>) => setForms((prev) => ({ ...prev, [event]: { ...prev[event], ...patch } }));

  const save = async (event: NotificationEventKey) => {
    if (!state) return;
    const { settings, error } = validateEventForm(forms[event]);
    setErrors((prev) => ({ ...prev, [event]: error ?? "" }));
    if (error) return;
    setBusy(event);
    let failure: { code?: string; message?: string } | null = null;
    if (state.legacy) {
      ({ error: failure } = await supabase.rpc("notification_save_legacy_event", { p_event: event, p_settings: settings }));
    } else {
      const config = configWithEvent(state.source, state.config, event, settings);
      ({ error: failure } = await supabase.rpc("tenant_config_save_draft", { p_tenant: tenantId, p_kind: "notifications", p_config: config, p_base_version: state.version }));
      if (!failure) ({ error: failure } = await supabase.rpc("tenant_config_publish", { p_tenant: tenantId, p_kind: "notifications", p_base_version: state.version }));
    }
    setBusy(null);
    if (failure) { setErrors((prev) => ({ ...prev, [event]: eventErrorMessage(failure) })); return; }
    push(`${NOTIFICATION_EVENT_LABELS[event].title}: recipients saved`);
    await load();
  };

  if (!state) return null;
  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold">Who is emailed</h3>
      <p className="mt-1 text-sm text-background-600">Choose the people notified for each event. Internal addresses do not need a portal account. Nothing is sent until sending is approved, and users can still opt out of their own copy.</p>
      <div className="mt-4 space-y-5">
        {NOTIFICATION_EVENTS.map((event) => {
          const form = forms[event];
          if (!form) return null;
          const label = NOTIFICATION_EVENT_LABELS[event];
          const preview = validateEventForm(form).settings;
          return (
            <fieldset key={event} className="rounded-md border border-background-200 p-4">
              <legend className="px-1 text-sm font-semibold">{label.title}</legend>
              <p className="text-xs text-background-600">{label.when}</p>
              <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-background-700" htmlFor={`recipients-${event}`}>Internal recipients (one per line, up to 10)</label>
              <textarea id={`recipients-${event}`} rows={3} value={form.recipientsText} onChange={(e) => update(event, { recipientsText: e.target.value })} aria-invalid={Boolean(errors[event])} aria-describedby={errors[event] ? `recipients-${event}-error` : undefined}
                className="mt-1 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm" placeholder="admissions@example.edu.au" />
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.notifyAgent} onChange={(e) => update(event, { notifyAgent: e.target.checked })} />Assigned agent</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.notifyAgencyAdmins} onChange={(e) => update(event, { notifyAgencyAdmins: e.target.checked })} />Agency admins</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.notifyStudent} onChange={(e) => update(event, { notifyStudent: e.target.checked })} />Student</label>
              </div>
              {errors[event] ? <p id={`recipients-${event}-error`} role="alert" className="mt-2 text-xs font-medium text-primary-700">{errors[event]}</p> : null}
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" disabled={busy !== null} onClick={() => void save(event)}>{busy === event ? "Saving…" : "Save recipients"}</Button>
                {!hasAnyRecipient(preview) ? <Badge tone="warn">Nobody will be emailed for this event</Badge> : null}
              </div>
            </fieldset>
          );
        })}
      </div>
      {invalid.length > 0 ? (
        <section className="mt-5 rounded-md border border-primary-200 bg-primary-50 p-4" aria-label="Emails not sent: no valid address">
          <h4 className="text-sm font-semibold text-primary-900">Not sent: no valid address ({invalid.length})</h4>
          <p className="mt-1 text-xs text-primary-900/80">These people were meant to be emailed but their address is missing or malformed. Fix the address on the application or the user, then resend the update.</p>
          <ul className="mt-2 space-y-1 text-xs text-primary-900">
            {invalid.slice(0, 10).map((item) => <li key={item.id}>{item.reference} · {item.event.replace(/_/g, " ")} · {item.recipient} · {new Date(item.at).toLocaleDateString()}</li>)}
          </ul>
        </section>
      ) : null}
      <fieldset className="mt-5 rounded-md border border-background-200 p-4" disabled={busy !== null}>
        <legend className="px-1 text-sm font-semibold">Submitted application in the email</legend>
        <p className="text-xs text-background-600">What the "Application submitted" email carries. The PDF is made from the submitted version when the email is sent and is never stored with the delivery.</p>
        <label className="mt-2 flex items-start gap-2 text-sm"><input type="radio" name="submission-pdf" checked={pdfMode === "attach"} onChange={() => void savePdfMode("attach")} className="mt-1" />
          <span>Attach the submitted application as a PDF (up to 2 MB; larger ones fall back to the link)</span></label>
        <label className="mt-1 flex items-start gap-2 text-sm"><input type="radio" name="submission-pdf" checked={pdfMode === "link"} onChange={() => void savePdfMode("link")} className="mt-1" />
          <span>Send only a secure link to the application (recipients must sign in)</span></label>
        {pdfError ? <p role="alert" className="mt-2 text-xs font-medium text-primary-700">{pdfError}</p> : null}
      </fieldset>
    </Card>
  );
}
