import { defaultOgImage, siteName, siteUrl } from "@/data/seo";
import { useContext } from "react";
import { PublicSiteContext } from "@/hooks/publicSiteContext";

export type StructuredDataValue = Record<string, unknown>;

/* Renders schema.org JSON-LD. React places the script inline in the document,
   which is valid for JSON-LD anywhere in the page. */
export function StructuredData({ data }: { data: StructuredDataValue[] }) {
  return (
    <>
      {data.map((schema, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }}
        />
      ))}
    </>
  );
}

type SeoProps = {
  title: string;
  description: string;
  path: string;
  image?: string;
  type?: "website" | "article";
  jsonLd?: StructuredDataValue[];
};

/* Per-page metadata. React 19 hoists <title>, <meta> and <link> rendered here
   into the document <head>, so every route gets its own title, description,
   canonical URL, social tags and structured data. */
export default function Seo({ title, description, path, image, type = "website", jsonLd }: SeoProps) {
  const context = useContext(PublicSiteContext);
  const tenant = context?.data.tenantSite;
  const name = tenant ? context.data.settings.name : siteName;
  const override = context?.data.seo?.find((entry) => entry.path === path);
  const pageTitle = override?.title || title;
  const pageDescription = override?.description || description;
  const fullTitle = pageTitle.includes(name) ? pageTitle : `${pageTitle} | ${name}`;
  const canonical = `${tenant ? window.location.origin : siteUrl}${/^\/(?!\/)/.test(path) ? path : "/"}`;
  const ogImage = tenant ? context.data.settings.logo : image ?? defaultOgImage;

  return (
    <>
      <title>{fullTitle}</title>
      <meta name="description" content={pageDescription} />
      <meta name="keywords" content={override?.keywords ?? ""} />
      <link rel="canonical" href={canonical} />
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={name} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={pageDescription} />
      <meta property="og:url" content={canonical} />
      <meta property="og:locale" content="en_AU" />
      <meta property="og:image" content={ogImage} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={pageDescription} />
      <meta name="twitter:image" content={ogImage} />
      {jsonLd && jsonLd.length > 0 ? <StructuredData data={jsonLd} /> : null}
    </>
  );
}
