/** Connector lines of the indented tree (.org-tree) and the top-down chart (.org-chart): Employees org chart, Jobs and Candidates trees.
 * Colours come from the theme tokens, so light and dark both work. */
export const ORG_CSS = `
.org-tree{list-style:none;margin:0;padding-left:1.75rem;position:relative}
.org-tree-root{padding-left:0}
.org-tree .org-tree-item{position:relative;padding-top:.5rem}
.org-tree:not(.org-tree-root)>.org-tree-item::before{content:"";position:absolute;left:-1rem;top:0;bottom:0;border-left:2px solid oklch(var(--background-300))}
.org-tree:not(.org-tree-root)>.org-tree-item:last-child::before{bottom:auto;height:2.4rem}
.org-tree:not(.org-tree-root)>.org-tree-item::after{content:"";position:absolute;left:-1rem;top:2.4rem;width:1rem;border-top:2px solid oklch(var(--background-300))}
.org-chart{display:inline-block;min-width:100%;text-align:center}
.org-chart ul{display:flex;justify-content:safe center;width:max-content;min-width:100%;padding-top:1.25rem;position:relative;list-style:none;margin:0}
.org-chart>ul{padding-top:0}
.org-chart li{position:relative;padding:1.25rem .5rem 0;display:flex;flex-direction:column;align-items:safe center;flex-shrink:0}
.org-chart>ul>li{padding-top:0}
.org-chart>ul>li::before,.org-chart>ul>li::after{display:none}
.org-chart li::before,.org-chart li::after{content:"";position:absolute;top:0;right:50%;width:50%;height:1.25rem;border-top:2px solid oklch(var(--background-300))}
.org-chart li::after{right:auto;left:50%;border-left:2px solid oklch(var(--background-300))}
.org-chart li:only-child::before,.org-chart li:only-child::after{display:none}
.org-chart li:only-child{padding-top:1.25rem}
.org-chart>ul>li:only-child{padding-top:0}
.org-chart li:first-child::before,.org-chart li:last-child::after{border:0 none}
.org-chart li:last-child::before{border-right:2px solid oklch(var(--background-300))}
.org-chart ul ul::before{content:"";position:absolute;top:0;left:50%;height:1.25rem;border-left:2px solid oklch(var(--background-300))}
.org-chart ul ul>li:only-child::before{display:block;border:0;border-left:2px solid oklch(var(--background-300));width:0;left:50%;right:auto;height:1.25rem}
.org-chart ul ul{padding-top:1.25rem}
`;
