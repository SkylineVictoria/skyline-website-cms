import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Modal } from "../ui";
import LetterPreview, { VariableCheck } from "@/components/shared/offer-letter/LetterPreview";
import { loadLetterRegistry, sampleValues, testApplications, testLetterValues, type LetterValues } from "@/lib/offerLetters";
import type { SigningTemplate } from "@/lib/signingApi";
import { replaceToken, unmappedTokens, type LetterVariable } from "../../../../../supabase/functions/_shared/letter-variables";
import type { Sections } from "@/lib/templateSections";

type Template = Sections & { title: string };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/**
 * HRMS > Templates: student offer letter (LOO) templates with name, version, last updated and active / inactive. A template with
 * unmapped tokens shows how many and cannot be made active (the database refuses it too).
 */
export function LetterTemplatesCard({ templates, busy, onNew, onEdit, onPreview, onDuplicate, onActive, onDefault, onDelete }: {
  templates: SigningTemplate[]; busy: string; onNew: () => void; onEdit: (t: SigningTemplate) => void; onPreview: (t: SigningTemplate) => void; onDuplicate: (t: SigningTemplate) => void;
  onActive: (t: SigningTemplate, active: boolean) => void; onDefault: (t: SigningTemplate) => void; onDelete: (t: SigningTemplate) => void;
}) {
  const [registry, setRegistry] = useState<LetterVariable[]>([]);
  useEffect(() => { void loadLetterRegistry().then(setRegistry, () => setRegistry([])); }, []);
  return (
    <Card className="p-5"><section data-testid="templates-offer-letters">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-bold text-foreground-950">Student offer letters (LOO)</h2>
          <p className="text-sm text-foreground-600">The letter of offer sent from an application (Take action › Issue offer letter): header, body and footer with {"{{variables}}"} filled from the application, course, fees, agent and institute.</p>
        </div>
        <Button size="sm" variant="outline" icon="ri-add-line" onClick={onNew} data-testid="template-new-offer-letter">New offer letter</Button>
      </div>
      {templates.length ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-foreground-500"><tr><th className="py-1 font-medium">Name</th><th className="py-1 font-medium">Version</th><th className="py-1 font-medium">Last updated</th><th className="py-1 font-medium">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-background-200">
            {templates.map((t) => {
              const unmapped = registry.length ? unmappedTokens(`${t.title}\n${t.header_html ?? ""}\n${t.body_html ?? ""}\n${t.footer_html ?? ""}`, registry).length : 0;
              const active = t.status === "active";
              return (
                <tr key={t.id} data-testid="letter-template-row" data-template-id={t.id}>
                  <td className="py-2 pr-2 font-semibold text-foreground-950">{t.name}{t.is_default ? <span className="ml-2 align-middle"><Badge tone="success">Default</Badge></span> : null}
                    {unmapped ? <span className="ml-2 align-middle text-xs font-normal text-amber-800" data-testid="letter-template-unmapped">{unmapped} unmapped</span> : null}</td>
                  <td className="py-2 pr-2">v{t.version}</td>
                  <td className="py-2 pr-2">{day(t.updated_at)}</td>
                  <td className="py-2 pr-2" data-testid="letter-template-status">{active ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Inactive</Badge>}</td>
                  <td className="py-2 text-right">
                    <span className="inline-flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => onPreview(t)}>Preview</Button>
                      <Button size="sm" variant="outline" onClick={() => onEdit(t)} data-testid="letter-template-edit">Edit</Button>
                      <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => onDuplicate(t)}>Duplicate</Button>
                      <Button size="sm" variant="outline" disabled={Boolean(busy) || (!active && unmapped > 0) || (active && t.is_default)} onClick={() => onActive(t, !active)} data-testid="letter-template-toggle"
                        title={!active && unmapped ? "Map every variable before making it active" : active && t.is_default ? "Make another template the default first" : undefined}>{active ? "Make inactive" : "Make active"}</Button>
                      {active && !t.is_default ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => onDefault(t)}>Make default</Button> : null}
                      {t.is_default ? null : <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => onDelete(t)}>Delete</Button>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="text-sm text-foreground-500">No offer letter templates yet.</p>}
    </section></Card>
  );
}

/**
 * Unmapped tokens of an offer letter template ({{unknown}}, $[field], {field:inline}, an old [Variable]): each with "Map to variable"
 * (the suggested one chosen) and one click to convert it everywhere; "Convert all" takes every suggestion. A template with any left is
 * saved inactive and cannot be made active.
 */
export function UnmappedTokens({ template, registry, onChange }: { template: Template; registry: readonly LetterVariable[]; onChange: (patch: Partial<Template>) => void }) {
  const all = `${template.title}\n${template.header_html}\n${template.body_html}\n${template.footer_html}`;
  const tokens = useMemo(() => unmappedTokens(all, registry), [all, registry]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (!tokens.length) return <p className="text-sm text-emerald-800" data-testid="unmapped-none"><i className="ri-check-line" aria-hidden="true" /> Every variable maps to the registry.</p>;
  const convert = (pairs: Array<[string, string]>) => {
    const patch: Partial<Template> = {};
    for (const field of ["title", "header_html", "body_html", "footer_html"] as const) {
      let text = template[field];
      for (const [token, key] of pairs) text = replaceToken(text, token, key);
      if (text !== template[field]) patch[field] = text;
    }
    onChange(patch);
  };
  const suggested = tokens.filter((t) => t.suggestion).map((t) => [t.token, choice[t.token] || t.suggestion!.key] as [string, string]);
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3" data-testid="unmapped-tokens">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-amber-950">{tokens.length === 1 ? "1 token is not mapped to a variable" : `${tokens.length} tokens are not mapped to a variable`}</p>
        {suggested.length > 1 ? <Button size="sm" variant="outline" onClick={() => convert(suggested)} data-testid="unmapped-convert-all">Convert all suggested</Button> : null}
      </div>
      <p className="mb-2 text-xs text-amber-900">Until each is mapped, the template is saved as inactive and cannot be used to send a letter.</p>
      <ul className="space-y-1.5">
        {tokens.map((t) => {
          const key = choice[t.token] || t.suggestion?.key || "";
          return (
            <li key={t.token} className="flex flex-wrap items-center gap-2 text-sm" data-testid="unmapped-token" data-token={t.token}>
              <code className="rounded bg-background-50 px-1.5 py-0.5 text-xs text-red-800">{t.token}</code>
              <span className="text-xs text-amber-900">{t.kind === "legacy" ? "old placeholder" : t.kind === "modifier" ? "unknown modifier (use |upper, |lower, |title or |raw)" : "not a variable"}</span>
              <label className="sr-only" htmlFor={`map-${t.token}`}>Map {t.token} to variable</label>
              <select id={`map-${t.token}`} value={key} onChange={(e) => setChoice((c) => ({ ...c, [t.token]: e.target.value }))} data-testid="unmapped-map-select"
                className="h-8 rounded border border-background-300 bg-background-50 px-2 text-xs">
                <option value="">Map to variable…</option>
                {registry.map((v) => <option key={v.key} value={v.key}>{v.group} · {v.label}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={!key} onClick={() => convert([[t.token, key]])} data-testid="unmapped-convert">Map to variable</Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "Preview with sample application" and "Test with application": the letter made from the template being edited, with the sample
 * values or a chosen application's real values, and the Variable check (value and source of each variable).
 */
export function LetterTestDialog({ template, registry, mode: initial, onClose }: { template: Template; registry: readonly LetterVariable[]; mode: "sample" | "application"; onClose: () => void }) {
  const [mode, setMode] = useState(initial);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<Awaited<ReturnType<typeof testApplications>> | null>(null);
  const [appId, setAppId] = useState("");
  const [values, setValues] = useState<LetterValues | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "application") return;
    const timer = window.setTimeout(() => { void testApplications(search).then(setApps, (e: Error) => setError(e.message)); }, 250);
    return () => window.clearTimeout(timer);
  }, [mode, search]);
  useEffect(() => {
    if (mode !== "application" || !appId) { setValues(null); return; }
    void testLetterValues(appId).then(setValues, (e: Error) => setError(e.message));
  }, [mode, appId]);
  const html = `${template.title}\n${template.header_html}\n${template.body_html}\n${template.footer_html}`;
  const shownValues = mode === "sample" ? sampleValues(registry) : values?.values ?? null;

  return (
    <Modal open title={mode === "sample" ? "Preview with sample application" : "Test with application"} width="max-w-6xl" onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="space-y-3" data-testid="letter-test-dialog">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" onClick={() => setMode("sample")} className={`rounded-md px-3 py-1.5 ${mode === "sample" ? "bg-primary-500 text-background-50" : "border border-background-300"}`}>Sample application</button>
          <button type="button" onClick={() => setMode("application")} className={`rounded-md px-3 py-1.5 ${mode === "application" ? "bg-primary-500 text-background-50" : "border border-background-300"}`} data-testid="letter-test-mode-application">A real application</button>
          {mode === "application" ? <>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reference or student name" aria-label="Find an application"
              className="h-9 w-56 rounded-md border border-background-300 bg-background-50 px-2" />
            <select value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="Application" data-testid="letter-test-application" className="h-9 min-w-56 rounded-md border border-background-300 bg-background-50 px-2">
              <option value="">{apps === null ? "Loading…" : apps.length ? "Choose an application" : "No applications found"}</option>
              {(apps ?? []).map((a) => <option key={a.id} value={a.id}>{a.reference} · {a.studentName || "Unnamed"} ({a.status.replaceAll("_", " ")})</option>)}
            </select>
          </> : null}
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {shownValues ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <LetterPreview input={{ template: { title: template.title, headerHtml: template.header_html, bodyHtml: template.body_html, footerHtml: template.footer_html }, registry, values: shownValues, sample: mode === "sample" }} />
            <div><p className="mb-1 text-sm font-semibold">Variable check</p><VariableCheck html={html} registry={registry} values={shownValues} /></div>
          </div>
        ) : mode === "application" ? <p className="text-sm text-foreground-500">Choose an application to see the letter with its details.</p> : null}
      </div>
    </Modal>
  );
}
