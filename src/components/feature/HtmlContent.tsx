import { sanitizeHtml } from "./htmlSanitizer";


/** Wraps each table in a scroll container so wide tables stay usable on mobile. */
function wrapTables(html: string): string {
  return html.replace(/<table[\s\S]*?<\/table>/gi, (table) => `<div class="cms-table-scroll">${table}</div>`);
}

export default function HtmlContent({ html, className = "" }: { html: string; className?: string }) {
  const safe = wrapTables(sanitizeHtml(html));
  return (
    <div
      className={`cms-content max-w-full text-sm leading-relaxed text-foreground-700 md:text-base ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
