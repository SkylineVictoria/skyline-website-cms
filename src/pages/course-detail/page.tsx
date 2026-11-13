import { Link, useParams } from "react-router-dom";
import CourseCard from "@/components/feature/CourseCard";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import HtmlContent from "@/components/feature/HtmlContent";
import CourseFeesIntakes from "@/components/feature/CourseFeesIntakes";
import { usePublicSite } from "@/hooks/publicSiteContext";

export default function CourseDetailPage() {
  const { slug } = useParams();
  const { data, isLive, status } = usePublicSite();
  const course = isLive ? data.courses.find((item) => item.slug === slug) : undefined;
  if (!course) return <><PageHero title={status === "loading" ? "Loading course…" : "Course unavailable"} breadcrumb="Courses" /><div className="site-container py-16"><Link to="/our-courses" className="text-primary-700 underline">Browse courses</Link></div></>;
  const content = data.courseContent?.[course.slug];
  const related = data.courses.filter((item) => item.category === course.category && item.slug !== course.slug).slice(0, 3);
  const facts = [
    ["Qualification code", course.code], ["CRICOS code", course.cricos],
    ["Duration", course.duration], ["Delivery", course.mode],
    ["Theory location", course.theoryLocation], ["Practical location", course.practicalLocation],
  ].filter(([, value]) => value);
  return (
    <>
      <Seo title={course.name} description={course.summary || course.name} path={`/courses/${course.slug}`} image={course.image} />
      <PageHero title={course.name} breadcrumb="Courses" lead={course.category} />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container grid items-start gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-10">
            {course.image ? <img src={course.image} alt={course.imageAlt} className="max-h-[420px] w-full object-cover" /> : null}
            {content?.description || course.summary ? <section><h2 className="mb-4 font-heading text-2xl font-semibold text-ink">Course overview</h2>{content?.description ? <HtmlContent html={content.description} /> : <p className="leading-relaxed text-foreground-700">{course.summary}</p>}</section> : null}
            {course.entry ? <section className="border-t border-background-200 pt-8"><h2 className="mb-4 font-heading text-2xl font-semibold text-ink">Entry requirements</h2><p className="whitespace-pre-line leading-relaxed text-foreground-700">{course.entry}</p></section> : null}
            {content?.sections.map((section, index) => <section key={index} className="border-t border-background-200 pt-8"><h2 className="mb-4 font-heading text-2xl font-semibold text-ink">{section.title}</h2><HtmlContent html={section.body} /></section>)}
            {course.units?.length ? <section className="border-t border-background-200 pt-8"><h2 className="mb-5 font-heading text-2xl font-semibold text-ink">Units of competency</h2><div className="overflow-x-auto"><table className="w-full min-w-[500px] text-left text-sm"><thead className="bg-ink text-white"><tr><th scope="col" className="p-3">Code</th><th scope="col" className="p-3">Unit</th><th scope="col" className="p-3">Type</th></tr></thead><tbody>{course.units.map((unit,index) => <tr key={index} className="border-b border-background-200 even:bg-background-100"><td className="p-3 font-medium">{unit.code}</td><td className="p-3">{unit.name}</td><td className="p-3">{unit.category}</td></tr>)}</tbody></table></div></section> : null}
            {course.attachments?.length ? <section className="border-t border-background-200 pt-8"><h2 className="mb-4 font-heading text-2xl font-semibold text-ink">Course documents</h2><ul className="divide-y divide-background-200">{course.attachments.map(file => <li key={file.id}><a href={file.url} target="_blank" rel="noopener noreferrer" className="block py-4 text-primary-700 underline">{file.name}</a></li>)}</ul></section> : null}
          </div>
          <aside className="border-t-4 border-primary-600 bg-background-100 p-6 lg:sticky lg:top-24">
            <h2 className="font-heading text-2xl font-semibold text-ink">At a glance</h2>
            <dl className="mt-6 divide-y divide-background-300">{facts.map(([label,value]) => <div key={label} className="py-4"><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</dt><dd className="mt-2 text-sm font-medium text-ink">{value}</dd></div>)}</dl>
            <CourseFeesIntakes slug={course.slug} tenantId={data.tenantSite?.tenantId ?? null} />
            <Link to="/enroll-now" className="mt-6 block bg-ink px-5 py-3 text-center font-semibold text-white hover:bg-secondary-800">Apply to study</Link>
            <Link to="/contact" className="mt-3 block border border-ink px-5 py-3 text-center font-semibold text-ink hover:bg-background-50">Book a call</Link>
            {data.settings.admissionsEmail ? <a href={data.settings.admissionsHref} className="mt-6 block break-all text-sm text-primary-700 underline">{data.settings.admissionsEmail}</a> : null}
          </aside>
        </div>
      </section>
      {related.length ? <section className="bg-background-100 py-16"><div className="site-container"><h2 className="font-heading text-3xl font-semibold text-ink">Related courses</h2><div className="mt-8 grid gap-6 md:grid-cols-3">{related.map(item => <CourseCard key={item.slug} course={item} />)}</div></div></section> : null}
    </>
  );
}
