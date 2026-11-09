import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";
import { EMPLOYMENT_TYPE_LABEL, jobApplyPath } from "@/lib/jobs";
import { getJob, type Job } from "@/lib/jobsApi";

/** One job post: the full description and the Apply now button (a closed job says so instead). */
export default function CareerDetailPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    getJob(id).then((row) => { if (!cancelled) setJob(row); }, (e) => { if (!cancelled) { setJob(null); setError(e instanceof Error ? e.message : "The job could not be loaded."); } });
    return () => { cancelled = true; };
  }, [id]);

  const title = job?.title ?? "Job";
  return (
    <>
      <Seo title={`${title} | Careers | Skyline Institute Of Technology`} description={job ? `${EMPLOYMENT_TYPE_LABEL[job.employmentType]} · ${job.location}. ${job.description.slice(0, 150)}` : "Job opening at Skyline Institute Of Technology."} path={`/careers/${id}`}
        jsonLd={[breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Careers", path: "/careers" }, { name: title, path: `/careers/${id}` }])]} />
      <PageHero title={title} breadcrumb="Careers" lead={job ? `${EMPLOYMENT_TYPE_LABEL[job.employmentType]} · ${job.location}${job.salary ? ` · ${job.salary}` : ""}` : undefined} />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-8">
            <p className="text-sm"><Link to="/careers" className="font-semibold text-primary-700 hover:underline">&larr; All openings</Link></p>
            {error ? <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
            {job === undefined ? <p className="mt-4 text-sm text-foreground-600" role="status">Loading…</p> : null}
            {job === null && !error ? <p className="mt-4 text-sm text-foreground-700">This job post does not exist or has been removed.</p> : null}
            {job ? (
              <article className="mt-4">
                <h2 className="font-heading text-xl font-bold text-foreground-950">About the role</h2>
                <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground-700 md:text-base">{job.description}</div>
              </article>
            ) : null}
          </div>
          <aside className="lg:col-span-4">
            {job ? (
              <div className="rounded-card border border-background-200 bg-background-100 p-6">
                <dl className="space-y-3 text-sm">
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Employment type</dt><dd className="text-foreground-900">{EMPLOYMENT_TYPE_LABEL[job.employmentType]}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Location</dt><dd className="text-foreground-900">{job.location}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Salary</dt><dd className="text-foreground-900">{job.salary || "Not stated"}</dd></div>
                  {job.department ? <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Department</dt><dd className="text-foreground-900">{job.department}</dd></div> : null}
                  {job.vacancies ? <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Vacancies</dt><dd className="text-foreground-900">{job.vacancies}</dd></div> : null}
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Posted</dt><dd className="text-foreground-900">{new Date(job.postedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</dd></div>
                </dl>
                {job.status === "open" ? (
                  <Link to={jobApplyPath(job.id)} className="mt-5 block rounded-md bg-primary-500 px-4 py-2.5 text-center text-sm font-semibold text-background-50 hover:bg-primary-600" data-testid="job-apply">Apply now</Link>
                ) : (
                  <p className="mt-5 rounded-md bg-background-200 px-3 py-2 text-center text-sm font-semibold text-foreground-700">Applications for this role have closed.</p>
                )}
                <p className="mt-3 text-xs text-foreground-500">You apply with a resume and a cover letter. We create your account first, so if you are hired you can complete your staff registration with the same login.</p>
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </>
  );
}
