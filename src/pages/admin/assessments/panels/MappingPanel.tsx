import { useEffect, useState } from "react";
import { Badge, Button, Select, TextInput } from "@/pages/admin/components/ui";
import { Empty } from "@/pages/admin/components/rto/overlay";
import { flattenQuestions } from "@/lib/assessment/definition";
import { isAnswerable } from "@/lib/assessment/registry";
import type { Definition, UnitMapping } from "@/lib/assessment/types";
import { asmAdmin, ELEMENT_KINDS, kindShort, type Coverage, type UnitElement } from "@/pages/admin/lib/assessments";

/** The unit mapping matrix: questions and criteria (rows) against the unit's elements, criteria, evidence and conditions (columns). */
export default function MappingPanel({ definition, unitId, versionId, elements, mappings, onChange, onElementsChanged, readOnly }: {
  definition: Definition; unitId: string | null; versionId: string | null; elements: UnitElement[]; mappings: UnitMapping[]; onChange: (m: UnitMapping[]) => void; onElementsChanged: () => void; readOnly?: boolean;
}) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (versionId) asmAdmin<Coverage>("coverage", { versionId }).then(setCoverage).catch(() => setCoverage(null)); }, [versionId, mappings.length, elements.length]);
  if (!unitId) return <Empty icon="ri-links-line" title="No unit" text="Choose the unit of competency on the assessment first; the matrix maps to its elements." />;
  const rows = flattenQuestions(definition).filter((f) => isAnswerable(f.question) && (f.question.markingMode ?? "criteria") !== "none")
    .flatMap((f) => [{ key: f.question.id, questionId: f.question.id, criterionId: null as string | null, label: `${f.number} ${f.question.label || f.question.type}` }, ...(f.question.criteria ?? []).map((c) => ({ key: `${f.question.id}|${c.id}`, questionId: f.question.id, criterionId: c.id as string | null, label: `    ↳ ${c.text}` }))]);
  const active = elements.filter((e) => e.isActive !== false);
  const has = (qid: string, cid: string | null, eid: string) => mappings.some((m) => m.questionId === qid && (m.criterionId ?? null) === cid && m.elementId === eid);
  const toggle = (qid: string, cid: string | null, eid: string) => onChange(has(qid, cid, eid) ? mappings.filter((m) => !(m.questionId === qid && (m.criterionId ?? null) === cid && m.elementId === eid)) : [...mappings, { questionId: qid, criterionId: cid, elementId: eid }]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-700">Tick where a question or criterion provides evidence for an element. Coverage gaps are elements no question maps to.</p>
        <Button size="sm" variant="outline" icon="ri-list-settings-line" onClick={() => setEditing((v) => !v)}>{editing ? "Done editing elements" : "Edit unit elements"}</Button>
      </div>
      {editing ? <ElementsEditor unitId={unitId} elements={elements} onSaved={onElementsChanged} /> : null}
      {coverage ? (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone={coverage.gaps.length ? "warn" : "success"}>{coverage.gaps.length ? `${coverage.gaps.length} element${coverage.gaps.length === 1 ? "" : "s"} not covered` : "Every element is covered"}</Badge>
          {coverage.unmappedQuestions.length ? <Badge tone="muted">{coverage.unmappedQuestions.length} question{coverage.unmappedQuestions.length === 1 ? "" : "s"} map to nothing</Badge> : null}
        </div>
      ) : null}
      {active.length === 0 ? <Empty icon="ri-list-check" title="No elements on this unit yet" text='Add the elements, performance criteria, performance evidence, knowledge evidence and assessment conditions with "Edit unit elements".' /> : (
        <div className="overflow-x-auto rounded-md border border-background-200">
          <table className="min-w-full text-xs">
            <thead><tr className="bg-background-100"><th className="sticky left-0 bg-background-100 p-2 text-left font-medium text-foreground-700">Question / criterion</th>{active.map((e) => <th key={e.id} className={`p-1 text-center font-medium ${coverage?.gaps.some((g) => g.id === e.id) ? "text-primary-700" : "text-foreground-700"}`} title={`${e.kind}: ${e.text}`}><span className="block">{kindShort(e.kind)}</span><span className="block font-normal">{e.code || "·"}</span></th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-background-100"><td className="sticky left-0 whitespace-pre bg-background-50 p-2 text-foreground-900">{r.label}</td>{active.map((e) => <td key={e.id} className="p-1 text-center"><input type="checkbox" disabled={readOnly} checked={has(r.questionId, r.criterionId, e.id)} onChange={() => toggle(r.questionId, r.criterionId, e.id)} aria-label={`${r.label} maps to ${e.code || e.text}`} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
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
    <div className="rounded-md border border-background-200 p-3">
      <p className="mb-2 text-xs text-foreground-600">Elements, performance criteria (under an element), performance evidence, knowledge evidence, assessment conditions and foundation skills of the unit, as data. Items removed here stay on old mappings but are inactive.</p>
      <ul className="space-y-1.5">{items.map((e) => (
        <li key={e.id} className="grid gap-1.5 sm:grid-cols-[9rem_6rem_1fr_9rem_auto]">
          <Select value={e.kind} onChange={(ev) => update(e.id, { kind: ev.target.value })}>{ELEMENT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select>
          <TextInput placeholder="Code" value={e.code} onChange={(ev) => update(e.id, { code: ev.target.value })} />
          <TextInput placeholder="Text" value={e.text} onChange={(ev) => update(e.id, { text: ev.target.value })} />
          <Select value={e.parentId ?? ""} onChange={(ev) => update(e.id, { parentId: ev.target.value || null })} disabled={e.kind !== "performance_criterion"}><option value="">(no parent)</option>{parents.filter((p) => p.id !== e.id).map((p) => <option key={p.id} value={p.id}>{p.code || p.text.slice(0, 20)}</option>)}</Select>
          <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setItems((l) => l.filter((x) => x.id !== e.id))} />
        </li>))}</ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setItems((l) => [...l, { id: `new-${Date.now()}-${l.length}`, kind: "element", parentId: null, code: "", text: "", sort: l.length }])}>Add row</Button>
        <Button size="sm" icon="ri-save-line" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await asmAdmin("unit_elements_save", { unitId, items: items.map((e, i) => ({ id: e.id.startsWith("new-") ? undefined : e.id, kind: e.kind, parentId: e.parentId && !e.parentId.startsWith("new-") ? e.parentId : undefined, code: e.code, text: e.text || "-", sort: i })) }); onSaved(); } catch (er) { setError(er instanceof Error ? er.message : "Not saved."); } finally { setBusy(false); } }}>Save elements</Button>
        {error ? <span className="text-xs text-primary-700">{error}</span> : null}
      </div>
    </div>
  );
}
