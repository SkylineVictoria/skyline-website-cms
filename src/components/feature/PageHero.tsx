import { Link } from "react-router-dom";

type PageHeroProps = { title: string; breadcrumb?: string; lead?: string };

export default function PageHero({ title, breadcrumb, lead }: PageHeroProps) {
  return (
    <section className="border-b-4 border-primary-600 bg-[#102b46] text-white">
      <div className="site-container py-10 md:py-14">
        <nav aria-label="Breadcrumb" className="mb-5 flex flex-wrap gap-2 text-xs text-white/70">
          <Link to="/" className="hover:text-white hover:underline">Home</Link>
          <span aria-hidden="true">/</span><span aria-current="page">{breadcrumb || title}</span>
        </nav>
        <h1 className="max-w-4xl font-heading text-3xl font-semibold leading-tight tracking-tight md:text-5xl">{title}</h1>
        {lead ? <p className="mt-5 max-w-3xl text-base leading-relaxed text-white/80">{lead}</p> : null}
      </div>
    </section>
  );
}
