import { supabase } from "@/pages/admin/lib/supabase";
import { currentTenantSite } from "@/lib/tenantSite";

/** Whether a Calendly API token is saved for this site; the token itself never comes back. */
export type CalendlyTokenStatus = { configured: boolean; updatedAt: string | null; hint: string };

export type CalendlyConnection = {
  name: string;
  email: string;
  schedulingUrl: string;
  eventTypes: { name: string; schedulingUrl: string; duration: number }[];
};

const tenantId = () => currentTenantSite()?.tenantId ?? null;

function statusOf(data: unknown): CalendlyTokenStatus {
  const row = (data ?? {}) as Record<string, unknown>;
  return { configured: row.configured === true, updatedAt: row.updatedAt ? String(row.updatedAt) : null, hint: row.hint ? String(row.hint) : "" };
}

export async function calendlyTokenStatus(): Promise<CalendlyTokenStatus> {
  const { data, error } = await supabase.rpc("cms_integration_status", { p_provider: "calendly", p_tenant: tenantId() });
  if (error) throw new Error(error.message);
  return statusOf(data);
}

/** Saves the token; an empty value removes it. */
export async function saveCalendlyToken(token: string): Promise<CalendlyTokenStatus> {
  const { data, error } = await supabase.rpc("cms_integration_secret_set", { p_provider: "calendly", p_tenant: tenantId(), p_secret: token.trim() });
  if (error) throw new Error(error.message);
  return statusOf(data);
}

/** Asks Calendly (through the calendly-admin Edge Function) who the saved token belongs to and which event types it has. */
export async function checkCalendlyConnection(): Promise<CalendlyConnection> {
  const { data, error } = await supabase.functions.invoke("calendly-admin", { body: { action: "verify", tenantId: tenantId() } });
  if (error) {
    let message = error.message;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch { /* keep the generic message */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  const row = (data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(row.eventTypes) ? (row.eventTypes as Record<string, unknown>[]) : [];
  return {
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    schedulingUrl: String(row.schedulingUrl ?? ""),
    eventTypes: list.map((item) => ({ name: String(item.name ?? ""), schedulingUrl: String(item.schedulingUrl ?? ""), duration: Number(item.duration ?? 0) || 0 })),
  };
}
