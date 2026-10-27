/** Canonical CMS paths are local, case-insensitive and segment-based. */
export function normalizeCmsPath(value: string): string | null {
  const raw = value.trim();
  const hasControls = (text: string) => Array.from(text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!raw || /[:?#\\]/.test(raw) || hasControls(raw)) return null;
  try {
    const segments = raw.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment).normalize("NFC").toLowerCase());
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[%/?#:\\\s]/.test(segment) || hasControls(segment))) return null;
    return `/${segments.join("/")}`;
  } catch { return null; }
}

/** Operational and resource routes must never be replaced by CMS pages. */
export function isReservedCmsPath(path: string): boolean {
  return /^(?:\/(?:admin|agency|auth|api|rest|storage|functions|assets|src|node_modules|courses|forms)(?:\/|$)|\/(?:forgot-password|reset-password)(?:\/|$)|\/@)/.test(path);
}

/** Normalize before indexing; ambiguous aliases fail closed instead of winning by row order. */
export function indexCmsPages<T>(rows: { slug: string; page: T }[]): Record<string, T> {
  const pages = new Map<string, T>();
  const collisions = new Set<string>();
  for (const { slug, page } of rows) {
    const path = normalizeCmsPath(slug);
    if (!path || path === "/" || isReservedCmsPath(path)) continue;
    const key = path.slice(1);
    if (pages.has(key)) collisions.add(key);
    else pages.set(key, page);
  }
  for (const key of collisions) pages.delete(key);
  return Object.fromEntries(pages);
}

export function cmsPageAtPath<T>(pages: Record<string, T>, pathname: string): T | undefined {
  const path = normalizeCmsPath(pathname);
  if (!path || isReservedCmsPath(path)) return undefined;
  const key = path === "/" ? "home" : path.slice(1);
  return Object.hasOwn(pages, key) ? pages[key] : undefined;
}
