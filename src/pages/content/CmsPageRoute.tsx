import { useLocation } from "react-router-dom";
import HtmlContent from "@/components/feature/HtmlContent";
import Seo from "@/components/feature/Seo";
import { usePublicSite } from "@/hooks/publicSiteContext";
import { cmsPageAtPath, normalizeCmsPath } from "@/lib/cmsPath";
import NotFound from "@/pages/NotFound";

/** The public snapshot already excludes drafts and unauthorized tenant rows. */
export default function CmsPageRoute() {
  const { data } = usePublicSite();
  const { pathname } = useLocation();
  const page = cmsPageAtPath(data.pages, pathname);
  if (!data.backedByDatabase || !page) return <NotFound />;
  return <section className="site-container py-12">
    <Seo title={page.seoTitle || page.title} description={page.seoDescription || ""} path={normalizeCmsPath(pathname)!} />
    <h1 className="font-heading text-3xl font-bold">{page.title}</h1>
    <HtmlContent html={page.body} />
  </section>;
}
