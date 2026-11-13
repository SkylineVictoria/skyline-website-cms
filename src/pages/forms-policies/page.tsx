import DocumentLibrary from "@/components/feature/DocumentLibrary";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";

export default function FormsPoliciesPage() {
  return (
    <>
      <Seo
        title="Forms & Policies | Skyline Institute Of Technology"
        description="Download Skyline Institute Of Technology student forms, policies and procedures — enrolment, credit transfer, refunds, complaints, deferment and more."
        path="/forms-policies"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Forms & Policies", path: "/forms-policies" },
          ]),
        ]}
      />
      <PageHero title="Forms & Policies" breadcrumb="Forms & Policies" />
      <section className="bg-background-50 py-section-sm">
        <div className="site-container">
          <DocumentLibrary />
        </div>
      </section>
    </>
  );
}