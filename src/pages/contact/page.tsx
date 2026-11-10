import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import Reveal from "@/components/base/Reveal";
import { breadcrumbSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";
import { calendlyEmbedSrc } from "@/lib/calendly";

export default function ContactPage() {
  const { data } = usePublicSite();
  const { settings } = data;
  // Calendly's inline embed is a plain iframe; no third-party script runs on the site.
  const bookingSrc = settings.calendlyUrl ? calendlyEmbedSrc(settings.calendlyUrl, typeof window === "undefined" ? "" : window.location.hostname) : "";

  return (
    <>
      <Seo
        title="Contact Us | Skyline Institute Of Technology"
        description="Book a call with Skyline Institute Of Technology in Melbourne."
        path="/contact"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Contact", path: "/contact" },
          ]),
        ]}
      />
      <PageHero title="Contact" breadcrumb="Contact" />
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
