/**
 * ASM-BUILDER (2026-11-25): Unit mapping in the wizard's design.
 *   - The unit's elements, performance criteria, performance evidence, knowledge evidence and assessment conditions come from
 *     training.gov.au by themselves (tga-course-import "unit_content", cached per unit code) the first time; "Refresh from
 *     training.gov.au" loads them again; "Edit unit elements" stays for anything training.gov.au does not hold.
 *   - Coverage gaps first: requirements no question maps to.
 *   - "Suggest mappings (AI)" (asm-import "suggest_mapping", the same provider as the import): suggestions are ticks to confirm,
 *     one click a row or "Confirm all" for a requirement, never mappings until confirmed; who confirmed is kept.
 *   - The matrix for anything else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import { Empty } from "@/pages/admin/components/rto/overlay";
import { MAPPABLE_KINDS, suggestionsByElement, tgaMerge, type MappingSuggestionRow, type TgaElement, type UnitElementRow } from "@/lib/assessment/unitElements";
import type { UnitMapping } from "@/lib/assessment/types";

const BTN_PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-background-300 bg-white px-3 py-2 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
/** A question of the workbook PDF template, keyed by its printed number (task.number): the mapping's key. */
export interface MapQuestion { key: string; number: string; label: string }
import { asmAdmin, ELEMENT_KINDS, kindShort, type UnitElement } from "@/pages/admin/lib/assessments";
import { supabase } from "@/pages/admin/lib/supabase";
import { invokeTga } from "@/pages/admin/lib/tga";

const CARD = "overflow-hidden rounded-xl border border-background-200 bg-white";
const CARD_HEAD = "flex flex-wrap items-center justify-between gap-2 border-b border-background-200 bg-background-50 px-4 py-2.5";
const KIND_TONE: Record<string, string> = { element: "bg-background-100 text-foreground-700", performance_criterion: "bg-sky-100 text-sky-900", performance_evidence: "bg-indigo-100 text-indigo-900", knowledge_evidence: "bg-violet-100 text-violet-900", assessment_condition: "bg-teal-100 text-teal-900", foundation_skill: "bg-background-100 text-foreground-700" };

function KindTag({ kind, code }: { kind: string; code: string }) {
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold ${KIND_TONE[kind] ?? "bg-background-100"}`}>{kindShort(kind)}{code ? ` ${code}` : ""}</span>;
}

async function functionError(error: unknown, fallback: string): Promise<string> {
  const res = (error as { context?: Response } | null)?.context;
  if (res && typeof res.json === "function") { try { const body = await res.clone().json() as { error?: string }; if (body?.error) return body.error; } catch { /* not JSON */ } }
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function MappingPanel({ assessmentId, questions, unitId, unitCode, elements, mappings, onChange, onElementsChanged, readOnly }: {
  assessmentId: string; questions: MapQuestion[]; unitId: string | null; unitCode: string | null; elements: UnitElement[]; mappings: UnitMapping[];
  onChange: (m: UnitMapping[]) => void; onElementsChanged: () => void; readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [tga, setTga] = useState<{ busy: boolean; note: string; error: string; fetchedAt: string | null }>({ busy: false, note: "", error: "", fetchedAt: null });
  const [suggestions, setSuggestions] = useState<MappingSuggestionRow[]>([]);
  const [ai, setAi] = useState<{ busy: boolean; error: string; note: string }>({ busy: false, error: "", note: "" });
  const [matrix, setMatrix] = useState(false);
  const active = useMemo(() => elements.filter((e) => e.isActive !== false), [elements]);
  const requirements = useMemo(() => active.filter((e) => MAPPABLE_KINDS.includes(e.kind)), [active]);
  const qBy = useMemo(() => new Map(questions.map((q) => [q.key, q])), [questions]);


  const loadSuggestions = useCallback(async () => {
    const { data } = await supabase.rpc("asm_mapping_suggestions_list", { p_assessment: assessmentId });
    setSuggestions((data as MappingSuggestionRow[] | null) ?? []);
  }, [assessmentId]);
  useEffect(() => { void loadSuggestions(); }, [loadSuggestions]);

  /** training.gov.au -> the unit's list: one save, a second one when new criteria wait for their new element's id. */
  const running = useRef(false);
  const loadFromTga = useCallback(async (refresh: boolean) => {
    if (!unitId || !unitCode || running.current) return; // one load at a time: two would both add the rows
    running.current = true;
    setTga((t) => ({ ...t, busy: true, error: "", note: "" }));
    try {
      const out = await invokeTga<{ details: { elements?: TgaElement[] }; fetchedAt: string; cached: boolean }>({ action: "unit_content", code: unitCode, refresh });
      if (out.error || !out.data) throw new Error(await functionError(out.error, "training.gov.au did not answer."));
      const rows = out.data.details?.elements ?? [];
      if (!rows.length) { setTga({ busy: false, error: "", note: `training.gov.au has no elements for ${unitCode}. Add them with Edit unit elements.`, fetchedAt: out.data.fetchedAt }); return; }
      let current: UnitElementRow[] = elements;
      let merged = tgaMerge(current, rows);
      const counts = { added: merged.added, updated: merged.updated };
      for (let pass = 0; pass < 2; pass += 1) {
        current = await asmAdmin<UnitElementRow[]>("unit_elements_save", { unitId, items: merged.items });
        if (!merged.pending) break;
        merged = tgaMerge(current, rows);
      }
      setTga({ busy: false, error: "", fetchedAt: out.data.fetchedAt, note: counts.added || counts.updated ? `Loaded from training.gov.au: ${counts.added} added, ${counts.updated} updated.` : "Already the same as training.gov.au." });
      onElementsChanged();
    } catch (e) { setTga((t) => ({ ...t, busy: false, error: e instanceof Error ? e.message : "training.gov.au did not answer." })); }
    finally { running.current = false; }
  }, [unitId, unitCode, elements, onElementsChanged]);

  // The first visit loads the unit's requirements by itself, once (a ref: React may run this effect twice).
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || readOnly || !unitId || !unitCode || requirements.length) return;
    autoTried.current = true; void loadFromTga(false);
  }, [readOnly, unitId, unitCode, requirements.length, loadFromTga]);

  const suggest = async () => {
    setAi({ busy: true, error: "", note: "" });
    const out = await supabase.functions.invoke<{ suggestions: MappingSuggestionRow[]; note?: string }>("asm-import", { body: { action: "suggest_mapping", assessmentId } });
    if (out.error || !out.data) { setAi({ busy: false, error: await functionError(out.error, "The AI reader could not suggest a mapping."), note: "" }); return; }
    setSuggestions(out.data.suggestions ?? []);
    const open = (out.data.suggestions ?? []).filter((s) => s.state === "suggested").length;
    setAi({ busy: false, error: "", note: out.data.note ?? (open ? `${open} suggestion${open === 1 ? "" : "s"} to confirm.` : "No new suggestions.") });
  };

  const has = (qid: string, cid: string | null, eid: string) => mappings.some((m) => m.questionId === qid && (m.criterionId ?? null) === cid && m.elementId === eid);
  const decide = async (rows: MappingSuggestionRow[], state: "confirmed" | "dismissed") => {
    if (!rows.length) return;
    if (state === "confirmed") {
      const add = rows.filter((r) => !has(r.questionId, null, r.elementId)).map((r) => ({ questionId: r.questionId, criterionId: null, elementId: r.elementId }));
      if (add.length) onChange([...mappings, ...add]);
    }
    const { data, error } = await supabase.rpc("asm_mapping_decide", { p_ids: rows.map((r) => r.id), p_state: state });
    if (error) { setAi((a) => ({ ...a, error: error.message })); return; }
    setSuggestions((data as MappingSuggestionRow[] | null) ?? []);
  };

  if (!unitId) return <Empty icon="ri-links-line" title="No unit" text="Choose the unit of competency in Settings first; the mapping is to its requirements." />;

  // coverage from the mappings on screen (saved a moment later), so a confirmed tick counts at once
  const mapped = new Set(mappings.map((m) => m.elementId));
  const gaps = requirements.filter((e) => !mapped.has(e.id));
  const unmappedQuestions = questions.filter((q) => !mappings.some((m) => m.questionId === q.key)).length;
  const covered = requirements.length - gaps.length;
  const grouped = suggestionsByElement(suggestions, requirements);
  const openCount = suggestions.filter((s) => s.state === "suggested").length;
  const qText = (id: string) => { const q = qBy.get(id); return q ? { number: q.number, text: q.label } : { number: "", text: "A question no longer in this version" }; };
  const rows = questions.map((q) => ({ key: q.key, questionId: q.key, criterionId: null as string | null, label: `${q.number} ${q.label}`.trim() }));
  const toggle = (qid: string, cid: string | null, eid: string) => onChange(has(qid, cid, eid) ? mappings.filter((m) => !(m.questionId === qid && (m.criterionId ?? null) === cid && m.elementId === eid)) : [...mappings, { questionId: qid, criterionId: cid, elementId: eid }]);

  return (
    <div className="space-y-4" data-testid="mapping-panel">
      {/* coverage first */}
      <section className={CARD} data-testid="coverage">
        <div className={CARD_HEAD}>
          <p className="text-sm font-semibold text-foreground-900">Coverage <span className="font-normal text-foreground-500">· {unitCode ?? "Unit"} · {requirements.length ? `${covered} of ${requirements.length} requirements covered` : "no requirements loaded yet"}</span></p>
          <div className="flex flex-wrap gap-2">
            {!readOnly ? <button type="button" className={BTN_SECONDARY} disabled={tga.busy || !unitCode} onClick={() => void loadFromTga(true)} data-testid="tga-refresh"><i className={tga.busy ? "ri-loader-4-line animate-spin" : "ri-refresh-line"} aria-hidden="true" />Refresh from training.gov.au</button> : null}
            <button type="button" className={BTN_SECONDARY} onClick={() => setEditing((v) => !v)}><i className="ri-list-settings-line" aria-hidden="true" />{editing ? "Done editing elements" : "Edit unit elements"}</button>
          </div>
        </div>
        {tga.busy ? <p role="status" className="px-4 py-2 text-sm text-foreground-600"><i className="ri-loader-4-line mr-1.5 animate-spin" aria-hidden="true" />Loading the unit's requirements from training.gov.au…</p> : null}
        {tga.error ? <p role="alert" className="px-4 py-2 text-sm text-red-700">{tga.error}</p> : null}
        {tga.note ? <p role="status" className="px-4 py-2 text-sm text-foreground-700" data-testid="tga-note">{tga.note}</p> : null}
        {requirements.length ? (
          <div className="px-4 py-3">
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-background-200" aria-hidden="true"><div className={`h-full rounded-full ${gaps.length ? "bg-amber-500" : "bg-green-600"}`} style={{ width: `${Math.round(100 * covered / requirements.length)}%` }} /></div>
            {gaps.length ? (
              <>
                <p className="text-sm font-semibold text-amber-900">{gaps.length} requirement{gaps.length === 1 ? "" : "s"} no question maps to</p>
                <ul className="mt-1.5 max-h-56 divide-y divide-background-100 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/40" data-testid="coverage-gaps">
                  {gaps.map((g) => <li key={g.id} className="flex items-center gap-2 px-3 py-1.5 text-sm"><KindTag kind={g.kind} code={g.code} /><span className="min-w-0 flex-1 truncate text-foreground-800" title={g.text}>{g.text}</span></li>)}
                </ul>
              </>
            ) : <p className="text-sm text-green-800"><i className="ri-check-double-line mr-1" aria-hidden="true" />Every requirement is covered.</p>}
            {unmappedQuestions ? <p className="mt-2 text-xs text-foreground-600">{unmappedQuestions} question{unmappedQuestions === 1 ? "" : "s"} map to nothing yet.</p> : null}
          </div>
        ) : !tga.busy ? <p className="px-4 py-3 text-sm text-foreground-600">No requirements on this unit yet. {unitCode ? "Load them from training.gov.au or add them with Edit unit elements." : "Add them with Edit unit elements."}</p> : null}
        {editing ? <div className="border-t border-background-200 p-4"><ElementsEditor unitId={unitId} elements={elements} onSaved={onElementsChanged} /></div> : null}
      </section>

      {/* AI suggestions: ticks to confirm */}
      <section className={CARD} data-testid="ai-mapping">
        <div className={CARD_HEAD}>
          <p className="text-sm font-semibold text-foreground-900">Suggested mappings <span className="font-normal text-foreground-500">· {openCount ? `${openCount} to confirm` : "none waiting"}</span></p>
          {!readOnly ? <button type="button" className={BTN_PRIMARY} disabled={ai.busy || !requirements.length || !questions.length} onClick={() => void suggest()} data-testid="ai-suggest"><i className={ai.busy ? "ri-loader-4-line animate-spin" : "ri-sparkling-2-line"} aria-hidden="true" />{ai.busy ? "Reading the questions…" : "Suggest mappings (AI)"}</button> : null}
        </div>
        {ai.error ? <p role="alert" className="px-4 py-2 text-sm text-red-700">{ai.error}</p> : null}
        {ai.note ? <p role="status" className="px-4 py-2 text-sm text-foreground-700">{ai.note}</p> : null}
        {grouped.length ? (
          <ul className="divide-y divide-background-200">
            {grouped.map(({ element, rows: list }) => {
              const waiting = list.filter((r) => r.state === "suggested");
              return (
                <li key={element.id} className="px-4 py-2.5" data-testid="suggestion-group">
                  <div className="flex items-center gap-2">
                    <KindTag kind={element.kind} code={element.code} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground-900" title={element.text}>{element.text}</span>
                    {waiting.length > 1 && !readOnly ? <button type="button" className="shrink-0 cursor-pointer text-xs font-semibold text-primary-700 hover:underline" onClick={() => void decide(waiting, "confirmed")}>Confirm all suggestions for this element</button> : null}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {list.map((r) => {
                      const q = qText(r.questionId);
                      const confirmed = r.state === "confirmed";
                      return (
                        <li key={r.id} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-background-50" data-testid="suggestion-row">
                          <button type="button" disabled={readOnly || confirmed} onClick={() => void decide([r], "confirmed")} aria-label={confirmed ? "Confirmed" : `Confirm: question ${q.number} gives evidence for this`} title={confirmed ? "Confirmed" : "Confirm"}
                            className={`mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-2 ${confirmed ? "border-green-600 bg-green-600 text-white" : "border-background-400 bg-white hover:border-primary-500"} disabled:cursor-default`}>
                            {confirmed ? <i className="ri-check-line text-sm" aria-hidden="true" /> : null}
                          </button>
                          <span className="min-w-0 flex-1 text-sm">
                            <span className="font-semibold text-foreground-900">{q.number}</span> <span className="text-foreground-800">{q.text.length > 110 ? `${q.text.slice(0, 109)}…` : q.text}</span>
                            <span className="block text-xs text-foreground-500">{confirmed ? `Confirmed${r.decidedBy ? ` by ${r.decidedBy}` : ""}${r.decidedAt ? ` · ${new Date(r.decidedAt).toLocaleString()}` : ""}` : `${Math.round(r.confidence * 100)}% · ${r.reason}`}</span>
                          </span>
                          {!confirmed && !readOnly ? <button type="button" className="shrink-0 cursor-pointer rounded p-1 text-foreground-400 opacity-0 hover:text-foreground-700 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label="Dismiss this suggestion" title="Dismiss" onClick={() => void decide([r], "dismissed")}><i className="ri-close-line" aria-hidden="true" /></button> : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : <p className="px-4 py-3 text-sm text-foreground-600">{requirements.length ? "The AI reader reads the questions and the unit's requirements and suggests which question gives evidence for which requirement. Nothing is mapped until you tick it." : "Load the unit's requirements first."}</p>}
      </section>

      {/* the matrix */}
      <section className={CARD}>
        <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2.5 text-left text-sm font-semibold text-foreground-900" aria-expanded={matrix} onClick={() => setMatrix((v) => !v)}>
          <i className={`ri-arrow-${matrix ? "down" : "right"}-s-line text-foreground-400`} aria-hidden="true" />Mapping matrix <span className="font-normal text-foreground-500">· {mappings.length} mapping{mappings.length === 1 ? "" : "s"}</span>
        </button>
        {matrix ? (active.length === 0 ? <p className="border-t border-background-200 px-4 py-3 text-sm text-foreground-600">No requirements yet.</p> : (
          <div className="overflow-x-auto border-t border-background-200">
            <table className="min-w-full text-xs">
              <thead><tr className="bg-background-50"><th className="sticky left-0 bg-background-50 p-2 text-left font-medium text-foreground-700">Question / criterion</th>{active.map((e) => <th key={e.id} className={`p-1 text-center font-medium ${gaps.some((g) => g.id === e.id) ? "text-amber-700" : "text-foreground-700"}`} title={`${e.kind}: ${e.text}`}><span className="block">{kindShort(e.kind)}</span><span className="block font-normal">{e.code || "·"}</span></th>)}</tr></thead>
              <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-background-100"><td className="sticky left-0 max-w-xs truncate whitespace-pre bg-white p-2 text-foreground-900" title={r.label}>{r.label}</td>{active.map((e) => <td key={e.id} className="p-1 text-center"><input type="checkbox" disabled={readOnly} checked={has(r.questionId, r.criterionId, e.id)} onChange={() => toggle(r.questionId, r.criterionId, e.id)} aria-label={`${r.label} maps to ${e.code || e.text}`} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        )) : null}
      </section>
    </div>
  );
}

function ElementsEditor({ unitId, elements, onSaved }: { unitId: string; elements: UnitElement[]; onSaved: () => void }) {
  const [items, setItems] = useState<UnitElement[]>(elements.filter((e) => e.isActive !== false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (id: string, patch: Partial<UnitElement>) => setItems((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const parents = items.filter((e) => e.kind === "element");
  return (
    <div>
      <p className="mb-2 text-xs text-foreground-600">Elements, performance criteria (under an element), performance evidence, knowledge evidence, assessment conditions and foundation skills of the unit. Items removed here stay on old mappings but are inactive.</p>
      <ul className="space-y-1.5">{items.map((e) => (
        <li key={e.id} className="grid gap-1.5 sm:grid-cols-[11rem_6rem_1fr_9rem_auto]">
          <Select value={e.kind} onChange={(ev) => update(e.id, { kind: ev.target.value })}>{ELEMENT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select>
          <TextInput placeholder="Code" value={e.code} onChange={(ev) => update(e.id, { code: ev.target.value })} />
          <TextInput placeholder="Text" value={e.text} onChange={(ev) => update(e.id, { text: ev.target.value })} />
          <Select value={e.parentId ?? ""} onChange={(ev) => update(e.id, { parentId: ev.target.value || null })} disabled={e.kind !== "performance_criterion"}><option value="">(no parent)</option>{parents.filter((p) => p.id !== e.id).map((p) => <option key={p.id} value={p.id}>{p.code || p.text.slice(0, 20)}</option>)}</Select>
          <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setItems((l) => l.filter((x) => x.id !== e.id))} />
        </li>))}</ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setItems((l) => [...l, { id: `new-${Date.now()}-${l.length}`, kind: "element", parentId: null, code: "", text: "", sort: l.length }])}>Add row</Button>
        <Button size="sm" icon="ri-save-line" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await asmAdmin("unit_elements_save", { unitId, items: items.map((e, i) => ({ id: e.id.startsWith("new-") ? undefined : e.id, kind: e.kind, parentId: e.parentId && !e.parentId.startsWith("new-") ? e.parentId : undefined, code: e.code, text: e.text || "-", sort: i })) }); onSaved(); } catch (er) { setError(er instanceof Error ? er.message : "Not saved."); } finally { setBusy(false); } }}>Save elements</Button>
        {error ? <span className="text-xs text-red-700">{error}</span> : null}
      </div>
    </div>
  );
}
