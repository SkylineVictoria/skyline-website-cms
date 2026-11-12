import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "../ui";
import LetterPreview, { VariableCheck } from "@/components/shared/offer-letter/LetterPreview";
import { sampleValues, testApplications, testLetterValues, type LetterValues } from "@/lib/offerLetters";
import { replaceToken, unmappedTokens, type LetterVariable } from "../../../../../supabase/functions/_shared/letter-variables";
import type { Sections } from "@/lib/templateSections";

type Template = Sections & { title: string };


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
