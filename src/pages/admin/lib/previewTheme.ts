import type { AdminSettings } from "@/pages/admin/lib/types";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import type { SiteTheme } from "@/lib/tenantTheme";
import type { LoaderStyle } from "@/config/cmsLimits";

/**
 * The theme the public site would apply for these (possibly unsaved) settings, using the same gating as the public data layer:
 * a tenant site always has a theme, the legacy site only once a theme has been configured. Used by every CMS preview.
 */
export function siteThemeFromSettings(settings: AdminSettings): SiteTheme | undefined {
  if (!requestWebsiteDomain() && !settings.themeConfigured) return undefined;
  return {
    primaryColor: settings.primaryColor ?? "",
    headingFont: settings.headingFont ?? "Arial",
    bodyFont: settings.bodyFont ?? "Arial",
    accentColor: settings.accentColor || undefined,
    loaderStyle: (settings.loaderStyle as LoaderStyle | undefined) ?? "ring",
  };
}
