import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, PageHeader, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { FooterConfig } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { siteThemeFromSettings } from "@/pages/admin/lib/previewTheme";
import { tenantThemeStyle } from "@/lib/tenantTheme";
import { FOOTER_LIMITS, validateFooterLinks } from "@/config/cmsLimits";
import SiteFooterView, { type FooterViewModel } from "@/components/feature/SiteFooterView";
import { footerLinks as builtInQuickLinks, studentLinks as builtInStudentLinks } from "@/data/site";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { footerLogos } from "@/config/brandFallbacks";
import { publicLikeSettings } from "@/pages/admin/lib/previewModels";

type LinkColumn = "quickLinks" | "studentLinks";
const COLUMNS: { key: LinkColumn; title: string; noun: string }[] = [
  { key: "quickLinks", title: "Quick links", noun: "quick link" },
  { key: "studentLinks", title: "Student links", noun: "student link" },
];

export default function FooterPage() {
  const { data, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const draftApi = useDraft<FooterConfig>("footer", "footer", data.footer);
  const draft = draftApi.value;
  const setDraft = draftApi.setValue;

  const set = <K extends keyof FooterConfig>(key: K, value: FooterConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // Same rule as the public data layer: a tenant or a configured footer uses the saved links; the legacy site otherwise shows its built-in links.
  const usesSaved = Boolean(requestWebsiteDomain()) || Boolean(draft.linksConfigured);
  const links = (key: LinkColumn) => (usesSaved ? draft[key] ?? [] : key === "quickLinks" ? builtInQuickLinks : builtInStudentLinks).map((l) => ({ label: l.label, to: l.to }));
  const setLinks = (key: LinkColumn, next: { label: string; to: string }[]) => setDraft((d) => ({ ...d, linksConfigured: true, [key]: next }));

  const problems = validateFooterLinks(COLUMNS.map((c) => ({ title: c.title, links: links(c.key) })));

  const save = async () => {
    if (problems.length) { push(problems[0], "error"); return; }
    try {
      await saveNow((d) => ({ ...d, footer: draft }));
      draftApi.markSaved();
      recordRevision({ entity: "footer", entityId: "footer", title: "Footer", action: "Saved draft", status: "Draft", snapshot: draft });
      logActivity("Updated", "Footer", "Footer");
      push("Footer saved");
    } catch (e) { push(e instanceof Error ? e.message : "Footer save failed", "error"); }
  };

  const settings = data.settings;
  // The preview feeds the SAME footer component the public site uses with the unsaved form state (links, titles, text) and the site theme.
  const shown = publicLikeSettings(settings);
  const logos = footerLogos(settings.logo, Boolean(requestWebsiteDomain()));
  const model: FooterViewModel = {
    footer: draft,
    quickLinks: links("quickLinks"),
    studentLinks: links("studentLinks"),
    acknowledgementLogo: logos.acknowledgement,
    mainLogo: logos.main,
    logoAlt: shown.logoAlt,
    social: shown.social,
    legal: shown.legal,
    contact: { address: shown.address, phone: shown.phone, phoneHref: shown.phoneHref, email: shown.email, emailHref: shown.emailHref },
  };

  return (
    <div>
      <PageHeader
        title="Footer"
        description="The site-wide footer: about text, link column headings, acknowledgement and copyright."
        breadcrumb="Global"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DraftStatus draft={draftApi} />
            <HistoryButton entity="footer" entityId="footer" title="Footer" onRestore={(snap) => setDraft(snap as FooterConfig)} />
            <Button icon="ri-save-line" onClick={save}>Save footer</Button>
          </div>
        }
      />

      <Card className="mb-5 p-5">
        <h2 className="font-heading text-base font-semibold">Footer links</h2>
        <p className="mt-1 text-xs text-foreground-500">Up to {FOOTER_LIMITS.maxLinksPerColumn} links per column, labels up to {FOOTER_LIMITS.maxLabelLength} characters. An empty column is hidden on the website.</p>
        {COLUMNS.map(({ key, title, noun }) => {
          const list = links(key);
          const atLimit = list.length >= FOOTER_LIMITS.maxLinksPerColumn;
          return (
            <div key={key} className="my-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{title}</h3>
                <span className={`text-xs ${atLimit ? "font-semibold text-primary-700" : "text-foreground-500"}`} aria-live="polite">{list.length}/{FOOTER_LIMITS.maxLinksPerColumn} links</span>
              </div>
              {list.map((link, i) => (
                <div className="flex gap-2" key={i}>
                  <div className="flex-1">
                    <TextInput aria-label={`${title} label ${i + 1}`} value={link.label} maxLength={FOOTER_LIMITS.maxLabelLength} placeholder="Label" onChange={(e) => setLinks(key, list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <span className="mt-0.5 block text-right text-[11px] text-foreground-400">{link.label.length}/{FOOTER_LIMITS.maxLabelLength}</span>
                  </div>
                  <div className="flex-1">
                    <TextInput aria-label={`${title} destination ${i + 1}`} value={link.to} placeholder="/page" onChange={(e) => setLinks(key, list.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                  </div>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${title} ${i + 1}`} onClick={() => setLinks(key, list.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <Button variant="outline" disabled={atLimit} onClick={() => setLinks(key, [...list, { label: "", to: "/" }])}>Add {noun}</Button>
              {atLimit ? <p className="text-xs text-primary-700">Limit reached: remove a link to add another.</p> : null}
            </div>
          );
        })}
        {problems.length ? <ul className="mt-2 list-disc pl-5 text-xs text-primary-700" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Footer content</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <Field label="About / intro text">
              <TextArea rows={3} value={draft.about} onChange={(e) => set("about", e.target.value)} />
            </Field>
          </div>
          <Field label="Quick links column title">
            <TextInput value={draft.quickLinksTitle} onChange={(e) => set("quickLinksTitle", e.target.value)} />
          </Field>
          <Field label="Student links column title">
            <TextInput value={draft.studentLinksTitle} onChange={(e) => set("studentLinksTitle", e.target.value)} />
          </Field>
          <div className="lg:col-span-2">
            <Field label="Acknowledgement of Country">
              <TextArea rows={3} value={draft.acknowledgement} onChange={(e) => set("acknowledgement", e.target.value)} />
            </Field>
          </div>
          <Field label="Copyright line">
            <TextInput value={draft.copyright} onChange={(e) => set("copyright", e.target.value)} />
          </Field>
          <div className="flex items-end pb-2">
            <Toggle checked={draft.showAcknowledgement} onChange={(v) => set("showAcknowledgement", v)} label="Show acknowledgement band" />
          </div>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-background-200 px-5 py-3">
          <i className="ri-eye-line text-primary-600" aria-hidden="true" />
          <h2 className="font-heading text-sm font-semibold text-foreground-950">Footer preview</h2>
          <span className="ml-auto text-xs text-foreground-500">Live: shows unsaved edits, rendered by the public footer</span>
        </div>
        <div className="font-body" style={tenantThemeStyle(siteThemeFromSettings(settings))}>
          <SiteFooterView model={model} preview />
        </div>
      </Card>

      <div className="mt-5 flex items-center justify-end gap-3">
        <DraftStatus draft={draftApi} />
        <Button icon="ri-save-line" onClick={save}>Save footer</Button>
      </div>
    </div>
  );
}
