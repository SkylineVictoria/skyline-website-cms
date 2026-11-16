import { useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { openCommPopup } from "@/lib/commPopup";

/**
 * Chat icon next to a person's name (replaces the old WhatsApp / email shortcuts that sent outside any record). It finds the person
 * from their email or mobile and opens the Messages popup to their conversation, where staff send by email, SMS, WhatsApp or Teams
 * and everything is recorded. Admin area only; renders nothing without an email or mobile.
 */
export default function PersonMessageIcon({ name, email, phone, className = "" }: { name?: string | null; email?: string | null; phone?: string | null; className?: string }) {
  const [busy, setBusy] = useState(false);
  if (!(email ?? "").trim() && !(phone ?? "").trim()) return null;
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) return null;
  const label = `Message ${name || "this person"}`;
  const open = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setBusy(true);
    const { data, error } = await supabase.rpc("comm_find_or_open", { p_name: name ?? "", p_email: email ?? "", p_phone: phone ?? "" });
    setBusy(false);
    if (error) { window.alert(`Could not open messages: ${error.message}`); return; }
    openCommPopup({ conversationId: String(data) });
  };
  return (
    <button type="button" onClick={(e) => void open(e)} disabled={busy} aria-label={label} title={label} data-testid="person-message-icon"
      className={`ml-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full align-middle text-primary-600 hover:bg-primary-50 disabled:opacity-50 ${className}`}>
      <i className={busy ? "ri-loader-4-line animate-spin text-base leading-none" : "ri-chat-3-line text-base leading-none"} aria-hidden="true" />
    </button>
  );
}
