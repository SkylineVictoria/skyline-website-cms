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
      <section className="bg-[#f5f5f7] text-[#1d1d1f]">
        <div className="mx-auto max-w-[1440px] px-5 pt-14 text-center md:px-12 md:pt-20">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground-500">Skyline Institute of Technology · Melbourne</p>
            <h1 className="mx-auto mt-5 max-w-5xl font-heading text-[48px] font-semibold leading-[1.02] tracking-[-0.055em] md:text-[84px] lg:text-[104px]">
              Your future.<br /><span className="text-primary-600">Starts here.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-foreground-600 md:text-2xl">
              Build hands-on skills through vocational courses in Melbourne.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
              <Link to="/our-courses" className="inline-flex items-center gap-2 rounded-full bg-primary-600 px-7 py-3.5 text-sm font-semibold text-white hover:bg-primary-700">
                Explore courses <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
              <Link to="/contact" className="py-3 text-base font-medium text-primary-700 hover:underline underline-offset-4">
                Book a call
              </Link>
            </div>
          </div>
          <div>
            <div className="mt-12 overflow-hidden rounded-t-[28px] bg-white md:mt-16 md:rounded-t-[40px]">
              <img
                src={heroImages[slide] ?? heroImages[0]}
                alt=""
                className="h-[300px] w-full object-cover object-center md:h-[460px]"
                fetchPriority="high"
              />
            </div>
            {heroImages.length > 1 ? (
              <div className="flex justify-center gap-1 py-3" aria-label="Homepage photos" role="group">
                {heroImages.map((_, index) => (
                  <button key={index} type="button" onClick={() => setSlide(index)} aria-label={`Show photo ${index + 1}`} aria-pressed={index === slide} className="grid h-8 w-8 place-items-center rounded-full hover:bg-black/5">
                    <span className={`h-2 w-2 rounded-full ${index === slide ? "bg-primary-600" : "bg-black/20"}`} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {coursesLoading || homeCourses.length > 0 ? (
      <section className="bg-white py-20 md:py-28">
        <div className="site-container">
          <Reveal className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <div>
              <h2 className="mt-3 font-heading text-4xl font-semibold tracking-[-0.04em] text-foreground-950 md:text-6xl">Find your next chapter.</h2>
            </div>
            <Link
              to="/our-courses"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-background-300 bg-white px-5 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
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

      <section className="mx-3 rounded-[28px] bg-[#f5f5f7] py-20 md:mx-6 md:rounded-[40px] md:py-28">
        <div className="site-container grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl bg-white">
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
            <h2 className="mt-4 font-heading text-4xl font-semibold leading-[1.05] tracking-[-0.04em] text-foreground-950 md:text-6xl">
              Real skills.<br />New possibilities.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-foreground-700">
              We help students from diverse backgrounds develop practical skills for starting or advancing a career.
            </p>
            <Link
              to="/about-us"
              className="mt-7 inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-secondary-900 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-secondary-800"
            >
              About Skyline
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
          </Reveal>
        </div>
      </section>

      <section className="mx-3 my-3 rounded-[28px] bg-[#1d1d1f] px-6 py-20 text-center text-white md:mx-6 md:my-6 md:rounded-[40px] md:py-28">
        <p className="text-sm font-medium text-white/60">Your next step</p>
        <h2 className="mx-auto mt-4 max-w-3xl font-heading text-4xl font-semibold leading-tight tracking-[-0.04em] md:text-6xl">Big plans?<br />Let’s talk.</h2>
        <p className="mx-auto mt-5 max-w-md text-lg text-white/70">Explore your study options with the Skyline team.</p>
        <Link to="/contact" className="mt-8 inline-flex rounded-full bg-white px-7 py-3.5 text-base font-medium text-[#1d1d1f] hover:bg-background-200">Book a call</Link>
      </section>

      <LatestNews />
    </>
  );
}
