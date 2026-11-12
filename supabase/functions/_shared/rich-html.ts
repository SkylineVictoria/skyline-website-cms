// Rich document HTML (TPL-02): the header, body and footer of a document template. Runtime-neutral (browser, Deno, Node tests); no DOM.
// One allow-list for everything: the editor sanitises what it loads and saves, the Edge Function sanitises again before it renders, and
// the database refuses scripts, frames, handlers and linked pictures on top (hr.rich_html_problem). Kept: paragraphs, headings, lists,
// quotes, rules, tables (column widths, borders on/off, per-cell borders and padding, colspan / rowspan, cell shading), line and paragraph
// spacing, pictures uploaded into the template (PNG / JPEG data URIs, or files in the template-assets Storage bucket),
// bold / italic / underline / strike / sub / sup, text colour and highlight, font size, alignment and links (https, mailto). Font families
// are dropped: the PDF has one family (Arimo, Arial-compatible), so a family the editor showed would silently change in the PDF.
// Everything else is removed; the text inside an unknown tag is kept, the content of a script, style, frame or form is not.
// Also here: the [Variable Name] tokens (scanning, warnings, joining tokens a Word document split across runs).
import { decodeEntities, escapeHtml } from "./hr-template.ts";

/* ------------------------------------------------------------------ tree */
export interface ElementNode { tag: string; attrs: Record<string, string>; children: Node[] }
export type Node = ElementNode | string;
const isElement = (node: Node): node is ElementNode => typeof node !== "string";

const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(["br", "hr", "img", "col", "wbr", "input", "meta", "link", "base", "area", "source", "param", "embed"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "noscript", "template", "svg", "math", "title", "head",
  "form", "textarea", "select", "button", "xml", "audio", "video", "canvas", "map"]);
const BLOCKISH = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "hr", "pre", "section", "article", "header", "footer"]);
const TABLE_SCOPE = new Set(["table"]);

/** A forgiving HTML parser (pasted, Word-made or hand-written HTML): implied closes for p / li / td / tr, stray closing tags ignored. */
export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = (tag: string, stopAt: Set<string> = TABLE_SCOPE): boolean => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) { stack.length = i; return true; }
      if (stopAt.has(stack[i].tag) && stack[i].tag !== tag) return false;
    }
    return false;
  };
  let skipping: string | null = null;
  for (const match of String(html ?? "").matchAll(TAG)) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    if (!name) {
      if (skipping || token.startsWith("<!") || token.startsWith("<?")) continue;
      top().children.push(decodeEntities(token === "<" ? "<" : token));
      continue;
    }
    const closing = token[1] === "/";
    if (skipping) { if (closing && name === skipping) skipping = null; continue; }
    if (DROP_WITH_CONTENT.has(name)) { if (!closing && !/\/\s*>$/.test(token) && !VOID.has(name)) skipping = name; continue; }
    if (closing) {
      if (name === "p" && !stack.some((n) => n.tag === "p")) { top().children.push({ tag: "p", attrs: {}, children: [] }); continue; }
      closeTo(name, name === "td" || name === "th" || name === "tr" || name === "tbody" || name === "thead" || name === "tfoot" || name === "table" ? TABLE_SCOPE : new Set(["table", "td", "th"]));
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (match[2] ?? "").matchAll(ATTR)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    // Implied closes.
    if (BLOCKISH.has(name)) closeTo("p", new Set(["table", "td", "th", "li", "blockquote", "div"]));
    if (name === "li") { for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (t === "ul" || t === "ol" || t === "table") break; if (t === "li") { stack.length = i; break; } } }
    if (name === "td" || name === "th") { for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (t === "tr" || t === "table") break; if (t === "td" || t === "th") { stack.length = i; break; } } }
    if (name === "tr") { for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (t === "table" || t === "tbody" || t === "thead" || t === "tfoot") break; if (t === "tr") { stack.length = i; break; } } }
    if (name === "tbody" || name === "thead" || name === "tfoot") { for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (t === "table") break; if (t === "tbody" || t === "thead" || t === "tfoot") { stack.length = i; break; } } }
    const element: ElementNode = { tag: name, attrs, children: [] };
    top().children.push(element);
    if (!VOID.has(name) && !/\/\s*>$/.test(token)) stack.push(element);
  }
  return root;
}

/* ------------------------------------------------------------------ allow-list */
const KEEP = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col",
  "br", "hr", "img", "a", "strong", "em", "u", "s", "sub", "sup", "span"]);
const RENAME: Record<string, string> = { b: "strong", i: "em", strike: "s", del: "s", ins: "u", font: "span", center: "div", section: "div", article: "div", header: "div", footer: "div",
  pre: "p", address: "p", caption: "p", dl: "div", dt: "p", dd: "p", figure: "div", figcaption: "p", main: "div", nav: "div", aside: "div", label: "span", small: "span", big: "span", mark: "span",
  code: "span", kbd: "span", samp: "span", var: "span", cite: "em", q: "span", abbr: "span", tt: "span" };
const FONT_SIZE_KEYWORDS: Record<string, number> = { "xx-small": 7, "x-small": 7.5, small: 10, medium: 12, large: 13.5, "x-large": 18, "xx-large": 24, "xxx-large": 36 };
const FONT_TAG_SIZES = [0, 7.5, 10, 12, 13.5, 18, 24, 36];
const NAMED_COLOURS: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", navy: "#000080", teal: "#008080", olive: "#808000", lime: "#00ff00", aqua: "#00ffff", fuchsia: "#ff00ff",
  darkblue: "#00008b", darkred: "#8b0000", darkgreen: "#006400", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", transparent: "" };
export const MAX_IMAGE_CHARS = 400_000;

/** A colour as #rrggbb, or null when it is not one this module understands (then it is dropped). */
export function colourOf(value: string | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (Object.hasOwn(NAMED_COLOURS, v)) return NAMED_COLOURS[v] || null;
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return `#${[...m[1]].map((c) => c + c).join("")}`;
  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return `#${m[1]}`;
  m = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}
/** A font size in points (pt, px, em relative to 10 pt, %, keywords), or null. */
export function pointsOf(value: string | undefined, base = 10): number | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (Object.hasOwn(FONT_SIZE_KEYWORDS, v)) return FONT_SIZE_KEYWORDS[v];
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(pt|px|em|rem|%)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const pt = m[2] === "px" ? n * 0.75 : m[2] === "em" || m[2] === "rem" ? n * base : m[2] === "%" ? (n / 100) * base : m[2] === "pt" ? n : n * 0.75;
  return pt >= 4 && pt <= 72 ? Math.round(pt * 10) / 10 : null;
}
/** A length for widths: { pct } or { pt }. */
export function lengthOf(value: string | undefined): { pct: number } | { pt: number } | null {
  const v = String(value ?? "").trim().toLowerCase();
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(%|px|pt|cm|mm|in)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === "%") return n > 0 && n <= 100 ? { pct: n } : null;
  const pt = m[2] === "pt" ? n : m[2] === "cm" ? n * 28.3465 : m[2] === "mm" ? n * 2.83465 : m[2] === "in" ? n * 72 : n * 0.75;
  return pt > 0 && pt <= 2000 ? { pt } : null;
}
const styleMap = (style: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of String(style ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().replace(/\s*!important\s*$/i, "");
  }
  return out;
};
export function safeHref(value: string | undefined): string | null {
  const href = String(value ?? "").trim();
  // eslint-disable-next-line no-control-regex -- control characters are never valid in a link
  if (/^(https?:\/\/|mailto:)[^\s<>"'\u0000-\u001f]+$/i.test(href) && href.length <= 2000) return href;
  return null;
}
/** A picture in the template-assets bucket (the project's Storage, or the local stack's): the only linked pictures a template may hold. */
export const TEMPLATE_ASSET_URL = /^(?:https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5})\/storage\/v1\/object\/public\/template-assets\/(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg)$/;
export const isTemplateAsset = (src: string | undefined) => TEMPLATE_ASSET_URL.test(String(src ?? "").trim());

const BORDER_WIDTHS: Record<string, number> = { thin: 0.75, medium: 1.5, thick: 2.25 };
/** One border side ("solid windowtext 1.0pt", "1px solid #333", "none") as "0.75pt solid #000000" / "none", or null when it says nothing. */
export function borderOf(value: string | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  const parts = v.replace(/rgba?\([^)]*\)/g, (m) => m.replace(/\s+/g, "")).split(/\s+/);
  if (parts.some((p) => p === "none" || p === "hidden")) return "none";
  let width: number | null = null, colour: string | null = null, style = false;
  for (const p of parts) {
    if (p === "windowtext" || p === "auto") { colour ??= "#000000"; continue; }
    if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(p)) { style = true; continue; }
    if (Object.hasOwn(BORDER_WIDTHS, p)) { width = BORDER_WIDTHS[p]; continue; }
    if (/^0(\.0+)?(pt|px|cm|mm|in)?$/.test(p)) { width = 0; continue; }
    const len = lengthOf(p);
    if (len && "pt" in len) { width = Math.round(len.pt * 100) / 100; continue; }
    colour ??= colourOf(p);
  }
  if (width === 0) return "none";
  if (width === null && !style) return null;
  return `${Math.min(6, width ?? 0.75)}pt solid ${colour ?? "#000000"}`;
}
/** A spacing length in points (0 to 72), or null. */
function spacingOf(value: string | undefined): number | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (/^0(\.0+)?([a-z]+)?$/.test(v)) return 0;
  const len = lengthOf(v);
  return len && "pt" in len && len.pt <= 72 ? Math.round(len.pt * 10) / 10 : null;
}
/** Line spacing as a multiple ("1.5", "115%") or in points ("18pt"), normalised; "normal" and nonsense say nothing. */
export function lineHeightOf(value: string | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase();
  let m = v.match(/^(\d+(?:\.\d+)?)%$/);
  if (m) { const n = Number(m[1]) / 100; return n >= 0.8 && n <= 3 ? String(Math.round(n * 100) / 100) : null; }
  m = v.match(/^(\d+(?:\.\d+)?)$/);
  if (m) { const n = Number(m[1]); return n >= 0.8 && n <= 3 ? String(Math.round(n * 100) / 100) : null; }
  if (!/(pt|px)$/.test(v)) return null;
  const len = lengthOf(v);
  return len && "pt" in len && len.pt >= 4 && len.pt <= 120 ? `${Math.round(len.pt * 10) / 10}pt` : null;
}

export function safeImageSrc(value: string | undefined): string | null {
  const src = String(value ?? "").trim();
  if (isTemplateAsset(src)) return src;
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(src) && src.length <= MAX_IMAGE_CHARS ? src : null;
}

/** The style a kept element may carry, normalised. */
function cleanStyle(tag: string, attrs: Record<string, string>): string {
  const css = styleMap(attrs.style);
  const out: string[] = [];
  const block = /^(p|div|h[1-6]|li|blockquote|td|th|table)$/.test(tag);
  const align = (css["text-align"] ?? attrs.align ?? "").toLowerCase();
  if (block && /^(left|center|right|justify)$/.test(align) && align !== "left") out.push(`text-align:${align}`);
  if (tag === "td" || tag === "th") {
    const valign = (css["vertical-align"] ?? attrs.valign ?? "").toLowerCase();
    if (/^(top|middle|bottom)$/.test(valign) && valign !== "top") out.push(`vertical-align:${valign}`);
  }
  const colour = colourOf(css.color ?? (tag === "span" ? attrs.color : undefined));
  if (colour) out.push(`color:${colour}`);
  const background = colourOf(css["background-color"] ?? css.background ?? attrs.bgcolor);
  if (background && background !== "#ffffff") out.push(`background-color:${background}`);
  const size = pointsOf(css["font-size"]) ?? (tag === "span" && attrs.size && /^[1-7]$/.test(attrs.size) ? FONT_TAG_SIZES[Number(attrs.size)] : null);
  if (size) out.push(`font-size:${size}pt`);
  if (/^(p|div|h[1-6]|li)$/.test(tag)) {
    const leading = lineHeightOf(css["line-height"]);
    if (leading) out.push(`line-height:${leading}`);
    for (const side of ["top", "bottom"] as const) {
      const space = spacingOf(css[`margin-${side}`]);
      if (space !== null) out.push(`margin-${side}:${space}pt`);
    }
  }
  // No font family is kept: the PDF prints every text in Arimo (Arial metrics), so the editor shows Arial too and nothing changes on the way.
  const weight = (css["font-weight"] ?? "").toLowerCase();
  if (weight === "bold" || weight === "bolder" || /^[6-9]00$/.test(weight)) out.push("font-weight:bold");
  if ((css["font-style"] ?? "").toLowerCase() === "italic") out.push("font-style:italic");
  const deco = (css["text-decoration"] ?? css["text-decoration-line"] ?? "").toLowerCase();
  if (deco.includes("underline")) out.push("text-decoration:underline");
  else if (deco.includes("line-through")) out.push("text-decoration:line-through");
  if (tag === "table" || tag === "td" || tag === "th" || tag === "col" || tag === "img") {
    const width = lengthOf(css.width ?? attrs.width);
    if (width) out.push(`width:${"pct" in width ? `${width.pct}%` : `${Math.round(width.pt * 10) / 10}pt`}`);
  }
  if (tag === "img") {
    const height = lengthOf(css.height ?? attrs.height);
    if (height && "pt" in height) out.push(`height:${Math.round(height.pt * 10) / 10}pt`);
  }
  if (tag === "table") {
    const border = (css.border ?? css["border-style"] ?? "").toLowerCase();
    if (attrs.border === "0" || /^(none|0|hidden)\b/.test(border)) out.push("border:none");
  }
  if (tag === "td" || tag === "th") {
    // Word sets each cell's borders (border, then border-top / -right / -bottom / -left over it); without them the table's apply.
    const all = borderOf(css.border);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const one = borderOf(css[`border-${side}`]) ?? all;
      if (one) out.push(`border-${side}:${one}`);
    }
    const pad = String(css.padding ?? "").trim().split(/\s+/).filter(Boolean);
    const [top, right = top, bottom = top, left = right] = pad;
    const v = spacingOf(css["padding-top"] ?? top) ?? spacingOf(css["padding-bottom"] ?? bottom);
    const h = spacingOf(css["padding-left"] ?? left) ?? spacingOf(css["padding-right"] ?? right);
    if (v !== null || h !== null) out.push(`padding:${Math.min(v ?? 4, 30)}pt ${Math.min(h ?? 4, 30)}pt`);
  }
  return out.join(";");
}

function serialise(node: Node, out: string[]): void {
  if (!isElement(node)) { out.push(escapeHtml(node).replace(/&#39;/g, "'").replace(/&quot;/g, '"')); return; }
  const tag = RENAME[node.tag] ?? node.tag;
  if (node.tag === "#root") { for (const child of node.children) serialise(child, out); return; }
  if (!KEEP.has(tag)) { for (const child of node.children) serialise(child, out); return; }
  const attrs: string[] = [];
  if (tag === "a") {
    const href = safeHref(node.attrs.href);
    if (!href) { for (const child of node.children) serialise(child, out); return; }
    attrs.push(`href="${escapeHtml(href)}"`);
  }
  if (tag === "img") {
    const src = safeImageSrc(node.attrs.src);
    if (!src) return;
    attrs.push(`src="${src}"`);
    if (node.attrs.alt) attrs.push(`alt="${escapeHtml(node.attrs.alt.slice(0, 200))}"`);
  }
  if (tag === "td" || tag === "th") {
    const span = Number(node.attrs.colspan);
    if (Number.isInteger(span) && span > 1 && span <= 20) attrs.push(`colspan="${span}"`);
    const rows = Number(node.attrs.rowspan);
    if (Number.isInteger(rows) && rows > 1 && rows <= 50) attrs.push(`rowspan="${rows}"`);
  }
  const style = cleanStyle(tag, { ...node.attrs, ...(node.tag === "font" ? { size: node.attrs.size, face: node.attrs.face, color: node.attrs.color } : {}) });
  if (style) attrs.push(`style="${escapeHtml(style).replace(/&#39;/g, "'")}"`);
  if (tag === "table" && node.attrs.border === "0" && !style.includes("border:none")) attrs.push('style="border:none"');
  const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  if (VOID.has(tag)) { out.push(open); return; }
  // A span that carries nothing is only its text.
  if (tag === "span" && !style) { for (const child of node.children) serialise(child, out); return; }
  out.push(open);
  for (const child of node.children) serialise(child, out);
  out.push(`</${tag}>`);
}

/** Rebuilds the HTML from the allow-list (see the top of this file). The result is well formed. */
export function sanitizeRichHtml(html: string): string {
  if (String(html ?? "").length > 2_000_000) throw new Error("The document is too long.");
  const out: string[] = [];
  serialise(parseHtml(html), out);
  return out.join("").replace(/<(p|div|span|strong|em|u|s)>\s*<\/\1>/g, (whole, tag: string) => (tag === "p" ? "<p></p>" : "")).trim();
}

/** The plain text of rich HTML (a paragraph per line, cells separated by a tab), for the plain-text copy and for scanning tokens. */
export function richPlainText(html: string): string {
  const lines: string[] = [];
  let line = "";
  const walk = (node: Node) => {
    if (!isElement(node)) { line += node.replace(/\s+/g, " "); return; }
    const tag = RENAME[node.tag] ?? node.tag;
    if (tag === "br") { lines.push(line); line = ""; return; }
    if (tag === "img") return;
    const block = /^(p|div|h[1-6]|li|blockquote|tr|table|ul|ol|hr)$/.test(tag);
    if (block && line.trim()) { lines.push(line); line = ""; }
    node.children.forEach((child, i) => { walk(child); if ((tag === "tr") && i < node.children.length - 1) line += "\t"; });
    if (block && line.trim()) { lines.push(line); line = ""; }
  };
  walk(parseHtml(html));
  if (line.trim()) lines.push(line);
  return lines.map((l) => l.replace(/[ \t]+$/g, "").replace(/^ +/, "")).filter((l, i, all) => l || (i > 0 && all[i - 1])).join("\n").trim();
}

/* ------------------------------------------------------------------ [Variable] tokens */
/** A token: text between square brackets on one line, up to 80 characters, with at least one letter (so [1], [ ] and [___] stay text). */
export const BRACKET_TOKEN = /\[([^[\]\n]{1,80})\]/g;
export const tokenName = (raw: string) => raw.replace(/\s+/g, " ").trim();
export const isTokenName = (raw: string) => /\p{L}/u.test(raw) && tokenName(raw).length > 0;

/** Every token in the text, in order of first use (names as written, spacing normalised). */
export function bracketTokens(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(BRACKET_TOKEN)) {
    if (!isTokenName(m[1])) continue;
    const name = tokenName(m[1]);
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/** Warnings staff see when they save: brackets that do not pair up on a line, and empty tokens such as [] or [ ]. */
export function bracketWarnings(text: string, section: string): string[] {
  const warnings: string[] = [];
  text.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const quote = line.length > 60 ? `${line.slice(0, 57)}...` : line;
    if (/\[\s*\]/.test(line)) warnings.push(`${section}: an empty [ ] in "${quote}"`);
    let depth = 0, unbalanced = false;
    for (const ch of line) {
      if (ch === "[") { depth++; if (depth > 1) unbalanced = true; }
      else if (ch === "]") { depth--; if (depth < 0) { unbalanced = true; depth = 0; } }
    }
    if (depth !== 0 || unbalanced) warnings.push(`${section}: a [ or ] without its pair in "${quote}"`);
    for (const m of line.matchAll(/\[([^[\]]{81,})\]/g)) warnings.push(`${section}: "[${m[1].slice(0, 30)}...]" is longer than 80 characters and stays text`);
  });
  return warnings;
}

/**
 * Word splits a token across runs when part of it was formatted or spell-checked separately ("[Student <b>Name</b>]"). The token's text
 * is joined back together and the tags that were inside it follow it, so the markup stays balanced.
 */
export function joinSplitTokens(html: string): string {
  return html.replace(/\[((?:[^[\]<>]|<[^>]*>){1,600}?)\]/g, (whole, inner: string) => {
    if (!inner.includes("<")) return whole;
    const text = inner.replace(/<[^>]*>/g, "");
    if (text.length > 80 || !isTokenName(decodeEntities(text))) return whole;
    const tags = inner.match(/<[^>]*>/g) ?? [];
    return `[${text}]${tags.join("")}`;
  });
}
