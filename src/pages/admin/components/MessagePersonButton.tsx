import { useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { openCommPopup } from "@/lib/commPopup";

export type MessageKind = "student" | "agent" | "staff" | "applicant" | "agency";

/** "Message" on a person's page: opens the messages popup straight to that person (email / SMS / WhatsApp / note, one log). */
export default function MessagePersonButton({ kind, refId, name, label = "Message", variant = "outline", size = "md" }: {
  kind: MessageKind; refId: string | null | undefined; name: string; label?: string; variant?: "primary" | "outline" | "ghost"; size?: "sm" | "md";
}) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  if (!refId) return null;
  const open = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("comm_open_conversation", { p_kind: kind, p_ref: refId });
    setBusy(false);
    if (error) { push(`Could not open messages with ${name || "this person"}: ${error.message}`, "error"); return; }
    openCommPopup({ conversationId: String(data) });
  };
  return (
    <Button variant={variant} size={size} icon="ri-chat-3-line" disabled={busy} onClick={() => void open()} data-testid={`message-${kind}`}>
      {busy ? "Opening…" : label}
    </Button>
  );
}
