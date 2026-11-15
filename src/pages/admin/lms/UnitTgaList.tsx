// A course's units with the training.gov.au content Sync stored: release, application, prerequisites, supersession,
// and the elements / performance criteria / evidence / conditions / foundation skills in asm_unit_elements.
import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import type { RtoUnit } from "@/pages/admin/lib/rto";

interface UnitInfo {
  tga_release_number: string | null; tga_release_date: string | null; tga_application: string | null; tga_unit_sector: string | null;
  tga_prerequisites: string | null; tga_supersedes_code: string | null; tga_supersedes_equivalent: boolean | null;
  usage_recommendation: string | null; tga_synced_at: string | null;
}
interface ElementRow { id: string; kind: string; code: string; text: string; parent_id: string | null; sort: number }
const KINDS: { kind: string; title: string }[] = [
  { kind: "foundation_skill", title: "Foundation skills" }, { kind: "performance_evidence", title: "Performance evidence" },
  { kind: "knowledge_evidence", title: "Knowledge evidence" }, { kind: "assessment_condition", title: "Assessment conditions" },
];

export function UnitDetail({ unitId }: { unitId: string }) {
  const [state, setState] = useState<{ info: UnitInfo | null; rows: ElementRow[]; error: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      supabase.from("cms_course_units").select("tga_release_number,tga_release_date,tga_application,tga_unit_sector,tga_prerequisites,tga_supersedes_code,tga_supersedes_equivalent,usage_recommendation,tga_synced_at")
        .eq("id", unitId).maybeSingle<UnitInfo>(),
      supabase.from("asm_unit_elements").select("id,kind,code,text,parent_id,sort").eq("unit_id", unitId).eq("is_active", true).order("sort"),
    ]).then(([info, rows]) => live && setState({ info: info.error ? null : info.data, rows: (rows.data ?? []) as ElementRow[],
      error: info.error ? "Unit details need the database update (migration 20261115140000)." : "" })).then(() => undefined);
    return () => { live = false; };
  }, [unitId]);
  if (!state) return <p className="py-2 text-xs text-foreground-500">Loading…</p>;
  const { info, rows, error } = state;
  const elements = rows.filter(row => row.kind === "element");
  const criteria = (id: string) => rows.filter(row => row.kind === "performance_criterion" && row.parent_id === id);
  const facts = info ? [
    ["Release", [info.tga_release_number, info.tga_release_date].filter(Boolean).join(" · ")], ["Usage", info.usage_recommendation],
    ["Sector", info.tga_unit_sector], ["Prerequisites", info.tga_prerequisites],
    ["Supersedes", info.tga_supersedes_code ? `${info.tga_supersedes_code}${info.tga_supersedes_equivalent ? " (equivalent)" : ""}` : null],
  ].filter(([, value]) => value) as [string, string][] : [];
  if (!rows.length && !info?.tga_synced_at) {
    return <p className="py-2 text-xs text-foreground-500">{error || "No training.gov.au content yet. Run Sync on the course (only active units are fetched)."}</p>;
  }
  return <div className="space-y-3 py-2 text-sm">
    {error ? <p className="text-xs text-amber-700">{error}</p> : null}
    {facts.length ? <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">{facts.map(([label, value]) =>
      <div key={label} className="flex gap-2"><dt className="w-24 shrink-0 text-xs text-foreground-500">{label}</dt><dd className="text-foreground-900">{value}</dd></div>)}</dl> : null}
    {info?.tga_application ? <p className="whitespace-pre-line text-foreground-700">{info.tga_application}</p> : null}
    {elements.length ? <div>
      <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">Elements and performance criteria</h5>
      <ol className="space-y-2">{elements.map(element => <li key={element.id}>
        <p className="font-medium text-foreground-950">{element.code} {element.text}</p>
        <ul className="ml-5 mt-0.5 space-y-0.5 text-foreground-700">{criteria(element.id).map(row => <li key={row.id}>{row.code} {row.text}</li>)}</ul>
      </li>)}</ol>
    </div> : null}
    {KINDS.map(({ kind, title }) => {
      const items = rows.filter(row => row.kind === kind);
      return items.length ? <details key={kind}>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">{title} ({items.length})</summary>
        <ul className="ml-5 mt-1 list-disc space-y-0.5 text-foreground-700">{items.map(row => <li key={row.id}>{row.code ? <strong>{row.code}: </strong> : null}{row.text}</li>)}</ul>
      </details> : null;
    })}
  </div>;
}

export default function UnitTgaList({ units }: { units: RtoUnit[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const inactive = units.filter(unit => !unit.isActive).length;
  const shown = units.filter(unit => showInactive || unit.isActive);
  return <section>
    <div className="mb-2 flex items-center justify-between">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Units ({units.length - inactive} active{inactive ? `, ${inactive} inactive electives` : ""})</h4>
      {inactive ? <button type="button" className="text-xs font-semibold text-primary-700" onClick={() => setShowInactive(v => !v)}>{showInactive ? "Hide inactive" : "Show inactive"}</button> : null}
    </div>
    <ul className="divide-y divide-background-200 rounded-lg border border-background-200">
      {shown.map(unit => {
        const key = unit.id ?? unit.code;
        return <li key={key}>
          <button type="button" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-background-100">
            <i className={(open === key ? "ri-arrow-down-s-line" : "ri-arrow-right-s-line") + " text-foreground-400"} aria-hidden="true" />
            <span className="w-28 shrink-0 font-semibold text-foreground-950">{unit.code}</span>
            <span className={"min-w-0 flex-1 truncate " + (unit.isActive ? "text-foreground-800" : "text-foreground-400")}>{unit.name}</span>
            <span className="shrink-0 text-xs text-foreground-500">{unit.unitType === "core" ? "Core" : "Elective"}{unit.nominalHours !== null ? ` · ${unit.nominalHours} h` : ""}{unit.isActive ? "" : " · inactive"}</span>
          </button>
          {open === key && unit.id ? <div className="border-t border-background-100 px-9"><UnitDetail unitId={unit.id} /></div> : null}
        </li>;
      })}
    </ul>
  </section>;
}
