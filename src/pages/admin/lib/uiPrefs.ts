// A CMS user's display preferences (Display density, sidebar as icons), saved to their profile (public.cms_user_prefs) and kept
// in this browser too, so the first paint already uses them.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

export type Density = "compact" | "comfortable";
export type SidebarMode = "full" | "icons";
export interface UiPrefs { density: Density; sidebar: SidebarMode }
const DEFAULTS: UiPrefs = { density: "compact", sidebar: "full" };
const KEY = "skyline.cms.uiPrefs";

const valid = (p: Partial<UiPrefs> | null | undefined): Partial<UiPrefs> => ({
  ...(p?.density === "compact" || p?.density === "comfortable" ? { density: p.density } : {}),
  ...(p?.sidebar === "full" || p?.sidebar === "icons" ? { sidebar: p.sidebar } : {}),
});
const cached = (): UiPrefs => {
  try { return { ...DEFAULTS, ...valid(JSON.parse(window.localStorage.getItem(KEY) ?? "null")) }; } catch { return DEFAULTS; }
};
const remember = (p: UiPrefs) => { try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ } };

export function useUiPrefs(userId: string | undefined) {
  const [prefs, setPrefs] = useState<UiPrefs>(cached);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void supabase.rpc("cms_user_prefs").then(({ data }) => {
      if (!live || !data) return;
      const next = { ...DEFAULTS, ...valid(data as Partial<UiPrefs>) };
      setPrefs(next); remember(next);
    });
    return () => { live = false; };
  }, [userId]);
  const update = useCallback((patch: Partial<UiPrefs>) => {
    setPrefs((p) => { const next = { ...p, ...patch }; remember(next); return next; });
    void supabase.rpc("cms_user_prefs", { p_prefs: patch });
  }, []);
  return [prefs, update] as const;
}
