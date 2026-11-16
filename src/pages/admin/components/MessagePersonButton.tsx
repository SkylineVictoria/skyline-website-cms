import { useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { ConversationView } from "@/pages/admin/components/CommunicationInbox";

export type MessageKind = "student" | "agent" | "staff" | "applicant" | "agency";

/**
 * "Message" on a person's page: opens that person's Communication Hub conversation in a panel. Staff choose Email, SMS or WhatsApp
 * (whichever are connected in Integrations) or an internal note, can start from a template, and see everything already sent.
 * Every message is recorded in the same conversation the Communication Hub shows.
 */
export default function MessagePersonButton({ kind, refId, name, label = "Message", variant = "outline", size = "md" }: {
  kind: MessageKind; refId: string | null | undefined; name: string; label?: string; variant?: "primary" | "outline" | "ghost"; size?: "sm" | "md";
}) {
  const { push } = useToast();
  const [conversation, setConversation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!refId) return null;
  const open = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("comm_open_conversation", { p_kind: kind, p_ref: refId });
    setBusy(false);
    if (error) { push(`Could not open messages: ${error.message}`, "error"); return; }
    setConversation(String(data));
  };
  return (
    <>
      <Button variant={variant} size={size} icon="ri-chat-3-line" disabled={busy} onClick={() => void open()} data-testid={`message-${kind}`}>
        {busy ? "Opening…" : label}
      </Button>
      {conversation ? (
        <Modal open title={`Messages with ${name || "this person"}`} onClose={() => setConversation(null)} width="max-w-3xl">
          <p className="mb-3 text-xs text-foreground-500">Email, SMS and WhatsApp (when connected in Integrations) and internal notes. Everything here is also in Communication Hub › Conversations.</p>
          <ConversationView id={conversation} onBack={() => setConversation(null)} onSent={() => undefined} />
        </Modal>
      ) : null}
    </>
  );
}
