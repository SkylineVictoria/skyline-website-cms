import { useCallback, useEffect, useState } from "react";
import { Button, Modal } from "../ui";
import PdfPages from "@/components/signing/PdfPages";
import { LETTERHEAD_STYLES, FONT_FACES, MAX_HEADER_FIRST, type Brand } from "../../../../../supabase/functions/_shared/letterhead-design";
import type { GeneratedDesign } from "../../../../../supabase/functions/_shared/letterhead-engine";
import { LETTERHEAD_TARGETS, activeLetterhead, applyLetterhead, designLetterheads, loadBrand, renderSamples, type DesignBatch, type LetterheadTarget } from "@/lib/letterheadDesigner";

/**
 * LETTERHEAD-DESIGNER (owner 2026-11-28): Documents & Signatures › Letterhead designer. Five designs from the brand (Classic, Modern,
 * Minimal, Bold, Formal), each shown on a letter, an offer letter and a workbook page; every one has passed the rules (header height,
 * contrast, logo resolution, RTO / CRICOS on every page, two embeddable fonts, no overflow). The admin picks one and where it applies.
 */
export default function LetterheadDesigner({ onClose, onApplied }: { onClose: () => void; onApplied: (message: string) => void }) {
  const [brand, setBrand] = useState<(Brand & { warnings: string[] }) | null>(null);
  const [batch, setBatch] = useState<DesignBatch | null>(null);
  const [samples, setSamples] = useState<Record<number, Uint8Array>>({});
  const [seed, setSeed] = useState(() => Math.floor(Date.now() / 1000) % 100000);
  const [busy, setBusy] = useState<"" | "design" | "apply">("design");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<number | null>(null);
  const [choosing, setChoosing] = useState<number | null>(null);
  const [targets, setTargets] = useState<LetterheadTarget[]>(["application_form", "letter_of_offer", "document_templates"]);
  const [active, setActive] = useState<Awaited<ReturnType<typeof activeLetterhead>>>(null);

  const design = useCallback(async (b: Brand, s: number) => {
    setBusy("design"); setError(""); setSamples({});
    try {
      const next = await designLetterheads(b, s);
      setBatch(next);
      // previews, one design at a time so the first ones show quickly
      for (const [i, d] of next.designs.entries()) { const bytes = await renderSamples(d.spec, b); setSamples((prev) => ({ ...prev, [i]: bytes })); }
    } catch (e) { setError(e instanceof Error ? e.message : "The designs could not be made."); }
    finally { setBusy(""); }
  }, []);
  useEffect(() => {
    void (async () => {
      try { const b = await loadBrand(); setBrand(b); setActive(await activeLetterhead()); await design(b, seed); }
      catch (e) { setError(e instanceof Error ? e.message : "The brand could not be loaded."); setBusy(""); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the designer opens
  }, []);

  const more = () => { if (!brand) return; const s = seed + 1; setSeed(s); void design(brand, s); };
  const apply = async () => {
    if (choosing === null || !batch || !brand) return;
    setBusy("apply"); setError("");
    try {
      const d = batch.designs[choosing];
      await applyLetterhead(d, brand, targets);
      onApplied(`“${d.spec.name}” is now used for: ${LETTERHEAD_TARGETS.filter((t) => targets.includes(t.id)).map((t) => t.label).join(", ")}. Earlier versions stay restorable.`);
    } catch (e) { setError(e instanceof Error ? e.message : "The letterhead could not be applied."); }
    finally { setBusy(""); }
  };
  const all = targets.length === LETTERHEAD_TARGETS.length;

  if (preview !== null && batch && samples[preview]) return <Modal open fill title={`Preview: ${batch.designs[preview].spec.name}`} width="max-w-4xl" onClose={() => setPreview(null)}
    footer={<><Button variant="outline" onClick={() => setPreview(null)}>Back to the designs</Button><Button onClick={() => { setChoosing(preview); setPreview(null); }}>Use this one</Button></>}>
    <PdfPages source={samples[preview]} maxWidth={820} />
  </Modal>;

  if (choosing !== null && batch) return <Modal open title={`Use “${batch.designs[choosing].spec.name}”`} width="max-w-xl" onClose={() => setChoosing(null)}
    footer={<><Button variant="outline" disabled={busy === "apply"} onClick={() => setChoosing(null)}>Cancel</Button>
      <Button disabled={busy === "apply" || !targets.length} onClick={() => void apply()} data-testid="letterhead-apply">{busy === "apply" ? "Applying…" : "Apply letterhead"}</Button></>}>
    <div className="space-y-3 text-sm" data-testid="letterhead-targets">
      <div className="flex items-center justify-between"><p className="font-semibold">Where should it be used?</p>
        <Button size="sm" variant="outline" data-testid="letterhead-select-all" onClick={() => setTargets(all ? [] : LETTERHEAD_TARGETS.map((t) => t.id))}>{all ? "Clear all" : "Select all"}</Button></div>
      {LETTERHEAD_TARGETS.map((t) => <label key={t.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-background-300 p-3 hover:bg-background-100">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={targets.includes(t.id)} data-testid={`letterhead-target-${t.id}`}
          onChange={(e) => setTargets((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))} />
        <span><span className="block font-medium text-foreground-900">{t.label}</span><span className="block text-xs text-foreground-600">{t.hint}</span></span>
      </label>)}
      <p className="text-xs text-foreground-500">Templates change as new versions (restore an earlier one from the template's Versions); documents already made keep their own copy.</p>
      {error && <p role="alert" className="rounded-md border border-red-300 p-2 text-red-700">{error}</p>}
    </div>
  </Modal>;

  return <Modal open fill title="Letterhead designer" width="max-w-6xl" onClose={() => { if (busy !== "apply") onClose(); }}
    footer={<div className="flex w-full flex-wrap items-center gap-2"><span className="text-xs text-foreground-600">{batch?.note}</span><span className="flex-1" />
      <Button variant="outline" disabled={busy !== "" || !brand} onClick={more} data-testid="letterhead-more">{busy === "design" ? "Designing…" : "Generate 5 more"}</Button>
      <Button variant="outline" onClick={onClose}>Close</Button></div>}>
    <div className="space-y-4" data-testid="letterhead-designer">
      {brand && <section className="flex flex-wrap items-center gap-4 rounded-md border border-background-300 bg-background-100 p-3 text-sm" data-testid="letterhead-brand">
        {brand.logoSrc ? <img src={brand.logoSrc} alt="Logo" className="h-10 w-auto" /> : null}
        <div className="min-w-0"><p className="font-semibold">{brand.name || "Your organisation"}</p><p className="text-xs text-foreground-600">RTO {brand.rto || "—"} · CRICOS {brand.cricos || "—"}</p></div>
        <div className="flex items-center gap-1" title="Brand colours: from the logo and the website">{[...brand.siteColors, ...brand.logoColors].slice(0, 8).map((c) => <span key={c} className="h-5 w-5 rounded border border-background-300" style={{ backgroundColor: c }} title={c} />)}</div>
        <p className="text-xs text-foreground-600">Fonts: {FONT_FACES.sans} (sans) and {FONT_FACES.serif} (serif){brand.siteFonts.length ? ` · website: ${brand.siteFonts.join(", ")}` : ""}</p>
        {active ? <p className="w-full text-xs text-foreground-600">In use now: <strong>{active.name}</strong> ({active.designer === "ai" ? "AI" : "built-in"}, {new Date(active.appliedAt).toLocaleDateString()})</p> : null}
        {brand.warnings.map((w) => <p key={w} className="w-full rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{w}</p>)}
      </section>}
      {error && <p role="alert" className="rounded-md border border-red-300 p-3 text-sm text-red-700">{error}</p>}
      {!batch && busy === "design" ? <p role="status" className="text-sm">Designing five letterheads from your brand…</p> : null}
      {batch && !batch.designs.length && busy === "" ? <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="letterhead-none">
        No design passed every rule with the current brand details. Add the organisation name, RTO and CRICOS codes in Website Settings, then open the designer again.</p> : null}
      <div className="grid gap-4 lg:grid-cols-2" data-testid="letterhead-designs">
        {batch?.designs.map((d: GeneratedDesign, i: number) => <article key={`${seed}-${i}`} className="space-y-2 rounded-lg border border-background-300 p-3" data-testid="letterhead-design">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-foreground-950">{d.spec.name}</h3>
            <span className="rounded-full bg-background-200 px-2 py-0.5 text-2xs font-semibold uppercase">{LETTERHEAD_STYLES.find((s) => s.style === d.spec.style)?.label}</span>
            <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${d.designer === "ai" ? "bg-violet-100 text-violet-900" : "bg-background-200 text-foreground-700"}`}>{d.designer === "ai" ? "AI" : "Built-in"}</span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-2xs font-semibold text-emerald-900" data-testid="letterhead-checks"
              title={`Header ${Math.round(d.check.measures.headerFirst)} pt of ${Math.round(MAX_HEADER_FIRST)} pt · later pages ${Math.round(d.check.measures.headerLater)} pt · contrast ${d.check.measures.minContrast.toFixed(1)}:1 · RTO / CRICOS on every page`}>Passed all checks</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto rounded border border-background-200 bg-background-100 p-2">
            {samples[i] ? <PdfPages source={samples[i]} maxWidth={500} lazy /> : <p className="p-6 text-center text-xs text-foreground-500">Rendering the samples…</p>}
          </div>
          <p className="text-xs text-foreground-600">Letter, offer letter and workbook page · header {Math.round(d.check.measures.headerFirst)} pt (max {Math.round(MAX_HEADER_FIRST)}) · contrast {d.check.measures.minContrast.toFixed(1)}:1 · {d.spec.fonts.heading === d.spec.fonts.body ? FONT_FACES[d.spec.fonts.body] : `${FONT_FACES[d.spec.fonts.heading]} + ${FONT_FACES[d.spec.fonts.body]}`}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!samples[i]} onClick={() => setPreview(i)}>Preview</Button>
            <Button size="sm" onClick={() => setChoosing(i)} data-testid="letterhead-use">Use this one</Button>
          </div>
        </article>)}
      </div>
    </div>
  </Modal>;
}
