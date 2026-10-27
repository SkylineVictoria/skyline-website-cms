// One place for every CMS layout limit. The editors show counters and disable "add" at these limits, and the same validators run again
// on save (store commit), so a limit cannot be bypassed by a stale tab, an import or a restored revision.

export const FOOTER_LIMITS = { maxLinksPerColumn: 8, maxLabelLength: 30 } as const;
export const NAV_LIMITS = { maxTopLevel: 7, maxChildren: 6, maxLabelLength: 22 } as const;
export const LOADER_STYLES = ["ring", "bar", "dots"] as const;
export type LoaderStyle = (typeof LOADER_STYLES)[number];

export interface LinkLike { label: string; to: string }
export interface NavLike { label: string; visible?: boolean; children: LinkLike[] }

/** Returns human-readable problems; an empty list means the footer links are within the limits. */
export function validateFooterLinks(columns: { title: string; links: LinkLike[] | undefined }[]): string[] {
  const problems: string[] = [];
  for (const column of columns) {
    const links = column.links ?? [];
    if (links.length > FOOTER_LIMITS.maxLinksPerColumn) problems.push(`${column.title} can have at most ${FOOTER_LIMITS.maxLinksPerColumn} links (it has ${links.length}).`);
    for (const link of links) {
      if (link.label.length > FOOTER_LIMITS.maxLabelLength) problems.push(`"${link.label.slice(0, 20)}…" in ${column.title} is longer than ${FOOTER_LIMITS.maxLabelLength} characters.`);
      if (!link.label.trim() || !link.to.trim()) problems.push(`Every link in ${column.title} needs a label and a destination.`);
    }
  }
  return problems;
}

export function validateNavigation(items: NavLike[]): string[] {
  const problems: string[] = [];
  if (items.length > NAV_LIMITS.maxTopLevel) problems.push(`The main menu can have at most ${NAV_LIMITS.maxTopLevel} top-level items (it has ${items.length}).`);
  for (const item of items) {
    if (item.label.length > NAV_LIMITS.maxLabelLength) problems.push(`"${item.label.slice(0, 18)}…" is longer than ${NAV_LIMITS.maxLabelLength} characters.`);
    if (item.children.length > NAV_LIMITS.maxChildren) problems.push(`"${item.label || "Untitled"}" can have at most ${NAV_LIMITS.maxChildren} dropdown items (it has ${item.children.length}).`);
    for (const child of item.children) {
      if (child.label.length > NAV_LIMITS.maxLabelLength) problems.push(`"${child.label.slice(0, 18)}…" is longer than ${NAV_LIMITS.maxLabelLength} characters.`);
    }
  }
  return problems;
}
