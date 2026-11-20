import { useState } from "react";
import { Badge, Button, Card, Field, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { locationLabel, operators, valueSummary, valueTypes, type Category, type Definition, type RegistryField, type Rule, type RuleLocation, type Version } from "./model";

const numberTypes = ["number", "percentage", "days", "hours", "weeks", "currency"];
const choices = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

function StructuredInput({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(value == null ? "" : JSON.stringify(value, null, 2));
  return <TextArea rows={3} value={text} onChange={event => {
    setText(event.target.value);
    try { onChange(JSON.parse(event.target.value)); } catch { onChange(undefined); }
  }} />;
}

function ValueControl({ definition, update }: { definition: Definition; update: (partial: Partial<Definition>) => void }) {
  const { value, value_type: type, options } = definition;
  if (type === "json") return <StructuredInput value={value} onChange={value => update({ value })} />;
  if (type === "list") return <TextArea value={Array.isArray(value) ? value.join("\n") : ""} onChange={e => update({ value: e.target.value.split("\n") })} />;
  if (type === "boolean") return <Select value={value === null ? "" : String(value)} onChange={e => update({ value: e.target.value === "" ? null : e.target.value === "true" })}>
    <option value="">Choose</option><option value="true">Yes</option><option value="false">No</option>
  </Select>;
  if (type === "dropdown" || type === "multiple selection") return <Select multiple={type === "multiple selection"}
    value={type === "multiple selection" ? (Array.isArray(value) ? value : []) : String(value ?? "")}
    onChange={e => update({ value: type === "multiple selection" ? Array.from(e.target.selectedOptions, option => option.value) : e.target.value })}>
    {type === "dropdown" && <option value="">Choose</option>}{options.map(option => <option key={option}>{option}</option>)}
  </Select>;
  const numeric = numberTypes.includes(type);
  return <TextInput type={numeric ? "number" : type === "date" || type === "time" ? type : "text"} step={numeric ? "any" : undefined}
    value={typeof value === "number" || typeof value === "string" ? value : ""}
    onChange={e => update({ value: numeric ? (e.target.value === "" ? null : e.target.valueAsNumber) : e.target.value })} />;
}

export default function RuleEditor({ initial, rule, version, existingApprovalRequired, categories, locations, fields, busy, close, submit }: {
  initial: Definition; rule?: Rule; version?: Version; existingApprovalRequired: boolean; categories: Category[]; locations: RuleLocation[]; fields: RegistryField[];
  busy: boolean; close: () => void; submit: (command: string, payload: object) => Promise<unknown>;
}) {
  const [d, setDefinition] = useState(initial);
  const [optionsText, setOptionsText] = useState(initial.options.join("\n"));
  const [reason, setReason] = useState("");
  const [testing, setTesting] = useState(false);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [result, setResult] = useState<unknown>();
  const update = (partial: Partial<Definition>) => { setDefinition(old => ({ ...old, ...partial })); setResult(undefined); };
  const scopedFields = fields.filter(field => field.scope === d.scope);
  const reasons = { rule_id: rule?.id, expected_version: version?.id, reason };
  const definition = { ...d, options: choices(optionsText) };
  const isDraft = version?.state === "draft";
  const test = async () => {
    const context = Object.fromEntries(scopedFields.filter(f => sample[f.key]?.trim()).map(f => {
      const value = sample[f.key];
      return [f.key, numberTypes.includes(f.value_type) ? Number(value) : f.value_type === "boolean" ? value === "true" : value];
    }));
    const preview = await submit("preview", { definition, context });
    if (preview !== undefined) setResult(preview);
  };
  return <Card className="self-start p-4">
    <div className="mb-4 flex items-center justify-between"><h2 className="font-bold">{rule ? "Edit rule" : "Add rule"}</h2><Button size="sm" variant="ghost" onClick={close}>Close</Button></div>
    {version && <div className="mb-3 flex flex-wrap gap-2"><Badge>Version {version.version} · {version.state}</Badge>{version.origin === "migration" && <Badge tone="warn">Migration default · review required</Badge>}</div>}
    <div className="space-y-3">
      <Field label="Rule name" required><TextInput value={d.name} onChange={e => update({ name: e.target.value })} /></Field>
      <Field label="Unique identifier" required><TextInput value={d.identifier} disabled={!!rule} onChange={e => update({ identifier: e.target.value })} /></Field>
      <Field label="Admin menu" required><Select value={d.scope} disabled={!!rule?.registration} onChange={e => update({ scope: e.target.value, groups: [] })}><option value="">Choose menu</option>{locations.map(location => <option key={location.id} value={location.id}>{locationLabel(locations, location.id)}</option>)}</Select></Field>
      <Field label="Category" required><Select value={d.category_id} onChange={e => update({ category_id: e.target.value })}><option value="">Choose category</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></Field>
      <Field label="Entity" required><TextInput value={d.entity} disabled={!!rule?.registration} onChange={e => update({ entity: e.target.value })} /></Field>
      <Field label="Description"><TextArea rows={2} value={d.description} onChange={e => update({ description: e.target.value })} /></Field>
      <Field label="Value type"><Select value={d.value_type} disabled={!!rule?.registration} onChange={e => update({ value_type: e.target.value, value: null })}>{valueTypes.map(type => <option key={type}>{type}</option>)}</Select></Field>
      {["dropdown", "multiple selection"].includes(d.value_type) && <Field label="Options" hint="One option per line"><TextArea value={optionsText} onChange={e => { setOptionsText(e.target.value); update({ options: choices(e.target.value) }); }} /></Field>}
      <Field label="Value"><ValueControl key={d.value_type} definition={definition} update={update} /></Field>
      <fieldset className="space-y-2 rounded-md border border-background-200 p-3">
        <legend className="font-semibold">IF</legend>
        <Field label="Match condition groups"><Select value={d.match} onChange={e => update({ match: e.target.value as Definition["match"] })}><option value="all">All groups (AND)</option><option value="any">Any group (OR)</option></Select></Field>
        {d.groups.map((group, i) => {
          const changeGroups = (next: typeof group | null) => update({ groups: next ? d.groups.map((g, j) => i === j ? next : g) : d.groups.filter((_, j) => i !== j) });
          return <div className="space-y-2 rounded border border-background-200 p-2" key={i}>
            <Field label={`Group ${i + 1}`}><Select value={group.match} onChange={e => changeGroups({ ...group, match: e.target.value as typeof group.match })}><option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option></Select></Field>
            {group.conditions.map((condition, j) => {
              const changeCondition = (partial: Partial<typeof condition>) => changeGroups({ ...group, conditions: group.conditions.map((c, k) => j === k ? { ...c, ...partial } : c) });
              const field = scopedFields.find(f => f.key === condition.field);
              const parse = (raw: string) => numberTypes.includes(field?.value_type ?? "") ? (raw === "" ? null : Number(raw)) : field?.value_type === "boolean" ? raw === "true" : raw;
              const isRange = condition.operator === "between";
              return <div key={j} className="space-y-2 border-l-2 border-primary-200 pl-2">
                <Field label="Field"><Select value={condition.field} onChange={e => changeCondition({ field: e.target.value, operand: null })}><option value="">Choose field</option>{scopedFields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</Select></Field>
                <Field label="Comparison"><Select value={condition.operator} onChange={e => changeCondition({ operator: e.target.value, operand: null })}>{operators.map(operator => <option key={operator}>{operator}</option>)}</Select></Field>
                {!condition.operator.includes("empty") && (field?.value_type === "boolean" && !isRange
                  ? <Field label="Compare with"><Select value={String(condition.operand ?? "")} onChange={e => changeCondition({ operand: e.target.value === "" ? null : parse(e.target.value) })}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></Select></Field>
                  : Array.from({ length: isRange ? 2 : 1 }, (_, index) => <Field key={index} label={isRange ? (index ? "End value" : "Start value") : "Compare with"}>
                    <TextInput type={numberTypes.includes(field?.value_type ?? "") ? "number" : field?.value_type === "date" ? "date" : "text"}
                      value={String((isRange ? (Array.isArray(condition.operand) ? condition.operand[index] : null) : condition.operand) ?? "")}
                      onChange={e => { const range = Array.isArray(condition.operand) ? [...condition.operand] : [null, null]; range[index] = parse(e.target.value); changeCondition({ operand: isRange ? range : parse(e.target.value) }); }} /></Field>))}
                <Button size="sm" variant="ghost" onClick={() => changeGroups({ ...group, conditions: group.conditions.filter((_, k) => j !== k) })}>Remove condition</Button>
              </div>;
            })}
            <div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => changeGroups({ ...group, conditions: [...group.conditions, { field: "", operator: "equals", operand: null }] })}>Add condition</Button><Button size="sm" variant="ghost" onClick={() => changeGroups(null)}>Remove group</Button></div>
          </div>;
        })}
        <Button size="sm" variant="outline" disabled={!scopedFields.length} onClick={() => update({ groups: [...d.groups, { match: "all", conditions: [{ field: "", operator: "equals", operand: null }] }] })}>Add group</Button>
        {!scopedFields.length && <p className="text-xs text-foreground-600">This menu has no registered condition fields.</p>}
      </fieldset>
      <Field label="THEN"><Select value={d.then_action} onChange={e => update({ then_action: e.target.value })}><option value="use_value">Apply rule value</option><option value="none">No action</option></Select></Field>
      <Field label="ELSE"><Select value={d.else_action} onChange={e => update({ else_action: e.target.value })}><option value="none">No action</option><option value="use_value">Apply rule value</option></Select></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Effective from" required><TextInput type="date" value={d.starts_on} onChange={e => update({ starts_on: e.target.value })} /></Field>
        <Field label="Effective through"><TextInput type="date" value={d.ends_on} onChange={e => update({ ends_on: e.target.value })} /></Field>
      </div>
      <Field label="Priority"><TextInput type="number" step="1" value={d.priority} onChange={e => update({ priority: Number(e.target.value) })} /></Field>
      <label className="flex gap-2"><input type="checkbox" checked={d.enabled} onChange={e => update({ enabled: e.target.checked })} />Active when published</label>
      <label className="flex gap-2"><input type="checkbox" checked={d.approval_required} onChange={e => update({ approval_required: e.target.checked })} />Require a second administrator</label>
      <Field label="External source URL"><TextInput type="url" value={d.source_url} onChange={e => update({ source_url: e.target.value })} /></Field>
      <Field label="Compliance notes"><TextArea rows={2} value={d.notes} onChange={e => update({ notes: e.target.value })} /></Field>
      <Button size="sm" variant="outline" onClick={() => setTesting(old => !old)}>{testing ? "Close test" : "Test this rule"}</Button>
      {testing && <div className="space-y-2 rounded border border-background-200 p-3">
        {scopedFields.map(f => <Field key={f.key} label={f.label}>{f.value_type === "boolean"
          ? <Select value={sample[f.key] ?? ""} onChange={e => setSample({ ...sample, [f.key]: e.target.value })}><option value="">Missing</option><option value="true">Yes</option><option value="false">No</option></Select>
          : <TextInput type={numberTypes.includes(f.value_type) ? "number" : f.value_type === "date" ? "date" : "text"} value={sample[f.key] ?? ""} onChange={e => setSample({ ...sample, [f.key]: e.target.value })} />}</Field>)}
        <Button size="sm" onClick={() => void test()} disabled={busy}>Preview outcome</Button>
        {result !== undefined && <p role="status" className="break-all">{valueSummary(result)}</p>}
      </div>}
      <Field label="Reason for change" required><TextArea rows={2} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !reason.trim()} onClick={() => void submit("save", { ...reasons, definition })}>Save draft</Button>
        {isDraft && <><Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void submit("publish", { ...reasons, definition })}>Publish saved draft</Button>
          {(version.definition.approval_required || existingApprovalRequired) && <Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void submit("approve", { ...reasons, definition })}>Approve saved draft</Button>}</>}
      </div>
      {rule && !rule.registration && <p className="text-xs text-foreground-600">This rule can be managed and tested here. A workflow must be connected to its identifier to enforce it.</p>}
    </div>
  </Card>;
}
