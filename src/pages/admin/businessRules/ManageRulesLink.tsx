import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import type { AdminMenuItem } from "@/pages/admin/lib/adminMenu";
import { locationLabel, ruleLocations, rulesRoute } from "./model";

export default function ManageRulesLink() {
  const { pathname, search } = useLocation();
  const [menu, setMenu] = useState<AdminMenuItem[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void supabase.from("admin_menu_items").select("id,parent_id,label,route,icon_key,sort_order,is_enabled,open_in_new_tab")
      .abortSignal(controller.signal).then(({ data, error }) => {
        if (!controller.signal.aborted && !error) setMenu(data ?? []);
      });
    return () => controller.abort();
  }, []);

  if (!menu || pathname === "/admin" || pathname === rulesRoute || pathname === "/admin/set-password") return null;
  const locations = ruleLocations(menu);
  const currentSearch = new URLSearchParams(search);
  if (pathname === "/admin/email-management" && !currentSearch.has("section")) currentSearch.set("section", "accounts");
  const route = locations.filter(item => {
    if (!item.route?.startsWith("/admin/")) return false;
    const [path, query] = item.route.split("?");
    if (pathname !== path && !pathname.startsWith(path + "/")) return false;
    return Array.from(new URLSearchParams(query)).every(([key, value]) => currentSearch.get(key) === value);
  }).sort((a, b) => (b.route?.length ?? 0) - (a.route?.length ?? 0))[0];
  if (!route) return null;
  return <Link to={`${rulesRoute}?menu=${encodeURIComponent(route.id)}`}
    title={`Manage rules for ${locationLabel(locations, route.id)}`}
    className="inline-flex items-center gap-1 rounded-md border border-background-200 px-2 py-1.5 text-label text-primary-700 hover:bg-background-100">
    <i className="ri-shield-check-line" aria-hidden="true" /> Manage Rules
  </Link>;
}
