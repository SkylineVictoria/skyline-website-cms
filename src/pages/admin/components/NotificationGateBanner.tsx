import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/** "Email sending is not active: <which gate>". The gates the database can see only; no secret values are read or shown. */
export default function NotificationGateBanner() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void supabase.rpc("notification_gate_state").then(({ data, error }) => {
      if (!active || error || !data) return;
      setMessage(data.active ? "" : String(data.message ?? "a sending gate is closed"));
    });
    return () => { active = false; };
  }, []);
  if (!message) return null;
  return (
    <p role="status" className="mb-4 flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900">
      <i className="ri-mail-forbid-line mt-0.5" aria-hidden="true" />
      <span>Email sending is not active: {message}. Notifications are recorded as blocked until it is opened.</span>
    </p>
  );
}
