

import { safeContentUrl } from "@/lib/contentUrl";
const tags = new Set('p div span br hr h1 h2 h3 h4 h5 h6 strong b em i u s sub sup ul ol li blockquote pre code table thead tbody tfoot tr th td caption colgroup col a img figure figcaption'.split(' '));
const discard = new Set('script style iframe object embed form link meta svg math template noscript'.split(' '));
function safeUrl(value: string, image: boolean): boolean {
  // The HTML parser has already decoded character references. URL parsing
  // normalizes control characters; do not validate the raw markup with regex.
  return !!safeContentUrl(value, image ? "image" : "link");
}
export function sanitizeHtml(html: string): string {
  // Vite renders in the browser. Non-DOM callers get safe text, never raw HTML.
  if (typeof document === 'undefined') return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const input = document.createElement('template'); input.innerHTML = html;
  const output = document.createElement('div');
  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent ?? '')); return; }
    if (!(node instanceof HTMLElement) || discard.has(node.localName)) return;
    if (!tags.has(node.localName)) { for (const child of node.childNodes) copy(child, parent); return; }
    const clean = document.createElement(node.localName);
    for (const attr of node.attributes) {
      const name = attr.name, value = attr.value;
      if (['title', 'alt'].includes(name) || name === 'dir' && ['ltr', 'rtl', 'auto'].includes(value)) clean.setAttribute(name, value);
      if (['colspan', 'rowspan', 'width', 'height', 'start', 'span'].includes(name) && /^\d{1,4}$/.test(value)) clean.setAttribute(name, value);
      if (name === 'href' && node.localName === 'a' && safeUrl(value, false)) clean.setAttribute(name, value);
      if (name === 'src' && node.localName === 'img' && safeUrl(value, true)) clean.setAttribute(name, value);
      if (name === 'target' && value === '_blank' && node.localName === 'a') { clean.setAttribute('target', '_blank'); clean.setAttribute('rel', 'noopener noreferrer'); }
      if (name === 'scope' && ['row', 'col', 'rowgroup', 'colgroup'].includes(value)) clean.setAttribute(name, value);
    }
    for (const child of node.childNodes) copy(child, clean);
    parent.appendChild(clean);
  };
  for (const node of input.content.childNodes) copy(node, output);
  return output.innerHTML;
}
