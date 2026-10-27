import { Link, Outlet, useLocation } from "react-router-dom";
import { usePublicSite } from "@/hooks/publicSiteContext";
import HtmlContent from "./HtmlContent";
import Seo from "./Seo";
import DocumentLibrary from "./DocumentLibrary";
import { cmsPageAtPath, normalizeCmsPath } from "@/lib/cmsPath";

/** Tenant pages render only approved CMS content; empty content stays empty. */
export default function TenantPublicContent() {
  const { data } = usePublicSite();
  const { pathname } = useLocation();
  if (pathname.startsWith("/forms/")) return <Outlet />;
  const slug = normalizeCmsPath(pathname)?.slice(1) || "home";
  const page = cmsPageAtPath(data.pages, pathname);
  const course = pathname.startsWith("/courses/") ? data.courses.find((item) => item.slug === slug.slice(8)) : undefined;
  const title = page?.title ?? course?.name ?? (pathname === "/our-courses" ? "Courses" : pathname === "/" ? data.settings.name : "Page unavailable");
  return <section className="site-container py-12">
    <Seo title={page?.seoTitle || title} description={page?.seoDescription || ""} path={normalizeCmsPath(pathname) || pathname} />
    <h1 className="font-heading text-3xl font-bold">{title}</h1>
    {pathname === "/" && data.settings.homeHeroImages[0] ? <img src={data.settings.homeHeroImages[0]} alt={data.settings.name} className="my-6 max-h-96 w-full object-cover" /> : null}
    {page ? <HtmlContent html={page.body} /> : null}
    {pathname === "/forms-policies" ? <><DocumentLibrary /><ul>{data.forms.map((form) => <li key={form.id}><Link to={`/forms/${form.id}`}>{form.name}</Link></li>)}</ul></> : null}
    {pathname === "/contact" ? <address className="my-6 not-italic"><p>{data.settings.address}</p><a href={data.settings.emailHref}>{data.settings.email}</a><p><a href={data.settings.phoneHref}>{data.settings.phone}</a></p></address> : null}
    {pathname === "/our-courses" ? <ul>{data.courses.map((item) => <li key={item.slug}><Link to={`/courses/${item.slug}`}>{item.name}</Link></li>)}</ul> : null}
    {course ? <><p>{course.summary}</p><p>{course.duration}</p><p>{course.mode}</p><table><tbody>{course.units?.map((unit) => <tr key={unit.code}><td>{unit.code}</td><td>{unit.name}</td></tr>)}</tbody></table></> : null}
    {course && data.courseContent?.[course.slug] ? <><HtmlContent html={data.courseContent[course.slug].description} />{data.courseContent[course.slug].sections.map((section) => <section key={section.title}><h2 className="font-heading text-xl">{section.title}</h2><HtmlContent html={section.body} /></section>)}</> : null}
  </section>;
}
