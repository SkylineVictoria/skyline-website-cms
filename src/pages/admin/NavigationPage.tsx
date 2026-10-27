import { useMemo, useState } from "react";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { NavMenuItem } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { NAV_LIMITS, validateNavigation } from "@/config/cmsLimits";
import { normalizeCmsPath } from "@/lib/cmsPath";
import { SiteHeaderView } from "@/components/feature/SiteHeader";
import { previewNavigation, publicLikeSettings } from "@/pages/admin/lib/previewModels";
import { siteThemeFromSettings } from "@/pages/admin/lib/previewTheme";
import { tenantThemeStyle } from "@/lib/tenantTheme";

const counter = (used: number, max: number) => (
  <span className={`text-xs ${used >= max ? "font-semibold text-primary-700" : "text-foreground-500"}`} aria-live="polite">{used}/{max}</span>
);

export default function NavigationPage() {
  const { data, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const draftApi = useDraft<NavMenuItem[]>("navigation", "navigation", data.navigation);
  const items = draftApi.value;
  const setItems = draftApi.setValue;

  // "Add a page to the menu" form state (not part of the saved draft).
  const [pick, setPick] = useState("");
  const [pickLabel, setPickLabel] = useState("");
  const [pickParent, setPickParent] = useState("top");
  const [previewWidth, setPreviewWidth] = useState(1280);

  const pagePath = (slug: string) => normalizeCmsPath(slug);
  const pageByPath = useMemo(() => new Map(data.pages.map((p) => [pagePath(p.slug), p] as const).filter(([path]) => path)), [data.pages]);
  const inMenu = useMemo(() => new Set(items.flatMap((i) => [i.to, ...i.children.map((c) => c.to)]).map((to) => pagePath(to)).filter(Boolean)), [items]);
  const published = data.pages.filter((p) => p.status === "Published" && pagePath(p.slug));
  const available = published.filter((p) => !inMenu.has(pagePath(p.slug)));
  const problems = validateNavigation(items);
  const topFull = items.length >= NAV_LIMITS.maxTopLevel;
  const parentFull = pickParent !== "top" && (items.find((i) => i.id === pickParent)?.children.length ?? 0) >= NAV_LIMITS.maxChildren;

  const setItem = (i: number, patch: Partial<NavMenuItem>) => setItems((prev) => prev.map((x, xi) => (xi === i ? { ...x, ...patch } : x)));
  const setChild = (i: number, j: number, patch: Partial<NavMenuItem["children"][number]>) =>
    setItems((prev) => prev.map((x, xi) => (xi === i ? { ...x, children: x.children.map((c, ci) => (ci === j ? { ...c, ...patch } : c)) } : x)));
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[i], next[target]] = [next[target], next[i]];
    setItems(next);
  };

  const choosePage = (slug: string) => {
    setPick(slug);
    const page = published.find((p) => p.slug === slug);
    setPickLabel(page ? (page.name || page.title).slice(0, NAV_LIMITS.maxLabelLength) : "");
  };
  const addPage = () => {
    const page = published.find((p) => p.slug === pick);
    const path = page ? pagePath(page.slug) : null;
    if (!page || !path || !pickLabel.trim()) return;
    if (pickParent === "top") {
      if (topFull) return;
      setItems((prev) => [...prev, { id: `nav-${Date.now()}`, label: pickLabel.trim(), to: path, visible: true, children: [] }]);
    } else {
      if (parentFull) return;
      setItems((prev) => prev.map((x) => (x.id === pickParent ? { ...x, children: [...x.children, { id: `child-${Date.now()}`, label: pickLabel.trim(), to: path, external: false, visible: true }] } : x)));
    }
    setPick(""); setPickLabel(""); setPickParent("top");
  };

  const save = async () => {
    if (problems.length) { push(problems[0], "error"); return; }
    try {
      await saveNow((d) => ({ ...d, navigation: items }));
      draftApi.markSaved();
      recordRevision({ entity: "navigation", entityId: "navigation", title: "Header navigation", action: "Saved draft", status: "Draft", snapshot: items });
      logActivity("Updated", "Header navigation", "Navigation");
      push("Navigation saved");
    } catch (e) { push(e instanceof Error ? e.message : "Navigation save failed", "error"); }
  };

  const unpublishedNote = (to: string) => {
    const page = pageByPath.get(pagePath(to) ?? "");
    return page && page.status !== "Published" ? <p className="mt-1 text-xs text-primary-700">This page is not published, so visitors will see a missing page.</p> : null;
  };

  return (
    <div>
      <PageHeader
        title="Header & Navigation"
        description={`The main menu: up to ${NAV_LIMITS.maxTopLevel} top-level items, ${NAV_LIMITS.maxChildren} per dropdown, labels up to ${NAV_LIMITS.maxLabelLength} characters. On narrow screens extra items move into a "More" menu automatically.`}
        breadcrumb="Global"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DraftStatus draft={draftApi} />
            <HistoryButton entity="navigation" entityId="navigation" title="Header navigation" onRestore={(snap) => setItems(snap as NavMenuItem[])} />
            <Button icon="ri-save-line" onClick={save}>Save navigation</Button>
          </div>
        }
      />

      <Card className="mb-5 p-5">
        <h2 className="font-heading text-base font-semibold">Add a page to the menu</h2>
        <p className="mt-1 text-xs text-foreground-500">Only published pages can be added. New and edited pages appear in the public header once the navigation is saved.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1fr_1fr_auto] md:items-end">
          <Field label="Published page">
            <Select aria-label="Published page" value={pick} onChange={(e) => choosePage(e.target.value)}>
              <option value="">{available.length ? "Choose a page…" : "All published pages are already in the menu"}</option>
              {available.map((p) => <option key={p.id} value={p.slug}>{p.name || p.title} (/{p.slug.replace(/^\//, "")})</option>)}
            </Select>
          </Field>
          <Field label={`Menu label (${pickLabel.length}/${NAV_LIMITS.maxLabelLength})`}>
            <TextInput aria-label="Menu label" value={pickLabel} maxLength={NAV_LIMITS.maxLabelLength} onChange={(e) => setPickLabel(e.target.value)} />
          </Field>
          <Field label="Place in">
            <Select aria-label="Place in" value={pickParent} onChange={(e) => setPickParent(e.target.value)}>
              <option value="top">Top level</option>
              {items.map((i) => <option key={i.id} value={i.id}>Dropdown: {i.label || "Untitled"} ({i.children.length}/{NAV_LIMITS.maxChildren})</option>)}
            </Select>
          </Field>
          <Button icon="ri-add-line" disabled={!pick || !pickLabel.trim() || (pickParent === "top" ? topFull : parentFull)} onClick={addPage}>Add to menu</Button>
        </div>
        {pickParent === "top" && topFull ? <p className="mt-2 text-xs text-primary-700">The top level is full ({NAV_LIMITS.maxTopLevel} items). Remove an item or choose a dropdown.</p> : null}
        {parentFull ? <p className="mt-2 text-xs text-primary-700">That dropdown is full ({NAV_LIMITS.maxChildren} items).</p> : null}
      </Card>

      <Card className="mb-5 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-background-200 px-5 py-3">
          <i className="ri-eye-line text-primary-600" aria-hidden="true" />
          <h2 className="font-heading text-sm font-semibold text-foreground-950">Header preview</h2>
          <span className="text-xs text-foreground-500">Live: unsaved edits, rendered by the public header. Narrow the window to see items move into "More".</span>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="header-preview-width" className="text-xs text-foreground-500">Window width</label>
            <Select id="header-preview-width" aria-label="Preview width" value={previewWidth} onChange={(e) => setPreviewWidth(Number(e.target.value))}>
              <option value={1440}>1440 px</option>
              <option value={1280}>1280 px</option>
              <option value={1100}>1100 px</option>
              <option value={1024}>1024 px</option>
            </Select>
          </div>
        </div>
        <div className="min-h-[360px] overflow-x-auto bg-background-100 p-3">
          <div
            className="mx-auto font-body"
            style={{ width: previewWidth, ...tenantThemeStyle(siteThemeFromSettings(data.settings)) }}
            onClickCapture={(event) => { if ((event.target as Element).closest("a, button[type=submit]")) event.preventDefault(); }}
            onSubmitCapture={(event) => event.preventDefault()}
          >
            <SiteHeaderView preview navigation={previewNavigation(items)} settings={publicLikeSettings(data.settings)} />
          </div>
        </div>
        <p className="border-t border-background-200 px-5 py-2 text-[11px] text-foreground-500">The desktop menu appears at 1024 px and wider; below that visitors get the mobile menu. Course mega-menus and page links are not followed in the preview.</p>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold">Menu items</h2>
          <span className="text-xs text-foreground-500">Top level {counter(items.length, NAV_LIMITS.maxTopLevel)}</span>
        </div>
        <div className="space-y-4">
          {items.map((item, i) => (
            <div key={item.id} className="rounded-md border border-background-200 p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[28px_1fr_1fr_auto] md:items-start">
                <div className="flex md:flex-col">
                  <button type="button" onClick={() => move(i, -1)} aria-label="Move up" className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600">
                    <i className="ri-arrow-up-s-fill" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => move(i, 1)} aria-label="Move down" className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600">
                    <i className="ri-arrow-down-s-fill" aria-hidden="true" />
                  </button>
                </div>
                <div>
                  <TextInput aria-label={`Menu label ${i + 1}`} value={item.label} maxLength={NAV_LIMITS.maxLabelLength} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="Menu label" />
                  <span className="mt-0.5 block text-right text-[11px] text-foreground-400">{item.label.length}/{NAV_LIMITS.maxLabelLength}</span>
                </div>
                <div>
                  <TextInput aria-label={`Menu link ${i + 1}`} value={item.to} onChange={(e) => setItem(i, { to: e.target.value })} placeholder="Link (e.g. /about-us)" />
                  {unpublishedNote(item.to)}
                </div>
                <div className="flex items-center gap-3">
                  <Toggle checked={item.visible} onChange={(v) => setItem(i, { visible: v })} label="Visible" />
                  <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => setItems((prev) => prev.filter((_, xi) => xi !== i))}>
                    <i className="ri-delete-bin-line" aria-hidden="true" />
                  </Button>
                </div>
              </div>

              {item.children.length > 0 ? (
                <div className="mt-3 space-y-2 border-l-2 border-background-200 pl-4">
                  <p className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-foreground-500">Dropdown items {counter(item.children.length, NAV_LIMITS.maxChildren)}</p>
                  {item.children.map((c, j) => (
                    <div key={c.id} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                      <TextInput aria-label={`Dropdown label ${i + 1}.${j + 1}`} value={c.label} maxLength={NAV_LIMITS.maxLabelLength} onChange={(e) => setChild(i, j, { label: e.target.value })} placeholder="Label" />
                      <div>
                        <TextInput aria-label={`Dropdown link ${i + 1}.${j + 1}`} value={c.to} onChange={(e) => setChild(i, j, { to: e.target.value })} placeholder="Link" />
                        {unpublishedNote(c.to)}
                      </div>
                      <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => setItem(i, { children: item.children.filter((_, ci) => ci !== j) })}>
                        <i className="ri-delete-bin-line" aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                disabled={item.children.length >= NAV_LIMITS.maxChildren}
                onClick={() => setItem(i, { children: [...item.children, { id: `child-${Date.now()}`, label: "", to: "", external: false, visible: true }] })}
                className="mt-3 inline-flex cursor-pointer items-center gap-1 text-[13px] font-medium text-primary-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
              >
                <i className="ri-add-line" aria-hidden="true" />
                {item.children.length >= NAV_LIMITS.maxChildren ? `Dropdown full (${NAV_LIMITS.maxChildren} items)` : "Add dropdown item"}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="outline" icon="ri-add-line" disabled={topFull} onClick={() => setItems((prev) => [...prev, { id: `nav-${Date.now()}`, label: "", to: "", visible: true, children: [] }])}>
            Add custom item
          </Button>
          {topFull ? <span className="text-xs text-primary-700">Limit reached: the menu holds at most {NAV_LIMITS.maxTopLevel} top-level items.</span> : null}
        </div>
        {problems.length ? <ul className="mt-3 list-disc pl-5 text-xs text-primary-700" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </Card>

      <div className="mt-5 flex items-center justify-end gap-3">
        <DraftStatus draft={draftApi} />
        <Button icon="ri-save-line" onClick={save}>Save navigation</Button>
      </div>
    </div>
  );
}
