import EnquiryForm, { type FormField } from "@/components/feature/EnquiryForm";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import Reveal from "@/components/base/Reveal";
import { breadcrumbSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

const contactFields: FormField[] = [
  { name: "name", label: "Your Name", type: "text", required: true, placeholder: "Your Name" },
  { name: "email", label: "Your Email", type: "email", required: true, placeholder: "Your Email" },
  { name: "phone", label: "Phone No", type: "tel", required: true, placeholder: "Phone No" },
  { name: "message", label: "Message", type: "textarea", required: true, placeholder: "Message" },
];

export default function ContactPage() {
  const { data } = usePublicSite();
  const { settings } = data;

  const contactCards = [
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
          <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-3">
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

      <section className="bg-background-100 pb-12 md:pb-16">
        <div className="site-container max-w-3xl">
          <EnquiryForm
            formId="skyline-contact-form"
            submitAddr="https://readdy.ai/api/form/db31smmoc082o2i1kl80"
            title="Inquiry"
            description="Send us a message and our team will get back to you."
            submitLabel="Submit"
            fields={contactFields}
          />
        </div>
      </section>

      <section className="bg-background-100 pb-16 md:pb-24">
        <div className="site-container">
          <div className="overflow-hidden rounded-card border border-background-200 bg-background-50">
            <iframe
              title={settings.address}
              src={settings.mapEmbedSrc}
              className="h-[320px] w-full border-0 md:h-[420px]"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </section>
    </>
  );
}