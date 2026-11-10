import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";
import { EMPLOYMENT_TYPE_LABEL, jobPath } from "@/lib/jobs";
import { listOpenJobs, type Job } from "@/lib/jobsApi";

/** The open jobs posted from the CMS (Agencies > Staff > Job posts). Each one opens its page with the Apply now button. */
export default function CareersPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    listOpenJobs().then((rows) => { if (!cancelled) setJobs(rows); }, (e) => { if (!cancelled) { setJobs([]); setError(e instanceof Error ? e.message : "The jobs could not be loaded."); } });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Seo title="Careers | Skyline Institute Of Technology" description="Current job openings at Skyline Institute Of Technology. Apply online with your resume and cover letter." path="/careers"
        jsonLd={[breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Careers", path: "/careers" }])]} />
      <PageHero title="Careers" breadcrumb="Careers" lead="Join the Skyline team. Current openings are listed below; apply online with your resume and cover letter." />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container">
          {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
          {jobs === null ? <p className="text-sm text-foreground-600" role="status">Loading jobs…</p> : null}
          {jobs && jobs.length === 0 && !error ? (
            <div className="rounded-sm border border-background-200 bg-background-100 p-8 text-center">
              <p className="font-heading text-lg font-bold text-[#102b46]">No openings right now</p>
              <p className="mt-2 text-sm text-foreground-600">Check back soon, or <Link to="/contact" className="font-semibold text-primary-700 hover:underline">contact us</Link> to register your interest.</p>
            </div>
          ) : null}
          {jobs && jobs.length ? (
            <ul className="grid gap-5 md:grid-cols-2" data-testid="job-list">
              {jobs.map((job) => (
                <li key={job.id} className="flex flex-col rounded-sm border border-background-200 bg-background-50 p-6 ">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary-800">{EMPLOYMENT_TYPE_LABEL[job.employmentType]}</span>
                    <span className="text-xs text-foreground-500">Posted {new Date(job.postedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}</span>
                  </div>
                  <h2 className="mt-3 font-heading text-xl font-bold text-[#102b46]"><Link to={jobPath(job.id)} className="hover:text-primary-700">{job.title}</Link></h2>
                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-foreground-700">
                    <div className="flex items-center gap-1.5"><i className="ri-map-pin-line text-primary-600" aria-hidden="true" /><dt className="sr-only">Location</dt><dd>{job.location}</dd></div>
                    {job.salary ? <div className="flex items-center gap-1.5"><i className="ri-money-dollar-circle-line text-primary-600" aria-hidden="true" /><dt className="sr-only">Salary</dt><dd>{job.salary}</dd></div> : null}
                  </dl>
                  <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground-600">{job.description}</p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link to={`${jobPath(job.id)}/apply`} className="rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50 hover:bg-primary-600">Apply now</Link>
                    <Link to={jobPath(job.id)} className="rounded-md border border-background-300 px-4 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100">View details</Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </>
  );
}
