import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import Reveal from "@/components/base/Reveal";
import { breadcrumbSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";
import { calendlyEmbedSrc } from "@/lib/calendly";

type ContactCard = { title: string; subtitle: string; href?: string; icon: string; external?: boolean };

export default function ContactPage() {
  const { data } = usePublicSite();
  const { settings } = data;
  // Calendly's inline embed is a plain iframe; no third-party script runs on the site.
  const bookingSrc = settings.calendlyUrl ? calendlyEmbedSrc(settings.calendlyUrl, typeof window === "undefined" ? "" : window.location.hostname) : "";

  const contactCards: ContactCard[] = [
    {
      title: settings.phone,
      subtitle: "Phone Support",
      href: settings.phoneHref,
      icon: "ri-phone-line",
    },
    {
      title: settings.email,
      subtitle: "Email Address",
      href: settings.emailHref,
      icon: "ri-mail-line",
    },
    ...(bookingSrc ? [{ title: "Book a call", subtitle: "Pick a time that suits you", href: settings.calendlyUrl, icon: "ri-calendar-check-line", external: true }] : []),
    {
      title: settings.address,
      subtitle: "Campus Address",
      icon: "ri-map-pin-2-line",
    },
  ];

  return (
    <>
      <Seo
        title="Contact Us | Skyline Institute Of Technology"
        description="Contact Skyline Institute Of Technology in Melbourne — call 03 9125 1661, email info@slit.edu.au or visit Level 8, 310 King St, Melbourne VIC 3000."
        path="/contact"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Contact", path: "/contact" },
          ]),
        ]}
      />
      <PageHero title="Contact" breadcrumb="Contact" />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container">
          <Reveal className="text-center">
            <p className="font-label text-xs font-semibold uppercase tracking-[0.2em] text-primary-600">Reach us</p>
            <h2 className="mt-3 font-heading text-2xl font-bold text-foreground-950 md:text-3xl">Get In Touch</h2>
          </Reveal>
          <div className={`mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 ${contactCards.length > 3 ? "xl:grid-cols-4" : "lg:grid-cols-3"}`}>
            {contactCards.map((card, index) => {
              const content = (
                <>
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-card bg-primary-100 text-primary-700">
                    <i className={`${card.icon} text-2xl`} aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 font-heading text-base font-semibold text-foreground-950">{card.title}</h3>
                  <p className="mt-2 text-sm text-foreground-500">{card.subtitle}</p>
                </>
              );
              return (
                <Reveal key={card.subtitle} delay={index * 80}>
                  {card.href ? (
                    <a
                      href={card.href}
                      target={card.external ? "_blank" : undefined}
                      rel={card.external ? "noopener noreferrer" : undefined}
                      className="flex h-full flex-col items-center rounded-card border border-background-200 bg-background-50 p-6 text-center transition-colors hover:border-primary-300"
                    >
                      {content}
                    </a>
                  ) : (
                    <div className="flex h-full flex-col items-center rounded-card border border-background-200 bg-background-50 p-6 text-center">
                      {content}
                    </div>
                  )}
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {bookingSrc ? (
        <section className="bg-background-100 py-12 md:py-16">
          <div className="site-container max-w-3xl">
            <Reveal className="text-center">
              <p className="font-label text-xs font-semibold uppercase tracking-[0.2em] text-primary-600">Book a call</p>
              <h2 className="mt-3 font-heading text-2xl font-bold text-foreground-950 md:text-3xl">Pick a time to talk to us</h2>
              <p className="mt-3 text-sm leading-relaxed text-foreground-600">Choose a slot and leave your name, email and phone number. We will call you at that time.</p>
            </Reveal>
            <div className="mt-6 overflow-hidden rounded-card border border-background-200 bg-background-50">
              <iframe title="Book a call" src={bookingSrc} className="h-[720px] w-full border-0" loading="lazy" />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
