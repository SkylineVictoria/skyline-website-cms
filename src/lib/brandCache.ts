import { DEFAULT_ACCENT_HEX, DEFAULT_PRIMARY_HEX, isHexColour } from "@/lib/colour";
import { LOADER_STYLES, type LoaderStyle } from "@/config/cmsLimits";

/** What the loader needs to look like the site before any data has arrived. Cached per tenant in localStorage (brand:<key>). */
export interface TenantBrand { name: string; logoUrl: string; primary: string; accent: string; loaderStyle: LoaderStyle }

const LEGACY_HOSTS = ["slit.edu.au", "www.slit.edu.au", "localhost", "127.0.0.1"];

/** Same selector the site uses to pick a tenant (the hostname); the known legacy hosts share one "legacy" key. */
export function tenantBrandKey(): string {
  if (typeof window === "undefined") return "legacy";
  const host = window.location.hostname.toLowerCase().replace(/\.$/, "");
  return LEGACY_HOSTS.includes(host) ? "legacy" : host;
}

/** Only https URLs and same-origin paths may be used as a logo; anything else falls back to the monogram. */
export const safeLogo = (value: unknown): string => (typeof value === "string" && /^(https:\/\/|\/(?!\/))/i.test(value) && value.length < 2000 ? value : "");
const style = (value: unknown): LoaderStyle => (LOADER_STYLES as readonly unknown[]).includes(value) ? (value as LoaderStyle) : "ring";

export function normaliseBrand(input: Partial<TenantBrand> | null | undefined): TenantBrand {
  return {
    name: typeof input?.name === "string" ? input.name.trim().slice(0, 80) : "",
    logoUrl: safeLogo(input?.logoUrl),
    primary: isHexColour(input?.primary) ? input.primary : DEFAULT_PRIMARY_HEX,
    accent: isHexColour(input?.accent) ? input.accent : DEFAULT_ACCENT_HEX,
    loaderStyle: style(input?.loaderStyle),
  };
}

export function readCachedBrand(key: string = tenantBrandKey()): TenantBrand | null {
  try {
    const raw = window.localStorage.getItem(`brand:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TenantBrand> | null;
    return parsed && typeof parsed === "object" ? normaliseBrand(parsed) : null;
  } catch {
    return null;
  }
}

/** Remember the tenant's branding so the next visit shows a branded loader before any data arrives. Call again whenever it changes. */
export function cacheBrand(brand: Partial<TenantBrand>, key: string = tenantBrandKey()): void {
  try {
    window.localStorage.setItem(`brand:${key}`, JSON.stringify(normaliseBrand(brand)));
  } catch {
    /* storage can be unavailable (private mode, blocked); the loader simply stays generic */
  }
}
