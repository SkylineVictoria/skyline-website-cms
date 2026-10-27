import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Reveal from "@/components/base/Reveal";
import CourseCard from "@/components/feature/CourseCard";
import LatestNews from "@/components/feature/LatestNews";
import Seo from "@/components/feature/Seo";
import { defaultOgImage, siteDescription } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

const services = [
  {
    title: "Education Services",
    text: "We at Skyline provide the best hands on learning as we believe in learning by doing.",
    icon: "ri-book-open-line",
  },
  {
    title: "International Hubs",
    text: "At Skyline you can explore vibrant cultures, customs and traditions from different countries all around the world.",
    icon: "ri-global-line",
  },
  {
    title: "World Class Academics",
    text: "Academics at Skyline equips the students with information and knowledge in various fields in general.",
    icon: "ri-award-line",
  },
];

const staticHeroImages = [
  "https://static.readdy.ai/image/7fe129f8d7ac12cdc97a659d50dae110/10672c8cbcfc600c6073bd57b6040721.jpeg",
  "https://readdy.ai/api/search-image?query=Modern%20Australian%20training%20campus%20courtyard%20with%20diverse%20international%20students%20walking%20and%20talking%2C%20warm%20afternoon%20light%2C%20clean%20architectural%20lines%2C%20editorial%20photography%20with%20soft%20shadows&width=1920&height=1080&seq=skyline-hero-02&orientation=landscape",
  "https://readdy.ai/api/search-image?query=Bright%20modern%20technical%20workshop%20classroom%20with%20students%20learning%20hands-on%20skills%20and%20an%20instructor%20guiding%20them%2C%20warm%20neutral%20tones%2C%20clean%20professional%20editorial%20photography&width=1920&height=1080&seq=skyline-hero-03&orientation=landscape",
];

const staticAboutImage = "https://slit.edu.au/wp-content/uploads/2023/05/about_img_02.png";

export default function Home() {
  const [slide, setSlide] = useState(0);
  const { data } = usePublicSite();
  const { featuredCourses, settings } = data;

  // Hero and about imagery are CMS-managed (Website Settings → Homepage images)
  // and fall back to the shipped defaults until the CMS provides values.
  const heroImages = settings.homeHeroImages.length ? settings.homeHeroImages : staticHeroImages;
  const aboutImage = settings.homeAboutImage || staticAboutImage;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSlide((current) => (current + 1) % heroImages.length);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [heroImages.length]);

  useEffect(() => {
    if (slide >= heroImages.length) setSlide(0);
  }, [heroImages.length, slide]);

  return (
    <>
      <Seo
        title="Skyline Institute Of Technology | Melbourne RTO & CRICOS Courses"
        description={siteDescription}
        path="/"
        image={defaultOgImage}
      />
      <section className="relative flex min-h-[520px] w-full items-center overflow-hidden md:min-h-[620px]">
        {heroImages.map((src, index) => (
          <img
            key={src}
            src={src}
            alt="Student looking ahead on an Australian campus"
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-1000 ${
              index === slide ? "opacity-100" : "opacity-0"
            }`}
          />
        ))}
        <div className="absolute inset-0 bg-gradient-to-r from-foreground-950/85 via-foreground-950/60 to-foreground-950/20" />
        <div className="site-container relative py-20 md:py-28">
          <div key={slide} className="max-w-2xl">
            <span className="inline-flex animate-fade-up items-center gap-3 font-label text-xs font-semibold uppercase tracking-[0.28em] text-primary-300">
              <span className="inline-block h-px w-8 bg-primary-400" />
              Welcome To Skyline
            </span>
            <h1
              className="mt-5 animate-fade-up font-heading text-4xl font-extrabold leading-[1.08] text-background-50 md:text-6xl"
              style={{ animationDelay: "0.1s" }}
            >
              Education is the key to success
            </h1>
            <p
              className="mt-6 max-w-xl animate-fade-up text-base leading-relaxed text-background-200 md:text-lg"
              style={{ animationDelay: "0.2s" }}
            >
              Skyline is at the forefront of delivering exceptional technical education and training in various
              professions and industries.
            </p>
            <div
              className="mt-8 flex animate-fade-up flex-col gap-3 sm:flex-row sm:items-center"
              style={{ animationDelay: "0.3s" }}
            >
              <Link
                to="/about-us"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
              >
                Discover More
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-50/40 px-6 py-3 text-sm font-semibold text-background-50 backdrop-blur transition-colors hover:bg-background-50/10"
              >
                Contact Us
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2">
          {heroImages.map((src, index) => (
            <button
              key={src}
              type="button"
              onClick={() => setSlide(index)}
              aria-label={`Show slide ${index + 1}`}
              className={`h-1.5 rounded-full transition-all ${
                index === slide ? "w-8 bg-primary-500" : "w-3 bg-background-50/60 hover:bg-background-50"
              }`}
            />
          ))}
        </div>
      </section>

      <section className="relative z-10 bg-background-50">
        <div className="site-container -mt-10 grid grid-cols-1 gap-5 pb-4 md:-mt-16 md:grid-cols-3">
          {services.map((service, index) => (
            <Reveal key={service.title} delay={index * 90}>
              <div className="flex h-full flex-col rounded-card border border-background-200 bg-background-50 p-6">
                <span className="flex h-14 w-14 items-center justify-center rounded-card bg-primary-100 text-primary-700">
                  <i className={`${service.icon} text-3xl`} aria-hidden="true" />
                </span>
                <h2 className="mt-5 font-heading text-lg font-semibold text-foreground-950">{service.title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-foreground-600">{service.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

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
              A Few Words About the Skyline
            </h2>
            <p className="mt-5 text-sm leading-relaxed text-foreground-700 md:text-base">
              Skyline Institute is at the forefront of delivering exceptional technical education and training in
              various professions and industries. Our commitment lies in equipping businesses with the necessary skills
              and talents to excel, while also assisting individuals in their career journeys, regardless of whether
              they are embarking on a new path or advancing further.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-foreground-700 md:text-base">
              Our approach involves empowering students from diverse backgrounds, as they represent the future's
              trailblazers and visionaries. Through our outstanding technical education and hands-on opportunities, we
              provide them with the tools they need to succeed in their careers and make a positive impact in the world.
            </p>
            <Link
              to="/about-us"
              className="mt-7 inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-secondary-900 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-secondary-800"
            >
              Read More
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
          </Reveal>
        </div>
      </section>

      <section className="bg-background-100 py-16 md:py-24">
        <div className="site-container">
          <Reveal className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <div>
              <span className="inline-flex items-center gap-2 font-label text-xs font-semibold uppercase tracking-[0.2em] text-primary-600">
                <i className="ri-graduation-cap-line text-base" aria-hidden="true" />
                Our Courses
              </span>
              <h2 className="mt-3 font-heading text-3xl font-bold text-foreground-950 md:text-4xl">Programs</h2>
            </div>
            <Link
              to="/our-courses"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
            >
              View all courses
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </Link>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-product-shop>
            {featuredCourses.map((course, index) => (
              <Reveal key={course.slug} delay={index * 70}>
                <CourseCard course={course} />
              </Reveal>
            ))}
          </div>
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