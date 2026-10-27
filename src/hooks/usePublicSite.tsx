import { PublicSiteStatus, PublicSiteSource, PublicSiteContextValue, PublicSiteContext, usePublicSite } from "./publicSiteContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fallbackSiteData, loadPublicSiteData, type PublicSiteData } from "@/lib/publicData";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { supabase } from "@/pages/admin/lib/supabase";
import TenantLoader, { cacheBrand } from "@/components/TenantLoader";

/**
 * Loads all CMS-managed content from Supabase once on mount and keeps it in
 * context so every public component reads from the same live source.
 *
 * Supabase remains the single source of truth: once a read succeeds, the
 * database result (including an intentionally empty list) replaces the static
 * fallback. The fallback is used only during the very first paint or if the
 * database is unreachable.
 */
export function PublicSiteProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<PublicSiteData>(() => fallbackSiteData());
  const [status, setStatus] = useState<PublicSiteStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const [resolved, setResolved] = useState(false);
  const [overlay, setOverlay] = useState<"fading" | "gone">("fading");
  const revisionRef = useRef<number | null>(null);
  const tenantRef = useRef<string | null>(null);

  const load = useCallback(async (silent: boolean) => {
    // A route refresh and the initial load must never fan out into concurrent
    // reads of every CMS table. In particular, React development StrictMode
    // may replay effects while mounting.
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) {
      setStatus("loading");
      setError(null);
    }
    try {
      const next = await loadPublicSiteData();
      setData(next);
      // Remember this site's branding (cms_settings.name / logo / primary_color) for a branded loader on the next visit.
      cacheBrand({ name: next.settings.name, logoUrl: next.settings.logo, primary: next.theme?.primaryColor });
      revisionRef.current = next.publicVersion ?? null;
      tenantRef.current = next.tenantSite?.tenantId ?? null;
      setResolved(true);
      setStatus("ready");
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not load website content.";
      if (silent && !requestWebsiteDomain()) {
        // Background refresh failed: keep whatever is already on screen.
        return;
      }
      setError(message);
      setStatus("error");
      setResolved(false);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // These must be stable. RouteRefresh depends on `refresh`; recreating it on
  // every successful data update caused the route effect to reload all CMS
  // tables forever.
  const refresh = useCallback(() => load(true), [load]);
  const reload = useCallback(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!resolved) return;
    let disposed = false;
    const poll = async () => {
      if (loadingRef.current || document.visibilityState === "hidden") return;
      const { data: revision, error: revisionError } = await supabase.rpc("cms_public_revision");
      if (disposed) return;
      if (revisionError) {
        if (requestWebsiteDomain()) { setResolved(false); setStatus("error"); setError("Website unavailable."); }
        return;
      }
      if (revision.contentVersion !== revisionRef.current) await refresh();
    };
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("skyline-public-content") : null;
    if (channel) channel.onmessage = (event) => { if (event.data?.tenantId === tenantRef.current) void refresh(); };
    const timer = window.setInterval(() => void poll(), 5000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => { disposed = true; window.clearInterval(timer); channel?.close(); window.removeEventListener("focus", poll); document.removeEventListener("visibilitychange", poll); };
  }, [resolved, refresh]);

  // Apply the CMS-managed favicon to the document head at runtime so a favicon
  // change in the CMS shows up on the live site without a redeploy.
  useEffect(() => {
    if (!resolved) return;
    const href = data.settings.favicon;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!href) { link?.remove(); return; }
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }, [data.settings.favicon, resolved]);

  const value = useMemo<PublicSiteContextValue>(
    () => ({
      data,
      status,
      isLive: data.backedByDatabase,
      error,
      refresh,
      reload,
    }),
    [data, status, error, refresh, reload],
  );

  // Once the tenant has loaded, the page renders underneath while the loader fades out, so there is no abrupt flash.
  useEffect(() => {
    if (!resolved) { setOverlay("fading"); return undefined; }
    const timer = window.setTimeout(() => setOverlay("gone"), 450);
    return () => window.clearTimeout(timer);
  }, [resolved]);

  if (!resolved) return <TenantLoader error={status === "error"} onRetry={reload} />;
  return (
    <PublicSiteContext.Provider value={value}>
      {children}
      {overlay === "fading" ? <TenantLoader leaving brand={{ name: data.settings.name, logoUrl: data.settings.logo, primary: data.theme?.primaryColor }} /> : null}
    </PublicSiteContext.Provider>
  );
}
