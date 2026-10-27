import { supabase } from "@/pages/admin/lib/supabase";
import { requestWebsiteDomain } from "./tenantHost";

export interface TenantSite {
  tenantId: string;
  hostname: string;
  settingsId: number;
  footerId: number;
  themeVersion: number;
  contentVersion: number;
}

let activeSite: TenantSite | null = null;
export const currentTenantSite = () => activeSite;

export async function resolveTenantSite(): Promise<TenantSite | null> {
  const hostname = requestWebsiteDomain();
  if (!hostname) { activeSite = null; return null; }
  const { data, error } = await supabase.rpc("tenant_website_context");
  if (error || !data || data.hostname !== hostname || !data.tenantId || !Number.isInteger(data.settingsId) || !Number.isInteger(data.footerId) || !(data.themeVersion > 0) || !(data.contentVersion > 0)) {
    activeSite = null;
    throw new Error("Website unavailable or configuration incomplete.");
  }
  activeSite = data as TenantSite;
  return activeSite;
}
