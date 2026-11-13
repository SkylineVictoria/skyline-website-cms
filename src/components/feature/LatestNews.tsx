import { newsItems } from "@/data/site";
import Reveal from "@/components/base/Reveal";

export default function LatestNews() {
  return (
    <section className="bg-background-50 py-section">
      <div className="site-container">
        <Reveal className="text-center">
          <p className="font-label text-xs font-semibold uppercase tracking-[0.2em] text-primary-600">Stay informed</p>
          <h2 className="mt-3 font-heading text-2xl font-bold text-foreground-950 md:text-3xl">Latest News</h2>
        </Reveal>
        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {newsItems.map((item, index) => (
            <Reveal key={item.title} delay={index * 80}>
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group block h-full overflow-hidden rounded-card border border-background-200 bg-background-50 transition-colors hover:border-primary-300"
              >
                <div className="relative aspect-square w-full overflow-hidden bg-background-100">
                  <img
                    src={item.image}
                    alt={item.alt}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 p-5">
                  <h3 className="font-heading text-base font-semibold leading-snug text-foreground-950">{item.title}</h3>
                  <i
                    className="ri-arrow-right-up-line text-lg text-primary-600 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </div>
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}