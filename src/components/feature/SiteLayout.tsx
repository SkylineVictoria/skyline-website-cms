import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import SiteHeader from "./SiteHeader";
import SiteFooter from "./SiteFooter";
import { StructuredData } from "./Seo";
import { organizationSchema, websiteSchema } from "@/data/seo";
import { PublicSiteProvider } from "@/hooks/usePublicSite";
import { usePublicSite } from "@/hooks/publicSiteContext";
import PublicAssistant from "./PublicAssistant";
import TenantPublicContent from "./TenantPublicContent";
import { tenantThemeStyle } from "@/lib/tenantTheme";

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [location.pathname]);
  return null;
}

function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-0.5 bg-transparent" aria-hidden="true">
      <div
        className="h-full bg-primary-500 transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-primary-500 text-background-50 shadow-lg transition-colors hover:bg-primary-600"
    >
      <i className="ri-arrow-up-line text-xl" aria-hidden="true" />
    </button>
  );
}

/**
 * Silently refetches CMS content when the visitor navigates to a new route, so
 * edits made in another tab/session show up without a hard reload. It never
 * blocks rendering or hides already-loaded content.
 */
function RouteRefresh() {
  const { refresh } = usePublicSite();
  const location = useLocation();
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    void refresh();
  }, [location.pathname, refresh]);

  return null;
}

function SiteLayoutInner() {
  const { data } = usePublicSite();
  return (
    <div className="flex min-h-screen flex-col bg-background-50 font-body" data-tenant-site={data.tenantSite?.tenantId} style={tenantThemeStyle(data.theme)}>
      {!data.tenantSite ? <StructuredData data={[organizationSchema, websiteSchema]} /> : <StructuredData data={[
        { "@context": "https://schema.org", "@type": "EducationalOrganization", name: data.settings.name, url: window.location.origin, logo: data.settings.logo, email: data.settings.email, telephone: data.settings.phone, address: data.settings.address },
        { "@context": "https://schema.org", "@type": "WebSite", name: data.settings.name, url: window.location.origin },
      ]} />}
      <ScrollProgress />
      <ScrollToTop />
      <RouteRefresh />
      <SiteHeader />
      <main className="flex-1">
        {data.tenantSite ? <TenantPublicContent /> : <Outlet />}
      </main>
      <SiteFooter />
      {!data.tenantSite ? <PublicAssistant /> : null}
      <BackToTop />
    </div>
  );
}

export default function SiteLayout() {
  return (
    <PublicSiteProvider>
      <SiteLayoutInner />
    </PublicSiteProvider>
  );
}
