import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { ConversationView } from "@/pages/admin/components/CommunicationInbox";

/**
 * EMPLOYEE-COMMS (2026-11-24, owner: "add communication also like business"): the employee's Communication Hub conversation on
 * their page (email / SMS / WhatsApp when connected / note, with the automatic HR emails in the same thread), opened by
 * comm_open_conversation('staff', profile id), the same conversation the Message button and the Messages popup use.
 */
export default function EmployeeMessages({ profileId }: { profileId: string }) {
  const [conversation, setConversation] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void supabase.rpc("comm_open_conversation", { p_kind: "staff", p_ref: profileId }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) setError(e.message); else setConversation(String(data));
    });
    return () => { live = false; };
  }, [profileId]);
  if (error) return <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">Messages could not be opened: {error}</p>;
  if (!conversation) return <p className="text-sm text-foreground-600" role="status">Loading messages…</p>;
  return <div data-testid="employee-messages"><ConversationView id={conversation} onBack={() => undefined} onSent={() => undefined} /></div>;
}
