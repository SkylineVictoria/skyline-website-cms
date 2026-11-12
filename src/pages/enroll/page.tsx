import { Link } from "react-router-dom";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";

export default function EnrollPage() {
  return (
    <>
      <Seo
        title="Enrolment | Skyline Institute Of Technology"
        description="How to apply to Skyline Institute Of Technology — international students enrol themselves in a few minutes, and education agents register their agency for the Agency Portal."
        path="/enroll-now"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Enrol Now", path: "/enroll-now" },
          ]),
        ]}
      />
      <PageHero
        title="Enrolment"
        lead="Choose the path that matches you — apply as a student, or submit applications on behalf of students as an education agent."
      />

      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          <article className="flex flex-col rounded-sm border border-background-200 bg-background-50 p-6 md:p-8">
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-100 text-xl text-primary-700">
              <i className="ri-user-3-line" aria-hidden="true" />
            </span>
            <h2 className="mt-4 font-heading text-xl font-bold text-[#102b46]">I&rsquo;m a student</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-foreground-600">
              Create your student account in a few minutes, then complete the international student application yourself,
              upload your documents and track your enrolment in your own student portal.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                to="/login?mode=enroll&as=student"
                className="inline-flex w-fit items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
              >
                Enrol as a student
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
              <Link
                to="/login"
                className="inline-flex w-fit items-center gap-2 whitespace-nowrap rounded-md border border-primary-300 bg-primary-50 px-5 py-2.5 text-sm font-semibold text-primary-700 transition-colors hover:border-primary-400 hover:bg-primary-100"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-3 text-xs text-foreground-500">Have an agent? Ask them for their referral code so your application stays with them.</p>
          </article>

          <article className="flex flex-col rounded-sm border border-background-200 bg-background-50 p-6 md:p-8">
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-100 text-xl text-accent-900">
              <i className="ri-briefcase-4-line" aria-hidden="true" />
            </span>
            <h2 className="mt-4 font-heading text-xl font-bold text-[#102b46]">I&rsquo;m an education agent</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-foreground-600">
              Submit and manage international student applications on behalf of students, upload supporting documents,
              and track admissions progress in the Agency Portal.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                to="/contact"
                className="inline-flex w-fit items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
              >
                Contact us to register
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
              <Link
                to="/login"
                className="inline-flex w-fit items-center gap-2 whitespace-nowrap rounded-md border border-primary-300 bg-primary-50 px-5 py-2.5 text-sm font-semibold text-primary-700 transition-colors hover:border-primary-400 hover:bg-primary-100"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-3 text-xs text-foreground-500">
              Agencies are registered by SLIT. Contact us, or send the full application form:{" "}
              <Link to="/become-an-agent" className="font-medium text-primary-700 hover:text-primary-800">
                Become an agent
              </Link>
              .
            </p>
          </article>
        </div>
      </section>
    </>
  );
}