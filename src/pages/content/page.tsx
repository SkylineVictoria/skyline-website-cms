import type { ContentPageData } from "@/data/pages";
import HtmlContent from "@/components/feature/HtmlContent";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema, siteName } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

function buildDescription(page: ContentPageData): string {
  if (page.lead) return page.lead;
  const paragraphBlock = page.blocks.find((block) => block.type === "paragraphs");
  if (paragraphBlock && paragraphBlock.type === "paragraphs" && paragraphBlock.paragraphs[0]) {
    return paragraphBlock.paragraphs[0].length > 168
      ? `${paragraphBlock.paragraphs[0].slice(0, 165).trim()}...`
      : paragraphBlock.paragraphs[0];
  }
  return `${page.title} — ${siteName}, RTO 45989 and CRICOS 04114B, Melbourne.`;
}

export default function ContentPageRoute({ data: page }: { data: ContentPageData }) {
  const { data: siteData, status } = usePublicSite();
  const live = siteData.pages[page.slug];
  const body = live?.body?.trim();
  const title = live?.title?.trim() || page.title;

  return (
    <>
      <Seo
        title={`${page.title} | ${siteName}`}
        description={buildDescription(page)}
        path={`/${page.slug}`}
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: page.breadcrumb, path: `/${page.slug}` },
          ]),
        ]}
      />
      <PageHero title={title} breadcrumb={page.breadcrumb} lead={undefined} />
      <section className="relative overflow-hidden bg-background-50 py-14 md:py-20">
        <div className="site-container relative">
          <div className="mx-auto max-w-4xl">
            {body ? <HtmlContent html={body} /> : <p role="status" className="text-foreground-600">{status === "loading" ? "Loading information…" : "No information is currently published for this page."}</p>}
          </div>
        </div>
      </section>
    </>
  );
}