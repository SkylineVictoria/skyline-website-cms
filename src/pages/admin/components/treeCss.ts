/** Connector lines of the indented tree (.org-tree): Jobs and Candidates trees.
 * Colours come from the theme tokens, so light and dark both work. */
export const ORG_CSS = `
.org-tree{list-style:none;margin:0;padding-left:1.75rem;position:relative}
.org-tree-root{padding-left:0}
.org-tree .org-tree-item{position:relative;padding-top:.5rem}
.org-tree:not(.org-tree-root)>.org-tree-item::before{content:"";position:absolute;left:-1rem;top:0;bottom:0;border-left:2px solid oklch(var(--background-300))}
.org-tree:not(.org-tree-root)>.org-tree-item:last-child::before{bottom:auto;height:2.4rem}
.org-tree:not(.org-tree-root)>.org-tree-item::after{content:"";position:absolute;left:-1rem;top:2.4rem;width:1rem;border-top:2px solid oklch(var(--background-300))}
`;
