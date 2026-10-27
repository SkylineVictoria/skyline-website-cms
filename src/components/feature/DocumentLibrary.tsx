import { formsPoliciesPage } from "@/data/pages";
import { usePublicSite } from "@/hooks/publicSiteContext";

type DocGroup = {
  title: string;
  items: { label: string; href: string; external: boolean }[];
};

/** Static fallback used only until the database responds or if it has no documents. */
function staticGroups(): DocGroup[] {
  return formsPoliciesPage.blocks
    .filter(
      (block): block is Extract<(typeof formsPoliciesPage.blocks)[number], { type: "links" }> =>
        block.type === "links",
    )
    .map((block) => ({
      title: block.heading ?? "Documents",
      items: block.items.map((item) => ({
        label: item.label,
        href: item.href,
        external: Boolean(item.external),
      })),
    }));
}

export default function DocumentLibrary() {
  const { data, isLive } = usePublicSite();
  // Once the database is authoritative, use it verbatim (an intentionally empty
  // document list stays empty). Static links only fill the pre-load gap.
  const groups: DocGroup[] = isLive ? data.documentGroups : staticGroups();

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      {groups.map((group) => (
        <div key={group.title} className="rounded-card border border-background-200 bg-background-50">
          <div className="flex items-center justify-between gap-4 border-b border-background-200 px-5 py-4">
            <h2 className="font-heading text-lg font-bold text-foreground-950">{group.title}</h2>
            <span className="rounded-full bg-secondary-100 px-3 py-1 font-label text-xs font-semibold text-secondary-900">
              {group.items.length} documents
            </span>
          </div>

          <div className="max-h-[448px] overflow-y-auto overscroll-contain">
            <ul className="divide-y divide-background-200">
              {group.items.map((item) => (
                <li key={`${group.title}-${item.label}-${item.href}`}>
                  <a
                    href={item.href}
                    target={item.external ? "_blank" : undefined}
                    rel={item.external ? "noopener noreferrer" : undefined}
                    className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-background-100"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-100 text-primary-700">
                      <i className="ri-file-pdf-2-line text-lg" aria-hidden="true" />
                    </span>
                    <span className="flex-1 text-sm leading-snug text-foreground-800 group-hover:text-primary-700">
                      {item.label}
                    </span>
                    <i className="ri-download-2-line text-lg text-foreground-400 group-hover:text-primary-600" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <p className="border-t border-background-200 px-5 py-3 text-xs text-foreground-500">
            <i className="ri-mouse-line mr-1.5 align-middle" aria-hidden="true" />
            Scroll within the list to view and download all documents.
          </p>
        </div>
      ))}
    </div>
  );
}