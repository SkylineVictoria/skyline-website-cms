export interface PortalScope { key: string; tenantId: string | null; name: string; domain: string | null; userId?: string }
let scope: PortalScope | null = null;
export const currentPortalScope = () => scope;
export const portalScopeDomain = () => scope?.domain ?? null;
export const portalScopeCacheKey = () => `${scope?.userId ?? "anonymous"}:${scope?.key ?? "unresolved"}`;
export function setPortalScope(next: PortalScope | null) {
  const previousKey = portalScopeCacheKey();
  scope = next;
  if (typeof window !== "undefined" && previousKey !== portalScopeCacheKey()) window.dispatchEvent(new Event("portal-scope-changed"));
}

export async function flushPortalBeforeSwitch(): Promise<void> {
  const waits: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent("portal-before-scope-switch", { detail: { waits } }));
  await Promise.all(waits);
}
