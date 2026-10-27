import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import CourseCard from "@/components/feature/CourseCard";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import Reveal from "@/components/base/Reveal";
import { getCourseDetail } from "@/data/courseDetails";
import { breadcrumbSchema, courseSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

type Detail = { label: string; value: string; icon: string; wide?: boolean };

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-3 font-heading text-lg font-bold text-foreground-950 md:text-xl">
      <span className="h-5 w-1 rounded-full bg-primary-500" aria-hidden="true" />
      {children}
    </h2>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-3">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 text-sm leading-relaxed text-foreground-700">
          <i className="ri-checkbox-blank-circle-fill mt-1.5 text-[6px] text-primary-500" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function CourseDetailPage() {
  const { slug } = useParams();
  const { data } = usePublicSite();
  const courses = data.courses;
  const course = courses.find((item) => item.slug === slug);

  if (!course) {
    return (
      <>
        <Seo
          title="Course not found"
          description="The course you are looking for could not be found. Please check the URL or browse the full list of programs."
          path="/courses/not-found"
        />
        <PageHero title="Course not found" breadcrumb="Courses" />
        <section className="bg-background-50 py-16">
          <div className="site-container">
            <div className="mx-auto max-w-xl rounded-card border border-background-200 bg-background-50 p-10 text-center">
              <h2 className="font-heading text-lg font-semibold text-foreground-950">We couldn't find that course</h2>
              <p className="mt-2 text-sm text-foreground-600">
                The course may have moved. Browse the full list of programs instead.
              </p>
              <Link
                to="/our-courses"
                className="mt-6 inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600"
              >
                View all courses
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  const detail = getCourseDetail(course.slug);
  // Units are authoritative in cms_course_units. An intentionally empty list
  // remains empty rather than resurrecting a hard-coded list.
  const units: [string, string, string][] = (course.units ?? []).map(
    (unit) => [unit.code, unit.name, unit.category] as [string, string, string],
  );
  const coreCount = units.filter((unit) => unit[2].toLowerCase().includes("core")).length;
  const electiveCount = units.length - coreCount;
  const related = courses.filter((item) => item.category === course.category && item.slug !== course.slug).slice(0, 3);

  const locationText = course.theoryLocation
    ? course.practicalLocation
      ? `Theory: ${course.theoryLocation} · Practical: ${course.practicalLocation}`
      : `Theory: ${course.theoryLocation}`
    : "";

  const details: Detail[] = [
    course.cricos ? { label: "CRICOS Course Code", value: course.cricos, icon: "ri-file-list-3-line" } : null,
    course.mode ? { label: "Mode of Delivery", value: course.mode, icon: "ri-computer-line" } : null,
    course.duration ? { label: "Course Duration", value: course.duration, icon: "ri-time-line" } : null,
    course.entry ? { label: "Entry Requirements", value: course.entry, icon: "ri-user-received-line" } : null,
    locationText ? { label: "Location", value: locationText, icon: "ri-map-pin-2-line", wide: true } : null,
  ].filter(Boolean) as Detail[];

  return (
    <>
      <Seo
        title={course.name}
        description={
          course.summary ??
          `Study ${course.name} at Skyline Institute Of Technology in Melbourne. CRICOS ${course.cricos ?? "04114B"}.`
        }
        path={`/courses/${course.slug}`}
        image={course.image}
        jsonLd={[
          courseSchema(course, detail),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Our Courses", path: "/our-courses" },
            { name: course.name, path: `/courses/${course.slug}` },
          ]),
        ]}
      />
      <PageHero title={course.name} breadcrumb="Courses" />

      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-8">
            <Reveal>
              <div className="overflow-hidden rounded-card border border-background-200 bg-background-100">
                {course.image ? (
                  <img src={course.image} alt={course.imageAlt} className="h-[280px] w-full object-top md:h-[420px]" />
                ) : (
                  <span className="flex h-[280px] w-full items-center justify-center bg-secondary-100 text-secondary-500 md:h-[420px]">
                    <i className="ri-graduation-cap-line text-5xl" aria-hidden="true" />
                  </span>
                )}
              </div>
            </Reveal>

            {details.length > 0 ? (
              <Reveal className="mt-8">
                <SectionTitle>Course Details</SectionTitle>
                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {details.map((item) => (
                    <div
                      key={item.label}
                      className={`flex items-start gap-4 rounded-card border border-background-200 bg-background-50 p-5 transition-colors hover:border-primary-300 ${
                        item.wide ? "sm:col-span-2" : ""
                      }`}
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-primary-100 text-primary-700">
                        <i className={`${item.icon} text-xl`} aria-hidden="true" />
                      </span>
                      <div>
                        <p className="font-label text-xs font-semibold uppercase tracking-wide text-foreground-500">
                          {item.label}
                        </p>
                        <p className="mt-1 text-sm font-medium leading-relaxed text-foreground-900">{item.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Reveal>
            ) : null}

            {detail ? (
              <>
                <Reveal className="mt-10">
                  <SectionTitle>Course Description</SectionTitle>
                  <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">
                    {detail.overview || course.summary}
                  </p>
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Training Package Requirements</SectionTitle>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {detail.trainingPackage.map((item) => (
                      <span
                        key={item}
                        className="inline-flex items-center gap-2 rounded-full border border-background-300 bg-background-50 px-4 py-2 text-xs font-semibold text-foreground-800"
                      >
                        <i className="ri-checkbox-circle-line text-primary-600" aria-hidden="true" />
                        {item}
                      </span>
                    ))}
                  </div>
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Mode of Delivery</SectionTitle>
                  <BulletList items={detail.delivery} />
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Qualifications</SectionTitle>
                  <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">{detail.qualification}</p>
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Entry Requirements</SectionTitle>
                  <BulletList items={detail.entryRequirements} />
                </Reveal>

                {units.length > 0 ? (
                  <Reveal className="mt-10">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <SectionTitle>Units of Competency</SectionTitle>
                      <p className="text-xs font-medium text-foreground-500">
                        {coreCount} Core · {electiveCount} Elective · {units.length} Total
                      </p>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-card border border-background-200">
                      <div className="max-h-[560px] overflow-x-auto overflow-y-auto">
                        <table className="w-full min-w-[560px] border-collapse text-left">
                          <thead className="sticky top-0 z-[1] bg-background-100">
                            <tr>
                              <th className="px-4 py-3 font-label text-xs font-bold uppercase tracking-wide text-foreground-700">
                                Unit Code
                              </th>
                              <th className="px-4 py-3 font-label text-xs font-bold uppercase tracking-wide text-foreground-700">
                                Unit Name
                              </th>
                              <th className="px-4 py-3 font-label text-xs font-bold uppercase tracking-wide text-foreground-700">
                                Core / Elective
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {units.map((unit, index) => {
                              const isCore = unit[2].toLowerCase().includes("core");
                              return (
                                <tr
                                  key={`${unit[0]}-${index}`}
                                  className={index % 2 === 0 ? "bg-background-50" : "bg-background-100/60"}
                                >
                                  <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-foreground-950">
                                    {unit[0]}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-foreground-700">{unit[1]}</td>
                                  <td className="whitespace-nowrap px-4 py-3">
                                    <span
                                      className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${
                                        isCore
                                          ? "bg-primary-100 text-primary-700"
                                          : "bg-secondary-100 text-secondary-900"
                                      }`}
                                    >
                                      {unit[2]}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {detail.disclaimer ? (
                      <p className="mt-3 text-xs italic leading-relaxed text-foreground-500">
                        Note: An asterisk (*) against a unit code indicates that a prerequisite requirement must be met.
                      </p>
                    ) : null}
                  </Reveal>
                ) : (
                  <Reveal className="mt-10">
                    <SectionTitle>Units of Competency</SectionTitle>
                    <div className="mt-4 rounded-card border border-dashed border-background-300 bg-background-50 px-6 py-10 text-center">
                      <i className="ri-list-check-2 text-2xl text-foreground-400" aria-hidden="true" />
                      <p className="mt-2 text-sm text-foreground-600">
                        Units of competency for this course are being finalised. Contact admissions for the
                        current unit list.
                      </p>
                    </div>
                  </Reveal>
                )}

                {course.attachments?.length ? (
                  <Reveal className="mt-10">
                    <SectionTitle>Course Downloads</SectionTitle>
                    <ul className="mt-4 divide-y divide-background-200 overflow-hidden rounded-card border border-background-200">
                      {course.attachments.map((attachment) => (
                        <li key={attachment.id}>
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center justify-between gap-4 px-4 py-3 text-sm font-medium text-primary-700 hover:bg-primary-50 hover:underline"
                          >
                            <span className="flex min-w-0 items-center gap-3"><i className="ri-file-pdf-2-line text-lg" aria-hidden="true" /><span className="truncate">{attachment.name}</span></span>
                            <i className="ri-download-2-line shrink-0" aria-hidden="true" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </Reveal>
                ) : null}

                <Reveal className="mt-10">
                  <SectionTitle>Pathways &amp; Careers</SectionTitle>
                  <p className="mt-4 font-label text-xs font-bold uppercase tracking-wide text-foreground-500">
                    Career Outcomes
                  </p>
                  <BulletList items={detail.careers} />
                  {detail.furtherStudy ? (
                    <div className="mt-4 rounded-card border border-accent-200 bg-accent-50 p-5">
                      <p className="font-label text-xs font-bold uppercase tracking-wide text-accent-900">
                        Further Study
                      </p>
                      <p className="mt-2 text-sm leading-relaxed text-accent-900/90">{detail.furtherStudy}</p>
                    </div>
                  ) : null}
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Course Duration</SectionTitle>
                  <BulletList items={detail.durationNotes} />
                </Reveal>

                <Reveal className="mt-10">
                  <SectionTitle>Fees</SectionTitle>
                  {detail.fee?.policyOnly ? (
                    <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">
                      Please see the SLIT fee and charge policy for the current fees applicable to this qualification.
                    </p>
                  ) : detail.fee ? (
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                      {detail.fee.total ? (
                        <div className="rounded-card border border-primary-200 bg-primary-50 p-5">
                          <p className="font-label text-xs font-semibold uppercase tracking-wide text-primary-700">
                            Total Course Cost
                          </p>
                          <p className="mt-1 font-heading text-xl font-bold text-foreground-950">{detail.fee.total}</p>
                        </div>
                      ) : null}
                      {detail.fee.tuition ? (
                        <div className="rounded-card border border-background-200 bg-background-50 p-5">
                          <p className="font-label text-xs font-semibold uppercase tracking-wide text-foreground-500">
                            Tuition
                          </p>
                          <p className="mt-1 font-heading text-xl font-bold text-foreground-950">{detail.fee.tuition}</p>
                        </div>
                      ) : null}
                      {detail.fee.nonTuition ? (
                        <div className="rounded-card border border-background-200 bg-background-50 p-5">
                          <p className="font-label text-xs font-semibold uppercase tracking-wide text-foreground-500">
                            Non-Tuition
                          </p>
                          <p className="mt-1 font-heading text-xl font-bold text-foreground-950">
                            {detail.fee.nonTuition}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {detail.fee?.note ? (
                    <p className="mt-3 text-xs italic leading-relaxed text-foreground-500">{detail.fee.note}</p>
                  ) : null}
                </Reveal>

                <Reveal className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div className="rounded-card border border-background-200 bg-background-50 p-5">
                    <h3 className="font-heading text-sm font-bold text-foreground-950">Credit Transfer</h3>
                    <p className="mt-2 text-sm leading-relaxed text-foreground-700">{detail.creditTransfer}</p>
                  </div>
                  <div className="rounded-card border border-background-200 bg-background-50 p-5">
                    <h3 className="font-heading text-sm font-bold text-foreground-950">
                      Recognition of Prior Learning (RPL)
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-foreground-700">{detail.rpl}</p>
                  </div>
                </Reveal>

                {detail.disclaimer ? (
                  <Reveal className="mt-10">
                    <div className="rounded-card border border-background-200 bg-background-100 p-5">
                      <h3 className="font-heading text-sm font-bold text-foreground-950">Disclaimer</h3>
                      <p className="mt-2 text-xs leading-relaxed text-foreground-600">{detail.disclaimer}</p>
                    </div>
                  </Reveal>
                ) : null}

                <Reveal className="mt-10">
                  <div className="rounded-card border border-accent-200 bg-accent-50 p-6">
                    <h3 className="font-heading text-base font-semibold text-accent-900">How to Apply</h3>
                    <p className="mt-2 text-sm leading-relaxed text-accent-900/90">
                      If you would like to enrol in this course, please apply online or contact us on (03) 9125 1661.
                    </p>
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                      <Link
                        to="/enroll-now"
                        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
                      >
                        Apply Online
                        <i className="ri-arrow-right-line" aria-hidden="true" />
                      </Link>
                      <Link
                        to="/contact"
                        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-accent-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-accent-900 transition-colors hover:bg-accent-100"
                      >
                        Contact Us
                      </Link>
                    </div>
                  </div>
                </Reveal>
              </>
            ) : (
              <Reveal className="mt-10">
                <SectionTitle>Course Information</SectionTitle>
                <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">
                  {course.summary ?? "Contact our admissions team for the full course outline, intake dates and fees."}
                </p>
              </Reveal>
            )}
          </div>

          <aside className="lg:col-span-4">
            <Reveal className="sticky top-28">
              <div className="rounded-card border border-background-200 bg-background-50 p-6">
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-secondary-100 px-3 py-1 font-label text-[11px] font-semibold uppercase tracking-wide text-secondary-900">
                  {course.category}
                </span>
                <h2 className="mt-4 font-heading text-lg font-semibold leading-snug text-foreground-950">
                  {course.name}
                </h2>

                <dl className="mt-6 space-y-4 border-t border-background-200 pt-6">
                  {course.cricos ? (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-sm text-foreground-500">CRICOS code</dt>
                      <dd className="text-sm font-semibold text-foreground-950">{course.cricos}</dd>
                    </div>
                  ) : null}
                  {course.code ? (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-sm text-foreground-500">Qualification code</dt>
                      <dd className="text-sm font-semibold text-foreground-950">{course.code}</dd>
                    </div>
                  ) : null}
                  {course.duration ? (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-sm text-foreground-500">Duration</dt>
                      <dd className="text-sm font-semibold text-foreground-950">{course.duration}</dd>
                    </div>
                  ) : null}
                  {units.length > 0 ? (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-sm text-foreground-500">Units</dt>
                      <dd className="text-sm font-semibold text-foreground-950">{units.length}</dd>
                    </div>
                  ) : null}
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-sm text-foreground-500">Training package</dt>
                    <dd className="text-right text-sm font-medium text-foreground-800">{course.category}</dd>
                  </div>
                </dl>

                <div className="mt-6 border-t border-background-200 pt-6">
                  <p className="font-label text-xs font-semibold uppercase tracking-wider text-foreground-500">
                    Enquiries
                  </p>
                  <a
                    href="mailto:admissions@slit.edu.au"
                    className="mt-2 flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700"
                  >
                    <i className="ri-mail-line" aria-hidden="true" />
                    admissions@slit.edu.au
                  </a>
                  <a
                    href="tel:0391251661"
                    className="mt-2 flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700"
                  >
                    <i className="ri-phone-line" aria-hidden="true" />
                    03 9125 1661
                  </a>
                </div>

                <Link
                  to="/enroll-now"
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
                >
                  Enroll Now
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </Link>
              </div>
            </Reveal>
          </aside>
        </div>
      </section>

      {related.length > 0 ? (
        <section className="bg-background-100 py-14 md:py-16">
          <div className="site-container">
            <Reveal>
              <h2 className="font-heading text-xl font-bold text-foreground-950 md:text-2xl">Related courses</h2>
            </Reveal>
            <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((item, index) => (
                <Reveal key={item.slug} delay={index * 80}>
                  <CourseCard course={item} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
