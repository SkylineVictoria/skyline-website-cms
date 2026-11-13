import type { Block } from "@/data/pages";
import Reveal from "@/components/base/Reveal";

function SectionHeading({ children, level = "h2" }: { children: string; level?: "h2" | "h3" }) {
  const className =
    level === "h2"
      ? "font-heading text-xl font-bold text-foreground-950 md:text-2xl"
      : "font-heading text-lg font-semibold text-foreground-950 md:text-xl";
  return (
    <div className="flex items-center gap-3">
      <span className="h-6 w-1 rounded-full bg-primary-500" aria-hidden="true" />
      {level === "h2" ? <h2 className={className}>{children}</h2> : <h3 className={className}>{children}</h3>}
    </div>
  );
}

function ParagraphsBlock({ block }: { block: Extract<Block, { type: "paragraphs" }> }) {
  if (block.paragraphs.length === 0 && !block.heading) return null;
  return (
    <div>
      {block.heading ? <SectionHeading>{block.heading}</SectionHeading> : null}
      <div className={block.heading ? "mt-4 space-y-4" : "space-y-4"}>
        {block.paragraphs.map((paragraph, index) => (
          <p key={index} className="text-base leading-relaxed text-foreground-700">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );
}

function ListBlock({ block }: { block: Extract<Block, { type: "list" }> }) {
  return (
    <div>
      {block.heading ? <SectionHeading level="h3">{block.heading}</SectionHeading> : null}
      <ul className={`${block.heading ? "mt-4" : ""} space-y-3`}>
        {block.items.map((item, index) => (
          <li key={index} className="flex items-start gap-3 text-base leading-relaxed text-foreground-700">
            <i className="ri-checkbox-circle-line mt-0.5 text-base text-primary-600" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LinksBlock({ block }: { block: Extract<Block, { type: "links" }> }) {
  const isDocument = block.items.some((item) => item.href.toLowerCase().endsWith(".pdf"));
  return (
    <div>
      {block.heading ? <SectionHeading level="h3">{block.heading}</SectionHeading> : null}
      <ul className={`${block.heading ? "mt-4" : ""} grid grid-cols-1 gap-3 md:grid-cols-2`}>
        {block.items.map((item) => (
          <li key={`${item.label}-${item.href}`}>
            <a
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noopener noreferrer" : undefined}
              className="group flex items-start gap-3 rounded-md border border-background-200 bg-background-50 p-4 text-sm text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
            >
              <i
                className={`${
                  isDocument ? "ri-file-pdf-2-line" : "ri-link"
                } mt-0.5 text-lg text-primary-600 transition-transform group-hover:-translate-y-0.5`}
                aria-hidden="true"
              />
              <span className="leading-snug">{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableBlock({ block }: { block: Extract<Block, { type: "table" }> }) {
  return (
    <div className="overflow-hidden rounded-card border border-background-200 bg-background-50">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="bg-secondary-100">
              {block.columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 font-label text-xs font-semibold uppercase tracking-wider text-secondary-900"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-background-200 align-top transition-colors hover:bg-background-100">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={`px-4 py-3 text-foreground-700 ${cellIndex === 0 ? "font-medium text-foreground-950" : ""}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeaturesBlock({ block }: { block: Extract<Block, { type: "features" }> }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      {block.items.map((item) => (
        <div
          key={item.title}
          className="flex items-center gap-4 rounded-card border border-background-200 bg-background-50 p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary-300"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-card bg-primary-100 text-primary-700">
            <i className={`${item.icon} text-2xl`} aria-hidden="true" />
          </span>
          <h3 className="font-heading text-base font-semibold text-foreground-950">{item.title}</h3>
        </div>
      ))}
    </div>
  );
}

function MediaBlock({ block }: { block: Extract<Block, { type: "media" }> }) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {block.items.map((item, index) => (
        <figure
          key={item.image}
          className={`group relative overflow-hidden rounded-card border border-background-200 bg-gradient-to-br from-background-100 to-background-50 ${
            index === 0 ? "md:col-span-2" : ""
          }`}
        >
          <div
            className={`flex w-full items-center justify-center p-6 ${
              index === 0 ? "h-72 md:h-96" : "h-64"
            }`}
          >
            <img
              src={item.image}
              alt={item.alt}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-contain object-center transition-transform duration-700 ease-out group-hover:scale-[1.04]"
            />
          </div>
          {item.caption ? (
            <figcaption className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full bg-background-50/90 px-3.5 py-1.5 font-label text-xs font-semibold uppercase tracking-wide text-foreground-800 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-500" aria-hidden="true" />
              {item.caption}
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}

export default function ContentBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-10">
      {blocks.map((block, index) => {
        let content = null;
        if (block.type === "paragraphs") content = <ParagraphsBlock block={block} />;
        else if (block.type === "list") content = <ListBlock block={block} />;
        else if (block.type === "links") content = <LinksBlock block={block} />;
        else if (block.type === "table") content = <TableBlock block={block} />;
        else if (block.type === "media") content = <MediaBlock block={block} />;
        else content = <FeaturesBlock block={block} />;

        return (
          <Reveal key={index} delay={(index % 3) * 60}>
            {content}
          </Reveal>
        );
      })}
    </div>
  );
}