import { NAV_LIMITS } from "../config/cmsLimits";
import { normalizeCmsPath } from "./cmsPath";
import type { NavMenuItem } from "../pages/admin/lib/types";

interface PageLike { name: string; slug: string; status: string; inNav: boolean }

/**
 * Keeps the header menu in step with a page's "Show in main menu" switch. Before this existed the switch was stored but never read, and
 * menu items were free text, so published pages never reached the header.
 *  - published + switch on: add a top-level item (label = page name, trimmed to the label limit) unless the page is already in the menu;
 *  - switch off: remove the page's item (a dropdown parent that still has children is kept, only its own link is cleared);
 *  - the page's URL changed: every menu link to the old URL follows it.
 * Throws a readable error when the menu is full instead of silently dropping the page or breaking the layout.
 */
export function syncPageNavigation(navigation: NavMenuItem[], page: PageLike, previousSlug?: string): NavMenuItem[] {
  const path = normalizeCmsPath(page.slug);
  const previousPath = previousSlug ? normalizeCmsPath(previousSlug) : null;
  if (!path) return navigation;
  let next = navigation;

  if (previousPath && previousPath !== path) {
    next = next.map((item) => ({
      ...item,
      to: normalizeCmsPath(item.to) === previousPath ? path : item.to,
      children: item.children.map((child) => (normalizeCmsPath(child.to) === previousPath ? { ...child, to: path } : child)),
    }));
  }

  const linked = (to: string) => normalizeCmsPath(to) === path;
  const present = next.some((item) => linked(item.to) || item.children.some((child) => linked(child.to)));

  if (!page.inNav) {
    return next
      .filter((item) => !(linked(item.to) && item.children.length === 0))
      .map((item) => ({ ...item, to: linked(item.to) ? "" : item.to, children: item.children.filter((child) => !linked(child.to)) }));
  }
  if (page.status !== "Published" || present) return next;
  if (next.length >= NAV_LIMITS.maxTopLevel) {
    throw new Error(`The main menu already has ${NAV_LIMITS.maxTopLevel} items. Remove one in Header & Navigation, or turn off "Show in main menu" for this page.`);
  }
  return [...next, { id: `nav-${Date.now()}`, label: (page.name || page.slug).slice(0, NAV_LIMITS.maxLabelLength), to: path, visible: true, children: [] }];
}
