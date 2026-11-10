import { useState } from "react";
import { Link } from "react-router-dom";
import Reveal from "@/components/base/Reveal";
import CoursesCarousel from "@/components/feature/CoursesCarousel";
import LatestNews from "@/components/feature/LatestNews";
import Seo from "@/components/feature/Seo";
import { defaultOgImage, siteDescription } from "@/data/seo";
import { HOME_COURSE_LIMIT } from "@/config/cmsLimits";
import { usePublicSite } from "@/hooks/publicSiteContext";


const staticHeroImages = [
  "https://static.readdy.ai/image/7fe129f8d7ac12cdc97a659d50dae110/10672c8cbcfc600c6073bd57b6040721.jpeg",
  "https://readdy.ai/api/search-image?query=Modern%20Australian%20training%20campus%20courtyard%20with%20diverse%20international%20students%20walking%20and%20talking%2C%20warm%20afternoon%20light%2C%20clean%20architectural%20lines%2C%20editorial%20photography%20with%20soft%20shadows&width=1920&height=1080&seq=skyline-hero-02&orientation=landscape",
  "https://readdy.ai/api/search-image?query=Bright%20modern%20technical%20workshop%20classroom%20with%20students%20learning%20hands-on%20skills%20and%20an%20instructor%20guiding%20them%2C%20warm%20neutral%20tones%2C%20clean%20professional%20editorial%20photography&width=1920&height=1080&seq=skyline-hero-03&orientation=landscape",
];

const staticAboutImage = "https://slit.edu.au/wp-content/uploads/2023/05/about_img_02.png";

export default function Home() {
  const [slide, setSlide] = useState(0);
  const { data, status } = usePublicSite();
  const { featuredCourses, courses, settings } = data;
  const homeCourses = [...featuredCourses, ...courses.filter((course) => !featuredCourses.some((featured) => featured.slug === course.slug))].slice(0, HOME_COURSE_LIMIT);
  const coursesLoading = status === "loading";

  // Hero and about imagery are CMS-managed (Website Settings → Homepage images)
  // and fall back to the shipped defaults until the CMS provides values.
  const heroImages = settings.homeHeroImages.length ? settings.homeHeroImages : staticHeroImages;
  const aboutImage = settings.homeAboutImage || staticAboutImage;

  return (
    <>
      <Seo
        title="Skyline Institute Of Technology | Melbourne RTO & CRICOS Courses"
        description={siteDescription}
        path="/"
        image={defaultOgImage}
      />
      <section className="bg-accent-950 text-white">
        <div className="site-container grid items-center gap-9 py-12 md:py-16 lg:grid-cols-2 lg:gap-14">
          <div>
            <p className="text-sm font-semibold text-primary-300">Skyline Institute of Technology · Melbourne</p>
            <h1 className="mt-4 max-w-xl font-heading text-4xl font-bold leading-tight tracking-tight md:text-5xl xl:text-6xl">
              Practical training for your next career step
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-background-200 md:text-lg">
              Build hands-on skills through vocational courses in Melbourne.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link to="/our-courses" className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-5 py-3 text-sm font-semibold text-white hover:bg-primary-700">
                Explore courses <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
              <Link to="/contact" className="py-3 text-sm font-semibold text-white underline underline-offset-4 hover:text-primary-300">
                Book a call
              </Link>
            </div>
          </div>
          <div>
            <div className="overflow-hidden rounded-2xl bg-accent-900">
              <img
                src={heroImages[slide] ?? heroImages[0]}
                alt=""
                className="aspect-[4/3] w-full object-cover object-center"
                fetchPriority="high"
              />
            </div>
            {heroImages.length > 1 ? (
              <div className="mt-2 flex justify-center gap-1" aria-label="Homepage photos" role="group">
                {heroImages.map((_, index) => (
                  <button key={index} type="button" onClick={() => setSlide(index)} aria-label={`Show photo ${index + 1}`} aria-pressed={index === slide} className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
                    <span className={`h-2 w-2 rounded-full ${index === slide ? "bg-primary-300" : "bg-white/50"}`} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {coursesLoading || homeCourses.length > 0 ? (
      <section className="bg-background-100 py-16 md:py-24">
        <div className="site-container">
          <Reveal className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <div>
              <h2 className="mt-3 font-heading text-3xl font-bold text-foreground-950 md:text-4xl">Explore our courses</h2>
            </div>
            <Link
              to="/our-courses"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
            >
              View all courses
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
          </Reveal>

          <div className="mt-10">
            <CoursesCarousel courses={homeCourses} settings={settings.coursesCarousel} loading={coursesLoading} />
          </div>
        </div>
      </section>

      ) : null}

      <section className="bg-background-50 py-16 md:py-24">
        <div className="site-container grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <div className="relative overflow-hidden rounded-card border border-background-200 bg-background-100">
              <img
                src={aboutImage}
                alt="Skyline Institute of Technology campus and students"
                className="h-[320px] w-full object-contain object-center md:h-[420px]"
              />
            </div>
          </Reveal>
          <Reveal delay={120}>
            <span className="inline-flex items-center gap-2 font-label text-xs font-semibold uppercase tracking-[0.2em] text-primary-600">
              <i className="ri-graduation-cap-line text-base" aria-hidden="true" />
              About Our Institute
            </span>
            <h2 className="mt-4 font-heading text-3xl font-bold leading-tight text-foreground-950 md:text-4xl">
              Learn by doing
            </h2>
            <p className="mt-5 text-base leading-relaxed text-foreground-700">
              We help students from diverse backgrounds develop practical skills for starting or advancing a career.
            </p>
            <Link
              to="/about-us"
              className="mt-7 inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-secondary-900 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-secondary-800"
            >
              About Skyline
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
          </Reveal>
        </div>
      </section>

      <section className="bg-accent-950 py-14 md:py-16">
        <div className="site-container flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
          <div>
            <h2 className="font-heading text-2xl font-bold text-background-50 md:text-3xl">Get In Touch</h2>
            <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-background-200">
              <a href={settings.phoneHref} className="flex items-center gap-2 transition-colors hover:text-primary-300">
                <i className="ri-phone-line text-base text-primary-300" aria-hidden="true" />
                {settings.phone}
              </a>
              <a href={settings.emailHref} className="flex items-center gap-2 transition-colors hover:text-primary-300">
                <i className="ri-mail-line text-base text-primary-300" aria-hidden="true" />
                {settings.email}
              </a>
              <span className="flex items-center gap-2">
                <i className="ri-map-pin-line text-base text-primary-300" aria-hidden="true" />
                {settings.address}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              to="/enroll-now"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
            >
              Enroll Now
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
            <Link
              to="/contact"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-50/40 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-background-50/10"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </section>

      <LatestNews />
    </>
  );
}
