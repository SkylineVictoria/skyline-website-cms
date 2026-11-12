import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/** Who gets a copy of an application's letters (application_cc_default): the agent, else the agency's main email. */
export interface CcDefault { applies: boolean; agentName?: string; agentEmail?: string; agencyName?: string; agencyEmail?: string; email?: string | null; warning?: string | null }

/** Loads only while `enabled` (a list row asks only when its Resend dialog is open). */
export function useCcDefault(applicationId: string, enabled = true): CcDefault | null {
  const [cc, setCc] = useState<CcDefault | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void supabase.rpc("application_cc_default", { p_application: applicationId }).then(({ data, error }) => {
      if (!active) return;
      if (error) { console.error("[cc] could not read the agent copy:", error.message); setCc({ applies: false }); return; }
      setCc((data ?? { applies: false }) as CcDefault);
    });
    return () => { active = false; };
  }, [applicationId, enabled]);
  return cc;
}

/** After the email went out: the agent's copy (recorded in the status history). A failure is reported, the letter is already sent. */
export async function sendCc(applicationId: string, event: "offer_letter_issued" | "coe_voe_issued", cc: CcDefault | null): Promise<void> {
  if (!cc?.applies || !cc.email) return;
  const { error } = await supabase.rpc("portal_notification_cc", { p_application: applicationId, p_event: event, p_emails: [cc.email] });
  if (error) throw new Error(`Sent, but the copy to ${cc.email} failed: ${error.message}`);
}
