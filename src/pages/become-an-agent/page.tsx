import ApplicationForm from "@/components/feature/ApplicationForm";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { agentSections } from "@/data/applicationForms";
import { breadcrumbSchema } from "@/data/seo";

const ethicsUrl =
  "https://internationaleducation.gov.au/News/Latest-News/Documents/Australian%20International%20Education%20and%20Training%20-%20Agent%20Code%20of%20Ethics.pdf";

const declaration = [
  "I am interested in representing INDOPACIFIC GLOBAL PTY LTD T/A SKYLINE INSTITUTE OF TECHNOLOGY (SLIT) as an education agent and I agree to do so in an honest and professional manner. I agree to:",
  "Regularly monitor policies and changes to the policies as reported on the Department of Home Affairs (DHA) website.",
  "Regularly monitor policies and regulations and changes to these policies and regulations as reported on the www.education.gov.au website.",
  "I have read the National Code 2018 and agree to adhere to the relevant Standards.",
  "I declare and take all reasonable steps to avoid conflicts of interest with my duties as an education agent of SLIT.",
  "I declare that I have read AUSTRALIAN INTERNATIONAL EDUCATION AND TRAINING Agent Code of Ethics attached with this application.",
];

export default function BecomeAnAgentPage() {
  return (
    <>
      <Seo
        title="Become an Agent | Skyline Institute Of Technology"
        description="Apply to become an education agent for Skyline Institute Of Technology. Complete the agent application form and our partnerships team will be in touch."
        path="/become-an-agent"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Become an Agent", path: "/become-an-agent" },
          ]),
        ]}
      />
      <PageHero title="Become an Agent" breadcrumb="Become an Agent" />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-4">
            <h2 className="font-heading text-xl font-bold text-ink md:text-2xl">AGENT APPLICATION FORM</h2>
            <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">
              Complete the agent application form and our partnerships team will be in touch.
            </p>

            <div className="mt-8 rounded-sm border border-background-200 bg-background-50 p-6">
              <h3 className="font-heading text-base font-semibold text-ink">Agent Declaration</h3>
              <ul className="mt-4 space-y-3">
                {declaration.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm leading-relaxed text-foreground-700">
                    <i className="ri-checkbox-circle-line mt-0.5 text-base text-primary-600" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <a
                href={ethicsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-primary-600 underline underline-offset-2 hover:text-primary-700"
              >
                <i className="ri-file-pdf-2-line text-base" aria-hidden="true" />
                Read the Australian International Education & Training Agent Code of Ethics (PDF)
              </a>
            </div>
          </div>

          <div className="lg:col-span-8">
            <ApplicationForm
              formId="skyline-agent-form"
              submitAddr="https://readdy.ai/api/form/db31t96oc082o2i1kl90"
              title="AGENT APPLICATION FORM"
              sections={agentSections}
              submitLabel="Submit"
              beforeSubmit={
                <p className="text-xs leading-relaxed text-foreground-600">
                  By submitting this application you confirm you have read and understood the
                  <a
                    href={ethicsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 font-semibold text-primary-600 underline underline-offset-2 hover:text-primary-700"
                  >
                    Australian International Education & Training Agent Code of Ethics (PDF)
                  </a>
                  .
                </p>
              }
            />
          </div>
        </div>
      </section>
    </>
  );
}