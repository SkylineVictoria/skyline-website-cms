import { useCallback, useEffect, useState } from "react";
import {
  formatDate,
  getEmailPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setEmailPreference,
  type NotificationEvent,
  type NotificationRow,
} from "@/pages/agency/lib/portalData";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

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
            {([["application_submitted", "Applications that are submitted"], ["application_status_changed", "Status changes on my applications"], ["offer_accepted", "Offers accepted on my applications"], ["coe_voe_issued", "CoE / VoE issued on my applications"]] as [NotificationEvent, string][]).map(([event, label]) => (
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