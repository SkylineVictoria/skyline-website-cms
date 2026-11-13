import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import type { Condition, ConditionOp } from "@/lib/assessment/types";

const OPS: { id: ConditionOp; label: string; needsValue: boolean }[] = [
  { id: "eq", label: "equals", needsValue: true }, { id: "neq", label: "does not equal", needsValue: true }, { id: "contains", label: "contains", needsValue: true },
  { id: "in", label: "is one of (comma list)", needsValue: true }, { id: "notIn", label: "is none of (comma list)", needsValue: true },
  { id: "gt", label: ">", needsValue: true }, { id: "gte", label: "≥", needsValue: true }, { id: "lt", label: "<", needsValue: true }, { id: "lte", label: "≤", needsValue: true },
  { id: "notEmpty", label: "is answered", needsValue: false }, { id: "empty", label: "is not answered", needsValue: false },
];
type Leaf = { questionId: string; op: ConditionOp; value?: unknown };
const parseValue = (raw: string, op: ConditionOp): unknown => {
  if (op === "in" || op === "notIn") return raw.split(",").map((s) => s.trim()).filter(Boolean).map(coerce);
  return coerce(raw);
};
const coerce = (s: string): unknown => (s === "true" ? true : s === "false" ? false : s !== "" && !Number.isNaN(Number(s)) ? Number(s) : s);
const show = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : v === undefined || v === null ? "" : String(v));

/** showIf: a group of rules (all / any) over earlier questions; the same rules the database evaluates. */
export default function ConditionEditor({ value, onChange, candidates }: { value: Condition | undefined; onChange: (c: Condition | undefined) => void; candidates: { id: string; label: string }[] }) {
  const mode: "all" | "any" = value && "any" in value ? "any" : "all";
  const leaves: Leaf[] = value ? ("all" in value ? (value.all as Leaf[]) : "any" in value ? (value.any as Leaf[]) : [value as Leaf]) : [];
  const emit = (m: "all" | "any", ls: Leaf[]) => onChange(ls.length ? (m === "all" ? { all: ls } : { any: ls }) : undefined);
  return (
    <div className="space-y-2 rounded-md border border-background-200 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-800">
        <span>Show this when</span>
        <Select className="w-auto" value={mode} onChange={(e) => emit(e.target.value as "all" | "any", leaves)} disabled={leaves.length < 2}><option value="all">all</option><option value="any">any</option></Select>
        <span>of these are true:</span>
      </div>
      {leaves.length === 0 ? <p className="text-xs text-foreground-500">Always shown.</p> : null}
      {leaves.map((leaf, i) => {
        const op = OPS.find((o) => o.id === leaf.op) ?? OPS[0];
        const update = (patch: Partial<Leaf>) => emit(mode, leaves.map((l, k) => (k === i ? { ...l, ...patch } : l)));
        return (
          <div key={i} className="grid gap-1.5 sm:grid-cols-[2fr_1.5fr_1.5fr_auto]">
            <Select value={leaf.questionId} onChange={(e) => update({ questionId: e.target.value })}><option value="">Question…</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
            <Select value={leaf.op} onChange={(e) => update({ op: e.target.value as ConditionOp, value: OPS.find((o) => o.id === e.target.value)?.needsValue ? leaf.value : undefined })}>{OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
            {op.needsValue ? <TextInput placeholder="value (an option id, number, true/false)" value={show(leaf.value)} onChange={(e) => update({ value: parseValue(e.target.value, leaf.op) })} /> : <span />}
            <Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove rule" onClick={() => emit(mode, leaves.filter((_, k) => k !== i))} />
          </div>
        );
      })}
      <Button size="sm" variant="outline" icon="ri-add-line" disabled={!candidates.length} onClick={() => emit(mode, [...leaves, { questionId: candidates[0]?.id ?? "", op: "eq", value: "" }])}>Add rule</Button>
    </div>
  );
}
