import type { AdminSettings, NavMenuItem } from "@/pages/admin/lib/types";
import type { NavItem } from "@/data/site";

/** The contact/social/logo fields the public header and footer read, built from the (possibly unsaved) admin settings. */
export function publicLikeSettings(settings: AdminSettings) {
  return {
    logo: settings.logo,
    logoAlt: settings.name,
    social: settings.social.filter((s) => s.enabled && s.href).map((s) => ({ label: s.label, href: s.href, icon: s.icon || "ri-links-line" })),
    legal: [settings.rto && `RTO ${settings.rto}`, settings.cricos && `CRICOS ${settings.cricos}`].filter(Boolean).join(" "),
    address: settings.address,
    phone: settings.phone,
    phoneHref: `tel:${settings.phone.replace(/[^\d+]/g, "")}`,
    email: settings.email,
    emailHref: `mailto:${settings.email}`,
  };
}

/** The menu the public header builds from saved rows: visible items and children with a label only. */
export function previewNavigation(items: NavMenuItem[]): NavItem[] {
  return items
    .filter((item) => item.visible && item.label.trim())
    .map((item): NavItem => {
      const children = item.children.filter((c) => c.visible && c.label.trim()).map((c) => ({ label: c.label, to: c.to || "/" }));
      return { label: item.label, to: item.to || undefined, external: false, ...(children.length ? { children } : {}) };
    });
}
