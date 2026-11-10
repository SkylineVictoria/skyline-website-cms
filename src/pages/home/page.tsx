import { useState } from "react";
import { Link } from "react-router-dom";
import Seo from "@/components/feature/Seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

export default function Home() {
  const { data, status, isLive, reload } = usePublicSite();
  const { settings, courses, studentLinks, footer } = data;
  const [query, setQuery] = useState("");
  const published = isLive ? courses : [];
  const filtered = published.filter((course) => [course.name, course.code, course.category].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const heroImage = published.find((course) => course.image)?.image;

  return (
    <>
      <Seo title={settings.name} description={settings.footerIntro || footer.about} path="/" />
      <section className="relative overflow-hidden bg-[#102b46] text-white">
        {heroImage ? <img src={heroImage} alt="" fetchPriority="high" className="absolute inset-0 h-full w-full object-cover object-center opacity-25" /> : null}
        <div className="absolute inset-0 bg-gradient-to-r from-[#102b46] via-[#102b46]/80 to-transparent" />
        <div className="site-container relative py-16 md:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Study with us</p>
          <h1 className="mt-5 max-w-3xl font-heading text-4xl font-semibold leading-[1.12] tracking-tight md:text-6xl">{settings.name}</h1>
          {isLive && settings.footerIntro ? <p className="mt-6 max-w-2xl text-base leading-relaxed text-white/80 md:text-lg">{settings.footerIntro}</p> : null}
          <a href="#courses" className="mt-8 inline-flex items-center gap-5 bg-white px-6 py-3.5 font-semibold text-[#102b46] hover:bg-background-100">Find your course <span aria-hidden="true">→</span></a>
          {isLive ? <div className="mt-12 flex flex-wrap gap-x-8 gap-y-2 border-t border-white/20 pt-5 text-xs tracking-wide text-white/70">
            {settings.rto ? <span>RTO {settings.rto}</span> : null}
            {settings.cricos ? <span>CRICOS {settings.cricos}</span> : null}
          </div> : null}
        </div>
      </section>

      <section id="courses" className="scroll-mt-24 bg-[#f5f6f7] py-16 md:py-24" aria-labelledby="courses-heading">
        <div className="site-container">
          <div className="grid gap-8 border-b border-background-300 pb-8 md:grid-cols-2 md:items-end">
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">Our courses</p><h2 id="courses-heading" className="mt-3 font-heading text-3xl font-semibold tracking-tight text-[#102b46] md:text-5xl">Explore your study options</h2></div>
            <div><label htmlFor="course-search" className="mb-2 block text-sm font-medium text-foreground-700">Search by course, code or study area</label><input id="course-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a course" className="w-full border border-background-300 bg-white px-4 py-3.5 text-base outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100" /></div>
          </div>
          {!isLive ? <div className="py-12 text-foreground-600" role="status">{status === "loading" ? "Loading courses…" : <><p>Course information is currently unavailable.</p><button onClick={reload} className="mt-3 underline">Try again</button></>}</div> : <>
            <p className="mt-6 text-sm text-foreground-600" aria-live="polite">{filtered.length} {filtered.length === 1 ? "course" : "courses"}</p>
            <div className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map((course) => <article key={course.slug} className="group flex flex-col bg-white">
                {course.image ? <Link to={`/courses/${course.slug}`} tabIndex={-1} aria-hidden="true" className="block overflow-hidden"><img src={course.image} alt="" loading="lazy" className="aspect-[16/9] w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105" /></Link> : null}
                <div className="flex flex-1 flex-col border border-background-200 p-6">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary-700">{course.category}</p>
                  <h3 className="mt-3 font-heading text-xl font-semibold leading-snug text-[#102b46]"><Link to={`/courses/${course.slug}`} className="hover:underline">{course.name}</Link></h3>
                  {course.summary ? <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground-600">{course.summary}</p> : null}
                  <div className="mt-auto pt-6"><div className="flex flex-wrap gap-3 border-t border-background-200 pt-4 text-xs text-foreground-600">{course.duration ? <span>{course.duration}</span> : null}{course.mode ? <span>{course.mode}</span> : null}</div><Link to={`/courses/${course.slug}`} className="mt-4 inline-flex items-center gap-3 text-sm font-semibold text-[#102b46]">Course details <span aria-hidden="true">→</span></Link></div>
                </div>
              </article>)}
            </div>
            {!filtered.length ? <p className="py-12 text-foreground-600">{query ? "No courses match your search. Try another course name or study area." : "No courses are currently published."}</p> : null}
          </>}
        </div>
      </section>

      {isLive && studentLinks.length > 0 ? <section className="bg-white py-16 md:py-20">
        <div className="site-container grid gap-10 lg:grid-cols-[1fr_2fr]">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">Student resources</p><h2 className="mt-3 font-heading text-3xl font-semibold text-[#102b46]">Information and support</h2></div>
          <div className="grid gap-x-8 sm:grid-cols-2">{studentLinks.map((link) => <a key={link.to + link.label} href={link.to} className="flex items-center justify-between gap-4 border-b border-background-300 py-5 text-base font-medium text-[#102b46] hover:text-primary-700">{link.label}<span aria-hidden="true">↗</span></a>)}</div>
        </div>
      </section> : null}
    </>
  );
}
