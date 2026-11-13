/**
 * The React half of the question-type registry: for every type, the student input, the read-only answer view (marking, review,
 * history), the builder's config editor and, for auto-checked types, the answer-key editor. The runtime-neutral half (schemas,
 * marking modes, defaults) is `src/lib/assessment/registry.ts`. Adding a type = one entry in each file; no migration.
 *
 * The file exports the registry object (not components), so fast refresh reloads the whole page on edits here; that is intended.
 */
/* eslint-disable react-refresh/only-export-components */
import { useState, type ReactNode } from "react";
import { Button, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import type { ChecklistItem, GridColumn, GridRow, Option } from "@/lib/assessment/registry";
import { newId } from "@/lib/assessment/registry";
import type { EvidenceFile, Question, Responses } from "@/lib/assessment/types";

export interface InputProps {
  q: Question; value: unknown; onChange: (v: unknown) => void; disabled?: boolean;
  evidence?: EvidenceFile[]; onUpload?: (q: Question, files: FileList) => Promise<void>; onRemoveEvidence?: (file: EvidenceFile) => Promise<void>; openEvidence?: (file: EvidenceFile) => void;
  /** Nested questions (case study, repeating group) are rendered by the renderer, which owns numbering and conditions. */
  renderChildren?: (children: Question[], responses: Responses, onChange: (r: Responses) => void, keyPrefix: string) => ReactNode;
  declarationText?: string;
}
export interface ViewProps {
  q: Question; value: unknown; evidence?: EvidenceFile[]; openEvidence?: (file: EvidenceFile) => void;
  renderChildren?: (children: Question[], responses: Responses, keyPrefix: string) => ReactNode;
}
export interface ConfigProps { q: Question; onChange: (patch: Partial<Question>) => void }
export interface KeyProps { q: Question; value: unknown; onChange: (key: unknown) => void }

export interface TypeUi { Input: (p: InputProps) => ReactNode; View: (p: ViewProps) => ReactNode; Config: (p: ConfigProps) => ReactNode; Key?: (p: KeyProps) => ReactNode }

const cfg = <T,>(q: Question, key: string, fallback: T): T => ((q.config ?? {})[key] as T | undefined) ?? fallback;
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const EMPTY = <span className="text-sm text-foreground-500">No answer</span>;

/* ------------------------------------------------------------------ shared small editors */
function ListEditor<T extends { id: string }>({ items, onChange, render, add, label, addLabel = "Add" }: {
  items: T[]; onChange: (items: T[]) => void; render: (item: T, update: (patch: Partial<T>) => void) => ReactNode; add: () => T; label: string; addLabel?: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-label font-medium text-foreground-800">{label}</span>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={it.id} className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-xs text-foreground-500">{i + 1}.</span>
            <div className="min-w-0 flex-1">{render(it, (patch) => onChange(items.map((x) => (x.id === it.id ? { ...x, ...patch } : x))))}</div>
            <Button size="sm" variant="ghost" icon="ri-arrow-up-s-line" aria-label="Move up" disabled={i === 0} onClick={() => { const a = items.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; onChange(a); }} />
            <Button size="sm" variant="ghost" icon="ri-arrow-down-s-line" aria-label="Move down" disabled={i === items.length - 1} onClick={() => { const a = items.slice(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; onChange(a); }} />
            <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => onChange(items.filter((x) => x.id !== it.id))} />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="outline" icon="ri-add-line" className="mt-2" onClick={() => onChange([...items, add()])}>{addLabel}</Button>
    </div>
  );
}
const OptionsEditor = ({ q, onChange, keyName = "options", label = "Options" }: ConfigProps & { keyName?: string; label?: string }) => (
  <ListEditor<Option> label={label} items={cfg<Option[]>(q, keyName, [])} onChange={(options) => onChange({ config: { ...q.config, [keyName]: options } })}
    render={(o, update) => <TextInput value={o.label} onChange={(e) => update({ label: e.target.value })} placeholder="Option text" />}
    add={() => ({ id: newId("o"), label: "" })} addLabel="Add option" />
);
const NumberInput = ({ label, value, onChange, min, step = 1 }: { label: string; value: unknown; onChange: (v: number | null) => void; min?: number; step?: number }) => (
  <label className="block"><span className="mb-1 block text-xs text-foreground-600">{label}</span>
    <TextInput type="number" min={min} step={step} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /></label>
);
const WordLimits = ({ q, onChange }: ConfigProps) => (
  <div className="grid grid-cols-2 gap-3">
    <NumberInput label="Minimum words" value={cfg(q, "minWords", null)} onChange={(v) => onChange({ config: { ...q.config, minWords: v } })} min={0} />
    <NumberInput label="Maximum words" value={cfg(q, "maxWords", null)} onChange={(v) => onChange({ config: { ...q.config, maxWords: v } })} min={1} />
  </div>
);
const Hint = ({ children }: { children: ReactNode }) => <p className="text-xs text-foreground-500">{children}</p>;

/* ------------------------------------------------------------------ evidence list (student + viewer) */
function EvidenceList({ q, evidence = [], disabled, onRemoveEvidence, openEvidence }: Pick<InputProps, "q" | "evidence" | "disabled" | "onRemoveEvidence" | "openEvidence">) {
  const mine = evidence.filter((f) => f.questionId === q.id && !f.byAssessor);
  if (!mine.length) return null;
  return (
    <ul className="mt-2 divide-y divide-background-100 rounded-md border border-background-200">
      {mine.map((f) => (
        <li key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
          <i className="ri-attachment-2 text-foreground-400" aria-hidden="true" />
          <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground-800 hover:text-primary-700" onClick={() => openEvidence?.(f)}>{f.fileName}</button>
          <span className="text-xs text-foreground-500">{(f.bytes / 1024).toFixed(0)} KB</span>
          {!disabled && onRemoveEvidence ? <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label={`Remove ${f.fileName}`} onClick={() => void onRemoveEvidence(f)} /> : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ the entries */
const instruction: TypeUi = {
  Input: ({ q }) => <ContentBlock q={q} />,
  View: ({ q }) => <ContentBlock q={q} />,
  Config: ({ q, onChange }) => (
    <div className="space-y-3">
      <label className="block"><span className="mb-1 block text-xs text-foreground-600">Content (plain text or simple HTML; links and images allowed)</span>
        <TextArea rows={6} value={cfg(q, "html", "")} onChange={(e) => onChange({ config: { ...q.config, html: e.target.value } })} /></label>
      <ListEditor<{ id: string; label: string; url: string }> label="Attached documents / media (links)" items={cfg(q, "attachments", [])}
        onChange={(attachments) => onChange({ config: { ...q.config, attachments } })}
        render={(a, update) => <div className="grid grid-cols-2 gap-1.5"><TextInput value={a.label} placeholder="Label" onChange={(e) => update({ label: e.target.value })} /><TextInput value={a.url} placeholder="https://…" onChange={(e) => update({ url: e.target.value })} /></div>}
        add={() => ({ id: newId("a"), label: "", url: "" })} addLabel="Add link" />
    </div>
  ),
};
function ContentBlock({ q }: { q: Question }) {
  const html = cfg<string>(q, "html", "");
  const attachments = cfg<{ id: string; label: string; url: string }[]>(q, "attachments", []);
  return (
    <div className="text-sm text-foreground-800">
      {/^\s*</.test(html) ? <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitize(html) }} /> : <p className="whitespace-pre-wrap">{html}</p>}
      {attachments.length ? (
        <ul className="mt-2 flex flex-wrap gap-2">{attachments.map((a) => <li key={a.id}><a className="inline-flex items-center gap-1 rounded-md border border-background-300 px-2 py-1 text-xs text-foreground-800 hover:bg-background-100" href={a.url} target="_blank" rel="noreferrer"><i className="ri-attachment-2" aria-hidden="true" />{a.label || a.url}</a></li>)}</ul>
      ) : null}
    </div>
  );
}
/** Strips scripts, event handlers and javascript: links from author-entered HTML (authors are CMS staff; this is defence in depth). */
export function sanitize(html: string): string {
  return html.replace(/<\s*(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "$1=\"#\"");
}

const short_answer: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const max = cfg<number | null>(q, "maxWords", null);
    return <div><TextArea rows={2} value={str(value)} disabled={disabled} placeholder={cfg(q, "placeholder", "")} onChange={(e) => onChange(e.target.value)} />{max ? <Hint>{words(str(value))} / {max} words</Hint> : null}</div>;
  },
  View: ({ value }) => (str(value) ? <p className="whitespace-pre-wrap text-sm text-foreground-900">{str(value)}</p> : EMPTY),
  Config: (p) => <WordLimits {...p} />,
};
const long_answer: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const max = cfg<number | null>(q, "maxWords", null);
    return <div><TextArea rows={8} value={str(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />{max ? <Hint>{words(str(value))} / {max} words</Hint> : null}</div>;
  },
  View: ({ value }) => (str(value) ? <p className="whitespace-pre-wrap text-sm text-foreground-900">{str(value)}</p> : EMPTY),
  Config: (p) => <WordLimits {...p} />,
};
const single_choice: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const options = cfg<Option[]>(q, "options", []); const other = cfg(q, "allowOther", false);
    const chosen = str(value); const isOther = other && chosen !== "" && !options.some((o) => o.id === chosen);
    return (
      <div className="space-y-1.5">
        {options.map((o) => <label key={o.id} className="flex items-center gap-2 text-sm text-foreground-900"><input type="radio" name={q.id} disabled={disabled} checked={chosen === o.id} onChange={() => onChange(o.id)} />{o.label}</label>)}
        {other ? <label className="flex items-center gap-2 text-sm text-foreground-900"><input type="radio" name={q.id} disabled={disabled} checked={isOther} onChange={() => onChange("Other: ")} />Other<TextInput className="ml-2 w-auto flex-1" disabled={disabled || !isOther} value={isOther ? chosen.replace(/^Other: /, "") : ""} onChange={(e) => onChange(`Other: ${e.target.value}`)} /></label> : null}
      </div>
    );
  },
  View: ({ q, value }) => { const o = cfg<Option[]>(q, "options", []).find((x) => x.id === str(value)); return str(value) ? <p className="text-sm text-foreground-900">{o?.label ?? str(value)}</p> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-3"><OptionsEditor q={q} onChange={onChange} /><Toggle label='Allow "Other" with free text' checked={cfg(q, "allowOther", false)} onChange={(v) => onChange({ config: { ...q.config, allowOther: v } })} /></div>,
  Key: ({ q, value, onChange }) => <Select value={str(value)} onChange={(e) => onChange(e.target.value || null)}><option value="">Correct option…</option>{cfg<Option[]>(q, "options", []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>,
};
const multi_choice: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const options = cfg<Option[]>(q, "options", []); const chosen = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (id: string, on: boolean) => onChange(on ? [...chosen, id] : chosen.filter((x) => x !== id));
    return <div className="space-y-1.5">{options.map((o) => <label key={o.id} className="flex items-center gap-2 text-sm text-foreground-900"><input type="checkbox" disabled={disabled} checked={chosen.includes(o.id)} onChange={(e) => toggle(o.id, e.target.checked)} />{o.label}</label>)}</div>;
  },
  View: ({ q, value }) => { const opts = cfg<Option[]>(q, "options", []); const chosen = Array.isArray(value) ? (value as string[]) : []; return chosen.length ? <ul className="list-disc pl-5 text-sm text-foreground-900">{chosen.map((id) => <li key={id}>{opts.find((o) => o.id === id)?.label ?? id}</li>)}</ul> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-3"><OptionsEditor q={q} onChange={onChange} /><div className="grid grid-cols-2 gap-3"><NumberInput label="Minimum selected" value={cfg(q, "minSelected", null)} onChange={(v) => onChange({ config: { ...q.config, minSelected: v } })} min={0} /><NumberInput label="Maximum selected" value={cfg(q, "maxSelected", null)} onChange={(v) => onChange({ config: { ...q.config, maxSelected: v } })} min={1} /></div></div>,
  Key: ({ q, value, onChange }) => { const chosen = Array.isArray(value) ? (value as string[]) : []; return <div className="space-y-1">{cfg<Option[]>(q, "options", []).map((o) => <label key={o.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))} />{o.label}</label>)}</div>; },
};
const true_false: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => (
    <div className="flex gap-4">{[[true, cfg(q, "trueLabel", "True")], [false, cfg(q, "falseLabel", "False")]].map(([v, label]) => <label key={String(v)} className="flex items-center gap-2 text-sm text-foreground-900"><input type="radio" name={q.id} disabled={disabled} checked={value === v} onChange={() => onChange(v)} />{String(label)}</label>)}</div>
  ),
  View: ({ q, value }) => (typeof value === "boolean" ? <p className="text-sm text-foreground-900">{value ? cfg(q, "trueLabel", "True") : cfg(q, "falseLabel", "False")}</p> : EMPTY),
  Config: ({ q, onChange }) => <div className="grid grid-cols-2 gap-3"><label className="block"><span className="mb-1 block text-xs text-foreground-600">Label for true</span><TextInput value={cfg(q, "trueLabel", "True")} onChange={(e) => onChange({ config: { ...q.config, trueLabel: e.target.value } })} /></label><label className="block"><span className="mb-1 block text-xs text-foreground-600">Label for false</span><TextInput value={cfg(q, "falseLabel", "False")} onChange={(e) => onChange({ config: { ...q.config, falseLabel: e.target.value } })} /></label></div>,
  Key: ({ value, onChange }) => <Select value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}><option value="">Correct answer…</option><option value="true">True</option><option value="false">False</option></Select>,
};
const matching: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const left = cfg<Option[]>(q, "left", []); const right = cfg<Option[]>(q, "right", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, string>;
    return <div className="space-y-1.5">{left.map((l) => <div key={l.id} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm"><span className="text-foreground-900">{l.label}</span><i className="ri-arrow-right-line text-foreground-400" aria-hidden="true" /><Select disabled={disabled} value={v[l.id] ?? ""} onChange={(e) => onChange({ ...v, [l.id]: e.target.value })}><option value="">Choose…</option>{right.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></div>)}</div>;
  },
  View: ({ q, value }) => { const left = cfg<Option[]>(q, "left", []); const right = cfg<Option[]>(q, "right", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, string>; return Object.keys(v).length ? <ul className="text-sm text-foreground-900">{left.map((l) => <li key={l.id}>{l.label} → {right.find((r) => r.id === v[l.id])?.label ?? <em className="text-foreground-500">none</em>}</li>)}</ul> : EMPTY; },
  Config: ({ q, onChange }) => <div className="grid gap-4 md:grid-cols-2"><OptionsEditor q={q} onChange={onChange} keyName="left" label="Left items" /><OptionsEditor q={q} onChange={onChange} keyName="right" label="Right items" /></div>,
  Key: ({ q, value, onChange }) => { const left = cfg<Option[]>(q, "left", []); const right = cfg<Option[]>(q, "right", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, string>; return <div className="space-y-1">{left.map((l) => <div key={l.id} className="grid grid-cols-[1fr_1fr] gap-2 text-sm"><span>{l.label}</span><Select value={v[l.id] ?? ""} onChange={(e) => onChange({ ...v, [l.id]: e.target.value })}><option value="">Matches…</option>{right.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></div>)}</div>; },
};
const ordering: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const items = cfg<Option[]>(q, "items", []); const order = Array.isArray(value) && value.length === items.length ? (value as string[]) : items.map((i) => i.id);
    const move = (i: number, d: number) => { const a = order.slice(); const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; onChange(a); };
    return <ol className="space-y-1">{order.map((id, i) => <li key={id} className="flex items-center gap-2 rounded-md border border-background-200 px-3 py-1.5 text-sm text-foreground-900"><span className="w-5 text-xs text-foreground-500">{i + 1}.</span><span className="flex-1">{items.find((x) => x.id === id)?.label ?? id}</span>{!disabled ? <><Button size="sm" variant="ghost" icon="ri-arrow-up-s-line" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} /><Button size="sm" variant="ghost" icon="ri-arrow-down-s-line" aria-label="Move down" disabled={i === order.length - 1} onClick={() => move(i, 1)} /></> : null}</li>)}</ol>;
  },
  View: ({ q, value }) => { const items = cfg<Option[]>(q, "items", []); return Array.isArray(value) && value.length ? <ol className="list-decimal pl-5 text-sm text-foreground-900">{(value as string[]).map((id) => <li key={id}>{items.find((x) => x.id === id)?.label ?? id}</li>)}</ol> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-2"><OptionsEditor q={q} onChange={onChange} keyName="items" label="Items (shown shuffled to the student)" /><Hint>The correct order is set in Keys &amp; guidance.</Hint></div>,
  Key: ({ q, value, onChange }) => { const items = cfg<Option[]>(q, "items", []); const order = Array.isArray(value) && value.length === items.length ? (value as string[]) : items.map((i) => i.id); const move = (i: number, d: number) => { const a = order.slice(); const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; onChange(a); }; return <ol className="space-y-1">{order.map((id, i) => <li key={id} className="flex items-center gap-2 text-sm"><span className="w-5 text-xs text-foreground-500">{i + 1}.</span><span className="flex-1">{items.find((x) => x.id === id)?.label ?? id}</span><Button size="sm" variant="ghost" icon="ri-arrow-up-s-line" aria-label="Move up" onClick={() => move(i, -1)} /><Button size="sm" variant="ghost" icon="ri-arrow-down-s-line" aria-label="Move down" onClick={() => move(i, 1)} /></li>)}</ol>; },
};
const fill_blanks: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const parts = cfg<string>(q, "text", "").split("[blank]"); const v = Array.isArray(value) ? (value as string[]) : [];
    return <p className="text-sm leading-8 text-foreground-900">{parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 ? <input className="mx-1 inline-block w-32 rounded-md border border-background-300 bg-background-50 px-2 py-0.5 text-sm" disabled={disabled} value={v[i] ?? ""} onChange={(e) => { const a = Array.from({ length: parts.length - 1 }, (_, k) => v[k] ?? ""); a[i] = e.target.value; onChange(a); }} /> : null}</span>)}</p>;
  },
  View: ({ q, value }) => { const parts = cfg<string>(q, "text", "").split("[blank]"); const v = Array.isArray(value) ? (value as string[]) : []; return v.length ? <p className="text-sm text-foreground-900">{parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 ? <mark className="rounded bg-accent-100 px-1">{v[i] || "…"}</mark> : null}</span>)}</p> : EMPTY; },
  Config: ({ q, onChange }) => <label className="block"><span className="mb-1 block text-xs text-foreground-600">Text; write [blank] where an answer goes</span><TextArea rows={3} value={cfg(q, "text", "")} onChange={(e) => onChange({ config: { ...q.config, text: e.target.value } })} /></label>,
  Key: ({ q, value, onChange }) => { const n = (cfg<string>(q, "text", "").match(/\[blank\]/g) ?? []).length; const v = Array.isArray(value) ? (value as unknown[]) : []; return <div className="space-y-1">{Array.from({ length: n }, (_, i) => <label key={i} className="flex items-center gap-2 text-sm"><span className="w-16 text-xs text-foreground-500">Blank {i + 1}</span><TextInput value={Array.isArray(v[i]) ? (v[i] as string[]).join(" | ") : str(v[i])} placeholder="answer | alternative" onChange={(e) => { const a = Array.from({ length: n }, (_, k) => v[k] ?? ""); const alts = e.target.value.split("|").map((s) => s.trim()).filter(Boolean); a[i] = alts.length > 1 ? alts : (alts[0] ?? ""); onChange(a); }} /></label>)}<Hint>Separate accepted alternatives with |. Case and spaces are ignored.</Hint></div>; },
};
const table_grid: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const columns = cfg<GridColumn[]>(q, "columns", []); const rows = cfg<GridRow[]>(q, "rows", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, Record<string, unknown>>;
    const extra = Object.keys(v).filter((r) => !rows.some((x) => x.id === r)); const allRows = [...rows, ...extra.map((id) => ({ id, label: "" }))];
    const set = (r: string, c: string, val: unknown) => onChange({ ...v, [r]: { ...(v[r] ?? {}), [c]: val } });
    return (
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-1 text-left text-xs text-foreground-600" />{columns.map((c) => <th key={c.id} className="p-1 text-left text-xs font-medium text-foreground-700">{c.label}</th>)}</tr></thead>
        <tbody>{allRows.map((r, ri) => <tr key={r.id}><th className="p-1 text-left text-xs font-medium text-foreground-700">{r.label || ri + 1}</th>{columns.map((c) => <td key={c.id} className="p-1">{c.kind === "checkbox" ? <input type="checkbox" disabled={disabled} checked={Boolean(v[r.id]?.[c.id])} onChange={(e) => set(r.id, c.id, e.target.checked)} /> : <TextInput type={c.kind === "number" ? "number" : "text"} disabled={disabled} value={str(v[r.id]?.[c.id])} onChange={(e) => set(r.id, c.id, c.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />}</td>)}</tr>)}</tbody></table>
        {cfg(q, "allowAddRows", false) && !disabled ? <Button size="sm" variant="outline" icon="ri-add-line" className="mt-2" onClick={() => onChange({ ...v, [newId("r")]: {} })}>Add row</Button> : null}
      </div>
    );
  },
  View: ({ q, value }) => { const columns = cfg<GridColumn[]>(q, "columns", []); const rows = cfg<GridRow[]>(q, "rows", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, Record<string, unknown>>; const allRows = [...rows, ...Object.keys(v).filter((r) => !rows.some((x) => x.id === r)).map((id) => ({ id, label: "" }))]; return Object.keys(v).length ? <table className="w-full text-sm"><thead><tr><th className="p-1" />{columns.map((c) => <th key={c.id} className="p-1 text-left text-xs text-foreground-600">{c.label}</th>)}</tr></thead><tbody>{allRows.map((r, ri) => <tr key={r.id} className="border-t border-background-100"><th className="p-1 text-left text-xs text-foreground-600">{r.label || ri + 1}</th>{columns.map((c) => <td key={c.id} className="p-1 text-foreground-900">{c.kind === "checkbox" ? (v[r.id]?.[c.id] ? "✓" : "") : str(v[r.id]?.[c.id])}</td>)}</tr>)}</tbody></table> : EMPTY; },
  Config: ({ q, onChange }) => (
    <div className="space-y-3">
      <ListEditor<GridColumn> label="Columns" items={cfg(q, "columns", [])} onChange={(columns) => onChange({ config: { ...q.config, columns } })}
        render={(c, update) => <div className="grid grid-cols-[1fr_auto] gap-1.5"><TextInput value={c.label} onChange={(e) => update({ label: e.target.value })} /><Select value={c.kind ?? "text"} onChange={(e) => update({ kind: e.target.value as GridColumn["kind"] })}><option value="text">Text</option><option value="number">Number</option><option value="checkbox">Tick</option></Select></div>}
        add={() => ({ id: newId("c"), label: "", kind: "text" })} addLabel="Add column" />
      <ListEditor<GridRow> label="Rows" items={cfg(q, "rows", [])} onChange={(rows) => onChange({ config: { ...q.config, rows } })} render={(r, update) => <TextInput value={r.label} onChange={(e) => update({ label: e.target.value })} />} add={() => ({ id: newId("r"), label: "" })} addLabel="Add row" />
      <Toggle label="The student may add rows" checked={cfg(q, "allowAddRows", false)} onChange={(v) => onChange({ config: { ...q.config, allowAddRows: v } })} />
    </div>
  ),
};
const likert: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => { const min = cfg(q, "min", 1); const max = cfg(q, "max", 5); const labels = cfg<string[]>(q, "labels", []); return <div className="flex flex-wrap gap-3">{Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n, i) => <label key={n} className="flex flex-col items-center gap-1 text-xs text-foreground-700"><input type="radio" name={q.id} disabled={disabled} checked={value === n} onChange={() => onChange(n)} /><span>{labels[i] ?? n}</span></label>)}</div>; },
  View: ({ q, value }) => { const labels = cfg<string[]>(q, "labels", []); const min = cfg(q, "min", 1); return typeof value === "number" ? <p className="text-sm text-foreground-900">{value} · {labels[value - min] ?? ""}</p> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><NumberInput label="From" value={cfg(q, "min", 1)} onChange={(v) => onChange({ config: { ...q.config, min: v ?? 1 } })} /><NumberInput label="To" value={cfg(q, "max", 5)} onChange={(v) => onChange({ config: { ...q.config, max: v ?? 5 } })} /></div><label className="block"><span className="mb-1 block text-xs text-foreground-600">Labels, one per point (one per line)</span><TextArea rows={5} value={cfg<string[]>(q, "labels", []).join("\n")} onChange={(e) => onChange({ config: { ...q.config, labels: e.target.value.split("\n") } })} /></label></div>,
};
const number: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => <div className="flex items-center gap-2"><TextInput type="number" className="max-w-xs" disabled={disabled} step={cfg(q, "integer", false) ? 1 : "any"} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />{cfg(q, "unit", "") ? <span className="text-sm text-foreground-600">{cfg(q, "unit", "")}</span> : null}</div>,
  View: ({ q, value }) => (typeof value === "number" ? <p className="text-sm text-foreground-900">{value} {cfg(q, "unit", "")}</p> : EMPTY),
  Config: ({ q, onChange }) => <div className="grid grid-cols-3 gap-3"><NumberInput label="Minimum" value={cfg(q, "min", null)} onChange={(v) => onChange({ config: { ...q.config, min: v } })} step={0.01} /><NumberInput label="Maximum" value={cfg(q, "max", null)} onChange={(v) => onChange({ config: { ...q.config, max: v } })} step={0.01} /><label className="block"><span className="mb-1 block text-xs text-foreground-600">Unit</span><TextInput value={cfg(q, "unit", "")} onChange={(e) => onChange({ config: { ...q.config, unit: e.target.value } })} /></label><Toggle label="Whole numbers only" checked={cfg(q, "integer", false)} onChange={(v) => onChange({ config: { ...q.config, integer: v } })} /></div>,
  Key: ({ value, onChange }) => { const v = (value && typeof value === "object" ? value : {}) as { min?: number; max?: number }; const exact = typeof value === "number" ? value : null; return <div className="grid grid-cols-3 gap-2 text-sm"><NumberInput label="Exact" value={exact} onChange={(n) => onChange(n)} step={0.01} /><NumberInput label="or from" value={v.min ?? null} onChange={(n) => onChange({ min: n ?? 0, max: v.max ?? n ?? 0 })} step={0.01} /><NumberInput label="to" value={v.max ?? null} onChange={(n) => onChange({ min: v.min ?? n ?? 0, max: n ?? 0 })} step={0.01} /></div>; },
};
const date: TypeUi = {
  Input: ({ value, onChange, disabled }) => <TextInput type="date" className="max-w-xs" disabled={disabled} value={str(value)} onChange={(e) => onChange(e.target.value)} />,
  View: ({ value }) => (str(value) ? <p className="text-sm text-foreground-900">{str(value)}</p> : EMPTY),
  Config: () => <Hint>A calendar date (YYYY-MM-DD).</Hint>,
  Key: ({ value, onChange }) => <TextInput type="date" value={str(value)} onChange={(e) => onChange(e.target.value || null)} />,
};
const file_upload: TypeUi = {
  Input: ({ q, value, onChange, disabled, evidence = [], onUpload, onRemoveEvidence, openEvidence }) => {
    const [busy, setBusy] = useState(false);
    const mine = evidence.filter((f) => f.questionId === q.id && !f.byAssessor);
    const max = cfg(q, "maxFiles", 5); const accept = cfg<string[]>(q, "accept", []);
    // The response is the list of registered file ids, kept in step with the evidence rows.
    const ids = mine.map((f) => f.id); if (JSON.stringify(ids) !== JSON.stringify(Array.isArray(value) ? value : [])) queueMicrotask(() => onChange(ids));
    return (
      <div>
        {!disabled && onUpload ? <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-background-300 px-3 py-2 text-sm text-foreground-700 hover:bg-background-100 ${busy || mine.length >= max ? "pointer-events-none opacity-60" : ""}`}><i className="ri-upload-cloud-2-line" aria-hidden="true" />{busy ? "Uploading…" : `Upload file${max > 1 ? "s" : ""}`}<input type="file" className="hidden" multiple={max > 1} accept={accept.join(",") || undefined} onChange={async (e) => { if (!e.target.files?.length) return; setBusy(true); try { await onUpload(q, e.target.files); } finally { setBusy(false); e.target.value = ""; } }} /></label> : null}
        <Hint>{accept.length ? `Allowed: ${accept.map((a) => a.split("/")[1] ?? a).join(", ")}. ` : ""}Up to {max} file{max > 1 ? "s" : ""}, {cfg(q, "maxMb", 25)} MB each.</Hint>
        <EvidenceList q={q} evidence={evidence} disabled={disabled} onRemoveEvidence={onRemoveEvidence} openEvidence={openEvidence} />
      </div>
    );
  },
  View: ({ q, evidence = [], openEvidence }) => { const mine = evidence.filter((f) => f.questionId === q.id && !f.byAssessor); return mine.length ? <EvidenceList q={q} evidence={evidence} disabled openEvidence={openEvidence} /> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-3"><div className="grid grid-cols-3 gap-3"><NumberInput label="Minimum files" value={cfg(q, "minFiles", 1)} onChange={(v) => onChange({ config: { ...q.config, minFiles: v } })} min={0} /><NumberInput label="Maximum files" value={cfg(q, "maxFiles", 5)} onChange={(v) => onChange({ config: { ...q.config, maxFiles: v } })} min={1} /><NumberInput label="Max MB each" value={cfg(q, "maxMb", 25)} onChange={(v) => onChange({ config: { ...q.config, maxMb: v } })} min={1} /></div><label className="block"><span className="mb-1 block text-xs text-foreground-600">Allowed types (MIME, one per line; empty = the institution's list)</span><TextArea rows={3} value={cfg<string[]>(q, "accept", []).join("\n")} onChange={(e) => onChange({ config: { ...q.config, accept: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })} /></label></div>,
};
const url: TypeUi = {
  Input: ({ value, onChange, disabled }) => <TextInput type="url" placeholder="https://…" disabled={disabled} value={str(value)} onChange={(e) => onChange(e.target.value)} />,
  View: ({ value }) => (str(value) ? <a className="text-sm text-primary-700 underline" href={str(value)} target="_blank" rel="noreferrer">{str(value)}</a> : EMPTY),
  Config: () => <Hint>A web address, e.g. a video or a shared document.</Hint>,
};
const case_study: TypeUi = {
  Input: ({ q, value, onChange, renderChildren }) => { const scenario = cfg<string>(q, "scenario", ""); const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Responses; return <div className="space-y-3">{scenario ? <div className="rounded-md bg-background-100 p-3 text-sm text-foreground-800 whitespace-pre-wrap">{scenario}</div> : null}<div className="space-y-4 border-l-2 border-background-200 pl-4">{renderChildren?.(q.children ?? [], v, onChange, `${q.id}.`)}</div></div>; },
  View: ({ q, value, renderChildren }) => { const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Responses; return <div className="space-y-3">{cfg<string>(q, "scenario", "") ? <div className="rounded-md bg-background-100 p-3 text-sm text-foreground-800 whitespace-pre-wrap">{cfg<string>(q, "scenario", "")}</div> : null}<div className="space-y-4 border-l-2 border-background-200 pl-4">{renderChildren?.(q.children ?? [], v, `${q.id}.`)}</div></div>; },
  Config: ({ q, onChange }) => <div className="space-y-2"><label className="block"><span className="mb-1 block text-xs text-foreground-600">Scenario text</span><TextArea rows={6} value={cfg(q, "scenario", "")} onChange={(e) => onChange({ config: { ...q.config, scenario: e.target.value } })} /></label><Hint>Add the sub-questions below this question in the builder.</Hint></div>,
};
const repeating_group: TypeUi = {
  Input: ({ q, value, onChange, disabled, renderChildren }) => {
    const entries = Array.isArray(value) ? (value as Responses[]) : []; const max = cfg(q, "maxEntries", 10); const label = cfg(q, "entryLabel", "Entry");
    return (
      <div className="space-y-3">
        {entries.map((entry, i) => <div key={i} className="rounded-md border border-background-200 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-wide text-foreground-600">{label} {i + 1}</span>{!disabled ? <Button size="sm" variant="ghost" icon="ri-delete-bin-line" onClick={() => onChange(entries.filter((_, k) => k !== i))}>Remove</Button> : null}</div><div className="space-y-4">{renderChildren?.(q.children ?? [], entry, (r) => onChange(entries.map((e, k) => (k === i ? r : e))), `${q.id}[${i}].`)}</div></div>)}
        {!disabled && entries.length < max ? <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => onChange([...entries, {}])}>Add {label.toLowerCase()}</Button> : null}
      </div>
    );
  },
  View: ({ q, value, renderChildren }) => { const entries = Array.isArray(value) ? (value as Responses[]) : []; const label = cfg(q, "entryLabel", "Entry"); return entries.length ? <div className="space-y-3">{entries.map((entry, i) => <div key={i} className="rounded-md border border-background-200 p-3"><span className="mb-2 block text-xs font-medium uppercase tracking-wide text-foreground-600">{label} {i + 1}</span><div className="space-y-3">{renderChildren?.(q.children ?? [], entry, `${q.id}[${i}].`)}</div></div>)}</div> : EMPTY; },
  Config: ({ q, onChange }) => <div className="space-y-2"><div className="grid grid-cols-3 gap-3"><label className="block"><span className="mb-1 block text-xs text-foreground-600">Entry label</span><TextInput value={cfg(q, "entryLabel", "Entry")} onChange={(e) => onChange({ config: { ...q.config, entryLabel: e.target.value } })} /></label><NumberInput label="Minimum entries" value={cfg(q, "minEntries", 1)} onChange={(v) => onChange({ config: { ...q.config, minEntries: v } })} min={0} /><NumberInput label="Maximum entries" value={cfg(q, "maxEntries", 10)} onChange={(v) => onChange({ config: { ...q.config, maxEntries: v } })} min={1} /></div><Hint>Add the fields of one entry below this question in the builder.</Hint></div>,
};
const observation_checklist: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => {
    const items = cfg<ChecklistItem[]>(q, "items", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return <div className="space-y-1.5">{items.map((it) => <div key={it.id} className="flex flex-wrap items-center gap-3 text-sm text-foreground-900"><span className="min-w-[12rem] flex-1">{it.text}</span>{[[true, "Observed"], [false, "Not observed"]].map(([val, label]) => <label key={String(val)} className="flex items-center gap-1"><input type="radio" name={`${q.id}-${it.id}`} disabled={disabled} checked={v[it.id] === val} onChange={() => onChange({ ...v, [it.id]: val })} />{String(label)}</label>)}</div>)}{cfg(q, "allowNotes", true) ? <TextArea rows={2} placeholder="Observation notes" disabled={disabled} value={str(v.notes)} onChange={(e) => onChange({ ...v, notes: e.target.value })} /> : null}</div>;
  },
  View: ({ q, value }) => { const items = cfg<ChecklistItem[]>(q, "items", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>; return Object.keys(v).length ? <ul className="text-sm text-foreground-900">{items.map((it) => <li key={it.id}>{v[it.id] === true ? "✓" : v[it.id] === false ? "✗" : "–"} {it.text}</li>)}{str(v.notes) ? <li className="mt-1 text-foreground-700">Notes: {str(v.notes)}</li> : null}</ul> : <span className="text-sm text-foreground-500">Not yet recorded by the assessor</span>; },
  Config: ({ q, onChange }) => <div className="space-y-3"><ListEditor<ChecklistItem> label="Items to observe" items={cfg(q, "items", [])} onChange={(items) => onChange({ config: { ...q.config, items } })} render={(it, update) => <TextInput value={it.text} onChange={(e) => update({ text: e.target.value })} />} add={() => ({ id: newId("o"), text: "" })} addLabel="Add item" /><Toggle label="Notes field" checked={cfg(q, "allowNotes", true)} onChange={(v) => onChange({ config: { ...q.config, allowNotes: v } })} /></div>,
};
const third_party_report: TypeUi = {
  Input: ({ q, value, onChange, disabled }) => { const fields = cfg<Option[]>(q, "fields", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>; return <div className="space-y-2">{fields.map((f) => <label key={f.id} className="block"><span className="mb-1 block text-xs text-foreground-600">{f.label}</span>{f.id === "report" ? <TextArea rows={4} disabled={disabled} value={str(v[f.id])} onChange={(e) => onChange({ ...v, [f.id]: e.target.value })} /> : <TextInput disabled={disabled} value={str(v[f.id])} onChange={(e) => onChange({ ...v, [f.id]: e.target.value })} />}</label>)}</div>; },
  View: ({ q, value }) => { const fields = cfg<Option[]>(q, "fields", []); const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>; return Object.keys(v).length ? <dl className="text-sm">{fields.map((f) => <div key={f.id}><dt className="text-xs text-foreground-500">{f.label}</dt><dd className="whitespace-pre-wrap text-foreground-900">{str(v[f.id]) || "—"}</dd></div>)}</dl> : <span className="text-sm text-foreground-500">Not yet recorded</span>; },
  Config: ({ q, onChange }) => <ListEditor<Option> label="Report fields" items={cfg(q, "fields", [])} onChange={(fields) => onChange({ config: { ...q.config, fields } })} render={(f, update) => <TextInput value={f.label} onChange={(e) => update({ label: e.target.value })} />} add={() => ({ id: newId("f"), label: "" })} addLabel="Add field" />,
};
const declaration: TypeUi = {
  Input: ({ q, value, onChange, disabled, declarationText }) => { const v = (value && typeof value === "object" ? value : {}) as { agreed?: boolean; signature?: string }; const text = cfg<string>(q, "text", "") || declarationText || ""; return <div className="space-y-2 rounded-md border border-background-200 bg-background-100 p-3"><p className="whitespace-pre-wrap text-sm text-foreground-800">{text}</p><label className="flex items-start gap-2 text-sm text-foreground-900"><input type="checkbox" className="mt-0.5" disabled={disabled} checked={Boolean(v.agreed)} onChange={(e) => onChange({ ...v, agreed: e.target.checked })} />I have read and agree to this declaration.</label><label className="block"><span className="mb-1 block text-xs text-foreground-600">Type your full name as your signature</span><TextInput className="max-w-sm" disabled={disabled} value={v.signature ?? ""} onChange={(e) => onChange({ ...v, signature: e.target.value })} /></label></div>; },
  View: ({ value }) => { const v = (value && typeof value === "object" ? value : {}) as { agreed?: boolean; signature?: string }; return v.signature ? <p className="text-sm text-foreground-900">Signed: <em>{v.signature}</em></p> : EMPTY; },
  Config: ({ q, onChange }) => <label className="block"><span className="mb-1 block text-xs text-foreground-600">Wording (empty = the institution's declaration from Settings)</span><TextArea rows={5} value={cfg(q, "text", "")} onChange={(e) => onChange({ config: { ...q.config, text: e.target.value } })} /></label>,
};

export const TYPE_UI: Record<string, TypeUi> = {
  instruction, content: instruction, short_answer, long_answer, single_choice, multi_choice, true_false, matching, ordering, fill_blanks, table_grid, likert, number, date, file_upload, url,
  case_study, repeating_group, observation_checklist, third_party_report, declaration,
};
export const typeUi = (type: string): TypeUi => TYPE_UI[type] ?? short_answer;
