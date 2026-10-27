import { Link } from "react-router-dom";
import type { MouseEvent, ReactNode } from "react";

export interface FooterLinkModel { label: string; to: string }
export interface FooterViewModel {
  footer: { showAcknowledgement: boolean; acknowledgement: string; about: string; quickLinksTitle: string; studentLinksTitle: string; copyright: string };
  quickLinks: FooterLinkModel[];
  studentLinks: FooterLinkModel[];
  acknowledgementLogo: string;
  mainLogo: string;
  logoAlt: string;
  social: { label: string; href: string; icon: string }[];
  legal: string;
  contact: { address: string; phone: string; phoneHref: string; email: string; emailHref: string };
}

/**
 * The one footer renderer. The public site feeds it from the published data and the CMS preview feeds it from the unsaved form state,
 * so what the editor shows is exactly what visitors get. In `preview` mode nothing navigates away from the editor.
 */
export default function SiteFooterView({ model, preview = false }: { model: FooterViewModel; preview?: boolean }) {
  const { footer, quickLinks, studentLinks, social, contact } = model;
  const stay = preview ? (event: MouseEvent) => event.preventDefault() : undefined;
  const linkClass = "text-sm text-background-200 transition-colors hover:text-primary-300";
  const anchor = (to: string, children: ReactNode, className = linkClass) =>
    preview ? <a href={to} onClick={stay} className={className}>{children}</a> : <Link to={to} className={className}>{children}</Link>;
  const column = (title: string, links: FooterLinkModel[], extra: string) =>
    links.length === 0 ? null : (
      <div className={extra}>
        <h2 className="font-heading text-base font-semibold text-background-50">{title}</h2>
        <ul className="mt-4 space-y-2.5">
          {links.map((link, index) => <li key={`${link.to}-${index}`}>{anchor(link.to, link.label)}</li>)}
        </ul>
      </div>
    );

  return (
    <footer className="mt-auto">
      {footer.showAcknowledgement ? (
        <div className="border-t border-background-200 bg-background-100">
          <div className="site-container flex flex-col items-start gap-4 py-6 md:flex-row md:items-center">
            {model.acknowledgementLogo ? <img src={model.acknowledgementLogo} alt={model.logoAlt} className="h-12 w-auto shrink-0 object-contain md:h-14" /> : null}
            <p className="text-xs leading-relaxed text-foreground-600 md:text-sm">{footer.acknowledgement}</p>
          </div>
        </div>
      ) : null}

      <div className="bg-accent-950 text-background-100">
        <div className="site-container grid grid-cols-1 gap-10 py-14 sm:grid-cols-2 lg:grid-cols-12 lg:gap-8">
          <div className="sm:col-span-2 lg:col-span-4">
            {model.mainLogo ? <img src={model.mainLogo} alt={model.logoAlt} className="h-12 w-auto object-contain" /> : <p className="font-heading text-base font-bold text-background-50">{model.logoAlt}</p>}
            <h2 className="mt-6 font-heading text-base font-semibold text-background-50">About Us</h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-background-200">{footer.about}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {social.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={stay}
                  aria-label={item.label}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-background-50/10 text-background-100 transition-colors hover:bg-primary-500 hover:text-background-50"
                >
                  <i className={`${item.icon} text-base`} aria-hidden="true" />
                </a>
              ))}
            </div>
            {model.legal ? <p className="mt-5 font-label text-sm font-semibold tracking-wide text-background-200">{model.legal}</p> : null}
          </div>

          {column(footer.quickLinksTitle, quickLinks, "lg:col-span-2 lg:col-start-6")}
          {column(footer.studentLinksTitle, studentLinks, quickLinks.length === 0 ? "lg:col-span-2 lg:col-start-6" : "lg:col-span-2")}

          <div className="lg:col-span-3">
            <h2 className="font-heading text-base font-semibold text-background-50">Contact</h2>
            <ul className="mt-4 space-y-3 text-sm text-background-200">
              <li className="flex items-start gap-3">
                <i className="ri-map-pin-line mt-0.5 text-base text-primary-300" aria-hidden="true" />
                <span>{contact.address}</span>
              </li>
              <li className="flex items-center gap-3">
                <i className="ri-phone-line text-base text-primary-300" aria-hidden="true" />
                <a href={contact.phoneHref} onClick={stay} className="transition-colors hover:text-primary-300">{contact.phone}</a>
              </li>
              <li className="flex items-center gap-3">
                <i className="ri-mail-line text-base text-primary-300" aria-hidden="true" />
                <a href={contact.emailHref} onClick={stay} className="transition-colors hover:text-primary-300">{contact.email}</a>
              </li>
            </ul>
            {anchor("/enroll-now", "Enroll Now", "mt-6 inline-block whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600")}
          </div>
        </div>

        <div className="border-t border-background-50/10">
          <div className="site-container flex flex-col items-center justify-center gap-2 py-5 md:flex-row">
            <p className="text-xs text-background-300">{footer.copyright}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
