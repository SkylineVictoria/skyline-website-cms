import { useCallback, useEffect, useState } from "react";
import {
  formatDate,
  getEmailPreferences,
  getSmsSettings,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeSmsNumber,
  saveSmsNumber,
  setEmailPreference,
  setSmsPreference,
  type NotificationEvent,
  type NotificationRow,
  type SmsSettings,
} from "@/pages/agency/lib/portalData";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

const EVENT_LABELS: [NotificationEvent, string][] = [
  ["application_submitted", "Applications that are submitted"],
  ["application_status_changed", "Status changes on my applications"],
  ["offer_accepted", "Offers accepted on my applications"],
  ["coe_voe_issued", "CoE / VoE issued on my applications"],
];

export default function PortalNotificationsPage() {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState<Record<NotificationEvent, boolean> | null>(null);
  const [prefError, setPrefError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await listNotifications());
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load your notifications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getEmailPreferences().then(setPrefs).catch(() => setPrefError("Your email preferences could not be loaded."));
  }, []);

  const togglePref = async (event: NotificationEvent, enabled: boolean) => {
    setPrefError("");
    try {
      await setEmailPreference(event, enabled);
      setPrefs((prev) => (prev ? { ...prev, [event]: enabled } : prev));
    } catch {
      setPrefError("Your email preference could not be saved. Please try again.");
    }
  };

  const [sms, setSms] = useState<SmsSettings | null>(null);
  const [smsError, setSmsError] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [consent, setConsent] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);

  useEffect(() => {
    getSmsSettings().then(setSms).catch(() => setSmsError("Your text message settings could not be loaded."));
  }, []);

  const saveNumber = async () => {
    setSmsError("");
    setSmsBusy(true);
    try {
      const phone = await saveSmsNumber(phoneInput);
      setSms((prev) => (prev ? { ...prev, phone } : prev));
      setPhoneInput("");
      setConsent(false);
    } catch {
      setSmsError("Enter a valid mobile number, for example 0412 345 678 or +61 412 345 678.");
    } finally {
      setSmsBusy(false);
    }
  };

  const removeNumber = async () => {
    setSmsError("");
    setSmsBusy(true);
    try {
      await removeSmsNumber();
      setSms((prev) => (prev ? { phone: null, events: { application_submitted: false, application_status_changed: false, offer_accepted: false, coe_voe_issued: false } } : prev));
    } catch {
      setSmsError("Your number could not be removed. Please try again.");
    } finally {
      setSmsBusy(false);
    }
  };

  const toggleSms = async (event: NotificationEvent, enabled: boolean) => {
    setSmsError("");
    try {
      await setSmsPreference(event, enabled);
      setSms((prev) => (prev ? { ...prev, events: { ...prev.events, [event]: enabled } } : prev));
    } catch {
      setSmsError("Your text message preference could not be saved. Please try again.");
    }
  };

  const handleRead = async (id: string) => {
    await markNotificationRead(id);
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const handleReadAll = async () => {
    await markAllNotificationsRead();
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const unread = items.filter((n) => !n.read).length;

  return (
    <div>
      <PageHeading
        eyebrow="Notifications"
        title="Notifications"
        description="Status changes and requests relating to your applications."
        action={
          unread > 0 ? (
            <button
              type="button"
              onClick={() => void handleReadAll()}
              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
            >
              Mark all as read
            </button>
          ) : undefined
        }
      />

      <fieldset className="mt-6 rounded-lg border border-background-200 bg-background-50 p-4">
        <legend className="px-1 text-sm font-semibold text-foreground-900">Email me about</legend>
        {prefs ? (
          <div className="space-y-2">
            {EVENT_LABELS.map(([event, label]) => (
              <label key={event} className="flex cursor-pointer items-center gap-2 text-sm text-foreground-800">
                <input type="checkbox" checked={prefs[event]} onChange={(e) => void togglePref(event, e.target.checked)} className="h-4 w-4" />
                {label}
              </label>
            ))}
            <p className="text-xs text-foreground-500">These choices apply to email only. Notifications here in the portal are not affected.</p>
          </div>
        ) : (
          <p className="text-sm text-foreground-500">{prefError || "Loading your email preferences\u2026"}</p>
        )}
        {prefs && prefError ? <p role="alert" className="mt-2 text-sm text-primary-900">{prefError}</p> : null}
      </fieldset>

      <fieldset className="mt-4 rounded-lg border border-background-200 bg-background-50 p-4">
        <legend className="px-1 text-sm font-semibold text-foreground-900">Text me about</legend>
        {!sms ? (
          <p className="text-sm text-foreground-500">{smsError || "Loading your text message settings\u2026"}</p>
        ) : sms.phone ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm text-foreground-800">
              <span>
                Texts go to <span className="font-semibold">{sms.phone}</span>
              </span>
              <button
                type="button"
                disabled={smsBusy}
                onClick={() => void removeNumber()}
                className="cursor-pointer rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Remove number
              </button>
            </div>
            {EVENT_LABELS.map(([event, label]) => (
              <label key={event} className="flex cursor-pointer items-center gap-2 text-sm text-foreground-800">
                <input type="checkbox" checked={sms.events[event]} onChange={(e) => void toggleSms(event, e.target.checked)} className="h-4 w-4" />
                {label}
              </label>
            ))}
            <p className="text-xs text-foreground-500">Text messages are off for each event until you turn them on. Removing your number stops all texts.</p>
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveNumber();
            }}
          >
            <label htmlFor="sms-phone" className="block text-sm text-foreground-800">
              Mobile number
            </label>
            <input
              id="sms-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="0412 345 678"
              className="w-full max-w-xs rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900"
            />
            <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground-800">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4" />
              {/* Same words as the consent recorded by portal_set_sms_contact. TODO(sms-stop): add "Reply STOP to stop" once ClickSend inbound replies are wired up. */}
              I agree to receive text messages about my applications at this number. I can turn them off on the Notifications page at any time.
            </label>
            <button
              type="submit"
              disabled={smsBusy || !consent || !phoneInput.trim()}
              className="cursor-pointer rounded-md bg-primary-700 px-4 py-2 text-sm font-semibold text-background-50 hover:bg-primary-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save number
            </button>
          </form>
        )}
        {sms && smsError ? <p role="alert" className="mt-2 text-sm text-primary-900">{smsError}</p> : null}
      </fieldset>

      <div className="mt-6">
        {loading ? (
          <PortalLoading label="Loading notifications\u2026" />
        ) : error ? (
          <PortalError message={error} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <PortalEmpty
            icon="ri-notification-3-line"
            title="No notifications yet"
            message="You'll be notified here when an application status changes or admissions requests action."
          />
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li
                key={item.id}
                className={`flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
                  item.read ? "border-background-200 bg-background-50" : "border-primary-200 bg-primary-50"
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-base ${
                      item.read ? "bg-background-100 text-foreground-500" : "bg-primary-100 text-primary-700"
                    }`}
                  >
                    <i className={item.read ? "ri-notification-line" : "ri-notification-badge-line"} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground-950">{item.title || "Update"}</p>
                    <p className="mt-0.5 text-sm text-foreground-600">{item.message}</p>
                    <p className="mt-1 text-xs text-foreground-400">
                      {item.reference ? `${item.reference} \u00b7 ` : ""}
                      {formatDate(item.createdAt)}
                    </p>
                  </div>
                </div>
                {!item.read ? (
                  <button
                    type="button"
                    onClick={() => void handleRead(item.id)}
                    className="cursor-pointer whitespace-nowrap rounded-md border border-primary-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-primary-700 hover:bg-primary-100 sm:shrink-0"
                  >
                    Mark read
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}