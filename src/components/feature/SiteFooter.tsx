import { usePublicSite } from "@/hooks/publicSiteContext";
import SiteFooterView, { type FooterViewModel } from "@/components/feature/SiteFooterView";
import { footerLogos } from "@/config/brandFallbacks";

export default function SiteFooter() {
  const { data } = usePublicSite();
  const { footer, footerLinks, studentLinks, settings } = data;
  const logos = footerLogos(settings.logoConfigured, Boolean(data.tenantSite));
  const model: FooterViewModel = {
    footer,
    quickLinks: footerLinks,
    studentLinks,
    acknowledgementLogo: logos.acknowledgement,
    mainLogo: logos.main,
    logoAlt: settings.logoAlt,
    social: settings.social,
    legal: settings.legal,
    contact: { address: settings.address, phone: settings.phone, phoneHref: settings.phoneHref, email: settings.email, emailHref: settings.emailHref },
  };
  return <SiteFooterView model={model} />;
}
