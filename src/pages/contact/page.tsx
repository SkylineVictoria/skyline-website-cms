import Seo from "@/components/feature/Seo";
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
      {bookingSrc ? (
        <section className="bg-background-50 py-8 md:py-12" aria-labelledby="booking-title">
          <div className="site-container max-w-6xl">
            <div className="text-center">
              <h1 id="booking-title" className="font-heading text-3xl font-bold tracking-tight text-foreground-950 md:text-4xl">Book a call</h1>
              <p className="mt-2 text-sm text-foreground-600 md:text-base">Choose a time and we’ll call you.</p>
            </div>
            <iframe
              title="Schedule a call with Skyline Institute of Technology"
              src={bookingSrc}
              className="mt-6 block h-[820px] w-full border-0 sm:h-[720px]"
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
