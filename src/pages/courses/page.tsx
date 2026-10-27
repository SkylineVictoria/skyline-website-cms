import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import CourseCard from "@/components/feature/CourseCard";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import Reveal from "@/components/base/Reveal";
import { breadcrumbSchema, courseListSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

export default function CoursesPage() {
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [activeCategory, setActiveCategory] = useState("All");
  const { data } = usePublicSite();
  const courses = data.courses;
  const visibleCourseCategories = data.courseCategories;

  useEffect(() => {
    setQuery(urlQuery);
    if (urlQuery.trim()) setActiveCategory("All");
  }, [urlQuery]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return courses.filter((course) => {
      const matchesCategory = activeCategory === "All" || course.category === activeCategory;
      const matchesTerm =
        !term ||
        course.name.toLowerCase().includes(term) ||
        (course.code ?? "").toLowerCase().includes(term) ||
        (course.cricos ?? "").toLowerCase().includes(term) ||
        course.category.toLowerCase().includes(term) ||
        (course.summary ?? "").toLowerCase().includes(term);
      return matchesCategory && matchesTerm;
    });
  }, [query, activeCategory, courses]);

  return (
    <>
      <Seo
        title="Our Courses | Skyline Institute Of Technology"
        description="Explore nationally recognised certificate and diploma courses at Skyline Institute Of Technology in Melbourne — automotive, building and construction, civil construction design, furnishing, glazing and business."
        path="/our-courses"
        jsonLd={[
          courseListSchema(courses),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Our Courses", path: "/our-courses" },
          ]),
        ]}
      />
      <PageHero
        title="Our Courses"
        breadcrumb="Our Courses"
        lead="Explore nationally recognised qualifications across automotive, construction, civil construction design, furnishing and business — delivered face-to-face by industry experts."
      />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container">
          <Reveal>
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {["All", ...visibleCourseCategories].map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setActiveCategory(category)}
                    className={`cursor-pointer whitespace-nowrap rounded-full border px-4 py-2 text-xs font-medium transition-colors ${
                      activeCategory === category
                        ? "border-primary-500 bg-primary-500 text-background-50"
                        : "border-background-300 bg-background-50 text-foreground-700 hover:border-primary-300"
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>
              <div className="flex w-full items-center gap-2 rounded-md border border-background-300 bg-background-50 px-4 py-2.5 lg:w-80">
                <i className="ri-search-line text-lg text-foreground-500" aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search courses"
                  aria-label="Search courses"
                  className="w-full border-none bg-transparent text-sm text-foreground-950 placeholder:text-foreground-400 focus:outline-none"
                />
              </div>
            </div>
          </Reveal>

          <Reveal>
            <p className="mt-6 text-sm text-foreground-500">
              Showing {filtered.length} of {courses.length} courses
            </p>
          </Reveal>

          {filtered.length > 0 ? (
            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-product-shop>
              {filtered.map((course, index) => (
                <Reveal key={course.slug} delay={(index % 3) * 80}>
                  <CourseCard course={course} />
                </Reveal>
              ))}
            </div>
          ) : (
            <div className="mt-10 rounded-card border border-background-200 bg-background-50 p-10 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-secondary-100 text-secondary-500">
                <i className="ri-search-eye-line text-2xl" aria-hidden="true" />
              </span>
              <h2 className="mt-4 font-heading text-lg font-semibold text-foreground-950">No courses found</h2>
              <p className="mt-2 text-sm text-foreground-600">
                Try a different search term or category, or contact us for the full list of programs.
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}